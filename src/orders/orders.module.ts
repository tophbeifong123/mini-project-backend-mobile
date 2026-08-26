import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { OrdersController } from './orders.controller';
import { OrdersProcessor } from './orders.processor';
import { ORDER_QUEUE_NAME, OrdersService } from './orders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product]),
    BullModule.registerQueue({ name: ORDER_QUEUE_NAME }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersProcessor],
  exports: [OrdersService],
})
export class OrdersModule {}
