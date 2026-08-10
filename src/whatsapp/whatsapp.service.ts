import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SendTemplateMessageDto,
  TemplateParameterInput,
} from './dto/send-template-message.dto';
import {
  WhatsAppApiError,
  WhatsAppSendMessageResponse,
  WhatsAppTemplateComponent,
  WhatsAppTemplateParameter,
} from './types/whatsapp-api.types';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly phoneNumberId: string;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly messagesUrl: string;

  constructor(private readonly configService: ConfigService) {
    const phoneNumberId = this.configService.get<string>('PHONE_NUMBER_ID');
    const token = this.configService.get<string>('WHATSAPP_TOKEN');

    if (!phoneNumberId || !token) {
      throw new Error(
        'PHONE_NUMBER_ID y WHATSAPP_TOKEN deben estar configurados en el .env',
      );
    }

    this.phoneNumberId = phoneNumberId;
    this.token = token;
    this.apiVersion = this.configService.get<string>(
      'WHATSAPP_API_VERSION',
      'v21.0',
    );
    this.messagesUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  /**
   * Envia un mensaje de WhatsApp usando un template aprobado en Meta.
   */
  async sendTemplateMessage(
    dto: SendTemplateMessageDto,
  ): Promise<WhatsAppSendMessageResponse> {
    const to = this.normalizePhoneNumber(dto.to);
    const components = this.buildTemplateComponents(dto);

    const template: Record<string, unknown> = {
      name: dto.templateName,
      language: {
        code: dto.languageCode ?? 'es',
      },
    };

    if (components.length > 0) {
      template.components = components;
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template,
    };

    try {
      console.log(`messagesUrl: ${this.messagesUrl}`);
      console.log(`token: ${this.token}`);
      const response = await fetch(this.messagesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as
        | WhatsAppSendMessageResponse
        | WhatsAppApiError;

      if (!response.ok) {
        console.log(`sendTemplateMessage error: ${JSON.stringify(data)}`);
        const apiError = data as WhatsAppApiError;
        const errorMessage =
          apiError.error?.message ?? 'Error al enviar mensaje de WhatsApp'

        this.logger.error(
          `WhatsApp API error (${response.status}): ${JSON.stringify(data)}`,
        );

        throw new InternalServerErrorException(errorMessage);
      }

      const result = data as WhatsAppSendMessageResponse;
      const messageId = result.messages?.[0]?.id ?? 'unknown';

      this.logger.log(
        `Template "${dto.templateName}" enviado a ${to} (messageId=${messageId})`,
      );

      return result;
    } catch (error) {
      console.log(`sendTemplateMessage error: ${error}`);
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Error de conexion con WhatsApp API: ${String(error)}`,
      );
    }
  }

  /**
   * Envia un mensaje de texto libre por WhatsApp (ventana de 24h).
   */
  async sendTextMessage(to: string, body: string): Promise<WhatsAppSendMessageResponse> {
    const phone = this.normalizePhoneNumber(to);
    const text = body?.trim();

    if (!phone) {
      throw new BadRequestException('Phone number is required.');
    }

    if (!text) {
      throw new BadRequestException('Message body is required.');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    try {
      const response = await fetch(this.messagesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as
        | WhatsAppSendMessageResponse
        | WhatsAppApiError;

      if (!response.ok) {
        const apiError = data as WhatsAppApiError;
        const errorMessage =
          apiError.error?.message ?? 'Error al enviar mensaje de WhatsApp';

        this.logger.error(
          `WhatsApp API error (${response.status}): ${JSON.stringify(data)}`,
        );

        throw new InternalServerErrorException(errorMessage);
      }

      const result = data as WhatsAppSendMessageResponse;
      const messageId = result.messages?.[0]?.id ?? 'unknown';

      this.logger.log(`Mensaje de texto enviado a ${phone} (messageId=${messageId})`);

      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException || error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Error de conexion con WhatsApp API: ${String(error)}`,
      );
    }
  }

  /**
   * Descarga un medio de WhatsApp por media id (Graph API).
   */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!mediaId?.trim()) {
      throw new BadRequestException('Media id is required.');
    }

    const metaUrl = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;

    try {
      const metaResponse = await fetch(metaUrl, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      const metaData = (await metaResponse.json()) as {
        url?: string;
        mime_type?: string;
        error?: WhatsAppApiError['error'];
      };

      if (!metaResponse.ok || !metaData.url) {
        this.logger.error(`Error obteniendo metadata de media: ${JSON.stringify(metaData)}`);
        throw new InternalServerErrorException(
          metaData.error?.message ?? 'No se pudo obtener la URL del medio de WhatsApp.',
        );
      }

      const fileResponse = await fetch(metaData.url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!fileResponse.ok) {
        throw new InternalServerErrorException(
          `No se pudo descargar el medio de WhatsApp (${fileResponse.status}).`,
        );
      }

      const arrayBuffer = await fileResponse.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType: metaData.mime_type || fileResponse.headers.get('content-type') || 'image/jpeg',
      };
    } catch (error) {
      if (
        error instanceof InternalServerErrorException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Error de conexion descargando medio de WhatsApp: ${String(error)}`,
      );
    }
  }

  private buildTemplateComponents(
    dto: SendTemplateMessageDto,
  ): WhatsAppTemplateComponent[] {
    const components: WhatsAppTemplateComponent[] = [];

    if (dto.headerParameters) {
      components.push({
        type: 'header',
        parameters: this.toTextParameters(dto.headerParameters),
      });
    }

    if (dto.bodyParameters) {
      components.push({
        type: 'body',
        parameters: this.toTextParameters(dto.bodyParameters),
      });
    }

    return components;
  }

  private toTextParameters(
    input: TemplateParameterInput[] | Record<string, string>,
  ): WhatsAppTemplateParameter[] {
    if (!Array.isArray(input)) {
      return Object.entries(input).map(([parameter_name, text]) => ({
        type: 'text',
        parameter_name,
        text,
      }));
    }

    return input.map((item) => {
      if (typeof item === 'string') {
        return { type: 'text', text: item };
      }

      if (!item.name?.trim()) {
        throw new BadRequestException(
          'Cada parametro con nombre debe incluir la propiedad "name".',
        );
      }

      return {
        type: 'text',
        parameter_name: item.name,
        text: item.value,
      };
    });
  }

  private normalizePhoneNumber(phone: string): string {
    return phone.replace(/\D/g, '');
  }
}
