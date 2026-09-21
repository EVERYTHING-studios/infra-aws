import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SageMakerLib from '../lib/sagemaker.js';
import type { TaskRecord } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Hoisted mock state shared with the vi.mock factories below (vitest hoists
// vi.mock above the test body, so the factories must close over state created
// by vi.hoisted).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  return {
    // Task records served by the gsi2 queries, keyed by status GSI value.
    tasksByStatus: {} as Record<string, TaskRecord[]>,
    // Published CloudWatch datapoints: { region, endpointName, value }.
    metrics: [] as Array<{ region?: string; endpointName?: string; value?: number }>,
  };
});

interface QueryLike {
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  Limit?: number;
}

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd: { input: QueryLike }) {
        const input = cmd.input;
        if (input.KeyConditionExpression) {
          const status = input.ExpressionAttributeValues?.[':status'] as string | undefined;
          // Emulate the key condition + token filter.
          const items = (h.tasksByStatus[status ?? ''] ?? []).filter(
            (t) => t.sagemaker_task_token !== undefined,
          );
          return { Items: items.slice(0, input.Limit ?? 100) };
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

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    constructor(public readonly config: { region?: string }) {}
    async send(cmd: { input: { MetricData?: Array<{ Dimensions?: Array<{ Name: string; Value: string }>; Value?: number }> } }) {
      for (const datum of cmd.input.MetricData ?? []) {
        h.metrics.push({
          region: this.config.region,
          endpointName: datum.Dimensions?.[0]?.Value,
          value: datum.Value,
        });
      }
      return {};
    }
  },
  PutMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('../lib/sagemaker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SageMakerLib>()),
}));

import { handler } from './endpoint-scaler.js';

const REGIONS = [
  { region: 'us-east-1', instanceType: 'g5', endpointName: 'svc-sagemaker-g5', inputBucket: 'in-g5-use1' },
  { region: 'us-west-2', instanceType: 'g5', endpointName: 'svc-sagemaker-g5-usw2', inputBucket: 'in-g5-usw2' },
];

function mkTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: '01JQUEUED02',
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

beforeAll(() => {
  process.env.TASKS_TABLE = 'tasks';
  process.env.SAGEMAKER_ENDPOINTS = JSON.stringify(REGIONS);
});

beforeEach(() => {
  h.tasksByStatus = {};
  h.metrics = [];
});

describe('endpoint-scaler', () => {
  it('counts a QUEUED token-bearing task as busy: its region publishes EndpointIdle = 0, empty regions 1', async () => {
    h.tasksByStatus['STATUS#QUEUED'] = [mkTask()];

    const result = await handler();

    expect(result).toEqual({ idle: 0 });
    expect(h.metrics).toEqual([
      { region: 'us-east-1', endpointName: 'svc-sagemaker-g5', value: 0 },
      { region: 'us-west-2', endpointName: 'svc-sagemaker-g5-usw2', value: 1 },
    ]);
  });

  it('a QUEUED task without a task token does not hold capacity', async () => {
    h.tasksByStatus['STATUS#QUEUED'] = [mkTask({ sagemaker_task_token: undefined })];

    const result = await handler();

    expect(result).toEqual({ idle: 1 });
    expect(h.metrics).toEqual([
      { region: 'us-east-1', endpointName: 'svc-sagemaker-g5', value: 1 },
      { region: 'us-west-2', endpointName: 'svc-sagemaker-g5-usw2', value: 1 },
    ]);
  });
});
