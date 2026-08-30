import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { ORDERS_QUEUE } from '../bullmq_config/bullmq.module';
import {
  REDIS_CACHE_CLIENT,
  REDIS_DATA_CLIENT,
} from '../redis/redis.constants';
import { RedisKeys } from '../redis/redis.keys';

export type Verdict = 'ok' | 'warn' | 'critical' | 'unknown';

export interface ProductIntegrityRow {
  productId: string;
  name: string;
  availableStock: number;
  dbRemaining: number;
  redisRemaining: number | null;
  orders: number;
  buyers: number;
  soldByDb: number;
  /** redisRemaining − dbRemaining · ติดลบ = มี job ค้างในคิว (ปกติ) · เป็นบวก = อันตราย */
  drift: number | null;
  verdict: Verdict;
  notes: string[];
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  prioritized: number;
}

export interface RedisSnapshot {
  role: 'cache' | 'data';
  usedMemoryMb: number | null;
  connectedClients: number | null;
  opsPerSecond: number | null;
  keyspaceHits: number | null;
  keyspaceMisses: number | null;
  hitRatio: number | null;
  evictedKeys: number | null;
  reachable: boolean;
}

export interface PoolSnapshot {
  total: number;
  idle: number;
  waiting: number;
}

export interface IntegrityReport {
  generatedAt: string;
  verdict: Verdict;
  headline: string;
  products: ProductIntegrityRow[];
  totals: {
    orders: number;
    buyers: number;
    availableStock: number;
    dbRemaining: number;
  };
  queue: QueueCounts | null;
  queueDrained: boolean;
  replicationLagSeconds: number | null;
  redis: RedisSnapshot[];
  pool: PoolSnapshot | null;
}

interface ProductRow {
  id: string;
  name: string;
  available_stock: number;
  remaining_stock: number;
  orders: string;
  buyers: string;
}

