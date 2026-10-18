/**
 * Shared SageMaker multi-endpoint dispatch helpers.
 *
 * The inference stack deploys one async endpoint per (region x instance
 * type) in every candidate region (see
 * modules/generate-inference/sagemaker-region), and the capacity sentinel
 * elects the active endpoint from the configured cold-price chain. The
 * dispatcher and the capacity sentinel both stage a task's input into the
 * elected endpoint's regional input bucket and invoke that endpoint, so
 * the staging + invoke pair lives here once.
 */

import { S3Client, CopyObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } from '@aws-sdk/client-sagemaker-runtime';
import type { TaskRecord } from './types.js';
import { requireEnv } from './env.js';

/**
 * Single async endpoint entry. `variantName` is the SageMaker production
 * variant on that endpoint ('trellis' on every v1 endpoint, 'pixal3d' on
 * every v2 endpoint — set in the sagemaker-region Terraform module); it keys
 * the autoscaling ResourceId when the sentinel inspects scaling activities.
 */
export interface EndpointConfig {
  region: string;
  instanceType: string;
  endpointName: string;
  inputBucket: string;
  variantName: string;
}

/**
 * Parse a chain's endpoint list env (JSON array of endpoint entries):
 * `[{"region":"us-east-1","instanceType":"g5","endpointName":"...","inputBucket":"...","variantName":"trellis"}]`.
 * Array order = the configured chain priority (type-major: instance types in
 * cold-price chain order from the env tfvars, regions in
 * sagemaker_candidate_regions priority order within each type). `variantName`
 * defaults to 'trellis' when absent (pre-v2 env shapes).
 *
 * Used for the v1 chain (`SAGEMAKER_ENDPOINTS`, always configured) and the
 * v2 chain (`SAGEMAKER_ENDPOINTS_PIXAL3D`) — the duplicate (region,
 * instanceType) check is per chain, so the two chains' overlapping
 * (region, type) pairs are fine.
 */
export function parseEndpointConfig(raw: string): EndpointConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SAGEMAKER_ENDPOINTS is not valid JSON: ${raw}`);
  }
  return parseEndpointEntries(parsed);
}

/**
 * Optional-chain variant: unset, empty, or `[]` env means the chain is not
 * deployed (e.g. SAGEMAKER_ENDPOINTS_PIXAL3D on a v2-off environment, where
 * Terraform emits an empty JSON array).
 */
export function parseOptionalEndpointConfig(raw: string | undefined): EndpointConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SAGEMAKER_ENDPOINTS is not valid JSON: ${raw}`);
  }
  if (Array.isArray(parsed) && parsed.length === 0) return [];
  return parseEndpointEntries(parsed);
}

function parseEndpointEntries(parsed: unknown): EndpointConfig[] {
  if (!Array.isArray(parsed)) {
    throw new Error(
      `SAGEMAKER_ENDPOINTS must be a JSON array of {region, instanceType, endpointName, inputBucket} entries: ${JSON.stringify(parsed)}`,
    );
  }
  const configs = parsed.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(
        `SAGEMAKER_ENDPOINTS entries must be objects with region, instanceType, endpointName and inputBucket: ${JSON.stringify(value)}`,
      );
    }
    const { region, instanceType, endpointName, inputBucket, variantName } = value as Record<string, unknown>;
    if (
      typeof region !== 'string' ||
      typeof instanceType !== 'string' ||
      typeof endpointName !== 'string' ||
      typeof inputBucket !== 'string'
    ) {
      throw new Error(
        `SAGEMAKER_ENDPOINTS entry is missing string region/instanceType/endpointName/inputBucket: ${JSON.stringify(value)}`,
      );
    }
    if (variantName !== undefined && typeof variantName !== 'string') {
      throw new Error(`SAGEMAKER_ENDPOINTS entry variantName must be a string: ${JSON.stringify(value)}`);
    }
    return { region, instanceType, endpointName, inputBucket, variantName: variantName ?? 'trellis' };
  });
  // Duplicate (region, instanceType) pairs are misconfiguration — the same
  // type deployed twice in one region. Multiple entries per region are
  // EXPECTED (the chain deploys g5/g6e/g7e in each candidate region).
  const dupes = configs.filter(
    (c, i) => configs.findIndex((o) => o.region === c.region && o.instanceType === c.instanceType) !== i,
  );
  if (dupes.length > 0) {
    throw new Error(
      `SAGEMAKER_ENDPOINTS contains duplicate (region, instanceType) pairs: ${dupes
        .map((c) => `${c.region}/${c.instanceType}`)
        .join(', ')}`,
    );
  }
  if (configs.length === 0) {
    throw new Error('SAGEMAKER_ENDPOINTS is empty');
  }
  return configs;
}

/**
 * Stage the task's input into the target region's SageMaker input bucket,
 * then start `InvokeEndpointAsync` against that region's endpoint.
 * `InferenceId = task_id` so the callback recovers the task from the SNS
 * notification.
 *
 * Two payload shapes:
 * - single-image (default, and every v1 request): copy `tasks/{id}/input/0`
 *   to `{prefix}/input.png` — the raw-image body the servers have always
 *   accepted;
 * - `multiview && image_urls.length > 1` (multi-image-to-3d on the v2
 *   chain): fetch EVERY staged view `tasks/{id}/input/{i}` from the work
 *   bucket (prepare stages all of them), base64 them into the JSON manifest
 *   the v2 server accepts (`{images, azimuths_deg}`, azimuths defaulted to
 *   90 * (i + 1) when the request omitted them), PutObject it as
 *   `{prefix}/input.json`, and point the invoke at that. Payload math:
 *   <= 4 staged images -> well under SageMaker's 1 GB async cap.
 *
 * The S3 and SageMaker clients are constructed per call with the target
 * region — the S3 client's region must match the destination bucket's
 * region, and InvokeEndpointAsync is regional.
 */
export async function dispatchToRegion(
  task: TaskRecord,
  conf: EndpointConfig,
  multiview: boolean = false,
): Promise<void> {
  const workBucket = requireEnv('WORK_BUCKET');
  const artifactPrefix = task.artifact_prefix ?? `tasks/${task.task_id}`;
  const s3 = new S3Client({ region: conf.region });

  const imageCount = task.input.image_urls?.length ?? 1;
  let inputKey: string;

  if (multiview && imageCount > 1) {
    const images: string[] = [];
    for (let i = 0; i < imageCount; i++) {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: workBucket,
          Key: `${artifactPrefix}/input/${i}`,
        }),
      );
      if (!res.Body) {
        throw new Error(`missing staged input ${artifactPrefix}/input/${i} in ${workBucket}`);
      }
      const bytes = await res.Body.transformToByteArray();
      images.push(Buffer.from(bytes).toString('base64'));
    }
    const azimuths =
      task.input.view_azimuths_deg ??
      Array.from({ length: imageCount - 1 }, (_, i) => 90 * (i + 1));
    inputKey = `${artifactPrefix}/input.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: conf.inputBucket,
        Key: inputKey,
        Body: JSON.stringify({ images, azimuths_deg: azimuths }),
        ContentType: 'application/json',
      }),
    );
  } else {
    inputKey = `${artifactPrefix}/input.png`;
    await s3.send(
      new CopyObjectCommand({
        Bucket: conf.inputBucket,
        Key: inputKey,
        CopySource: `${workBucket}/${artifactPrefix}/input/0`,
        ContentType: 'image/png',
        MetadataDirective: 'REPLACE',
      }),
    );
  }

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
