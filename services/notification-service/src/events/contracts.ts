/**
 * Event contracts shared by every service.
 *
 * In a real system this file lives in a shared package (or a schema registry
 * with Avro/Protobuf). Here it is copy-pasted into each service on purpose:
 * every service stays independently buildable and you can see the whole
 * contract without jumping between packages.
 *
 * Rule of thumb: topics are named <aggregate>.<past-tense-event>.
 * An event is a fact that already happened, so it is never rejected -
 * consumers just react to it.
 */
export const TOPICS = {
  USER_CREATED: 'user.created',
  ORDER_CREATED: 'order.created',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_REJECTED: 'inventory.rejected',
} as const;

export interface UserCreatedEvent {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface OrderCreatedEvent {
  orderId: string;
  userId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  createdAt: string;
}

export interface InventoryReservedEvent {
  orderId: string;
  userId: string;
  productId: string;
  quantity: number;
  remainingStock: number;
}

export interface InventoryRejectedEvent {
  orderId: string;
  userId: string;
  productId: string;
  quantity: number;
  reason: string;
}

export interface OrderConfirmedEvent {
  orderId: string;
  userId: string;
  productId: string;
  quantity: number;
  totalPrice: number;
}

export interface OrderCancelledEvent {
  orderId: string;
  userId: string;
  productId: string;
  quantity: number;
  reason: string;
}
