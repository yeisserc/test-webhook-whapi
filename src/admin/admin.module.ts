import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../clients/entities/client.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CurrencyRatesModule } from '../currency-rates/currency-rates.module';
import { UsersModule } from '../users/users.module';
import { CollectionSend } from '../whatsapp-bot/entities/collection-send.entity';
import { Payment } from '../whatsapp-bot/entities/payment.entity';
import { AdminAuthService } from './admin-auth.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Module({
  imports: [
    UsersModule,
    CurrencyRatesModule,
    TypeOrmModule.forFeature([Client, Collection, CollectionSend, Payment]),
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminService, AdminGuard],
})
export class AdminModule {}
