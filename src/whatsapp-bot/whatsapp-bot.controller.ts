import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappBotService } from './whatsapp-bot.service';
import { ReceiveMessageDto } from './dto/receive-message.dto';
import { SendReminderDto } from './dto/send-reminder.dto';
import { Payment } from './entities/payment.entity';

@Controller('whatsapp')
export class WhatsappBotController {
  private readonly logger = new Logger(WhatsappBotController.name);
  private readonly verifyToken: string;

  constructor(
    private readonly whatsappBotService: WhatsappBotService,
    private readonly configService: ConfigService,
  ) {
    this.verifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN') ?? '';
  }

  /**
   * Verificación del webhook por parte de Meta (Callback URL).
   * Meta envía: hub.mode, hub.verify_token, hub.challenge
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    if (mode === 'subscribe' && token && challenge && token === this.verifyToken) {
      this.logger.log('Webhook de WhatsApp verificado correctamente.');
      return challenge;
    }

    this.logger.warn('Falló la verificación del webhook de WhatsApp.');
    throw new ForbiddenException('Webhook verification failed.');
  }

  /**
   * Webhook para recibir mensajes de WhatsApp
   */
  @Post('webhook')
  async handleWebhook(@Body() dto: ReceiveMessageDto): Promise<{ success: boolean }> {
    this.logger.log(`Mensaje recibido de ${dto.phoneNumber}`);
    this.whatsappBotService.handleIncomingMessage(dto);
    return { success: true };
  }

  /**
   * Envía un recordatorio de cobranza
   */
  @Post('send-reminder')
  async sendReminder(@Body() dto: SendReminderDto): Promise<{ success: boolean }> {
    await this.whatsappBotService.sendReminder(dto);
    return { success: true };
  }

  /**
   * Obtiene pagos pendientes de verificación
   */
  @Get('payments/pending')
  async getPendingPayments(): Promise<Payment[]> {
    return this.whatsappBotService.getPendingPayments();
  }

  /**
   * Verifica y confirma un pago
   */
  @Post('payments/:id/verify')
  async verifyPayment(
    @Param('id') paymentId: string,
  ): Promise<{ success: boolean }> {
    await this.whatsappBotService.verifyAndConfirmPayment(paymentId);
    return { success: true };
  }

  /**
   * Envía recordatorios automáticos de cobro (típicamente ejecutado por un cron)
   */
  @Post('send-reminders/:daysOffset')
  async sendAutomaticReminders(@Param('daysOffset') daysOffset: string): Promise<{ sentCount: number }> {
    const offset = parseInt(daysOffset, 10);
    if (isNaN(offset)) {
      throw new BadRequestException('Invalid daysOffset parameter');
    }

    const count = await this.whatsappBotService.sendAutomaticReminders(offset);
    return { sentCount: count };
  }
}
