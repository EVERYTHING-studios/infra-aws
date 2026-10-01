import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor() {
      // construction config irrelevant; send is mocked on the document client
    }
  },
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: (...args: unknown[]) => mockSend(...args) }),
  },
  ScanCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

import { handler } from './admin-stats.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

process.env.TASKS_TABLE = 'generate-staging-tasks';

interface JsonResult {
  statusCode: number;
  body: string;
}

async function call(): Promise<JsonResult> {
  return (await handler({} as APIGatewayProxyEventV2)) as JsonResult;
}

/** Narrow a mocked ScanCommand call down to its input object. */
function scanInput(args: unknown[]): Record<string, unknown> {
  const cmd = args[0];
  if (
    cmd !== null &&
    typeof cmd === 'object' &&
    'input' in cmd &&
    cmd.input !== null &&
    typeof cmd.input === 'object'
  ) {
    // runtime-verified above: input is an object-shaped scan input
    return cmd.input as Record<string, unknown>;
  }
  throw new Error('expected a ScanCommand with an input object');
}

function item(status: string, type: string): Record<string, unknown> {
  return { pk: `TASK#${status}-${type}`, status, type, source: 'api' };
}

function page(items: Record<string, unknown>[], lastEvaluatedKey?: Record<string, unknown>) {
  return { Items: items, ...(lastEvaluatedKey ? { LastEvaluatedKey: lastEvaluatedKey } : {}) };
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('admin-stats', () => {
  it('aggregates a single-page scan', async () => {
    mockSend.mockResolvedValueOnce(
      page([
        item('SUCCEEDED', 'text-to-3d-preview'),
        item('SUCCEEDED', 'image-to-3d'),
        item('IN_PROGRESS', 'image-to-3d'),
        item('FAILED', 'text-to-3d-refine'),
      ]),
    );

    const res = await call();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(4);
    expect(body.by_status).toEqual({
      PENDING: 0,
      QUEUED: 0,
      IN_PROGRESS: 1,
      SUCCEEDED: 2,
      FAILED: 1,
      CANCELED: 0,
    });
    expect(body.by_type).toEqual({
      'text-to-3d-preview': 1,
      'text-to-3d-refine': 1,
      'image-to-3d': 2,
      'multi-image-to-3d': 0,
    });
    expect(body.window_note).toMatch(/90 days/);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = scanInput(mockSend.mock.calls[0]!);
    expect(input.TableName).toBe('generate-staging-tasks');
    expect(input.FilterExpression).toBe('#src = :api');
    expect(input.ExpressionAttributeNames).toEqual({ '#src': 'source' });
    expect(input.ExpressionAttributeValues).toEqual({ ':api': 'api' });
    expect(input.ExclusiveStartKey).toBeUndefined();
  });

  it('follows LastEvaluatedKey across pages and merges counts', async () => {
    const key2 = { pk: 'TASK#cursor' };
    mockSend
      .mockResolvedValueOnce(page([item('PENDING', 'text-to-3d-preview')], key2))
      .mockResolvedValueOnce(page([item('PENDING', 'image-to-3d'), item('QUEUED', 'image-to-3d')]));

    const res = await call();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.by_status).toEqual({
      PENDING: 2,
      QUEUED: 1,
      IN_PROGRESS: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      CANCELED: 0,
    });
    expect(body.by_type['image-to-3d']).toBe(2);
    expect(body.by_type['text-to-3d-preview']).toBe(1);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const page1 = scanInput(mockSend.mock.calls[0]!);
    const page2 = scanInput(mockSend.mock.calls[1]!);
    for (const input of [page1, page2]) {
      expect(input.TableName).toBe('generate-staging-tasks');
      expect(input.FilterExpression).toBe('#src = :api');
      expect(input.ExpressionAttributeNames).toEqual({ '#src': 'source' });
      expect(input.ExpressionAttributeValues).toEqual({ ':api': 'api' });
    }
    expect(page1.ExclusiveStartKey).toBeUndefined();
    expect(page2.ExclusiveStartKey).toEqual(key2);
  });

  it('zero-fills every status and type on an empty table', async () => {
    mockSend.mockResolvedValueOnce(page([]));

    const res = await call();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.by_status).toEqual({
      PENDING: 0,
      QUEUED: 0,
      IN_PROGRESS: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      CANCELED: 0,
    });
    expect(body.by_type).toEqual({
      'text-to-3d-preview': 0,
      'text-to-3d-refine': 0,
      'image-to-3d': 0,
      'multi-image-to-3d': 0,
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('skips unknown status and type values defensively', async () => {
    mockSend.mockResolvedValueOnce(page([item('WAT_STATUS', 'WAT_TYPE')]));

    const res = await call();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(Object.values(body.by_status).every((n) => n === 0)).toBe(true);
    expect(Object.values(body.by_type).every((n) => n === 0)).toBe(true);
  });
});
