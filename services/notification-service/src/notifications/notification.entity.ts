import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** Which event produced this notification, e.g. order.confirmed. */
  @Column()
  topic: string;

  @Column({ default: 'EMAIL' })
  channel: string;

  @Column()
  message: string;

  /** The raw event, handy for debugging what a consumer actually received. */
  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
