import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getTask } from '../lib/tasks-repo.js';
import { toApiTask } from '../lib/types.js';
import { json, errorResponse } from '../lib/http.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const taskId = event.pathParameters?.id;
  if (!taskId) {
    return errorResponse(400, 'invalid_request', 'task id path parameter is required');
  }
  const task = await getTask(taskId);
  if (!task) {
    return errorResponse(404, 'not_found', 'no such task');
  }
  return json(200, toApiTask(task));
}
