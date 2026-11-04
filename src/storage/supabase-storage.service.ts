import { randomUUID } from 'crypto';
import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const endpoint = configService.get<string>('SUPABASE_STORAGE_URL')?.trim();
    const region = configService.get<string>('SUPABASE_STORAGE_REGION')?.trim();
    const accessKeyId = configService.get<string>('SUPABASE_STORAGE_ACCESS_KEY')?.trim();
    const secretAccessKey = configService.get<string>('SUPABASE_STORAGE_SECRET_KEY')?.trim();
    this.bucket = configService.get<string>('SUPABASE_STORAGE_SCREENSHOTS_BUCKET')?.trim() ?? '';

    if (!endpoint || !region || !accessKeyId || !secretAccessKey || !this.bucket) {
      throw new Error('Faltan variables de Supabase Storage en el entorno.');
    }

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async savePaymentScreenshot(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
    const extension = EXTENSION_BY_MIME[normalizedMime] ?? '.jpg';
    const key = `payment-screenshots/${Date.now()}-${randomUUID()}${extension}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: imageBuffer,
          ContentType: EXTENSION_BY_MIME[normalizedMime] ? normalizedMime : 'image/jpeg',
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo guardar el comprobante en Supabase: ${message}`);
      throw new InternalServerErrorException('No se pudo guardar el comprobante.');
    }

    return key;
  }

  async readPaymentScreenshot(key: string): Promise<{ body: Buffer; contentType: string }> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) {
        throw new NotFoundException('Comprobante no encontrado.');
      }

      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType || contentTypeForKey(key),
      };
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof NoSuchKey || (error instanceof S3ServiceException && error.name === 'NotFound')) {
        throw new NotFoundException('Comprobante no encontrado.');
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo leer el comprobante desde Supabase: ${message}`);
      throw new InternalServerErrorException('No se pudo obtener el comprobante.');
    }
  }
}

function contentTypeForKey(key: string): string {
  const extension = key.slice(key.lastIndexOf('.')).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/jpeg';
}
