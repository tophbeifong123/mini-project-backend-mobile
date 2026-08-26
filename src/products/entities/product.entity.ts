import { Column, Entity, PrimaryColumn } from 'typeorm';

// ⚠️ node-postgres คืนคอลัมน์ NUMERIC มาเป็น **string** เสมอ (กัน precision หาย)
// ถ้าไม่แปลง response จะเป็น "price": "2990.00" ซึ่ง **ผิด API contract** ที่บังคับเป็น number
// → k6 ของกลุ่มอื่นที่ assert `price === 2990` จะพังทันที
const numericTransformer = {
  to: (value: number): number => value,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
};

@Entity('products')
export class Product {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string; // ⚠️ ห้ามใช้ @PrimaryGeneratedColumn — id มาจาก seed ('p-1001')

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  price!: number;

  @Column({ name: 'available_stock', type: 'int' })
  availableStock!: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock!: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
