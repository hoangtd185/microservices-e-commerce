import { createHash } from 'crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { IdempotencyKey } from './idempotency-key.entity';
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

const IDEMPOTENCY_TTL_HOURS = 24;

export interface CreateOrderResult {
  order: Order;
  /** True when this response is a replay of an earlier identical request. */
  replayed: boolean;
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly repo: Repository<Order>,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
    private readonly remote: RemoteService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.kafka.connect();
  }

  /**
   * Step 1 of the saga: validate synchronously, persist as PENDING, announce.
   * We never wait for inventory - the HTTP response returns immediately.
   */
  async create(
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ): Promise<CreateOrderResult> {
    await this.remote.getUser(dto.userId);
    const product = await this.remote.getProduct(dto.productId);

    const draft = {
      userId: dto.userId,
      productId: dto.productId,
      quantity: dto.quantity,
      unitPrice: product.price,
      totalPrice: Number((product.price * dto.quantity).toFixed(2)),
      status: OrderStatus.PENDING,
    };

    const result = idempotencyKey
      ? await this.createIdempotent(draft, dto, idempotencyKey)
      : { order: await this.repo.save(this.repo.create(draft)), replayed: false };

    // A replay must not publish a second order.created - the first request
    // already did, and inventory has already decided.
    if (!result.replayed) {
      await this.publishOrderCreated(result.order);
    }

    return result;
  }

  private async createIdempotent(
    draft: Partial<Order>,
    dto: CreateOrderDto,
    key: string,
  ): Promise<CreateOrderResult> {
    // Hash the meaningful fields, not the raw string: key reuse with a
    // different body must be caught, but formatting differences must not be.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId: dto.userId,
          productId: dto.productId,
          quantity: dto.quantity,
        }),
      )
      .digest('hex');

    return this.dataSource.transaction(async (manager) => {
      // Claim the key. A concurrent request with the same key blocks on the
      // primary key index here until we commit, then sees the conflict -
      // so "double-clicked Buy" is resolved by Postgres, not by a race in JS.
      const claim: unknown[] = await manager.query(
        `INSERT INTO idempotency_keys ("key","requestHash","orderId","expiresAt")
         VALUES ($1,$2,NULL,$3)
         ON CONFLICT ("key") DO NOTHING
         RETURNING "key"`,
        [key, requestHash, new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3_600_000)],
      );

      if (claim.length === 0) {
        const existing = await manager.findOne(IdempotencyKey, { where: { key } });

        if (existing.requestHash !== requestHash) {
          throw new UnprocessableEntityException(
            `Idempotency-Key ${key} was already used with a different request body`,
          );
        }
        if (!existing.orderId) {
          // Only reachable if a previous attempt committed the key but not the
          // order, which this transaction design prevents - defensive.
          throw new ConflictException(
            `A request with Idempotency-Key ${key} is still in flight`,
          );
        }

        const order = await manager.findOne(Order, { where: { id: existing.orderId } });
        this.logger.log(`replayed idempotent request ${key} -> order ${order.id}`);
        return { order, replayed: true };
      }

      // Same transaction as the key: either both land or neither does.
      const order = await manager.save(manager.create(Order, draft));
      await manager.update(IdempotencyKey, { key }, { orderId: order.id });

      return { order, replayed: false };
    });
  }

  private async publishOrderCreated(order: Order): Promise<void> {
    const event: OrderCreatedEvent = {
      orderId: order.id,
      userId: order.userId,
      productId: order.productId,
      quantity: order.quantity,
      unitPrice: Number(order.unitPrice),
      totalPrice: Number(order.totalPrice),
      createdAt: order.createdAt.toISOString(),
    };
    // emit() is a cold observable - awaiting it is what actually publishes.
    await firstValueFrom(
      this.kafka.emit(TOPICS.ORDER_CREATED, { key: order.id, value: event }),
    );
    this.logger.log(`-> ${TOPICS.ORDER_CREATED} ${order.id}`);
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
    // Idempotency: Kafka guarantees at-least-once, so this event can arrive
    // more than once. Only a PENDING order may transition.
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
