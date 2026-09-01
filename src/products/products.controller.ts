import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { MAX_PAGE_LIMIT } from './dto/list-products.dto';
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

interface ProductsQuery {
  page?: unknown;
  limit?: unknown;
}

/**
 * Parser เล็กสำหรับ hot read path โดยเฉพาะ
 *
 * การใช้ class-transformer + class-validator กับ DTO สร้าง class/metadata traversal
 * ทุกคำขอ ทั้งที่ endpoint นี้รับเพียง positive integer สองค่า ฟังก์ชันนี้คง
 * contract เดิมครบ: optional, ค่าเริ่มต้น, จำนวนเต็ม >= 1 และ clamp limit
 * แต่ไม่สร้าง object graph เพิ่มบนเส้นทางที่ถูกยิงหลักพันครั้งต่อวินาที
 */
function positiveQueryInteger(
  name: 'page' | 'limit',
  raw: unknown,
  fallback: number,
  maximum?: number,
): number {
  if (raw === undefined) {
    return fallback;
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new BadRequestException(`${name} must be an integer number`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException(`${name} must not be less than 1`);
  }

  return maximum === undefined ? value : Math.min(value, maximum);
}

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /** read-heavy path (CLAUDE.md §3) — 1,000 concurrent users */
  @Get()
  async listProducts(
    // ใช้ interface (runtime metatype = Object) เพื่อให้ global ValidationPipe ข้าม
    // class transformation; validation ที่เทียบเท่า contract ทำด้านล่างแบบ allocation ต่ำ
    @Query() query: ProductsQuery,
  ): Promise<ListProductsResponse> {
    const page = positiveQueryInteger('page', query.page, 1);
    const limit = positiveQueryInteger(
      'limit',
      query.limit,
      10,
      MAX_PAGE_LIMIT,
    );
    const { data, meta } = await this.productsService.listProducts(page, limit);
    return { status: 'success', data, meta };
  }
}
