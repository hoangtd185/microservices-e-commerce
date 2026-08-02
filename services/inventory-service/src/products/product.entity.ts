import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  sku: string;

  @Column()
  name: string;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
  })
  price: number;

  /** Physically available and not yet promised to anyone. */
  @Column({ type: 'int', default: 0 })
  stock: number;

  /** Promised to a PENDING/CONFIRMED order. */
  @Column({ type: 'int', default: 0 })
  reserved: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
