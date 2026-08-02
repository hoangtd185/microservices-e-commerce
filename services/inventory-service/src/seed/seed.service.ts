import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/product.entity';
import { buildCatalog } from './catalog';

export interface SeedOptions {
  /**
   * Also overwrite stock on SKUs that already exist. Off by default so a
   * restart never silently refills inventory underneath you - turn it on to
   * reset the catalog between load tests.
   */
  resetStock?: boolean;
}

export interface SeedResult {
  total: number;
  created: number;
  updated: number;
}

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
  ) {}

  /**
   * Idempotent: safe to run any number of times. One INSERT ... ON CONFLICT
   * statement rather than a read-then-write loop, for the same reason the
   * stock decrement is a single statement.
   */
  async run(options: SeedOptions = {}): Promise<SeedResult> {
    const catalog = buildCatalog();
    const before = await this.products.count();

    const overwrite = options.resetStock
      ? ['name', 'price', 'stock']
      : ['name', 'price'];

    await this.products
      .createQueryBuilder()
      .insert()
      .into(Product)
      .values(catalog)
      .orUpdate(overwrite, ['sku'])
      .execute();

    const after = await this.products.count();
    const created = after - before;

    const result = {
      total: catalog.length,
      created,
      updated: catalog.length - created,
    };

    this.logger.log(
      `seeded ${result.total} products (${result.created} new, ${result.updated} updated${
        options.resetStock ? ', stock reset' : ', stock preserved'
      })`,
    );

    return result;
  }
}
