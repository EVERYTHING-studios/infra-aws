import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';
import { requireEnv } from '../lib/env.js';
import { MAX_FETCH_IMAGE_BYTES } from '../lib/data-uris.js';

const s3 = new S3Client({});

interface PrepareInput {
  task_id: string;
}

export interface PipelineContext {
  task_id: string;
  postprocess: string;
}

/**
 * First pipeline state: mark the task running, stage any input images into
 * the work bucket, and hand the pipeline configuration to the next states.
 */
export async function handler(event: PrepareInput): Promise<PipelineContext> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }
  if (task.status === 'CANCELED') {
    throw new Error(`Task ${event.task_id} was canceled`);
  }

  const workBucket = requireEnv('WORK_BUCKET');
  const artifactPrefix = task.artifact_prefix ?? `tasks/${task.task_id}`;

  // Stage input images so inference reads only from our own bucket.
  const imageUrls = task.input.image_urls ?? [];
  for (const [index, url] of imageUrls.entries()) {
    if (url.startsWith('s3://')) {
      const parsed = new URL(url);
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: parsed.hostname, Key: decodeURIComponent(parsed.pathname.slice(1)) }),
      );
      const body = Buffer.from(await obj.Body!.transformToByteArray());
      await s3.send(
        new PutObjectCommand({
          Bucket: workBucket,
          Key: `${artifactPrefix}/input/${index}`,
          Body: body,
          ContentType: obj.ContentType ?? 'application/octet-stream',
        }),
      );
      continue;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch input image ${index}: HTTP ${response.status}`);
    }
    const declaredBytes = Number(response.headers.get('content-length') ?? '0');
    if (declaredBytes > MAX_FETCH_IMAGE_BYTES) {
      throw new Error(`input image ${index} is ${declaredBytes} bytes, exceeding the ${MAX_FETCH_IMAGE_BYTES} byte limit`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    await s3.send(
      new PutObjectCommand({
        Bucket: workBucket,
        Key: `${artifactPrefix}/input/${index}`,
        Body: body,
        ContentType: response.headers.get('content-type') ?? 'application/octet-stream',
      }),
    );
  }

  const updated = await updateTask(task.task_id, {
    status: 'IN_PROGRESS',
    progress: 5,
    artifact_prefix: artifactPrefix,
    inference_backend: process.env.INFERENCE_BACKEND ?? 'stub',
  });
  await enqueueWebhook(updated);

  return {
    task_id: task.task_id,
    postprocess: process.env.POSTPROCESS_MODE ?? 'lite',
  };
}
