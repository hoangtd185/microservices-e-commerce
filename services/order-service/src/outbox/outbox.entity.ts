import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The transactional outbox.
 *
 * The problem it solves: a service cannot atomically write to Postgres AND
 * publish to Kafka. Two systems, two commits, no shared transaction. Crash in
 * between and you get an order that exists but that nobody was ever told about.
 *
 * The fix: don't publish. Write the event into THIS table, inside the same
 * transaction as the business data. One commit, one system, fully atomic.
 * A separate relay then reads the table and publishes to Kafka afterwards.
 *
 * The guarantee changes from "maybe published" to "published at least once",
 * which is exactly what Kafka gives you anyway - so consumers already cope.
 */
@Entity('outbox')
@Index(['publishedAt', 'id'])
export class OutboxMessage {
  /** Sequential: the relay publishes in insertion order. */
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  topic: string;

  /** Kafka message key - decides the partition, and therefore ordering. */
  @Column({ type: 'varchar', nullable: true })
  messageKey: string | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  /**
   * Set when a relay picks the row up. Acts as a lease: if the relay dies
   * mid-publish, the row becomes claimable again after a timeout instead of
   * being stuck forever.
   */
  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  /** Non-null means it reached Kafka. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
