import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappBotService } from './whatsapp-bot.service';
import { WhatsappBotController } from './whatsapp-bot.controller';
import { WhatsappBotSchedulerService } from './whatsapp-bot.scheduler';
import { Payment } from './entities/payment.entity';
import { CollectionSend } from './entities/collection-send.entity';
import { Collection } from '../collections/entities/collection.entity';
import { BankAutomationModule } from '../bank-automation/bank-automation.module';
import { OpenaiExtractionModule } from '../openai-extraction/openai-extraction.module';
import { CollectionsModule } from '../collections/collections.module';
import { CurrencyRatesModule } from '../currency-rates/currency-rates.module';
import { Client } from '../clients/entities/client.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, CollectionSend, Collection, Client]),
    BankAutomationModule,
    OpenaiExtractionModule,
    forwardRef(() => CollectionsModule),
    CurrencyRatesModule,
    WhatsappModule,
    UsersModule,
  ],
  controllers: [WhatsappBotController],
  providers: [WhatsappBotService, WhatsappBotSchedulerService],
  exports: [WhatsappBotService],
})
export class WhatsappBotModule {}
