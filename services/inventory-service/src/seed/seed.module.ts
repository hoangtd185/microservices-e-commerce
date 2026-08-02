import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/product.entity';
import { SeedService } from './seed.service';
import { databaseConfig } from '../database.config';

/**
 * Minimal module for the standalone seeder: database only, no Kafka, no HTTP.
 * The CLI should not need a broker to be up just to insert rows.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(databaseConfig()),
    TypeOrmModule.forFeature([Product]),
  ],
  providers: [SeedService],
})
export class SeedModule {}
