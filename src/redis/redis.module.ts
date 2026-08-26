import { Global, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis, { RedisOptions } from 'ioredis';

import { REDIS_CACHE_CLIENT, REDIS_DATA_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

function buildOptions(
  config: ConfigService,
  hostKey: string,
  portKey: string,
  hostDefault: string,
  portDefault: number,
  connectionName: string,
): RedisOptions {
  const logger = new Logger(`Redis:${connectionName}`);

  return {
    host: config.get<string>(hostKey, hostDefault),
    port: Number(config.get<string | number>(portKey, portDefault)),
    connectionName,
    // BullMQ บังคับ null และ worker/blocking command ก็ต้องการแบบนี้เช่นกัน
    maxRetriesPerRequest: null,
    /**
     * ⚠️ ขาดบรรทัดนี้ไม่ได้ — `maxRetriesPerRequest: null` แปลว่า "ไม่ยอมแพ้"
     * ถ้าไม่มี timeout ด้วย คำสั่งจะ **ค้าง** ไม่ reject ตอน Redis สะดุด
     * → `try/catch` + fallback ที่เขียนไว้ทุกที่ไม่มีวันทำงาน
     * → request ค้างจนชน `proxy_read_timeout 5s` ของ nginx แล้วกลายเป็น 504
     * ซึ่งขัดกับกฎ `CLAUDE.md` §6 ที่ว่า "Redis คือ optimization ไม่ใช่ dependency"
     * ตั้ง 1 วิ: นานกว่า p99 ปกติหลายสิบเท่า แต่สั้นกว่า timeout ของ nginx มาก
     */
    commandTimeout: 1_000,
    enableReadyCheck: true,
    lazyConnect: false,
    // exponential backoff แบบมีเพดาน — ระหว่าง flash sale ห้าม hammer redis
    retryStrategy: (times: number): number => {
      const delay = Math.min(times * 200, 3000);
      if (times === 1 || times % 10 === 0) {
        logger.warn(`reconnecting (attempt ${times}) in ${delay}ms`);
      }
      return delay;
    },
    reconnectOnError: (err: Error): boolean => err.message.includes('READONLY'),
  };
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CACHE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(
          buildOptions(
            config,
            'REDIS_CACHE_HOST',
            'REDIS_CACHE_PORT',
            'redis-cache',
            6379,
            'flash-sale-cache',
          ),
        ),
    },
    {
      provide: REDIS_DATA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(
          buildOptions(
            config,
            'REDIS_DATA_HOST',
            'REDIS_DATA_PORT',
            'redis-data',
            6379,
            'flash-sale-data',
          ),
        ),
    },
    RedisService,
  ],
  exports: [REDIS_CACHE_CLIENT, REDIS_DATA_CLIENT, RedisService],
})
export class RedisModule implements OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** graceful shutdown — flush command ที่ค้างอยู่ก่อนปิด (CLAUDE.md §6 DO) */
  async onModuleDestroy(): Promise<void> {
    for (const token of [REDIS_CACHE_CLIENT, REDIS_DATA_CLIENT]) {
      try {
        const client = this.moduleRef.get<Redis>(token, { strict: false });
        await client.quit();
      } catch (err) {
        this.logger.warn(
          `failed to quit ${token}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
