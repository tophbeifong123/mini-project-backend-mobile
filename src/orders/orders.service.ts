import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';

import { GatekeeperVerdict, RedisService } from '../redis/redis.service';

/** payload ของ job (BUILD_SPEC — cross-module contract) */
export interface OrderJobData {
  userId: string;
  productId: string;
  correlationId?: string;
  /**
   * token สุ่ม **ต่อคำขอ** (ไม่ใช่ต่อ job) — load-bearing 2 อย่าง:
   *  1. เป็นค่าที่ gatekeeper เขียนลง `lock:order:*` ทำให้ compare-and-delete
   *     แยกการถือครองคนละครั้งได้จริง (jobId ซ้ำทุกครั้งที่คนเดิมขอของเดิม)
   *  2. เป็นตัวพิสูจน์ว่า job ที่เก็บอยู่ใน Redis เป็นของคำขอนี้ ไม่ใช่ของเก่าที่ BullMQ dedup
   */
  requestToken: string;
}

/** response 202 ตาม CLAUDE.md §3 — byte-exact */
export interface CreateOrderResponse {
  status: 'processing';
  orderJobId: string;
  message: string;
}

export const ORDER_QUEUE_NAME = 'orders';
export const ORDER_JOB_NAME = 'process-order';

/** deterministic jobId -> BullMQ ปฏิเสธ job ซ้ำเอง (CLAUDE.md §4 ข้อ 9) */
export function buildOrderJobId(userId: string, productId: string): string {
  return `order:${userId}:${productId}`;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly lockTtlMs: number;

  constructor(
    @InjectQueue(ORDER_QUEUE_NAME) private readonly ordersQueue: Queue,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.lockTtlMs = Number(
      this.config.get<string | number>('ORDER_LOCK_TTL_MS', 30_000),
    );
  }

  /**
   * Tier 1 + Tier 2 (architecture.md §6.1–6.2)
   * ❌ ห้ามมี synchronous DB write ที่นี่ — ตอบ 202 ทันทีหลัง enqueue (CLAUDE.md §4 ข้อ 1)
   */
  async createOrder(
    userId: string,
    productId: string,
    correlationId?: string,
  ): Promise<CreateOrderResponse> {
    const jobId = buildOrderJobId(userId, productId);

    // token สุ่มใหม่ "ทุกคำขอ" — ไม่ใช่ jobId ซึ่งซ้ำทุกครั้งที่คนเดิมขอของเดิม
    // ใช้ 2 อย่าง: (1) ค่าใน lock เพื่อให้ compare-and-delete แยกการถือครองได้จริง
    //             (2) ตัวพิสูจน์ว่า job ที่อยู่ในคิวเป็นของคำขอนี้ (ดูด้านล่าง)
    const requestToken = randomUUID();

    // ── Tier 1: Lua gatekeeper — 3 เช็ค + 2 เขียน ใน 1 roundtrip ที่ atomic ──
    //
    // ⚠️ ต้องมี try/catch — `commandTimeout: 1_000` (redis.module.ts) ยกเลิกแค่
    //    "การรอ" ฝั่ง client เท่านั้น มันไม่มีทางยกเลิกคำสั่งที่ Redis รับไปรันแล้ว
    //    ตอนโหลดพีคจน Redis ตอบช้ากว่า 1 วินาที Lua จะ **DECR ไปเรียบร้อยแล้ว**
    //    แต่ฝั่งเราได้ error → ถ้าปล่อยให้ทะลุขึ้นไปเป็น 500 เฉยๆ จะไม่มีใครคืนสต็อก
    //    (วัดจริงจาก k6 run 002: unhandled 8 ครั้ง = ของหาย 8 ชิ้นจาก 50 พอดี)
    //
    //    Lua atomic รับประกันว่า "รันครบหรือไม่รันเลย" แต่ไม่ได้รับประกันว่า
    //    **ผู้เรียกจะได้รู้ผล** — สถานะที่สามนี้ต้องจัดการเอง (CLAUDE.md §4 ข้อ 6)
    let verdict: number;
    try {
      verdict = await this.redis.gatekeeper(
        userId,
        productId,
        requestToken,
        this.lockTtlMs,
      );
    } catch (err) {
      await this.compensateIfReserved(userId, productId, jobId, requestToken);
      this.logger.error(
        `gatekeeper failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Stock service unavailable');
    }

    switch (verdict) {
      case GatekeeperVerdict.ALREADY_PURCHASED:
        throw new ConflictException('You already purchased this product');
      case GatekeeperVerdict.REQUEST_IN_FLIGHT:
        // 429 = พฤติกรรมที่ถูกต้อง ไม่ใช่ error (CLAUDE.md §3)
        // body ต้องเป็น object ทรงเดียวกับ error ตัวอื่น ไม่งั้น k6 ที่ทำ r.json('message') จะได้ undefined
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Order already in progress',
            error: 'Too Many Requests',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case GatekeeperVerdict.SOLD_OUT:
        throw new ConflictException('Sold out');
      case GatekeeperVerdict.STOCK_NOT_INITIALIZED:
        // ต้องแยกจาก "ของหมด" ให้ชัด ไม่งั้นระบบพังเงียบๆ
        throw new ServiceUnavailableException('Stock not initialized');
      default:
        break;
    }

    if (verdict !== GatekeeperVerdict.ALLOWED) {
      // ยังไม่มีการ DECR เกิดขึ้น (Lua จะ DECR เฉพาะตอนคืน 1) จึง **ห้าม** compensate ที่นี่
      this.logger.error(
        `unexpected gatekeeper verdict ${verdict} for ${jobId}`,
      );
      throw new ServiceUnavailableException('Unexpected gatekeeper verdict');
    }

    // ⚠️ ตั้งแต่บรรทัดนี้ไป สต็อกถูก DECR ใน Redis ไปแล้ว
    // ทุก exit path ที่ไม่มี job วิ่งต่อ **ต้อง** ชดเชยคืน (CLAUDE.md §4 ข้อ 6)
    let job: Job<OrderJobData> | undefined;
    try {
      job = await this.ordersQueue.add(
        ORDER_JOB_NAME,
        { userId, productId, correlationId, requestToken },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 200 },
          removeOnComplete: { count: 5000 }, // ต้องพอให้ Bull-Board นับ Completed ได้ครบ
          removeOnFail: { count: 5000 },
        },
      );
    } catch (err) {
      await this.compensate(userId, productId, jobId, requestToken);
      this.logger.error(
        `enqueue failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Queue unavailable');
    }

    // ── Blocker (b) fix (architecture-rationale.md §7b) ──
    // BullMQ เจอ jobId ซ้ำแล้ว **คืน job เดิมเงียบๆ ไม่ throw** -> catch ข้างบนไม่เคยทำงาน
    // ถ้าไม่ตรวจ จะได้ 202 ทั้งที่ไม่มี job ใหม่วิ่ง = สต็อกหายถาวร 1 ชิ้น
    if (!job) {
      await this.compensate(userId, productId, jobId, requestToken);
      throw new ServiceUnavailableException('Queue unavailable');
    }

    // ⚠️ ห้ามเทียบกับ `job.data` ที่ `add()` คืนมา — มันคือ object literal ที่เราส่งเข้าไปเอง
    //    `Job.create()` เขียนกลับแค่ `job.id` ไม่เคยอ่าน data จาก Redis
    //    (node_modules/bullmq/dist/cjs/classes/job.js:124-135)
    //    และตอน jobId ซ้ำ ฝั่ง Lua แค่ `return jobId` โดยทิ้ง payload ใหม่
    //    (scripts/addStandardJob-9.js:445) -> เทียบยังไงก็ตรงเสมอ = เช็คตาย
    //
    // ต้อง **อ่าน job กลับจาก Redis** (`getJob` -> Job.fromId -> HGETALL) แล้วเทียบ
    // token ที่ "เก็บอยู่จริง" กับของเรา คำถามเดียวที่ต้องตอบคือ:
    //   DECR ของคำขอนี้ ไปเป็นทุนให้ job ที่มีอยู่จริงหรือเปล่า
    // ถ้าใช่ = job ของเราจะรัน ไม่ต้องสน state · ถ้าไม่ใช่ = โดน dedup ต้องคืน
    // ต้นทุนเท่าเดิมกับ getState() ที่ถอดออกไป (1 roundtrip บน redis-data)
    const stored = await this.readStoredJob(jobId);

    if (stored === null) {
      // อ่านไม่ได้ / job ถูก trim ไปแล้ว — **ห้ามคืนสต็อก**
      // คืนผิดตอนที่ของขายไปแล้วแย่กว่าไม่คืน (Redis สูงกว่า DB = ปล่อยคนที่ 51 เข้ามา)
      this.logger.error(
        `cannot verify queued job ${jobId} — assuming ours and NOT compensating`,
      );
    } else if (stored.data?.requestToken !== requestToken) {
      // token ที่เก็บอยู่เป็นของคำขออื่น = เราโดน dedup, DECR รอบนี้ไม่มีใครกิน
      await this.compensate(userId, productId, jobId, requestToken);
      throw new ConflictException('Order already processed');
    }

    return {
      status: 'processing',
      orderJobId: jobId,
      message: 'Your order is in the queue.',
    };
    
  }

  /**
   * อ่าน job ที่ "เก็บอยู่จริง" ใน Redis กลับมา (ไม่ใช่ object ที่ add() คืน)
   * คืน `null` เมื่ออ่านไม่ได้หรือไม่มี job — ผู้เรียกต้องตีความว่า "ยืนยันไม่ได้"
   * ไม่ใช่ "เป็นของคนอื่น" (ดูเหตุผลที่จุดเรียกใช้)
   */
  private async readStoredJob(
    jobId: string,
  ): Promise<Job<OrderJobData> | null> {
    try {
      return (await this.ordersQueue.getJob(jobId)) ?? null;
    } catch (err) {
      this.logger.warn(
        `getJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * ชดเชยเมื่อ **ยืนยันไม่ได้** ว่า gatekeeper รันไปหรือยัง
   *
   * ห้ามใช้ `compensate()` ตรงนี้เด็ดขาด — `compensate.lua` สั่ง `INCR` โดยไม่มีเงื่อนไข
   * ถ้า Lua ไม่เคยรัน (เช่น Redis หลุดก่อนรับคำสั่ง) จะกลายเป็นการเพิ่มสต็อกลอยๆ
   * → Redis สูงกว่า DB → ปล่อยคนที่ 51 เข้ามา ซึ่งแย่กว่าปัญหาเดิม
   *
   * `compensate-if-reserved.lua` เช็ค `lock:order:*` ว่าเป็น `requestToken` ของเราไหม
   * ก่อนตัดสินใจ — lock จะมีค่านั้นได้ก็ต่อเมื่อ gatekeeper.lua รันถึงบรรทัด SET
   * ซึ่ง atomic คู่กับ DECR อยู่แล้ว จึงปลอดภัยทั้งสองทาง
   */
  private async compensateIfReserved(
    userId: string,
    productId: string,
    jobId: string,
    requestToken: string,
  ): Promise<void> {
    try {
      const restored = await this.redis.compensateIfReserved(
        userId,
        productId,
        requestToken,
      );
      if (restored === 1) {
        this.logger.warn(
          `gatekeeper timed out but the reservation was real — stock restored for ${jobId}`,
        );
      }
    } catch (err) {
      // ชดเชยไม่สำเร็จ = สต็อกหาย 1 ชิ้น ต้องดังที่สุดเพื่อให้ตามเก็บได้
      this.logger.error(
        `COMPENSATION FAILED for ${jobId} — stock may have leaked by 1: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** ชดเชยไม่สำเร็จ = สต็อกหาย ต้อง log ให้ดังที่สุด แต่ห้ามกลบ error เดิมของผู้เรียก */
  private async compensate(
    userId: string,
    productId: string,
    jobId: string,
    requestToken: string,
  ): Promise<void> {
    try {
      await this.redis.compensate(userId, productId, requestToken);
    } catch (err) {
      this.logger.error(
        `COMPENSATION FAILED for ${jobId} — stock leaked by 1: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
