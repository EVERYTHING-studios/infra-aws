import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { applyLedgerEntry, getBalance, listLedgerByUser, LedgerItem } from '../lib/accounts-repo.js';
import { billingRates } from '../lib/billing.js';
import { json, errorResponse, authorizerUserId } from '../lib/http.js';
import { requireEnv } from '../lib/env.js';

/**
 * Balance & usage routes:
 *   GET  /v1/balance                        (customer authorizer — per-user key)
 *   GET  /v1/accounts/{user_id}/balance     (internal shared-key authorizer)
 *   POST /v1/accounts/{user_id}/balance     (internal shared-key authorizer)
 *
 * The internal routes are called by the web-app dashboard backend and the
 * Stripe-webhook fulfillment path only. POST is the single money-in /
 * money-out seam: Stripe top-ups send idempotency_key `topup:{session.id}`,
 * dashboard admins send `admin:{ulid}`. Authorization (admin gate,
 * webhook-only top-ups) is enforced web-app-side, exactly like the keys
 * routes.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;

  if (routeKey === 'GET /v1/balance' && method === 'GET') {
    const userId = authorizerUserId(event);
    if (!userId) {
      return errorResponse(502, 'internal_error', 'authorizer context missing user_id');
    }
    return json(200, {
      balance_micro_usd: await getBalance(userId),
      min_balance_micro_usd: Number(requireEnv('MIN_BALANCE_MICRO_USD')),
      rates: billingRates(),
    });
  }

  const userId = event.pathParameters?.user_id;
  if (!userId) {
    return errorResponse(400, 'invalid_request', 'missing user_id path parameter');
  }

  if (routeKey === 'GET /v1/accounts/{user_id}/balance' && method === 'GET') {
    return getBalancePage(userId, event.queryStringParameters ?? {});
  }
  if (routeKey === 'POST /v1/accounts/{user_id}/balance' && method === 'POST') {
    return postAdjustment(userId, event.body);
  }
  return errorResponse(404, 'not_found', 'unknown route');
}

async function getBalancePage(
  userId: string,
  params: Record<string, string | undefined>,
): Promise<APIGatewayProxyResultV2> {
  let limit = 20;
  if (params.limit !== undefined) {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorResponse(400, 'invalid_request', 'limit must be an integer between 1 and 100');
    }
  }
  let cursor: string | undefined;
  if (params.cursor !== undefined) {
    try {
      JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
    } catch {
      return errorResponse(400, 'invalid_cursor', 'cursor is not a valid pagination token');
    }
    cursor = params.cursor;
  }

  const [balance, page] = await Promise.all([getBalance(userId), listLedgerByUser(userId, limit, cursor)]);
  return json(200, {
    balance_micro_usd: balance,
    min_balance_micro_usd: Number(requireEnv('MIN_BALANCE_MICRO_USD')),
    rates: billingRates(),
    entries: page.items.map(toLedgerEntry),
    ...(page.lastEvaluatedKey ? { next_cursor: page.lastEvaluatedKey } : {}),
  });
}

function toLedgerEntry(item: LedgerItem) {
  return {
    idem: item.idem,
    kind: item.kind,
    amount_micro_usd: item.amount_micro_usd,
    ...(item.task_id !== undefined ? { task_id: item.task_id } : {}),
    ...(item.instance_type !== undefined ? { instance_type: item.instance_type } : {}),
    ...(item.seconds !== undefined ? { seconds: item.seconds } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    created_at: item.created_at,
  };
}

async function postAdjustment(
  userId: string,
  rawBody: string | null | undefined,
): Promise<APIGatewayProxyResultV2> {
  let body: {
    amount_micro_usd?: unknown;
    idempotency_key?: unknown;
    description?: unknown;
  };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return errorResponse(400, 'invalid_request', 'request body is not valid JSON');
  }

  const amount = body.amount_micro_usd;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount === 0) {
    return errorResponse(400, 'invalid_request', 'amount_micro_usd must be a non-zero integer (micro-USD)');
  }
  const idempotencyKey = body.idempotency_key;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    return errorResponse(400, 'invalid_request', 'idempotency_key must be a string of 1-200 characters');
  }
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 200)) {
    return errorResponse(400, 'invalid_request', 'description must be a string of at most 200 characters');
  }

  await applyLedgerEntry(userId, amount, idempotencyKey, 'admin', {
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
  });
  return json(200, { balance_micro_usd: await getBalance(userId) });
}
