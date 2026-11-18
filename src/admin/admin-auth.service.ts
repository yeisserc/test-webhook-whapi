import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { signAdminToken } from './admin-token';

/**
 * Acceso de administrador:
 * - usuarios con role = admin
 * - correos listados en ADMIN_EMAILS (separados por coma)
 * - si ADMIN_EMAILS está vacío, el correo de ADMIN_ALERT_EMAIL
 * El primer ingreso de un correo permitido lo marca como admin.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

  async login(emailInput: string, passwordInput: string) {
    const email = emailInput?.trim().toLowerCase();
    const password = passwordInput?.trim();

    if (!email || !password) {
      throw new UnauthorizedException('El correo y la contraseña son obligatorios.');
    }

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }

    const matches = await bcrypt.compare(password, user.password);
    if (!matches) {
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }

    if (user.isActive === false) {
      throw new UnauthorizedException('Esta cuenta está desactivada.');
    }

    const allowed = this.adminEmails().includes(email);
    if (user.role !== 'admin' && !allowed) {
      throw new ForbiddenException('Esta cuenta no tiene acceso de administrador.');
    }

    if (user.role !== 'admin') {
      user.role = 'admin';
      await this.usersRepository.save(user);
    }

    const token = signAdminToken({ sub: user.id, email: user.email }, this.tokenSecret());
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  private adminEmails(): string[] {
    const configured = this.configService.get<string>('ADMIN_EMAILS')?.trim();
    const source = configured || this.configService.get<string>('ADMIN_ALERT_EMAIL') || '';
    return source
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  private tokenSecret(): string {
    const secret = this.configService.get<string>('ADMIN_TOKEN_SECRET')?.trim();
    if (!secret) {
      throw new InternalServerErrorException('Falta ADMIN_TOKEN_SECRET en el servidor.');
    }
    return secret;
  }
}
