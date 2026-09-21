import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-user API keys for the customer API.
 *
 * Token format: esk_{key_id}_{secret} — key_id is stored in clear text (it is
 * a public identifier used for DynamoDB lookup), the secret is never stored:
 * only its sha256 hash is persisted and compared in constant time.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return out;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Same comparison discipline as the shared-key authorizer. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}


/** Webhook signing secrets: same entropy class as key secrets (32 bytes, base62). */
export function generateWebhookSecret(): string {
  return randomBase62(43);
}
export interface GeneratedApiKey {
  key_id: string;
  secret: string;
  /** Full plaintext token — returned to the caller exactly once. */
  token: string;
  key_hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key_id = randomBase62(16);
  const secret = randomBase62(43); // 32 bytes of entropy in base62
  return {
    key_id,
    secret,
    token: `esk_${key_id}_${secret}`,
    key_hash: sha256Hex(secret),
  };
}

const TOKEN_RE = /^esk_([A-Za-z0-9]{16})_([A-Za-z0-9]{43})$/;

export function parseApiKey(token: string): { key_id: string; secret: string } | null {
  const match = TOKEN_RE.exec(token);
  return match ? { key_id: match[1]!, secret: match[2]! } : null;
}
