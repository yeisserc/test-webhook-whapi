import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Collection } from '../../collections/entities/collection.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'clients' })
export class Client {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.clients, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 120 })
  firstName!: string;

  @Column({ type: 'varchar', length: 120 })
  lastName!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  nickname!: string | null;

  @Column({ type: 'varchar', length: 4, default: '58' })
  countryCode!: string;

  @Column({ type: 'varchar', length: 10 })
  phoneCode!: string;

  @Column({ type: 'varchar', length: 20 })
  phoneNumber!: string;

  @OneToMany(() => Collection, (collection) => collection.client)
  collections!: Collection[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
