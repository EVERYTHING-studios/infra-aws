import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SageMakerLib from '../lib/sagemaker.js';
import type { TaskRecord } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Hoisted mock state shared with the vi.mock factories below (vitest hoists
// vi.mock above the test body, so the factories must close over state created
// by vi.hoisted).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const now = Date.now();
  return {
    // endpointName -> DescribeEndpoint/DescribeScalingActivities facts
    factsByEndpoint: {} as Record<
      string,
      {
        status: string;
        current: number;
        desired: number;
        activityCode?: string;
        activityDescription?: string;
        activityStartMinAgo?: number;
      }
    >,
    // SSM parameter store (Gets read it; Puts write it)
    ssmValues: {} as Record<string, string | undefined>,
    // Task records served by gsi2 queries (rescue + promotion).
    tasks: [] as TaskRecord[],
    // Raw UpdateCommand inputs received by the doc client.
    updates: [] as unknown[],
    // Task records handed to enqueueWebhook.
    webhooks: [] as Array<Record<string, unknown>>,
    // dispatchToRegion invocations.
    dispatches: [] as Array<{ task_id: string; endpointName: string; region: string }>,
    // pk values whose status-guarded updates must throw ConditionalCheckFailedException.
    failUpdateForPks: new Set<string>(),
    ConditionalCheckFailedException: class extends Error {
      constructor() {
        super('The conditional request failed');
        this.name = 'ConditionalCheckFailedException';
      }
    },
    now,
  };
});

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    async send(cmd: { input: { Name?: string; Value?: string } }) {
      if ('Value' in cmd.input && cmd.input.Name) {
        h.ssmValues[cmd.input.Name] = cmd.input.Value;
        return {};
      }
      return { Parameter: { Value: h.ssmValues[cmd.input.Name ?? ''] } };
    }
  },
  GetParameterCommand: class {
    constructor(public readonly input: { Name?: string }) {}
  },
  PutParameterCommand: class {
    constructor(public readonly input: { Name?: string; Value?: string }) {}
  },
}));

vi.mock('@aws-sdk/client-sagemaker', () => ({
  SageMakerClient: class {
    async send(cmd: { input: { EndpointName?: string } }) {
      const f = h.factsByEndpoint[cmd.input.EndpointName ?? ''];
      return {
        EndpointStatus: f?.status ?? 'InService',
        ProductionVariants: [
          { CurrentInstanceCount: f?.current ?? 0, DesiredInstanceCount: f?.desired ?? 0 },
        ],
      };
    }
  },
  DescribeEndpointCommand: class {
    constructor(public readonly input: { EndpointName?: string }) {}
  },
}));

vi.mock('@aws-sdk/client-application-auto-scaling', () => ({
  ApplicationAutoScalingClient: class {
    async send(cmd: { input: { ResourceId?: string } }) {
      const f = Object.entries(h.factsByEndpoint).find(([name]) =>
        cmd.input.ResourceId?.startsWith(`endpoint/${name}/variant/`),
      )?.[1];
      const activities =
        f?.activityCode !== undefined
          ? [
              {
                StatusCode: f.activityCode,
                Description: f.activityDescription,
                StartTime: new Date(h.now - (f.activityStartMinAgo ?? 0) * 60 * 1000),
              },
            ]
          : [];
      return { ScalingActivities: activities };
    }
  },
  DescribeScalingActivitiesCommand: class {
    constructor(public readonly input: { ResourceId?: string }) {}
  }
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: h.ConditionalCheckFailedException,
}));

interface QueryLike {
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  FilterExpression?: string;
  Limit?: number;
}

