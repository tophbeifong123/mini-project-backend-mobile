import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';

import { IntegrityService } from './integrity.service';

interface RawProductRow {
  id: string;
  name: string;
  available_stock: number;
  remaining_stock: number;
  orders: string;
  buyers: string;
}

/**
 * ตัวตัดสิน "ระบบยังถูกต้องอยู่ไหม" ของหน้า /admin/insights
 * ถ้า logic ตรงนี้ผิด รายงานจะบอกว่าทุกอย่างปกติทั้งที่ oversell ไปแล้ว — ต้องมีเทสต์คุม
 */
describe('IntegrityService', () => {
  const row = (overrides: Partial<RawProductRow> = {}): RawProductRow => ({
    id: 'p-1001',
    name: 'Limited Edition Sneaker',
    available_stock: 50,
    remaining_stock: 0,
    orders: '50',
    buyers: '50',
    ...overrides,
  });

  function build(options: {
    rows: RawProductRow[];
    redisStock: (string | null)[];
    queued?: number;
  }) {
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        sql.includes('FROM products')
          ? Promise.resolve(options.rows)
          : Promise.resolve([{ lag: '0.012' }]),
      ),
    };

    const dataSource = {
      createQueryRunner: jest.fn(() => runner),
      driver: {},
    } as unknown as DataSource;

    const data = {
      mget: jest.fn().mockResolvedValue(options.redisStock),
      info: jest.fn().mockResolvedValue('used_memory:1048576\nevicted_keys:0'),
    } as unknown as Redis;

    const cache = {
      info: jest
        .fn()
        .mockResolvedValue('keyspace_hits:90\nkeyspace_misses:10\n'),
    } as unknown as Redis;

    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: options.queued ?? 0,
        active: 0,
        completed: 50,
        failed: 0,
        delayed: 0,
        prioritized: 0,
      }),
    } as unknown as Queue;

    return new IntegrityService(dataSource, data, cache, queue);
  }

  it('คืน ok เมื่อขายครบพอดีและ Redis ตรงกับ DB', async () => {
    const report = await build({ rows: [row()], redisStock: ['0'] }).check();

    expect(report.verdict).toBe('ok');
    expect(report.products[0].drift).toBe(0);
    expect(report.totals.orders).toBe(50);
  });

  it('จับ oversell ได้เมื่อ order มากกว่าของที่มี', async () => {
    const report = await build({
      rows: [row({ orders: '51', buyers: '51', remaining_stock: -1 })],
      redisStock: ['0'],
    }).check();

    expect(report.verdict).toBe('critical');
    expect(report.products[0].notes.join(' ')).toContain('OVERSELL');
  });

  it('จับคนที่ได้เกิน 1 ชิ้นได้ (order ไม่เท่ากับจำนวนผู้ซื้อ)', async () => {
    const report = await build({
      rows: [row({ orders: '50', buyers: '49' })],
      redisStock: ['0'],
    }).check();

    expect(report.verdict).toBe('critical');
    expect(report.products[0].notes.join(' ')).toContain('ซื้อซ้ำ');
  });

  it('ถือว่าวิกฤตเมื่อ Redis สูงกว่า DB (เสี่ยงปล่อยคนเกินโควตา)', async () => {
    const report = await build({
      rows: [row({ orders: '49', buyers: '49', remaining_stock: 1 })],
      redisStock: ['3'],
    }).check();

    expect(report.verdict).toBe('critical');
    expect(report.products[0].drift).toBe(2);
  });

  it('drift ติดลบระหว่างมี job ค้างในคิว = ยังปกติ', async () => {
    const report = await build({
      rows: [row({ orders: '45', buyers: '45', remaining_stock: 5 })],
      redisStock: ['2'],
      queued: 3,
    }).check();

    expect(report.verdict).toBe('ok');
    expect(report.queueDrained).toBe(false);
    expect(report.products[0].notes.join(' ')).toContain('job ค้างในคิว');
  });

  it('drift ติดลบทั้งที่คิวว่าง = สต็อกรั่ว ต้องเตือน', async () => {
    const report = await build({
      rows: [row({ orders: '45', buyers: '45', remaining_stock: 5 })],
      redisStock: ['2'],
      queued: 0,
    }).check();

    expect(report.verdict).toBe('warn');
    expect(report.products[0].notes.join(' ')).toContain('สต็อกรั่ว');
  });

  it('เตือนเมื่อยังไม่ได้ seed stock counter ลง Redis', async () => {
    const report = await build({
      rows: [row({ orders: '0', buyers: '0', remaining_stock: 50 })],
      redisStock: [null],
    }).check();

    expect(report.verdict).toBe('warn');
    expect(report.products[0].redisRemaining).toBeNull();
  });

  it('อ่านสถิติแคชและ replication lag มาแสดงได้', async () => {
    const report = await build({ rows: [row()], redisStock: ['0'] }).check();

    const cache = report.redis.find((entry) => entry.role === 'cache');
    expect(cache?.hitRatio).toBe(90);
    expect(report.replicationLagSeconds).toBe(0.012);
  });
});
