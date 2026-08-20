import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import type { PipelineContext } from './prepare.js';

const s3 = new S3Client({});

/**
 * Stub inference backend: simulates a model run by walking progress forward
 * and writing a fixture GLB to the work bucket at the same location the real
 * backend will (tasks/{task_id}/raw/model.glb). Lets the whole pipeline —
 * post-process, finalize, webhooks, web-app integration — be exercised E2E
 * before SageMaker lands.
 */
export async function handler(event: PipelineContext): Promise<PipelineContext> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  for (const progress of [25, 50, 75]) {
    await sleep(2000);
    await updateTask(task.task_id, { progress });
  }

  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub.glb');
  const glb = await readFile(fixturePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: requireEnv('WORK_BUCKET'),
      Key: `${task.artifact_prefix}/raw/model.glb`,
      Body: glb,
      ContentType: 'model/gltf-binary',
    }),
  );

  return event;
}
