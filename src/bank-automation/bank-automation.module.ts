import { Module } from '@nestjs/common';
import { BankAutomationController } from './bank-automation.controller';
import { BankAutomationService } from './bank-automation.service';
import { OpenaiExtractionModule } from '../openai-extraction/openai-extraction.module';

@Module({
  imports: [OpenaiExtractionModule],
  controllers: [BankAutomationController],
  providers: [BankAutomationService],
  exports: [BankAutomationService],
})
export class BankAutomationModule {}
