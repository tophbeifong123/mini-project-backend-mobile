import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

/** header ที่ใช้ส่ง correlation id: client → nginx → app → job payload */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** instance ที่ประมวลผล request นี้ (app-1 / app-2 / app-3) */
export const INSTANCE_ID = process.env.INSTANCE_ID ?? 'unknown';

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** podman/docker ทิ้ง marker file ไว้ — ในคอนเทนเนอร์ต้องเป็น JSON บรรทัดเดียวเสมอ */
function isInsideContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

const usePretty =
  (process.env.NODE_ENV ?? 'development') === 'development' &&
  !isInsideContainer();

/**
 * Structured JSON logging (CLAUDE.md §5.5)
 * - single-line JSON, มี `instanceId` + `correlationId` ทุกบรรทัด
 * - redact password / token / secret / authorization
 * - pino-pretty เฉพาะตอน dev บนเครื่อง (ไม่ใช่ในคอนเทนเนอร์)
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',

        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

        formatters: {
          level: (label: string) => ({ level: label }),
        },

        base: {
          instanceId: INSTANCE_ID,
          pid: process.pid,
        },

        // correlation id: ใช้ค่าที่ nginx ส่งมา ถ้าไม่มีก็สร้างใหม่ 1 ครั้งต่อ request
        // แล้วยัดกลับเข้า req.headers เพื่อให้ CorrelationIdMiddleware เห็นค่าเดียวกัน
        genReqId: (req: IncomingMessage, res: ServerResponse): string => {
          const incoming =
            firstHeader(req.headers[CORRELATION_ID_HEADER]) ??
            firstHeader(req.headers['x-request-id']);

          const correlationId = incoming ?? randomUUID();
          req.headers[CORRELATION_ID_HEADER] = correlationId;
          res.setHeader('X-Correlation-ID', correlationId);

          return correlationId;
        },

        customProps: (req: IncomingMessage) => ({
          correlationId: (req as IncomingMessage & { id?: string }).id,
        }),

        serializers: {
          req(req: {
            method: string;
            url: string;
            headers: Record<string, string | string[] | undefined>;
          }) {
            return {
              method: req.method,
              url: req.url,
              headers: {
                host: req.headers.host,
                'user-agent': req.headers['user-agent'],
                [CORRELATION_ID_HEADER]: req.headers[CORRELATION_ID_HEADER],
                authorization: req.headers.authorization,
              },
            };
          },
          res(res: { statusCode: number }) {
            return { statusCode: res.statusCode };
          },
        },

        redact: {
          censor: '[REDACTED]',
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.token',
            '*.secret',
            '*.accessToken',
            'password',
            'token',
            'secret',
            'accessToken',
            'JWT_SECRET',
          ],
        },

        // autoLogging ปิดไว้เพื่อไม่ให้ซ้ำซ้อนกับ LoggingInterceptor ที่ให้ข้อมูล durationMs + correlationId ละเอียดกว่า
        autoLogging: false,

        transport: usePretty
          ? {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                colorize: true,
                translateTime: 'SYS:standard',
              },
            }
          : undefined,
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
