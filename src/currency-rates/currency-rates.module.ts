import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailModule } from '../mail/mail.module';
import { CurrencyRatesController } from './currency-rates.controller';
import { CurrencyRatesScheduler } from './currency-rates.scheduler';
import { CurrencyRatesService } from './currency-rates.service';
import { CurrencyRate } from './entities/currency-rate.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CurrencyRate]), MailModule],
  controllers: [CurrencyRatesController],
  providers: [CurrencyRatesService, CurrencyRatesScheduler],
  exports: [TypeOrmModule, CurrencyRatesService],
})
export class CurrencyRatesModule {}
