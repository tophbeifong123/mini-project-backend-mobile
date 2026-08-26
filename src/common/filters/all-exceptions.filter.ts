import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import {
  getCorrelationId,
  RequestWithCorrelationId,
} from '../middleware/correlation-id.middleware';

/**
 * Global exception filter
 *
 * ⚠️ `HttpException` ต้องผ่านไปแบบ **ไม่แก้ไข** ทั้ง status และ body
 *    เพราะ API contract (CLAUDE.md §3) บังคับ 202 / 401 / 409 / 429 / 503 แบบเป๊ะๆ
 *    ถ้าไป wrap body ใหม่ k6 ของกลุ่มอื่นจะ assert ไม่ผ่าน
 *
 * error ที่ไม่รู้จักเท่านั้นที่ถูกแปลงเป็น 500 พร้อม log correlationId ไว้ไล่ต่อ
 */
/** `HttpException.getStatus()` คืน number ธรรมดา จึงต้องเทียบกับ number ไม่ใช่ตัว enum */
const SERVER_ERROR_STATUS_FLOOR = 500;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<RequestWithCorrelationId>();
    const correlationId = getCorrelationId(req);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      if (status >= SERVER_ERROR_STATUS_FLOOR) {
        this.logger.error(
          {
            correlationId,
            url: req.originalUrl ?? req.url,
            status,
            err: exception,
          },
          'http exception (server error)',
        );
      }

      // ส่งต่อ status + body เดิมทั้งดุ้น
      res.status(status).json(exception.getResponse());
      return;
    }

    this.logger.error(
      {
        correlationId,
        method: req.method,
        url: req.originalUrl ?? req.url,
        err:
          exception instanceof Error
            ? exception
            : { message: String(exception) },
      },
      'unhandled exception',
    );

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      correlationId,
    });
  }
}
