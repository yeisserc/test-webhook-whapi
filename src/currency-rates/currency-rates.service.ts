import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto';
import { CurrencyRate } from './entities/currency-rate.entity';

@Injectable()
export class CurrencyRatesService {
  constructor(
    @InjectRepository(CurrencyRate)
    private readonly currencyRatesRepository: Repository<CurrencyRate>,
  ) {}

  findAll(currency?: string) {
    return this.currencyRatesRepository.find({
      where: currency ? { currency: currency.trim().toUpperCase() } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async findLatest(currency: string): Promise<CurrencyRate> {
    const normalizedCurrency = currency?.trim().toUpperCase();
    if (!normalizedCurrency) {
      throw new BadRequestException('La moneda es obligatoria.');
    }

    const [latest] = await this.currencyRatesRepository.find({
      where: { currency: normalizedCurrency },
      order: { createdAt: 'DESC' },
      take: 1,
    });

    if (!latest) {
      throw new NotFoundException(`No se encontró tasa para la moneda ${normalizedCurrency}.`);
    }

    return latest;
  }

  async getCurrentRate(currency: string): Promise<number> {
    const latest = await this.findLatest(currency);
    return Number(latest.rate);
  }

  async create(payload: CreateCurrencyRateDto) {
    const currency = payload.currency?.trim().toUpperCase();
    const rate = Number(payload.rate);

    if (!currency) {
      throw new BadRequestException('La moneda es obligatoria.');
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('La tasa debe ser un número mayor que 0.');
    }

    const currencyRate = this.currencyRatesRepository.create({ currency, rate });
    return this.currencyRatesRepository.save(currencyRate);
  }
}
