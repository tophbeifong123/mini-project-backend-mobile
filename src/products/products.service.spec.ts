import type { MetricsService } from '../observability/metrics.service';
import { Repository } from 'typeorm';

import { RedisService } from '../redis/redis.service';
import { Product } from './entities/product.entity';
import { CatalogPage, ProductsService } from './products.service';

interface QueryBuilderMock {
  orderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getManyAndCount: jest.Mock;
}

function buildProduct(overrides: Partial<Product> = {}): Product {
  const product = new Product();
  product.id = 'p-1001';
  product.name = 'Limited Edition Sneaker';
  product.description = 'ไม่ควรโผล่ใน response';
  product.price = 2990;
  product.availableStock = 50;
  product.remainingStock = 50;
  product.isFlashSaleActive = true;
  return Object.assign(product, overrides);
}

describe('ProductsService', () => {
  type RedisMock = jest.Mocked<
    Pick<RedisService, 'getCatalogPage' | 'setCatalogPage' | 'getStocks'>
  >;
  type RepositoryMock = jest.Mocked<
    Pick<Repository<Product>, 'createQueryBuilder'>
  >;

  let service: ProductsService;
  let redis: RedisMock;
  let repository: RepositoryMock;
  let qb: QueryBuilderMock;

  beforeEach(() => {
    qb = {
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([[buildProduct()], 20]),
    };
    qb.orderBy.mockReturnValue(qb);
    qb.skip.mockReturnValue(qb);
    qb.take.mockReturnValue(qb);

    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    redis = {
      getCatalogPage: jest.fn(),
      setCatalogPage: jest.fn(),
      getStocks: jest.fn(),
    };
    redis.getCatalogPage.mockResolvedValue(null);
    redis.setCatalogPage.mockResolvedValue(undefined);
    redis.getStocks.mockResolvedValue(['50']);

    // การวัดผลต้องไม่มีผลต่อ logic — stub ไว้เฉยๆ พอ
    const metrics = { inc: jest.fn() };
    service = new ProductsService(
      repository as unknown as Repository<Product>,
      redis as unknown as RedisService,
      metrics as unknown as MetricsService,
    );
  });

  describe('stock overlay (the "เงื่อนไขสำคัญ" of the assignment)', () => {
    it('takes remainingStock from Redis, NOT from the cached metadata', async () => {
      const cached: CatalogPage = {
        total: 20,
        items: [
          {
            productId: 'p-1001',
            name: 'Limited Edition Sneaker',
            price: 2990,
            availableStock: 50,
            isFlashSaleActive: true,
            fallbackRemainingStock: 50, // ค่าเก่าที่ค้างอยู่ในแคช
          },
        ],
      };
      redis.getCatalogPage.mockResolvedValue(cached);
      redis.getStocks.mockResolvedValue(['30']); // ค่าสดจาก counter

      const result = await service.listProducts(1, 10);

      expect(result.data[0].remainingStock).toBe(30);
      expect(result.data[0].availableStock).toBe(50);
      // cache hit -> ห้ามแตะ DB
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      // แต่ต้อง MGET ทุก request เสมอ
      expect(redis.getStocks).toHaveBeenCalledWith(['p-1001']);
    });

    it('falls back to the row stock only when the counter is missing', async () => {
      redis.getStocks.mockResolvedValue([null]);

      const result = await service.listProducts(1, 10);

      expect(result.data[0].remainingStock).toBe(50);
    });

    it('degrades to the cached fallback instead of failing the whole read', async () => {
      // read path ไม่ใช่พื้นผิวของความถูกต้อง — ไม่มีใครซื้อของจาก response ของ GET
      // ตัวตัดสินคือ gatekeeper.lua ฝั่ง write เท่านั้น
      // การโยน 503 ทำให้ reader ทั้ง 1,000 คนอ่านอะไรไม่ได้เลย เพื่อกัน "เลขเก่านิดหน่อย"
      redis.getStocks.mockRejectedValue(new Error('redis-data down'));

      const result = await service.listProducts(1, 10);

      expect(result.data).toHaveLength(1);
      // ใช้ fallbackRemainingStock ที่ติดมากับ metadata cache
      expect(result.data[0].remainingStock).toBe(50);
      expect(service.getDegradedReadCount()).toBe(1);
    });
  });

  describe('response shape (CLAUDE.md §3)', () => {
    it('serializes price as a number and omits description', async () => {
      const result = await service.listProducts(1, 10);

      expect(typeof result.data[0].price).toBe('number');
      expect(result.data[0].price).toBe(2990);
      expect(result.data[0]).not.toHaveProperty('description');
      expect(Object.keys(result.data[0]).sort()).toEqual(
        [
          'availableStock',
          'isFlashSaleActive',
          'name',
          'price',
          'productId',
          'remainingStock',
        ].sort(),
      );
    });

    it('coerces a NUMERIC string that slipped through into a number', async () => {
      qb.getManyAndCount.mockResolvedValue([
        [buildProduct({ price: '2990.00' as unknown as number })],
        20,
      ]);

      const result = await service.listProducts(1, 10);

      expect(result.data[0].price).toBe(2990);
      expect(typeof result.data[0].price).toBe('number');
    });

    it('computes meta.totalPages from the DB total', async () => {
      const result = await service.listProducts(2, 10);

      expect(result.meta).toEqual({
        total: 20,
        page: 2,
        limit: 10,
        totalPages: 2,
      });
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.orderBy).toHaveBeenCalledWith('product.id', 'ASC');
    });
  });

  describe('cache-aside + single-flight (architecture.md §5.3)', () => {
    it('queries the DB once even when several callers miss concurrently', async () => {
      let releaseDb: (value: [Product[], number]) => void = () => undefined;
      qb.getManyAndCount.mockReturnValue(
        new Promise<[Product[], number]>((resolve) => {
          releaseDb = resolve;
        }),
      );

      const first = service.listProducts(1, 10);
      const second = service.listProducts(1, 10);

      // ปล่อยให้ทั้งสอง request ไปถึงจุด cache miss ก่อน
      await Promise.resolve();
      await Promise.resolve();
      releaseDb([[buildProduct()], 20]);

      const [a, b] = await Promise.all([first, second]);

      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(redis.setCatalogPage).toHaveBeenCalledTimes(1);
      expect(a.data[0].productId).toBe('p-1001');
      expect(b.data[0].productId).toBe('p-1001');
    });

    it('clears the in-flight entry so a later miss hits the DB again', async () => {
      await service.listProducts(1, 10);
      await service.listProducts(1, 10);

      expect(qb.getManyAndCount).toHaveBeenCalledTimes(2);
    });

    it('writes the freshly loaded page back into the cache', async () => {
      await service.listProducts(1, 10);

      expect(redis.setCatalogPage).toHaveBeenCalledWith(
        1,
        10,
        expect.objectContaining({
          total: 20,
          items: [
            expect.objectContaining({
              productId: 'p-1001',
              fallbackRemainingStock: 50,
            }),
          ],
        }),
      );
    });
  });
});
