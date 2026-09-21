import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SageMakerClient, DescribeEndpointCommand } from '@aws-sdk/client-sagemaker';
import {
  ApplicationAutoScalingClient,
  DescribeScalingActivitiesCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig, dispatchToRegion, VARIANT_NAME, type EndpointConfig } from '../lib/sagemaker.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';
import type { TaskRecord } from '../lib/types.js';

/** How recent a successful scale-up stays valid as capacity proof for failback. */
const PROOF_WINDOW_MS = 60 * 60 * 1000;
/** A scale-up in flight this long with zero instances is a drought, not provisioning. */
const STALE_PROVISIONING_MS = 15 * 60 * 1000;
const ssm = new SSMClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Capacity sentinel. Runs every minute (EventBridge, same rule as the
 * scaler). AWS exposes no "capacity availability" API for SageMaker — an
 * instance type's capacity in a region is only proven by real provisioning
 * attempts. This sentinel therefore watches live evidence from every
 * configured (region x instance type) endpoint + scaling activities and
 * elects the active endpoint automatically, in SAGEMAKER_ENDPOINTS order
 * (the cold-price chain: type-major, region-minor):
 *
 * Classification per endpoint:
 *   FAILED       endpoint status Failed (never self-heals; needs manual recreate)
 *   DROUGHT      desired >= 1 but current = 0 and the latest scaling activity
 *                ended Unfulfilled/Failed — proven no capacity
 *   PROVISIONING endpoint Creating/Updating, or a scale-up attempt in flight
 *   HEALTHY      InService and (current >= 1 or desired = 0) and not DROUGHT
 *
 * Election (candidate order in SAGEMAKER_ENDPOINTS = chain priority):
 *   1. Active is HEALTHY/PROVISIONING -> only flip to a HIGHER-priority
 *      (earlier in the chain) endpoint that is healthy-PROVEN (current >= 1
 *      or a recent Successful activity); an idle-unproven endpoint must not
 *      steal traffic and re-enter the capacity lottery.
 *   2. Active is DROUGHT/FAILED -> flip to the first HEALTHY endpoint
 *      (idle-unproven counts — the flip itself is the probe).
 *   3. No healthy candidate -> stay (every endpoint keeps retrying for free).
 *
 * Flips are rate-limited by FLIP_COOLDOWN_SECONDS. On each run, while the
 * active endpoint is HEALTHY, stranded tasks (IN_PROGRESS or QUEUED with a
 * task token dispatched to a region other than the active one) are
 * re-dispatched to the active endpoint; their parked state-machine tokens
 * resume normally on the new endpoint's success callback, and late duplicate
 * callbacks from the abandoned region are no-ops (consumed-token guard in
 * the callback). Additionally, QUEUED tasks in any region with a live
 * instance are promoted to IN_PROGRESS — the closest available signal that
 * SageMaker has picked the request up.
 */

type RegionClass = 'FAILED' | 'DROUGHT' | 'PROVISIONING' | 'HEALTHY';
interface EndpointState {
  conf: EndpointConfig;
  class: RegionClass;
  /** HEALTHY and capacity-proven: has an instance now, or recently scaled one up. */
  proven: boolean;
  /** Live instance count (facts.current) — used by QUEUED promotion. */
  current: number;
}

export interface EndpointFacts {
  status: string;
  current: number;
  desired: number;
  latestActivityStatusCode?: string;
  latestActivityDescription?: string;
  latestActivityStart?: Date;
}

async function describeRegion(conf: EndpointConfig): Promise<EndpointFacts> {
  const sagemaker = new SageMakerClient({ region: conf.region });
  const endpoint = await sagemaker.send(
    new DescribeEndpointCommand({ EndpointName: conf.endpointName }),
  );
  const variant = endpoint.ProductionVariants?.[0];
  const current = variant?.CurrentInstanceCount ?? 0;
  const desired = variant?.DesiredInstanceCount ?? 0;

  const aas = new ApplicationAutoScalingClient({ region: conf.region });
  const activities = await aas.send(
    new DescribeScalingActivitiesCommand({
      ServiceNamespace: 'sagemaker',
      ResourceId: `endpoint/${conf.endpointName}/variant/${VARIANT_NAME}`,
      MaxResults: 20,
    }),
  );
  const sorted = [...(activities.ScalingActivities ?? [])].sort(
    (a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0),
  );
  const latest = sorted[0];

  return {
    status: endpoint.EndpointStatus ?? 'Unknown',
    current,
    desired,
    latestActivityStatusCode: latest?.StatusCode,
    latestActivityDescription: latest?.Description,
    latestActivityStart: latest?.StartTime,
  };
}

