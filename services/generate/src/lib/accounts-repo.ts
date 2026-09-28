import {
  DynamoDBClient,
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { requireEnv } from './env.js';

/**
 * Accounts & API keys store for the customer API.
 *
 * Item layout (pk-partitioned, single table):
 *   pk = USER#{user_id}:  { user_id, display_name?, webhook_url?, webhook_secret?,
 *                          balance_micro_usd?, created_at, updated_at }
 *   pk = KEY#{key_id}:    { key_id, user_id, key_hash, label, status, created_at,
 *                          last_used_at? }
 *                          + gsi1pk = USER#{user_id}#KEYS, gsi1sk = created_at
 *   pk = LEDGER#{idem}:   { idem, user_id, kind, amount_micro_usd, task_id?,
 *                          instance_type?, seconds?, description?, created_at }
 *                          + gsi1pk = USER#{user_id}#LEDGER, gsi1sk = created_at
 *                          (financial record — no TTL, ever)
 */

export interface AccountItem {
  user_id: string;
  display_name?: string;
  webhook_url?: string;
  webhook_secret?: string;
  /** Prepay balance in micro-USD (1e-6 USD); absent = 0. */
  balance_micro_usd?: number;
  created_at: string;
  updated_at: string;
}

export type LedgerKind = 'usage' | 'topup' | 'admin';

export interface LedgerItem {
  /** Idempotency token: usage:{task_id} | topup:{stripe_session_id} | admin:{ulid}. */
  idem: string;
  user_id: string;
  kind: LedgerKind;
  /** Signed micro-USD; usage entries are negative. */
  amount_micro_usd: number;
  task_id?: string;
  instance_type?: string;
  seconds?: number;
  description?: string;
  created_at: string;
}

export type ApiKeyStatus = 'active' | 'revoked';

export interface ApiKeyItem {
  key_id: string;
  user_id: string;
  /** sha256 hex of the token secret; the secret itself is never stored. */
  key_hash: string;
  label?: string;
  status: ApiKeyStatus;
  created_at: string;
  last_used_at?: string;
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function userPk(userId: string): { pk: string } {
  return { pk: `USER#${userId}` };
}

export class NotFoundError extends Error {}

/** Create the account row if absent (first key / first webhook config); otherwise refresh display_name. */
export async function upsertAccount(userId: string, displayName?: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await client.send(
      new PutCommand({
        TableName: requireEnv('ACCOUNTS_TABLE'),
        Item: {
          ...userPk(userId),
          user_id: userId,
          display_name: displayName,
          created_at: now,
          updated_at: now,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    if (displayName !== undefined) {
      await client.send(
        new UpdateCommand({
          TableName: requireEnv('ACCOUNTS_TABLE'),
          Key: userPk(userId),
          UpdateExpression: 'SET display_name = :d, updated_at = :now',
          ExpressionAttributeValues: { ':d': displayName, ':now': now },
        }),
      );
    }
  }
}

export async function getAccount(userId: string): Promise<AccountItem | null> {
  const result = await client.send(
    new GetCommand({ TableName: requireEnv('ACCOUNTS_TABLE'), Key: userPk(userId) }),
  );
  return (result.Item as AccountItem | undefined) ?? null;
}

/** Prepay balance in micro-USD; absent account row or attribute reads as 0. */
export async function getBalance(userId: string): Promise<number> {
  const account = await getAccount(userId);
  return account?.balance_micro_usd ?? 0;
}

export interface LedgerEntryMeta {
  task_id?: string;
  instance_type?: string;
  seconds?: number;
  description?: string;
}

/**
 * Apply one signed ledger entry and move the balance atomically
 * (TransactWriteItems). Idempotent by ledger pk: a repeat with the same
 * `idem` (webhook redelivery / Lambda retry) returns `{ already_applied: true }`
 * instead of double-applying.
 *
 * Callers guarantee the USER#{user_id} row exists — the account update is
 * conditioned on `attribute_exists(pk)` so a missing row can never silently
 * create a balance-only zombie item.
 */
export async function applyLedgerEntry(
  userId: string,
  amountMicroUsd: number,
  idem: string,
  kind: LedgerKind,
  meta: LedgerEntryMeta = {},
): Promise<{ already_applied?: boolean }> {
  const now = new Date().toISOString();
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: requireEnv('ACCOUNTS_TABLE'),
              Item: {
                pk: `LEDGER#${idem}`,
                idem,
                user_id: userId,
                kind,
                amount_micro_usd: amountMicroUsd,
                task_id: meta.task_id,
                instance_type: meta.instance_type,
                seconds: meta.seconds,
                description: meta.description,
                created_at: now,
                gsi1pk: `USER#${userId}#LEDGER`,
                gsi1sk: now,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: requireEnv('ACCOUNTS_TABLE'),
              Key: userPk(userId),
              UpdateExpression:
                'SET balance_micro_usd = if_not_exists(balance_micro_usd, :zero) + :delta, updated_at = :now',
              ExpressionAttributeValues: {
                ':zero': 0,
                ':delta': amountMicroUsd,
                ':now': now,
              },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
        ],
      }),
    );
    return {};
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      const reasons = (err.CancellationReasons ?? []) as { Code?: string }[];
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        // Ledger pk already exists — this exact entry was applied before.
        return { already_applied: true };
      }
      if (reasons[1]?.Code === 'ConditionalCheckFailed') {
        throw new NotFoundError(`account ${userId} not found`);
      }
    }
    throw err;
  }
}

