import { describe, expect, it } from 'vitest';
import { generateApiKey, parseApiKey, sha256Hex, constantTimeEquals } from './api-keys.js';

describe('api-keys', () => {
  it('roundtrips generate → parse → sha256 verify', () => {
    const generated = generateApiKey();
    expect(generated.token).toBe(`esk_${generated.key_id}_${generated.secret}`);
    expect(generated.key_id).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(generated.secret).toMatch(/^[A-Za-z0-9]{43}$/);

    const parsed = parseApiKey(generated.token);
    expect(parsed).toEqual({ key_id: generated.key_id, secret: generated.secret });

    // The stored hash comparison the authorizer performs.
    expect(sha256Hex(parsed!.secret)).toBe(generated.key_hash);
    expect(constantTimeEquals(sha256Hex(parsed!.secret), generated.key_hash)).toBe(true);
  });

  it('produces unique keys', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key_id).not.toBe(b.key_id);
    expect(a.secret).not.toBe(b.secret);
  });

  it('rejects malformed tokens', () => {
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('esk_short_secret')).toBeNull();
    expect(parseApiKey('esk_ABCDEFGHIJKLMNOP_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBeNull();
    expect(parseApiKey('esk_ABCDEFGHIJKLMNOPQ!_x'.padEnd(64, 'x'))).toBeNull();
    expect(parseApiKey('Bearer esk_ABCDEFGHIJKLMNOPQ_x'.padEnd(64, 'x'))).toBeNull();
    // wrong secret length: 42 chars instead of 43
    const short = `esk_ABCDEFGHIJKLMNOPQ_${'a'.repeat(42)}`;
    expect(parseApiKey(short)).toBeNull();
  });
});
