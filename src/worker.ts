import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';

/**
 * Dedicated BullMQ worker process — ไม่มี HTTP listener
 *
 * แยก worker event loop ออกจาก API เพื่อให้ transaction/side effect หลัง commit
 * ไม่เพิ่ม tail latency ของ GET/POST แต่ยัง reuse DI, Redis, TypeORM และ processor
 * ชุดเดียวกับแอปหลักทั้งหมด
 */
async function bootstrapWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

void bootstrapWorker();
