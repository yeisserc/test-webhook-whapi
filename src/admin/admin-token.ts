import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export type AdminTokenPayload = {
  sub: string;
  email: string;
  exp: number;
};

export function signAdminToken(payload: { sub: string; email: string }, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({
      sub: payload.sub,
      email: payload.email,
      exp: Date.now() + TOKEN_TTL_MS,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function readAdminToken(token: string, secret: string): AdminTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, signature] = parts;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AdminTokenPayload;
    if (!payload?.sub || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
