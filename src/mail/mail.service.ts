import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export type SendAdminAlertResult = {
  sent: boolean;
  to?: string;
  reason?: string;
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly fromAddress: string;
  private readonly adminAlertEmail: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST')?.trim();
    const port = Number(this.configService.get<string>('SMTP_PORT', '587'));
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    const pass = this.configService.get<string>('SMTP_PASS')?.trim();
    this.fromAddress =
      this.configService.get<string>('SMTP_FROM')?.trim() ||
      user ||
      'noreply@cobrofacil.local';
    this.adminAlertEmail =
      this.configService.get<string>('ADMIN_ALERT_EMAIL')?.trim() || '';

    if (host && user && pass) {
      // family no está tipado en @types/nodemailer, pero smtp-connection sí lo soporta
      const options: SMTPTransport.Options & { family?: 4 | 6 } = {
        host,
        port,
        secure: port === 465,
        // Forzar IPv4: en redes sin IPv6, Gmail resuelve a :: y falla con ENETUNREACH
        family: 4,
        auth: { user, pass },
      };
      this.transporter = nodemailer.createTransport(options);
    } else {
      this.transporter = null;
      this.logger.warn(
        'SMTP no configurado (SMTP_HOST/SMTP_USER/SMTP_PASS). Los avisos por correo quedarán deshabilitados.',
      );
    }
  }

  async sendAdminAlert(subject: string, text: string): Promise<SendAdminAlertResult> {
    if (!this.transporter) {
      const reason = 'SMTP no configurado (SMTP_HOST/SMTP_USER/SMTP_PASS).';
      this.logger.warn(`Correo admin omitido: ${reason} Asunto: ${subject}`);
      return { sent: false, reason };
    }

    if (!this.adminAlertEmail) {
      const reason = 'ADMIN_ALERT_EMAIL no configurado.';
      this.logger.warn(`Correo admin omitido: ${reason} Asunto: ${subject}`);
      return { sent: false, reason };
    }

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to: this.adminAlertEmail,
        subject,
        text,
      });
      this.logger.log(`Alerta enviada a ${this.adminAlertEmail}: ${subject}`);
      return { sent: true, to: this.adminAlertEmail };
    } catch (error: unknown) {
      console.log(error);
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error enviando correo admin: ${reason}`);
      return { sent: false, to: this.adminAlertEmail, reason };
    }
  }
}
