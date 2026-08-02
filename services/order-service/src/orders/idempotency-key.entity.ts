import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * "I already answered this exact request - here is the same answer again."
 *
 * The client sends an Idempotency-Key header. We insert that key and create the
 * order in ONE transaction, so a network retry, a double-clicked Buy button, or
 * an impatient mobile client cannot produce two orders.
 *
 * The requestHash matters as much as the key: reusing a key with a different
 * body is a client bug, and silently returning the old order would hide it.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  key: string;

  /** sha256 of the normalised request body. */
  @Column({ type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  /** Keys are not kept forever; prune anything past this. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
