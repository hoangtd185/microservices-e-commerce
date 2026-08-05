import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  email: string;

  @Column()
  name: string;

  /**
   * scrypt hash, stored as "salt:hash". Nullable because a user can be created
   * by an admin/seed path without ever setting a password.
   *
   * `select: false` keeps it out of every ordinary query, so it cannot leak
   * into an API response by accident - the single most common way password
   * hashes end up in public JSON.
   */
  @Column({ type: 'varchar', nullable: true, select: false })
  passwordHash: string | null;

  /** Denormalised read model, kept up to date by the order.confirmed event. */
  @Column({ type: 'int', default: 0 })
  ordersCount: number;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: {
      to: (v: number) => v,
      from: (v: string) => Number(v),
    },
  })
  totalSpent: number;

  @CreateDateColumn()
  createdAt: Date;
}
