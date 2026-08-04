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
import { DataSource, Repository } from 'typeorm';
import { Product } from './product.entity';
import { Reservation, ReservationStatus } from './reservation.entity';
import { CreateProductDto, RestockDto } from './dto/product.dto';
import { KAFKA_PRODUCER } from '../kafka/kafka.module';
import {
  TOPICS,
  OrderCreatedEvent,
  OrderCancelledEvent,
  InventoryReservedEvent,
  InventoryRejectedEvent,
} from '../events/contracts';

/** How long stock stays held before it should be given back. */
const RESERVATION_TTL_MINUTES = 15;

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Reservation)
    private readonly reservations: Repository<Reservation>,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.kafka.connect();
  }

  // ------------------------------------------------------------- read API ---

  findAll(): Promise<Product[]> {
    return this.products.find({ order: { sku: 'ASC' } });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.products.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  create(dto: CreateProductDto): Promise<Product> {
    return this.products.save(this.products.create(dto));
  }

  /**
   * Restock is the same atomic pattern, just without a condition: never read
   * a number, add to it in JavaScript, and write it back. That is a lost-update
   * bug waiting for two concurrent requests.
   */
  async restock(id: string, dto: RestockDto): Promise<Product> {
    const rows = await this.dataSource.query(
      `WITH restocked AS (
         UPDATE products
            SET stock = stock + $1, "updatedAt" = now()
          WHERE id = $2
         RETURNING id
       )
       SELECT id FROM restocked`,
      [dto.quantity, id],
    );
    if (rows.length === 0) throw new NotFoundException(`Product ${id} not found`);
    return this.findOne(id);
  }

  // ------------------------------------------------------------ the saga ---

  /**
   * Step 2 of the saga: decide whether this order gets its stock.
   *
   * Two guarantees, both enforced by the database rather than by application
   * logic, because application logic cannot see concurrent transactions:
   *
   *  - EXACTLY ONCE per order: the reservations primary key. A duplicate
   *    delivery of order.created cannot decrement stock twice. Concurrent
   *    duplicates are serialised by the unique index itself.
   *
   *  - NO OVERSELLING: a single conditional UPDATE. No SELECT, no row lock
   *    held across statements, no version column, no retry loop.
   */
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    const decision = await this.dataSource.transaction(async (manager) => {
      // --- claim the order id -------------------------------------------
      // ON CONFLICT DO NOTHING. If another delivery of this same event is
      // mid-flight, this INSERT blocks on the index until that transaction
      // commits, then finds the conflict and returns nothing.
      const claim: unknown[] = await manager.query(
        `INSERT INTO reservations
           ("orderId","productId","userId",quantity,status,"remainingStock","expiresAt")
         VALUES ($1,$2,$3,$4,'PENDING',0,$5)
         ON CONFLICT ("orderId") DO NOTHING
         RETURNING "orderId"`,
        [
          event.orderId,
          event.productId,
          event.userId,
          event.quantity,
          new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000),
        ],
      );

      const isFirstDelivery = claim.length > 0;

      if (!isFirstDelivery) {
        const existing = await manager.findOne(Reservation, {
          where: { orderId: event.orderId },
        });
        return { replayed: true, reservation: existing };
      }

      // --- the atomic decrement ------------------------------------------
      // One statement. Postgres takes a row lock for the duration of this
      // statement only; a concurrent UPDATE that was blocked here re-evaluates
      // `stock >= $1` against the committed row (EvalPlanQual), so the second
      // request correctly sees the reduced stock and matches zero rows.
      //
      // The UPDATE is wrapped in a CTE on purpose. TypeORM special-cases raw
      // UPDATE/DELETE and returns [rows, rowCount] instead of just rows, so
      // `result.length` would always be 2 and never match. Wrapping it makes
      // the outer command a SELECT, which returns rows normally - and the
      // whole thing is still one atomic statement.
      const updated: Array<{ stock: number }> = await manager.query(
        `WITH decremented AS (
           UPDATE products
              SET stock    = stock - $1,
                  reserved = reserved + $1,
                  "updatedAt" = now()
            WHERE id = $2
              AND stock >= $1
           RETURNING stock
         )
         SELECT stock FROM decremented`,
        [event.quantity, event.productId],
      );

      let status: ReservationStatus;
      let reason: string | null = null;
      let remainingStock = 0;

      if (updated.length === 1) {
        status = ReservationStatus.RESERVED;
        remainingStock = Number(updated[0].stock);
      } else {
        // Zero rows means one of two things - find out which, for a useful message.
        const [product] = await manager.query(
          `SELECT stock FROM products WHERE id = $1`,
          [event.productId],
        );
        status = ReservationStatus.REJECTED;
        reason = product
          ? `OUT_OF_STOCK (requested ${event.quantity}, available ${product.stock})`
          : 'PRODUCT_NOT_FOUND';
      }

      await manager.update(
        Reservation,
        { orderId: event.orderId },
        { status, reason, remainingStock },
      );

      const reservation = await manager.findOne(Reservation, {
        where: { orderId: event.orderId },
      });
      return { replayed: false, reservation };
    });

    await this.publishOutcome(event, decision.reservation, decision.replayed);
  }

  /**
   * Publishing happens after the transaction commits, which leaves a gap: if
   * this process dies right here, the decision is durable but nobody was told.
   * That is why a redelivery replays the stored outcome instead of skipping it.
   * (The complete fix is the transactional outbox - see the README.)
   */
  private async publishOutcome(
    event: OrderCreatedEvent,
    reservation: Reservation | null,
    replayed: boolean,
  ): Promise<void> {
    if (!reservation) return;

    const tag = replayed ? 'REPLAY' : 'new';

    if (reservation.status === ReservationStatus.RESERVED) {
      const payload: InventoryReservedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        productId: event.productId,
        quantity: event.quantity,
        remainingStock: reservation.remainingStock,
      };
      await firstValueFrom(
        this.kafka.emit(TOPICS.INVENTORY_RESERVED, {
          key: event.orderId,
          value: payload,
        }),
      );
      this.logger.log(`-> ${TOPICS.INVENTORY_RESERVED} ${event.orderId} [${tag}]`);
      return;
    }

    if (reservation.status === ReservationStatus.REJECTED) {
      const payload: InventoryRejectedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        productId: event.productId,
        quantity: event.quantity,
        reason: reservation.reason ?? 'REJECTED',
      };
      await firstValueFrom(
        this.kafka.emit(TOPICS.INVENTORY_REJECTED, {
          key: event.orderId,
          value: payload,
        }),
      );
      this.logger.warn(
        `-> ${TOPICS.INVENTORY_REJECTED} ${event.orderId}: ${reservation.reason} [${tag}]`,
      );
      return;
    }

    // RELEASED: the order was already cancelled and the stock handed back.
    this.logger.log(`order ${event.orderId} already released, nothing to publish`);
  }

  /**
   * Compensating transaction. There is no distributed rollback across services -
   * only an explicit undo step, guarded so it can run twice safely.
   */
  async handleOrderCancelled(event: OrderCancelledEvent): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Flip RESERVED -> RELEASED first. If this matches zero rows the
      // reservation was never held (rejected) or was already given back,
      // and we must not touch stock.
      const flipped = await manager.update(
        Reservation,
        { orderId: event.orderId, status: ReservationStatus.RESERVED },
        { status: ReservationStatus.RELEASED },
      );

      if (!flipped.affected) {
        this.logger.log(`nothing to release for order ${event.orderId}`);
        return;
      }

      const reservation = await manager.findOne(Reservation, {
        where: { orderId: event.orderId },
      });

      await manager.query(
        `UPDATE products
            SET stock    = stock + $1,
                reserved = GREATEST(reserved - $1, 0),
                "updatedAt" = now()
          WHERE id = $2`,
        [reservation.quantity, reservation.productId],
      );

      this.logger.log(
        `released ${reservation.quantity} unit(s) back to stock (order ${event.orderId})`,
      );
    });
  }

  /** Diagnostics: see what the service decided for a given order. */
  findReservation(orderId: string): Promise<Reservation | null> {
    return this.reservations.findOne({ where: { orderId } });
  }
}
