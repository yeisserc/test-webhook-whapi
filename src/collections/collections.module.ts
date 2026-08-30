import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../clients/entities/client.entity';
import { User } from '../users/entities/user.entity';
import { WhatsappBotModule } from '../whatsapp-bot/whatsapp-bot.module';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Collection, Client, User]),
    forwardRef(() => WhatsappBotModule),
  ],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
