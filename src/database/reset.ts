/**
 * `pnpm run reset` — ล้างสถานะของรอบทดสอบให้กลับไปเป็นตอนเริ่ม
 *
 * ทำไมต้องมี: หลังยิง k6 หนึ่งรอบ ระบบจะ "ติดล็อค" ตัวเองอย่างสมบูรณ์
 *   - `seed.ts` ใช้ `ON CONFLICT DO UPDATE` ที่ **ไม่แตะ** `remaining_stock`
 *   - `seed-redis.ts` ใช้ `SET ... NX` จึงเขียนทับ counter ที่เป็น 0 ไม่ได้
 *   - `bought:{productId}:{userId}` **ไม่มี TTL** และถูก persist ลง AOF
 * → re-seed ซ้ำกี่รอบก็ไม่เปลี่ยนอะไร ยิงรอบสองได้ 409 ทั้งหมด
 * → และกลุ่มเพื่อนที่มายิงด้วย `user-1..user-500` ชุดเดียวกันก็จะได้ 409 ทั้งหมดเช่นกัน
 *
 * ⚠️ สคริปต์นี้ **ลบข้อมูล** (`CLAUDE.md` §8) จึงบังคับให้ยืนยันด้วย `RESET_CONFIRM=yes`
 *
 * ใช้:  RESET_CONFIRM=yes pnpm run reset
 */
import Redis from 'ioredis';

import { RedisKeys } from '../redis/redis.keys';
import AppDataSource from './data-source';
import { seedProducts } from '../seed/seed';
import { seedRedisStockWith } from '../seed/seed-redis';

/** ลบ key ตาม pattern ด้วย SCAN — ห้ามใช้ KEYS (O(N) + บล็อก Redis ทั้งตัว, CLAUDE.md §6) */
async function deleteByPattern(
  client: Redis,
  pattern: string,
): Promise<number> {
  let cursor = '0';
  let deleted = 0;

  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) {
      deleted += await client.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
}

export async function resetAll(): Promise<void> {
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
    // ── 1) DB: orders ก่อน products (products มี FK ชี้มาจาก orders) ──
    const orders = await AppDataSource.query<{ count: string }[]>(
      `WITH deleted AS (DELETE FROM orders RETURNING 1)
       SELECT COUNT(*)::text AS count FROM deleted`,
    );
    await AppDataSource.query(
      `UPDATE products SET remaining_stock = available_stock, updated_at = now()`,
    );
    console.log(
      `[reset] orders ลบไป ${orders[0]?.count ?? '0'} แถว · remaining_stock = available_stock แล้ว`,
    );

    // ── 2) Redis: ลบทุก key ของรอบขาย ──
    const stock = await deleteByPattern(client, RedisKeys.stock('*'));
    const bought = await deleteByPattern(client, RedisKeys.bought('*', '*'));
    const locks = await deleteByPattern(client, RedisKeys.orderLock('*', '*'));
    const guards = await deleteByPattern(client, RedisKeys.compensated('*'));
    // ตัวนับ observability ต้องล้างด้วย ไม่งั้นตัวเลขในรายงานจะเป็นผลรวมของหลายรอบ
    const metrics = await client.del(
      RedisKeys.metricsCounters(),
      RedisKeys.metricsInstances(),
    );
    console.log(
      `[reset] redis-data ลบ stock=${stock} bought=${bought} lock=${locks} ` +
        `compensated=${guards} metrics=${metrics}`,
    );

    // ── 3) seed ใหม่ ลำดับนี้สลับไม่ได้ (Redis คัดลอกค่ามาจาก DB) ──
    await seedProducts(AppDataSource);
    await seedRedisStockWith(AppDataSource, client);

    console.log('[reset] เสร็จแล้ว — ยิง k6 รอบใหม่ได้เลย');
    console.log(
      '[reset] ⚠️ BullMQ jobs ไม่ได้ถูกลบ — ถ้าต้องการล้าง Bull-Board ให้ใช้ปุ่มใน dashboard',
    );
  } finally {
    await client.quit();
    if (ownsDataSource) {
      await AppDataSource.destroy();
    }
  }
}

async function main(): Promise<void> {
  if (process.env.RESET_CONFIRM !== 'yes') {
    console.error(
      '[reset] ปฏิเสธ — สคริปต์นี้ลบ orders ทั้งตารางและ key ใน redis-data\n' +
        '        ถ้าตั้งใจจริง ให้รัน:  RESET_CONFIRM=yes pnpm run reset',
    );
    process.exit(1);
  }
  await resetAll();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[reset] ล้มเหลว:', err);
    process.exit(1);
  });
}
