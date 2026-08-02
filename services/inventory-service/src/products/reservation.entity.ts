import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per order we have already acted on.
 *
 * This is the idempotency guard: Kafka can deliver order.created twice
 * (rebalance, retry, redeploy). The orderId is the primary key, so the second
 * delivery hits a duplicate-key check and we skip it instead of reserving
 * stock twice.
 */
@Entity('reservations')
export class Reservation {
  @PrimaryColumn('uuid')
  orderId: string;

  @Column('uuid')
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ default: false })
  released: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
