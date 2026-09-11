import { Body, Controller, Post } from '@nestjs/common';
import { MailService } from './mail.service';

@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  /**
   * Prueba el envío de alertas al admin.
   * POST /mail/test-admin-alert
   * Body opcional: { "subject": "...", "text": "..." }
   */
  @Post('test-admin-alert')
  async testAdminAlert(
    @Body()
    body?: {
      subject?: string;
      text?: string;
    },
  ) {
    const subject = body?.subject?.trim() || 'CobroFacil: prueba de alerta admin';
    const text =
      body?.text?.trim() ||
      [
        'Este es un correo de prueba de sendAdminAlert.',
        '',
        `Fecha: ${new Date().toISOString()}`,
      ].join('\n');

    const result = await this.mailService.sendAdminAlert(subject, text);

    return {
      success: result.sent,
      ...result,
    };
  }
}
