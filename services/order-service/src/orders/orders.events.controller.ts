import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { OrdersService } from './orders.service';
import {
  TOPICS,
  InventoryReservedEvent,
  InventoryRejectedEvent,
} from '../events/contracts';

@Controller()
export class OrdersEventsController {
  private readonly logger = new Logger(OrdersEventsController.name);

  constructor(private readonly orders: OrdersService) {}

  @EventPattern(TOPICS.INVENTORY_RESERVED)
  async onInventoryReserved(@Payload() event: InventoryReservedEvent) {
    this.logger.log(`<- ${TOPICS.INVENTORY_RESERVED} ${event.orderId}`);
    await this.orders.confirm(event);
  }

  @EventPattern(TOPICS.INVENTORY_REJECTED)
  async onInventoryRejected(@Payload() event: InventoryRejectedEvent) {
    this.logger.log(`<- ${TOPICS.INVENTORY_REJECTED} ${event.orderId}`);
    await this.orders.cancel(event);
  }
}
