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

/** log method / url / status / duration / correlationId ของทุก request */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
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

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.info(
            {
              correlationId,
              method,
              url,
              statusCode: res.statusCode,
              durationMs: Date.now() - startedAt,
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
