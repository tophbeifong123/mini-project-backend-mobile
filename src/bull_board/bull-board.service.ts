import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { RequestHandler } from 'express';
import basicAuth from 'express-basic-auth';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

import { ORDERS_QUEUE } from '../bullmq_config/bullmq.module';
import type { OrderJobData } from '../orders/orders.service';
import { BOARD_FAVICON, BOARD_LOGO, BOARD_THEME } from './bull-board.theme';

export const BULL_BOARD_BASE_PATH = '/admin/queues';

/**
 * Bull-Board dashboard สำหรับดู Waiting / Active / Completed / Failed (§9.1)
 *
 * ⚠️ **ต้องมี Basic Auth คลุมเสมอ** (CLAUDE.md §6 / slide-errata #10)
 *    เพราะหน้านี้เปิดดู payload ของ job และกด retry/remove ได้
 *
 * หน้าตา (ธีม/โลโก้/ป้าย environment) แยกไปอยู่ `bull-board.theme.ts` — เป็นการตกแต่งล้วนๆ
 */
@Injectable()
export class BullBoardService {
  private readonly serverAdapter = new ExpressAdapter();
  private readonly authMiddleware: RequestHandler;

  constructor(
    @InjectQueue(ORDERS_QUEUE) private readonly ordersQueue: Queue,
    config: ConfigService,
  ) {
    this.serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);

    const instanceId = config.get<string>('INSTANCE_ID', 'app');
    const nodeEnv = config.get<string>('NODE_ENV', 'development');

    const adapter = new BullMQAdapter(this.ordersQueue, {
      displayName: 'Orders — Flash Sale',
      description:
        'จำกัด 1 ชิ้น/คน · jobId = order:{userId}:{productId} · attempts 3 (exponential 200ms)',
    });

    // job ทุกตัวชื่อ `process-order` เหมือนกันหมด — เปลี่ยนให้โชว์ว่าใครซื้ออะไรแทน
    adapter.setFormatter('name', (data: unknown) => {
      const { userId, productId } = (data ?? {}) as Partial<OrderJobData>;
      return typeof userId === 'string' && typeof productId === 'string'
        ? `${productId} ← ${userId}`
        : 'process-order';
    });

    // requestToken เป็นหลักฐานการถือครอง lock (compensate*.lua) — ห้ามโชว์เต็มบนหน้าเว็บ
    adapter.setFormatter('data', (data: unknown) => {
      if (typeof data !== 'object' || data === null) return data;
      const { requestToken, ...rest } = data as Record<string, unknown>;
      return typeof requestToken === 'string'
        ? { ...rest, requestToken: `${requestToken.slice(0, 6)}…[redacted]` }
        : data;
    });

    createBullBoard({
      queues: [adapter],
      serverAdapter: this.serverAdapter,
      options: {
        uiConfig: {
          boardTitle: 'Flash Sale · Queues',
          boardLogo: { path: BOARD_LOGO, width: 28, height: 28 },
          favIcon: BOARD_FAVICON,
          theme: BOARD_THEME,
          hideDocsLink: true,
          showMetrics: true,
          jobDetails: { defaultTab: 'Data' },
          pollingInterval: { showSetting: true },
          environment: {
            label: `${nodeEnv} · ${instanceId}`,
            color: '#e11d48',
            textColor: '#ffffff',
          },
          miscLinks: [
            { text: 'Insights', url: '/admin/insights' },
            { text: 'Readiness', url: '/health/ready' },
            { text: 'Catalog API', url: '/api/v1/products?page=1&limit=10' },
          ],
        },
      },
    });

    const user = config.getOrThrow<string>('BULL_BOARD_USER');
    const password = config.getOrThrow<string>('BULL_BOARD_PASSWORD');

    this.authMiddleware = basicAuth({
      users: { [user]: password },
      challenge: true,
      realm: 'flash-sale-queues',
    });
  }

  getAuthMiddleware(): RequestHandler {
    return this.authMiddleware;
  }

  /** router ของ Bull-Board ใช้เป็น express middleware ได้ตรงๆ */
  getRouter(): RequestHandler {
    // `getRouter()` ของ ExpressAdapter ประกาศ return เป็น `any` — cast ตรงนี้ทีเดียว
    return this.serverAdapter.getRouter() as RequestHandler;
  }
}
