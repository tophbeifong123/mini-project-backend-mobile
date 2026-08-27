import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';

import { ORDERS_QUEUE } from '../bullmq_config/bullmq.module';
import { BullBoardService } from './bull-board.service';

@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: ORDERS_QUEUE })],
  providers: [BullBoardService],
  exports: [BullBoardService],
})
export class BullBoardModule {}
