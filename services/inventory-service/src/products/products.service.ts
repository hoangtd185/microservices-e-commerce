import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Product } from './product.entity';
import { Reservation, ReservationStatus } from './reservation.entity';
import { CreateProductDto, RestockDto } from './dto/product.dto';
import { OutboxService } from '../outbox/outbox.service';
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
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Reservation)
    private readonly reservations: Repository<Reservation>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

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
    await this.dataSource.transaction(async (manager) => {
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

      if (claim.length === 0) {
        // Already handled. Nothing to redo, and nothing to re-publish either:
        // the first delivery wrote its outcome to the outbox in this same
        // transaction, so the event is guaranteed to go out exactly once.
        // (Before the outbox existed this branch had to replay the stored
        // outcome, because a crash between COMMIT and emit lost the event.)
        this.logger.log(`order ${event.orderId} already processed, skipping`);
        return;
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

      // --- the outcome goes into the outbox, in THIS transaction ---
      // One extra INSERT. No broker round trip while locks are held.
      if (status === ReservationStatus.RESERVED) {
        const payload: InventoryReservedEvent = {
          orderId: event.orderId,
          userId: event.userId,
          productId: event.productId,
          quantity: event.quantity,
          remainingStock,
        };
        await this.outbox.record(manager, {
          topic: TOPICS.INVENTORY_RESERVED,
          key: event.orderId,
          payload: payload as any,
        });
        this.logger.log(`reserved ${event.quantity} for order ${event.orderId}`);
      } else {
        const payload: InventoryRejectedEvent = {
          orderId: event.orderId,
          userId: event.userId,
          productId: event.productId,
          quantity: event.quantity,
          reason: reason ?? 'REJECTED',
        };
        await this.outbox.record(manager, {
          topic: TOPICS.INVENTORY_REJECTED,
          key: event.orderId,
          payload: payload as any,
        });
        this.logger.warn(`rejected order ${event.orderId}: ${reason}`);
      }
    });
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
