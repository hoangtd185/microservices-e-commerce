import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { Reservation } from './reservation.entity';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductsEventsController } from './products.events.controller';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [TypeOrmModule.forFeature([Product, Reservation]), KafkaModule],
  controllers: [ProductsController, ProductsEventsController],
  providers: [ProductsService],
})
export class ProductsModule {}
