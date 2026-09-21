import { ulid } from 'ulid';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  clearWebhookEndpoint,
  getAccount,
  getWebhookEndpoint,
  NotFoundError,
  rotateWebhookSecret,
  setWebhookEndpoint,
  upsertAccount,
} from '../lib/accounts-repo.js';
import { generateWebhookSecret } from '../lib/api-keys.js';
import { json, errorResponse, authorizerUserId } from '../lib/http.js';
import { requireEnv } from '../lib/env.js';

const sqs = new SQSClient({});
/**
 * Webhook configuration for both surfaces (identical logic, different user
 * resolution):
 *   customer-authorizer routes:  /v1/webhook-endpoint[...]
 *   internal (dashboard) routes: /v1/accounts/{user_id}/webhook-endpoint[...]
 *
 * The signing secret is per-user, retrievable by the owner (Stripe-style) and
 * rotatable. `https:` only — customer webhooks must be TLS.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Internal routes name the user in the path; customer routes get it from
  // the customer authorizer context.
  const userId = event.pathParameters?.user_id ?? authorizerUserId(event) ?? undefined;
  if (typeof userId !== 'string' || userId.length === 0) {
    return errorResponse(502, 'internal_error', 'no user context for webhook endpoint');
  }
  const method = event.requestContext.http.method;
  const action = event.routeKey.split(' ').slice(1).join(' ').split('/').pop(); // 'endpoint' | 'rotate' | 'test'

  try {
    if (method === 'PUT' && action === 'webhook-endpoint') {
      return await putEndpoint(userId, event.body);
    }
    if (method === 'GET' && action === 'webhook-endpoint') {
      return await getEndpoint(userId);
    }
    if (method === 'DELETE' && action === 'webhook-endpoint') {
      await clearWebhookEndpoint(userId);
      return { statusCode: 204 };
    }
    if (method === 'POST' && action === 'rotate') {
      return await rotate(userId);
    }
    if (method === 'POST' && action === 'test') {
      return await test(userId);
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      return errorResponse(404, 'not_configured', 'no webhook endpoint configured');
    }
    throw err;
  }
  return errorResponse(404, 'not_found', 'unknown route');
}

async function putEndpoint(
  userId: string,
  rawBody: string | null | undefined,
): Promise<APIGatewayProxyResultV2> {
  let url: string;
  try {
    const body = JSON.parse(rawBody ?? '{}');
    url = body?.url;
  } catch {
    return errorResponse(400, 'invalid_request', 'request body is not valid JSON');
  }
  if (typeof url !== 'string') {
    return errorResponse(400, 'invalid_request', 'url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return errorResponse(400, 'invalid_request', 'url is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    return errorResponse(400, 'invalid_request', 'url must be an https URL');
  }

  const account = await getAccount(userId);
  const existingSecret = account?.webhook_secret;
  // Create-on-first-config, so webhook setup works before any key exists.
  if (!account) {
    await upsertAccount(userId);
  }
  const newSecret = existingSecret ?? generateWebhookSecret();
  await setWebhookEndpoint(userId, url, existingSecret ? undefined : newSecret);

  // The secret is echoed only when it was just created (PUT/rotate show-once).
  return json(200, {
    url,
    ...(existingSecret ? {} : { secret: newSecret }),
  });
}

async function getEndpoint(userId: string): Promise<APIGatewayProxyResultV2> {
  const endpoint = await getWebhookEndpoint(userId);
  if (!endpoint) {
    return errorResponse(404, 'not_configured', 'no webhook endpoint configured');
  }
  // Owner-only path; secret retrievable by design (documented in the dashboard).
  return json(200, { url: endpoint.url, secret: endpoint.secret });
}

async function rotate(userId: string): Promise<APIGatewayProxyResultV2> {
  const endpoint = await getWebhookEndpoint(userId);
  if (!endpoint) {
    return errorResponse(404, 'not_configured', 'no webhook endpoint configured');
  }
  const secret = generateWebhookSecret();
  await rotateWebhookSecret(userId, secret);
  return json(200, { secret });
}

async function test(userId: string): Promise<APIGatewayProxyResultV2> {
  const endpoint = await getWebhookEndpoint(userId);
  if (!endpoint) {
    return errorResponse(409, 'not_configured', 'configure a webhook endpoint before sending a test');
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: requireEnv('CUSTOMER_WEBHOOK_QUEUE_URL'),
      MessageBody: JSON.stringify({
        event: 'ping',
        event_id: ulid(),
        user_id: userId,
        timestamp: new Date().toISOString(),
      }),
    }),
  );
  return json(202, { queued: true });
}
