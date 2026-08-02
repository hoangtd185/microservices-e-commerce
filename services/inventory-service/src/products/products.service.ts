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
import { Reservation } from './reservation.entity';
import { CreateProductDto, RestockDto } from './dto/product.dto';
import { KAFKA_PRODUCER } from '../kafka/kafka.module';
import {
  TOPICS,
  OrderCreatedEvent,
  OrderCancelledEvent,
  InventoryReservedEvent,
  InventoryRejectedEvent,
} from '../events/contracts';

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.kafka.connect();
    if (process.env.SEED_PRODUCTS === 'true') {
      await this.seed();
    }
  }

  private async seed() {
    const count = await this.products.count();
    if (count > 0) return;

    await this.products.save([
      { sku: 'PHONE-01', name: 'Budget Smartphone', price: 129.99, stock: 25 },
      { sku: 'HEADSET-01', name: 'Wireless Headset', price: 39.5, stock: 10 },
      { sku: 'CABLE-01', name: 'USB-C Cable 2m', price: 4.99, stock: 200 },
      { sku: 'LIMITED-01', name: 'Flash Sale Sneakers', price: 59.0, stock: 2 },
    ]);
    this.logger.log('seeded 4 demo products (LIMITED-01 has only 2 in stock)');
  }

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

  async restock(id: string, dto: RestockDto): Promise<Product> {
    const product = await this.findOne(id);
    product.stock += dto.quantity;
    return this.products.save(product);
  }

  /**
   * Step 2 of the saga: try to reserve stock for a brand new order.
   *
   * Everything happens in one Postgres transaction with a row lock, so two
   * concurrent orders for the last item cannot both succeed. The outcome is
   * then published as an event - success or failure, both are just facts.
   */
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const already = await manager.findOne(Reservation, {
        where: { orderId: event.orderId },
      });
      if (already) {
        this.logger.log(`order ${event.orderId} already processed, skipping`);
        return null; // idempotent no-op
      }

      const product = await manager.findOne(Product, {
        where: { id: event.productId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!product) {
        return { ok: false as const, reason: 'PRODUCT_NOT_FOUND', remaining: 0 };
      }
      if (product.stock < event.quantity) {
        return {
          ok: false as const,
          reason: `OUT_OF_STOCK (requested ${event.quantity}, available ${product.stock})`,
          remaining: product.stock,
        };
      }

      product.stock -= event.quantity;
      product.reserved += event.quantity;
      await manager.save(product);
      await manager.save(
        manager.create(Reservation, {
          orderId: event.orderId,
          productId: event.productId,
          quantity: event.quantity,
        }),
      );

      return { ok: true as const, reason: null, remaining: product.stock };
    });

    if (outcome === null) return;

    if (outcome.ok) {
      const reserved: InventoryReservedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        productId: event.productId,
        quantity: event.quantity,
        remainingStock: outcome.remaining,
      };
      // emit() is cold: awaiting it is what actually publishes to Kafka.
      await firstValueFrom(
        this.kafka.emit(TOPICS.INVENTORY_RESERVED, {
          key: event.orderId,
          value: reserved,
        }),
      );
      this.logger.log(`-> ${TOPICS.INVENTORY_RESERVED} ${event.orderId}`);
    } else {
      const rejected: InventoryRejectedEvent = {
        orderId: event.orderId,
        userId: event.userId,
        productId: event.productId,
        quantity: event.quantity,
        reason: outcome.reason,
      };
      await firstValueFrom(
        this.kafka.emit(TOPICS.INVENTORY_REJECTED, {
          key: event.orderId,
          value: rejected,
        }),
      );
      this.logger.warn(`-> ${TOPICS.INVENTORY_REJECTED} ${event.orderId}: ${outcome.reason}`);
    }
  }

  /**
   * Compensating transaction: the order died after we had already reserved,
   * so put the stock back. This is how you "roll back" across services -
   * there is no distributed transaction, only an undo step.
   */
  async handleOrderCancelled(event: OrderCancelledEvent): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const reservation = await manager.findOne(Reservation, {
        where: { orderId: event.orderId },
      });
      if (!reservation || reservation.released) return;

      const product = await manager.findOne(Product, {
        where: { id: reservation.productId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!product) return;

      product.stock += reservation.quantity;
      product.reserved = Math.max(0, product.reserved - reservation.quantity);
      reservation.released = true;

      await manager.save(product);
      await manager.save(reservation);
      this.logger.log(
        `released ${reservation.quantity} x ${product.sku} back to stock (order ${event.orderId})`,
      );
    });
  }
}
