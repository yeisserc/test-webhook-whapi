import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { CollectionSend } from './entities/collection-send.entity';
import { SendReminderDto } from './dto/send-reminder.dto';
import { ReceiveMessageDto } from './dto/receive-message.dto';
import { MetaWebhookPayload } from './dto/meta-webhook.dto';
import type { MetaWebhookMessage, MetaWebhookStatus } from './dto/meta-webhook.dto';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { Collection } from '../collections/entities/collection.entity';
import { BankAutomationService } from '../bank-automation/bank-automation.service';
import { OpenaiExtractionService } from '../openai-extraction/openai-extraction.service';
import { CollectionsService } from '../collections/collections.service';
import { CurrencyRatesService } from '../currency-rates/currency-rates.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { PAYMENT_BANK_LABELS } from '../users/payment-bank.enum';
import { MailService } from '../mail/mail.service';
import { WhatsappStatusGateway } from './whatsapp-status.gateway';
import { SupabaseStorageService } from '../storage/supabase-storage.service';
import { extractAmountFromText } from '../utils';

const MAX_BANK_VERIFICATION_ATTEMPTS = 100;

const TEMPLATE_NAME_PAYMENT_REMINDER = 'is_payment_date_v4';
const TEMPLATE_NAME_EARLY_REMINDER = 'two_days_for_payme_day';
const TEMPLATE_NAME_RECEIVED_PAYMENT = 'received_payment_v2';
/** Recordatorio de la tarde si no llegó el comprobante. El nombre lo define Meta. */
const TEMPLATE_NAME_AFTERNOON_FOLLOWUP = 'afternoon_follow_up';
/** Recobro del día siguiente. Mismos parámetros que is_payment_date_v4, sin current_date. */
const TEMPLATE_NAME_NEXT_DAY_FOLLOWUP = 'payment_next_day_follow_up';

const SCREENSHOT_ONLY_REPLY = `📸 Para validar tu pago, por favor envía únicamente el capture del pago por este chat.

No envíes texto ni otros archivos. ¡Gracias! 🙌`;

const WHATSAPP_STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

type TemplateName =
  | typeof TEMPLATE_NAME_PAYMENT_REMINDER
  | typeof TEMPLATE_NAME_EARLY_REMINDER
  | typeof TEMPLATE_NAME_NEXT_DAY_FOLLOWUP;

