import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook-signature.js';

describe('webhook signature', () => {
  const secret = 'test-secret';
  const timestamp = '2026-07-10T12:00:00.000Z';
  const body = JSON.stringify({ event: 'task.updated', task_id: '01JTEST' });

  it('round-trips sign → verify', () => {
    const signature = signWebhook(secret, timestamp, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhook(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body + 'x', signature)).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const signature = signWebhook(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, '2026-07-10T12:00:01.000Z', body, signature)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const signature = signWebhook('other-secret', timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyWebhookSignature(secret, timestamp, body, 'garbage')).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, body, '')).toBe(false);
  });
});
