import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { RemoteService } from './remote.service';
import { KAFKA_PRODUCER } from '../kafka/kafka.module';
import {
  TOPICS,
  OrderCreatedEvent,
  OrderConfirmedEvent,
  OrderCancelledEvent,
  InventoryReservedEvent,
  InventoryRejectedEvent,
} from '../events/contracts';

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly repo: Repository<Order>,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
    private readonly remote: RemoteService,
  ) {}

  async onModuleInit() {
    await this.kafka.connect();
  }

  /**
   * Step 1 of the saga.
   * Validate synchronously, persist as PENDING, then announce the fact.
   * We do NOT wait for inventory - the HTTP response returns immediately.
   */
  async create(dto: CreateOrderDto): Promise<Order> {
    await this.remote.getUser(dto.userId);
    const product = await this.remote.getProduct(dto.productId);

    const order = await this.repo.save(
      this.repo.create({
        userId: dto.userId,
        productId: dto.productId,
        quantity: dto.quantity,
        unitPrice: product.price,
        totalPrice: Number((product.price * dto.quantity).toFixed(2)),
        status: OrderStatus.PENDING,
      }),
    );

    const event: OrderCreatedEvent = {
      orderId: order.id,
      userId: order.userId,
      productId: order.productId,
      quantity: order.quantity,
      unitPrice: Number(order.unitPrice),
      totalPrice: Number(order.totalPrice),
      createdAt: order.createdAt.toISOString(),
    };
    // emit() is a cold observable - awaiting it is what actually publishes,
    // and it also means we know the broker accepted the message.
    await firstValueFrom(
      this.kafka.emit(TOPICS.ORDER_CREATED, { key: order.id, value: event }),
    );
    this.logger.log(`-> ${TOPICS.ORDER_CREATED} ${order.id}`);

    return order;
  }

  findAll(userId?: string): Promise<Order[]> {
    return this.repo.find({
      where: userId ? { userId } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.repo.findOne({ where: { id } });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  /** Step 3a: inventory said yes. */
  async confirm(event: InventoryReservedEvent): Promise<void> {
    const order = await this.repo.findOne({ where: { id: event.orderId } });
    if (!order) {
      this.logger.warn(`inventory.reserved for unknown order ${event.orderId}`);
      return;
    }
    // Idempotency: the same event can be delivered more than once
    // (Kafka guarantees at-least-once, not exactly-once).
    if (order.status !== OrderStatus.PENDING) {
      this.logger.log(`order ${order.id} already ${order.status}, ignoring`);
      return;
    }

    order.status = OrderStatus.CONFIRMED;
    order.statusReason = null;
    await this.repo.save(order);

    const confirmed: OrderConfirmedEvent = {
      orderId: order.id,
      userId: order.userId,
      productId: order.productId,
      quantity: order.quantity,
      totalPrice: Number(order.totalPrice),
    };
    await firstValueFrom(
      this.kafka.emit(TOPICS.ORDER_CONFIRMED, { key: order.id, value: confirmed }),
    );
    this.logger.log(`-> ${TOPICS.ORDER_CONFIRMED} ${order.id}`);
  }

  /** Step 3b: inventory said no -> compensating action. */
  async cancel(event: InventoryRejectedEvent): Promise<void> {
    const order = await this.repo.findOne({ where: { id: event.orderId } });
    if (!order) {
      this.logger.warn(`inventory.rejected for unknown order ${event.orderId}`);
      return;
    }
    if (order.status !== OrderStatus.PENDING) {
      this.logger.log(`order ${order.id} already ${order.status}, ignoring`);
      return;
    }

    order.status = OrderStatus.CANCELLED;
    order.statusReason = event.reason;
    await this.repo.save(order);

    const cancelled: OrderCancelledEvent = {
      orderId: order.id,
      userId: order.userId,
      productId: order.productId,
      quantity: order.quantity,
      reason: event.reason,
    };
    await firstValueFrom(
      this.kafka.emit(TOPICS.ORDER_CANCELLED, { key: order.id, value: cancelled }),
    );
    this.logger.log(`-> ${TOPICS.ORDER_CANCELLED} ${order.id} (${event.reason})`);
  }
}
