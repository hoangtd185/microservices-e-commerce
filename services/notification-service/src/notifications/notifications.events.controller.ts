import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { NotificationsService } from './notifications.service';
import {
  TOPICS,
  UserCreatedEvent,
  OrderCreatedEvent,
  OrderConfirmedEvent,
  OrderCancelledEvent,
  InventoryRejectedEvent,
} from '../events/contracts';

/**
 * The pure consumer. It subscribes to five topics and owns no write API -
 * a good illustration of why event-driven wiring scales: adding this service
 * required zero changes to the services that publish the events.
 */
@Controller()
export class NotificationsEventsController {
  private readonly logger = new Logger(NotificationsEventsController.name);

  constructor(private readonly notifications: NotificationsService) {}

  @EventPattern(TOPICS.USER_CREATED)
  async onUserCreated(@Payload() e: UserCreatedEvent) {
    await this.notifications.record(
      TOPICS.USER_CREATED,
      e.userId,
      `Welcome to Shopee-lite, ${e.name}! Your account (${e.email}) is ready.`,
      e as any,
    );
  }

  @EventPattern(TOPICS.ORDER_CREATED)
  async onOrderCreated(@Payload() e: OrderCreatedEvent) {
    await this.notifications.record(
      TOPICS.ORDER_CREATED,
      e.userId,
      `We received your order ${e.orderId.slice(0, 8)} (${e.quantity} item(s), $${e.totalPrice}). Checking stock...`,
      e as any,
    );
  }

  @EventPattern(TOPICS.ORDER_CONFIRMED)
  async onOrderConfirmed(@Payload() e: OrderConfirmedEvent) {
    await this.notifications.record(
      TOPICS.ORDER_CONFIRMED,
      e.userId,
      `Order ${e.orderId.slice(0, 8)} confirmed - $${e.totalPrice} charged. Packing now!`,
      e as any,
    );
  }

  @EventPattern(TOPICS.ORDER_CANCELLED)
  async onOrderCancelled(@Payload() e: OrderCancelledEvent) {
    await this.notifications.record(
      TOPICS.ORDER_CANCELLED,
      e.userId,
      `Sorry - order ${e.orderId.slice(0, 8)} was cancelled: ${e.reason}`,
      e as any,
      'PUSH',
    );
  }

  @EventPattern(TOPICS.INVENTORY_REJECTED)
  async onInventoryRejected(@Payload() e: InventoryRejectedEvent) {
    this.logger.warn(`inventory rejected order ${e.orderId}: ${e.reason}`);
    await this.notifications.record(
      TOPICS.INVENTORY_REJECTED,
      e.userId,
      `Item unavailable for order ${e.orderId.slice(0, 8)}: ${e.reason}`,
      e as any,
      'INTERNAL',
    );
  }
}
