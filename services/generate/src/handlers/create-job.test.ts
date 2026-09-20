import { describe, expect, it, vi, beforeEach } from 'vitest';

const putTask = vi.fn();
const updateTask = vi.fn();
const getTask = vi.fn();
const findByIdempotencyKey = vi.fn();

vi.mock('../lib/tasks-repo.js', () => ({
  putTask: (...args: unknown[]) => putTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  getTask: (...args: unknown[]) => getTask(...args),
  findByIdempotencyKey: (...args: unknown[]) => findByIdempotencyKey(...args),
  ttlFromNow: () => 0,
}));

const offloadDataUri = vi.fn();
const isDataUri = vi.fn((url: string) => url.startsWith('data:'));

vi.mock('../lib/data-uris.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data-uris.js')>()),
  offloadDataUri: (...args: unknown[]) => offloadDataUri(...args),
  isDataUri: (...args: unknown[]) => isDataUri(...(args as [string])),
}));

const sfnSend = vi.fn();
vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: class {
    send = (...args: unknown[]) => sfnSend(...args);
  },
  StartExecutionCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { handler } from './create-job.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const USER = '11111111-2222-4333-8444-555555555555';

interface JsonResult {
  statusCode: number;
  body: string;
}

async function call(body: unknown, overrides: Partial<APIGatewayProxyEventV2> = {}): Promise<JsonResult> {
  const event = {
    routeKey: 'POST /v1/jobs',
    requestContext: {
      http: { method: 'POST', path: '/v1/jobs' },
      authorizer: { lambda: { user_id: USER } },
    },
    body: JSON.stringify(body),
    ...overrides,
  } as APIGatewayProxyEventV2;
  return (await handler(event)) as JsonResult;
}

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URI = `data:image/png;base64,${PNG_B64}`;

beforeEach(() => {
  putTask.mockReset().mockResolvedValue(undefined);
  updateTask.mockReset().mockResolvedValue(undefined);
  getTask.mockReset().mockResolvedValue(null);
  findByIdempotencyKey.mockReset().mockResolvedValue(null);
  offloadDataUri.mockReset().mockResolvedValue('s3://work-bucket/tasks/01JOFFLOAD00/uploads/0');
  isDataUri.mockClear();
  sfnSend.mockReset().mockResolvedValue({ executionArn: 'arn:aws:states:us-east-1:123:execution:sm:name' });
  process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123:stateMachine:sm';
});

describe('create-job', () => {
  it('offloads a data-URI image and persists the s3:// ref', async () => {
    const res = await call({ type: 'image-to-3d', input: { image_urls: [DATA_URI] } });

    expect(res.statusCode).toBe(202);
    const { job_id } = JSON.parse(res.body);
    expect(putTask).toHaveBeenCalledTimes(1);
    const record = putTask.mock.calls[0]![0];
    expect(record.task_id).toBe(job_id);
    expect(record.input.image_urls).toEqual(['s3://work-bucket/tasks/01JOFFLOAD00/uploads/0']);
    expect(offloadDataUri).toHaveBeenCalledWith(DATA_URI, `tasks/${job_id}/uploads/0`);
  });

  it('stores https URLs verbatim without offloading', async () => {
    const res = await call({ type: 'image-to-3d', input: { image_urls: ['https://cdn.example/x.png'] } });

    expect(res.statusCode).toBe(202);
    expect(offloadDataUri).not.toHaveBeenCalled();
    const record = putTask.mock.calls[0]![0];
    expect(record.input.image_urls).toEqual(['https://cdn.example/x.png']);
  });

  it('rejects a data URI with an unsupported media type', async () => {
    const res = await call({
      type: 'image-to-3d',
      input: { image_urls: [`data:image/gif;base64,${PNG_B64}`] },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid_request');
    expect(offloadDataUri).not.toHaveBeenCalled();
    expect(putTask).not.toHaveBeenCalled();
  });

  it('502s when the authorizer context is missing', async () => {
    const res = await call(
      { type: 'text-to-3d-preview', input: { prompt: 'a teapot' } },
      { requestContext: { http: { method: 'POST', path: '/v1/jobs' } } as APIGatewayProxyEventV2['requestContext'] },
    );
    expect(res.statusCode).toBe(502);
  });
});
