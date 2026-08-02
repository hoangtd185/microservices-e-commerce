import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum ReservationStatus {
  /** Only ever visible inside the claiming transaction. */
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  REJECTED = 'REJECTED',
  RELEASED = 'RELEASED',
}

/**
 * One row per order we have already decided on. Two jobs:
 *
 * 1. IDEMPOTENCY. orderId is the primary key, so a redelivered order.created
 *    hits the unique index instead of decrementing stock a second time.
 *    Concurrent duplicates are serialised by that same index: the second INSERT
 *    blocks until the first transaction commits, then finds the conflict.
 *
 * 2. OUTCOME RECORD. We store what we decided, so a duplicate delivery can
 *    re-publish the original answer. That matters: if we committed the
 *    decrement and then crashed before emitting, the order would sit in PENDING
 *    forever. On redelivery we replay the stored outcome instead of recomputing.
 */
@Entity('reservations')
export class Reservation {
  @PrimaryColumn('uuid')
  orderId: string;

  @Index()
  @Column('uuid')
  productId: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'enum', enum: ReservationStatus })
  status: ReservationStatus;

  /** Why it was rejected; null when reserved. */
  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  /** Stock left at the moment we decided - replayed in inventory.reserved. */
  @Column({ type: 'int', default: 0 })
  remainingStock: number;

  /**
   * Held stock must not be held forever - an abandoned checkout should give
   * the items back. A reaper releases RESERVED rows past this timestamp.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
