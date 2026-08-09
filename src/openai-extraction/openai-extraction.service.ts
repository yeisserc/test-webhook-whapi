import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

type TransferExtraction = {
  amount: number | null;
  reference: string | null;
};

type QueryCostInfo = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

@Injectable()
export class OpenaiExtractionService {
  private readonly logger = new Logger(OpenaiExtractionService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly inputCostPer1M: number | null;
  private readonly outputCostPer1M: number | null;

  constructor(private readonly configService: ConfigService) {
    const apiKey =
      this.configService.get<string>('OPENAI_API_KEY') ??
      this.configService.get<string>('OPENAI_KEY');

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY (u OPENAI_KEY) no esta configurada.');
    }

    this.openai = new OpenAI({ apiKey });
    this.model = this.configService.get<string>('OPENAI_MODEL', 'gpt-4.1-mini');
    this.inputCostPer1M = this.readNumberConfig('OPENAI_INPUT_COST_PER_1M');
    this.outputCostPer1M = this.readNumberConfig('OPENAI_OUTPUT_COST_PER_1M');
  }

  async extractTransferDataFromImage(fileBuffer: Buffer, mimeType: string) {
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('El archivo enviado no es una imagen valida.');
    }

    const imageDataUrl = this.buildDataUrl(fileBuffer, mimeType);

    try {
      const response = await this.openai.responses.create({
        model: this.model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Extrae datos de un screenshot de transferencia bancaria y responde solamente JSON con este formato exacto: {"amount": number|null, "reference": string|null}. Si no encuentras un valor, usa null. No incluyas texto adicional.',
              },
              {
                type: 'input_image',
                image_url: imageDataUrl,
                detail: 'auto',
              },
            ],
          },
        ],
      });

      const queryCost = this.logQueryCost(response);

      const rawModelOutput = (response.output_text || '').trim();
      const extracted = this.parseExtraction(rawModelOutput);

      return {
        amount: extracted.amount,
        reference: extracted.reference,
        rawModelOutput,
        queryCost,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Error procesando imagen con OpenAI: ${String(error)}`,
      );
    }
  }

  private buildDataUrl(fileBuffer: Buffer, mimeType: string) {
    const base64Image = fileBuffer.toString('base64');
    return `data:${mimeType};base64,${base64Image}`;
  }

  private parseExtraction(rawOutput: string): TransferExtraction {
    const jsonSnippet = this.findJsonObject(rawOutput);

    if (!jsonSnippet) {
      return {
        amount: null,
        reference: null,
      };
    }

    try {
      const parsed = JSON.parse(jsonSnippet) as {
        amount?: number | string | null;
        reference?: string | null;
      };

      return {
        amount: this.normalizeAmount(parsed.amount),
        reference:
          typeof parsed.reference === 'string' && parsed.reference.trim().length > 0
            ? parsed.reference.trim()
            : null,
      };
    } catch {
      return {
        amount: null,
        reference: null,
      };
    }
  }

  private findJsonObject(text: string) {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }

  private normalizeAmount(amount: number | string | null | undefined) {
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      return amount;
    }

    if (typeof amount !== 'string') {
      return null;
    }

    const trimmed = amount.trim();
    if (!trimmed) {
      return null;
    }

    const commaAsDecimal = /^-?\d{1,3}(\.\d{3})*,\d+$/;
    const normalized = commaAsDecimal.test(trimmed)
      ? trimmed.replace(/\./g, '').replace(',', '.')
      : trimmed.replace(/,/g, '');

    const numericValue = Number(normalized.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  private readNumberConfig(key: string) {
    const rawValue = this.configService.get<string>(key);
    if (!rawValue) {
      return null;
    }

    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  private logQueryCost(response: { id?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }): QueryCostInfo {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;

    const hasRates = this.inputCostPer1M !== null && this.outputCostPer1M !== null;
    const estimatedCostUsd = hasRates
      ? (inputTokens / 1_000_000) * this.inputCostPer1M +
        (outputTokens / 1_000_000) * this.outputCostPer1M
      : null;

    this.logger.log(
      [
        'OpenAI query usage',
        `model=${this.model}`,
        `requestId=${response.id ?? 'unknown'}`,
        `inputTokens=${inputTokens}`,
        `outputTokens=${outputTokens}`,
        `totalTokens=${totalTokens}`,
        `estimatedCostUsd=${estimatedCostUsd !== null ? estimatedCostUsd.toFixed(6) : 'N/A'}`,
      ].join(' | '),
    );

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
    };
  }
}
