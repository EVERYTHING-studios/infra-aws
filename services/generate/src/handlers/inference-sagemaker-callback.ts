import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import type { SNSEvent, SNSEventRecord } from 'aws-lambda';

const s3 = new S3Client({});
const sfn = new SFNClient({});

/**
 * SageMaker inference callback. Subscribed to the endpoint's success and error
 * SNS topics. SageMaker's async notification message carries `inferenceId`
 * (which the dispatcher set to the task_id) and, on success, the GLB
 * `outputLocation` in the output bucket.
 *
 * On success: copy the GLB to the pipeline contract location
 * (tasks/{task_id}/raw/model.glb in the work bucket) and call SendTaskSuccess
 * with the pipeline context so the state machine resumes at ChoosePostProcess.
 *
 * On error: call SendTaskFailure so the state machine's Inference Catch routes
 * to FailTask (which marks the task FAILED and enqueues the webhook).
 */
interface AsyncNotification {
  invocationStatus?: string;
  inferenceId?: string;
  responseParameters?: { outputLocation?: string };
  failureLocation?: string;
}

export async function handler(event: SNSEvent): Promise<{ processed: number }> {
  let processed = 0;
  for (const record of event.Records ?? []) {
    await processRecord(record);
    processed += 1;
  }
  return { processed };
}

async function processRecord(record: SNSEventRecord): Promise<void> {
  const message = parseMessage(record.Sns.Message);

  const taskId = message.inferenceId;
  if (!taskId) {
    console.error('SageMaker notification missing inferenceId', JSON.stringify(message));
    return;
  }

  const task = await getTask(taskId);
  if (!task) {
    console.error(`Task ${taskId} not found for SageMaker notification`);
    return;
  }

  const taskToken = task.sagemaker_task_token;
  if (!taskToken) {
    console.error(`Task ${taskId} has no sagemaker_task_token; cannot resume state machine`);
    return;
  }

  const status = (message.invocationStatus ?? '').toLowerCase();
  if (status === 'completed') {
    await handleSuccess(taskId, task.artifact_prefix, taskToken, message);
  } else {
    await handleFailure(taskId, taskToken, message);
  }
}

async function handleSuccess(
  taskId: string,
  artifactPrefix: string | undefined,
  taskToken: string,
  message: AsyncNotification,
): Promise<void> {
  const outputLocation = message.responseParameters?.outputLocation;
  if (!outputLocation) {
    await fail(taskToken, 'InferenceCompleted', 'SageMaker success notification had no outputLocation');
    return;
  }

  const { bucket, key } = parseS3Uri(outputLocation);
  const glb = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!glb.Body) {
    await fail(taskToken, 'InferenceCompleted', `Empty GLB body at ${outputLocation}`);
    return;
  }
  const body = Buffer.from(await glb.Body.transformToByteArray());

  const workBucket = requireEnv('WORK_BUCKET');
  const prefix = artifactPrefix ?? `tasks/${taskId}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: workBucket,
      Key: `${prefix}/raw/model.glb`,
      Body: body,
      ContentType: 'model/gltf-binary',
    }),
  );

  await updateTask(taskId, { progress: 90 });

  // The next state (ChoosePostProcess) reads $.postprocess. postprocess is a
  // deployment-level constant (set by prepare from POSTPROCESS_MODE), so the
  // callback reconstructs it from the same env var.
  const postprocess = process.env.POSTPROCESS_MODE ?? 'lite';
  await sfn.send(
    new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ task_id: taskId, postprocess }),
    }),
  );
}

async function handleFailure(
  taskId: string,
  taskToken: string,
  message: AsyncNotification,
): Promise<void> {
  let cause = `SageMaker inference failed (status: ${message.invocationStatus ?? 'unknown'})`;
  if (message.failureLocation) {
    try {
      const { bucket, key } = parseS3Uri(message.failureLocation);
      const failureObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (failureObj.Body) {
        const text = await failureObj.Body.transformToString();
        cause = text.slice(0, 1000);
      }
    } catch (err) {
      console.error('Failed to read SageMaker failureLocation', err);
    }
  }
  console.error(`Task ${taskId} inference failed: ${cause}`);
  await fail(taskToken, 'InferenceFailed', cause);
}

async function fail(taskToken: string, error: string, cause: string): Promise<void> {
  await sfn.send(
    new SendTaskFailureCommand({
      taskToken,
      error,
      cause,
    }),
  );
}

function parseMessage(raw: string): AsyncNotification {
  try {
    return JSON.parse(raw) as AsyncNotification;
  } catch {
    console.error('Failed to parse SageMaker SNS message as JSON', raw);
    return {};
  }
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const url = new URL(uri);
  return { bucket: url.host, key: decodeURIComponent(url.pathname.slice(1)) };
}
