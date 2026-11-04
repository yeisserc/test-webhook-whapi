import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { createUuidPipe } from '../common/uuid.pipe';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get(':id/screenshot')
  @Header('Cache-Control', 'private, max-age=300')
  async screenshot(@Param('id', createUuidPipe()) id: string): Promise<StreamableFile> {
    const file = await this.paymentsService.readScreenshot(id);
    return new StreamableFile(file.body, { type: file.contentType });
  }
}
