import { hostname } from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import { REDIS_DATA_CLIENT } from '../redis/redis.constants';
import { RedisKeys } from '../redis/redis.keys';
import type { MetricName } from './metrics.constants';

const FLUSH_INTERVAL_MS = 1_000;

export interface InstanceSnapshot {
  instanceId: string;
  pid: number;
  uptimeSeconds: number;
  rssMb: number;
  heapUsedMb: number;
  /** p99 ของ event loop delay ในช่วง 1 วินาทีที่ผ่านมา (ms) */
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  updatedAt: number;
}

/**
 * ตัวนับ observability ที่ **แชร์ข้ามทั้ง 6 instance**
 *
 * ทำไมต้อง buffer ใน RAM แล้วค่อย flush:
 *   ถ้า `HINCRBY` ทุกครั้งที่นับ ตอนยิง 1,500 rps จะเพิ่มภาระให้ redis-data อีก 1,500 ops/s
 *   บน connection เดียวกับที่ gatekeeper ใช้ = เครื่องมือวัดไปกวนสิ่งที่กำลังวัด
 *   buffer แล้ว flush 1 ครั้ง/วินาทีด้วย pipeline เหลือ ~1 roundtrip/วินาที/instance
 *
 * ⚠️ ตัวเลขใน buffer ไม่ใช่ state ที่ต้องแชร์ (แหล่งจริงคือ hash บน redis-data)
 *    มันคือ write-behind buffer อายุ ≤ 1 วินาที จึงไม่ขัดกฎ stateless (CLAUDE.md §5 ข้อ 1)
 *    ต้นทุนที่ยอมรับ: ถ้า container โดน SIGKILL ตัวนับ ≤ 1 วินาทีสุดท้ายหาย
 *    (SIGTERM ปกติไม่หาย เพราะ `onModuleDestroy` flush ปิดท้าย)
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private readonly buffer = new Map<string, number>();
  private readonly instanceId: string;
  private readonly eventLoop: IntervalHistogram;
  private timer?: NodeJS.Timeout;
  private consecutiveFlushErrors = 0;

  constructor(
    @Inject(REDIS_DATA_CLIENT) private readonly data: Redis,
    config: ConfigService,
  ) {
    // fallback เป็น hostname (ใน container = container id) เพื่อให้แต่ละ instance
    // มี field ของตัวเองเสมอ แม้ลืมตั้ง INSTANCE_ID ไม่งั้นทั้ง 6 ตัวจะทับ field เดียวกัน
    this.instanceId = config.get<string>('INSTANCE_ID', hostname());
    this.eventLoop = monitorEventLoopDelay({ resolution: 10 });
  }

  onModuleInit(): void {
    this.eventLoop.enable();
    // unref() — timer ตัวนี้ต้องไม่กันไม่ให้ process ปิดตัวลงตอน shutdown
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.eventLoop.disable();
    await this.flush();
  }

  /**
   * บวกตัวนับ — **synchronous ล้วน ไม่มี I/O** จึงเรียกจาก hot path ได้โดยไม่เพิ่ม latency
   * และไม่มีทาง throw ใส่ผู้เรียก (การวัดผลห้ามทำให้คำสั่งซื้อล้ม)
   */
  inc(name: MetricName, by = 1): void {
    this.buffer.set(name, (this.buffer.get(name) ?? 0) + by);
  }

  /** ตัวนับสะสมทั้งคลัสเตอร์ (รวมของที่ยังค้างใน buffer ของ instance นี้ด้วย) */
  async readCounters(): Promise<Record<string, number>> {
    const stored = await this.data.hgetall(RedisKeys.metricsCounters());
    const counters: Record<string, number> = {};
    for (const [name, raw] of Object.entries(stored)) {
      counters[name] = Number(raw) || 0;
    }
    for (const [name, pending] of this.buffer) {
      counters[name] = (counters[name] ?? 0) + pending;
    }
    return counters;
  }

  /** สถานะราย instance ล่าสุดของทั้ง 6 ตัว */
  async readInstances(): Promise<InstanceSnapshot[]> {
    const stored = await this.data.hgetall(RedisKeys.metricsInstances());
    const snapshots: InstanceSnapshot[] = [];
    for (const raw of Object.values(stored)) {
      try {
        snapshots.push(JSON.parse(raw) as InstanceSnapshot);
      } catch {
        // field ที่พังทิ้งไปเงียบๆ — หน้าแดชบอร์ดต้องไม่ล้มเพราะ JSON เสียใบเดียว
      }
    }
    return snapshots.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  /** ล้างตัวนับทั้งหมด (ใช้ก่อนยิง k6 รอบใหม่ให้ตัวเลขในรายงานสะอาด) */
  async reset(): Promise<void> {
    this.buffer.clear();
    await this.data.del(
      RedisKeys.metricsCounters(),
      RedisKeys.metricsInstances(),
    );
  }

  private buildSnapshot(): InstanceSnapshot {
    const memory = process.memoryUsage();
    const snapshot: InstanceSnapshot = {
      instanceId: this.instanceId,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
      // histogram คืนค่าเป็น "นาโนวินาที" — หารก่อนโชว์ ไม่งั้นตัวเลขเกินจริง 1e6 เท่า
      eventLoopP99Ms:
        Math.round((this.eventLoop.percentile(99) / 1e6) * 100) / 100,
      eventLoopMaxMs: Math.round((this.eventLoop.max / 1e6) * 100) / 100,
      updatedAt: Date.now(),
    };
    this.eventLoop.reset();
    return snapshot;
  }

  private async flush(): Promise<void> {
    const pending = [...this.buffer.entries()];
    this.buffer.clear();

    try {
      const pipeline = this.data.pipeline();
      for (const [name, value] of pending) {
        pipeline.hincrby(RedisKeys.metricsCounters(), name, value);
      }
      pipeline.hset(
        RedisKeys.metricsInstances(),
        this.instanceId,
        JSON.stringify(this.buildSnapshot()),
      );
      await pipeline.exec();
      this.consecutiveFlushErrors = 0;
    } catch (err) {
      // เอาของที่ flush ไม่สำเร็จกลับเข้า buffer — ห้ามทิ้ง ไม่งั้นตัวเลขในรายงานขาด
      for (const [name, value] of pending) {
        this.buffer.set(name, (this.buffer.get(name) ?? 0) + value);
      }
      this.consecutiveFlushErrors += 1;
      // Redis สะดุดตอนโหลดพีคจะ flush ไม่ผ่านรัวๆ — log ทุกครั้ง = log storm ซ้ำเติม
      if (this.consecutiveFlushErrors % 30 === 1) {
        this.logger.warn(
          `metrics flush failed x${this.consecutiveFlushErrors}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}
