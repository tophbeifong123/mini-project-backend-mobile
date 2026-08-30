import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';

/**
 * RedisService มาจาก RedisModule ที่เป็น @Global() จึงไม่ต้อง import ที่นี่
 * TerminusModule ให้มาแค่ `HealthCheckService` — **ไม่ได้ใช้ `TypeOrmHealthIndicator`**
 * เพราะ indicator สำเร็จรูป ping แยก master กับ slave ไม่ได้
 * controller จึงเขียน `pingDatabase` เองด้วย `createQueryRunner(mode)` (health.controller.ts)
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
