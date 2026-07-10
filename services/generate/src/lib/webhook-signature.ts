import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing shared contract with the web-app:
 *   x-generate-timestamp: <ISO 8601>
 *   x-generate-signature: sha256=<hex HMAC(secret, `${timestamp}.${body}`)>
 */

export const SIGNATURE_HEADER = 'x-generate-signature';
export const TIMESTAMP_HEADER = 'x-generate-timestamp';

export function signWebhook(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhook(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
