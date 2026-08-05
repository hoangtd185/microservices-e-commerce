import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity';
import { IdempotencyKey } from './idempotency-key.entity';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersEventsController } from './orders.events.controller';
import { RemoteService } from './remote.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, IdempotencyKey]), HttpModule],
  controllers: [OrdersController, OrdersEventsController],
  providers: [OrdersService, RemoteService],
})
export class OrdersModule {}