export function classify(facts: EndpointFacts): { class: RegionClass; proven: boolean } {
  if (facts.status === 'Failed') {
    return { class: 'FAILED', proven: false };
  }
  const creating = facts.status === 'Creating' || facts.status === 'Updating' || facts.status === 'SystemUpdating';
  const scalingInFlight =
    facts.desired > facts.current &&
    (facts.latestActivityStatusCode === 'Pending' || facts.latestActivityStatusCode === 'InProgress');
  if ((creating || scalingInFlight) && !staleProvisioning(facts)) {
    return { class: 'PROVISIONING', proven: false };
  }
  if (
    facts.current === 0 &&
    facts.desired >= 1 &&
    (facts.latestActivityStatusCode === 'Unfulfilled' ||
      facts.latestActivityStatusCode === 'Failed' ||
      staleProvisioning(facts))
  ) {
    return { class: 'DROUGHT', proven: false };
  }
  const proven = facts.current >= 1 || recentScaleUpSucceeded(facts);
  return { class: 'HEALTHY', proven };
}

/**
 * Capacity proof for failback: an instance is running now, or the latest
 * scaling activity recently SCALED UP successfully ("Setting desired
 * instance count to N", N >= 1). A successful scale-down proves nothing
 * about capacity and must not make an idle region steal traffic back.
 */
function recentScaleUpSucceeded(facts: EndpointFacts): boolean {
  if (facts.latestActivityStatusCode !== 'Successful' || !facts.latestActivityStart) {
    return false;
  }
  if (Date.now() - facts.latestActivityStart.getTime() > PROOF_WINDOW_MS) {
    return false;
  }
  const target = facts.latestActivityDescription?.match(/to (\d+)/)?.[1];
  return target !== undefined && Number(target) >= 1;
}

/**
 * A scale-up stuck Pending/InProgress with zero instances for longer than
 * STALE_PROVISIONING_MS is treated as a drought: AAS only declares
 * Unfulfilled after hours, so without this rule a dry region stays
 * PROVISIONING forever and never loses the active role.
 */
function staleProvisioning(facts: EndpointFacts): boolean {
  if (facts.current !== 0 || !facts.latestActivityStart) return false;
  if (facts.latestActivityStatusCode !== 'Pending' && facts.latestActivityStatusCode !== 'InProgress') {
    return false;
  }
  return Date.now() - facts.latestActivityStart.getTime() > STALE_PROVISIONING_MS;
}

async function getParameterValue(name: string): Promise<string | undefined> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    return result.Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

async function queryStatusTasks(tableName: string, status: string): Promise<TaskRecord[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :status',
      ExpressionAttributeValues: { ':status': status },
      FilterExpression: 'attribute_exists(sagemaker_task_token)',
      Limit: 100,
    }),
  );
  return (result.Items ?? []) as TaskRecord[];
}

/**
 * Stranded tasks: dispatched (token-bearing) records still sitting in
 * IN_PROGRESS or QUEUED. QUEUED tasks rescued into a new region stay QUEUED —
 * accurate, since the re-dispatch puts them back into SageMaker's async queue.
 */
async function queryStrandedTasks(tableName: string): Promise<TaskRecord[]> {
  const [inProgress, queued] = await Promise.all([
    queryStatusTasks(tableName, 'STATUS#IN_PROGRESS'),
    queryStatusTasks(tableName, 'STATUS#QUEUED'),
  ]);
  return [...inProgress, ...queued];
}

/**
 * QUEUED -> IN_PROGRESS promotion: a region with a live instance (current
 * >= 1) has picked the request up or is about to — SageMaker emits no
 * per-inference start event, so a running instance is the best available
 * signal. Guarded by `status = :queued` so the SageMaker callback (which sets
 * a terminal status directly) always wins the race.
 */
async function promoteQueuedTasksInRegion(tableName: string, region: string): Promise<number> {
  const queued = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :status',
      ExpressionAttributeValues: { ':status': 'STATUS#QUEUED', ':region': region },
      FilterExpression: 'attribute_exists(sagemaker_task_token) AND sagemaker_region = :region',
      Limit: 100,
    }),
  );

  let promoted = 0;
  for (const item of (queued.Items ?? []) as TaskRecord[]) {
    const now = new Date().toISOString();
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `TASK#${item.task_id}` },
          UpdateExpression:
            'SET status = :in_progress, gsi2pk = :gsi2, updated_at = :now' +
            (item.source === 'api' ? ', gsi4pk = :gsi4' : ''),
          ExpressionAttributeValues: {
            ':in_progress': 'IN_PROGRESS',
            ':gsi2': 'STATUS#IN_PROGRESS',
            ':now': now,
            ...(item.source === 'api'
              ? { ':gsi4': `USER#${item.user_id}#STATUS#IN_PROGRESS` }
              : {}),
            ':queued': 'QUEUED',
          },
          ConditionExpression: 'status = :queued',
        }),
      );
      promoted += 1;
      await enqueueWebhook({ ...item, status: 'IN_PROGRESS', updated_at: now });
      console.log(`Promoted queued task ${item.task_id} to IN_PROGRESS (${region} has a live instance)`);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // The SageMaker callback won the race and already set a terminal
        // status. Nothing to do.
        continue;
      }
      throw err;
    }
  }
  return promoted;
}

