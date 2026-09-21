import { describe, expect, it, vi, beforeEach } from 'vitest';

const listApiTasksByUser = vi.fn();
vi.mock('../lib/tasks-repo.js', () => ({
  listApiTasksByUser: (...args: unknown[]) => listApiTasksByUser(...args),
}));

import { handler } from './list-jobs.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { TaskRecord } from '../lib/types.js';

const USER = '11111111-2222-4333-8444-555555555555';

interface JsonResult {
  statusCode: number;
  body: string;
}

async function call(
  overrides: Partial<APIGatewayProxyEventV2> = {},
): Promise<JsonResult> {
  const event = {
    routeKey: 'GET /v1/jobs',
    requestContext: {
      http: { method: 'GET', path: '/v1/jobs' },
      authorizer: { lambda: { user_id: USER } },
    },
    queryStringParameters: {},
    ...overrides,
  } as APIGatewayProxyEventV2;
  return (await handler(event)) as JsonResult;
}

const task: TaskRecord = {
  task_id: '01JTESTTASK',
  type: 'text-to-3d-preview',
  status: 'SUCCEEDED',
  progress: 100,
  input: { prompt: 'a red chair' },
  options: {},
  user_id: USER,
  job_id: '01JTESTJOB',
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  ttl: 0,
};

beforeEach(() => {
  listApiTasksByUser.mockReset();
  listApiTasksByUser.mockResolvedValue({ items: [] });
});

describe('list-jobs', () => {
  it('rejects an unknown status', async () => {
    const res = await call({ queryStringParameters: { status: 'BOGUS' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'invalid_request', message: expect.stringContaining('SUCCEEDED') },
    });
  });


  it('bounds limit to an integer 1-100', async () => {
    for (const limit of ['0', '101', '2.5', 'abc']) {
      const res = await call({ queryStringParameters: { limit } });
      expect(res.statusCode).toBe(400);
    }
    const res = await call({ queryStringParameters: { limit: '42' } });
    expect(res.statusCode).toBe(200);
    expect(listApiTasksByUser.mock.calls[0]![1]).toMatchObject({ limit: 42 });
  });

  it('decodes a valid cursor into the exclusive start key', async () => {
    const startKey = { gsi3pk: `USER#${USER}`, gsi3sk: '2026-09-19T00:00:00.000Z', pk: 'TASK#01J' };
    listApiTasksByUser.mockResolvedValue({ items: [task] });
    const cursor = Buffer.from(JSON.stringify(startKey)).toString('base64url');
    const res = await call({ queryStringParameters: { cursor } });
    expect(res.statusCode).toBe(200);
    expect(listApiTasksByUser.mock.calls[0]![1]).toMatchObject({ exclusiveStartKey: startKey });
  });

  it('rejects a malformed cursor', async () => {
    const res = await call({ queryStringParameters: { cursor: '%%%not-base64url' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'invalid_cursor', message: expect.any(String) },
    });
  });

  it('roundtrips lastEvaluatedKey through next_cursor', async () => {
    const lastKey = { gsi3pk: `USER#${USER}`, gsi3sk: '2026-09-18T00:00:00.000Z' };
    listApiTasksByUser.mockResolvedValue({ items: [task], lastEvaluatedKey: lastKey });
    const res = await call();
    const body = JSON.parse(res.body);
    expect(body.jobs[0]).toEqual({
      task_id: '01JTESTTASK',
      type: 'text-to-3d-preview',
      status: 'SUCCEEDED',
      progress: 100,
      model_urls: null,
      thumbnail_url: null,
      error: null,
      created_at: '2026-09-19T00:00:00.000Z',
      finished_at: null,
    });
    const decoded = JSON.parse(Buffer.from(body.next_cursor, 'base64url').toString('utf8'));
    expect(decoded).toEqual(lastKey);
  });

  it('omits next_cursor on the last page and defaults limit to 20', async () => {
    listApiTasksByUser.mockResolvedValue({ items: [] });
    const res = await call();
    const body = JSON.parse(res.body);
    expect(body).toEqual({ jobs: [] });
    expect(body.next_cursor).toBeUndefined();
    expect(listApiTasksByUser.mock.calls[0]![1]).toMatchObject({ limit: 20 });
    expect(listApiTasksByUser.mock.calls[0]![1]).not.toHaveProperty('status');
  });

  it('passes a valid status filter through to gsi4', async () => {
    listApiTasksByUser.mockResolvedValue({ items: [] });
    const res = await call({ queryStringParameters: { status: 'SUCCEEDED' } });
    expect(res.statusCode).toBe(200);
    expect(listApiTasksByUser.mock.calls[0]![1]).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('502s when the authorizer context is missing', async () => {
    const res = await call({ requestContext: { http: { method: 'GET', path: '/v1/jobs' } } as APIGatewayProxyEventV2['requestContext'] });
    expect(res.statusCode).toBe(502);
  });
});
