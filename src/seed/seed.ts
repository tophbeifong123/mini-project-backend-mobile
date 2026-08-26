import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DataSource } from 'typeorm';
import AppDataSource from '../database/data-source';

/** 1 record ใน docs/Requirement/products-seed.json (architecture.md §3.1.5) */
interface SeedProduct {
  productId: string;
  name: string;
  description?: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

/**
 * ทั้ง ts-node (`src/seed`) และ compiled (`dist/seed`) อยู่ลึกจาก root 2 ชั้นเท่ากัน
 * ใน container ไฟล์อยู่ที่ /app/docs/Requirement/products-seed.json
 */
export function resolveSeedFilePath(): string {
  const fromEnv = process.env.SEED_FILE;
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return join(
    __dirname,
    '..',
    '..',
    'docs',
    'Requirement',
    'products-seed.json',
  );
}

function loadSeedFile(): SeedProduct[] {
  const path = resolveSeedFilePath();

  // fail loudly — seed ที่เงียบๆ ไม่ทำงาน = stock counter ว่าง = ทุก order ตอบ 503
  if (!existsSync(path)) {
    throw new Error(
      `Seed file not found: ${path}. Set SEED_FILE or make sure docs/Requirement/products-seed.json is copied into the image.`,
    );
  }

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Seed file ${path} must contain a non-empty JSON array`);
  }

  return parsed.map((row, index) => {
    const item = row as Partial<SeedProduct>;
    if (
      typeof item.productId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.price !== 'number' ||
      typeof item.availableStock !== 'number'
    ) {
      throw new Error(
        `Seed row #${index} is malformed: ${JSON.stringify(row)}`,
      );
    }
    return {
      productId: item.productId,
      name: item.name,
      description: item.description ?? '',
      price: item.price,
      availableStock: item.availableStock,
      isFlashSaleActive: item.isFlashSaleActive === true,
    };
  });
}

/**
 * Upsert สินค้าเข้า DB
 * ⚠️ `remaining_stock` ถูกตั้งเฉพาะ "ตอน insert" เท่านั้น (= available_stock)
 *    ถ้า seed ซ้ำระหว่างที่ขายอยู่แล้วไปเขียนทับ จะกลบยอดที่ขายไปแล้ว
 *    และทำให้ Redis counter กับ DB ไม่ตรงกันถาวร (architecture.md §3.1.5)
 */
export async function seedProducts(dataSource: DataSource): Promise<void> {
  const products = loadSeedFile();

  for (const product of products) {
    await dataSource.query(
      `INSERT INTO products
         (id, name, description, price, available_stock, remaining_stock, is_flash_sale_active)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name                 = EXCLUDED.name,
         description          = EXCLUDED.description,
         price                = EXCLUDED.price,
         available_stock      = EXCLUDED.available_stock,
         is_flash_sale_active = EXCLUDED.is_flash_sale_active,
         updated_at           = now()`,
      [
        product.productId,
        product.name,
        product.description,
        product.price,
        product.availableStock,
        product.isFlashSaleActive,
      ],
    );
  }

  console.log(
    `[seed] upserted ${products.length} products (remaining_stock untouched on existing rows)`,
  );
}

async function main(): Promise<void> {
  const ownsDataSource = !AppDataSource.isInitialized;
  if (ownsDataSource) {
    await AppDataSource.initialize();
  }
  try {
    await seedProducts(AppDataSource);
  } finally {
    if (ownsDataSource) {
      await AppDataSource.destroy();
    }
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
