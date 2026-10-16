import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  ValueTransformer,
} from 'typeorm';
import { Collection } from '../../collections/entities/collection.entity';
import { Payment } from './payment.entity';

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

  @Column({ name: 'sent_at', type: 'timestamptz' })
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

  @Index({ unique: true })
  @Column({ name: 'whatsapp_message_id', type: 'varchar', length: 128, nullable: true })
  whatsappMessageId?: string | null;

  /** sent | delivered | read | failed */
  @Column({ name: 'whatsapp_status', type: 'varchar', length: 20, default: 'sent' })
  whatsappStatus!: string;

  @Column({ name: 'whatsapp_status_at', type: 'timestamptz', nullable: true })
  whatsappStatusAt?: Date | null;

  @Column({ name: 'whatsapp_error', type: 'text', nullable: true })
  whatsappError?: string | null;

  @OneToMany(() => Payment, (payment) => payment.collectionSend)
  payments!: Payment[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
