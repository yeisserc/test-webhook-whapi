import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { fetchBcvUsdRate } from './bcv-usd-rate.fetcher';
import { CreateCurrencyRateDto } from './dto/create-currency-rate.dto';
import { CurrencyRate } from './entities/currency-rate.entity';

export type SyncUsdRateFromBcvResult = {
  rate: number;
  previousRate: number | null;
  unchanged: boolean;
  saved: CurrencyRate;
  sourceUrl: string;
};

@Injectable()
export class CurrencyRatesService {
  private readonly logger = new Logger(CurrencyRatesService.name);

  constructor(
    @InjectRepository(CurrencyRate)
    private readonly currencyRatesRepository: Repository<CurrencyRate>,
    private readonly mailService: MailService,
  ) {}

  findAll(currency?: string) {
    return this.currencyRatesRepository.find({
      where: currency ? { currency: currency.trim().toUpperCase() } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async findLatest(currency: string): Promise<CurrencyRate> {
    const latest = await this.findLatestOrNull(currency);
    if (!latest) {
      throw new NotFoundException(
        `No se encontró tasa para la moneda ${currency?.trim().toUpperCase()}.`,
      );
    }
    return latest;
  }

  async findLatestOrNull(currency: string): Promise<CurrencyRate | null> {
    const normalizedCurrency = currency?.trim().toUpperCase();
    if (!normalizedCurrency) {
      throw new BadRequestException('La moneda es obligatoria.');
    }

    const [latest] = await this.currencyRatesRepository.find({
      where: { currency: normalizedCurrency },
      order: { createdAt: 'DESC' },
      take: 1,
    });

    return latest ?? null;
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

  /**
   * Toma la tasa USD del BCV, la guarda y notifica por correo
   * (éxito, sin cambio, o fallo).
   */
  async syncUsdRateFromBcv(): Promise<SyncUsdRateFromBcvResult> {
    try {
      const { rate, rawSourceUrl } = await fetchBcvUsdRate();
      const previous = await this.findLatestOrNull('USD');
      const previousRate = previous ? Number(previous.rate) : null;
      const unchanged =
        previousRate !== null && this.ratesEqual(previousRate, rate);

      const saved = await this.create({ currency: 'USD', rate });

      if (unchanged) {
        await this.mailService.sendAdminAlert(
          'CobroFacil: tasa USD sin cambio (BCV)',
          [
            'Se consultó el BCV y la tasa del dólar quedó igual.',
            '',
            `Tasa vigente: ${this.formatRate(rate)} Bs/USD`,
            `Fuente: ${rawSourceUrl}`,
            `Registro guardado: ${saved.id}`,
            `Fecha: ${new Date().toISOString()}`,
          ].join('\n'),
        );
      } else {
        await this.mailService.sendAdminAlert(
          'CobroFacil: tasa USD actualizada (BCV)',
          [
            'Se tomó y guardó el precio del dólar desde el BCV.',
            '',
            `Nueva tasa: ${this.formatRate(rate)} Bs/USD`,
            previousRate === null
              ? 'Tasa anterior: (no había registro)'
              : `Tasa anterior: ${this.formatRate(previousRate)} Bs/USD`,
            `Fuente: ${rawSourceUrl}`,
            `Registro guardado: ${saved.id}`,
            `Fecha: ${new Date().toISOString()}`,
          ].join('\n'),
        );
      }

      return {
        rate,
        previousRate,
        unchanged,
        saved,
        sourceUrl: rawSourceUrl,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Fallo al sincronizar tasa USD del BCV: ${message}`);

      await this.mailService.sendAdminAlert(
        'CobroFacil: error al actualizar tasa USD (BCV)',
        [
          'Hubo un problema al tomar o guardar la tasa del dólar del BCV.',
          '',
          `Detalle: ${message}`,
          `Fecha: ${new Date().toISOString()}`,
        ].join('\n'),
      );

      throw error;
    }
  }

  private ratesEqual(a: number, b: number): boolean {
    // La columna guarda hasta 4 decimales
    return Math.round(a * 10000) === Math.round(b * 10000);
  }

  private formatRate(rate: number): string {
    return rate.toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }
}
