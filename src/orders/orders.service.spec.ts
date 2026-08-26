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
  type QueueMock = jest.Mocked<Pick<Queue, 'add'>>;
  type RedisMock = jest.Mocked<Pick<RedisService, 'gatekeeper' | 'compensate'>>;

  let service: OrdersService;
  let queue: QueueMock;
  let redis: RedisMock;
  let job: {
    id: string;
    data?: Partial<OrderJobData>;
    getState: jest.Mock;
  };

  const userId = 'user-999';
  const productId = 'p-1001';
  const jobId = `order:${userId}:${productId}`;

  beforeEach(() => {
    job = { id: jobId, getState: jest.fn().mockResolvedValue('waiting') };

    queue = { add: jest.fn() };
    // จำลอง BullMQ ตอนสร้าง job ใหม่: job ที่คืนมาถือ payload ชุดเดียวกับที่ส่งเข้าไป
    queue.add.mockImplementation(
      (_name: string, data: OrderJobData): Promise<Job<OrderJobData>> => {
        job.data = data;
        return Promise.resolve(job as unknown as Job<OrderJobData>);
      },
    );

    redis = {
      gatekeeper: jest.fn(),
      compensate: jest.fn(),
    };
    redis.compensate.mockResolvedValue(undefined);

    const config = {
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    } as unknown as jest.Mocked<ConfigService>;

    service = new OrdersService(
      queue as unknown as Queue,
      redis as unknown as RedisService,
      config,
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

  describe('blocker (b): BullMQ returns the EXISTING job on a duplicate jobId', () => {
    beforeEach(() => {
      redis.gatekeeper.mockResolvedValue(GatekeeperVerdict.ALLOWED);
    });

    it('compensates and throws 409 when the returned job is already completed', async () => {
      job.getState.mockResolvedValue('completed');

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(redis.compensate).toHaveBeenCalledWith(userId, productId);
    });

    it('compensates and throws 409 when the returned job already failed', async () => {
      job.getState.mockResolvedValue('failed');

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(redis.compensate).toHaveBeenCalledTimes(1);
    });

    it('compensates and throws 503 when queue.add resolves to nothing', async () => {
      queue.add.mockResolvedValue(undefined as unknown as Job<OrderJobData>);

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(redis.compensate).toHaveBeenCalledWith(userId, productId);
    });

    it('still compensates when queue.add genuinely throws', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(redis.compensate).toHaveBeenCalledWith(userId, productId);
    });

    it('does NOT compensate for a freshly queued (waiting) job', async () => {
      job.getState.mockResolvedValue('waiting');

      await service.createOrder(userId, productId);

      expect(redis.compensate).not.toHaveBeenCalled();
    });

    it('compensates when BullMQ returns a PRE-EXISTING job that is still waiting', async () => {
      // in-flight lock หมดอายุก่อน job เดิมถูกหยิบไปทำ → gatekeeper ปล่อยผ่าน + DECR อีกครั้ง
      // แต่ queue.add() คืน job เดิม (jobId ซ้ำ) ซึ่งกิน DECR ไปแค่ครั้งเดียว → ต้องคืนรอบนี้
      queue.add.mockResolvedValue({
        id: jobId,
        data: {
          userId,
          productId,
          requestToken: 'token-from-an-older-request',
        },
        getState: jest.fn().mockResolvedValue('waiting'),
      } as unknown as Job<OrderJobData>);

      const error = await service
        .createOrder(userId, productId)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(redis.compensate).toHaveBeenCalledWith(userId, productId);
    });
  });
});
