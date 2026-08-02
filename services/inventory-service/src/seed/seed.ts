import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SeedModule } from './seed.module';
import { SeedService } from './seed.service';

/**
 * Standalone seeder.
 *
 *   npm run seed                  insert missing SKUs, keep existing stock
 *   npm run seed -- --reset-stock also reset stock/price on existing SKUs
 *
 * In Docker:
 *   docker compose exec inventory-service node dist/seed/seed.js --reset-stock
 */
async function run() {
  const logger = new Logger('Seed');
  const resetStock = process.argv.includes('--reset-stock');

  const app = await NestFactory.createApplicationContext(SeedModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const result = await app.get(SeedService).run({ resetStock });
    logger.log(
      `done: ${result.created} created, ${result.updated} updated, ${result.total} total`,
    );
  } catch (err: any) {
    logger.error(`seed failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

run();
