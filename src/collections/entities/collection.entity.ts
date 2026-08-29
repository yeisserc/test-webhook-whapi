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
import { Client } from '../../clients/entities/client.entity';
import { User } from '../../users/entities/user.entity';

const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => (value ?? null),
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity({ name: 'collections' })
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.collections, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @ManyToOne(() => Client, (client) => client.collections, {
    nullable: false,
    onDelete: 'CASCADE',
    eager: true,
  })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @Column({
    name: 'total_debt',
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  totalDebt!: number;

  @Column({
    name: 'current_debt',
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  currentDebt!: number;

  @Column({ name: 'installments', type: 'int' })
  installments!: number;

  @Column({ name: 'current_installment', type: 'int' })
  currentInstallment!: number;

  @Column({ type: 'varchar', length: 60 })
  frequency!: string;

  @Column({ name: 'collection_day', type: 'varchar', length: 20, nullable: true })
  collectionDay!: string | null;

  @Column({ type: 'varchar', length: 255 })
  concept!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
