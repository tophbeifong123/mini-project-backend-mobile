import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';

/**
 * RedisService มาจาก RedisModule ที่เป็น @Global() จึงไม่ต้อง import ที่นี่
 * TypeOrmHealthIndicator มากับ TerminusModule และใช้ DataSource ที่ DatabaseModule ลงทะเบียนไว้
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
