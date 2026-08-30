import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ORDERS_QUEUE } from '../bullmq_config/bullmq.module';
import { IntegrityService } from './integrity.service';
import { MetricsService } from './metrics.service';
import { ObservabilityController } from './observability.controller';

/**
 * `@Global` เพราะ `MetricsService` ถูกฉีดเข้าไปในเกือบทุก service ที่มีเส้นทางร้อน
 * (orders / products / worker) — ถ้าไม่ global ต้องไล่ import ทุกโมดูลแล้วพังง่ายตอนเพิ่มของใหม่
 *
 * ตัว Redis client มาจาก `RedisModule` ซึ่งเป็น `@Global` อยู่แล้ว
 */
@Global()
@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: ORDERS_QUEUE })],
  controllers: [ObservabilityController],
  providers: [MetricsService, IntegrityService],
  exports: [MetricsService, IntegrityService],
})
export class ObservabilityModule {}
