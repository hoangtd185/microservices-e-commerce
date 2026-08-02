import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Shared by the running service and by the standalone seeder, so the two can
 * never drift apart.
 */
export const databaseConfig = (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'inventory_db',
  autoLoadEntities: true,
  // Demo only. Real projects generate migrations instead.
  synchronize: true,
  retryAttempts: 20,
  retryDelay: 3000,
});
