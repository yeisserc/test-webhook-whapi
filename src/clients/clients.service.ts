import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
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
      throw new NotFoundException('Client not found.');
    }

    return client;
  }

  async create(payload: CreateClientDto) {
    await this.assertUserExists(payload.userId);

    const firstName = payload.firstName?.trim();
    const lastName = payload.lastName?.trim();
    const nickname = payload.nickname?.trim();
    const countryCode = payload.countryCode?.trim();

    if (!firstName) {
      throw new BadRequestException('First name is required.');
    }

    if (!lastName) {
      throw new BadRequestException('Last name is required.');
    }

    const phoneCode = this.normalizePhoneCode(payload.phoneCode);
    const phoneNumber = payload.phoneNumber?.trim();

    if (!phoneCode) {
      throw new BadRequestException('Phone code is required.');
    }

    if (!phoneNumber) {
      throw new BadRequestException('Phone number is required.');
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
        throw new BadRequestException('First name cannot be empty.');
      }
      client.firstName = firstName;
    }

    if (payload.lastName !== undefined) {
      const lastName = payload.lastName.trim();
      if (!lastName) {
        throw new BadRequestException('Last name cannot be empty.');
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
        throw new BadRequestException('Phone code cannot be empty.');
      }
      client.phoneCode = phoneCode;
    }

    if (payload.phoneNumber !== undefined) {
      const phoneNumber = payload.phoneNumber.trim();
      if (!phoneNumber) {
        throw new BadRequestException('Phone number cannot be empty.');
      }
      client.phoneNumber = phoneNumber;
    }

    return this.clientsRepository.save(client);
  }

  async remove(id: string) {
    const client = await this.findOne(id);
    await this.clientsRepository.remove(client);

    return {
      message: 'Client deleted successfully.',
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

  /** Quita el 0 inicial local (0412 → 412) para formato internacional. */
  private normalizePhoneCode(phoneCode?: string): string {
    const trimmed = phoneCode?.trim() ?? '';
    if (!trimmed) {
      return '';
    }
    return trimmed.replace(/^0+/, '') || trimmed;
  }
}