interface UpdateLike {
  Key?: { pk?: string };
  UpdateExpression?: string;
  ConditionExpression?: string;
}

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd: { input: QueryLike & UpdateLike }) {
        const input = cmd.input;
        if (input.KeyConditionExpression) {
          const values = input.ExpressionAttributeValues ?? {};
          const status = values[':status'] as string | undefined;
          const region = values[':region'] as string | undefined;
          // Emulate the key condition + filter: status match, token present,
          // region match when the promotion query supplies one.
          let items = h.tasks.filter(
            (t) =>
              `STATUS#${t.status}` === status &&
              t.sagemaker_task_token !== undefined &&
              (region === undefined || t.sagemaker_region === region),
          );
          items = items.slice(0, input.Limit ?? 100);
          return { Items: items };
        }
        if (input.UpdateExpression) {
          if (
            input.ConditionExpression === '#status = :queued' &&
            input.Key?.pk !== undefined &&
            h.failUpdateForPks.has(input.Key.pk)
          ) {
            throw new h.ConditionalCheckFailedException();
          }
          h.updates.push(input);
          return {};
        }
        return { Items: [] };
      },
    }),
  },
  QueryCommand: class {
    constructor(public readonly input: unknown) {}
  },
  UpdateCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('../lib/webhook-queue.js', () => ({
  enqueueWebhook: (task: Record<string, unknown>) => {
    h.webhooks.push(task);
    return Promise.resolve();
  },
}));

vi.mock('../lib/sagemaker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SageMakerLib>()),
  dispatchToRegion: (task: { task_id: string }, conf: { endpointName: string; region: string }) => {
    h.dispatches.push({ task_id: task.task_id, endpointName: conf.endpointName, region: conf.region });
    return Promise.resolve();
  },
}));

const ago = (min: number) => new Date(Date.now() - min * 60 * 1000);

describe('classify', () => {
  it('PROVISIONING while a scale-up at zero instances is younger than the 15-min staleness threshold', () => {
    expect(classify({ status: 'InService', current: 0, desired: 1,
      latestActivityStatusCode: 'InProgress', latestActivityDescription: 'Setting desired instance count to 1.',
      latestActivityStart: ago(14) })).toEqual({ class: 'PROVISIONING', proven: false });
  });

  it('DROUGHT once a scale-up at zero instances exceeds 15 min', () => {
    expect(classify({ status: 'InService', current: 0, desired: 1,
      latestActivityStatusCode: 'InProgress', latestActivityStart: ago(16) }))
      .toEqual({ class: 'DROUGHT', proven: false });
  });

  it('HEALTHY (not proven) when idle at desired 0 after a scale-down', () => {
    expect(classify({ status: 'InService', current: 0, desired: 0,
      latestActivityStatusCode: 'Successful', latestActivityDescription: 'Setting desired instance count to 0.',
      latestActivityStart: ago(5) })).toEqual({ class: 'HEALTHY', proven: false });
  });

  it('HEALTHY and proven with an instance running', () => {
    expect(classify({ status: 'InService', current: 1, desired: 1 }))
      .toEqual({ class: 'HEALTHY', proven: true });
  });

  it('FAILED on a failed endpoint', () => {
    expect(classify({ status: 'Failed', current: 0, desired: 0 }))
      .toEqual({ class: 'FAILED', proven: false });
  });
});

// ---------------------------------------------------------------------------
// Chain election across a mixed (region x type) chain. SAGEMAKER_ENDPOINTS
// array order is the cold-price chain: g5 -> g6e -> g7e.
// ---------------------------------------------------------------------------
import { classify, handler } from './capacity-sentinel.js';

const CHAIN = [
  { region: 'us-east-1', instanceType: 'g5', endpointName: 'svc-sagemaker-g5', inputBucket: 'in-g5' },
  { region: 'us-east-1', instanceType: 'g6e', endpointName: 'svc-sagemaker-g6e', inputBucket: 'in-g6e' },
  { region: 'us-east-1', instanceType: 'g7e', endpointName: 'svc-sagemaker-g7e', inputBucket: 'in-g7e' },
];
const ACTIVE_PARAM = '/generate/staging/sagemaker/active_endpoint';
const LAST_FLIP_PARAM = '/generate/staging/sagemaker/last_flip';

beforeAll(() => {
  process.env.SAGEMAKER_ENDPOINTS = JSON.stringify(CHAIN);
  process.env.ACTIVE_ENDPOINT_PARAM = ACTIVE_PARAM;
  process.env.LAST_FLIP_PARAM = LAST_FLIP_PARAM;
  process.env.TASKS_TABLE = 'tasks';
  process.env.FLIP_COOLDOWN_SECONDS = '0';
});

