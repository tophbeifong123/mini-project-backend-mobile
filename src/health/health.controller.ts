import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { DataSource } from 'typeorm';

import { RedisService } from '../redis/redis.service';

/** TypeORM ReplicationMode — ประกาศเองเพื่อไม่ผูกกับ path ภายในของ typeorm */
type ReplicationMode = 'master' | 'slave';

interface LivenessResponse {
  status: 'alive';
  instanceId: string;
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness — ตอบ 200 เสมอถ้า process ยังหายใจอยู่
   *
   * ⚠️ **ห้ามเช็ค DB หรือ Redis ที่นี่เด็ดขาด** (CLAUDE.md §5.4)
   *    ถ้าเช็ค แล้ว DB สะดุดแค่แป๊บเดียว orchestrator จะ restart **ทุก container พร้อมกัน**
   *    = ระบบล่มทั้งคลัสเตอร์จากปัญหาที่หายเองได้
   */
  @Get('live')
  live(): LivenessResponse {
    return {
      status: 'alive',
      instanceId: process.env.INSTANCE_ID ?? 'unknown',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * Readiness — เช็ค dependency จริง: PostgreSQL primary + replica + redis ทั้งสองตัว
   * ถ้าตัวใดตัวหนึ่งล่ม terminus จะตอบ **503** เพื่อให้ nginx ถอด instance นี้ออกจาก pool
   *
   * เช็ค master แยกจาก slave เพราะ DataSource ตั้ง `defaultMode: 'slave'` ไว้
   * ถ้า ping แค่ default จะไม่มีวันรู้เลยว่า primary (ฝั่ง write) ล่มไปแล้ว
   */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.pingDatabase('master', 'postgres-primary'),
      () => this.pingDatabase('slave', 'postgres-replica'),
      () => this.pingRedis('redis-cache', () => this.redis.pingCache()),
      () => this.pingRedis('redis-data', () => this.redis.pingData()),
    ]);
  }

  private async pingDatabase(
    mode: ReplicationMode,
    key: string,
  ): Promise<HealthIndicatorResult> {
    const queryRunner = this.dataSource.createQueryRunner(mode);
    try {
      await queryRunner.connect();
      await queryRunner.query('SELECT 1');
      return { [key]: { status: 'up' as const } };
    } catch (error) {
      throw new HealthCheckError(`${key} check failed`, {
        [key]: {
          status: 'down' as const,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      // release ห้ามกลบ error เดิมที่กำลังโยนอยู่
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async pingRedis(
    key: string,
    ping: () => Promise<boolean>,
  ): Promise<HealthIndicatorResult> {
    try {
      const alive = await ping();
      if (!alive) {
        throw new Error('ping returned false');
      }
      return { [key]: { status: 'up' as const } };
    } catch (error) {
      throw new HealthCheckError(`${key} check failed`, {
        [key]: {
          status: 'down' as const,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
