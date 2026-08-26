import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum OrderStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
@Unique('uq_user_product_order', ['userId', 'productId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId!: string; // = JWT `sub` เท่านั้น ห้ามรับจาก body (CLAUDE.md §4 ข้อ 2)

  @Index()
  @Column({ name: 'product_id', type: 'varchar', length: 32 })
  productId!: string;

  @Column({ type: 'varchar', length: 16, default: OrderStatus.CONFIRMED })
  status!: OrderStatus;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