describe('chain election', () => {
  it('skips a DROUGHT head and elects the first HEALTHY entry in chain order (g5 DROUGHT, g6e HEALTHY -> g6e)', async () => {
    h.factsByEndpoint['svc-sagemaker-g5'] = {
      status: 'InService', current: 0, desired: 1,
      activityCode: 'InProgress', activityStartMinAgo: 20,
    };
    h.factsByEndpoint['svc-sagemaker-g6e'] = {
      status: 'InService', current: 0, desired: 0,
      activityCode: 'Successful', activityDescription: 'Setting desired instance count to 0.',
      activityStartMinAgo: 5,
    };
    h.factsByEndpoint['svc-sagemaker-g7e'] = { status: 'Failed', current: 0, desired: 0 };
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';
    h.ssmValues[LAST_FLIP_PARAM] = '1970-01-01T00:00:00.000Z';

    const result = await handler();

    expect(result.flipped).toBe(true);
    expect(result.active_endpoint).toBe('svc-sagemaker-g6e');
    expect(result.classes).toEqual({
      'svc-sagemaker-g5': 'DROUGHT',
      'svc-sagemaker-g6e': 'HEALTHY',
      'svc-sagemaker-g7e': 'FAILED',
    });
    // The flip is recorded as the elected endpoint NAME.
    expect(h.ssmValues[ACTIVE_PARAM]).toBe('svc-sagemaker-g6e');
  });

  it('fails back to the recovered chain head once it is healthy-proven', async () => {
    // Continues from the previous run: active is g6e. The g5 head has since
    // provisioned an instance (healthy + proven).
    h.factsByEndpoint['svc-sagemaker-g5'] = { status: 'InService', current: 1, desired: 1 };
    h.factsByEndpoint['svc-sagemaker-g6e'] = {
      status: 'InService', current: 0, desired: 0,
      activityCode: 'Successful', activityDescription: 'Setting desired instance count to 0.',
      activityStartMinAgo: 5,
    };
    h.factsByEndpoint['svc-sagemaker-g7e'] = { status: 'Failed', current: 0, desired: 0 };
    // active param carries over from the previous test's flip (g6e).

    const result = await handler();

    expect(result.flipped).toBe(true);
    expect(result.active_endpoint).toBe('svc-sagemaker-g5');
    expect(h.ssmValues[ACTIVE_PARAM]).toBe('svc-sagemaker-g5');
  });

  it('stays on a healthy active endpoint (no healthy sibling outranks it)', async () => {
    h.factsByEndpoint['svc-sagemaker-g5'] = { status: 'InService', current: 1, desired: 1 };
    h.factsByEndpoint['svc-sagemaker-g6e'] = {
      status: 'InService', current: 0, desired: 0,
      activityCode: 'Successful', activityDescription: 'Setting desired instance count to 0.',
      activityStartMinAgo: 5,
    };
    h.factsByEndpoint['svc-sagemaker-g7e'] = { status: 'InService', current: 0, desired: 0 };
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';

    const result = await handler();

    expect(result.flipped).toBe(false);
    expect(result.active_endpoint).toBe('svc-sagemaker-g5');
  });
});

// ---------------------------------------------------------------------------
// Two-region chain: endpoint NAMES are globally unique (us-east-1 unsuffixed,
// us-east-2 gains a -useast2 suffix — see sagemaker-region main.tf
// region_token). The sentinel/dispatcher key every lookup on the endpoint
// name across the whole chain, so same-type cross-region failover must
// resolve the OTHER region's endpoint, not collapse onto the first region's
// same-named entry (the bug this test guards against).
// ---------------------------------------------------------------------------
const TWO_REGION_CHAIN = [
  { region: 'us-east-1', instanceType: 'g5', endpointName: 'svc-sagemaker-g5', inputBucket: 'in-g5-use1' },
  { region: 'us-east-2', instanceType: 'g5', endpointName: 'svc-sagemaker-g5-useast2', inputBucket: 'in-g5-use2' },
  { region: 'us-east-1', instanceType: 'g6e', endpointName: 'svc-sagemaker-g6e', inputBucket: 'in-g6e-use1' },
  { region: 'us-east-2', instanceType: 'g6e', endpointName: 'svc-sagemaker-g6e-useast2', inputBucket: 'in-g6e-use2' },
  { region: 'us-east-1', instanceType: 'g7e', endpointName: 'svc-sagemaker-g7e', inputBucket: 'in-g7e-use1' },
  { region: 'us-east-2', instanceType: 'g7e', endpointName: 'svc-sagemaker-g7e-useast2', inputBucket: 'in-g7e-use2' },
];

