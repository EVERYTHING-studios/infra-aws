import { ulid } from 'ulid';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { validateCreateJob, ValidationError } from '../lib/validate.js';
import {
  findByIdempotencyKey,
  getTask,
  putTask,
  ttlFromNow,
  updateTask,
} from '../lib/tasks-repo.js';
import { TaskRecord } from '../lib/types.js';
import { json, errorResponse, authorizerUserId } from '../lib/http.js';
import { requireEnv } from '../lib/env.js';
import { isDataUri, offloadDataUri } from '../lib/data-uris.js';

const sfn = new SFNClient({});

/**
 * POST /v1/jobs — customer API render job creation. Mirrors create-task but:
 *  - user identity comes from the customer authorizer context (per-user key),
 *  - output hints are synthesized (job_id = fresh ULID), never client-chosen,
 *  - idempotency is scoped per user,
 *  - the task is marked source: 'api' so listings/webhooks route to the
 *    customer surfaces. API jobs do not consume credits and create no
 *    Supabase rows — usage billing is future work.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = authorizerUserId(event);
  if (!userId) {
    // The customer authorizer always sets user_id; absence is a wiring fault.
    return errorResponse(502, 'internal_error', 'authorizer context missing user_id');
  }

  let request;
  try {
    request = validateCreateJob(JSON.parse(event.body ?? '{}'));
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
    const existing = await findByIdempotencyKey(request.idempotency_key, userId);
    if (existing) {
      return json(202, { job_id: existing.task_id });
    }
  }

  // Refine jobs chain onto a succeeded preview job owned by the same user.
  // 404 (never 403) on any mismatch — no cross-user existence leak.
  let parent: TaskRecord | null = null;
  if (request.type === 'text-to-3d-refine') {
    parent = await getTask(request.input.preview_task_id!);
    if (!parent || parent.source !== 'api' || parent.user_id !== userId) {
      return errorResponse(404, 'parent_not_found', 'preview_task_id does not reference a known job');
    }
    if (parent.status !== 'SUCCEEDED') {
      return errorResponse(409, 'parent_not_ready', `preview job is ${parent.status}, expected SUCCEEDED`);
    }
  }

  // Offload inline data-URI images to S3 before persisting: the task record
  // must hold a durable s3:// ref, never megabytes of base64 (DynamoDB item
  // cap is 400 KB). Runs after the idempotency check so replays don't re-upload.
  const taskId = ulid();
  const imageUrls = request.input.image_urls;
  if (imageUrls) {
    request.input.image_urls = await Promise.all(
      imageUrls.map((url, index) =>
        isDataUri(url) ? offloadDataUri(url, `tasks/${taskId}/uploads/${index}`) : url,
      ),
    );
  }

  const now = new Date();
  const record: TaskRecord = {
    task_id: taskId,
    type: request.type,
    status: 'PENDING',
    progress: 0,
    input: request.input,
    options: request.options ?? {},
    user_id: userId,
    job_id: ulid(), // synthesized; finalize lands at {ASSETS_BASE_URL}/model-assets/{user_id}/{job_id}.glb
    parent_task_id: parent?.task_id,
    artifact_prefix: parent?.artifact_prefix,
    idempotency_key: request.idempotency_key,
    source: 'api',
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

  return json(202, { job_id: record.task_id });
}
