import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import {
  BULL_BOARD_BASE_PATH,
  BullBoardService,
} from './bull_board/bull-board.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  // bufferLogs: เก็บ log ช่วง bootstrap ไว้ แล้วปล่อยผ่าน pino เมื่อ logger พร้อม
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // log ของ NestJS เองก็ต้องออกมาเป็น JSON บรรทัดเดียวเหมือนกัน
  app.useLogger(app.get(Logger));

  // ⚠️ ไม่มี global prefix โดยเจตนา — controller ประกาศ path เต็มเอง
  //    ('api/v1/...' สำหรับ contract, 'health/...' สำหรับ probe)
  //    ถ้าใส่ prefix ที่นี่ /health/* จะกลายเป็น /api/v1/health/* แล้ว healthcheck พัง

  app.useGlobalPipes(
    new ValidationPipe({
      // `whitelist` ตัด field แปลกปลอมทิ้ง (เช่น body.userId จะไม่มีทางถูกใช้ — invariant §4 ข้อ 2)
      // ⚠️ ห้ามเปิด `forbidNonWhitelisted` — โจทย์เขียนว่า "ไม่ต้องส่ง quantity" ไม่ใช่ "ห้ามส่ง"
      //    k6 ของกลุ่มอื่นที่ส่ง {productId, quantity:1} มาจะโดน 400 ทุก request = ยิงข้ามกลุ่มไม่ได้
      whitelist: true,
      transform: true,
      // query string มาเป็น string เสมอ — ต้องแปลงให้ตรง type ของ DTO
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(
    app.get(LoggingInterceptor),
    new LoggerErrorInterceptor(),
  );
  app.useGlobalFilters(app.get(AllExceptionsFilter));

  // Bull-Board — ต้องมี Basic Auth คลุมเสมอ (CLAUDE.md §6)
  const bullBoard = app.get(BullBoardService);
  app.use(
    BULL_BOARD_BASE_PATH,
    bullBoard.getAuthMiddleware(),
    bullBoard.getRouter(),
  );

  // ปิด worker/connection ให้เรียบร้อยตอน SIGTERM ไม่งั้น deploy ทีไรเกิด stalled job
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = Number(config.get<number>('PORT', 3000));

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
