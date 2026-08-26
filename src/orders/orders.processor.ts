import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, QueryRunner } from 'typeorm';

import { Product } from '../products/entities/product.entity';
import { RedisService } from '../redis/redis.service';
import { Order, OrderStatus } from './entities/order.entity';
import { SoldOutError } from './errors/sold-out.error';
import { ORDER_QUEUE_NAME, OrderJobData } from './orders.service';

/** PostgreSQL: 23505 = unique_violation -> job นี้เคยสำเร็จไปแล้ว (retry ซ้ำ) */
const PG_UNIQUE_VIOLATION = '23505';

export interface OrderJobResult {
  status: 'confirmed' | 'already_confirmed' | 'sold_out';
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Tier 3 (architecture.md §6.3)
 * concurrency ต้องไม่เกินขนาด pool ของ master (§8) — อ่านจาก env เพราะ decorator ใช้ DI ไม่ได้
 */
@Processor(ORDER_QUEUE_NAME, {
  concurrency: Number(process.env.WORKER_CONCURRENCY) || 5,
})
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<OrderJobData>): Promise<OrderJobResult> {
    const { userId, productId } = job.data;
    const jobId = job.id ?? `order:${userId}:${productId}`;

    // ⚠️ กับดัก Read-Write Split: repository.findOne() จะวิ่งไป replica ที่มี lag
    //    worker ต้องใช้ master runner เท่านั้น (CLAUDE.md §4 ข้อ 3)
    const queryRunner = this.dataSource.createQueryRunner('master');
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let committed = false;
    try {
      // ── Atomic decrement: ไม่ SELECT ก่อน จึงไม่มี TOCTOU (CLAUDE.md §4 ข้อ 4) ──
      const result = await queryRunner.manager
        .createQueryBuilder()
        .update(Product)
        .set({ remainingStock: () => 'remaining_stock - 1' })
        .where('id = :productId AND remaining_stock > 0', { productId })
        .execute();

      if (result.affected === 0) {
        throw new SoldOutError(productId); // permanent — ห้าม retry
      }

      await queryRunner.manager.insert(Order, {
        userId,
        productId,
        status: OrderStatus.CONFIRMED,
      });

      await queryRunner.commitTransaction();
      committed = true; // ◄── หมุดชี้ขาดของทุก branch ข้างล่าง
    } catch (err) {
      if (!committed) {
        await this.safeRollback(queryRunner, jobId);
      }

      // idempotency: เคย INSERT สำเร็จไปแล้ว = ถือว่าสำเร็จ ห้ามคืนสต็อก ห้าม retry
      if (isUniqueViolation(err)) {
        this.logger.warn(
          `job ${jobId} hit unique violation — already confirmed`,
        );
        return { status: 'already_confirmed' };
      }

      // ── Blocker (a) fix (architecture-rationale.md §7a) ──
      // คืนสต็อก "เฉพาะตอนที่ล้มเหลวถาวรจริง" เท่านั้น
      // ถ้าคืนตอน transient แล้ว retry สำเร็จทีหลัง -> Redis จะสูงกว่า DB ถาวร 1 หน่วย
      // (compensated:{jobId} กันการคืน "ซ้ำ" ได้ แต่ไม่ได้กันการคืน job ที่ยังไม่ตาย)
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (isFinalAttempt || err instanceof SoldOutError) {
        await this.redis.compensateOnce(jobId, userId, productId);
      }

      if (err instanceof SoldOutError) {
        // ❌ อย่า throw — permanent failure (CLAUDE.md §4 ข้อ 10)
        this.logger.warn(`job ${jobId} sold out — no retry`);
        return { status: 'sold_out' };
      }

      this.logger.error(
        `job ${jobId} failed (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}, ` +
          `compensated=${isFinalAttempt}): ${describe(err)}`,
      );
      throw err; // ✅ transient -> ให้ BullMQ retry
    } finally {
      if (!queryRunner.isReleased) {
        await queryRunner.release();
      }
    }

    // ── Side effects หลัง commit — อยู่ **นอก** try/catch ของ transaction โดยเจตนา ──
    // ถ้าโค้ดพวกนี้ throw แล้วไปเข้า catch ข้างบน จะกลายเป็น "คืนสต็อกทั้งที่ขายไปแล้ว"
    // = Redis บวกเกินจริง -> oversell (CLAUDE.md §4 ข้อ 7)
    try {
      await this.redis.markBought(productId, userId);
      // ปล่อย lock ด้วย compare-and-delete — token = jobId ที่ gatekeeper เขียนไว้
      await this.redis.releaseInFlightLock(userId, productId, jobId);
      await this.redis.invalidateCatalogCache();
    } catch (err) {
      this.logger.error(
        `post-commit side effect failed for job ${jobId} (order IS confirmed): ${describe(err)}`,
      );
      // กลืน error ทิ้ง — order สำเร็จไปแล้ว TTL ของ lock จะเก็บกวาดให้เอง
    }

    return { status: 'confirmed' };
  }

  /** rollback ที่ throw จะกลบสาเหตุจริงของ error — ต้องกันไว้ */
  private async safeRollback(
    queryRunner: QueryRunner,
    jobId: string,
  ): Promise<void> {
    try {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
    } catch (err) {
      this.logger.error(`rollback failed for job ${jobId}: ${describe(err)}`);
    }
  }

  // ⚠️ ใช้ @OnWorkerEvent (BullMQ) เท่านั้น — `queue.on('completed')` เป็นของ Bull v4
  @OnWorkerEvent('completed')
  onCompleted(job: Job<OrderJobData>): void {
    this.logger.log(
      `job ${String(job.id)} completed for user=${job.data.userId} product=${job.data.productId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<OrderJobData> | undefined, err: Error): void {
    this.logger.error(
      `job ${String(job?.id)} failed permanently or will retry: ${describe(err)}`,
    );
  }
}
