import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SeedService } from './seed.service';

/**
 * Convenience only: `docker compose up` should hand you a populated catalog
 * without a second command. Never resets stock - that has to be deliberate.
 */
@Injectable()
export class SeedOnBootService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedOnBootService.name);

  constructor(private readonly seeder: SeedService) {}

  async onApplicationBootstrap() {
    if (process.env.SEED_PRODUCTS !== 'true') return;
    try {
      await this.seeder.run();
    } catch (err: any) {
      // Never let seeding take the service down.
      this.logger.error(`seeding failed: ${err.message}`);
    }
  }
}
