import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Metric } from '../observability/metrics.constants';
import { MetricsService } from '../observability/metrics.service';
import { RedisService } from '../redis/redis.service';
import { Product } from './entities/product.entity';

/**
 * metadata ของสินค้า 1 ตัวที่ "แคชได้นาน" — ไม่มี remainingStock สดอยู่ในนี้
 * (architecture.md §5.1 — หัวใจของ "เงื่อนไขสำคัญ" ในโจทย์)
 *
 * `fallbackRemainingStock` = ค่า remaining_stock จาก DB ณ ตอนที่แคชถูกสร้าง
 * ใช้ *เฉพาะ* ตอน counter ใน redis-data ไม่มีค่า (ยังไม่ seed) เท่านั้น — ไม่ใช่ค่าที่ส่งออกปกติ
 */
export interface ProductMetadata {
  productId: string;
  name: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
  fallbackRemainingStock: number;
}

/** payload ที่ถูกเก็บใน `catalog:page:{p}:limit:{l}` */
export interface CatalogPage {
  items: ProductMetadata[];
  total: number;
}

/** 1 element ของ `data[]` ใน response — ตรงตาม CLAUDE.md §3 เป๊ะๆ */
export interface ProductResponseItem {
  productId: string;
  name: string;
  price: number;
  availableStock: number;
  remainingStock: number;
  isFlashSaleActive: boolean;
}

export interface ProductListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductListResult {
  data: ProductResponseItem[];
  meta: ProductListMeta;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  /**
   * Single-flight promise memoization (architecture.md §5.3)
   * เก็บเฉพาะ *in-flight request* ของ process นี้ และลบทิ้งใน `finally` เสมอ
   * → ไม่ใช่การเก็บผลลัพธ์ข้ามคำขอ จึงไม่ผิดกฎ stateless (CLAUDE.md §5 ข้อ 1)
   */
  private readonly inFlight = new Map<string, Promise<CatalogPage>>();

  /** นับ response ที่ remainingStock มาจากแคชแทน Redis (redis-data อ่านไม่ได้) */
  private degradedReads = 0;

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  async listProducts(page: number, limit: number): Promise<ProductListResult> {
    // 1) metadata: cache-aside (+ single-flight ตอน miss)
    const cached = await this.redis.getCatalogPage<CatalogPage>(page, limit);
    this.metrics.inc(
      cached ? Metric.CATALOG_CACHE_HITS : Metric.CATALOG_CACHE_MISSES,
    );
    const catalog = cached ?? (await this.loadCatalogPage(page, limit));

    // 2) stock overlay: MGET สดทุก request — ห้ามแคช (CLAUDE.md §3 / §5)
    const productIds = catalog.items.map((item) => item.productId);
    const stocks = await this.readStocks(productIds);

    // 3) merge
    const data: ProductResponseItem[] = catalog.items.map((item, index) => {
      const raw = stocks[index];
      return {
        productId: item.productId,
        name: item.name,
        price: Number(item.price),
        availableStock: item.availableStock,
        remainingStock:
          raw === null || raw === undefined
            ? item.fallbackRemainingStock
            : Number(raw),
        isFlashSaleActive: item.isFlashSaleActive,
      };
    });

    const safeLimit = limit > 0 ? limit : 1;
    return {
      data,
      meta: {
        total: catalog.total,
        page,
        limit,
        totalPages: Math.ceil(catalog.total / safeLimit),
      },
    };
  }

  /**
   * อ่าน stock counter — ถ้า redis-data ล่ม ให้ **degrade ไม่ใช่ล้ม**
   *
   * เดิมที่นี่โยน 503 ด้วยเหตุผลว่า `remainingStock` เป็น "เงื่อนไขสำคัญ" ของโจทย์
   * แต่ read path **ไม่ใช่พื้นผิวของความถูกต้อง** — ไม่มีใครซื้อของจาก response ของ GET
   * ตัวตัดสินว่าใครได้ของคือ `gatekeeper.lua` ฝั่ง write เท่านั้น
   * เลขที่เก่าไปนิดจึงทำให้ oversell ไม่ได้ ทำให้ซื้อซ้ำไม่ได้ ทำให้ Redis/DB เพี้ยนไม่ได้
   *
   * ในทางกลับกัน การโยน 503 ทำให้ reader ทั้ง 1,000 คนอ่านอะไรไม่ได้เลย
   * (และถ้า redis ค้างแทนที่จะ error จะกลายเป็น 504 จาก nginx ซึ่งแย่กว่าอีก
   *  — ดู `commandTimeout` ใน redis.module.ts)
   *
   * ⚠️ `fallbackRemainingStock` คือค่า DB ตอนเติมแคช ระหว่าง burst มันอาจบอก 47 ทั้งที่จริงเป็น 0
   *    เพราะฉะนั้นต้อง **นับและ log ให้เห็น** ไม่ใช่เงียบ — รายงานต้องบอกได้ว่าเสิร์ฟ degraded ไปกี่ใบ
   */
  private async readStocks(productIds: string[]): Promise<(string | null)[]> {
    try {
      return await this.redis.getStocks(productIds);
    } catch (err) {
      this.degradedReads += 1;
      this.metrics.inc(Metric.CATALOG_DEGRADED_READS);
      this.logger.error(
        `stock counter read failed — serving cached fallback ` +
          `(degraded responses so far: ${this.degradedReads}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      // คืน null ทุกช่อง → ตัว merge จะใช้ fallbackRemainingStock ให้เอง
      return productIds.map(() => null);
    }
  }

  /** จำนวน response ที่เสิร์ฟด้วยสต็อกจากแคชเพราะอ่าน redis-data ไม่ได้ (สำหรับรายงาน) */
  getDegradedReadCount(): number {
    return this.degradedReads;
  }

  /** cache miss -> แชร์ promise เดียวกันทุกคนที่ขอหน้าเดียวกันอยู่ในขณะนั้น */
  private async loadCatalogPage(
    page: number,
    limit: number,
  ): Promise<CatalogPage> {
    const key = `${page}:${limit}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.fetchAndCacheCatalogPage(page, limit).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async fetchAndCacheCatalogPage(
    page: number,
    limit: number,
  ): Promise<CatalogPage> {
    // อ่านจาก replica ได้ (metadata ไม่ต้อง lock) — ⚠️ ORDER BY id ASC ต้องมีเสมอ
    // LIMIT/OFFSET ที่ไม่ deterministic จะข้าม/คืนแถวซ้ำ (architecture.md §3.1.1)
    const [rows, total] = await this.productsRepository
      .createQueryBuilder('product')
      .orderBy('product.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const catalog: CatalogPage = {
      total,
      items: rows.map((row) => ({
        productId: row.id,
        name: row.name,
        price: Number(row.price),
        availableStock: row.availableStock,
        isFlashSaleActive: row.isFlashSaleActive,
        fallbackRemainingStock: row.remainingStock,
      })),
    };

    // update DB -> แล้วค่อยเขียน cache (TTL + jitter อยู่ใน RedisService)
    await this.redis.setCatalogPage<CatalogPage>(page, limit, catalog);
    return catalog;
  }
}
