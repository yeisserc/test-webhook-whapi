import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { UsersService } from '../users/users.service';

export type WhatsappStatusEvent = {
  userId: string;
  clientId: string;
  collectionId: string;
  collectionSendId: string;
  whatsappStatus: string;
  whatsappStatusAt: string | null;
  whatsappError: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
})
export class WhatsappStatusGateway implements OnGatewayConnection {
  private readonly logger = new Logger(WhatsappStatusGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly usersService: UsersService) {}

  async handleConnection(client: Socket): Promise<void> {
    const userId = String(client.handshake.auth?.userId ?? '').trim();
    if (!UUID_PATTERN.test(userId)) {
      client.disconnect(true);
      return;
    }

    try {
      await this.usersService.findOne(userId);
    } catch {
      this.logger.debug(`Conexión de estado rechazada para usuario ${userId}`);
      client.disconnect(true);
      return;
    }

    await client.join(this.room(userId));
    this.logger.debug(`Usuario ${userId} suscrito a estados de WhatsApp`);
  }

  emitStatus(event: WhatsappStatusEvent): void {
    this.server?.to(this.room(event.userId)).emit('whatsapp-status', event);
  }

  private room(userId: string): string {
    return `user:${userId}`;
  }
}
