import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CollectionSend } from '../whatsapp-bot/entities/collection-send.entity';
import { Payment } from '../whatsapp-bot/entities/payment.entity';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { Client } from './entities/client.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Client, User, Collection, CollectionSend, Payment])],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [TypeOrmModule, ClientsService],
})
export class ClientsModule {}