export async function handler(): Promise<{
  active_endpoint: string;
  flipped: boolean;
  classes: Record<string, RegionClass>;
  rescued: number;
  promoted: number;
}> {
  const configs = parseEndpointConfig(requireEnv('SAGEMAKER_ENDPOINTS'));
  const activeParam = requireEnv('ACTIVE_ENDPOINT_PARAM');
  const lastFlipParam = requireEnv('LAST_FLIP_PARAM');
  const cooldownSeconds = Number(process.env.FLIP_COOLDOWN_SECONDS ?? '300');

  // Read the current election: the stored value is an endpoint NAME (unique
  // per region x type). Unknown/absent -> chain head (first configured).
  const storedActive = await getParameterValue(activeParam);
  let activeEndpoint =
    storedActive && configs.some((c) => c.endpointName === storedActive)
      ? storedActive
      : configs[0]?.endpointName;
  if (!activeEndpoint) {
    throw new Error('No active endpoint resolved (SAGEMAKER_ENDPOINTS is empty)');
  }

  // Classify every chain endpoint, preserving configured order.
  const states: EndpointState[] = [];
  for (const conf of configs) {
    const facts = await describeRegion(conf);
    const { class: cls, proven } = classify(facts);
    states.push({ conf, class: cls, proven, current: facts.current });
  }
  const classes: Record<string, RegionClass> = {};
  for (const s of states) classes[s.conf.endpointName] = s.class;

  // ---- election ----------------------------------------------------------
  let flipped = false;
  const activeIdx = states.findIndex((s) => s.conf.endpointName === activeEndpoint);
  const activeClass = states[activeIdx]?.class ?? 'DROUGHT';

  let target: string | undefined;
  if (activeClass === 'HEALTHY' || activeClass === 'PROVISIONING') {
    // Failback only: a higher-priority (earlier in the chain) healthy-PROVEN
    // endpoint.
    target = states
      .slice(0, activeIdx)
      .find((s) => s.class === 'HEALTHY' && s.proven)
      ?.conf.endpointName;
  } else {
    // Active endpoint is dry/dead: first HEALTHY candidate (idle-unproven ok).
    target = states.find((s) => s.class === 'HEALTHY')?.conf.endpointName;
  }

  if (target && target !== activeEndpoint) {
    const lastFlip = await getParameterValue(lastFlipParam);
    const lastFlipMs = lastFlip ? Date.parse(lastFlip) : NaN;
    const withinCooldown = Number.isFinite(lastFlipMs) && Date.now() - lastFlipMs < cooldownSeconds * 1000;
    if (withinCooldown) {
      console.log(`Flip to ${target} suppressed: within ${cooldownSeconds}s cooldown`);
    } else {
      const now = new Date().toISOString();
      await ssm.send(new PutParameterCommand({ Name: activeParam, Value: target, Type: 'String', Overwrite: true }));
      await ssm.send(new PutParameterCommand({ Name: lastFlipParam, Value: now, Type: 'String', Overwrite: true }));
      console.log(
        `Flipped active endpoint ${activeEndpoint} -> ${target} (active=${activeClass}, classes=${JSON.stringify(classes)})`,
      );
      activeEndpoint = target;
      flipped = true;
    }
  } else if (!target && activeClass !== 'HEALTHY' && activeClass !== 'PROVISIONING') {
    console.log(`Active endpoint ${activeEndpoint} is ${activeClass} and no healthy candidate exists; staying`);
  }

  // ---- stranded-task rescue ---------------------------------------------
  let rescued = 0;
  let promoted = 0;
  const activeState = states.find((s) => s.conf.endpointName === activeEndpoint);
  if (activeState && activeState.class === 'HEALTHY') {
    const tableName = requireEnv('TASKS_TABLE');
    const stranded = await queryStrandedTasks(tableName);
    for (const task of stranded) {
      const taskRegion = task.sagemaker_region ?? 'us-east-1';
      if (taskRegion === activeState.conf.region) continue;
      try {
        await dispatchToRegion(task, activeState.conf);
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: `TASK#${task.task_id}` },
            UpdateExpression: 'SET sagemaker_region = :region, updated_at = :now',
            ExpressionAttributeValues: { ':region': activeState.conf.region, ':now': new Date().toISOString() },
            ConditionExpression: 'attribute_exists(pk)',
          }),
        );
        rescued += 1;
        console.log(
          `Re-dispatched stranded task ${task.task_id} from ${taskRegion} to ${activeState.conf.endpointName} (${activeState.conf.region})`,
        );
      } catch (err) {
        console.error(`Failed to re-dispatch stranded task ${task.task_id} to ${activeState.conf.endpointName}`, err);
      }
    }
  }

  // ---- queued-task promotion --------------------------------------------
  // Any region with a live instance has (or is about to) pick up its queued
  // requests: flip them to IN_PROGRESS. Checked for every healthy region,
  // not just the active one — re-dispatched rescues land elsewhere.
  const tableForPromotion = requireEnv('TASKS_TABLE');
  for (const s of states) {
    if (s.class !== 'HEALTHY' || s.current < 1) continue;
    promoted += await promoteQueuedTasksInRegion(tableForPromotion, s.conf.region);
  }

  return { active_endpoint: activeEndpoint, flipped, classes, rescued, promoted };
}
