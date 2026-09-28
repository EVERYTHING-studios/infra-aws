import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const getBalance = vi.fn();
const listLedgerByUser = vi.fn();
const upsertAccount = vi.fn();
const applyLedgerEntry = vi.fn();

vi.mock('../lib/accounts-repo.js', () => ({
  getBalance: (...args: unknown[]) => getBalance(...args),
  listLedgerByUser: (...args: unknown[]) => listLedgerByUser(...args),
  upsertAccount: (...args: unknown[]) => upsertAccount(...args),
  applyLedgerEntry: (...args: unknown[]) => applyLedgerEntry(...args),
}));

import { handler } from './balance.js';

const USER_ID = '11111111-2222-4333-8444-555555555555';

interface JsonResult {
  statusCode: number;
  body: string;
}

function post(body: unknown): Promise<JsonResult> {
  const event = {
    routeKey: 'POST /v1/accounts/{user_id}/balance',
    requestContext: { http: { method: 'POST' } },
    pathParameters: { user_id: USER_ID },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
  return handler(event) as Promise<JsonResult>;
}

beforeEach(() => {
  getBalance.mockReset().mockResolvedValue(1_000_000);
  listLedgerByUser.mockReset();
  upsertAccount.mockReset().mockResolvedValue(undefined);
  applyLedgerEntry.mockReset().mockResolvedValue({});
});

describe('POST /v1/accounts/{user_id}/balance', () => {
  it('creates the account row before applying the ledger entry', async () => {
    const result = await post({ amount_micro_usd: 1_000_000, idempotency_key: 'admin:x' });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ balance_micro_usd: 1_000_000 });

    expect(upsertAccount).toHaveBeenCalledTimes(1);
    expect(upsertAccount).toHaveBeenCalledWith(USER_ID);
    expect(applyLedgerEntry).toHaveBeenCalledTimes(1);
    expect(applyLedgerEntry).toHaveBeenCalledWith(
      USER_ID,
      1_000_000,
      'admin:x',
      'admin',
      {},
    );
    expect(upsertAccount.mock.invocationCallOrder[0]!).toBeLessThan(
      applyLedgerEntry.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects a zero amount without touching the repo', async () => {
    const result = await post({ amount_micro_usd: 0, idempotency_key: 'k' });

    expect(result.statusCode).toBe(400);
    expect(upsertAccount).not.toHaveBeenCalled();
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });

  it('rejects a missing idempotency_key', async () => {
    const result = await post({ amount_micro_usd: 1 });

    expect(result.statusCode).toBe(400);
    expect(upsertAccount).not.toHaveBeenCalled();
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body', async () => {
    const result = await post('not json');

    expect(result.statusCode).toBe(400);
    expect(upsertAccount).not.toHaveBeenCalled();
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });
});
