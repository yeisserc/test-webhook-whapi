import { Body, Controller, Post, UseInterceptors, BadRequestException, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BankAutomationService } from './bank-automation.service';
import type { VerifyPaymentBancoDeVenezuelaRequest, VerifyPaymentRequest } from './bank-automation.service';

export type UploadedImage = {
  buffer: Buffer;
  mimetype: string;
};

@Controller('bank-automation')
export class BankAutomationController {
  constructor(private readonly bankAutomationService: BankAutomationService) {}

  @Post('verify-payment-banco-de-venezuela')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      fileFilter: (_request, file, callback) => {
        if (!file.mimetype.startsWith('image/')) {
          callback(new BadRequestException('El archivo debe ser una imagen.'), false);
          return;
        }

        callback(null, true);
      },
    }),
  )
  verifyPaymentBancoDeVenezuela(@UploadedFile() file?: UploadedImage) {
    return this.bankAutomationService.processPaymentScreenshotBancoDeVenezuela(file);
  }
}
