import { isAbsolute, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SupabaseStorageService } from '../storage/supabase-storage.service';
import { Payment } from '../whatsapp-bot/entities/payment.entity';

const LOCAL_SCREENSHOT_ROOT = resolve(process.cwd(), 'uploads', 'payment-screenshots');

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    private readonly storage: SupabaseStorageService,
  ) {}

  async readScreenshot(paymentId: string): Promise<{ body: Buffer; contentType: string }> {
    const payment = await this.paymentsRepository.findOne({ where: { id: paymentId } });
    const stored = payment?.screenshotUrl?.trim();
    if (!stored) {
      throw new NotFoundException('Comprobante no encontrado.');
    }

    const localPath = localScreenshotPath(stored);
    if (localPath) {
      try {
        return {
          body: await readFile(localPath),
          contentType: contentTypeForPath(localPath),
        };
      } catch {
        throw new NotFoundException('Comprobante no encontrado.');
      }
    }

    if (stored.includes('://') || stored.startsWith('/') || stored.includes('..')) {
      throw new NotFoundException('Comprobante no encontrado.');
    }

    return this.storage.readPaymentScreenshot(stored);
  }
}

function localScreenshotPath(stored: string): string | null {
  const normalized = stored.replace(/\\/g, '/').replace(/^\//, '');
  if (!normalized.startsWith('uploads/payment-screenshots/')) return null;

  const absolute = resolve(process.cwd(), normalized);
  const fromRoot = relative(LOCAL_SCREENSHOT_ROOT, absolute);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  return absolute;
}

function contentTypeForPath(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/jpeg';
}