function parseInfo(info: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of info.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    parsed[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return parsed;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reconciliation ระหว่าง Redis counter กับ DB — รูที่ CLAUDE.md §0.1 บอกว่า
 * "ตัวจับ drift ตัวเดียวที่มีคือการรัน §9.3 ด้วยมือ"
 *
 * ตรวจ **อ่านอย่างเดียว** ไม่แก้อะไรทั้งสิ้น การซ่อม drift อัตโนมัติอันตรายกว่าปัญหาเดิม
 * (INCR ลอยๆ = ปล่อยคนที่ 51 เข้ามา) — หน้าที่ของที่นี่คือบอกให้คนตัดสินใจ
 */
@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_DATA_CLIENT) private readonly data: Redis,
    @Inject(REDIS_CACHE_CLIENT) private readonly cache: Redis,
    @InjectQueue(ORDERS_QUEUE) private readonly ordersQueue: Queue,
  ) {}

  async check(): Promise<IntegrityReport> {
    const [products, queue, replicationLagSeconds, redis] = await Promise.all([
      this.checkProducts(),
      this.readQueueCounts(),
      this.readReplicationLag(),
      Promise.all([
        this.readRedis('cache', this.cache),
        this.readRedis('data', this.data),
      ]),
    ]);

    const queueDrained =
      queue !== null && queue.waiting + queue.active + queue.delayed === 0;

    // drift ติดลบระหว่างที่ยังมี job ค้าง = ปกติ (Redis จองก่อน DB ตัดทีหลัง)
    // แต่ถ้าคิวว่างแล้วยังติดลบ = สต็อกรั่วจริง ต้องยกระดับเป็น warn
    for (const row of products) {
      if (row.verdict !== 'ok' || row.drift === null || row.drift >= 0)
        continue;
      if (queueDrained) {
        row.verdict = 'warn';
        row.notes.push('คิวว่างแล้วแต่ Redis ยังต่ำกว่า DB — สต็อกรั่ว');
      } else {
        row.notes.push('Redis ต่ำกว่า DB เพราะมี job ค้างในคิว (ปกติ)');
      }
    }

    const verdict = products.reduce<Verdict>(
      (worst, row) => this.worse(worst, row.verdict),
      'ok',
    );

    return {
      generatedAt: new Date().toISOString(),
      verdict,
      headline: this.headline(verdict, products),
      products,
      totals: {
        orders: products.reduce((sum, row) => sum + row.orders, 0),
        buyers: products.reduce((sum, row) => sum + row.buyers, 0),
        availableStock: products.reduce(
          (sum, row) => sum + row.availableStock,
          0,
        ),
        dbRemaining: products.reduce((sum, row) => sum + row.dbRemaining, 0),
      },
      queue,
      queueDrained,
      replicationLagSeconds,
      redis,
      pool: this.readPool(),
    };
  }

  /**
   * ⚠️ ต้องอ่านจาก **master** เท่านั้น (invariant §4 ข้อ 3)
   *    ถ้าอ่าน replica ที่มี lag แล้วเอาไปเทียบกับ Redis ที่สดเสมอ
   *    หน้านี้จะรายงาน drift ปลอมทุกครั้งที่ replica ตามไม่ทัน
   */
  private async checkProducts(): Promise<ProductIntegrityRow[]> {
    const runner = this.dataSource.createQueryRunner('master');
    try {
      await runner.connect();
      // TypeORM 0.3 ประกาศ query() ว่าคืน QueryResult — cast ทีเดียวตรงนี้
      const rows = (await runner.query(`
        SELECT p.id,
               p.name,
               p.available_stock,
               p.remaining_stock,
               COALESCE(o.orders, 0)  AS orders,
               COALESCE(o.buyers, 0)  AS buyers
        FROM products p
        LEFT JOIN (
          SELECT product_id,
                 COUNT(*)                 AS orders,
                 COUNT(DISTINCT user_id)  AS buyers
          FROM orders
          GROUP BY product_id
        ) o ON o.product_id = p.id
        ORDER BY p.id ASC
      `)) as ProductRow[];

      const counters = rows.length
        ? await this.readStockCounters(rows.map((row) => row.id))
        : [];

      return rows.map((row, index) => this.buildRow(row, counters[index]));
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async readStockCounters(
    productIds: string[],
  ): Promise<(string | null)[]> {
    try {
      return await this.data.mget(productIds.map((id) => RedisKeys.stock(id)));
    } catch (err) {
      this.logger.warn(
        `stock counter read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return productIds.map(() => null);
    }
  }

  private buildRow(
    row: ProductRow,
    counter: string | null | undefined,
  ): ProductIntegrityRow {
    const availableStock = Number(row.available_stock);
    const dbRemaining = Number(row.remaining_stock);
    const orders = Number(row.orders);
    const buyers = Number(row.buyers);
    const redisRemaining =
      counter === null || counter === undefined ? null : Number(counter);

    const notes: string[] = [];
    let verdict: Verdict = 'ok';

    if (orders > availableStock) {
      verdict = 'critical';
      notes.push(`OVERSELL: order ${orders} ใบ เกินของที่มี ${availableStock}`);
    }
    if (dbRemaining < 0) {
      verdict = 'critical';
      notes.push('remaining_stock ติดลบ');
    }
    if (orders !== buyers) {
      verdict = 'critical';
      notes.push(`ซื้อซ้ำ: order ${orders} ใบ จากผู้ซื้อ ${buyers} คน`);
    }
    if (availableStock - dbRemaining !== orders) {
      verdict = this.worse(verdict, 'critical');
      notes.push(
        `DB ไม่สมดุล: ขายไป ${availableStock - dbRemaining} แต่มี order ${orders} ใบ`,
      );
    }

    if (redisRemaining === null) {
      verdict = this.worse(verdict, 'warn');
      notes.push('ไม่มี stock counter ใน Redis (ยังไม่ seed:redis?)');
    } else if (redisRemaining > dbRemaining) {
      verdict = 'critical';
      notes.push('Redis สูงกว่า DB — เสี่ยงปล่อยคนเกินโควตาเข้ามา');
    }

    return {
      productId: row.id,
      name: row.name,
      availableStock,
      dbRemaining,
      redisRemaining,
      orders,
      buyers,
      soldByDb: availableStock - dbRemaining,
      drift: redisRemaining === null ? null : redisRemaining - dbRemaining,
      verdict,
      notes,
    };
  }

  private async readQueueCounts(): Promise<QueueCounts | null> {
    try {
      const counts = await this.ordersQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'prioritized',
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        prioritized: counts.prioritized ?? 0,
      };
    } catch (err) {
      this.logger.warn(
        `queue counts unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** วัดจากฝั่ง replica เอง — `pg_last_xact_replay_timestamp()` เป็น NULL ถ้ายังไม่เคย replay */
  private async readReplicationLag(): Promise<number | null> {
    const runner = this.dataSource.createQueryRunner('slave');
    try {
      await runner.connect();
      const rows = (await runner.query(`
        SELECT CASE
                 WHEN NOT pg_is_in_recovery() THEN NULL
                 ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
               END AS lag
      `)) as { lag: string | null }[];
      const lag = rows[0]?.lag;
      return lag === null || lag === undefined
        ? null
        : Math.round(Number(lag) * 1000) / 1000;
    } catch (err) {
      this.logger.warn(
        `replication lag unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async readRedis(
    role: 'cache' | 'data',
    client: Redis,
  ): Promise<RedisSnapshot> {
    try {
      const info = parseInfo(await client.info());
      const hits = toNumber(info.keyspace_hits);
      const misses = toNumber(info.keyspace_misses);
      const total = (hits ?? 0) + (misses ?? 0);
      const usedMemory = toNumber(info.used_memory);

      return {
        role,
        usedMemoryMb:
          usedMemory === null
            ? null
            : Math.round((usedMemory / 1024 / 1024) * 10) / 10,
        connectedClients: toNumber(info.connected_clients),
        opsPerSecond: toNumber(info.instantaneous_ops_per_sec),
        keyspaceHits: hits,
        keyspaceMisses: misses,
        hitRatio:
          total > 0 ? Math.round(((hits ?? 0) / total) * 1000) / 10 : null,
        evictedKeys: toNumber(info.evicted_keys),
        reachable: true,
      };
    } catch {
      return {
        role,
        usedMemoryMb: null,
        connectedClients: null,
        opsPerSecond: null,
        keyspaceHits: null,
        keyspaceMisses: null,
        hitRatio: null,
        evictedKeys: null,
        reachable: false,
      };
    }
  }

  /**
   * ขนาด pool ของ master — `waiting > 0` ต่อเนื่องคือคอขวดที่ WORKER_CONCURRENCY สูงเกิน pool
   * อ่านจากภายในของ node-postgres จึงต้องกันพังไว้ (ถ้าโครงสร้างเปลี่ยน ให้คืน null เฉยๆ)
   */
  private readPool(): PoolSnapshot | null {
    try {
      const driver = this.dataSource.driver as unknown as {
        master?: {
          totalCount?: number;
          idleCount?: number;
          waitingCount?: number;
        };
      };
      const pool = driver.master;
      if (!pool || typeof pool.totalCount !== 'number') return null;
      return {
        total: pool.totalCount,
        idle: pool.idleCount ?? 0,
        waiting: pool.waitingCount ?? 0,
      };
    } catch {
      return null;
    }
  }

  private worse(a: Verdict, b: Verdict): Verdict {
    const rank: Record<Verdict, number> = {
      ok: 0,
      unknown: 1,
      warn: 2,
      critical: 3,
    };
    return rank[b] > rank[a] ? b : a;
  }

  private headline(verdict: Verdict, rows: ProductIntegrityRow[]): string {
    if (verdict === 'ok') {
      return 'ไม่มี oversell ไม่มีคนซื้อซ้ำ Redis กับ DB ตรงกัน';
    }
    const flagged = rows.filter((row) => row.verdict !== 'ok');
    return `${flagged.length} สินค้ามีปัญหา: ${flagged
      .slice(0, 3)
      .map((row) => `${row.productId} (${row.notes[0] ?? row.verdict})`)
      .join(' · ')}`;
  }
}
