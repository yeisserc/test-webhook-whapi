import * as https from 'https';
import { URL } from 'url';

const BCV_URL = 'https://www.bcv.org.ve/';
const DOLAR_RATE_REGEX =
  /id=["']dolar["'][\s\S]*?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i;

export class BcvUsdRateFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BcvUsdRateFetchError';
  }
}

/**
 * Descarga el HTML del BCV (el certificado del sitio suele fallar la validación).
 */
export async function fetchBcvHomeHtml(timeoutMs = 30000): Promise<{ url: string; html: string }> {
  try {
    const html = await getHttpsText(BCV_URL, timeoutMs);
    return { url: BCV_URL, html };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BcvUsdRateFetchError(`No se pudo descargar la página del BCV: ${reason}`);
  }
}

/**
 * Extrae el USD del selector
 * `#dolar > div > div > div.col-sm-6.col-xs-6.centrado.textp > strong`
 */
export function parseBcvUsdRate(html: string): number {
  const match = html.match(DOLAR_RATE_REGEX);
  if (!match?.[1]) {
    throw new BcvUsdRateFetchError(
      'No se encontró el texto de la tasa USD en #dolar … strong del BCV.',
    );
  }

  const raw = match[1].trim();
  // Formato VE: "919,82270000" (coma decimal; punto = miles si existiera)
  const normalized = raw.replace(/\./g, '').replace(',', '.');
  const rate = Number(normalized);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new BcvUsdRateFetchError(`Tasa USD inválida leída del BCV: "${raw}"`);
  }

  return rate;
}

export async function fetchBcvUsdRate(timeoutMs = 30000): Promise<{
  rate: number;
  rawSourceUrl: string;
}> {
  const { url, html } = await fetchBcvHomeHtml(timeoutMs);
  return { rate: parseBcvUsdRate(html), rawSourceUrl: url };
}

function getHttpsText(url: string, timeoutMs: number, redirectsLeft = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new BcvUsdRateFetchError('Demasiadas redirecciones al consultar el BCV.'));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          getHttpsText(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new BcvUsdRateFetchError(`BCV respondió HTTP ${status}.`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      },
    );

    request.on('timeout', () => {
      request.destroy(new BcvUsdRateFetchError(`Timeout al consultar el BCV (${timeoutMs}ms).`));
    });
    request.on('error', reject);
  });
}
