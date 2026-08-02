import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { UsersService } from './users.service';
import { TOPICS, OrderConfirmedEvent } from '../events/contracts';

/**
 * Kafka side of user-service. @EventPattern = fire-and-forget consumer
 * (no reply is produced), which is what you want for events.
 */
@Controller()
export class UsersEventsController {
  private readonly logger = new Logger(UsersEventsController.name);

  constructor(private readonly users: UsersService) {}

  @EventPattern(TOPICS.ORDER_CONFIRMED)
  async onOrderConfirmed(@Payload() event: OrderConfirmedEvent) {
    this.logger.log(`<- ${TOPICS.ORDER_CONFIRMED} ${JSON.stringify(event)}`);
    await this.users.applyOrderConfirmed(event);
  }
}
