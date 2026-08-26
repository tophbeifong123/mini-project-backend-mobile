import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema — DDL ตรงตาม docs/Architecture/architecture.md §3.1.1
 *
 * หมายเหตุที่ห้ามลืม:
 * - `products.id` เป็น VARCHAR PK ที่กำหนดเอง ('p-1001') ห้าม generate (§3.1.4 ข้อ 2)
 * - `orders.user_id` **ไม่มี FK โดยเจตนา** เพราะไม่มีตาราง users (§3.1.4 ข้อ 3)
 * - `uq_user_product_order` = ด่านสุดท้ายของกฎ "1 ชิ้น/คน" (§6.4)
 * - `gen_random_uuid()` เป็น built-in ตั้งแต่ PostgreSQL 13 — บน PG 16 ไม่ต้องลง pgcrypto
 */
export class InitSchema1787000000000 implements MigrationInterface {
  name = 'InitSchema1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE products (
        id                    VARCHAR(32)    PRIMARY KEY,
        name                  VARCHAR(255)   NOT NULL,
        description           TEXT           NOT NULL DEFAULT '',
        price                 NUMERIC(10,2)  NOT NULL,
        available_stock       INTEGER        NOT NULL,
        remaining_stock       INTEGER        NOT NULL,
        is_flash_sale_active  BOOLEAN        NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),

        CONSTRAINT chk_positive_stock CHECK (remaining_stock >= 0),
        CONSTRAINT chk_stock_ceiling  CHECK (remaining_stock <= available_stock),
        CONSTRAINT chk_price_positive CHECK (price >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE orders (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     VARCHAR(64)  NOT NULL,
        product_id  VARCHAR(32)  NOT NULL REFERENCES products(id),
        status      VARCHAR(16)  NOT NULL DEFAULT 'CONFIRMED',
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

        CONSTRAINT uq_user_product_order UNIQUE (user_id, product_id),
        CONSTRAINT chk_order_status CHECK (status IN ('CONFIRMED', 'CANCELLED'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_orders_product ON orders (product_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_orders_product`);
    await queryRunner.query(`DROP TABLE IF EXISTS orders`);
    await queryRunner.query(`DROP TABLE IF EXISTS products`);
  }
}
