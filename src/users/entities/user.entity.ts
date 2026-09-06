import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { Collection } from '../../collections/entities/collection.entity';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  password!: string;

  @Column({ name: 'phone_number', type: 'varchar', length: 30, nullable: true })
  phoneNumber!: string | null;

  @Column({ name: 'bank_username', type: 'varchar', length: 120, nullable: true })
  bankUsername!: string | null;

  @Column({ name: 'bank_password', type: 'varchar', length: 255, nullable: true })
  bankPassword!: string | null;

  @Column({ name: 'valid_bank_credentials', type: 'boolean', default: false })
  validBankCredentials!: boolean;

  @OneToMany(() => Client, (client) => client.user)
  clients!: Client[];

  @OneToMany(() => Collection, (collection) => collection.user)
  collections!: Collection[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
