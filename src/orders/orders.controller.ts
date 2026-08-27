import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderResponse, OrdersService } from './orders.service';

/**
 * `request.user` = ผลลัพธ์ของ `JwtStrategy.validate()` (= `{ userId }`)
 * รองรับ `sub` ไว้ด้วยเผื่อ strategy ส่ง claim ดิบกลับมา — ทั้งสองทางมาจาก JWT เท่านั้น
 */
interface AuthenticatedRequest extends Request {
  user?: Partial<AuthenticatedUser> & { sub?: string };
}

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * write-heavy path (CLAUDE.md §3)
   * ต้องตอบ **202** เท่านั้น (ห้าม 200/201) และห้ามรอ DB
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createOrder(
    @Req() request: AuthenticatedRequest,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true, // ปฏิเสธ field แปลกปลอม เช่น quantity / userId
      }),
    )
    dto: CreateOrderDto,
  ): Promise<CreateOrderResponse> {
    // ⚠️ invariant §4 ข้อ 2 — userId มาจาก JWT claim เท่านั้น ห้ามอ่านจาก body
    const userId = request.user?.sub ?? request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Missing subject claim in token');
    }

    const correlationHeader = request.headers['x-correlation-id'];
    const correlationId = Array.isArray(correlationHeader)
      ? correlationHeader[0]
      : correlationHeader;

    return this.ordersService.createOrder(userId, dto.productId, correlationId);
  }
}
