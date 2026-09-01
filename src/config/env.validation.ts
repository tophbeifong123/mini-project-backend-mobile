import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * สเปกของ env ทั้งระบบ (BUILD_SPEC "ENV VARS").
 * ทุกค่าถูกอ่านผ่าน ConfigService เท่านั้น — ห้าม hardcode (CLAUDE.md §6)
 *
 * ค่าที่ "ต้องมี" จริงๆ มีตัวเดียวคือ JWT_SECRET เพราะเป็น secret ที่เดาแทนไม่ได้
 * ตัวอื่นมี default ตรงกับ .env.example เพื่อให้ fail fast เฉพาะเรื่องที่สำคัญ
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  INSTANCE_ID: string = 'app-1';

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  // ---- JWT (§4) ----
  @IsString()
  @MinLength(8)
  JWT_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_EXPIRES_IN: string = '15m';

  // ---- PostgreSQL primary ----
  @IsString()
  @IsNotEmpty()
  DB_HOST: string = 'postgres-primary';

  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT: number = 5432;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME: string = 'flashsale';

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD: string = 'flashsale';

  @IsString()
  @IsNotEmpty()
  DB_DATABASE: string = 'flashsale';

  // ---- PostgreSQL replica (read-only) ----
  @IsString()
  @IsNotEmpty()
  DB_REPLICA_HOST: string = 'postgres-replica';

  @IsInt()
  @Min(1)
  @Max(65535)
  DB_REPLICA_PORT: number = 5432;

  /** §8: instances × (1 master + 1 replica) × poolSize ≤ 80% ของ max_connections */
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_SIZE: number = 10;

  // ---- Redis: cache (allkeys-lru) ----
  @IsString()
  @IsNotEmpty()
  REDIS_CACHE_HOST: string = 'redis-cache';

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_CACHE_PORT: number = 6379;

  // ---- Redis: data (noeviction + AOF) — stock counter / lock / BullMQ ----
  @IsString()
  @IsNotEmpty()
  REDIS_DATA_HOST: string = 'redis-data';

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_DATA_PORT: number = 6379;

  // ---- Cache policy (§5.3 TTL + jitter) ----
  @IsInt()
  @Min(1)
  CATALOG_CACHE_TTL_BASE: number = 30;

  @IsInt()
  @Min(0)
  CATALOG_CACHE_TTL_JITTER: number = 30;

  // ---- Write path ----
  @IsInt()
  @Min(1000)
  ORDER_LOCK_TTL_MS: number = 30000;

  /** §8: ห้ามเกิน DB_POOL_SIZE ของ master */
  @IsInt()
  @Min(1)
  WORKER_CONCURRENCY: number = 5;

  /**
   * API process ปิด consumer เพื่อไม่ให้ DB transaction/worker callback แย่ง
   * event loop กับ HTTP; dedicated worker process เปิดไว้เพียงตัวเดียว
   */
  @IsIn(['true', 'false'])
  ORDER_WORKER_ENABLED: string = 'true';

  // ---- Bull-Board (ต้องมี Basic Auth คลุม — CLAUDE.md §6) ----
  @IsString()
  @IsNotEmpty()
  BULL_BOARD_USER: string = 'admin';

  @IsString()
  @IsNotEmpty()
  BULL_BOARD_PASSWORD: string = 'admin';
}

/**
 * ใช้กับ ConfigModule.forRoot({ validate })
 * คืน config เดิมทั้งก้อน + ค่าที่ผ่านการ cast/ใส่ default แล้ว
 * (ห้ามคืนเฉพาะ instance เพราะจะทำให้ env ตัวอื่นของ process หายไปจาก ConfigService)
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  return { ...config, ...(validated as unknown as Record<string, unknown>) };
}
