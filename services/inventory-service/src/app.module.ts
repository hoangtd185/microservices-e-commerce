import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsModule } from './products/products.module';
import { OutboxModule } from './outbox/outbox.module';
import { HealthController } from './health.controller';
import { databaseConfig } from './database.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(databaseConfig()),
    OutboxModule,
    ProductsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
