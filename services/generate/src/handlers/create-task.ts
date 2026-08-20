import { ulid } from 'ulid';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { validateCreateTask, ValidationError } from '../lib/validate.js';
import {
  findByIdempotencyKey,
  getTask,
  putTask,
  ttlFromNow,
  updateTask,
} from '../lib/tasks-repo.js';
import { TaskRecord } from '../lib/types.js';
import { json, errorResponse } from '../lib/http.js';
import { requireEnv } from '../lib/env.js';

const sfn = new SFNClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let request;
  try {
    request = validateCreateTask(JSON.parse(event.body ?? '{}'));
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(400, 'invalid_request', err.message);
    }
    if (err instanceof SyntaxError) {
      return errorResponse(400, 'invalid_request', 'request body is not valid JSON');
    }
    throw err;
  }

  if (request.idempotency_key) {
    const existing = await findByIdempotencyKey(request.idempotency_key);
    if (existing) {
      return json(202, { task_id: existing.task_id });
    }
  }

  // Refine tasks chain onto a succeeded preview task and inherit its
  // artifacts and output destination.
  let parent: TaskRecord | null = null;
  if (request.type === 'text-to-3d-refine') {
    parent = await getTask(request.input.preview_task_id!);
    if (!parent) {
      return errorResponse(404, 'parent_not_found', 'preview_task_id does not reference a known task');
    }
    if (parent.status !== 'SUCCEEDED') {
      return errorResponse(409, 'parent_not_ready', `preview task is ${parent.status}, expected SUCCEEDED`);
    }
  }

  const now = new Date();
  const record: TaskRecord = {
    task_id: ulid(),
    type: request.type,
    status: 'PENDING',
    progress: 0,
    input: request.input,
    options: request.options ?? {},
    user_id: request.output?.user_id ?? parent!.user_id,
    job_id: request.output?.job_id ?? parent!.job_id,
    parent_task_id: parent?.task_id,
    artifact_prefix: parent?.artifact_prefix,
    idempotency_key: request.idempotency_key,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ttl: ttlFromNow(now),
  };

  await putTask(record);

  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: requireEnv('STATE_MACHINE_ARN'),
      name: record.task_id,
      input: JSON.stringify({ task_id: record.task_id }),
    }),
  );
  await updateTask(record.task_id, { execution_arn: execution.executionArn });

  return json(202, { task_id: record.task_id });
}
