import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import type { SNSEvent, SNSEventRecord } from 'aws-lambda';

/** Default-region client (us-east-1): writes to the work bucket. */
const s3 = new S3Client({});
const sfn = new SFNClient({});

/**
 * SageMaker inference callback. Subscribed to the success and error SNS
 * topics of every candidate region's endpoint. SageMaker's async
 * notification message carries `inferenceId` (which the dispatcher set to
 * the task_id) and, on success, the GLB `outputLocation` in that region's
 * output bucket. The source region is parsed per record from
 * `record.EventSubscriptionArn` (`arn:aws:sns:<region>:...`), so callbacks
 * route correctly no matter which region's endpoint ran the inference or
 * when the sentinel last flipped the active region.
 *
 * On success: copy the GLB to the pipeline contract location
 * (tasks/{task_id}/raw/model.glb in the work bucket) and call SendTaskSuccess
 * with the pipeline context so the state machine resumes at ChoosePostProcess.
 *
 * On error: call SendTaskFailure so the state machine's Inference Catch routes
 * to FailTask (which marks the task FAILED and enqueues the webhook).
 *
 * Consumed-token guard: after a sentinel re-dispatch, a late duplicate
 * callback from the abandoned region can reference a task token that the
 * other region's callback already consumed. SFN then rejects
 * SendTaskSuccess/Failure with InvalidToken/TaskDoesNotExist/ResourceNotFound.
 * Those are logged no-ops — throwing would make SNS retry forever.
 */
interface AsyncNotification {
  invocationStatus?: string;
  inferenceId?: string;
  responseParameters?: { outputLocation?: string };
  failureLocation?: string;
}

/** SFN error names that mean "the task token was already consumed elsewhere". */
const CONSUMED_TOKEN_ERRORS = new Set(['InvalidToken', 'TaskDoesNotExist', 'ResourceNotFound']);

function isConsumedTokenError(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  if (CONSUMED_TOKEN_ERRORS.has(name)) return true;
  const message = `${name} ${(err as Error).message ?? ''}`;
  return /Invalid Token|Task does not exist|ResourceNotFound/i.test(message);
}

export async function handler(event: SNSEvent): Promise<{ processed: number }> {
  let processed = 0;
  for (const record of event.Records ?? []) {
    await processRecord(record);
    processed += 1;
  }
  return { processed };
}

/** Parse the SNS topic's region from the subscription ARN: arn:aws:sns:<region>:... */
function recordRegion(record: SNSEventRecord): string {
  const parts = record.EventSubscriptionArn?.split(':');
  const region = parts?.[3];
  if (!region) {
    throw new Error(`Cannot parse region from EventSubscriptionArn: ${record.EventSubscriptionArn}`);
  }
  return region;
}

async function processRecord(record: SNSEventRecord): Promise<void> {
  const message = parseMessage(record.Sns.Message);
  const region = recordRegion(record);

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
    await handleSuccess(taskId, task.artifact_prefix, taskToken, message, region);
  } else {
    await handleFailure(taskId, taskToken, message, region);
  }
}

async function handleSuccess(
  taskId: string,
  artifactPrefix: string | undefined,
  taskToken: string,
  message: AsyncNotification,
  region: string,
): Promise<void> {
  const outputLocation = message.responseParameters?.outputLocation;
  if (!outputLocation) {
    await fail(taskToken, 'InferenceCompleted', 'SageMaker success notification had no outputLocation');
    return;
  }

  // The output bucket lives in the region whose endpoint ran the inference.
  const s3Regional = new S3Client({ region });
  const { bucket, key } = parseS3Uri(outputLocation);
  const glb = await s3Regional.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
  try {
    await sfn.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ task_id: taskId, postprocess }),
      }),
    );
  } catch (err) {
    if (isConsumedTokenError(err)) {
      console.warn(`Task ${taskId}: task token already consumed (duplicate callback from ${region}); success is a no-op`);
    } else {
      throw err;
    }
  }
  // Token is cleared AFTER SendTaskSuccess so SNS retries can still recover it
  // if the SFN call throws. Once SendTaskSuccess succeeds, the token is unneeded.
  await updateTask(taskId, { remove: ['sagemaker_task_token'] });
}

async function handleFailure(
  taskId: string,
  taskToken: string,
  message: AsyncNotification,
  region: string,
): Promise<void> {
  let cause = `SageMaker inference failed (status: ${message.invocationStatus ?? 'unknown'})`;
  if (message.failureLocation) {
    try {
      const s3Regional = new S3Client({ region });
      const { bucket, key } = parseS3Uri(message.failureLocation);
      const failureObj = await s3Regional.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
  await updateTask(taskId, { remove: ['sagemaker_task_token'] });
}

async function fail(taskToken: string, error: string, cause: string): Promise<void> {
  try {
    await sfn.send(
      new SendTaskFailureCommand({
        taskToken,
        error,
        cause,
      }),
    );
  } catch (err) {
    if (isConsumedTokenError(err)) {
      console.warn(`Task token already consumed; failure callback is a no-op (${error}: ${cause})`);
    } else {
      throw err;
    }
  }
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
