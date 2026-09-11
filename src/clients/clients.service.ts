import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CollectionSend } from '../whatsapp-bot/entities/collection-send.entity';
import { Payment } from '../whatsapp-bot/entities/payment.entity';
import { CreateClientDto } from './dto/create-client.dto';
import type { UpdateClientDto } from './dto/update-client.dto';
import { Client } from './entities/client.entity';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientsRepository: Repository<Client>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Collection)
    private readonly collectionsRepository: Repository<Collection>,
    @InjectRepository(CollectionSend)
    private readonly collectionSendsRepository: Repository<CollectionSend>,
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
  ) {}

  findAll(userId?: string) {
    return this.clientsRepository.find({
      where: userId ? { userId } : {},
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const client = await this.clientsRepository.findOne({
      where: { id },
      relations: { user: true },
    });
    if (!client) {
      throw new NotFoundException('Cliente no encontrado.');
    }

    return client;
  }

  async getPaymentHistory(clientId: string) {
    const client = await this.findOne(clientId);

    const collections = await this.collectionsRepository.find({
      where: { clientId },
      order: { createdAt: 'DESC' },
    });

    const history = await Promise.all(
      collections.map(async (collection) => {
        const sends = await this.collectionSendsRepository.find({
          where: { collectionId: collection.id },
          order: { sentAt: 'DESC', installmentNumber: 'DESC' },
        });

        const sendIds = sends.map((send) => send.id);
        const payments = sendIds.length
          ? await this.paymentsRepository.find({
              where: { collectionSendId: In(sendIds) },
              order: { createdAt: 'DESC' },
            })
          : [];

        const paymentsBySendId = payments.reduce<Record<string, Payment[]>>((acc, payment) => {
          const key = payment.collectionSendId;
          if (!acc[key]) acc[key] = [];
          acc[key].push(payment);
          return acc;
        }, {});

        return {
          id: collection.id,
          concept: collection.concept,
          frequency: collection.frequency,
          collectionDay: collection.collectionDay,
          totalDebt: collection.totalDebt,
          currentDebt: collection.currentDebt,
          installments: collection.installments,
          currentInstallment: collection.currentInstallment,
          createdAt: collection.createdAt,
          sends: sends.map((send) => ({
            id: send.id,
            sentAt: send.sentAt,
            installmentNumber: send.installmentNumber,
            amountUsd: send.amountUsd,
            amountBs: send.amountBs,
            currency: send.currency,
            payments: (paymentsBySendId[send.id] ?? []).map((payment) => ({
              id: payment.id,
              amount: payment.amount,
              installmentNumber: payment.installmentNumber,
              referenceNumber: payment.referenceNumber,
              status: payment.status,
              notes: payment.notes,
              createdAt: payment.createdAt,
              verifiedAt: payment.verifiedAt,
            })),
          })),
        };
      }),
    );

    return {
      client: {
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        nickname: client.nickname,
        phoneCode: client.phoneCode,
        phoneNumber: client.phoneNumber,
      },
      collections: history,
    };
  }

  async create(payload: CreateClientDto) {
    await this.assertUserExists(payload.userId);

    const firstName = payload.firstName?.trim();
    const lastName = payload.lastName?.trim();
    const nickname = payload.nickname?.trim();
    const countryCode = payload.countryCode?.trim();

    if (!firstName) {
      throw new BadRequestException('El nombre es obligatorio.');
    }

    if (!lastName) {
      throw new BadRequestException('El apellido es obligatorio.');
    }

    const phoneCode = this.normalizePhoneCode(payload.phoneCode);
    const phoneNumber = payload.phoneNumber?.trim();

    if (!phoneCode) {
      throw new BadRequestException('El código de teléfono es obligatorio.');
    }

    if (!phoneNumber) {
      throw new BadRequestException('El número de teléfono es obligatorio.');
    }

    const client = this.clientsRepository.create({
      userId: payload.userId,
      firstName,
      lastName,
      nickname: nickname || null,
      countryCode: countryCode || '58',
      phoneCode,
      phoneNumber,
    });

    return this.clientsRepository.save(client);
  }

  async update(id: string, payload: UpdateClientDto) {
    const client = await this.findOne(id);

    if (payload.userId !== undefined) {
      await this.assertUserExists(payload.userId);
      client.userId = payload.userId;
    }

    if (payload.firstName !== undefined) {
      const firstName = payload.firstName.trim();
      if (!firstName) {
        throw new BadRequestException('El nombre no puede estar vacío.');
      }
      client.firstName = firstName;
    }

    if (payload.lastName !== undefined) {
      const lastName = payload.lastName.trim();
      if (!lastName) {
        throw new BadRequestException('El apellido no puede estar vacío.');
      }
      client.lastName = lastName;
    }

    if (payload.nickname !== undefined) {
      const nickname = payload.nickname.trim();
      client.nickname = nickname || null;
    }

    if (payload.countryCode !== undefined) {
      const countryCode = payload.countryCode.trim();
      client.countryCode = countryCode || '58';
    }

    if (payload.phoneCode !== undefined) {
      const phoneCode = this.normalizePhoneCode(payload.phoneCode);
      if (!phoneCode) {
        throw new BadRequestException('El código de teléfono no puede estar vacío.');
      }
      client.phoneCode = phoneCode;
    }

    if (payload.phoneNumber !== undefined) {
      const phoneNumber = payload.phoneNumber.trim();
      if (!phoneNumber) {
        throw new BadRequestException('El número de teléfono no puede estar vacío.');
      }
      client.phoneNumber = phoneNumber;
    }

    return this.clientsRepository.save(client);
  }

  async remove(id: string) {
    const client = await this.findOne(id);
    await this.clientsRepository.remove(client);

    return {
      message: 'Cliente eliminado correctamente.',
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

  /** Quita el 0 inicial local (0412 → 412) para formato internacional. */
  private normalizePhoneCode(phoneCode?: string): string {
    const trimmed = phoneCode?.trim() ?? '';
    if (!trimmed) {
      return '';
    }
    return trimmed.replace(/^0+/, '') || trimmed;
  }
}
