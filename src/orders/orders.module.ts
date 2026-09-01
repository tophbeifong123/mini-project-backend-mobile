import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { OrdersController } from './orders.controller';
import { OrdersProcessor } from './orders.processor';
import { ORDER_QUEUE_NAME, OrdersService } from './orders.service';

/**
 * Default เป็น true เพื่อให้ local dev / tests / deployment รุ่นเก่ายังทำงานครบ
 * ส่วน production API containers ระบุ false และให้ dedicated worker เปิด true
 */
export function isOrderWorkerEnabled(
  value = process.env.ORDER_WORKER_ENABLED,
): boolean {
  return value !== 'false';
}

const orderWorkerProviders = isOrderWorkerEnabled() ? [OrdersProcessor] : [];

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product]),
    BullModule.registerQueue({ name: ORDER_QUEUE_NAME }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ...orderWorkerProviders],
  exports: [OrdersService],
})
export class OrdersModule {}
