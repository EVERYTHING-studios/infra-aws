import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { ModelUrls } from '../lib/types.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';
import { requireEnv } from '../lib/env.js';
import type { PipelineContext } from './prepare.js';

const cloudfront = new CloudFrontClient({});

/**
 * Terminal success state: record CDN URLs, mark SUCCEEDED, invalidate the CDN
 * path (refine overwrites the preview's GLB key), and enqueue the webhook.
 */
export async function handler(event: PipelineContext): Promise<{ task_id: string }> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  const baseUrl = requireEnv('ASSETS_BASE_URL').replace(/\/$/, '');
  const prefix = `model-assets/${task.user_id}/${task.job_id}`;
  const modelUrls: ModelUrls = { glb: `${baseUrl}/${prefix}.glb` };

  // The Fargate post-process emits extra formats alongside the GLB; the lite
  // path emits GLB only. URLs are convention-based either way.
  for (const format of task.options.formats ?? []) {
    if (format !== 'glb') {
      modelUrls[format] = `${baseUrl}/${prefix}.${format}`;
    }
  }

  const distributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
  if (distributionId) {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `${task.task_id}-${Date.now()}`,
          Paths: { Quantity: 1, Items: [`/${prefix}*`] },
        },
      }),
    );
  }

  const updated = await updateTask(task.task_id, {
    status: 'SUCCEEDED',
    progress: 100,
    model_urls: modelUrls,
    thumbnail_url: `${baseUrl}/${prefix}-thumbnail.jpg`,
    finished_at: new Date().toISOString(),
  });

  await enqueueWebhook(updated);
  return { task_id: task.task_id };
}
