import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersEventsController } from './orders.events.controller';
import { RemoteService } from './remote.service';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [TypeOrmModule.forFeature([Order]), KafkaModule, HttpModule],
  controllers: [OrdersController, OrdersEventsController],
  providers: [OrdersService, RemoteService],
})
export class OrdersModule {}
