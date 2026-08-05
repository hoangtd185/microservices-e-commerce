import { createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { IdempotencyKey } from './idempotency-key.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { RemoteService } from './remote.service';
import { OutboxService } from '../outbox/outbox.service';
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
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly repo: Repository<Order>,
    private readonly remote: RemoteService,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Step 1 of the saga: validate synchronously, persist as PENDING, announce.
   * We never wait for inventory - the HTTP response returns immediately.
   *
   * Note there is no Kafka call anywhere in this path any more. The event is
   * written to the outbox in the same transaction as the order, so the request
   * never waits on a broker round trip, and a crash can no longer lose it.
   */
  async create(
    dto: CreateOrderDto,
    userId: string,
    idempotencyKey?: string,
  ): Promise<CreateOrderResult> {
    await this.remote.getUser(userId);
    const product = await this.remote.getProduct(dto.productId);

    const draft = {
      userId,
      productId: dto.productId,
      quantity: dto.quantity,
      unitPrice: product.price,
      totalPrice: Number((product.price * dto.quantity).toFixed(2)),
      status: OrderStatus.PENDING,
    };

    if (idempotencyKey) {
      return this.createIdempotent(draft, userId, dto, idempotencyKey);
    }

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.save(manager.create(Order, draft));
      await this.recordOrderCreated(manager, order);
      return { order, replayed: false };
    });
  }

  private async recordOrderCreated(manager: EntityManager, order: Order): Promise<void> {
    const event: OrderCreatedEvent = {
      orderId: order.id,
      userId: order.userId,
      productId: order.productId,
      quantity: order.quantity,
      unitPrice: Number(order.unitPrice),
      totalPrice: Number(order.totalPrice),
      createdAt: order.createdAt.toISOString(),
    };
    await this.outbox.record(manager, {
      topic: TOPICS.ORDER_CREATED,
      key: order.id,
      payload: event as any,
    });
    this.logger.log(`order ${order.id} accepted (${TOPICS.ORDER_CREATED} queued)`);
  }

  private async createIdempotent(
    draft: Partial<Order>,
    userId: string,
    dto: CreateOrderDto,
    key: string,
  ): Promise<CreateOrderResult> {
    // Hash the meaningful fields, not the raw string: key reuse with a
    // different body must be caught, but formatting differences must not be.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId,
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

      // One transaction, three writes, all cheap: the key, the order, and the
      // event. Either all of it happened or none of it did.
      const order = await manager.save(manager.create(Order, draft));
      await manager.update(IdempotencyKey, { key }, { orderId: order.id });
      await this.recordOrderCreated(manager, order);

      return { order, replayed: false };
    });
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
    await this.transition(
      event.orderId,
      OrderStatus.CONFIRMED,
      null,
      TOPICS.ORDER_CONFIRMED,
      (order): OrderConfirmedEvent => ({
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        quantity: order.quantity,
        totalPrice: Number(order.totalPrice),
      }),
    );
  }

  /** Step 3b: inventory said no -> compensating action. */
  async cancel(event: InventoryRejectedEvent): Promise<void> {
    await this.transition(
      event.orderId,
      OrderStatus.CANCELLED,
      event.reason,
      TOPICS.ORDER_CANCELLED,
      (order): OrderCancelledEvent => ({
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        quantity: order.quantity,
        reason: event.reason,
      }),
    );
  }

  /**
   * Move a PENDING order to a terminal state and queue the resulting event,
   * both in one short transaction.
   *
   * Idempotency: Kafka is at-least-once, so this can run twice for the same
   * event. Only a PENDING order may transition, so the second run is a no-op
   * and does not queue a duplicate event.
   */
  private async transition(
    orderId: string,
    status: OrderStatus,
    reason: string | null,
    topic: string,
    buildEvent: (order: Order) => Record<string, any>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const updated = await manager.update(
        Order,
        { id: orderId, status: OrderStatus.PENDING },
        { status, statusReason: reason },
      );

      if (!updated.affected) {
        this.logger.log(`order ${orderId} is not PENDING, ignoring`);
        return;
      }

      const order = await manager.findOne(Order, { where: { id: orderId } });
      await this.outbox.record(manager, {
        topic,
        key: order.id,
        payload: buildEvent(order),
      });
      this.logger.log(`order ${order.id} -> ${status} (${topic} queued)`);
    });
  }
}
