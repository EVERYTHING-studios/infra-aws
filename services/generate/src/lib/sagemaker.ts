/**
 * Shared SageMaker multi-region dispatch helpers.
 *
 * The inference stack is deployed in every candidate region (see
 * modules/generate-inference/sagemaker-region). The dispatcher and the
 * capacity sentinel both stage a task's input into the active region's
 * input bucket and invoke that region's endpoint, so the staging + invoke
 * pair lives here once.
 */

import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } from '@aws-sdk/client-sagemaker-runtime';
import type { TaskRecord } from './types.js';
import { requireEnv } from './env.js';

/** Single async endpoint variant name (set in the sagemaker-region Terraform module). */
export const VARIANT_NAME = 'trellis';

export interface RegionConfig {
  region: string;
  endpointName: string;
  inputBucket: string;
}

/**
 * Parse the `SAGEMAKER_REGIONS` env (JSON array of region entries):
 * `[{"region":"us-east-1","endpointName":"...","inputBucket":"..."}]`.
 * Array order = the configured failback priority (sagemaker_candidate_regions
 * order in the env tfvars; us-east-1 appended last when unlisted).
 */
export function parseRegionConfig(raw: string): RegionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SAGEMAKER_REGIONS is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `SAGEMAKER_REGIONS must be a JSON array of {region, endpointName, inputBucket} entries: ${raw}`,
    );
  }
  const configs = parsed.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(
        `SAGEMAKER_REGIONS entries must be objects with region, endpointName and inputBucket: ${JSON.stringify(value)}`,
      );
    }
    const { region, endpointName, inputBucket } = value as Record<string, unknown>;
    if (typeof region !== 'string' || typeof endpointName !== 'string' || typeof inputBucket !== 'string') {
      throw new Error(
        `SAGEMAKER_REGIONS entry is missing string region/endpointName/inputBucket: ${JSON.stringify(value)}`,
      );
    }
    return { region, endpointName, inputBucket };
  });
  const dupes = configs.filter((c, i) => configs.findIndex((o) => o.region === c.region) !== i);
  if (dupes.length > 0) {
    throw new Error(`SAGEMAKER_REGIONS contains duplicate regions: ${dupes.map((c) => c.region).join(', ')}`);
  }
  if (configs.length === 0) {
    throw new Error('SAGEMAKER_REGIONS is empty');
  }
  return configs;
}

/**
 * Stage the task's input image (prepare writes `tasks/{id}/input/0` in the
 * work bucket) into the target region's SageMaker input bucket, then start
 * `InvokeEndpointAsync` against that region's endpoint. `InferenceId =
 * task_id` so the callback recovers the task from the SNS notification.
 *
 * The S3 and SageMaker clients are constructed per call with the target
 * region — the S3 client's region must match the destination bucket's
 * region, and InvokeEndpointAsync is regional.
 */
export async function dispatchToRegion(task: TaskRecord, conf: RegionConfig): Promise<void> {
  const workBucket = requireEnv('WORK_BUCKET');
  const artifactPrefix = task.artifact_prefix ?? `tasks/${task.task_id}`;

  const sourceKey = `${artifactPrefix}/input/0`;
  const inputKey = `${artifactPrefix}/input.png`;
  const s3 = new S3Client({ region: conf.region });
  await s3.send(
    new CopyObjectCommand({
      Bucket: conf.inputBucket,
      Key: inputKey,
      CopySource: `${workBucket}/${sourceKey}`,
      ContentType: 'image/png',
      MetadataDirective: 'REPLACE',
    }),
  );

  const sagemaker = new SageMakerRuntimeClient({ region: conf.region });
  await sagemaker.send(
    new InvokeEndpointAsyncCommand({
      EndpointName: conf.endpointName,
      InputLocation: `s3://${conf.inputBucket}/${inputKey}`,
      InferenceId: task.task_id,
      InvocationTimeoutSeconds: 3600,
    }),
  );
}
