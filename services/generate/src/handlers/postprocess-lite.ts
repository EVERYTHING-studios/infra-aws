import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S3Client, CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import type { PipelineContext } from './prepare.js';

const s3 = new S3Client({});

/**
 * Lightweight post-process used until the Fargate/Blender path is enabled:
 * promotes the raw GLB from the work bucket to the model-assets bucket at the
 * web-app's key convention and writes a placeholder thumbnail. No format
 * conversion — GLB only.
 */
export async function handler(event: PipelineContext): Promise<PipelineContext> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  const workBucket = requireEnv('WORK_BUCKET');
  const assetsBucket = requireEnv('ASSETS_BUCKET');
  const glbKey = `model-assets/${task.user_id}/${task.job_id}.glb`;
  const thumbnailKey = `model-assets/${task.user_id}/${task.job_id}-thumbnail.jpg`;

  await s3.send(
    new CopyObjectCommand({
      Bucket: assetsBucket,
      Key: glbKey,
      CopySource: `${workBucket}/${task.artifact_prefix}/raw/model.glb`,
      ContentType: 'model/gltf-binary',
      MetadataDirective: 'REPLACE',
    }),
  );

  const thumbnailPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'thumbnail.jpg');
  await s3.send(
    new PutObjectCommand({
      Bucket: assetsBucket,
      Key: thumbnailKey,
      Body: await readFile(thumbnailPath),
      ContentType: 'image/jpeg',
    }),
  );

  return event;
}
