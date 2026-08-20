import { timingSafeEqual } from 'node:crypto';
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';
import { getSecret } from '../lib/secrets.js';
import { requireEnv } from '../lib/env.js';

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> {
  const presented = event.headers?.['x-api-key'];
  if (!presented) {
    return { isAuthorized: false };
  }
  const expected = await getSecret(requireEnv('API_KEY_SECRET_ARN'));
  return { isAuthorized: constantTimeEquals(presented, expected) };
}
