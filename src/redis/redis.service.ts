import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CACHE_CLIENT, REDIS_DATA_CLIENT } from './redis.constants';
import { RedisKeys } from './redis.keys';

/**
 * Lua script ที่ถูกลงทะเบียนด้วย `defineCommand` — ioredis เติม method พวกนี้ให้ตอน runtime
 * เราประกาศ type ไว้เองเพื่อไม่ต้องใช้ `any` (CLAUDE.md §6 DO: strict typing)
 */
interface LuaCommands {
  gatekeeper(
    lockKey: string,
    stockKey: string,
    boughtKey: string,
    lockTtlMs: string,
    token: string,
  ): Promise<number>;

  compensateStock(
    stockKey: string,
    lockKey: string,
    requestToken: string,
  ): Promise<number>;

  compensateStockOnce(
    guardKey: string,
    stockKey: string,
    lockKey: string,
    guardTtlSeconds: string,
    requestToken: string,
  ): Promise<number>;

  releaseLock(lockKey: string, token: string): Promise<number>;
}

export type RedisDataClient = Redis & LuaCommands;

/** verdict ที่ gatekeeper.lua คืนกลับมา (architecture.md §6.1) */
export const GatekeeperVerdict = {
  ALLOWED: 1,
  ALREADY_PURCHASED: -1,
  REQUEST_IN_FLIGHT: -2,
  SOLD_OUT: -3,
  STOCK_NOT_INITIALIZED: -4,
} as const;

interface LuaScriptDefinition {
  name: keyof LuaCommands;
  file: string;
  numberOfKeys: number;
}

const LUA_SCRIPTS: readonly LuaScriptDefinition[] = [
  { name: 'gatekeeper', file: 'gatekeeper.lua', numberOfKeys: 3 },
  { name: 'compensateStock', file: 'compensate.lua', numberOfKeys: 2 },
  { name: 'compensateStockOnce', file: 'compensate-once.lua', numberOfKeys: 3 },
  { name: 'releaseLock', file: 'release-lock.lua', numberOfKeys: 1 },
] as const;

/**
 * guard key ของ compensation ต้องอยู่นานพอครอบ retry chain ของ job เดียวเท่านั้น
 * `attempts: 3` + exponential backoff 200ms = จบใน ~2 วินาที → 300 วิเหลือเฟือ
 *
 * ⚠️ เดิมตั้งไว้ 86,400 วิ (24 ชม.) ซึ่งยาวเกินความจำเป็น ~5 order of magnitude
 *    guard ที่อยู่นานกว่างานของมัน = guard ที่บล็อกการคืนสต็อกที่ถูกต้องในอนาคตแบบเงียบๆ
 */
const COMPENSATION_GUARD_TTL_SECONDS = 300;

