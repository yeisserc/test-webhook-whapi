import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WhatsappBotService } from './whatsapp-bot.service';

@Injectable()
export class WhatsappBotSchedulerService {
  private readonly logger = new Logger(WhatsappBotSchedulerService.name);
  private readonly paymentVerificationEnabled: boolean;
  private readonly paymentDueRemindersEnabled: boolean;

  constructor(
    private readonly whatsappBotService: WhatsappBotService,
    private readonly configService: ConfigService,
  ) {
    this.paymentVerificationEnabled = this.isEnabled('VERIFY_PENDING_PAYMENTS');
    this.paymentDueRemindersEnabled = this.isEnabled('SEND_PAYMENT_DUE_REMINDERS');
    this.logger.log(
      this.paymentVerificationEnabled
        ? 'Verificación automática de pagos activada.'
        : 'Verificación automática de pagos desactivada (VERIFY_PENDING_PAYMENTS=false).',
    );
    this.logger.log(
      this.paymentDueRemindersEnabled
        ? 'Recordatorios del día de cobro activados.'
        : 'Recordatorios del día de cobro desactivados (SEND_PAYMENT_DUE_REMINDERS=false).',
    );
  }

  private isEnabled(name: string): boolean {
    const value = this.configService.get<string>(name, 'true')?.trim().toLowerCase();
    return value !== 'false';
  }

  /**
   * Envía recordatorios 2 días antes de la fecha de cobro
   * Se ejecutaría diariamente a las 9:00 AM con: @Cron(CronExpression.EVERY_DAY_AT_9AM)
   */
  async sendEarlyReminders(): Promise<void> {
    try {
      this.logger.debug('Enviando recordatorios con 2 días de anticipación...');
      const count = await this.whatsappBotService.sendAutomaticReminders(2);
      this.logger.log(`${count} recordatorios enviados`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error en sendEarlyReminders: ${message}`);
    }
  }

  /**
   * Envía recordatorios el día de cobro, todos los días a las 7:00 PM
   */
  // @Cron(CronExpression.EVERY_DAY_AT_7PM, {
  @Cron("10 10 * * *", {
    timeZone: 'America/Caracas',
  })
  async sendPaymentDueReminders(): Promise<void> {
    if (!this.paymentDueRemindersEnabled) {
      return;
    }

    try {
      this.logger.debug('Enviando recordatorios de cobranza del día...');
      const count = await this.whatsappBotService.sendAutomaticReminders(0);
      this.logger.log(`${count} recordatorios de cobro enviados`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error en sendPaymentDueReminders: ${message}`);
    }
  }

  /**
   * Verifica automáticamente los pagos pendientes
   * Se ejecutaría cada 30 minutos con: @Cron(CronExpression.EVERY_30_MINUTES)
   */ 
  // @Cron(CronExpression.EVERY_10_MINUTES, {
  @Cron('0 */3 * * * *', {
    timeZone: 'America/Caracas',
  })
  async verifyPendingPayments(): Promise<void> {
    if (!this.paymentVerificationEnabled) {
      return;
    }

    try {
      this.logger.debug('Verificando pagos pendientes...');
      const pendingPayments = await this.whatsappBotService.getPendingPayments();

      for (const payment of pendingPayments) {
        try {
          await this.whatsappBotService.verifyAndConfirmPayment(payment.id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error verificando pago ${payment.id}: ${message}`);
        }
      }

      this.logger.log(`${pendingPayments.length} pagos pendientes procesados en este ciclo`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error en verifyPendingPayments: ${message}`);
    }
  }
}
