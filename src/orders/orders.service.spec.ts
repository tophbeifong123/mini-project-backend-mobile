import type { MetricsService } from '../observability/metrics.service';
import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';

import { GatekeeperVerdict, RedisService } from '../redis/redis.service';
import { OrderJobData, OrdersService } from './orders.service';

describe('OrdersService', () => {
  type QueueMock = jest.Mocked<Pick<Queue, 'add' | 'getJob'>>;
  type RedisMock = jest.Mocked<
    Pick<RedisService, 'gatekeeper' | 'compensate' | 'compensateIfReserved'>
  >;

  let service: OrdersService;
  let queue: QueueMock;
  let redis: RedisMock;
  /** job ที่ "เก็บอยู่ใน Redis" — คือสิ่งที่ queue.getJob() คืนมา ไม่ใช่สิ่งที่ add() คืน */
  let storedJob: { id: string; data: Partial<OrderJobData> } | undefined;

  const userId = 'user-999';
  const productId = 'p-1001';
  const jobId = `order:${userId}:${productId}`;

  beforeEach(() => {
    storedJob = undefined;

    queue = { add: jest.fn(), getJob: jest.fn() };

    // ⚠️ จำลอง BullMQ ให้ตรงความจริง: `add()` คืน Job ที่ประกอบจาก payload **ที่เราส่งเข้าไป**
    //    ไม่เคยอ่านกลับจาก Redis (bullmq/classes/job.js:124-135)
    //    และถ้า jobId ซ้ำ ฝั่ง Lua จะทิ้ง payload ใหม่เงียบๆ (addStandardJob-9.js:445)
    //    → การเทียบ token จาก add() จึงตรงเสมอ = เช็คตาย นี่คือเหตุผลที่ต้องใช้ getJob()
    queue.add.mockImplementation(
      (_name: string, data: OrderJobData): Promise<Job<OrderJobData>> => {
        storedJob ??= { id: jobId, data }; // มีอยู่แล้ว = ถูก dedup, payload เดิมคงอยู่
        return Promise.resolve({
          id: jobId,
          data,
        } as unknown as Job<OrderJobData>);
      },
    );
    queue.getJob.mockImplementation(() =>
      Promise.resolve(storedJob as unknown as Job<OrderJobData>),
    );

    redis = {
      gatekeeper: jest.fn(),
      compensate: jest.fn(),
      compensateIfReserved: jest.fn(),
    };
    redis.compensate.mockResolvedValue(undefined);
    // 0 = ไม่พบ lock ของเรา → gatekeeper ไม่ได้รัน → ไม่มีอะไรต้องคืน
    redis.compensateIfReserved.mockResolvedValue(0);

    const config = {
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    } as unknown as jest.Mocked<ConfigService>;

    // การวัดผลต้องไม่มีผลต่อ logic — stub ไว้เฉยๆ พอ
    const metrics = { inc: jest.fn() };
    service = new OrdersService(
      queue as unknown as Queue,
      redis as unknown as RedisService,
      config,
      metrics as unknown as MetricsService,
    );
  });

  describe('gatekeeper verdicts → HTTP status codes (CLAUDE.md §3)', () => {
    it('maps -1 (already purchased) to 409', async () => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.ALREADY_PURCHASED);

      await expect(
        service.createOrder(userId, productId),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queue.add).not.toHaveBeenCalled();
      expect(redis.compensate).not.toHaveBeenCalled();
    });

    it('maps -2 (in-flight) to 429 — a correct behaviour, not an error', async () => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.REQUEST_IN_FLIGHT);

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('maps -3 (sold out) to 409', async () => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.SOLD_OUT);

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
    });

    it('maps -4 (stock not seeded) to 503 — must stay distinct from sold out', async () => {
      redis.gatekeeper.mockResolvedValue(
        GatekeeperVerdict.STOCK_NOT_INITIALIZED,
      );

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      // ยังไม่มีการ DECR -> ห้ามคืนสต็อก
      expect(redis.compensate).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.ALLOWED);
    });

    it('returns the exact 202 body from CLAUDE.md §3', async () => {
      await expect(service.createOrder(userId, productId)).resolves.toEqual({
        status: 'processing',
        orderJobId: 'order:user-999:p-1001',
        message: 'Your order is in the queue.',
      });
      expect(redis.compensate).not.toHaveBeenCalled();
    });

    it('enqueues with a deterministic jobId and BullMQ-only options', async () => {
      // `expect.any()` มี type เป็น `any` — พักไว้ใน unknown ก่อน จะได้ไม่ผิด no-unsafe-assignment
      const anyString: unknown = expect.any(String);

      await service.createOrder(userId, productId, 'corr-1');

      expect(queue.add).toHaveBeenCalledWith(
        'process-order',
        {
          userId,
          productId,
          correlationId: 'corr-1',
          requestToken: anyString,
        },
        expect.objectContaining({
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 200 },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 5000 },
        }),
      );
      // `timeout` เป็น option ของ Bull v4 ไม่ใช่ BullMQ
      const options = queue.add.mock.calls[0][2] as unknown as Record<
        string,
        unknown
      >;
      expect(options).not.toHaveProperty('timeout');
    });

    it('passes the JWT-derived userId straight through to the job payload', async () => {
      await service.createOrder('user-42', productId);

      expect(queue.add).toHaveBeenCalledWith(
        'process-order',
        expect.objectContaining({ userId: 'user-42' }),
        expect.objectContaining({ jobId: 'order:user-42:p-1001' }),
      );
    });
  });

  describe('blocker (b): BullMQ dedups a duplicate jobId silently', () => {
    beforeEach(() => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.ALLOWED);
    });

    it('compensates and throws 409 when the STORED job belongs to an earlier request', async () => {
      // job เดิมค้างอยู่ในคิว (lock หมดอายุก่อนมันถูกหยิบไปทำ)
      // -> add() ถูก dedup, payload ใหม่ถูกทิ้ง, DECR รอบนี้ไม่มีใครกิน
      storedJob = {
        id: jobId,
        data: { userId, productId, requestToken: 'token-of-an-older-request' },
      };

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(redis.compensate).toHaveBeenCalledWith(
        userId,
        productId,
        expect.any(String),
      );
    });

    it('does NOT compensate when the stored job is OUR job, even if a worker already finished it', async () => {
      // race ที่เช็คแบบเดิม (state === 'completed') จับผิด:
      // worker ทำ job ของเราเสร็จภายใน roundtrip เดียว -> ของขายไปแล้วจริง
      // ถ้าคืนสต็อกตรงนี้ Redis จะสูงกว่า DB และคนที่ได้ของจะได้ 409
      await expect(
        service.createOrder(userId, productId),
      ).resolves.toMatchObject({ status: 'processing' });

      expect(redis.compensate).not.toHaveBeenCalled();
    });

    it('does NOT compensate when the stored job cannot be read back', async () => {
      // ยืนยันไม่ได้ != เป็นของคนอื่น — คืนผิดตอนของขายไปแล้วแย่กว่าไม่คืน
      queue.getJob.mockRejectedValue(new Error('redis-data timeout'));

      await expect(
        service.createOrder(userId, productId),
      ).resolves.toMatchObject({ status: 'processing' });

      expect(redis.compensate).not.toHaveBeenCalled();
    });

    it('compensates and throws 503 when queue.add resolves to nothing', async () => {
      queue.add.mockResolvedValue(undefined as unknown as Job<OrderJobData>);

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(redis.compensate).toHaveBeenCalledTimes(1);
    });

    it('still compensates when queue.add genuinely throws', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(redis.compensate).toHaveBeenCalledTimes(1);
    });
  });

  describe('gatekeeper throws: commandTimeout cancels the WAIT, not the command', () => {
    // k6 run 002 (2026-08-27): ioredis โยน `Command timed out` 8 ครั้ง → 500 → ไม่มีใครคืนสต็อก
    // → ของหาย 8 ชิ้นจาก 50 พอดี (DB remaining_stock = 8, orders = 42/50)

    it('restores the stock when the lock proves the reservation was real', async () => {
      redis.gatekeeper.mockRejectedValue(new Error('Command timed out'));
      redis.compensateIfReserved.mockResolvedValue(1); // lock ถือ token ของเรา = DECR เกิดขึ้นแล้ว

      await expect(
        service.createOrder(userId, productId),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(redis.compensateIfReserved).toHaveBeenCalledTimes(1);
      // ต้องคืนด้วย token ตัวเดียวกับที่ gatekeeper พยายามเขียนลง lock
      const [, , attemptedToken] = redis.gatekeeper.mock.calls[0];
      const [, , compensatedToken] = redis.compensateIfReserved.mock.calls[0];
      expect(compensatedToken).toBe(attemptedToken);

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('never uses the unconditional compensate() — that would put Redis ahead of the DB', async () => {
      redis.gatekeeper.mockRejectedValue(new Error('Command timed out'));
      redis.compensateIfReserved.mockResolvedValue(0); // Lua ไม่เคยรัน

      await expect(
        service.createOrder(userId, productId),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // compensate() สั่ง INCR โดยไม่มีเงื่อนไข — เรียกตรงนี้เมื่อไหร่ = เติมสต็อกลอยๆ
      expect(redis.compensate).not.toHaveBeenCalled();
      expect(redis.compensateIfReserved).toHaveBeenCalledTimes(1);
    });

    it('still answers 503 when the compensation itself fails, and does not mask it as 500', async () => {
      redis.gatekeeper.mockRejectedValue(new Error('Command timed out'));
      redis.compensateIfReserved.mockRejectedValue(
        new Error('redis-data down'),
      );

      await expect(
        service.createOrder(userId, productId),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('lock token (requestToken)', () => {
    beforeEach(() => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.ALLOWED);
    });

    it('writes a per-request token into the lock, not the jobId', async () => {
      await service.createOrder(userId, productId);

      const tokenInLock = redis.gatekeeper.mock.calls[0][2];
      expect(tokenInLock).not.toBe(jobId);
      expect(typeof tokenInLock).toBe('string');
      expect(tokenInLock.length).toBeGreaterThan(0);
    });

    it('uses a different token on every request so compare-and-delete can tell them apart', async () => {
      await service.createOrder(userId, productId);
      storedJob = undefined; // จำลองคำขอใหม่ที่ job เดิมหมดไปแล้ว
      await service.createOrder(userId, productId);

      const [first, second] = redis.gatekeeper.mock.calls.map((c) => c[2]);
      expect(first).not.toBe(second);
    });

    it('passes the same token to compensate() that it put in the lock', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));

      await service.createOrder(userId, productId).catch(() => undefined);

      const tokenInLock = redis.gatekeeper.mock.calls[0][2];
      expect(redis.compensate).toHaveBeenCalledWith(
        userId,
        productId,
        tokenInLock,
      );
    });
  });
});
