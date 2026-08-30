import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { BullBoardModule } from './bull_board/bull-board.module';
import { BullMqModule } from './bullmq_config/bullmq.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database_config/database.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './logger/logger.module';
import { ObservabilityModule } from './observability/observability.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate: validateEnv,
    }),

    // logging ต้องมาก่อน module อื่นเพื่อให้ middleware ของ pino ถูก register เป็นตัวแรก
    LoggerModule,

    RedisModule,
    DatabaseModule,
    BullMqModule,
    BullBoardModule,
    ObservabilityModule,

    AuthModule,
    ProductsModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [AllExceptionsFilter, LoggingInterceptor],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
