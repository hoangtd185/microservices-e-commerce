import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ProductsService } from './products.service';
import { TOPICS, OrderCreatedEvent, OrderCancelledEvent } from '../events/contracts';

@Controller()
export class ProductsEventsController {
  private readonly logger = new Logger(ProductsEventsController.name);

  constructor(private readonly products: ProductsService) {}

  @EventPattern(TOPICS.ORDER_CREATED)
  async onOrderCreated(@Payload() event: OrderCreatedEvent) {
    this.logger.log(`<- ${TOPICS.ORDER_CREATED} ${event.orderId}`);
    await this.products.handleOrderCreated(event);
  }

  @EventPattern(TOPICS.ORDER_CANCELLED)
  async onOrderCancelled(@Payload() event: OrderCancelledEvent) {
    this.logger.log(`<- ${TOPICS.ORDER_CANCELLED} ${event.orderId}`);
    await this.products.handleOrderCancelled(event);
  }
}
