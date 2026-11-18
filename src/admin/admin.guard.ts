import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { readAdminToken } from './admin-token';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      adminUser?: User;
    }>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const secret = this.configService.get<string>('ADMIN_TOKEN_SECRET')?.trim();

    if (!secret || !token) {
      throw new UnauthorizedException('Inicia sesión de administrador.');
    }

    const payload = readAdminToken(token, secret);
    if (!payload) {
      throw new UnauthorizedException('La sesión de administrador expiró.');
    }

    const user = await this.usersRepository.findOne({ where: { id: payload.sub } });
    if (!user || user.role !== 'admin' || user.isActive === false) {
      throw new UnauthorizedException('Esta sesión ya no tiene acceso de administrador.');
    }

    request.adminUser = user;
    return true;
  }
}
