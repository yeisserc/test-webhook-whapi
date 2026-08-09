import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../clients/entities/client.entity';
import { User } from '../users/entities/user.entity';
import { CreateCollectionDto } from './dto/create-collection.dto';
import type { UpdateCollectionDto } from './dto/update-collection.dto';
import { Collection } from './entities/collection.entity';

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
      throw new NotFoundException('Collection not found.');
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
      collectionDay: payload.collectionDay?.trim() || null,
      concept: payload.concept.trim(),
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

    if (payload.concept !== undefined) {
      const concept = payload.concept.trim();
      if (!concept) {
        throw new BadRequestException('Concept cannot be empty.');
      }
      collection.concept = concept;
    }

    this.validatePayload(collection);

    return this.collectionsRepository.save(collection);
  }

  async remove(id: string) {
    const collection = await this.findOne(id);
    await this.collectionsRepository.remove(collection);

    return {
      message: 'Collection deleted successfully.',
      id,
    };
  }

  private async assertUserExists(userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('User id is required.');
    }

    const exists = await this.usersRepository.exists({ where: { id: userId } });
    if (!exists) {
      throw new BadRequestException('The provided user does not exist.');
    }
  }

  private async assertClientExists(clientId: string) {
    const exists = await this.clientsRepository.exists({ where: { id: clientId } });
    if (!exists) {
      throw new BadRequestException('The provided client does not exist.');
    }
  }

  private async assertClientBelongsToUser(clientId: string, userId: string) {
    const client = await this.clientsRepository.findOne({ where: { id: clientId } });
    if (!client || client.userId !== userId) {
      throw new BadRequestException('The client does not belong to the provided user.');
    }
  }

  private validatePayload(payload: {
    totalDebt: number;
    currentDebt: number;
    installments: number;
    currentInstallment: number;
    frequency: string;
  }) {
    if (!Number.isFinite(Number(payload.totalDebt)) || Number(payload.totalDebt) < 0) {
      throw new BadRequestException('Total debt must be a number greater than or equal to 0.');
    }

    if (!Number.isFinite(Number(payload.currentDebt)) || Number(payload.currentDebt) < 0) {
      throw new BadRequestException('Current debt must be a number greater than or equal to 0.');
    }

    if (!Number.isInteger(Number(payload.installments)) || Number(payload.installments) <= 0) {
      throw new BadRequestException('Installments must be an integer greater than 0.');
    }

    if (!Number.isInteger(Number(payload.currentInstallment)) || Number(payload.currentInstallment) <= 0) {
      throw new BadRequestException('Current installment must be an integer greater than 0.');
    }

    if (Number(payload.currentInstallment) > Number(payload.installments)) {
      throw new BadRequestException('Current installment cannot be greater than installments.');
    }

    if (!payload.frequency?.trim()) {
      throw new BadRequestException('Collection frequency is required.');
    }

    const freq = payload.frequency.trim();
    if (freq !== 'Manual' && !(payload as { collectionDay?: string | null }).collectionDay?.trim()) {
      throw new BadRequestException('Collection day is required for the selected frequency.');
    }

    if (!(payload as { concept?: string | null }).concept?.trim()) {
      throw new BadRequestException('Concept is required.');
    }
  }

  /**
   * Calcula las colecciones que vencen en X días
   * Útil para enviar recordatorios automáticos
   */
  async getCollectionsDueInDays(daysOffset: number): Promise<Collection[]> {
    const collections = await this.collectionsRepository.find({
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
  private calculateNextPaymentDate(collection: Collection, referenceDate: Date): Date | null {
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
      const [day1, day2] = collection.collectionDay
        .split(',')
        .map((day) => Number(day.trim()))
        .sort((a, b) => a - b);

      if (!Number.isFinite(day1) || !Number.isFinite(day2)) {
        return null;
      }

      const currentDay = ref.getDate();

      if (currentDay === day1 || currentDay === day2) {
        return ref;
      }

      const nextDate = new Date(ref);

      if (currentDay < day1) {
        nextDate.setDate(day1);
      } else if (currentDay < day2) {
        nextDate.setDate(day2);
      } else {
        nextDate.setMonth(nextDate.getMonth() + 1);
        nextDate.setDate(day1);
      }

      return nextDate;
    }

    if (collection.frequency === 'Mensual' && collection.collectionDay) {
      const paymentDay = Number(collection.collectionDay);
      if (!Number.isFinite(paymentDay)) {
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
