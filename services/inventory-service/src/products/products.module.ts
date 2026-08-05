import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { Reservation } from './reservation.entity';
import { ProductsService } from './products.service';
import { ProductsController, ReservationsController } from './products.controller';
import { ProductsEventsController } from './products.events.controller';
import { SeedService } from '../seed/seed.service';
import { SeedOnBootService } from '../seed/seed-on-boot.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, Reservation])],
  controllers: [ProductsController, ReservationsController, ProductsEventsController],
  providers: [ProductsService, SeedService, SeedOnBootService],
})
export class ProductsModule {}
