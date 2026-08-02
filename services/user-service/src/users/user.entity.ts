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
