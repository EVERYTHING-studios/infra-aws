import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { listApiTasksByUser } from '../lib/tasks-repo.js';
import { TASK_STATUSES, toApiTask } from '../lib/types.js';
import { json, errorResponse, authorizerUserId } from '../lib/http.js';

/**
 * GET /v1/jobs — customer API job list, newest first, cursor-paginated.
 * The cursor is the base64url-encoded JSON of the DynamoDB exclusive-start
 * key; `next_cursor` is omitted when the page is the last one.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = authorizerUserId(event);
  if (!userId) {
    return errorResponse(502, 'internal_error', 'authorizer context missing user_id');
  }

  const params = event.queryStringParameters ?? {};

  let status: string | undefined;
  if (params.status !== undefined) {
    status = params.status;
    if (!TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
      return errorResponse(400, 'invalid_request', `status must be one of: ${TASK_STATUSES.join(', ')}`);
    }
  }

  let limit = 20;
  if (params.limit !== undefined) {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorResponse(400, 'invalid_request', 'limit must be an integer between 1 and 100');
    }
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (params.cursor !== undefined) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
    } catch {
      return errorResponse(400, 'invalid_cursor', 'cursor is not a valid pagination token');
    }
  }

  const result = await listApiTasksByUser(userId, {
    ...(status ? { status: status as (typeof TASK_STATUSES)[number] } : {}),
    limit,
    ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
  });

  const nextCursor = result.lastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64url')
    : undefined;

  return json(200, {
    jobs: result.items.map(toApiTask),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  });
}
