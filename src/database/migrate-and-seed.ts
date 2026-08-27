import { seedRedisStock } from '../seed/seed-redis';
import { seedProducts } from '../seed/seed';
import { AppDataSource } from './data-source';

/**
 * Bootstrap script ที่ entrypoint ของ app-1 เรียกก่อนสตาร์ท API
 * (compile แล้วอยู่ที่ `dist/database/migrate-and-seed.js`)
 *
 * ลำดับนี้ **สลับไม่ได้** (§3.1.5):
 *   1) migration  → มีตาราง
 *   2) seed DB    → products + remaining_stock = available_stock
 *   3) seed Redis → SET stock:flash_sale:{id} NX จากค่าใน DB
 *
 * ถ้าพังต้อง exit 1 ให้ดังๆ ไม่งั้น app จะขึ้นมาโดยที่ stock counter ยังไม่ถูก seed
 * แล้ว POST /orders จะตอบ 503 ทั้งการทดสอบ
 */
async function main(): Promise<void> {
  const started = Date.now();
  console.log('[migrate-and-seed] initializing data source...');
  await AppDataSource.initialize();

  try {
    const applied = await AppDataSource.runMigrations({ transaction: 'each' });
    console.log(
      `[migrate-and-seed] migrations applied: ${
        applied.length === 0
          ? '(none pending)'
          : applied.map((m) => m.name).join(', ')
      }`,
    );

    console.log('[migrate-and-seed] seeding products into PostgreSQL...');
    await seedProducts(AppDataSource);

    console.log('[migrate-and-seed] seeding stock counters into redis-data...');
    await seedRedisStock();

    console.log(`[migrate-and-seed] done in ${Date.now() - started}ms`);
  } finally {
    await AppDataSource.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[migrate-and-seed] FAILED', error);
    process.exit(1);
  });
