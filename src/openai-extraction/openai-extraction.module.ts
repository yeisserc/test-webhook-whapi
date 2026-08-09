import { Module } from '@nestjs/common';
import { OpenaiExtractionController } from './openai-extraction.controller';
import { OpenaiExtractionService } from './openai-extraction.service';

@Module({
  controllers: [OpenaiExtractionController],
  providers: [OpenaiExtractionService],
  exports: [OpenaiExtractionService],
})
export class OpenaiExtractionModule {}
