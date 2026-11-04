import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Payment } from '../whatsapp-bot/entities/payment.entity';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), StorageModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}