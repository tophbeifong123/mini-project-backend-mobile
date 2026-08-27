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

export const BULL_BOARD_BASE_PATH = '/admin/queues';

/**
 * Bull-Board dashboard สำหรับดู Waiting / Active / Completed / Failed (§9.1)
 *
 * ⚠️ **ต้องมี Basic Auth คลุมเสมอ** (CLAUDE.md §6 / slide-errata #10)
 *    เพราะหน้านี้เปิดดู payload ของ job และกด retry/remove ได้
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

    createBullBoard({
      queues: [new BullMQAdapter(this.ordersQueue)],
      serverAdapter: this.serverAdapter,
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
