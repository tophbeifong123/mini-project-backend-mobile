import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * body ของ `POST /api/v1/orders` (CLAUDE.md §3)
 * ⚠️ ไม่มี `quantity` โดยเจตนา — โจทย์บังคับ 1 ชิ้น/คน และ UNIQUE(user_id, product_id) เป็นตัวบังคับ
 * ⚠️ ไม่มี `userId` — มาจาก JWT claim `sub` เท่านั้น (invariant §4 ข้อ 2)
 */
export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  productId!: string;
}
