import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const ORDERS_QUEUE = 'orders';

/**
 * BullMQ ต่อเข้า **redis-data** เท่านั้น (noeviction + AOF)
 * ห้ามไปใช้ redis-cache ที่เป็น allkeys-lru — job หายเงียบๆ (invariant CLAUDE.md §4 ข้อ 11)
 *
 * ⚠️ ใช้ `@nestjs/bullmq` + `bullmq` เท่านั้น ห้าม `bull` / `@nestjs/bull`
 *
 * `removeOnComplete/removeOnFail: false` เป็นเรื่องของ **ความถูกต้อง ไม่ใช่แค่ debug**:
 * dedup ของเราพึ่ง BullMQ ปฏิเสธ jobId ซ้ำ (invariant §4 ข้อ 9) ซึ่งทำงานได้ก็ต่อเมื่อ
 * job เดิมยังอยู่ใน Redis. ถ้าลบทิ้ง คนเดิมจะสั่งซื้อซ้ำได้
 * (และ Bull-Board ต้องโชว์ Completed = 50 ตาม §9.1 ด้วย)
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_DATA_HOST'),
          port: Number(config.get<number>('REDIS_DATA_PORT', 6379)),
          // BullMQ บังคับให้ ioredis ไม่จำกัดจำนวน retry ของคำสั่งที่ค้าง
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 500 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      }),
    }),

    BullModule.registerQueue({ name: ORDERS_QUEUE }),
  ],
  exports: [BullModule],
})
export class BullMqModule {}
