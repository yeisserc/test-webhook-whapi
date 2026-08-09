import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrencyRatesService } from './currency-rates.service';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto';

@Controller('currency-rates')
export class CurrencyRatesController {
  constructor(private readonly currencyRatesService: CurrencyRatesService) {}

  @Get()
  findAll(@Query('currency') currency?: string) {
    return this.currencyRatesService.findAll(currency);
  }

  @Get('latest')
  findLatest(@Query('currency') currency = 'USD') {
    return this.currencyRatesService.findLatest(currency);
  }

  @Post()
  create(@Body() payload: CreateCurrencyRateDto) {
    return this.currencyRatesService.create(payload);
  }
}
