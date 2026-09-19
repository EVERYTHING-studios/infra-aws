import { describe, expect, it } from 'vitest';
import { indexAttributes } from './tasks-repo.js';

const USER = '11111111-2222-4333-8444-555555555555';
const CREATED = '2026-09-19T00:00:00.000Z';

describe('indexAttributes', () => {
  it('web-app tasks keep the global idempotency scope and never write the customer GSIs', () => {
    const attrs = indexAttributes({
      user_id: USER,
      source: 'web-app',
      status: 'PENDING',
      created_at: CREATED,
      idempotency_key: 'k1',
    });
    expect(attrs).toEqual({
      gsi1pk: 'IDEMPOTENCY#k1',
      gsi2pk: 'STATUS#PENDING',
      gsi2sk: CREATED,
    });
  });

  it('legacy tasks (source absent) behave exactly like web-app tasks', () => {
    const attrs = indexAttributes({
      user_id: USER,
      source: undefined,
      status: 'SUCCEEDED',
      created_at: CREATED,
      idempotency_key: 'k1',
    });
    expect(attrs.gsi1pk).toBe('IDEMPOTENCY#k1');
    expect(attrs).not.toHaveProperty('gsi3pk');
    expect(attrs).not.toHaveProperty('gsi4pk');
  });

  it('API tasks scope idempotency per user and write the sparse listing keys', () => {
    const attrs = indexAttributes({
      user_id: USER,
      source: 'api',
      status: 'PENDING',
      created_at: CREATED,
      idempotency_key: 'k1',
    });
    expect(attrs).toEqual({
      gsi1pk: `USER#${USER}#IDEMP#k1`,
      gsi2pk: 'STATUS#PENDING',
      gsi2sk: CREATED,
      gsi3pk: `USER#${USER}`,
      gsi3sk: CREATED,
      gsi4pk: `USER#${USER}#STATUS#PENDING`,
    });
  });

  it('omits the idempotency key entirely when the record has none', () => {
    const attrs = indexAttributes({
      user_id: USER,
      source: 'api',
      status: 'PENDING',
      created_at: CREATED,
    });
    expect(attrs).not.toHaveProperty('gsi1pk');
  });
});
