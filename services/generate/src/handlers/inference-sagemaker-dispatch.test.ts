import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SageMakerLib from '../lib/sagemaker.js';

const getTask = vi.fn();
const updateTask = vi.fn();

vi.mock('../lib/tasks-repo.js', () => ({
  getTask: (...args: unknown[]) => getTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
}));

const dispatchToRegion = vi.fn();

vi.mock('../lib/sagemaker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SageMakerLib>()),
  dispatchToRegion: (...args: unknown[]) => dispatchToRegion(...args),
}));

const enqueueWebhook = vi.fn();

vi.mock('../lib/webhook-queue.js', () => ({
  enqueueWebhook: (...args: unknown[]) => enqueueWebhook(...args),
}));

const ssmSend = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = (...args: unknown[]) => ssmSend(...args);
  },
  GetParameterCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { handler } from './inference-sagemaker-dispatch.js';
import type { TaskRecord } from '../lib/types.js';

const ENDPOINTS = [
  { region: 'us-east-1', instanceType: 'g5', endpointName: 'svc-sagemaker-g5', inputBucket: 'in-g5-use1' },
  { region: 'us-east-2', instanceType: 'g5', endpointName: 'svc-sagemaker-g5-useast2', inputBucket: 'in-g5-use2' },
];

const PX_ENDPOINTS = [
  {
    region: 'us-east-1',
    instanceType: 'g5',
    endpointName: 'svc-sagemaker-pixal3d-g5',
    inputBucket: 'in-g5-use1',
    variantName: 'pixal3d',
  },
];

const task: TaskRecord = {
  task_id: '01JDISPATCH',
  type: 'text-to-3d-preview',
  status: 'PENDING',
  progress: 10,
  input: { prompt: 'a teapot' },
  options: {},
  user_id: '11111111-2222-4333-8444-555555555555',
  job_id: '99999999-8888-4777-8666-555555555555',
  artifact_prefix: 'tasks/01JDISPATCH',
  created_at: '2026-09-20T12:00:00.000Z',
  updated_at: '2026-09-20T12:00:00.000Z',
  ttl: 1900000000,
};

beforeEach(() => {
  getTask.mockReset().mockResolvedValue(task);
  updateTask.mockReset().mockResolvedValue({ ...task, status: 'QUEUED' });
  dispatchToRegion.mockReset().mockResolvedValue(undefined);
  enqueueWebhook.mockClear().mockResolvedValue(undefined);
  ssmSend.mockReset().mockResolvedValue({ Parameter: { Value: 'svc-sagemaker-g5-useast2' } });
  process.env.ACTIVE_ENDPOINT_PARAM = '/generate/staging/sagemaker/active_endpoint';
  process.env.SAGEMAKER_ENDPOINTS = JSON.stringify(ENDPOINTS);
  delete process.env.ACTIVE_ENDPOINT_PARAM_PIXAL3D;
  delete process.env.SAGEMAKER_ENDPOINTS_PIXAL3D;
});

describe('inference-sagemaker-dispatch', () => {
  it('dispatches to the active endpoint, marks the task QUEUED, and enqueues the webhook', async () => {
    const result = await handler({ task_id: '01JDISPATCH', postprocess: 'lite', task_token: 'tok-1' });

    expect(result).toEqual({ dispatched: true });
    // Dispatch targets the SSM-elected endpoint (the second chain entry).
    expect(dispatchToRegion).toHaveBeenCalledTimes(1);
    const [dispatchedTask, conf] = dispatchToRegion.mock.calls[0] as [TaskRecord, SageMakerLib.EndpointConfig];
    expect(dispatchedTask.task_id).toBe('01JDISPATCH');
    expect(conf.endpointName).toBe('svc-sagemaker-g5-useast2');

    // The record flips to QUEUED with the token + region persisted.
    expect(updateTask).toHaveBeenCalledTimes(1);
    const [taskId, update] = updateTask.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskId).toBe('01JDISPATCH');
    expect(update.status).toBe('QUEUED');
    expect(update.sagemaker_task_token).toBe('tok-1');
    expect(update.sagemaker_region).toBe('us-east-2');
    expect(update.progress).toBe(25);
    expect(update.inference_started_at).toEqual(expect.any(String));

    // The webhook carries the post-update record.
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(enqueueWebhook).toHaveBeenCalledWith({ ...task, status: 'QUEUED' });
  });

  it('throws when the task record does not exist', async () => {
    getTask.mockResolvedValue(null);
    await expect(
      handler({ task_id: '01JMISSING', postprocess: 'lite', task_token: 'tok-1' }),
    ).rejects.toThrow('Task 01JMISSING not found');
    expect(dispatchToRegion).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(enqueueWebhook).not.toHaveBeenCalled();
  });

  it('dispatches a precision-v2 task on the pixal3d chain (event model wins)', async () => {
    process.env.SAGEMAKER_ENDPOINTS_PIXAL3D = JSON.stringify(PX_ENDPOINTS);
    process.env.ACTIVE_ENDPOINT_PARAM_PIXAL3D = '/generate/staging/sagemaker/pixal3d/active_endpoint';
    ssmSend.mockResolvedValue({ Parameter: { Value: 'svc-sagemaker-pixal3d-g5' } });

    const result = await handler({
      task_id: '01JDISPATCH',
      postprocess: 'lite',
      task_token: 'tok-2',
      model: 'precision-v2',
    });

    expect(result).toEqual({ dispatched: true });
    const [dispatchedTask, conf] = dispatchToRegion.mock.calls[0] as [TaskRecord, SageMakerLib.EndpointConfig];
    expect(dispatchedTask.task_id).toBe('01JDISPATCH');
    expect(conf.endpointName).toBe('svc-sagemaker-pixal3d-g5');
    expect(conf.variantName).toBe('pixal3d');
    // The SSM read targets the v2 chain's own parameter.
    expect(ssmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: '/generate/staging/sagemaker/pixal3d/active_endpoint' } }),
    );
  });

  it('falls back to the task record model when the event omits it', async () => {
    process.env.SAGEMAKER_ENDPOINTS_PIXAL3D = JSON.stringify(PX_ENDPOINTS);
    process.env.ACTIVE_ENDPOINT_PARAM_PIXAL3D = '/generate/staging/sagemaker/pixal3d/active_endpoint';
    ssmSend.mockResolvedValue({ Parameter: { Value: 'svc-sagemaker-pixal3d-g5' } });
    getTask.mockResolvedValue({ ...task, model: 'precision-v2' });

    await handler({ task_id: '01JDISPATCH', postprocess: 'lite', task_token: 'tok-3' });

    const conf = dispatchToRegion.mock.calls[0]?.[1] as SageMakerLib.EndpointConfig;
    expect(conf.endpointName).toBe('svc-sagemaker-pixal3d-g5');
  });

  it('throws when precision-v2 is requested but no pixal3d chain is configured', async () => {
    await expect(
      handler({ task_id: '01JDISPATCH', postprocess: 'lite', task_token: 'tok-4', model: 'precision-v2' }),
    ).rejects.toThrow(/no Pixal3D chain is configured/);
    expect(dispatchToRegion).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
});
