import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BULL_BOARD_BASE_PATH } from '../bull_board/bull-board.service';
import { renderInsightsPage } from './insights.page';
import type { IntegrityReport } from './integrity.service';
import { IntegrityService } from './integrity.service';
import type { InstanceSnapshot } from './metrics.service';
import { MetricsService } from './metrics.service';

interface InsightsPayload {
  counters: Record<string, number>;
  instances: InstanceSnapshot[];
  integrity: IntegrityReport;
}

/**
 * ทุกอย่างอยู่ใต้ `/admin` เดียวกับ Bull-Board โดยเจตนา —
 * `main.ts` ครอบ Basic Auth ที่ prefix นี้ทีเดียว จะได้ไม่มีทางเผลอเปิดหน้าใดหน้าหนึ่งทิ้งไว้
 */
@Controller('admin')
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly integrity: IntegrityService,
    private readonly config: ConfigService,
  ) {}

  @Get('insights')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderInsightsPage({
      instanceId: this.config.get<string>('INSTANCE_ID', 'app'),
      nodeEnv: this.config.get<string>('NODE_ENV', 'development'),
      queuesPath: BULL_BOARD_BASE_PATH,
    });
  }

  @Get('insights.json')
  async snapshot(): Promise<InsightsPayload> {
    const [counters, instances, integrity] = await Promise.all([
      this.metrics.readCounters(),
      this.metrics.readInstances(),
      this.integrity.check(),
    ]);
    return { counters, instances, integrity };
  }

  /**
   * Prometheus exposition format — ยังไม่มี Prometheus ในสแตก (ตามที่ตกลงว่าไม่เพิ่ม service)
   * แต่เปิดไว้ให้ชี้ scrape มาได้ทันทีถ้าจะต่อทีหลัง และ `curl` ดูดิบๆ ก็อ่านออก
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prometheus(): Promise<string> {
    const [counters, instances, report] = await Promise.all([
      this.metrics.readCounters(),
      this.metrics.readInstances(),
      this.integrity.check(),
    ]);

    const lines: string[] = [];

    for (const [name, value] of Object.entries(counters).sort()) {
      const type = name.endsWith('_total') ? 'counter' : 'gauge';
      lines.push(`# TYPE ${name} ${type}`, `${name} ${value}`);
    }

    lines.push(
      '# HELP flash_sale_stock_db_remaining remaining_stock ใน PostgreSQL primary',
      '# TYPE flash_sale_stock_db_remaining gauge',
    );
    for (const row of report.products) {
      lines.push(
        `flash_sale_stock_db_remaining{product_id="${row.productId}"} ${row.dbRemaining}`,
      );
    }

    lines.push(
      '# HELP flash_sale_stock_redis_remaining stock counter ใน redis-data',
      '# TYPE flash_sale_stock_redis_remaining gauge',
    );
    for (const row of report.products) {
      if (row.redisRemaining !== null) {
        lines.push(
          `flash_sale_stock_redis_remaining{product_id="${row.productId}"} ${row.redisRemaining}`,
        );
      }
    }

    lines.push(
      '# HELP flash_sale_stock_drift redis − db (บวก = อันตราย)',
      '# TYPE flash_sale_stock_drift gauge',
    );
    for (const row of report.products) {
      if (row.drift !== null) {
        lines.push(
          `flash_sale_stock_drift{product_id="${row.productId}"} ${row.drift}`,
        );
      }
    }

    lines.push(
      '# HELP flash_sale_orders_persisted จำนวน order ในตาราง orders',
      '# TYPE flash_sale_orders_persisted gauge',
    );
    for (const row of report.products) {
      lines.push(
        `flash_sale_orders_persisted{product_id="${row.productId}"} ${row.orders}`,
      );
    }

    lines.push(
      '# HELP flash_sale_integrity_verdict 0=ok 1=warn 2=critical',
      '# TYPE flash_sale_integrity_verdict gauge',
      `flash_sale_integrity_verdict ${
        report.verdict === 'ok' ? 0 : report.verdict === 'critical' ? 2 : 1
      }`,
    );

    if (report.queue) {
      lines.push('# TYPE flash_sale_queue_jobs gauge');
      for (const [state, count] of Object.entries(report.queue)) {
        lines.push(`flash_sale_queue_jobs{state="${state}"} ${count}`);
      }
    }

    if (report.replicationLagSeconds !== null) {
      lines.push(
        '# TYPE flash_sale_replication_lag_seconds gauge',
        `flash_sale_replication_lag_seconds ${report.replicationLagSeconds}`,
      );
    }

    for (const redis of report.redis) {
      if (!redis.reachable) continue;
      lines.push(
        `flash_sale_redis_ops_per_second{role="${redis.role}"} ${redis.opsPerSecond ?? 0}`,
        `flash_sale_redis_used_memory_mb{role="${redis.role}"} ${redis.usedMemoryMb ?? 0}`,
        `flash_sale_redis_evicted_keys{role="${redis.role}"} ${redis.evictedKeys ?? 0}`,
      );
      if (redis.hitRatio !== null) {
        lines.push(
          `flash_sale_redis_hit_ratio{role="${redis.role}"} ${redis.hitRatio}`,
        );
      }
    }

    lines.push(
      '# HELP flash_sale_event_loop_p99_ms event loop delay p99 รายวินาที ของแต่ละ instance',
      '# TYPE flash_sale_event_loop_p99_ms gauge',
    );
    for (const instance of instances) {
      lines.push(
        `flash_sale_event_loop_p99_ms{instance="${instance.instanceId}"} ${instance.eventLoopP99Ms}`,
        `flash_sale_process_rss_mb{instance="${instance.instanceId}"} ${instance.rssMb}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  /** ล้างตัวนับก่อนยิง k6 รอบใหม่ — ไม่แตะข้อมูลธุรกิจ (order/stock ไม่เกี่ยว) */
  @Post('metrics/reset')
  @HttpCode(200)
  async reset(): Promise<{ status: 'ok' }> {
    await this.metrics.reset();
    return { status: 'ok' };
  }
}
