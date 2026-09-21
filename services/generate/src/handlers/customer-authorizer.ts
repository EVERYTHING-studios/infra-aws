import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { getApiKey, touchLastUsed } from '../lib/accounts-repo.js';
import { parseApiKey, sha256Hex, constantTimeEquals } from '../lib/api-keys.js';

/**
 * Wire format for HTTP API request authorizers with simple responses:
 * { isAuthorized, context } — context values must be string/number/bool.
 * (This aws-lambda version lacks the response type, hence the local one.)
 */
interface CustomerAuthorizerResponse {
  isAuthorized: boolean;
  context?: Record<string, string | number | boolean>;
}

/**
 * Request authorizer for customer API routes. Accepts the per-user API key as
 * either `Authorization: Bearer esk_...` or `x-api-key: esk_...`. The token's
 * key_id is the public lookup handle; the secret is verified against the
 * stored sha256 hash in constant time. Revoked keys are rejected immediately;
 * the API Gateway authorizer cache means revocation can take up to 300 s to
 * propagate (documented in the dashboard copy).
 */
export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<CustomerAuthorizerResponse> {
  const authHeader = event.headers?.['authorization'] ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const token = event.headers?.['x-api-key'] ?? bearer;
  if (!token) {
    return { isAuthorized: false };
  }

  const parsed = parseApiKey(token);
  if (!parsed) {
    return { isAuthorized: false };
  }

  const key = await getApiKey(parsed.key_id);
  if (!key || key.status !== 'active') {
    return { isAuthorized: false };
  }
  if (!constantTimeEquals(sha256Hex(parsed.secret), key.key_hash)) {
    return { isAuthorized: false };
  }

  // Best-effort last-used touch; never block auth on it.
  touchLastUsed(key.key_id).catch((err) => {
    console.warn(`Failed to update last_used_at for key ${key.key_id}`, err);
  });

  return {
    isAuthorized: true,
    context: { user_id: key.user_id, key_id: key.key_id },
  };
}
