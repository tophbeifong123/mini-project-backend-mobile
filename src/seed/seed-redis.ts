import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { RedisKeys } from '../redis/redis.keys';
import AppDataSource from '../database/data-source';

interface StockRow {
  id: string;
  remaining_stock: number | string;
}

/**
 * คัดลอก `remaining_stock` จาก DB (source of truth) ไปเป็น counter ใน redis-data
 *
 * ⚠️ ต้องใช้ `SET ... NX` เท่านั้น — instance ที่ 2 และ 3 (หรือการรันซ้ำ) จะได้ไม่เขียนทับ
 *    ค่าที่ถูก DECR ไปแล้ว ซึ่งจะกลายเป็น "สต็อกงอกกลับมา" = oversell (architecture.md §6.1)
 * ⚠️ ต้องรันหลัง `pnpm run seed` เสมอ — ลำดับสลับไม่ได้ (§3.1.5)
 */
export async function seedRedisStockWith(
  dataSource: DataSource,
  client: Redis,
): Promise<void> {
  const rows = await dataSource.query<StockRow[]>(
    `SELECT id, remaining_stock FROM products ORDER BY id ASC`,
  );

  if (rows.length === 0) {
    throw new Error(
      '[seed:redis] no products found — run `pnpm run seed` first (order matters)',
    );
  }

  const pipeline = client.pipeline();
  for (const row of rows) {
    pipeline.set(
      RedisKeys.stock(row.id),
      String(Number(row.remaining_stock)),
      'NX',
    );
  }
  const results = await pipeline.exec();

  let created = 0;
  for (const entry of results ?? []) {
    const [err, value] = entry;
    if (err) {
      throw err;
    }
    if (value === 'OK') {
      created += 1;
    }
  }

  console.log(
    `[seed:redis] ${rows.length} products processed — ${created} counters created, ` +
      `${rows.length - created} already existed (left untouched by NX)`,
  );
}

export async function seedRedisStock(): Promise<void> {
  // ถูกเรียกได้ทั้งแบบ standalone (`pnpm run seed:redis`) และจาก database/migrate-and-seed.ts
  // ที่ initialize DataSource ไว้ให้แล้ว — ใครเปิดคนนั้นปิด ห้ามปิดของคนอื่น
  const ownsDataSource = !AppDataSource.isInitialized;
  if (ownsDataSource) {
    await AppDataSource.initialize();
  }

  const client = new Redis({
    host: process.env.REDIS_DATA_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_DATA_PORT ?? 6380),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  try {
    await seedRedisStockWith(AppDataSource, client);
  } finally {
    await client.quit();
    if (ownsDataSource) {
      await AppDataSource.destroy();
    }
  }
}

if (require.main === module) {
  seedRedisStock().catch((err: unknown) => {
    console.error('[seed:redis] failed:', err);
    process.exit(1);
  });
}
