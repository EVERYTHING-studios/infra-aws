import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SageMakerClient, DescribeEndpointCommand } from '@aws-sdk/client-sagemaker';
import {
  ApplicationAutoScalingClient,
  DescribeScalingActivitiesCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig, dispatchToRegion, VARIANT_NAME, type EndpointConfig } from '../lib/sagemaker.js';
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
 * active endpoint is HEALTHY, stranded tasks (IN_PROGRESS with a task token
 * dispatched to a region other than the active one) are re-dispatched to the
 * active endpoint; their parked state-machine tokens resume normally on the
 * new endpoint's success callback, and late duplicate callbacks from the
 * abandoned region are no-ops (consumed-token guard in the callback).
 */

type RegionClass = 'FAILED' | 'DROUGHT' | 'PROVISIONING' | 'HEALTHY';

interface EndpointState {
  conf: EndpointConfig;
  class: RegionClass;
  /** HEALTHY and capacity-proven: has an instance now, or recently scaled one up. */
  proven: boolean;
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

async function queryStrandedTasks(tableName: string): Promise<TaskRecord[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :status',
      ExpressionAttributeValues: { ':status': 'STATUS#IN_PROGRESS' },
      FilterExpression: 'attribute_exists(sagemaker_task_token)',
      Limit: 100,
    }),
  );
  return (result.Items ?? []) as TaskRecord[];
}

export async function handler(): Promise<{
  active_endpoint: string;
  flipped: boolean;
  classes: Record<string, RegionClass>;
  rescued: number;
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
    states.push({ conf, class: cls, proven });
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

  return { active_endpoint: activeEndpoint, flipped, classes, rescued };
}
