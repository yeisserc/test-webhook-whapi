import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { CollectionSend } from './entities/collection-send.entity';
import { SendReminderDto } from './dto/send-reminder.dto';
import { ReceiveMessageDto } from './dto/receive-message.dto';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { Collection } from '../collections/entities/collection.entity';
import { BankAutomationService, VerifyPaymentBancoDeVenezuelaRequest, VerifyPaymentRequest } from '../bank-automation/bank-automation.service';
import { OpenaiExtractionService } from '../openai-extraction/openai-extraction.service';
import { CollectionsService } from '../collections/collections.service';
import { CurrencyRatesService } from '../currency-rates/currency-rates.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

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
   * Procesa un mensaje entrante de WhatsApp
   */
  async handleIncomingMessage(dto: ReceiveMessageDto): Promise<void> {
    try {
      // Si hay media (screenshot o documento), procesar el pago
      if (dto.mediaUrl && dto.mediaType === 'image') {
        await this.processPaymentFromScreenshot(dto.phoneNumber, dto.mediaUrl);
      } else if (dto.message) {
        // Si hay solo texto, buscar referencia o número de referencia
        await this.processPaymentFromReference(dto.phoneNumber, dto.message);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando mensaje entrante: ${message}`);
      // TODO: Enviar mensaje de error al cliente
    }
  }

  /**
   * Procesa un pago desde un screenshot
   */
  private async processPaymentFromScreenshot(phoneNumber: string, screenshotUrl: string): Promise<void> {
    try {
      // Extraer datos del screenshot usando OpenAI
      // Descargamos la imagen desde la URL y la pasamos como Buffer
      const imageResponse = await fetch(screenshotUrl);
      const arrayBuffer = await imageResponse.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      const extractedData = await this.openaiExtractionService.extractTransferDataFromImage(imageBuffer, mimeType);

      if (!extractedData || !extractedData.amount || !extractedData.reference) {
        throw new BadRequestException('No se pudo extraer los datos del comprobante');
      }

      // Encontrar la colección correspondiente por teléfono
      const collection = await this.findCollectionByPhoneNumber(phoneNumber);
      if (!collection) {
        throw new BadRequestException('No se encontró cobranza asociada');
      }

      // Crear registro de pago pendiente de verificación
      await this.createPaymentRecord({
        collectionId: collection.id,
        referenceNumber: extractedData.reference,
        screenshotUrl,
        amount: extractedData.amount,
        installmentNumber: collection.currentInstallment,
      });

      // TODO: Enviar mensaje de confirmación al cliente
      this.logger.log(`Pago registrado para verificación: ${extractedData.reference}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando screenshot: ${message}`);
      throw error;
    }
  }

  /**
   * Procesa un pago desde una referencia de texto
   */
  private async processPaymentFromReference(phoneNumber: string, reference: string): Promise<void> {
    try {
      const collection = await this.findCollectionByPhoneNumber(phoneNumber);
      if (!collection) {
        throw new BadRequestException('No se encontró cobranza asociada');
      }

      // Crear registro de pago pendiente de verificación
      await this.createPaymentRecord({
        collectionId: collection.id,
        referenceNumber: reference.trim(),
        amount: collection.currentDebt,
        installmentNumber: collection.currentInstallment,
      });

      this.logger.log(`Pago registrado para verificación: ${reference}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error procesando referencia: ${message}`);
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
        relations: { collection: { user: true, client: true } },
      });

      if (!payment) {
        throw new BadRequestException('Payment not found');
      }

      const collectionSend = await this.collectionSendRepository.findOne({
        where: {
          collectionId: payment.collectionId,
          installmentNumber: payment.installmentNumber,
        },
        order: { sentAt: 'DESC' },
      });

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

      const bankUsername = payment.collection?.user?.bankUsername?.trim();
      const bankPassword = payment.collection?.user?.bankPassword?.trim();

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
          reference: payment.referenceNumber ?? '',
        },
      };
      const result = await this.bankAutomationService.verifyPaymentBDV(verifyPayload);
      const isVerified = result?.movementIsCorrect ?? false;

      if (!isVerified) {
        console.log("Payment not verified");
        payment.status = 'rejected';
        payment.notes = 'No se pudo validar el pago en el banco';

        await this.notifyClientPaymentResult(
          payment,
          'No pudimos validar tu pago. Por favor ponte en contacto con tu vendedor.',
        );
      } else {
        console.log("Payment verified");
        payment.status = 'verified';
        payment.verifiedAt = new Date();

        // Actualizar la colección marcando la cuota como pagada
        await this.updateCollectionPayment(payment.collection.id, payment.installmentNumber);

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
    const client = payment.collection.client;
    const clientPhone = `${client.countryCode ?? ''}${client.phoneCode}${client.phoneNumber}`;
    await this.whatsappService.sendTextMessage(clientPhone, message);
  }

  /**
   * Obtiene pagos pendientes de verificación
   */
  async getPendingPayments(): Promise<Payment[]> {
    return this.paymentRepository.find({
      where: { status: 'pending' },
      relations: { collection: true },
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

  private async findCollectionByPhoneNumber(phoneNumber: string): Promise<Collection | null> {
    const cleanedPhone = phoneNumber.replace(/\D/g, '');

    const collection = await this.collectionRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.client', 'client')
      .where(
        "CONCAT(COALESCE(client.countryCode, ''), client.phoneCode, client.phoneNumber) = :phone",
        { phone: cleanedPhone },
      )
      .orderBy('c.createdAt', 'DESC')
      .getOne();

    return collection || null;
  }

  private async createPaymentRecord(dto: ProcessPaymentDto): Promise<Payment> {
    const collection = await this.collectionRepository.findOne({
      where: { id: dto.collectionId },
    });

    if (!collection) {
      throw new BadRequestException('Collection not found');
    }

    const payment = this.paymentRepository.create({
      collection,
      amount: dto.amount,
      installmentNumber: dto.installmentNumber,
      referenceNumber: dto.referenceNumber,
      screenshotUrl: dto.screenshotUrl || null,
      status: 'pending',
      notes: null,
    });

    return this.paymentRepository.save(payment);
  }

  private async updateCollectionPayment(collectionId: string, installmentNumber: number): Promise<void> {
    const collection = await this.collectionRepository.findOne({
      where: { id: collectionId },
    });

    if (collection) {
      // Restar el monto pagado de la deuda actual
      collection.currentInstallment = installmentNumber + 1;
      
      const payment = await this.paymentRepository.findOne({
        where: { collectionId, installmentNumber },
      });

      if (payment) {
        collection.currentDebt = Math.max(0, collection.currentDebt - payment.amount);
      }

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
