import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Raw, Repository } from 'typeorm';
import { Client } from '../clients/entities/client.entity';
import { User } from '../users/entities/user.entity';
import { CreateCollectionDto } from './dto/create-collection.dto';
import type { UpdateCollectionDto } from './dto/update-collection.dto';
import { Collection } from './entities/collection.entity';

const LAST_MONTH_COLLECTION_DAY = 'ultimo';

@Injectable()
export class CollectionsService {
  constructor(
    @InjectRepository(Collection)
    private readonly collectionsRepository: Repository<Collection>,
    @InjectRepository(Client)
    private readonly clientsRepository: Repository<Client>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll(filters: { clientId?: string; userId?: string } = {}) {
    const where: { clientId?: string; userId?: string } = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.userId) where.userId = filters.userId;

    return this.collectionsRepository.find({
      where,
      relations: { user: true, client: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const collection = await this.collectionsRepository.findOne({
      where: { id },
      relations: { user: true, client: true },
    });
    if (!collection) {
      throw new NotFoundException('Cobranza no encontrada.');
    }

    return collection;
  }

  async create(payload: CreateCollectionDto) {
    await this.assertUserExists(payload.userId);
    await this.assertClientExists(payload.clientId);
    await this.assertClientBelongsToUser(payload.clientId, payload.userId);

    const createPayload = {
      ...payload,
      currentDebt: Number(payload.totalDebt),
      currentInstallment: 1,
    };

    this.validatePayload(createPayload);

    const collection = this.collectionsRepository.create({
      userId: payload.userId,
      clientId: payload.clientId,
      totalDebt: Number(payload.totalDebt),
      currentDebt: Number(payload.totalDebt),
      installments: Number(payload.installments),
      currentInstallment: 1,
      frequency: payload.frequency.trim(),
      collectionDay: this.normalizeCollectionDay(payload.frequency, payload.collectionDay),
      concept: payload.concept.trim(),
      skippedInstallments: this.normalizeSkippedInstallments(
        payload.skippedInstallments,
        Number(payload.installments),
      ),
    });

    return this.collectionsRepository.save(collection);
  }

  async update(id: string, payload: UpdateCollectionDto) {
    const collection = await this.findOne(id);

    if (payload.userId !== undefined) {
      await this.assertUserExists(payload.userId);
      collection.userId = payload.userId;
    }

    if (payload.clientId !== undefined) {
      await this.assertClientExists(payload.clientId);
      collection.clientId = payload.clientId;
    }

    if (payload.userId !== undefined || payload.clientId !== undefined) {
      await this.assertClientBelongsToUser(collection.clientId, collection.userId);
    }

    if (payload.totalDebt !== undefined) {
      collection.totalDebt = Number(payload.totalDebt);
    }

    if (payload.currentDebt !== undefined) {
      collection.currentDebt = Number(payload.currentDebt);
    }

    if (payload.installments !== undefined) {
      collection.installments = Number(payload.installments);
    }

    if (payload.currentInstallment !== undefined) {
      collection.currentInstallment = Number(payload.currentInstallment);
    }

    if (payload.frequency !== undefined) {
      collection.frequency = payload.frequency.trim();
    }

    if (payload.collectionDay !== undefined) {
      collection.collectionDay = payload.collectionDay.trim() || null;
    }

    collection.collectionDay = this.normalizeCollectionDay(collection.frequency, collection.collectionDay);

    if (payload.concept !== undefined) {
      const concept = payload.concept.trim();
      if (!concept) {
        throw new BadRequestException('El concepto no puede estar vacío.');
      }
      collection.concept = concept;
    }

    if (payload.skippedInstallments !== undefined) {
      collection.skippedInstallments = this.normalizeSkippedInstallments(
        payload.skippedInstallments,
        Number(collection.installments),
      );
    }

    this.validatePayload(collection);

    return this.collectionsRepository.save(collection);
  }

  async remove(id: string) {
    const collection = await this.findOne(id);
    await this.collectionsRepository.remove(collection);

    return {
      message: 'Cobranza eliminada correctamente.',
      id,
    };
  }

  private async assertUserExists(userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('El id de usuario es obligatorio.');
    }

    const exists = await this.usersRepository.exists({ where: { id: userId } });
    if (!exists) {
      throw new BadRequestException('El usuario indicado no existe.');
    }
  }

  private async assertClientExists(clientId: string) {
    const exists = await this.clientsRepository.exists({ where: { id: clientId } });
    if (!exists) {
      throw new BadRequestException('El cliente indicado no existe.');
    }
  }

  private async assertClientBelongsToUser(clientId: string, userId: string) {
    const client = await this.clientsRepository.findOne({ where: { id: clientId } });
    if (!client || client.userId !== userId) {
      throw new BadRequestException('El cliente no pertenece al usuario indicado.');
    }
  }

  private normalizeCollectionDay(
    frequency: string | undefined,
    collectionDay: string | null | undefined,
  ): string | null {
    const day = collectionDay?.trim() || null;
    if (!day) {
      return null;
    }

    if (frequency?.trim() === 'Mensual' && day.toLowerCase() === LAST_MONTH_COLLECTION_DAY) {
      return LAST_MONTH_COLLECTION_DAY;
    }

    if (frequency?.trim() === 'Quincenal') {
      const parsed = this.parseQuincenalDays(day);
      if (parsed) {
        const second = parsed.secondIsLastDay ? LAST_MONTH_COLLECTION_DAY : String(parsed.day2);
        return `${parsed.day1},${second}`;
      }
    }

    return day;
  }

  private parseQuincenalDays(
    collectionDay: string,
  ): { day1: number; day2: number; secondIsLastDay: boolean } | null {
    const parts = collectionDay
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }

    const lastIndex = parts.findIndex((part) => part.toLowerCase() === LAST_MONTH_COLLECTION_DAY);
    if (lastIndex >= 0) {
      const numeric = parts[lastIndex === 0 ? 1 : 0];
      const day1 = Number(numeric);
      if (!Number.isInteger(day1) || day1 < 1 || day1 > 15 || String(day1) !== numeric) {
        return null;
      }
      return { day1, day2: 0, secondIsLastDay: true };
    }

    const numbers = parts.map((part) => Number(part));
    if (numbers.some((day, index) => !Number.isInteger(day) || String(day) !== parts[index])) {
      return null;
    }

    const [day1, day2] = [...numbers].sort((left, right) => left - right);
    if (day1 < 1 || day1 > 15 || day2 < 16 || day2 > 28) {
      return null;
    }

    return { day1, day2, secondIsLastDay: false };
  }

  private lastDayOfMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  private validatePayload(payload: {
    totalDebt: number;
    currentDebt: number;
    installments: number;
    currentInstallment: number;
    frequency: string;
    collectionDay?: string | null;
  }) {
    if (!Number.isFinite(Number(payload.totalDebt)) || Number(payload.totalDebt) < 0) {
      throw new BadRequestException('La deuda total debe ser un número mayor o igual a 0.');
    }

    if (!Number.isFinite(Number(payload.currentDebt)) || Number(payload.currentDebt) < 0) {
      throw new BadRequestException('La deuda actual debe ser un número mayor o igual a 0.');
    }

    if (!Number.isInteger(Number(payload.installments)) || Number(payload.installments) <= 0) {
      throw new BadRequestException('Las cuotas deben ser un entero mayor que 0.');
    }

    if (!Number.isInteger(Number(payload.currentInstallment)) || Number(payload.currentInstallment) <= 0) {
      throw new BadRequestException('La cuota actual debe ser un entero mayor que 0.');
    }

    if (Number(payload.currentInstallment) > Number(payload.installments)) {
      throw new BadRequestException('La cuota actual no puede ser mayor que el total de cuotas.');
    }

    if (!payload.frequency?.trim()) {
      throw new BadRequestException('La frecuencia de cobro es obligatoria.');
    }

    const freq = payload.frequency.trim();
    const collectionDay = payload.collectionDay?.trim() ?? '';
    if (freq !== 'Manual' && !collectionDay) {
      throw new BadRequestException('El día de cobro es obligatorio para la frecuencia seleccionada.');
    }

    if (freq === 'Quincenal' && collectionDay && !this.parseQuincenalDays(collectionDay)) {
      throw new BadRequestException(
        'La cobranza quincenal usa un día entre 1 y 15 y otro entre 16 y 28, o el último del mes.',
      );
    }

    if (freq === 'Mensual' && collectionDay) {
      const isLastDay = collectionDay.toLowerCase() === LAST_MONTH_COLLECTION_DAY;
      const paymentDay = Number(collectionDay);
      const isDayOfMonth = Number.isInteger(paymentDay) && paymentDay >= 1 && paymentDay <= 28 && String(paymentDay) === collectionDay;
      if (!isLastDay && !isDayOfMonth) {
        throw new BadRequestException(
          'El día de cobro mensual debe estar entre 1 y 28, o ser el último del mes.',
        );
      }
    }

    if (!(payload as { concept?: string | null }).concept?.trim()) {
      throw new BadRequestException('El concepto es obligatorio.');
    }
  }

  isInstallmentSkipped(collection: { skippedInstallments?: string | null }, installment: number): boolean {
    const current = Number(installment);
    return this.skippedInstallmentNumbers(collection).includes(current);
  }

  wasSkipHandledToday(collection: { skipHandledOn?: string | null }): boolean {
    return collection.skipHandledOn === this.caracasDateKey();
  }

  /**
   * La cuota en curso no se cobra: baja la deuda en el monto de una cuota y pasa a la siguiente.
   */
  async waiveCurrentInstallment(collection: Collection): Promise<Collection> {
    const installments = Number(collection.installments);
    const amount = Number((Number(collection.totalDebt) / installments).toFixed(2));
    collection.currentDebt = Math.max(0, Number((Number(collection.currentDebt) - amount).toFixed(2)));
    collection.currentInstallment = Number(collection.currentInstallment) + 1;
    collection.skipHandledOn = this.caracasDateKey();
    return this.collectionsRepository.save(collection);
  }

  private normalizeSkippedInstallments(value: number[] | undefined, installments: number): string | null {
    if (!value?.length) {
      return null;
    }

    const numbers = value.map((item) => Number(item));
    if (numbers.some((item) => !Number.isInteger(item) || item < 1 || item > installments)) {
      throw new BadRequestException('Las cuotas sin cobro deben estar entre 1 y el total de cuotas.');
    }

    return [...new Set(numbers)].sort((left, right) => left - right).join(',');
  }

  private skippedInstallmentNumbers(collection: { skippedInstallments?: string | null }): number[] {
    return String(collection.skippedInstallments ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((item) => Number.isInteger(item) && item > 0);
  }

  private caracasDateKey(date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  /**
   * Calcula las colecciones que vencen en X días
   * Útil para enviar recordatorios automáticos
   */
  async getCollectionsDueInDays(daysOffset: number): Promise<Collection[]> {
    const collections = await this.collectionsRepository.find({
      where: {
        currentDebt: MoreThan(0),
        currentInstallment: Raw((alias) => `${alias} <= installments`),
      },
      relations: { client: true },
    });

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysOffset);

    return collections.filter((collection) => {
      const nextPaymentDate = this.calculateNextPaymentDate(collection, targetDate);
      console.log(`nextPaymentDate: ${nextPaymentDate}`);
      console.log(`targetDate: ${targetDate}`);
      return this.isSameDay(nextPaymentDate, targetDate);
    });
  }

  /**
   * Calcula la próxima fecha de pago (incluyendo el día de referencia si cae en cobro)
   * basada en frequency y collectionDay.
   */
  calculateNextPaymentDate(collection: Collection, referenceDate: Date): Date | null {
    const ref = new Date(referenceDate);
    ref.setHours(0, 0, 0, 0);

    if (collection.frequency === 'Manual') {
      return null;
    }

    if (collection.frequency === 'Semanal' && collection.collectionDay) {
      const dayMap: { [key: string]: number } = {
        'Lunes': 1,
        'Martes': 2,
        'Miércoles': 3,
        'Jueves': 4,
        'Viernes': 5,
        'Sábado': 6,
        'Domingo': 0,
      };

      const targetWeekday = dayMap[collection.collectionDay];
      if (targetWeekday === undefined) {
        return null;
      }

      const currentWeekday = ref.getDay();
      const daysUntilTarget = (targetWeekday - currentWeekday + 7) % 7;

      const nextDate = new Date(ref);
      nextDate.setDate(nextDate.getDate() + daysUntilTarget);
      return nextDate;
    }

    if (collection.frequency === 'Quincenal' && collection.collectionDay) {
      const parsed = this.parseQuincenalDays(collection.collectionDay);
      if (!parsed) {
        return null;
      }

      const currentDay = ref.getDate();
      const secondDay = parsed.secondIsLastDay ? this.lastDayOfMonth(ref) : parsed.day2;

      if (currentDay === parsed.day1 || currentDay === secondDay) {
        return ref;
      }

      const nextDate = new Date(ref);

      if (currentDay < parsed.day1) {
        nextDate.setDate(parsed.day1);
      } else if (currentDay < secondDay) {
        nextDate.setDate(secondDay);
      } else {
        nextDate.setDate(1);
        nextDate.setMonth(nextDate.getMonth() + 1);
        nextDate.setDate(parsed.day1);
      }

      return nextDate;
    }

    if (collection.frequency === 'Mensual' && collection.collectionDay) {
      if (collection.collectionDay.trim().toLowerCase() === LAST_MONTH_COLLECTION_DAY) {
        const nextDate = new Date(ref);
        nextDate.setMonth(nextDate.getMonth() + 1, 0);
        return nextDate;
      }

      const paymentDay = Number(collection.collectionDay);
      if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28) {
        return null;
      }

      const nextDate = new Date(ref);
      nextDate.setDate(paymentDay);

      if (nextDate < ref) {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }

      return nextDate;
    }

    return null;
  }

  private isSameDay(date1: Date | null, date2: Date): boolean {
    if (!date1) return false;
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }
}
