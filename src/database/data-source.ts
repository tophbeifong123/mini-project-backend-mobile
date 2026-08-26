import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DataSource } from 'typeorm';

/**
 * โหลด .env แบบไม่พึ่ง dependency
 * (pnpm ใช้ node_modules แบบ strict — `dotenv` เป็น transitive dep ของ @nestjs/config
 *  จึง import ตรงๆ ไม่ได้ ถ้าไม่ได้ประกาศไว้ใน package.json)
 * ค่าที่มีอยู่แล้วใน process.env ชนะเสมอ (container inject env มาให้)
 */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

/**
 * DataSource สำหรับ TypeORM CLI (`typeorm-ts-node-commonjs -d src/database/data-source.ts`)
 * และสำหรับ `database/migrate-and-seed.ts`
 *
 * ⚠️ **master only** — ไม่มี replication ที่นี่โดยเจตนา
 *    migration ต้องวิ่งเข้า primary เสมอ ถ้าเผลอไป replica จะเจอ read-only error
 *
 * path ใช้ `__dirname` เพื่อให้ทำงานได้ทั้งตอนรันจาก `src/` (ts-node) และ `dist/` (node)
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'flashsale',
  password: process.env.DB_PASSWORD ?? 'flashsale',
  database: process.env.DB_DATABASE ?? 'flashsale',

  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],

  synchronize: false,
  migrationsRun: false,
  logging: ['error', 'migration'],
});

export default AppDataSource;