export interface LedgerPage {
  items: LedgerItem[];
  lastEvaluatedKey?: string;
}

/** Newest-first ledger page for a user (gsi1: USER#{user_id}#LEDGER by created_at). */
export async function listLedgerByUser(
  userId: string,
  limit = 20,
  cursor?: string,
): Promise<LedgerPage> {
  const result = await client.send(
    new QueryCommand({
      TableName: requireEnv('ACCOUNTS_TABLE'),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}#LEDGER` },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } : {}),
    }),
  );
  return {
    items: (result.Items ?? []) as LedgerItem[],
    ...(result.LastEvaluatedKey
      ? { lastEvaluatedKey: Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') }
      : {}),
  };
}

export async function putApiKey(item: ApiKeyItem): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: requireEnv('ACCOUNTS_TABLE'),
      Item: {
        pk: `KEY#${item.key_id}`,
        key_id: item.key_id,
        user_id: item.user_id,
        key_hash: item.key_hash,
        label: item.label,
        status: item.status,
        created_at: item.created_at,
        gsi1pk: `USER#${item.user_id}#KEYS`,
        gsi1sk: item.created_at,
      },
    }),
  );
}

export async function getApiKey(keyId: string): Promise<ApiKeyItem | null> {
  const result = await client.send(
    new GetCommand({ TableName: requireEnv('ACCOUNTS_TABLE'), Key: { pk: `KEY#${keyId}` } }),
  );
  return (result.Item as ApiKeyItem | undefined) ?? null;
}

export async function listKeysByUser(userId: string, limit = 100): Promise<ApiKeyItem[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: requireEnv('ACCOUNTS_TABLE'),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}#KEYS` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as ApiKeyItem[];
}

export async function revokeApiKey(keyId: string): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: requireEnv('ACCOUNTS_TABLE'),
        Key: { pk: `KEY#${keyId}` },
        UpdateExpression: 'SET #s = :revoked, updated_at = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked', ':now': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new NotFoundError(`key ${keyId} not found`);
    }
    throw err;
  }
}

/** Set (or replace) the webhook URL; optionally store a newly generated secret alongside. */
export async function setWebhookEndpoint(
  userId: string,
  url: string,
  secret?: string,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: requireEnv('ACCOUNTS_TABLE'),
        Key: userPk(userId),
        UpdateExpression:
          secret !== undefined
            ? 'SET webhook_url = :url, webhook_secret = :secret, updated_at = :now'
            : 'SET webhook_url = :url, updated_at = :now',
        ExpressionAttributeValues: {
          ':url': url,
          ...(secret !== undefined ? { ':secret': secret } : {}),
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new NotFoundError(`account ${userId} not found`);
    }
    throw err;
  }
}

export async function getWebhookEndpoint(
  userId: string,
): Promise<{ url: string; secret: string } | null> {
  const account = await getAccount(userId);
  if (!account?.webhook_url || !account.webhook_secret) return null;
  return { url: account.webhook_url, secret: account.webhook_secret };
}

export async function rotateWebhookSecret(userId: string, secret: string): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: requireEnv('ACCOUNTS_TABLE'),
        Key: userPk(userId),
        UpdateExpression: 'SET webhook_secret = :secret, updated_at = :now',
        ExpressionAttributeValues: { ':secret': secret, ':now': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new NotFoundError(`account ${userId} not found`);
    }
    throw err;
  }
}

export async function clearWebhookEndpoint(userId: string): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: requireEnv('ACCOUNTS_TABLE'),
      Key: userPk(userId),
      UpdateExpression: 'REMOVE webhook_url, webhook_secret',
    }),
  );
}

const LAST_USED_STALE_MS = 60 * 60 * 1000;

/**
 * Touch last_used_at at most hourly: the authorizer calls this
 * fire-and-forget on every (uncached) request, and the conditional expression
 * keeps write volume off the hot auth path.
 */
export async function touchLastUsed(keyId: string, now: Date = new Date()): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: requireEnv('ACCOUNTS_TABLE'),
        Key: { pk: `KEY#${keyId}` },
        UpdateExpression: 'SET last_used_at = :now',
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':cutoff': new Date(now.getTime() - LAST_USED_STALE_MS).toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(last_used_at) OR last_used_at < :cutoff',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return; // touched recently
    throw err;
  }
}
