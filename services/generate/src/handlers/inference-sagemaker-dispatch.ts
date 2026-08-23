import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } from '@aws-sdk/client-sagemaker-runtime';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';

const s3 = new S3Client({});
const sagemaker = new SageMakerRuntimeClient({});
/**
 * SageMaker inference dispatcher. Invoked by the state machine's
 * `lambda:invoke.waitForTaskToken` Inference state with the pipeline context
 * plus the Step Functions task token. It stages the input image into the
 * SageMaker async input bucket, kicks off `InvokeEndpointAsync` (InferenceId =
 * task_id), persists the task token on the task record so the callback can
 * recover it, and returns immediately — it does NOT wait for inference.
 *
 * The state machine stays parked on the task token until the callback Lambda
 * calls SendTaskSuccess/SendTaskFailure.
 */
export interface DispatchInput {
  task_id: string;
  postprocess: string;
  task_token: string;
}

export async function handler(event: DispatchInput): Promise<{ dispatched: true }> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  const workBucket = requireEnv('WORK_BUCKET');
  const inputBucket = requireEnv('SAGEMAKER_INPUT_BUCKET');
  const endpointName = requireEnv('SAGEMAKER_ENDPOINT_NAME');
  const artifactPrefix = task.artifact_prefix ?? `tasks/${task.task_id}`;

  // Stage the input image (prepare writes tasks/{task_id}/input/0) into the
  // SageMaker input bucket at a stable key, then point InvokeEndpointAsync at
  // it. The container reads raw image bytes from the request body.
  const sourceKey = `${artifactPrefix}/input/0`;
  const inputKey = `${artifactPrefix}/input.png`;
  await s3.send(
    new CopyObjectCommand({
      Bucket: inputBucket,
      Key: inputKey,
      CopySource: `${workBucket}/${sourceKey}`,
      ContentType: 'image/png',
      MetadataDirective: 'REPLACE',
    }),
  );

  // InferenceId = task_id (ULID, fits the <=128-char limit and is unique). The
  // callback recovers the task_id from the SNS notification's inferenceId, then
  // reads the task token from DynamoDB.
  await sagemaker.send(
    new InvokeEndpointAsyncCommand({
      EndpointName: endpointName,
      InputLocation: `s3://${inputBucket}/${inputKey}`,
      InferenceId: task.task_id,
      InvocationTimeoutSeconds: 3600,
    }),
  );

  // Persist the task token so the callback can resume the state machine.
  await updateTask(task.task_id, {
    sagemaker_task_token: event.task_token,
    progress: 25,
  });

  return { dispatched: true };
}
