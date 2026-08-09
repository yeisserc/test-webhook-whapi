import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

const SALT_ROUNDS = 10;

export type PublicUser = Omit<User, 'password' | 'bankPassword'> & {
  hasBankAccount: boolean;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll() {
    return this.usersRepository.find({
      order: { createdAt: 'DESC' },
    }).then((users) => users.map((user) => this.toPublicUser(user)));
  }

  async findOne(id: string) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return this.toPublicUser(user);
  }

  async register(payload: RegisterUserDto) {
    const email = payload.email?.trim().toLowerCase();
    const password = payload.password?.trim();

    if (!email) {
      throw new BadRequestException('Email is required.');
    }

    if (!this.isValidEmail(email)) {
      throw new BadRequestException('Email format is invalid.');
    }

    if (!password || password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters.');
    }

    const existing = await this.usersRepository.findOne({ where: { email } });
    if (existing) {
      throw new BadRequestException('A user with this email already exists.');
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = this.usersRepository.create({
      email,
      password: hashedPassword,
      phoneNumber: null,
      bankUsername: null,
      bankPassword: null,
    });

    const saved = await this.usersRepository.save(user);
    return this.toPublicUser(saved);
  }

  async login(payload: LoginUserDto) {
    const email = payload.email?.trim().toLowerCase();
    const password = payload.password?.trim();

    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const matches = await bcrypt.compare(password, user.password);
    if (!matches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.toPublicUser(user);
  }

  async create(payload: CreateUserDto) {
    const email = payload.email?.trim().toLowerCase();
    const password = payload.password?.trim();
    const phoneNumber = payload.phoneNumber?.trim() || null;
    const bankUsername = payload.bankUsername?.trim() || null;
    const bankPassword = payload.bankPassword?.trim() || null;

    if (!email) {
      throw new BadRequestException('Email is required.');
    }

    if (!password || password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters.');
    }

    const existing = await this.usersRepository.findOne({ where: { email } });
    if (existing) {
      throw new BadRequestException('A user with this email already exists.');
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = this.usersRepository.create({
      email,
      password: hashedPassword,
      phoneNumber,
      bankUsername,
      bankPassword,
    });

    const saved = await this.usersRepository.save(user);
    return this.toPublicUser(saved);
  }

  async updateBankAccount(id: string, payload: UpdateBankAccountDto) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const bankUsername = payload.bankUsername?.trim();
    const bankPassword = payload.bankPassword?.trim();

    if (!bankUsername) {
      throw new BadRequestException('Bank username is required.');
    }

    if (!bankPassword) {
      throw new BadRequestException('Bank password is required.');
    }

    user.bankUsername = bankUsername;
    user.bankPassword = bankPassword;

    const saved = await this.usersRepository.save(user);
    return this.toPublicUser(saved);
  }

  async update(id: string, payload: UpdateUserDto) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (payload.email !== undefined) {
      const email = payload.email.trim().toLowerCase();
      if (!email) {
        throw new BadRequestException('Email cannot be empty.');
      }

      const existing = await this.usersRepository.findOne({ where: { email } });
      if (existing && existing.id !== id) {
        throw new BadRequestException('A user with this email already exists.');
      }

      user.email = email;
    }

    if (payload.password !== undefined) {
      const password = payload.password.trim();
      if (!password || password.length < 6) {
        throw new BadRequestException('Password must be at least 6 characters.');
      }
      user.password = await bcrypt.hash(password, SALT_ROUNDS);
    }

    if (payload.phoneNumber !== undefined) {
      const phoneNumber = payload.phoneNumber.trim();
      user.phoneNumber = phoneNumber || null;
    }

    if (payload.bankUsername !== undefined) {
      const bankUsername = payload.bankUsername.trim();
      user.bankUsername = bankUsername || null;
    }

    if (payload.bankPassword !== undefined) {
      const bankPassword = payload.bankPassword.trim();
      user.bankPassword = bankPassword || null;
    }

    const saved = await this.usersRepository.save(user);
    return this.toPublicUser(saved);
  }

  async remove(id: string) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    await this.usersRepository.remove(user);

    return {
      message: 'User deleted successfully.',
      id,
    };
  }

  private toPublicUser(user: User): PublicUser {
    const { password: _password, bankPassword, ...rest } = user;
    return {
      ...rest,
      hasBankAccount: Boolean(rest.bankUsername?.trim() && bankPassword?.trim()),
    };
  }

  private isValidEmail(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
