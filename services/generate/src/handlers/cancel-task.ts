import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { isTerminal, toApiTask } from '../lib/types.js';
import { json, errorResponse } from '../lib/http.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';

const sfn = new SFNClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const taskId = event.pathParameters?.id;
  if (!taskId) {
    return errorResponse(400, 'invalid_request', 'task id path parameter is required');
  }
  const task = await getTask(taskId);
  if (!task) {
    return errorResponse(404, 'not_found', 'no such task');
  }
  if (isTerminal(task.status)) {
    return json(200, toApiTask(task));
  }

  if (task.execution_arn) {
    try {
      await sfn.send(
        new StopExecutionCommand({
          executionArn: task.execution_arn,
          cause: 'canceled via POST /v1/tasks/{id}/cancel',
        }),
      );
    } catch (err) {
      // Execution may already be finished; cancellation of the record still applies.
      console.warn('StopExecution failed', { taskId, err });
    }
  }

  const updated = await updateTask(taskId, {
    status: 'CANCELED',
    finished_at: new Date().toISOString(),
  });
  await enqueueWebhook(updated);
  return json(200, toApiTask(updated));
}
