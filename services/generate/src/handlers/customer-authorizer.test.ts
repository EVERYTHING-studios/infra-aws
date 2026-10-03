import { describe, expect, it, vi, beforeEach } from 'vitest';

const getApiKey = vi.fn();
const touchLastUsed = vi.fn();

vi.mock('../lib/accounts-repo.js', () => ({
  getApiKey: (...args: unknown[]) => getApiKey(...args),
  touchLastUsed: (...args: unknown[]) => touchLastUsed(...args),
}));

import { handler } from './customer-authorizer.js';
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';

function authEvent(headers: Record<string, string>): APIGatewayRequestAuthorizerEventV2 {
  return { type: 'REQUEST', routeKey: '$default', headers } as APIGatewayRequestAuthorizerEventV2;
}

// A syntactically valid per-user token (esk_{16}_{43}) that has no DB row.
const UNKNOWN_TOKEN = `esk_${'a'.repeat(16)}_${'b'.repeat(43)}`;

beforeEach(() => {
  getApiKey.mockReset().mockResolvedValue(null);
  touchLastUsed.mockReset().mockResolvedValue(undefined);
});

describe('customer-authorizer', () => {
  it('grants the synthetic testmode user for the public test key (x-api-key)', async () => {
    const res = await handler(authEvent({ 'x-api-key': 'esk_testmode' }));

    expect(res).toEqual({
      isAuthorized: true,
      context: { user_id: 'testmode', key_id: 'testmode' },
    });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('grants the synthetic testmode user for the public test key (Bearer)', async () => {
    const res = await handler(authEvent({ authorization: 'Bearer esk_testmode' }));

    expect(res).toEqual({
      isAuthorized: true,
      context: { user_id: 'testmode', key_id: 'testmode' },
    });
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('rejects a well-formed but unknown per-user key', async () => {
    const res = await handler(authEvent({ 'x-api-key': UNKNOWN_TOKEN }));

    expect(res).toEqual({ isAuthorized: false });
    expect(getApiKey).toHaveBeenCalledWith('a'.repeat(16));
  });

  it('rejects a request with no token', async () => {
    const res = await handler(authEvent({}));

    expect(res).toEqual({ isAuthorized: false });
    expect(getApiKey).not.toHaveBeenCalled();
  });
});
