import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getTask } from '../lib/tasks-repo.js';
import { toApiTask } from '../lib/types.js';
import { json, errorResponse, authorizerUserId } from '../lib/http.js';

/**
 * GET /v1/jobs/{id} — customer API. Only API-created jobs owned by the
 * caller are visible; everything else is a uniform 404 (never 403 — no
 * cross-user existence leak).
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = authorizerUserId(event);
  if (!userId) {
    return errorResponse(502, 'internal_error', 'authorizer context missing user_id');
  }
  const task = await getTask(event.pathParameters?.id ?? '');
  if (!task || task.source !== 'api' || task.user_id !== userId) {
    return errorResponse(404, 'not_found', 'job not found');
  }

  return json(200, toApiTask(task));
}
