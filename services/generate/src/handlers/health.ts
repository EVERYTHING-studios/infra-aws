import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { json } from '../lib/http.js';

export async function handler(): Promise<APIGatewayProxyResultV2> {
  return json(200, { ok: true });
}
