import { Controller, Get, Query } from '@nestjs/common';

import { ListProductsDto } from './dto/list-products.dto';
import {
  ProductListMeta,
  ProductResponseItem,
  ProductsService,
} from './products.service';

interface ListProductsResponse {
  status: 'success';
  data: ProductResponseItem[];
  meta: ProductListMeta;
}

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /** read-heavy path (CLAUDE.md §3) — 1,000 concurrent users */
  @Get()
  async listProducts(
    // ⚠️ ห้ามประกาศ ValidationPipe ซ้ำตรงนี้ — global pipe ใน main.ts เป็น superset อยู่แล้ว
    //    (transform + whitelist + enableImplicitConversion) และ pipe ระดับ param
    //    ถูกเรียก "เพิ่ม" ไม่ใช่ "แทนที่" → class-transformer ทำงาน 2 รอบต่อ 1 คำขอ
    //    บน endpoint ที่ร้อนที่สุดของระบบ (ถอดออก 2026-08-31)
    @Query() query: ListProductsDto,
  ): Promise<ListProductsResponse> {
    const { data, meta } = await this.productsService.listProducts(
      query.page,
      query.limit,
    );
    return { status: 'success', data, meta };
  }
}
