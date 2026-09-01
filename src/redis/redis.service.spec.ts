import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import { RedisService } from './redis.service';

describe('RedisService stock read single-flight', () => {
  function createService(mget: jest.Mock): RedisService {
    const cache = {} as Redis;
    const data = { mget } as unknown as Redis;
    const config = {
      get: (_key: string, fallback: unknown) => fallback,
    } as ConfigService;
    return new RedisService(cache, data, config);
  }

  it('shares only a currently in-flight MGET for the same stock keys', async () => {
    let resolveRead!: (value: (string | null)[]) => void;
    const mget = jest.fn(
      () =>
        new Promise<(string | null)[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const service = createService(mget);

    const first = service.getStocks(['p-1001', 'p-1002']);
    const second = service.getStocks(['p-1001', 'p-1002']);

    expect(mget).toHaveBeenCalledTimes(1);
    resolveRead(['50', '20']);
    await expect(Promise.all([first, second])).resolves.toEqual([
      ['50', '20'],
      ['50', '20'],
    ]);

    // settle แล้วต้องอ่าน Redis ใหม่เสมอ — ไม่ใช่ result cache
    void service.getStocks(['p-1001', 'p-1002']);
    expect(mget).toHaveBeenCalledTimes(2);
  });

  it('does not combine different stock-key sets', async () => {
    const mget = jest.fn().mockResolvedValue(['1']);
    const service = createService(mget);

    await Promise.all([
      service.getStocks(['p-1001']),
      service.getStocks(['p-1002']),
    ]);

    expect(mget).toHaveBeenCalledTimes(2);
  });
});