@Injectable()
export class WhatsappBotService {
  private readonly logger = new Logger(WhatsappBotService.name);
  private verificationCycleRunning = false;

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(CollectionSend)
    private readonly collectionSendRepository: Repository<CollectionSend>,
    @InjectRepository(Collection)
    private readonly collectionRepository: Repository<Collection>,
    private readonly bankAutomationService: BankAutomationService,
    private readonly openaiExtractionService: OpenaiExtractionService,
    private readonly collectionsService: CollectionsService,
    private readonly currencyRatesService: CurrencyRatesService,
    private readonly whatsappService: WhatsappService,
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
    private readonly whatsappStatusGateway: WhatsappStatusGateway,
    private readonly storage: SupabaseStorageService,
  ) {}

  /**
   * Envía un mensaje de recordatorio de cobranza
   */
  async sendReminder(dto: SendReminderDto): Promise<CollectionSend | null> {
    try {
      const collection = await this.collectionRepository.findOne({
        where: { id: dto.collectionId },
        relations: { client: true, user: true },
      });

      if (!collection) {
        throw new BadRequestException('Cobranza no encontrada');
      }

      const currency = 'USD';
      const currencyRate = await this.currencyRatesService.getCurrentRate(currency);
      const amountUsd = Number((collection.totalDebt / collection.installments).toFixed(2));
      const amountBs = Number((amountUsd * currencyRate).toFixed(2));

      const templateName = dto.daysUntilPayment === 0 ?
        TEMPLATE_NAME_PAYMENT_REMINDER :
        TEMPLATE_NAME_EARLY_REMINDER;

      const bodyParameters = this.buildBodyParameters(
        collection,
        templateName,
        dto.daysUntilPayment,
        amountUsd,
        amountBs,
        collection.currentInstallment,
      );

      const sendResult = await this.whatsappService.sendTemplateMessage({
        to: dto.phoneNumber,
        templateName,
        bodyParameters,
      });
      const whatsappMessageId = sendResult.messages?.[0]?.id ?? null;

      // Solo registrar el envío el día de cobro (no el recordatorio de 2 días antes)
      if (dto.daysUntilPayment === 0) {
        const collectionSend = await this.collectionSendRepository.save(
          this.collectionSendRepository.create({
            collectionId: collection.id,
            collection,
            sentAt: new Date(),
            amountUsd,
            amountBs,
            currencyRate,
            currency,
            installmentNumber: collection.currentInstallment,
            whatsappMessageId,
            whatsappStatus: 'sent',
            whatsappStatusAt: new Date(),
          }),
        );
        this.publishWhatsappStatus(collectionSend, collection);
        return collectionSend;
      }

      return null;
    } catch (error: unknown) {
      console.log(`sendReminder error: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error enviando recordatorio: ${message}`);
      throw error;
    }
  }

  /**
   * Envía manualmente el cobro de la cuota en curso.
   */
  async sendManualCharge(collectionId: string): Promise<{
    collectionId: string;
    installmentNumber: number;
    amountUsd: number;
    amountBs: number;
    collectionSendId: string;
  }> {
    const collection = await this.collectionRepository.findOne({
      where: { id: collectionId },
      relations: { client: true },
    });

    if (!collection) {
      throw new BadRequestException('Cobranza no encontrada');
    }

    if (Number(collection.currentDebt) <= 0) {
      throw new BadRequestException('Esta cobranza ya está saldada.');
    }

    if (collection.currentInstallment > collection.installments) {
      throw new BadRequestException('Todas las cuotas de esta cobranza ya fueron cobradas.');
    }

    const client = collection.client;
    if (!client?.phoneCode?.trim() || !client?.phoneNumber?.trim()) {
      throw new BadRequestException('El cliente no tiene teléfono configurado.');
    }

    const phoneNumber = `${client.countryCode ?? '58'}${client.phoneCode}${client.phoneNumber}`;
    const amountUsd = Number((collection.totalDebt / collection.installments).toFixed(2));
    const currencyRate = await this.currencyRatesService.getCurrentRate('USD');
    const amountBs = Number((amountUsd * currencyRate).toFixed(2));

    const collectionSend = await this.sendReminder({
      collectionId: collection.id,
      daysUntilPayment: 0,
      phoneNumber,
    });

    if (!collectionSend) {
      throw new BadRequestException('No se pudo registrar el envío de cobro.');
    }

    this.logger.log(
      `Envío manual de cobro para cobranza ${collection.id}, cuota ${collection.currentInstallment}`,
    );

    return {
      collectionId: collection.id,
      installmentNumber: collectionSend.installmentNumber,
      amountUsd: collectionSend.amountUsd,
      amountBs: collectionSend.amountBs,
      collectionSendId: collectionSend.id,
    };
  }

  /**
   * Procesa el payload real del webhook de Meta
   */
  async handleMetaWebhook(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') {
      this.logger.debug(`Webhook ignorado: object=${payload.object ?? 'undefined'}`);
      return;
    }

    const statuses = this.extractStatusUpdates(payload);
    for (const status of statuses) {
      await this.applyWhatsappStatus(status);
    }

    const messages = this.extractIncomingMessages(payload);
    if (messages.length === 0) {
      if (statuses.length === 0) {
        this.logger.debug('Webhook de Meta sin mensajes ni actualizaciones de estado.');
      }
      return;
    }

    await this.handleIncomingMessages(messages);
  }

  /**
   * Revisa juntos los mensajes de un mismo aviso.
   * Si alguno trae imagen, se procesan las capturas y no se responde al texto.
   * Si ninguno trae imagen, se envía un solo aviso pidiendo la captura.
   */
  private async handleIncomingMessages(messages: ReceiveMessageDto[]): Promise<void> {
    const byPhone = new Map<string, ReceiveMessageDto[]>();
    for (const message of messages) {
      const group = byPhone.get(message.phoneNumber) ?? [];
      group.push(message);
      byPhone.set(message.phoneNumber, group);
    }

    for (const [phoneNumber, group] of byPhone) {
      for (const message of group) {
        this.logger.log(
          `Mensaje recibido de ${phoneNumber} (type=${message.mediaType ?? 'text'}, id=${message.messageId ?? 'n/a'})`,
        );
      }

      const images = group.filter(
        (message) => message.mediaType === 'image' && (message.mediaId || message.mediaUrl),
      );

      if (images.length > 0) {
        for (const image of images) {
          try {
            await this.processPaymentFromScreenshot(phoneNumber, {
              mediaId: image.mediaId,
              mediaUrl: image.mediaUrl,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error procesando mensaje entrante: ${message}`);
          }
        }
        continue;
      }

      try {
        await this.whatsappService.sendTextMessage(phoneNumber, SCREENSHOT_ONLY_REPLY);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error respondiendo mensaje sin captura: ${message}`);
      }
    }
  }

  /**
   * Procesa un pago desde un screenshot
   */
  private async processPaymentFromScreenshot(
    phoneNumber: string,
    media: { mediaId?: string; mediaUrl?: string },
  ): Promise<void> {
    try {
      let imageBuffer: Buffer;
      let mimeType = 'image/jpeg';

      if (media.mediaId) {
        const downloaded = await this.whatsappService.downloadMedia(media.mediaId);
        imageBuffer = downloaded.buffer;
        mimeType = downloaded.mimeType;
      } else if (media.mediaUrl) {
        const imageResponse = await fetch(media.mediaUrl);
        const arrayBuffer = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
        mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
      } else {
        throw new BadRequestException('No se recibió media para procesar el comprobante');
      }

      const extractedData = await this.openaiExtractionService.extractTransferDataFromImage(
        imageBuffer,
        mimeType,
      );

      if (!extractedData || !extractedData.amount || !extractedData.reference) {
        throw new BadRequestException('No se pudo extraer los datos del comprobante');
      }

      const collectionSend = await this.findLatestCollectionSendByPhoneNumber(phoneNumber);
      if (!collectionSend) {
        throw new BadRequestException('No se encontró un envío de cobranza asociado');
      }

      const screenshotUrl = await this.storage.savePaymentScreenshot(imageBuffer, mimeType);

      await this.createPaymentRecord({
        collectionSendId: collectionSend.id,
        referenceNumber: extractedData.reference,
        screenshotUrl,
        amount: extractedData.amount,
        installmentNumber: collectionSend.installmentNumber,
      });

      await this.whatsappService.sendTextMessage(
        phoneNumber,
        'Su pago se está verificando, le avisamos cuando lo hayamos validado. Esto puede tardar unos minutos.',
      );

      this.logger.log(`Pago registrado para verificación: ${extractedData.reference}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando screenshot: ${message}`);

      try {
        await this.whatsappService.sendTextMessage(
          phoneNumber,
          'Hubo un error al procesar su pago. Por favor reenvíe el capture.',
        );
      } catch (notifyError: unknown) {
        const notifyMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
        this.logger.error(`Error notificando fallo de screenshot: ${notifyMessage}`);
      }

      throw error;
    }
  }

  private extractStatusUpdates(payload: MetaWebhookPayload): MetaWebhookStatus[] {
    const results: MetaWebhookStatus[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== 'messages') {
          continue;
        }

        for (const status of change.value?.statuses ?? []) {
          if (status?.id && status.status) {
            results.push(status);
          }
        }
      }
    }

    return results;
  }

  /**
   * Actualiza el estado de entrega de un envío sin retroceder
   * (enviado → recibido → leído). Un fallo no pisa un mensaje ya entregado.
   */
  private async applyWhatsappStatus(status: MetaWebhookStatus): Promise<void> {
    const messageId = status.id?.trim();
    const nextStatus = status.status?.trim();
    if (!messageId || !nextStatus) {
      return;
    }

    if (!['sent', 'delivered', 'read', 'failed'].includes(nextStatus)) {
      this.logger.debug(`Estado de WhatsApp ignorado: ${nextStatus} (${messageId})`);
      return;
    }

    const collectionSend = await this.collectionSendRepository.findOne({
      where: { whatsappMessageId: messageId },
    });

    if (!collectionSend) {
      this.logger.debug(`Estado de WhatsApp sin envío asociado: ${nextStatus} (${messageId})`);
      return;
    }

    const incomingAt = this.parseWhatsappTimestamp(status.timestamp);
    const currentRank = WHATSAPP_STATUS_RANK[collectionSend.whatsappStatus] ?? 0;
    const nextRank = WHATSAPP_STATUS_RANK[nextStatus] ?? 0;

    if (nextStatus === 'failed') {
      const current = collectionSend.whatsappStatus;
      if (current === 'delivered' || current === 'read') {
        return;
      }

      collectionSend.whatsappStatus = 'failed';
      collectionSend.whatsappStatusAt = incomingAt;
      collectionSend.whatsappError = this.whatsappStatusError(status);
      await this.collectionSendRepository.save(collectionSend);
      this.publishWhatsappStatus(collectionSend);
      this.logger.warn(
        `Envío ${collectionSend.id} marcado como fallido: ${collectionSend.whatsappError ?? 'sin detalle'}`,
      );
      return;
    }

    if (nextRank < currentRank) {
      return;
    }

    // Al crear el envío guardamos la hora local, que suele ser posterior al
    // timestamp en segundos de Meta. Un estado más avanzado (sent → delivered
    // → read) se acepta igual; la hora solo descarta repeticiones del mismo nivel.
    if (
      nextRank === currentRank &&
      collectionSend.whatsappStatusAt &&
      incomingAt.getTime() <= collectionSend.whatsappStatusAt.getTime()
    ) {
      return;
    }

    collectionSend.whatsappStatus = nextStatus;
    collectionSend.whatsappStatusAt = incomingAt;
    collectionSend.whatsappError = null;
    await this.collectionSendRepository.save(collectionSend);
    this.publishWhatsappStatus(collectionSend);
    this.logger.log(`Envío ${collectionSend.id} actualizado a ${nextStatus}`);
  }

  private publishWhatsappStatus(collectionSend: CollectionSend, collection?: Collection): void {
    const owner = collection ?? collectionSend.collection;
    if (!owner?.userId || !owner.clientId) {
      return;
    }

    this.whatsappStatusGateway.emitStatus({
      userId: owner.userId,
      clientId: owner.clientId,
      collectionId: collectionSend.collectionId,
      collectionSendId: collectionSend.id,
      whatsappStatus: collectionSend.whatsappStatus,
      whatsappStatusAt: collectionSend.whatsappStatusAt
        ? new Date(collectionSend.whatsappStatusAt).toISOString()
        : null,
      whatsappError: collectionSend.whatsappError ?? null,
    });
  }

  private parseWhatsappTimestamp(timestamp?: string): Date {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return new Date();
    }
    return new Date(seconds * 1000);
  }

  private whatsappStatusError(status: MetaWebhookStatus): string | null {
    const error = status.errors?.[0];
    if (!error) {
      return null;
    }
    return error.error_data?.details || error.message || error.title || null;
  }

  private extractIncomingMessages(payload: MetaWebhookPayload): ReceiveMessageDto[] {
    const results: ReceiveMessageDto[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== 'messages') {
          continue;
        }

        for (const message of change.value?.messages ?? []) {
          const normalized = this.normalizeMetaMessage(message);
          if (normalized) {
            results.push(normalized);
          }
        }
      }
    }

    return results;
  }

  private normalizeMetaMessage(message: MetaWebhookMessage): ReceiveMessageDto | null {
    const phoneNumber = message.from?.replace(/\D/g, '');
    if (!phoneNumber) {
      return null;
    }

    if (message.type === 'text' && message.text?.body?.trim()) {
      return {
        phoneNumber,
        message: message.text.body.trim(),
        messageId: message.id,
        mediaType: 'text',
      };
    }

    if (message.type === 'image' && message.image?.id) {
      return {
        phoneNumber,
        message: message.image.caption?.trim(),
        mediaId: message.image.id,
        mediaType: 'image',
        messageId: message.id,
      };
    }

    return {
      phoneNumber,
      message: message.type === 'text' ? message.text?.body?.trim() : undefined,
      mediaType: message.type ?? 'unknown',
      messageId: message.id,
    };
  }

  /**
   * Verifica los pagos pendientes de cada cuenta en una sola sesión de banco.
   * Si el ciclo anterior sigue abierto, este no arranca.
   */
  async verifyPendingPaymentsBatch(): Promise<number> {
    if (this.verificationCycleRunning) {
      this.logger.warn('Verificación bancaria ya en curso. Se omite este ciclo.');
      return 0;
    }

    this.verificationCycleRunning = true;
    try {
      const pendingPayments = await this.getPendingPayments();
      const groups = new Map<string, Payment[]>();

      for (const payment of pendingPayments) {
        const userId = payment.collectionSend?.collection?.user?.id;
        if (!userId) continue;
        const group = groups.get(userId) ?? [];
        group.push(payment);
        groups.set(userId, group);
      }

      let processed = 0;
      for (const payments of groups.values()) {
        processed += await this.verifyUserPaymentsInOneSession(payments);
      }

      this.logger.log(`${processed} pagos pendientes procesados en este ciclo`);
      return processed;
    } finally {
      this.verificationCycleRunning = false;
    }
  }

  /**
   * Verifica y confirma un pago
   */
  async verifyAndConfirmPayment(paymentId: string): Promise<void> {
    try {
      const payment = await this.paymentRepository.findOne({
        where: { id: paymentId },
        relations: {
          collectionSend: {
            collection: { user: true, client: true },
          },
        },
      });

      if (!payment) {
        throw new BadRequestException('Pago no encontrado');
      }

      const collectionSend = payment.collectionSend;
      if (!collectionSend) {
        payment.status = 'rejected';
        payment.notes = 'No se encontró un envío de cobranza asociado a este pago';
        await this.paymentRepository.save(payment);
        await this.notifyClientPaymentResult(
          payment,
          'No pudimos validar tu pago. Por favor ponte en contacto con tu vendedor.',
        );
        return;
      }

      const paymentAmount = Number(Number(payment.amount).toFixed(2));
      const expectedAmountBs = Number(Number(collectionSend.amountBs).toFixed(2));
      const difference = Number(Math.abs(paymentAmount - expectedAmountBs).toFixed(2));

      if (difference > 0.01) {
        await this.rejectPaymentForAmountMismatch(payment, paymentAmount, expectedAmountBs);
        return;
      }

      const user = collectionSend.collection?.user;
      if (!this.canVerifyUserBank(user)) {
        this.logger.warn(
          `Pago ${payment.id} omitido: el usuario no tiene credenciales bancarias válidas.`,
        );
        return;
      }

      const result = await this.bankAutomationService.verifyPaymentBDV({
        credentials: {
          username: user.bankUsername!.trim(),
          password: user.bankPassword!.trim(),
        },
        paymentData: {
          amount: payment.amount,
          reference: payment.referenceNumber?.slice(-6) ?? '',
        },
      });

      if (result?.passwordExpired) {
        await this.pausePaymentsForExpiredBankPassword(user, [payment]);
        return;
      }

      if (result?.invalidCredentials) {
        await this.pausePaymentsForInvalidBankCredentials(user, [payment]);
        return;
      }

      await this.applyBankVerificationResult(payment, result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error verificando pago: ${message}`);
      throw error;
    }
  }

  private async verifyUserPaymentsInOneSession(payments: Payment[]): Promise<number> {
    const ready: Payment[] = [];

    for (const payment of payments) {
      if (await this.paymentIsReadyForBank(payment)) {
        ready.push(payment);
      }
    }

    if (ready.length === 0) {
      return payments.length;
    }

    const user = ready[0].collectionSend.collection.user;
    this.logger.log(
      `Verificando ${ready.length} pago(s) del usuario ${user.id} en una sola sesión bancaria.`,
    );

    const results = await this.bankAutomationService.verifyPaymentsBDV({
      credentials: {
        username: user.bankUsername!.trim(),
        password: user.bankPassword!.trim(),
      },
      payments: ready.map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        reference: payment.referenceNumber?.slice(-6) ?? '',
      })),
    });
    const resultById = new Map(results.map((result) => [result.id, result]));

    if (results.some((result) => result.passwordExpired)) {
      await this.pausePaymentsForExpiredBankPassword(user, ready);
      return payments.length;
    }

    if (results.some((result) => result.invalidCredentials)) {
      await this.pausePaymentsForInvalidBankCredentials(user, ready);
      return payments.length;
    }

    for (const payment of ready) {
      const result = resultById.get(payment.id) ?? {
        error: 'La verificación no devolvió resultado para este pago.',
        isTechnicalError: true,
        movementIsCorrect: false,
      };
      await this.applyBankVerificationResult(payment, result);
    }

    return payments.length;
  }

  /** Rechaza el pago si no se puede consultar, o lo deja listo para la sesión del banco. */
  private async paymentIsReadyForBank(payment: Payment): Promise<boolean> {
    const collectionSend = payment.collectionSend;
    if (!collectionSend) {
      payment.status = 'rejected';
      payment.notes = 'No se encontró un envío de cobranza asociado a este pago';
      await this.paymentRepository.save(payment);
      return false;
    }

    const paymentAmount = Number(Number(payment.amount).toFixed(2));
    const expectedAmountBs = Number(Number(collectionSend.amountBs).toFixed(2));
    const difference = Number(Math.abs(paymentAmount - expectedAmountBs).toFixed(2));

    if (difference > 0.01) {
      await this.rejectPaymentForAmountMismatch(payment, paymentAmount, expectedAmountBs);
      return false;
    }

    return this.canVerifyUserBank(collectionSend.collection?.user);
  }

  private async pausePaymentsForExpiredBankPassword(user: User, payments: Payment[]): Promise<void> {
    if (user.id) {
      await this.usersService.markBankCredentialsInvalid(user.id);
    }

    for (const payment of payments) {
      payment.notes = 'Verificación en pausa: la contraseña del banco está vencida';
      await this.paymentRepository.save(payment);
    }

    await this.mailService.sendAdminAlert(
      `CobroFacil: contraseña bancaria vencida — ${user.email}`,
      `El usuario con correo ${user.email} tiene la contraseña vencida.`,
    );
    this.logger.warn(
      `Contraseña bancaria vencida para el usuario ${user.email}. ${payments.length} pago(s) en pausa.`,
    );
  }

  private async pausePaymentsForInvalidBankCredentials(user: User, payments: Payment[]): Promise<void> {
    if (user.id) {
      await this.usersService.markBankCredentialsInvalid(user.id);
    }

    for (const payment of payments) {
      payment.notes = 'Verificación en pausa: credenciales bancarias inválidas';
      await this.paymentRepository.save(payment);
    }

    await this.notifySellerInvalidBankCredentials(user);
    this.logger.warn(
      `Credenciales bancarias inválidas para el usuario ${user.id}. ${payments.length} pago(s) en pausa.`,
    );
  }

  private async applyBankVerificationResult(
    payment: Payment,
    result: {
      error: string;
      isTechnicalError: boolean;
      movementIsCorrect: boolean;
      movements?: { reference: string; amount: string }[];
    },
  ): Promise<void> {
    const collectionSend = payment.collectionSend;
    const attempts = (payment.verificationAttempts ?? 0) + 1;
    payment.verificationAttempts = attempts;

    if (result.isTechnicalError) {
      if (attempts >= MAX_BANK_VERIFICATION_ATTEMPTS) {
        payment.status = 'rejected';
        payment.nextVerificationAt = null;
        payment.notes = `No se pudo consultar el banco tras ${attempts} intentos: ${result.error}`;
        await this.paymentRepository.save(payment);
        await this.notifyClientPaymentResult(
          payment,
          'No pudimos consultar el banco para validar tu pago. Por favor ponte en contacto con tu vendedor.',
        );
        return;
      }

      payment.status = 'pending';
      payment.nextVerificationAt = null;
      payment.notes = `Error técnico (${attempts}/${MAX_BANK_VERIFICATION_ATTEMPTS}): ${result.error}`;
      await this.paymentRepository.save(payment);
      this.logger.warn(
        `Error técnico verificando pago ${payment.id}. Intento ${attempts}/${MAX_BANK_VERIFICATION_ATTEMPTS}.`,
      );

      if (attempts === 4) {
        try {
          await this.notifyClientPaymentResult(
            payment,
            'La conexión con el banco está tardando. Seguimos verificando tu pago y te avisamos en cuanto tengamos el resultado.',
          );
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `No se pudo avisar la demora del banco para el pago ${payment.id}: ${message}`,
          );
        }
      }
      return;
    }

    if (!result.movementIsCorrect) {
      const feedback = this.bankRejectionFeedback(payment, result.movements);
      payment.status = 'rejected';
      payment.nextVerificationAt = null;
      payment.notes = feedback.notes;
      await this.notifyClientPaymentResult(payment, feedback.message);
    } else {
      payment.status = 'verified';
      payment.verifiedAt = new Date();
      payment.nextVerificationAt = null;

      await this.updateCollectionPayment(
        collectionSend.collection.id,
        payment.installmentNumber,
        Number(collectionSend.amountUsd),
      );
      await this.notifyClientPaymentResult(
        payment,
        'Tu pago fue verificado exitosamente. ¡Gracias!',
      );
      await this.notifyUserPaymentReceived(payment);
      this.logger.log(`Pago verificado: ${payment.referenceNumber}`);
    }

    await this.paymentRepository.save(payment);
  }

  private async notifyUserPaymentReceived(payment: Payment): Promise<void> {
    const collection = payment.collectionSend?.collection;
    const client = collection?.client;
    const user = collection?.user;
    const phone = this.normalizeUserPhone(user?.phoneNumber);

    if (!phone) {
      this.logger.warn(
        `Pago ${payment.id} verificado, pero el usuario ${user?.id ?? 'desconocido'} no tiene teléfono para la plantilla received_payment.`,
      );
      return;
    }

    const clientName = `${client?.firstName ?? ''} ${client?.lastName ?? ''}`.trim() || 'Cliente';
    const amountUsd = Number(payment.collectionSend.amountUsd);
    const amountBs = Number(payment.collectionSend.amountBs);

    try {
      await this.whatsappService.sendTemplateMessage({
        to: phone,
        templateName: TEMPLATE_NAME_RECEIVED_PAYMENT,
        languageCode: 'es',
        bodyParameters: {
          client_name: clientName,
          amount: `${amountUsd.toFixed(2)}`,
          amount_bs: `${amountBs.toFixed(2)}`,
          payment_description: collection?.concept?.trim() || 'Pago pendiente',
          installment: String(payment.installmentNumber),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `No se pudo avisar al usuario ${user?.id ?? ''} del pago ${payment.id}: ${message}`,
      );
    }
  }

  private normalizeUserPhone(phone?: string | null): string {
    const digits = phone?.replace(/\D/g, '') ?? '';
    if (!digits) return '';
    if (digits.startsWith('0')) return `58${digits.replace(/^0+/, '')}`;
    if (!digits.startsWith('58') && digits.length <= 10) return `58${digits}`;
    return digits;
  }

  private async rejectPaymentForAmountMismatch(
    payment: Payment,
    paymentAmount: number,
    expectedAmountBs: number,
  ): Promise<void> {
    payment.status = 'rejected';
    payment.notes = `El monto del pago (${paymentAmount}) no coincide con el monto cobrado (${expectedAmountBs} Bs)`;
    await this.paymentRepository.save(payment);
    await this.notifyClientPaymentResult(
      payment,
      `No pudimos validar tu pago porque el monto del capture es ${this.formatBs(paymentAmount)} y la cuota que debes pagar es ${this.formatBs(expectedAmountBs)}.\n\nRevisa el pago y envía el capture correcto, o ponte en contacto con tu vendedor.`,
    );
  }

  private bankRejectionFeedback(
    payment: Payment,
    movements: { reference: string; amount: string }[] | undefined,
  ): { message: string; notes: string } {
    const searched = payment.referenceNumber?.slice(-6) ?? '';
    const reference = payment.referenceNumber?.trim() || searched || 'indicada';
    const expected = Number(payment.collectionSend?.amountBs ?? payment.amount);
    const related = (movements ?? []).filter(
      (movement) => searched && movement.reference.includes(searched),
    );

    if (related.length === 0) {
      return {
        notes: `No se encontró en el banco un movimiento con la referencia ${reference}`,
        message: `No pudimos validar tu pago. No encontramos en el banco un movimiento con la referencia ${reference}.\n\nRevisa que la captura corresponda a este pago, o ponte en contacto con tu vendedor.`,
      };
    }

    const amounts = [
      ...new Set(
        related
          .map((movement) => extractAmountFromText(movement.amount))
          .filter((amount): amount is number => amount !== null)
          .map((amount) => amount.toFixed(2)),
      ),
    ];
    const amountMatches = amounts.some(
      (amount) => Math.abs(Number(amount) - expected) <= 0.01,
    );

    if (amounts.length === 0 || amountMatches) {
      return {
        notes: `La referencia ${reference} aparece en el banco, pero no se pudo confirmar el movimiento`,
        message:
          'No pudimos confirmar el movimiento de tu pago en el banco. Por favor ponte en contacto con tu vendedor.',
      };
    }

    const found = amounts.map((amount) => this.formatBs(Number(amount))).join(' y ');
    return {
      notes: `La referencia ${reference} está en el banco por ${found}, pero la cuota es ${this.formatBs(expected)}`,
      message: `No pudimos validar tu pago. En el banco la referencia ${reference} aparece por ${found}, pero la cuota que debes pagar es ${this.formatBs(expected)}.\n\nRevisa el pago o ponte en contacto con tu vendedor.`,
    };
  }

  private formatBs(amount: number): string {
    return `${Number(amount).toFixed(2)} Bs.`;
  }

  private async notifyClientPaymentResult(payment: Payment, message: string): Promise<void> {
    const client = payment.collectionSend.collection.client;
    const clientPhone = `${client.countryCode ?? ''}${client.phoneCode}${client.phoneNumber}`;
    await this.whatsappService.sendTextMessage(clientPhone, message);
  }

  private canVerifyUserBank(user?: User | null): user is User {
    return Boolean(
      user?.validBankCredentials &&
        user.bankUsername?.trim() &&
        user.bankPassword?.trim(),
    );
  }

  private async notifySellerInvalidBankCredentials(user: User): Promise<void> {
    await this.mailService.sendAdminAlert(
      `CobroFacil: credenciales bancarias inválidas — ${user.email}`,
      [
        'Un usuario tiene credenciales bancarias inválidas.',
        '',
        `Usuario ID: ${user.id}`,
        `Email: ${user.email}`,
        `Teléfono: ${user.phoneNumber?.trim() || 'No registrado'}`,
        `Usuario banco: ${user.bankUsername?.trim() || 'N/A'}`,
        '',
        'Los pagos de este usuario quedarán en pausa hasta que actualice sus credenciales en la app.',
      ].join('\n'),
    );

    // Notificación directa al usuario por WhatsApp (texto libre): no funciona fuera de la
    // ventana de 24h sin plantilla. Dejado comentado hasta tener un template aprobado.
    // const phone = user.phoneNumber?.trim();
    // if (!phone) {
    //   this.logger.warn(
    //     `Usuario ${user.id} con credenciales bancarias inválidas, pero no tiene teléfono para notificar.`,
    //   );
    //   return;
    // }
    //
    // try {
    //   await this.whatsappService.sendTextMessage(
    //     phone,
    //     'Tus credenciales bancarias son inválidas. Debes cambiarlas para poder validar los pagos que recibas.',
    //   );
    // } catch (error: unknown) {
    //   const message = error instanceof Error ? error.message : String(error);
    //   this.logger.error(
    //     `No se pudo notificar al usuario ${user.id} que sus credenciales bancarias son inválidas: ${message}`,
    //   );
    // }
  }

  /**
   * Obtiene los pagos pendientes. Cada ejecución del cron los vuelve a intentar.
   */
  async getPendingPayments(): Promise<Payment[]> {
    const payments = await this.paymentRepository.find({
      where: {
        status: 'pending',
      },
      relations: {
        collectionSend: {
          collection: { client: true, user: true },
        },
      },
      order: { createdAt: 'ASC' },
    });

    return payments.filter((payment) => this.canVerifyUserBank(payment.collectionSend?.collection?.user));
  }

  /**
   * Por la tarde, recuerda el cobro de hoy si todavía no llegó un comprobante.
   */
  async sendAfternoonFollowups(): Promise<number> {
    if (!TEMPLATE_NAME_AFTERNOON_FOLLOWUP) {
      this.logger.warn('Recordatorio de la tarde omitido: falta el nombre de la plantilla.');
      return 0;
    }

    const sends = await this.findChargeSendsOnCaracasDay(0);
    let sent = 0;

    for (const send of sends) {
      if (send.afternoonFollowupSentAt || this.sendHasReceipt(send) || this.chargeIsSettled(send)) {
        continue;
      }

      const phoneNumber = this.clientPhone(send.collection);
      if (!phoneNumber) {
        this.logger.warn(`Cobranza ${send.collectionId} sin teléfono para el recordatorio de la tarde.`);
        continue;
      }

      try {
        const client = send.collection.client;
        await this.whatsappService.sendTemplateMessage({
          to: phoneNumber,
          templateName: TEMPLATE_NAME_AFTERNOON_FOLLOWUP,
          bodyParameters: {
            client_name: `${client.firstName} ${client.lastName}`.trim(),
            amount: `${Number(send.amountUsd).toFixed(2)}$`,
            amount_bs: `${Number(send.amountBs).toFixed(2)} Bs.`,
          },
          languageCode: 'en',
        });
        await this.collectionSendRepository.update(send.id, { afternoonFollowupSentAt: new Date() });
        sent += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error en recordatorio de la tarde para envío ${send.id}: ${message}`);
      }
    }

    return sent;
  }

  /**
   * Reenvía el cobro al día siguiente y a los dos días si sigue sin comprobante.
   */
  async sendNextDayFollowups(): Promise<number> {
    if (!TEMPLATE_NAME_NEXT_DAY_FOLLOWUP) {
      this.logger.warn('Recobro omitido: falta el nombre de la plantilla.');
      return 0;
    }

    const nextDay = await this.sendChargeFollowup(-1, 'nextDayFollowupSentAt', 'del día siguiente');
    const twoDays = await this.sendChargeFollowup(-2, 'twoDayFollowupSentAt', 'de los dos días');
    return nextDay + twoDays;
  }

  private async sendChargeFollowup(
    dayOffset: number,
    sentAtField: 'nextDayFollowupSentAt' | 'twoDayFollowupSentAt',
    label: string,
  ): Promise<number> {
    const sends = await this.findChargeSendsOnCaracasDay(dayOffset);
    let sent = 0;
    let currencyRate: number;
    try {
      currencyRate = await this.currencyRatesService.getCurrentRate('USD');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Recobro ${label} omitido: no se pudo obtener la tasa del día. ${message}`);
      return 0;
    }

    for (const send of sends) {
      if (send[sentAtField] || this.sendHasReceipt(send) || this.chargeIsSettled(send)) {
        continue;
      }

      const collection = send.collection;
      const phoneNumber = this.clientPhone(collection);
      if (!phoneNumber) {
        this.logger.warn(`Cobranza ${send.collectionId} sin teléfono para el recobro ${label}.`);
        continue;
      }

      const amountUsd = Number(send.amountUsd);
      const amountBs = Number((amountUsd * currencyRate).toFixed(2));

      try {
        const bodyParameters = this.buildBodyParameters(
          collection,
          TEMPLATE_NAME_NEXT_DAY_FOLLOWUP,
          0,
          amountUsd,
          amountBs,
          send.installmentNumber,
        );
        await this.whatsappService.sendTemplateMessage({
          to: phoneNumber,
          templateName: TEMPLATE_NAME_NEXT_DAY_FOLLOWUP,
          bodyParameters,
        });
        await this.collectionSendRepository.update(send.id, {
          [sentAtField]: new Date(),
          amountBs,
        });
        sent += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error en recobro ${label} para envío ${send.id}: ${message}`);
      }
    }

    return sent;
  }

  /**
   * Obtiene colecciones que necesitan recordatorios
   */
  async getCollectionsNeedingReminders(daysOffset: number): Promise<Collection[]> {
    return this.collectionsService.getCollectionsDueInDays(daysOffset);
  }

  /**
   * Envía recordatorios automáticos a todas las colecciones que vencen en X días
   */
  async sendAutomaticReminders(daysOffset: number): Promise<number> {
    try {
      const collections = await this.getCollectionsNeedingReminders(daysOffset);
      for (const collection of collections) {
        try {
          await this.sendReminder({
            collectionId: collection.id,
            daysUntilPayment: daysOffset,
            phoneNumber: `${collection.client.countryCode}${collection.client.phoneCode}${collection.client.phoneNumber}`,
          });
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error enviando recordatorio para ${collection.id}: ${errorMsg}`);
        }
      }

      return collections.length;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error en sendAutomaticReminders: ${errorMsg}`);
      return 0;
    }
  }

  // ==================== HELPERS ====================

  /**
   * Busca la última CollectionSend enviada cuya Collection pertenece
   * al cliente identificado por countryCode + phoneCode + phoneNumber.
   */
  private async findLatestCollectionSendByPhoneNumber(
    phoneNumber: string,
  ): Promise<CollectionSend | null> {
    const cleanedPhone = phoneNumber.replace(/\D/g, '');

    const collectionSend = await this.collectionSendRepository
      .createQueryBuilder('cs')
      .innerJoinAndSelect('cs.collection', 'collection')
      .innerJoinAndSelect('collection.client', 'client')
      .where(
        "CONCAT(COALESCE(client.countryCode, ''), client.phoneCode, client.phoneNumber) = :phone",
        { phone: cleanedPhone },
      )
      .orderBy('cs.sentAt', 'DESC')
      .getOne();

    return collectionSend || null;
  }

  private async createPaymentRecord(dto: ProcessPaymentDto): Promise<Payment> {
    const collectionSend = await this.collectionSendRepository.findOne({
      where: { id: dto.collectionSendId },
      relations: { collection: { client: true } },
    });

    if (!collectionSend) {
      throw new BadRequestException('Envío de cobranza no encontrado');
    }

    const payment = this.paymentRepository.create({
      collectionSendId: collectionSend.id,
      collectionSend,
      amount: dto.amount,
      installmentNumber: dto.installmentNumber,
      referenceNumber: dto.referenceNumber ?? null,
      screenshotUrl: dto.screenshotUrl || null,
      status: 'pending',
      notes: null,
      verificationAttempts: 0,
      nextVerificationAt: null,
    });

    return this.paymentRepository.save(payment);
  }

  private async updateCollectionPayment(
    collectionId: string,
    installmentNumber: number,
    amountPaid: number,
  ): Promise<void> {
    const collection = await this.collectionRepository.findOne({
      where: { id: collectionId },
    });

    if (collection) {
      collection.currentInstallment = installmentNumber + 1;
      collection.currentDebt = Math.max(0, collection.currentDebt - amountPaid);
      await this.collectionRepository.save(collection);
    }
  }

  private usesPaymentDateParameters(templateName: string): boolean {
    return (
      templateName === TEMPLATE_NAME_PAYMENT_REMINDER ||
      templateName === TEMPLATE_NAME_NEXT_DAY_FOLLOWUP
    );
  }

  private buildReminderMessage(collection: Collection, type: 'payment_reminder' | 'payment_due'): string {
    const clientName = collection.client.firstName;
    const amount = collection.currentDebt.toFixed(2);
    const concept = collection.concept || 'Pago pendiente';

    if (type === 'payment_reminder') {
      return `Hola ${clientName}, recordatorio: en 2 días vence tu cuota de ${amount}Bs. Concepto: ${concept}.`;
    } else {
      return `Hola ${clientName}, tu cuota de ${amount}Bs. vence hoy. Concepto: ${concept}. Favor enviar el capture del pago.`;
    }
  }

  private caracasDayBounds(dayOffset: number): { start: Date; end: Date } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    const day = Number(parts.find((part) => part.type === 'day')?.value);
    const start = new Date(Date.UTC(year, month - 1, day + dayOffset, 4, 0, 0, 0));
    const end = new Date(Date.UTC(year, month - 1, day + dayOffset + 1, 4, 0, 0, 0));
    return { start, end };
  }

  private async findChargeSendsOnCaracasDay(dayOffset: number): Promise<CollectionSend[]> {
    const { start, end } = this.caracasDayBounds(dayOffset);
    return this.collectionSendRepository
      .createQueryBuilder('cs')
      .innerJoinAndSelect('cs.collection', 'collection')
      .innerJoinAndSelect('collection.client', 'client')
      .innerJoinAndSelect('collection.user', 'user')
      .leftJoinAndSelect('cs.payments', 'payment')
      .where('cs.sentAt >= :start AND cs.sentAt < :end', { start, end })
      .andWhere("(cs.whatsappStatus IS NULL OR cs.whatsappStatus <> 'failed')")
      .getMany();
  }

  private sendHasReceipt(send: CollectionSend): boolean {
    return (send.payments ?? []).some((payment) => Boolean(payment.screenshotUrl?.trim()));
  }

  private chargeIsSettled(send: CollectionSend): boolean {
    const collection = send.collection;
    return Number(collection.currentDebt) <= 0 || collection.currentInstallment > send.installmentNumber;
  }

  private clientPhone(collection: Collection): string | null {
    const client = collection.client;
    if (!client?.phoneCode?.trim() || !client.phoneNumber?.trim()) {
      return null;
    }
    return `${client.countryCode ?? ''}${client.phoneCode}${client.phoneNumber}`;
  }

  private buildBodyParameters(
    collection: Collection,
    templateName: TemplateName,
    daysUntilPayment: number,
    amountUsd: number,
    amountBs: number,
    installmentNumber: number,
  ): Record<string, string> {
    const currentDate = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const clientName = `${collection.client.firstName} ${collection.client.lastName}`;
    const paymentDescription = collection.concept || 'Pago pendiente';

    if (this.usesPaymentDateParameters(templateName)) {
      const companyName = collection.user?.companyName?.trim() ?? '';
      const paymentDocument = collection.user?.paymentDocument?.trim() ?? '';
      const paymentPhoneNumber = collection.user?.paymentPhoneNumber?.trim() ?? '';
      const paymentBankName = collection.user?.paymentBank
        ? PAYMENT_BANK_LABELS[collection.user.paymentBank]
        : '';

      if (!companyName || !paymentDocument || !paymentPhoneNumber || !paymentBankName) {
        throw new BadRequestException(
          'Configura el nombre de la empresa y los datos de pago antes de enviar el cobro.',
        );
      }

      const parameters: Record<string, string> = {
        client_name: clientName,
        amount: amountUsd.toFixed(2) + '$',
        payment_description: paymentDescription,
        amount_bs: amountBs.toFixed(2) + ' Bs.',
        installment: installmentNumber.toString(),
        company_name: companyName,
        payment_document: paymentDocument,
        payment_phone_number: paymentPhoneNumber,
        payment_bank_name: paymentBankName,
      };

      if (templateName === TEMPLATE_NAME_PAYMENT_REMINDER) {
        parameters.current_date = currentDate;
      }

      return parameters;
    }

    const paymentDate = new Date(new Date().setDate(new Date().getDate() + daysUntilPayment)).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    return {
      client_name: clientName,
      payment_date: paymentDate,
      amount: amountUsd.toFixed(2),
      payment_description: paymentDescription,
    };
  }
}
