import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted state shared with the vi.mock factories (vitest hoists vi.mock).
const h = vi.hoisted(() => ({
  // Raw TransactWriteCommand inputs received by the doc client.
  transactions: [] as unknown[],
  // Raw GetCommand/QueryCommand inputs.
  gets: [] as unknown[],
  queries: [] as unknown[],
  // Items served per command kind.
  getItem: undefined as Record<string, unknown> | undefined,
  queryItems: [] as Record<string, unknown>[],
  lastEvaluatedKey: undefined as Record<string, unknown> | undefined,
  // When set, the next TransactWrite throws TransactionCanceledException.
  cancelReasons: undefined as Array<{ Code?: string }> | undefined,
  TransactionCanceledException: class extends Error {
    constructor(public readonly CancellationReasons?: Array<{ Code?: string }>) {
      super('Transaction cancelled');
      this.name = 'TransactionCanceledException';
    }
  },
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: class extends Error {},
  TransactionCanceledException: h.TransactionCanceledException,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd: { input: Record<string, unknown> }) {
        const input = cmd.input;
        if ('TransactItems' in input) {
          h.transactions.push(input);
          if (h.cancelReasons !== undefined) {
            const reasons = h.cancelReasons;
            h.cancelReasons = undefined;
            throw new h.TransactionCanceledException(reasons);
          }
          return {};
        }
        if ('Key' in input) {
          h.gets.push(input);
          return { Item: h.getItem };
        }
        h.queries.push(input);
        return {
          Items: h.queryItems,
          ...(h.lastEvaluatedKey ? { LastEvaluatedKey: h.lastEvaluatedKey } : {}),
        };
      },
    }),
  },
  GetCommand: class {
    constructor(public readonly input: unknown) {}
  },
  PutCommand: class {
    constructor(public readonly input: unknown) {}
  },
  QueryCommand: class {
    constructor(public readonly input: unknown) {}
  },
  TransactWriteCommand: class {
    constructor(public readonly input: unknown) {}
  },
  UpdateCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { applyLedgerEntry, getBalance, listLedgerByUser } from './accounts-repo.js';

const USER = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  h.transactions = [];
  h.gets = [];
  h.queries = [];
  h.getItem = undefined;
  h.queryItems = [];
  h.lastEvaluatedKey = undefined;
  h.cancelReasons = undefined;
  process.env.ACCOUNTS_TABLE = 'generate-staging-accounts';
});

describe('getBalance', () => {
  it('reads the account row and returns its balance', async () => {
    h.getItem = { user_id: USER, balance_micro_usd: 2500000 };
    await expect(getBalance(USER)).resolves.toBe(2500000);
    expect(h.gets[0]).toMatchObject({ Key: { pk: `USER#${USER}` } });
  });

  it('reads as 0 when the row or the balance attribute is absent', async () => {
    await expect(getBalance(USER)).resolves.toBe(0);
    h.getItem = { user_id: USER };
    await expect(getBalance(USER)).resolves.toBe(0);
  });
});

describe('applyLedgerEntry', () => {
  it('writes ledger item and balance delta in one transaction', async () => {
    await applyLedgerEntry(USER, -1000, 'usage:01JT1', 'usage', {
      task_id: '01JT1',
      instance_type: 'g5',
      seconds: 2,
    });

    expect(h.transactions).toHaveLength(1);
    const [put, update] = (h.transactions[0] as { TransactItems: Array<Record<string, unknown>> })
      .TransactItems as Array<{ Put?: Record<string, unknown>; Update?: Record<string, unknown> }>;
    expect(put!.Put).toMatchObject({
      Item: expect.objectContaining({
        pk: 'LEDGER#usage:01JT1',
        idem: 'usage:01JT1',
        user_id: USER,
        kind: 'usage',
        amount_micro_usd: -1000,
        task_id: '01JT1',
        instance_type: 'g5',
        seconds: 2,
        gsi1pk: `USER#${USER}#LEDGER`,
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(update!.Update).toMatchObject({
      Key: { pk: `USER#${USER}` },
      UpdateExpression:
        'SET balance_micro_usd = if_not_exists(balance_micro_usd, :zero) + :delta, updated_at = :now',
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('reports already_applied on idempotent replay instead of double-charging', async () => {
    h.cancelReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
    const result = await applyLedgerEntry(USER, 10000000, 'topup:cs_test_1', 'topup');
    expect(result).toEqual({ already_applied: true });
    // The retried transaction was attempted exactly once — no second attempt.
    expect(h.transactions).toHaveLength(1);
  });

  it('throws when the account row is missing (update condition failed)', async () => {
    h.cancelReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
    await expect(applyLedgerEntry(USER, -500, 'usage:01JT2', 'usage')).rejects.toThrow(
      `account ${USER} not found`,
    );
  });
});

describe('listLedgerByUser', () => {
  it('queries the ledger GSI newest-first and encodes the next cursor', async () => {
    h.queryItems = [{ idem: 'usage:01JT1', kind: 'usage' }];
    h.lastEvaluatedKey = { pk: 'LEDGER#usage:01JT1' };

    const page = await listLedgerByUser(USER, 20);

    expect(h.queries[0]).toMatchObject({
      IndexName: 'gsi1',
      ExpressionAttributeValues: { ':pk': `USER#${USER}#LEDGER` },
      ScanIndexForward: false,
      Limit: 20,
    });
    expect(page.items).toEqual([{ idem: 'usage:01JT1', kind: 'usage' }]);
    const decoded = JSON.parse(Buffer.from(page.lastEvaluatedKey!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ pk: 'LEDGER#usage:01JT1' });
  });

  it('passes the decoded cursor as the exclusive start key', async () => {
    const cursor = Buffer.from(JSON.stringify({ pk: 'LEDGER#x' })).toString('base64url');
    await listLedgerByUser(USER, 50, cursor);
    expect(h.queries[0]).toMatchObject({ ExclusiveStartKey: { pk: 'LEDGER#x' }, Limit: 50 });
  });
});