/** ล้าง metadata cache ได้ไม่เกิน 1 ครั้งต่อช่วงเวลานี้ (ดู invalidateCatalogCache) */
const CATALOG_FLUSH_MIN_INTERVAL_MS = 1_000;

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private readonly catalogTtlBase: number;
  private readonly catalogTtlJitter: number;

  /** state ของ debounce ใน invalidateCatalogCache() — per-process, ไม่ใช่ shared state */
  private lastCatalogFlushAt = 0;
  private pendingCatalogFlush?: NodeJS.Timeout;

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly cache: Redis,
    @Inject(REDIS_DATA_CLIENT) private readonly data: Redis,
    private readonly config: ConfigService,
  ) {
    this.catalogTtlBase = Number(
      this.config.get<string | number>('CATALOG_CACHE_TTL_BASE', 30),
    );
    this.catalogTtlJitter = Number(
      this.config.get<string | number>('CATALOG_CACHE_TTL_JITTER', 30),
    );
  }

  onModuleInit(): void {
    this.registerLuaScripts();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Lua registration
  // ────────────────────────────────────────────────────────────────────────

  /**
   * ⚠️ `.lua` ไม่ถูก compile โดย tsc — ต้องถูก copy เข้า dist ผ่าน nest-cli assets
   * `__dirname` = src/redis (ts-node) หรือ dist/redis (prod) จึงใช้ได้ทั้งสองแบบ
   */
  private resolveLuaDir(): string {
    const candidates = [
      join(__dirname, 'lua'),
      join(process.cwd(), 'dist', 'redis', 'lua'),
      join(process.cwd(), 'src', 'redis', 'lua'),
    ];

    const found = candidates.find((dir) => existsSync(dir));
    if (!found) {
      throw new Error(
        `Lua script directory not found. Looked in: ${candidates.join(', ')}. ` +
          `Check the "assets" entry in nest-cli.json and the Dockerfile COPY step.`,
      );
    }
    return found;
  }

  private registerLuaScripts(): void {
    const luaDir = this.resolveLuaDir();
    const client = this.data as RedisDataClient;

    for (const script of LUA_SCRIPTS) {
      const path = join(luaDir, script.file);
      if (!existsSync(path)) {
        throw new Error(`Missing Lua script: ${path}`);
      }
      client.defineCommand(script.name, {
        numberOfKeys: script.numberOfKeys,
        lua: readFileSync(path, 'utf8'),
      });
    }

    this.logger.log(
      `registered ${LUA_SCRIPTS.length} Lua scripts from ${luaDir}`,
    );
  }

  private get dataClient(): RedisDataClient {
    return this.data as RedisDataClient;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Write path — redis-data. ห้าม swallow error เด็ดขาด
  // (stock counter ไม่ใช่ optimization: พลาดเมื่อไหร่ = oversell/undersell)
  // ────────────────────────────────────────────────────────────────────────

  /** Tier 1 (architecture.md §6.1): 1 = ผ่าน · -1 ซื้อแล้ว · -2 in-flight · -3 หมด · -4 ยังไม่ seed */
  async gatekeeper(
    userId: string,
    productId: string,
    requestToken: string,
    lockTtlMs: number,
  ): Promise<number> {
    return this.dataClient.gatekeeper(
      RedisKeys.orderLock(userId, productId),
      RedisKeys.stock(productId),
      RedisKeys.bought(productId, userId),
      String(lockTtlMs),
      requestToken,
    );
  }

  /** ชดเชยจาก API path เมื่อ enqueue ไม่สำเร็จ — INCR stock + ปล่อย lock ใน Lua เดียว */
  async compensate(
    userId: string,
    productId: string,
    requestToken: string,
  ): Promise<void> {
    await this.dataClient.compensateStock(
      RedisKeys.stock(productId),
      RedisKeys.orderLock(userId, productId),
      requestToken,
    );
  }

  /** ชดเชยจาก worker — idempotent ต่อ jobId (1 = คืนแล้วรอบนี้, 0 = เคยคืนไปแล้ว) */
  async compensateOnce(
    jobId: string,
    userId: string,
    productId: string,
    requestToken: string,
  ): Promise<number> {
    return this.dataClient.compensateStockOnce(
      RedisKeys.compensated(jobId),
      RedisKeys.stock(productId),
      RedisKeys.orderLock(userId, productId),
      String(COMPENSATION_GUARD_TTL_SECONDS),
      requestToken,
    );
  }

  /** flag "ซื้อสำเร็จแล้ว" — ไม่มี TTL โดยเจตนา (redis-data = noeviction, เป็นความจริงของรอบขาย) */
  async markBought(productId: string, userId: string): Promise<void> {
    await this.data.set(RedisKeys.bought(productId, userId), '1');
  }

  /** ปล่อย lock ด้วย compare-and-delete — ห้าม DEL ตรงๆ (CLAUDE.md §6) */
  async releaseInFlightLock(
    userId: string,
    productId: string,
    token: string,
  ): Promise<void> {
    await this.dataClient.releaseLock(
      RedisKeys.orderLock(userId, productId),
      token,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Read path — stock overlay (redis-data) + metadata cache (redis-cache)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * อ่านสต็อกสดของหลายสินค้าใน 1 roundtrip (architecture.md §5.2 ขั้นที่ 2)
   * ห้ามแคชผลลัพธ์ของ method นี้ และห้ามกลืน error — ผู้เรียกต้องรู้ว่าสต็อกอ่านไม่ได้
   */
  async getStocks(productIds: string[]): Promise<(string | null)[]> {
    if (productIds.length === 0) {
      return [];
    }
    return this.data.mget(productIds.map((id) => RedisKeys.stock(id)));
  }

  /** cache = optimization เท่านั้น -> error ใดๆ แปลว่า "miss" แล้วให้ผู้เรียกไป DB ต่อ */
  async getCatalogPage<T>(page: number, limit: number): Promise<T | null> {
    try {
      const raw = await this.cache.get(RedisKeys.catalogPage(page, limit));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      this.logger.warn(
        `catalog cache read failed (falling back to DB): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** SETEX ด้วย TTL + jitter เสมอ (กัน avalanche) แล้วจดไว้ใน catalog:index */
  async setCatalogPage<T>(
    page: number,
    limit: number,
    value: T,
  ): Promise<void> {
    const key = RedisKeys.catalogPage(page, limit);
    const indexKey = RedisKeys.catalogIndex();
    const ttl =
      this.catalogTtlBase +
      Math.floor(Math.random() * (this.catalogTtlJitter + 1));

    try {
      await this.cache
        .multi()
        .setex(key, ttl, JSON.stringify(value))
        .sadd(indexKey, key)
        // index เองก็ต้องมี TTL — key ที่ไม่มี TTL ใน redis-cache = memory leak
        .expire(indexKey, this.catalogTtlBase + this.catalogTtlJitter + 60)
        .exec();
    } catch (err) {
      this.logger.warn(
        `catalog cache write failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * ล้าง metadata cache ทั้งหมด — **debounce ไม่เกิน 1 ครั้ง/วินาที**
   *
   * โจทย์ข้อ 2.3 กฎ 4 บังคับให้ invalidate หลัง DB update สำเร็จ ซึ่งยังทำอยู่
   * แต่ของ 50 ชิ้นขายหมดใน window ~300ms = ล้างทั้งแคช 50 ครั้งรวดตอนที่
   * reader 1,000 คนกำลังยิงอยู่พอดี ซึ่งไม่ใช่สิ่งที่กฎข้อนั้นต้องการ
   *
   * ตัวที่ทำให้ `remainingStock` ถูกต้องคือ stock overlay (§5.2) ไม่ใช่การ invalidate
   * การล้างแคชมีไว้เผื่อ metadata เปลี่ยน (เช่น `isFlashSaleActive`) ซึ่ง 1 วินาทีถือว่าสด
   *
   * เป็น **trailing debounce** ไม่ใช่การทิ้ง — คำขอที่ตกอยู่ใน window
   * จะถูกรวบไปทำรอบเดียวหลังครบ 1 วิ จึงไม่มีการล้างที่หายไปเฉยๆ
   *
   * ❌ ห้ามใช้ `KEYS pattern` (O(N) + บล็อก Redis ทั้งตัว — CLAUDE.md §6)
   */
  async invalidateCatalogCache(): Promise<void> {
    const now = Date.now();
    const sinceLast = now - this.lastCatalogFlushAt;

    if (sinceLast >= CATALOG_FLUSH_MIN_INTERVAL_MS) {
      this.lastCatalogFlushAt = now;
      await this.flushCatalogCache();
      return;
    }

    // อยู่ใน window แล้ว — จองรอบ trailing ไว้รอบเดียว ที่เหลือเกาะไปด้วย
    if (this.pendingCatalogFlush) {
      return;
    }
    this.pendingCatalogFlush = setTimeout(() => {
      this.pendingCatalogFlush = undefined;
      this.lastCatalogFlushAt = Date.now();
      void this.flushCatalogCache();
    }, CATALOG_FLUSH_MIN_INTERVAL_MS - sinceLast);
    this.pendingCatalogFlush.unref();
  }

  /** การล้างจริง — ไม่มี debounce (ใช้ภายในและตอน shutdown) */
  private async flushCatalogCache(): Promise<void> {
    const indexKey = RedisKeys.catalogIndex();
    try {
      const keys = await this.cache.smembers(indexKey);
      if (keys.length > 0) {
        await this.cache.del(...keys);
      }
      await this.cache.del(indexKey);
    } catch (err) {
      this.logger.warn(
        `catalog cache invalidation failed (TTL will clean up): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Health (/health/ready)
  // ────────────────────────────────────────────────────────────────────────

  async pingCache(): Promise<boolean> {
    try {
      return (await this.cache.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async pingData(): Promise<boolean> {
    try {
      return (await this.data.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