describe('two-region chain election', () => {
  it('fails over same-type across regions by unique endpoint name (g5-useast2 DROUGHT -> g5 us-east-1 HEALTHY)', async () => {
    process.env.SAGEMAKER_ENDPOINTS = JSON.stringify(TWO_REGION_CHAIN);

    // g5 in us-east-2 (the stored active) is in a capacity drought; the SAME
    // type in us-east-1 is healthy (idle at zero, unproven). Everything else
    // in the chain has failed.
    h.factsByEndpoint['svc-sagemaker-g5-useast2'] = {
      status: 'InService', current: 0, desired: 1,
      activityCode: 'InProgress', activityStartMinAgo: 20,
    };
    h.factsByEndpoint['svc-sagemaker-g5'] = {
      status: 'InService', current: 0, desired: 0,
      activityCode: 'Successful', activityDescription: 'Setting desired instance count to 0.',
      activityStartMinAgo: 5,
    };
    for (const name of [
      'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ]) {
      h.factsByEndpoint[name] = { status: 'Failed', current: 0, desired: 0 };
    }
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5-useast2';

    const result = await handler();

    expect(result.flipped).toBe(true);
    expect(result.active_endpoint).toBe('svc-sagemaker-g5');
    // classes is keyed by endpoint name: 6 DISTINCT keys across 2 regions.
    expect(Object.keys(result.classes).sort()).toEqual([
      'svc-sagemaker-g5', 'svc-sagemaker-g5-useast2',
      'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ].sort());
    expect(result.classes['svc-sagemaker-g5-useast2']).toBe('DROUGHT');
    expect(result.classes['svc-sagemaker-g5']).toBe('HEALTHY');
    expect(h.ssmValues[ACTIVE_PARAM]).toBe('svc-sagemaker-g5');
  });
});

// ---------------------------------------------------------------------------
// QUEUED-task lifecycle: rescue re-dispatches stranded QUEUED tasks (they
// stay QUEUED), and promotion flips QUEUED -> IN_PROGRESS only in regions
// with a live instance, guarded against the SageMaker callback race.
// ---------------------------------------------------------------------------
function mkTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: '01JQUEUED01',
    type: 'text-to-3d-preview',
    status: 'QUEUED',
    progress: 25,
    input: { prompt: 'a teapot' },
    options: {},
    user_id: '11111111-2222-4333-8444-555555555555',
    job_id: '99999999-8888-4777-8666-555555555555',
    created_at: '2026-09-20T12:00:00.000Z',
    updated_at: '2026-09-20T12:00:00.000Z',
    ttl: 1900000000,
    sagemaker_task_token: 'token-1',
    sagemaker_region: 'us-east-1',
    ...overrides,
  };
}

describe('queued-task rescue + promotion', () => {
  beforeEach(() => {
    process.env.SAGEMAKER_ENDPOINTS = JSON.stringify(TWO_REGION_CHAIN);
    h.factsByEndpoint = {};
    h.tasks = [];
    h.updates = [];
    h.webhooks = [];
    h.dispatches = [];
    h.failUpdateForPks.clear();
  });

  it('rescue re-dispatches a stranded QUEUED task to the active region and leaves it QUEUED', async () => {
    // Active endpoint (g5 us-east-1) is healthy with a live instance; the
    // queued task sits in the drought region us-east-2.
    h.factsByEndpoint['svc-sagemaker-g5'] = { status: 'InService', current: 1, desired: 1 };
    for (const name of [
      'svc-sagemaker-g5-useast2', 'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ]) {
      h.factsByEndpoint[name] = { status: 'Failed', current: 0, desired: 0 };
    }
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';
    h.tasks = [mkTask({ sagemaker_region: 'us-east-2' })];

    const result = await handler();

    expect(result.rescued).toBe(1);
    expect(result.promoted).toBe(0);
    expect(h.dispatches).toEqual([
      { task_id: '01JQUEUED01', endpointName: 'svc-sagemaker-g5', region: 'us-east-1' },
    ]);
    // The rescue update only moves the region — the record stays QUEUED.
    expect(h.updates).toEqual([
      expect.objectContaining({
        Key: { pk: 'TASK#01JQUEUED01' },
        UpdateExpression: 'SET sagemaker_region = :region, updated_at = :now',
      }),
    ]);
    expect(h.webhooks).toEqual([]);
  });

  it('promotion flips a QUEUED task to IN_PROGRESS in a region with a live instance and enqueues a webhook', async () => {
    h.factsByEndpoint['svc-sagemaker-g5'] = { status: 'InService', current: 1, desired: 1 };
    for (const name of [
      'svc-sagemaker-g5-useast2', 'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ]) {
      h.factsByEndpoint[name] = { status: 'Failed', current: 0, desired: 0 };
    }
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';
    // API-sourced task in the active region: rescue skips it (same region),
    // promotion picks it up and must sync the per-user status GSI too.
    h.tasks = [mkTask({ source: 'api', sagemaker_region: 'us-east-1' })];

    const result = await handler();

    expect(result.rescued).toBe(0);
    expect(result.promoted).toBe(1);
    expect(h.dispatches).toEqual([]);
    expect(h.updates).toEqual([
      expect.objectContaining({
        Key: { pk: 'TASK#01JQUEUED01' },
        UpdateExpression:
          'SET #status = :in_progress, gsi2pk = :gsi2, updated_at = :now, gsi4pk = :gsi4',
        ExpressionAttributeNames: { '#status': 'status' },
        ConditionExpression: '#status = :queued',
        ExpressionAttributeValues: expect.objectContaining({
          ':gsi2': 'STATUS#IN_PROGRESS',
          ':gsi4': 'USER#11111111-2222-4333-8444-555555555555#STATUS#IN_PROGRESS',
        }),
      }),
    ]);
    expect(h.webhooks).toEqual([
      expect.objectContaining({ task_id: '01JQUEUED01', status: 'IN_PROGRESS' }),
    ]);
  });

  it('keeps a QUEUED task QUEUED when its region has zero live instances', async () => {
    // Active endpoint is healthy but idle at zero instances.
    h.factsByEndpoint['svc-sagemaker-g5'] = {
      status: 'InService', current: 0, desired: 0,
      activityCode: 'Successful', activityDescription: 'Setting desired instance count to 0.',
      activityStartMinAgo: 5,
    };
    for (const name of [
      'svc-sagemaker-g5-useast2', 'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ]) {
      h.factsByEndpoint[name] = { status: 'Failed', current: 0, desired: 0 };
    }
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';
    h.tasks = [mkTask({ sagemaker_region: 'us-east-1' })];

    const result = await handler();

    expect(result.rescued).toBe(0);
    expect(result.promoted).toBe(0);
    expect(h.updates).toEqual([]);
    expect(h.webhooks).toEqual([]);
    expect(h.dispatches).toEqual([]);
  });

  it('skips promotion when the SageMaker callback won the race (ConditionalCheckFailedException)', async () => {
    h.factsByEndpoint['svc-sagemaker-g5'] = { status: 'InService', current: 1, desired: 1 };
    for (const name of [
      'svc-sagemaker-g5-useast2', 'svc-sagemaker-g6e', 'svc-sagemaker-g6e-useast2',
      'svc-sagemaker-g7e', 'svc-sagemaker-g7e-useast2',
    ]) {
      h.factsByEndpoint[name] = { status: 'Failed', current: 0, desired: 0 };
    }
    h.ssmValues[ACTIVE_PARAM] = 'svc-sagemaker-g5';
    h.tasks = [mkTask({ sagemaker_region: 'us-east-1' })];
    h.failUpdateForPks.add('TASK#01JQUEUED01');

    const result = await handler();

    expect(result.promoted).toBe(0);
    expect(h.webhooks).toEqual([]);
  });
});
