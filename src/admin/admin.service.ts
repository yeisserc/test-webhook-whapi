import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../clients/entities/client.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CurrencyRatesService } from '../currency-rates/currency-rates.service';
import { User } from '../users/entities/user.entity';
import { CollectionSend } from '../whatsapp-bot/entities/collection-send.entity';
import { Payment } from '../whatsapp-bot/entities/payment.entity';

const OPERATIONS_LIMIT = 40;

@Injectable()
export class AdminService {
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
    private readonly currencyRatesService: CurrencyRatesService,
    private readonly configService: ConfigService,
  ) {}

  async getSummary() {
    const [companies, activeCollections, pendingPayments, rejectedPayments, today, latestUsdRate] =
      await Promise.all([
        this.usersRepository.count(),
        this.collectionsRepository
          .createQueryBuilder('collection')
          .where('collection.currentDebt > 0')
          .andWhere('collection.currentInstallment <= collection.installments')
          .getCount(),
        this.paymentsRepository.count({ where: { status: 'pending' } }),
        this.paymentsRepository.count({ where: { status: 'rejected' } }),
        this.verifiedToday(),
        this.latestUsdRate(),
      ]);

    return {
      companies,
      activeCollections,
      payments: {
        verifiedToday: today.count,
        pending: pendingPayments,
        rejected: rejectedPayments,
        receivedTodayUsd: today.totalUsd,
      },
      latestUsdRate,
      jobs: {
        paymentVerificationEnabled: this.isEnabled('VERIFY_PENDING_PAYMENTS'),
        paymentDueRemindersEnabled: this.isEnabled('SEND_PAYMENT_DUE_REMINDERS'),
        whatsappConfigured: Boolean(
          this.configService.get<string>('PHONE_NUMBER_ID')?.trim() &&
            this.configService.get<string>('WHATSAPP_TOKEN')?.trim(),
        ),
      },
    };
  }

  async listCompanies() {
    const [users, clientRows, collectionRows] = await Promise.all([
      this.usersRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientsRepository
        .createQueryBuilder('client')
        .select('client.userId', 'userId')
        .addSelect('COUNT(*)', 'count')
        .groupBy('client.userId')
        .getRawMany<Record<string, unknown>>(),
      this.collectionsRepository
        .createQueryBuilder('collection')
        .select('collection.userId', 'userId')
        .addSelect('COUNT(*)', 'count')
        .groupBy('collection.userId')
        .getRawMany<Record<string, unknown>>(),
    ]);

    const clients = this.toCountMap(clientRows);
    const collections = this.toCountMap(collectionRows);

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive !== false,
      companyName: user.companyName,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt,
      bankConnected: Boolean(
        user.bankUsername?.trim() && user.bankPassword?.trim() && user.validBankCredentials,
      ),
      paymentDetailsReady: Boolean(
        user.companyName?.trim() &&
          user.paymentDocument?.trim() &&
          user.paymentPhoneNumber?.trim() &&
          user.paymentBank,
      ),
      clientsCount: clients.get(user.id) ?? 0,
      collectionsCount: collections.get(user.id) ?? 0,
    }));
  }

  async updateCompanyStatus(id: string, isActive: boolean) {
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException('Indica si la cuenta queda activa.');
    }

    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('Empresa no encontrada.');
    }

    if (user.role === 'admin') {
      throw new BadRequestException('No se puede cambiar el estado de un administrador.');
    }

    user.isActive = isActive;
    await this.usersRepository.save(user);
    return { id: user.id, isActive: user.isActive };
  }

  async getOperations() {
    const [failedSends, payments] = await Promise.all([
      this.sendsRepository
        .createQueryBuilder('send')
        .innerJoinAndSelect('send.collection', 'collection')
        .innerJoinAndSelect('collection.client', 'client')
        .innerJoinAndSelect('collection.user', 'user')
        .where('send.whatsappStatus = :status', { status: 'failed' })
        .orWhere('send.whatsappError IS NOT NULL')
        .orderBy('send.sentAt', 'DESC')
        .take(OPERATIONS_LIMIT)
        .getMany(),
      this.paymentsRepository
        .createQueryBuilder('payment')
        .innerJoinAndSelect('payment.collectionSend', 'send')
        .innerJoinAndSelect('send.collection', 'collection')
        .innerJoinAndSelect('collection.client', 'client')
        .innerJoinAndSelect('collection.user', 'user')
        .where('payment.status IN (:...statuses)', { statuses: ['pending', 'rejected'] })
        .orderBy('payment.createdAt', 'DESC')
        .take(OPERATIONS_LIMIT)
        .getMany(),
    ]);

    return {
      failedSends: failedSends.map((send) => {
        const collection = send.collection;
        const user = collection.user;
        return {
          id: send.id,
          sentAt: send.sentAt,
          companyName: user.companyName,
          companyEmail: user.email,
          clientName: this.clientName(collection.client.firstName, collection.client.lastName),
          installmentNumber: send.installmentNumber,
          amountUsd: Number(send.amountUsd),
          whatsappStatus: send.whatsappStatus,
          whatsappError: send.whatsappError ?? null,
        };
      }),
      payments: payments.map((payment) => {
        const collection = payment.collectionSend.collection;
        const user = collection.user;
        return {
          id: payment.id,
          createdAt: payment.createdAt,
          status: payment.status,
          amountUsd: Number(payment.collectionSend.amountUsd),
          companyName: user.companyName,
          companyEmail: user.email,
          clientName: this.clientName(collection.client.firstName, collection.client.lastName),
          installmentNumber: payment.installmentNumber,
          referenceNumber: payment.referenceNumber,
          hasScreenshot: Boolean(payment.screenshotUrl),
        };
      }),
    };
  }

  async getRates() {
    const rates = await this.currencyRatesService.findAll('USD');
    return {
      latest: this.toRate(rates[0]),
      history: rates.slice(0, 20).map((rate) => this.toRate(rate)),
    };
  }

  createRate(currency: string | undefined, rate: number | undefined) {
    return this.currencyRatesService.create({
      currency: currency?.trim() || 'USD',
      rate: Number(rate),
    });
  }

  private toRate(rate?: { id: string; currency: string; rate: number; createdAt: Date }) {
    if (!rate) return null;
    return {
      id: rate.id,
      currency: rate.currency,
      rate: Number(rate.rate),
      createdAt: rate.createdAt,
    };
  }

  private async latestUsdRate() {
    try {
      const latest = await this.currencyRatesService.findLatest('USD');
      return {
        currency: latest.currency,
        rate: Number(latest.rate),
        createdAt: latest.createdAt,
      };
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async verifiedToday(): Promise<{ count: number; totalUsd: number }> {
    const { start, end } = this.caracasDayBounds();
    const row = await this.paymentsRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.collectionSend', 'send')
      .where('payment.status = :status', { status: 'verified' })
      .andWhere('payment.verifiedAt >= :start AND payment.verifiedAt < :end', { start, end })
      .select('COUNT(payment.id)', 'count')
      .addSelect('COALESCE(SUM(send.amountUsd), 0)', 'total')
      .getRawOne<Record<string, string | number | null>>();

    return {
      count: Number(row?.count ?? 0),
      totalUsd: Number(Number(row?.total ?? 0).toFixed(2)),
    };
  }

  private toCountMap(rows: Array<Record<string, unknown>>): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
      const id = String(row.userId ?? row.userid ?? row.user_id ?? '');
      if (!id) continue;
      map.set(id, Number(row.count ?? 0));
    }
    return map;
  }

  private clientName(firstName: string, lastName?: string | null): string {
    return `${firstName} ${lastName ?? ''}`.trim();
  }

  private isEnabled(name: string): boolean {
    const value = this.configService.get<string>(name, 'true')?.trim().toLowerCase();
    return value !== 'false';
  }

  private caracasDayBounds(): { start: Date; end: Date } {
    const { year, month, day } = this.caracasParts(new Date());
    const start = new Date(Date.UTC(year, month - 1, day, 4, 0, 0, 0));
    const end = new Date(Date.UTC(year, month - 1, day + 1, 4, 0, 0, 0));
    return { start, end };
  }

  private caracasParts(date: Date): { year: number; month: number; day: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: read('year'), month: read('month'), day: read('day') };
  }
}
