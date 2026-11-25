import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CurrencyRatesService } from './currency-rates.service';

@Injectable()
export class CurrencyRatesScheduler {
  private readonly logger = new Logger(CurrencyRatesScheduler.name);
  private readonly enabled: boolean;
  private running = false;

  constructor(
    private readonly currencyRatesService: CurrencyRatesService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.isEnabled('UPDATE_USD_RATE_FROM_BCV');
    this.logger.log(
      this.enabled
        ? 'Actualización diaria de tasa USD (BCV) activada: L–V 16:05 America/Caracas.'
        : 'Actualización diaria de tasa USD (BCV) desactivada (UPDATE_USD_RATE_FROM_BCV=false).',
    );
  }

  private isEnabled(name: string): boolean {
    const value = this.configService.get<string>(name, 'true')?.trim().toLowerCase();
    return value !== 'false';
  }

  /**
   * Lunes a viernes a las 5:05 PM (hora Venezuela): toma la tasa USD del BCV.
   */
  @Cron('5 17 * * 1-5', {
    timeZone: 'America/Caracas',
  })
  async updateUsdRateFromBcv(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.running) {
      this.logger.warn('Actualización BCV omitida: ya hay una en curso.');
      return;
    }

    this.running = true;
    try {
      this.logger.log('Iniciando actualización de tasa USD desde el BCV…');
      const result = await this.currencyRatesService.syncUsdRateFromBcv();
      this.logger.log(
        result.unchanged
          ? `Tasa USD sin cambio: ${result.rate}`
          : `Tasa USD actualizada: ${result.previousRate ?? 'n/a'} → ${result.rate}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error en updateUsdRateFromBcv: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
