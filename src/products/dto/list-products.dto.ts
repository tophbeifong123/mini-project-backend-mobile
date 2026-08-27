import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** เพดานจำนวนแถวต่อหน้า — กัน request ที่ขอทั้งตารางมาทำ replica ล้ม */
export const MAX_PAGE_LIMIT = 100;

/** query ของ `GET /api/v1/products?page=1&limit=10` (CLAUDE.md §3) */
export class ListProductsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  // ⚠️ clamp ไม่ใช่ reject — โจทย์บอกให้ "ลองเปลี่ยน limit ดู" และ k6 ของกลุ่มอื่นอาจส่ง limit
  //    ที่มากกว่าเพดานมา ถ้าตอบ 400 จะยิงข้ามกลุ่มไม่ผ่าน ทั้งที่ไม่ได้ผิด contract §3
  //    → รับไว้แล้วหั่นลงมาที่ MAX_PAGE_LIMIT, `meta.limit` จะรายงานค่าที่ใช้จริง
  @IsOptional()
  @Type(() => Number)
  @Transform(
    ({ value }: { value: unknown }) => {
      const n = Number(value);
      return Number.isFinite(n)
        ? Math.min(Math.trunc(n), MAX_PAGE_LIMIT)
        : value;
    },
    { toClassOnly: true },
  )
  @IsInt()
  @Min(1)
  limit: number = 10;
}
