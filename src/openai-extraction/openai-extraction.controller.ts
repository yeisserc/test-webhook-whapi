import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OpenaiExtractionService } from './openai-extraction.service';

type UploadedImage = {
  buffer: Buffer;
  mimetype: string;
};

@Controller('openai-extraction')
export class OpenaiExtractionController {
  constructor(private readonly openaiExtractionService: OpenaiExtractionService) {}

  @Post('bank-transfer')
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
  async extractBankTransferData(@UploadedFile() file?: UploadedImage) {
    if (!file) {
      throw new BadRequestException('Debes enviar la imagen en el campo "image".');
    }

    return this.openaiExtractionService.extractTransferDataFromImage(file.buffer, file.mimetype);
  }
}
