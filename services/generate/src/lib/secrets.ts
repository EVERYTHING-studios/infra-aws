import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetch a secret string, cached across warm invocations. */
export async function getSecret(secretArn: string): Promise<string> {
  const cached = cache.get(secretArn);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }
  cache.set(secretArn, { value: result.SecretString, fetchedAt: Date.now() });
  return result.SecretString;
}
