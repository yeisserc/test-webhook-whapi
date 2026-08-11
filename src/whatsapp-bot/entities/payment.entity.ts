import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { CollectionSend } from './collection-send.entity';

const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => (value ?? null),
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'collection_send_id', type: 'uuid' })
  collectionSendId!: string;

  @ManyToOne(() => CollectionSend, {
    nullable: false,
    onDelete: 'CASCADE',
    eager: true,
  })
  @JoinColumn({ name: 'collection_send_id' })
  collectionSend!: CollectionSend;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  amount!: number;

  @Column({ name: 'installment_number', type: 'int' })
  installmentNumber!: number;

  @Column({ name: 'reference_number', type: 'varchar', length: 100, nullable: true })
  referenceNumber!: string | null;

  @Column({ name: 'screenshot_url', type: 'text', nullable: true })
  screenshotUrl!: string | null;

  @Column({ type: 'varchar', length: 50 })
  status!: string; // 'pending', 'verified', 'rejected'

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'verified_at', type: 'timestamp', nullable: true })
  verifiedAt!: Date | null;
}
