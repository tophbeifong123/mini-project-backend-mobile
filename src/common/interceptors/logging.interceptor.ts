import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Observable, tap } from 'rxjs';

import {
  getCorrelationId,
  RequestWithCorrelationId,
} from '../middleware/correlation-id.middleware';

/**
 * อัตราการสุ่ม log ของ read path ที่สำเร็จ — เขียน 1 บรรทัดต่อ N คำขอ
 *
 * ทำไมต้องสุ่ม: `GET /api/v1/products` ถูกยิงหลักพัน rps ส่วน `POST /api/v1/orders`
 * ยิงได้เต็มที่ 50 ใบที่สำเร็จ (สต็อกมีเท่านั้น) — log ต่อ request จึงเป็นภาระที่
 * **read path จ่ายฝ่ายเดียว** โดยไม่มีใครอ่าน CPU profile วัดได้ว่า pino stack กิน ~6%
 * ของ CPU ทั้งหมด และการปิด log ต่อ request เพิ่ม throughput ได้ +11%
 *
 * ⚠️ การสุ่มนี้ใช้กับ **read path ที่สำเร็จเท่านั้น** — สิ่งที่ยังคง log ครบ 100%:
 *   · ทุก request ที่ error (บล็อก `error:` ด้านล่าง ไม่ผ่านตัวสุ่มเลย)
 *   · ทุก method ที่ไม่ใช่ GET → write path ยังตามรอยได้ทุกใบตาม CLAUDE.md §5.5
 *   · nginx access log ยังบันทึกครบทุกใบอยู่แล้ว (คนละชั้นกัน)
 */
const READ_LOG_SAMPLE_RATE = 100;

/**
 * log method / url / status / duration / correlationId
 * (read path ที่สำเร็จถูกสุ่ม 1/N — ดู READ_LOG_SAMPLE_RATE)
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  /** ตัวนับสำหรับสุ่ม log — เป็น counter ของ process นี้ ไม่ใช่ state ที่ต้องแชร์ */
  private readCount = 0;

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(LoggingInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithCorrelationId>();
    const res = http.getResponse<Response>();

    // หน้า admin (Bull-Board + insights ที่ poll ทุก 3 วิ) และ health probe ไม่ต้อง log
    const path = req.originalUrl ?? req.url ?? '';
    if (path.startsWith('/admin') || path.startsWith('/health/')) {
      return next.handle();
    }

    const startedAt = Date.now();
    const correlationId = getCorrelationId(req);
    const method = req.method;
    const url = req.originalUrl ?? req.url;

    // GET = read path เท่านั้นที่ถูกสุ่ม · write path log ครบทุกใบเสมอ
    const sampled =
      method !== 'GET' || this.readCount++ % READ_LOG_SAMPLE_RATE === 0;

    return next.handle().pipe(
      tap({
        next: () => {
          if (!sampled) {
            return;
          }
          this.logger.info(
            {
              correlationId,
              method,
              url,
              statusCode: res.statusCode,
              durationMs: Date.now() - startedAt,
              ...(method === 'GET'
                ? { sampleRate: READ_LOG_SAMPLE_RATE }
                : null),
            },
            'request completed',
          );
        },
        error: (error: unknown) => {
          const statusCode =
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            typeof error.status === 'number'
              ? (error as { status: number }).status
              : 500;

          this.logger.warn(
            {
              correlationId,
              method,
              url,
              statusCode,
              durationMs: Date.now() - startedAt,
            },
            'request failed',
          );
        },
      }),
    );
  }
}
