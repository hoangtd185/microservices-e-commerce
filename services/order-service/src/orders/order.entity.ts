import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OrderStatus {
  /** Written to the DB, order.created published, waiting for inventory. */
  PENDING = 'PENDING',
  /** inventory.reserved arrived. */
  CONFIRMED = 'CONFIRMED',
  /** inventory.rejected arrived (or a manual cancel). */
  CANCELLED = 'CANCELLED',
}

const money = {
  type: 'numeric' as const,
  precision: 12,
  scale: 2,
  transformer: {
    to: (v: number) => v,
    from: (v: string) => Number(v),
  },
};

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @Index()
  @Column('uuid')
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column(money)
  unitPrice: number;

  @Column(money)
  totalPrice: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ type: 'varchar', nullable: true })
  statusReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
