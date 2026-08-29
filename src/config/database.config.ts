import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Order } from '../orders/entities/order.entity';
import { Product } from '../products/entities/product.entity';

/**
 * TypeORM options สำหรับ runtime ของ app (§8 Connection Pooling)
 *
 * - `replication` สร้าง pool **แยกต่อ master และต่อ slave แต่ละตัว**
 *   → นับแยกต่อเซิร์ฟเวอร์: 6 instances × poolSize 8 = 48 บน primary และ 48 บน replica
 *   (อย่าบวกรวมกัน — มันคนละเซิร์ฟเวอร์ ดู architecture.md §8)
 * - `defaultMode: 'slave'` → read ทั่วไปวิ่งไป replica
 *   ⚠️ write path ของ worker ต้องเรียก `dataSource.createQueryRunner('master')` เองเสมอ
 *   (invariant CLAUDE.md §4 ข้อ 3) เพราะ replica มี lag
 * - `synchronize: false` เด็ดขาด — schema มาจาก migration เท่านั้น (CLAUDE.md §6)
 */
export function buildTypeOrmOptions(
  config: ConfigService,
): TypeOrmModuleOptions {
  const username = config.getOrThrow<string>('DB_USERNAME');
  const password = config.getOrThrow<string>('DB_PASSWORD');
  const database = config.getOrThrow<string>('DB_DATABASE');
  const poolSize = Number(config.get<number>('DB_POOL_SIZE', 10));

  return {
    type: 'postgres',

    replication: {
      master: {
        host: config.getOrThrow<string>('DB_HOST'),
        port: Number(config.get<number>('DB_PORT', 5432)),
        username,
        password,
        database,
      },
      slaves: [
        {
          host: config.getOrThrow<string>('DB_REPLICA_HOST'),
          port: Number(config.get<number>('DB_REPLICA_PORT', 5432)),
          username,
          password,
          database,
        },
      ],
      defaultMode: 'slave',
    },

    // poolSize ถูก apply แยกต่อ pool (master + slave แต่ละตัว)
    poolSize,

    entities: [Product, Order],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],

    // schema จัดการด้วย migration เท่านั้น — app ไม่รัน migration ตอน boot
    // (entrypoint ของ app-1 รัน dist/database/migrate-and-seed.js แทน)
    synchronize: false,
    migrationsRun: false,

    logging: ['error'],
  };
}
