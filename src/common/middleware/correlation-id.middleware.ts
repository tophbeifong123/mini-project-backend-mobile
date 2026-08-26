import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../logger/logger.module';

/** request ที่ผ่าน middleware นี้แล้วจะมี correlationId ติดมาด้วยเสมอ */
export interface RequestWithCorrelationId extends Request {
  correlationId?: string;
  // ⚠️ ห้ามประกาศ `id` ซ้ำที่นี่ — pino-http augment `express.Request` ไว้แล้วเป็น `ReqId`
  //    (string | number | object) การประกาศเป็น `string | undefined` จะชนกันเป็น TS2430
}

/** pino-http `req.id` เป็น ReqId (string | number | object) — เอาเฉพาะตอนที่เป็น string ที่ใช้ได้จริง */
function reqIdAsString(req: RequestWithCorrelationId): string | undefined {
  const id: unknown = req.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * อ่าน `X-Correlation-ID` (nginx เป็นคนใส่มา) — ถ้าไม่มีก็สร้างใหม่
 * แล้วเก็บไว้บน request + echo กลับใน response header
 *
 * idempotent: ถ้า pino-http (genReqId) สร้างไปแล้วจะใช้ค่าเดิม ไม่สร้างซ้ำ
 * ค่านี้จะถูกส่งต่อเข้า job payload เพื่อ trace ข้ามไปถึง worker (CLAUDE.md §5.5)
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: RequestWithCorrelationId, res: Response, next: NextFunction): void {
    const fromHeader = req.headers[CORRELATION_ID_HEADER];
    const incoming = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;

    const correlationId =
      (incoming && incoming.trim().length > 0 ? incoming.trim() : undefined) ??
      reqIdAsString(req) ??
      randomUUID();

    req.correlationId = correlationId;
    req.headers[CORRELATION_ID_HEADER] = correlationId;

    if (!res.getHeader('X-Correlation-ID')) {
      res.setHeader('X-Correlation-ID', correlationId);
    }

    next();
  }
}

/** helper รวมศูนย์ — ใช้ได้ทั้งใน interceptor, filter และ controller */
export function getCorrelationId(req: RequestWithCorrelationId): string {
  const fromHeader = req.headers?.[CORRELATION_ID_HEADER];
  const incoming = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  return req.correlationId ?? reqIdAsString(req) ?? incoming ?? 'unknown';
}
