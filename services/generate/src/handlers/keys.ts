import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getApiKey,
  listKeysByUser,
  NotFoundError,
  putApiKey,
  revokeApiKey,
  upsertAccount,
} from '../lib/accounts-repo.js';
import { generateApiKey } from '../lib/api-keys.js';
import { json, errorResponse } from '../lib/http.js';

/**
 * Internal key-management routes (shared-key authorizer; called by the
 * web-app dashboard backend only, never by end users):
 *   POST   /v1/accounts/{user_id}/keys          create — returns the token once
 *   GET    /v1/accounts/{user_id}/keys          list (never hashes/tokens)
 *   DELETE /v1/accounts/{user_id}/keys/{key_id} revoke
 *
 * user_id is always taken from the path, never the body. The subscription
 * gate is the web-app's responsibility; infra trusts the proxy.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = event.pathParameters?.user_id;
  if (!userId) {
    return errorResponse(400, 'invalid_request', 'missing user_id path parameter');
  }
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;

  if (routeKey === 'POST /v1/accounts/{user_id}/keys' && method === 'POST') {
    return createKey(userId, event.body);
  }
  if (routeKey === 'GET /v1/accounts/{user_id}/keys' && method === 'GET') {
    return listKeys(userId);
  }
  if (routeKey === 'DELETE /v1/accounts/{user_id}/keys/{key_id}' && method === 'DELETE') {
    return deleteKey(userId, event.pathParameters?.key_id);
  }
  return errorResponse(404, 'not_found', 'unknown route');
}

async function createKey(userId: string, rawBody: string | null | undefined): Promise<APIGatewayProxyResultV2> {
  let label: string | undefined;
  try {
    const body = rawBody ? JSON.parse(rawBody) : {};
    if (typeof body !== 'object' || body === null) {
      throw new SyntaxError();
    }
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || body.label.length > 100) {
        return errorResponse(400, 'invalid_request', 'label must be a string of at most 100 characters');
      }
      label = body.label;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return errorResponse(400, 'invalid_request', 'request body is not valid JSON');
    }
    throw err;
  }

  const generated = generateApiKey();
  await upsertAccount(userId); // create-on-first-key
  await putApiKey({
    key_id: generated.key_id,
    user_id: userId,
    key_hash: generated.key_hash,
    ...(label !== undefined ? { label } : {}),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  // The plaintext token is returned exactly once and never stored.
  return json(201, {
    key_id: generated.key_id,
    key: generated.token,
    ...(label !== undefined ? { label } : {}),
    created_at: new Date().toISOString(),
  });
}

async function listKeys(userId: string): Promise<APIGatewayProxyResultV2> {
  const keys = await listKeysByUser(userId);
  return json(200, {
    keys: keys.map((key) => ({
      key_id: key.key_id,
      label: key.label ?? null,
      status: key.status,
      created_at: key.created_at,
      last_used_at: key.last_used_at ?? null,
    })),
  });
}

async function deleteKey(
  userId: string,
  keyId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!keyId) {
    return errorResponse(400, 'invalid_request', 'missing key_id path parameter');
  }
  const key = await getApiKey(keyId);
  if (!key || key.user_id !== userId) {
    return errorResponse(404, 'not_found', 'key not found');
  }
  try {
    await revokeApiKey(keyId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return errorResponse(404, 'not_found', 'key not found');
    }
    throw err;
  }
  return { statusCode: 204 };
}
