import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { CollectionSend } from './entities/collection-send.entity';
import { SendReminderDto } from './dto/send-reminder.dto';
import { ReceiveMessageDto } from './dto/receive-message.dto';
import { MetaWebhookPayload } from './dto/meta-webhook.dto';
import type { MetaWebhookMessage } from './dto/meta-webhook.dto';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { Collection } from '../collections/entities/collection.entity';
import { BankAutomationService, VerifyPaymentBancoDeVenezuelaRequest, VerifyPaymentRequest } from '../bank-automation/bank-automation.service';
import { OpenaiExtractionService } from '../openai-extraction/openai-extraction.service';
import { CollectionsService } from '../collections/collections.service';
import { CurrencyRatesService } from '../currency-rates/currency-rates.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

const BANK_VERIFICATION_RETRY_MINUTES = 10;
const MAX_BANK_VERIFICATION_ATTEMPTS = 3;
@Injectable()
export class WhatsappBotService {
  private readonly logger = new Logger(WhatsappBotService.name);

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
  ) {}

  /**
   * Envía un mensaje de recordatorio de cobranza
   */
  async sendReminder(dto: SendReminderDto): Promise<void> {
    try {
      const collection = await this.collectionRepository.findOne({
        where: { id: dto.collectionId },
        relations: { client: true },
      });

      if (!collection) {
        throw new BadRequestException('Collection not found');
      }

      const currency = 'USD';
      const currencyRate = await this.currencyRatesService.getCurrentRate(currency);
      const amountUsd = Number((collection.totalDebt / collection.installments).toFixed(2));
      const amountBs = Number((amountUsd * currencyRate).toFixed(2));

      const templateName = dto.daysUntilPayment === 0 ? 'is_payment_date' : 'two_days_for_payme_day';
      const bodyParameters = this.buildBodyParameters(
        collection,
        templateName,
        dto.daysUntilPayment,
        amountUsd,
      );

      await this.whatsappService.sendTemplateMessage({
        to: dto.phoneNumber,
        templateName,
        bodyParameters,
      });

      // Solo registrar el envío el día de cobro (no el recordatorio de 2 días antes)
      if (dto.daysUntilPayment === 0) {
        await this.collectionSendRepository.save(
          this.collectionSendRepository.create({
            collectionId: collection.id,
            collection,
            sentAt: new Date(),
            amountUsd,
            amountBs,
            currencyRate,
            currency,
            installmentNumber: collection.currentInstallment,
          }),
        );
      }
    } catch (error: unknown) {
      console.log(`sendReminder error: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error enviando recordatorio: ${message}`);
      throw error;
    }
  }

  /**
   * Procesa el payload real del webhook de Meta
   */
  async handleMetaWebhook(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') {
      this.logger.debug(`Webhook ignorado: object=${payload.object ?? 'undefined'}`);
      return;
    }

    const messages = this.extractIncomingMessages(payload);
    if (messages.length === 0) {
      this.logger.debug('Webhook de Meta sin mensajes entrantes (posible status update).');
      return;
    }

    for (const message of messages) {
      await this.handleIncomingMessage(message);
    }
  }

  /**
   * Procesa un mensaje entrante de WhatsApp
   */
  async handleIncomingMessage(dto: ReceiveMessageDto): Promise<void> {
    try {
      this.logger.log(
        `Mensaje recibido de ${dto.phoneNumber} (type=${dto.mediaType ?? 'text'}, id=${dto.messageId ?? 'n/a'})`,
      );

      if (dto.mediaType === 'image' && (dto.mediaId || dto.mediaUrl)) {
        await this.processPaymentFromScreenshot(dto.phoneNumber, {
          mediaId: dto.mediaId,
          mediaUrl: dto.mediaUrl,
        });
      } else if (dto.message) {
        await this.processPaymentFromReference(dto.phoneNumber, dto.message);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando mensaje entrante: ${message}`);
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
      let screenshotUrl: string | null = media.mediaUrl ?? null;

      if (media.mediaId) {
        const downloaded = await this.whatsappService.downloadMedia(media.mediaId);
        imageBuffer = downloaded.buffer;
        mimeType = downloaded.mimeType;
        screenshotUrl = media.mediaId;
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

      await this.createPaymentRecord({
        collectionSendId: collectionSend.id,
        referenceNumber: extractedData.reference,
        screenshotUrl: screenshotUrl ?? undefined,
        amount: extractedData.amount,
        installmentNumber: collectionSend.installmentNumber,
      });

      await this.whatsappService.sendTextMessage(
        phoneNumber,
        'Su pago se está verificando, le avisamos cuando lo hayamos validado.',
      );

      this.logger.log(`Pago registrado para verificación: ${extractedData.reference}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando screenshot: ${message}`);

      try {
        await this.whatsappService.sendTextMessage(
          phoneNumber,
          'Hubo un error al procesar su pago. Por favor reenvíe la captura o el número de referencia.',
        );
      } catch (notifyError: unknown) {
        const notifyMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
        this.logger.error(`Error notificando fallo de screenshot: ${notifyMessage}`);
      }

      throw error;
    }
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

    this.logger.debug(`Mensaje de Meta ignorado: type=${message.type ?? 'unknown'}`);
    return null;
  }

  /**
   * Procesa un pago desde una referencia de texto
   */
  private async processPaymentFromReference(phoneNumber: string, reference: string): Promise<void> {
    try {
      const collectionSend = await this.findLatestCollectionSendByPhoneNumber(phoneNumber);
      if (!collectionSend) {
        throw new BadRequestException('No se encontró un envío de cobranza asociado');
      }

      await this.createPaymentRecord({
        collectionSendId: collectionSend.id,
        referenceNumber: reference.trim(),
        amount: Number(collectionSend.amountBs),
        installmentNumber: collectionSend.installmentNumber,
      });

      await this.whatsappService.sendTextMessage(
        phoneNumber,
        'Su pago se está verificando, le avisamos cuando lo hayamos validado.',
      );

      this.logger.log(`Pago registrado para verificación: ${reference}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando referencia: ${message}`);

      try {
        await this.whatsappService.sendTextMessage(
          phoneNumber,
          'Hubo un error al procesar su pago. Por favor reenvíe la captura o el número de referencia.',
        );
      } catch (notifyError: unknown) {
        const notifyMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
        this.logger.error(`Error notificando fallo de referencia: ${notifyMessage}`);
      }

      throw error;
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
        throw new BadRequestException('Payment not found');
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
        payment.status = 'rejected';
        payment.notes = `El monto del pago (${paymentAmount}) no coincide con el monto cobrado (${expectedAmountBs} Bs)`;
        await this.paymentRepository.save(payment);
        await this.notifyClientPaymentResult(
          payment,
          'No pudimos validar tu pago. Por favor ponte en contacto con tu vendedor.',
        );
        return;
      }

      const bankUsername = collectionSend.collection?.user?.bankUsername?.trim();
      const bankPassword = collectionSend.collection?.user?.bankPassword?.trim();

      if (!bankUsername || !bankPassword) {
        throw new BadRequestException('Bank credentials not found for the collection user.');
      }

      const verifyPayload: VerifyPaymentBancoDeVenezuelaRequest = {
        credentials: {
          username: bankUsername,
          password: bankPassword,
        },
        paymentData: {
          amount: payment.amount,
          reference: payment.referenceNumber?.slice(-6) ?? '',
        },
      };
      const result = await this.bankAutomationService.verifyPaymentBDV(verifyPayload);
      const attempts = (payment.verificationAttempts ?? 0) + 1;
      payment.verificationAttempts = attempts;

      // Error técnico del banco (timeout, página no carga, etc.): reintentar más tarde
      if (result?.isTechnicalError) {
        if (attempts >= MAX_BANK_VERIFICATION_ATTEMPTS) {
          payment.status = 'rejected';
          payment.nextVerificationAt = null;
          payment.notes = `No se pudo consultar el banco tras ${attempts} intentos: ${result.error}`;
          await this.paymentRepository.save(payment);
          await this.notifyClientPaymentResult(
            payment,
            'No pudimos validar tu pago. Por favor ponte en contacto con tu vendedor.',
          );
          return;
        }

        payment.status = 'pending';
        payment.nextVerificationAt = new Date(
          Date.now() + attempts * BANK_VERIFICATION_RETRY_MINUTES * 60 * 1000,
        );
        payment.notes = `Reintento programado (${attempts}/${MAX_BANK_VERIFICATION_ATTEMPTS}): ${result.error}`;
        await this.paymentRepository.save(payment);
        this.logger.warn(
          `Error técnico verificando pago ${payment.id}. Reintento #${attempts} en ${BANK_VERIFICATION_RETRY_MINUTES} min.`,
        );
        return;
      }

      const isVerified = result?.movementIsCorrect ?? false;

      if (!isVerified) {
        // Banco respondió bien pero el movimiento no existe / no coincide: no reintentar
        console.log('Payment not verified');
        payment.status = 'rejected';
        payment.nextVerificationAt = null;
        payment.notes = 'No se pudo validar el pago en el banco';

        await this.notifyClientPaymentResult(
          payment,
          'No pudimos validar tu pago. Por favor ponte en contacto con tu vendedor.',
        );
      } else {
        console.log('Payment verified');
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

        this.logger.log(`Pago verificado: ${payment.referenceNumber}`);
      }

      await this.paymentRepository.save(payment);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error verificando pago: ${message}`);
      throw error;
    }
  }

  private async notifyClientPaymentResult(payment: Payment, message: string): Promise<void> {
    const client = payment.collectionSend.collection.client;
    const clientPhone = `${client.countryCode ?? ''}${client.phoneCode}${client.phoneNumber}`;
    await this.whatsappService.sendTextMessage(clientPhone, message);
  }

  /**
   * Obtiene pagos pendientes listos para verificación
   * (sin reintento programado, o ya venció el tiempo de espera).
   */
  async getPendingPayments(): Promise<Payment[]> {
    const now = new Date();

    return this.paymentRepository.find({
      where: [
        {
          status: 'pending',
          nextVerificationAt: IsNull(),
        },
        {
          status: 'pending',
          nextVerificationAt: LessThanOrEqual(now),
        },
      ],
      relations: {
        collectionSend: {
          collection: { client: true, user: true },
        },
      },
      order: { createdAt: 'ASC' },
    });
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
            phoneNumber: `58${collection.client.phoneCode}${collection.client.phoneNumber}`,
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
      throw new BadRequestException('Collection send not found');
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

  private buildReminderMessage(collection: Collection, type: 'payment_reminder' | 'payment_due'): string {
    const clientName = collection.client.firstName;
    const amount = collection.currentDebt.toFixed(2);
    const concept = collection.concept || 'Pago pendiente';

    if (type === 'payment_reminder') {
      return `Hola ${clientName}, recordatorio: en 2 días vence tu cuota de ${amount}Bs. Concepto: ${concept}.`;
    } else {
      return `Hola ${clientName}, tu cuota de ${amount}Bs. vence hoy. Concepto: ${concept}. Favor enviar comprobante.`;
    }
  }

  private buildBodyParameters(
    collection: Collection,
    templateName: 'is_payment_date' | 'two_days_for_payme_day',
    daysUntilPayment: number,
    amountUsd: number,
  ): Record<string, string> {
    const currentDate = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const clientName = `${collection.client.firstName} ${collection.client.lastName}`;
    const paymentDescription = collection.concept || 'Pago pendiente';

    if (templateName === 'is_payment_date') {
      return {
        client_name: clientName,
        current_date: currentDate,
        amount: amountUsd.toFixed(2) + '$',
        payment_description: paymentDescription,
      };
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
