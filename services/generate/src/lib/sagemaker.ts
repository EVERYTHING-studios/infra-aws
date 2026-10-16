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
 *
 * Also home to the chain's capacity-snapshot helpers: the sentinel publishes
 * each chain's per-endpoint classes every minute and the dispatcher spreads
 * new work across every non-FAILED pool while the chain has no HEALTHY entry
 * (see ChainCapacityState / pickSpreadEndpoint).
 */

import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
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
 * One chain's capacity snapshot, published every minute by the capacity
 * sentinel to that chain's capacity SSM parameter and read by the
 * dispatcher. `classes` is keyed by endpoint NAME (unique per region x type,
 * the same key `active_endpoint` stores); `no_healthy` means no entry of the
 * chain can serve right now, so new work is spread across the pools that are
 * still trying instead of piling onto one.
 */
export type CapacityClass = 'FAILED' | 'DROUGHT' | 'PROVISIONING' | 'HEALTHY';
export interface ChainCapacityState {
  at: string;
  no_healthy: boolean;
  classes: Record<string, CapacityClass>;
}

/**
 * Parse the sentinel's capacity snapshot. Unset, empty, unparseable, or
 * structurally invalid input returns undefined, and the caller then falls
 * back to the elected endpoint (the pre-spread behaviour) — a malformed or
 * missing snapshot can never break a dispatch.
 */
export function parseChainCapacityState(raw: string | undefined): ChainCapacityState | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { at, no_healthy, classes } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return undefined;
  if (typeof no_healthy !== 'boolean') return undefined;
  if (typeof classes !== 'object' || classes === null) return undefined;
  return { at, no_healthy, classes: classes as Record<string, CapacityClass> };
}

/**
 * A snapshot older than `maxAgeMs` is ignored: if the sentinel stops writing
 * (Lambda failure, ssm:PutParameter denied) the dispatcher reverts to the
 * single elected endpoint rather than spreading on stale evidence.
 */
export function chainCapacityIsFresh(state: ChainCapacityState, maxAgeMs = 5 * 60 * 1000): boolean {
  return Date.now() - Date.parse(state.at) <= maxAgeMs;
}

/**
 * Deterministic placement across every pool the chain has not written off.
 * DROUGHT and PROVISIONING pools are eligible on purpose: during a
 * chain-wide drought every pool still asking AWS for capacity should hold a
 * share of the backlog, so whichever one is granted capacity drains
 * immediately. This is placement, never duplication — the task is invoked at
 * exactly one endpoint, so there is no copy left behind to withdraw (a
 * queued async request cannot be cancelled).
 *
 * Same task id always lands on the same pool, so a retry of the same task
 * does not fan out across the chain.
 */
export function pickSpreadEndpoint(
  configs: EndpointConfig[],
  state: ChainCapacityState,
  taskId: string,
): EndpointConfig {
  // Unknown/absent class keys count as non-FAILED (fail-open): a chain entry
  // added between the sentinel's write and this read is dispatched to rather
  // than dead-ended.
  const eligible = configs.filter((c) => state.classes[c.endpointName] !== 'FAILED');
  // An empty eligible list makes the modulo NaN, so the lookup is undefined
  // for both "every entry is FAILED" and (unreachably) an out-of-range index.
  const picked = eligible[sumOfCharCodes(taskId) % eligible.length];
  if (!picked) {
    throw new Error('No dispatchable endpoint in chain (every entry is FAILED)');
  }
  return picked;
}

/** Stable spread hash: same task id -> same pool, across runs and regions. */
function sumOfCharCodes(value: string): number {
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) sum += value.charCodeAt(i);
  return sum;
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
export async function dispatchToRegion(task: TaskRecord, conf: EndpointConfig): Promise<void> {
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
