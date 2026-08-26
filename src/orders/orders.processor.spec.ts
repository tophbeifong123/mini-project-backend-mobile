import { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { RedisService } from '../redis/redis.service';
import { OrdersProcessor } from './orders.processor';
import { OrderJobData } from './orders.service';

interface UpdateQueryBuilderMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  execute: jest.Mock;
}

interface QueryRunnerMock {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  release: jest.Mock;
  isReleased: boolean;
  isTransactionActive: boolean;
  manager: {
    createQueryBuilder: jest.Mock;
    insert: jest.Mock;
  };
}

function createQueryRunnerMock(): {
  queryRunner: QueryRunnerMock;
  updateQb: UpdateQueryBuilderMock;
} {
  const updateQb: UpdateQueryBuilderMock = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  updateQb.update.mockReturnValue(updateQb);
  updateQb.set.mockReturnValue(updateQb);
  updateQb.where.mockReturnValue(updateQb);

  const queryRunner: QueryRunnerMock = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
    isReleased: false,
    isTransactionActive: true,
    manager: {
      createQueryBuilder: jest.fn().mockReturnValue(updateQb),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'uuid-1' }] }),
    },
  };
  queryRunner.release.mockImplementation(() => {
    queryRunner.isReleased = true;
    return Promise.resolve();
  });

  return { queryRunner, updateQb };
}

function createJob(
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
): Job<OrderJobData> {
  return {
    id: 'order:user-999:p-1001',
    data: { userId: 'user-999', productId: 'p-1001' },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<OrderJobData>;
}

describe('OrdersProcessor', () => {
  type RedisMock = jest.Mocked<
    Pick<
      RedisService,
      | 'compensateOnce'
      | 'markBought'
      | 'releaseInFlightLock'
      | 'invalidateCatalogCache'
    >
  >;

  let processor: OrdersProcessor;
  let redis: RedisMock;
  let queryRunner: QueryRunnerMock;
  let updateQb: UpdateQueryBuilderMock;
  let dataSource: { createQueryRunner: jest.Mock };

  beforeEach(() => {
    const mocks = createQueryRunnerMock();
    queryRunner = mocks.queryRunner;
    updateQb = mocks.updateQb;

    dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };

    redis = {
      compensateOnce: jest.fn(),
      markBought: jest.fn(),
      releaseInFlightLock: jest.fn(),
      invalidateCatalogCache: jest.fn(),
    };
    redis.compensateOnce.mockResolvedValue(1);
    redis.markBought.mockResolvedValue(undefined);
    redis.releaseInFlightLock.mockResolvedValue(undefined);
    redis.invalidateCatalogCache.mockResolvedValue(undefined);

    processor = new OrdersProcessor(
      dataSource as unknown as DataSource,
      redis as unknown as RedisService,
    );
  });

  it('writes through the master query runner only (invariant §4.3)', async () => {
    await processor.process(createJob());

    expect(dataSource.createQueryRunner).toHaveBeenCalledWith('master');
  });

  it('decrements atomically without a pre-SELECT (invariant §4.4)', async () => {
    await processor.process(createJob());

    expect(updateQb.where).toHaveBeenCalledWith(
      'id = :productId AND remaining_stock > 0',
      { productId: 'p-1001' },
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns sold_out (never throws) when affected === 0, and compensates', async () => {
    updateQb.execute.mockResolvedValue({ affected: 0 });

    await expect(processor.process(createJob())).resolves.toEqual({
      status: 'sold_out',
    });

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(redis.compensateOnce).toHaveBeenCalledWith(
      'order:user-999:p-1001',
      'user-999',
      'p-1001',
    );
    // permanent failure -> ห้ามทำ side effect หลัง commit
    expect(redis.markBought).not.toHaveBeenCalled();
  });

  it('treats PG 23505 as already_confirmed and does NOT compensate', async () => {
    queryRunner.manager.insert.mockRejectedValue(
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
    );

    await expect(processor.process(createJob())).resolves.toEqual({
      status: 'already_confirmed',
    });

    expect(redis.compensateOnce).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  describe('blocker (a): compensate only on a FINAL failure', () => {
    it('does NOT compensate on a transient failure that will be retried', async () => {
      updateQb.execute.mockRejectedValue(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      );

      await expect(
        processor.process(createJob({ attemptsMade: 0, attempts: 3 })),
      ).rejects.toThrow('deadlock detected');

      expect(redis.compensateOnce).not.toHaveBeenCalled();
    });

    it('DOES compensate on the final attempt, and still rethrows', async () => {
      updateQb.execute.mockRejectedValue(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      );

      await expect(
        processor.process(createJob({ attemptsMade: 2, attempts: 3 })),
      ).rejects.toThrow('deadlock detected');

      expect(redis.compensateOnce).toHaveBeenCalledTimes(1);
    });
  });

  describe('post-commit side effects (invariant §4.7)', () => {
    it('runs markBought / releaseInFlightLock / invalidateCatalogCache after commit', async () => {
      await expect(processor.process(createJob())).resolves.toEqual({
        status: 'confirmed',
      });

      expect(redis.markBought).toHaveBeenCalledWith('p-1001', 'user-999');
      expect(redis.releaseInFlightLock).toHaveBeenCalledWith(
        'user-999',
        'p-1001',
        'order:user-999:p-1001',
      );
      expect(redis.invalidateCatalogCache).toHaveBeenCalledTimes(1);
    });

    it('never rolls back or compensates when a side effect fails', async () => {
      redis.markBought.mockRejectedValue(new Error('redis-data blip'));

      await expect(processor.process(createJob())).resolves.toEqual({
        status: 'confirmed',
      });

      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(redis.compensateOnce).not.toHaveBeenCalled();
    });
  });
});
