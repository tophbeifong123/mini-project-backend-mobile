import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';

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
    // ประกาศ pipe ตรงนี้ด้วย เพื่อให้ค่า default ของ DTO ทำงานแน่นอน
    // ไม่ว่า global ValidationPipe จะตั้ง transform ไว้หรือไม่
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: ListProductsDto,
  ): Promise<ListProductsResponse> {
    const { data, meta } = await this.productsService.listProducts(
      query.page,
      query.limit,
    );
    return { status: 'success', data, meta };
  }
}
