import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  ValueTransformer,
} from 'typeorm';
import { Collection } from '../../collections/entities/collection.entity';

const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => (value ?? null),
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity({ name: 'collection_sends' })
export class CollectionSend {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'collection_id', type: 'uuid' })
  collectionId!: string;

  @ManyToOne(() => Collection, {
    nullable: false,
    onDelete: 'CASCADE',
    eager: true,
  })
  @JoinColumn({ name: 'collection_id' })
  collection!: Collection;

  @Column({ name: 'sent_at', type: 'timestamp' })
  sentAt!: Date;

  @Column({
    name: 'amount_usd',
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  amountUsd!: number;

  @Column({
    name: 'amount_bs',
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  amountBs!: number;

  @Column({
    name: 'currency_rate',
    type: 'numeric',
    precision: 14,
    scale: 4,
    transformer: decimalTransformer,
  })
  currencyRate!: number;

  @Column({ type: 'varchar', length: 10, default: 'USD' })
  currency!: string;

  @Column({ name: 'installment_number', type: 'int' })
  installmentNumber!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
