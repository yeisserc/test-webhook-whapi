import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CollectionsService } from '../collections/collections.service';
import { Collection } from '../collections/entities/collection.entity';
import { Client } from '../clients/entities/client.entity';
import { User } from '../users/entities/user.entity';
import { CollectionSend } from '../whatsapp-bot/entities/collection-send.entity';
import { Payment } from '../whatsapp-bot/entities/payment.entity';

const CHARGE_SEND_TIME = '10:10 a. m.';

type SetupStep = {
  id: string;
  title: string;
  description: string;
  done: boolean;
  path: string;
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Client)
    private readonly clientsRepository: Repository<Client>,
    @InjectRepository(Collection)
    private readonly collectionsRepository: Repository<Collection>,
    @InjectRepository(CollectionSend)
    private readonly sendsRepository: Repository<CollectionSend>,
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    private readonly collectionsService: CollectionsService,
    private readonly configService: ConfigService,
  ) {}

  async getHome(userId: string) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const [clients, collections, sends, payments] = await Promise.all([
      this.clientsRepository.find({ where: { userId } }),
      this.collectionsRepository.find({
        where: { userId },
        relations: { client: true },
      }),
      this.sendsRepository
        .createQueryBuilder('send')
        .innerJoinAndSelect('send.collection', 'collection')
        .innerJoinAndSelect('collection.client', 'client')
        .leftJoinAndSelect('send.payments', 'payment')
        .where('collection.userId = :userId', { userId })
        .getMany(),
      this.paymentsRepository
        .createQueryBuilder('payment')
        .innerJoinAndSelect('payment.collectionSend', 'send')
        .innerJoinAndSelect('send.collection', 'collection')
        .innerJoinAndSelect('collection.client', 'client')
        .where('collection.userId = :userId', { userId })
        .orderBy('payment.createdAt', 'DESC')
        .getMany(),
    ]);

    const today = this.caracasToday();
    const { start, end } = this.caracasDayBounds(0);
    const activeCollections = collections.filter((collection) => this.isActive(collection));
    const sentInstallments = new Set(
      sends.map((send) => `${send.collectionId}:${send.installmentNumber}`),
    );
    const pendingToSend = activeCollections.filter(
      (collection) => !sentInstallments.has(`${collection.id}:${collection.currentInstallment}`),
    );
    const verifiedPayments = payments.filter((payment) => payment.status === 'verified');
    const todaySends = sends
      .filter((send) => send.sentAt >= start && send.sentAt < end)
      .sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
    const verifiedToday = verifiedPayments.filter((payment) => this.isSameCaracasDay(payment.verifiedAt, start, end));
    const receivedTodayUsd = verifiedToday.reduce((sum, payment) => {
      return sum + Number(payment.collectionSend?.amountUsd || 0);
    }, 0);
    const scheduled = activeCollections
      .map((collection) => this.scheduleFor(collection, today))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => left.chargeDate.localeCompare(right.chargeDate));
    const todayKey = this.dateKey(today);
    const upcoming = scheduled.filter((item) => item.chargeDate > todayKey);
    const nextCharge = scheduled[0] ?? null;
    const attention = payments
      .filter((payment) => payment.status === 'rejected')
      .slice(0, 6)
      .map((payment) => this.toAttention(payment));

    const bankConnected = Boolean(
      user.bankUsername?.trim() && user.bankPassword?.trim() && user.validBankCredentials,
    );
    const paymentDetailsReady = Boolean(
      user.companyName?.trim() &&
        user.paymentDocument?.trim() &&
        user.paymentPhoneNumber?.trim() &&
        user.paymentBank,
    );
    const whatsappActive = Boolean(
      this.configService.get<string>('PHONE_NUMBER_ID')?.trim() &&
        this.configService.get<string>('WHATSAPP_TOKEN')?.trim(),
    );
    const steps = this.setupSteps(bankConnected, clients.length > 0, collections.length > 0, paymentDetailsReady);

    return {
      userName: this.displayName(user.email),
      greetingPeriod: this.greetingPeriod(),
      setup: {
        completed: steps.filter((step) => step.done).length,
        total: steps.length,
        steps,
      },
      status: {
        ready: bankConnected && whatsappActive && paymentDetailsReady,
        whatsappActive,
        bankConnected,
        automaticSendsEnabled: paymentDetailsReady,
      },
      summary: {
        activeCollections: activeCollections.length,
        pendingToSend: pendingToSend.length,
        paymentsReceived: verifiedPayments.length,
        todaySends: todaySends.length,
        verifiedToday: verifiedToday.length,
        pendingPayments: payments.filter((payment) => payment.status === 'pending').length,
        receivedTodayUsd: Number(receivedTodayUsd.toFixed(2)),
      },
      nextCharge,
      upcoming,
      todayCharges: todaySends.map((send) => this.toTodayCharge(send)),
      attention,
      hasActivity: sends.length > 0 || payments.length > 0,
      hasClients: clients.length > 0,
      hasCollections: collections.length > 0,
    };
  }

  private setupSteps(
    bankConnected: boolean,
    hasClients: boolean,
    hasCollections: boolean,
    paymentDetailsReady: boolean,
  ): SetupStep[] {
    return [
      {
        id: 'bank',
        title: 'Conectar banco',
        description: 'Vincula tu banco para recibir los pagos.',
        done: bankConnected,
        path: '/bank',
      },
      {
        id: 'client',
        title: 'Agregar primer cliente',
        description: 'Registra a la persona o negocio a quien cobrarás.',
        done: hasClients,
        path: '/clients/new',
      },
      {
        id: 'collection',
        title: 'Crear primera cobranza',
        description: 'Define el monto, la fecha y el concepto.',
        done: hasCollections,
        path: '/collections/new',
      },
      {
        id: 'automatic',
        title: 'Activar envíos automáticos',
        description: 'Completa los datos de pago para enviar los cobros por WhatsApp.',
        done: paymentDetailsReady,
        path: '/bank',
      },
    ];
  }

  private scheduleFor(collection: Collection, today: Date) {
    const nextDate = this.collectionsService.calculateNextPaymentDate(collection, today);
    if (!nextDate || !collection.client) return null;

    const chargeDate = this.dateKey(nextDate);
    const reminder = new Date(nextDate);
    reminder.setDate(reminder.getDate() - 2);

    return {
      collectionId: collection.id,
      clientId: collection.clientId,
      clientName: `${collection.client.firstName} ${collection.client.lastName}`.trim(),
      installmentNumber: collection.currentInstallment,
      amountUsd: Number(Number(collection.totalDebt / collection.installments).toFixed(2)),
      chargeDate,
      reminderDate: this.dateKey(reminder),
      sendTimeLabel: CHARGE_SEND_TIME,
    };
  }

  private toTodayCharge(send: CollectionSend) {
    const client = send.collection.client;
    const latest = this.latestPayment(send.payments ?? []);
    return {
      id: send.id,
      clientId: send.collection.clientId,
      clientName: `${client.firstName} ${client.lastName}`.trim(),
      installmentNumber: send.installmentNumber,
      amountUsd: Number(send.amountUsd),
      sentAt: send.sentAt,
      status: latest?.status || 'sent',
      whatsappStatus: send.whatsappStatus ?? 'sent',
      whatsappError: send.whatsappError ?? null,
    };
  }

  private toAttention(payment: Payment) {
    const client = payment.collectionSend.collection.client;
    return {
      id: payment.id,
      clientId: payment.collectionSend.collection.clientId,
      clientName: `${client.firstName} ${client.lastName}`.trim(),
      status: 'rejected',
      amountUsd: Number(payment.collectionSend.amountUsd),
      detail: 'Comprobante no válido',
    };
  }

  private latestPayment(payments: Payment[]): Payment | null {
    return [...payments].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  private isActive(collection: Collection): boolean {
    return Number(collection.currentDebt) > 0 && collection.currentInstallment <= collection.installments;
  }

  private isSameCaracasDay(value: Date | null | undefined, start: Date, end: Date): boolean {
    if (!value) return false;
    return value >= start && value < end;
  }

  private caracasToday(): Date {
    const parts = this.caracasParts(new Date());
    return new Date(parts.year, parts.month - 1, parts.day);
  }

  private caracasDayBounds(dayOffset: number): { start: Date; end: Date } {
    const { year, month, day } = this.caracasParts(new Date());
    const start = new Date(Date.UTC(year, month - 1, day + dayOffset, 4, 0, 0, 0));
    const end = new Date(Date.UTC(year, month - 1, day + dayOffset + 1, 4, 0, 0, 0));
    return { start, end };
  }

  private caracasParts(date: Date): { year: number; month: number; day: number; hour: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') };
  }

  private greetingPeriod(): 'morning' | 'afternoon' | 'evening' {
    const hour = this.caracasParts(new Date()).hour;
    if (hour < 12) return 'morning';
    if (hour < 19) return 'afternoon';
    return 'evening';
  }

  private dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private displayName(email: string): string {
    const local = email.split('@')[0]?.split(/[._-]/)[0]?.trim() || 'Hola';
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
}
