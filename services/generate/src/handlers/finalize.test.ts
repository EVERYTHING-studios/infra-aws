import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../lib/types.js';

const getTask = vi.fn();
const updateTask = vi.fn();

vi.mock('../lib/tasks-repo.js', () => ({
  getTask: (...args: unknown[]) => getTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
}));

const applyLedgerEntry = vi.fn();

vi.mock('../lib/accounts-repo.js', () => ({
  applyLedgerEntry: (...args: unknown[]) => applyLedgerEntry(...args),
}));

const enqueueWebhook = vi.fn();
vi.mock('../lib/webhook-queue.js', () => ({
  enqueueWebhook: (...args: unknown[]) => enqueueWebhook(...args),
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {},
  CreateInvalidationCommand: class {},
}));

import { handler } from './finalize.js';
import type { PipelineContext } from './prepare.js';

function mkTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: '01JFINAL01',
    type: 'text-to-3d-preview',
    status: 'IN_PROGRESS',
    progress: 90,
    input: { prompt: 'a teapot' },
    options: {},
    user_id: '11111111-2222-4333-8444-555555555555',
    job_id: '99999999-8888-4777-8666-555555555555',
    created_at: '2026-09-20T12:00:00.000Z',
    updated_at: '2026-09-20T12:04:00.000Z',
    ttl: 1900000000,
    ...overrides,
  };
}

beforeEach(() => {
  getTask.mockReset().mockResolvedValue(mkTask());
  updateTask.mockReset().mockImplementation((taskId, update) => ({ taskId, ...update }));
  applyLedgerEntry.mockReset().mockResolvedValue({});
  enqueueWebhook.mockReset().mockResolvedValue(undefined);
  process.env.ASSETS_BASE_URL = 'https://assets.example';
  process.env.BILLING_RATES_JSON = '{"g5":844,"g6e":1556,"g7e":2333}';
  delete process.env.CLOUDFRONT_DISTRIBUTION_ID;
});

async function finalize(task: TaskRecord) {
  getTask.mockResolvedValue(task);
  return handler({ task_id: task.task_id } as PipelineContext);
}

describe('finalize usage settlement', () => {
  it('charges an api task over its capacity window in one ledger entry', async () => {
    const task = mkTask({
      source: 'api',
      capacity_started_at: '2026-09-20T12:00:00.000Z',
      inference_finished_at: '2026-09-20T12:01:00.000Z',
      inference_instance_type: 'g5',
    });

    await finalize(task);

    expect(applyLedgerEntry).toHaveBeenCalledTimes(1);
    expect(applyLedgerEntry).toHaveBeenCalledWith(
      task.user_id,
      -60 * 844,
      'usage:01JFINAL01',
      'usage',
      { task_id: '01JFINAL01', instance_type: 'g5', seconds: 60 },
    );
  });

  it('never charges web-app tasks (source absent)', async () => {
    await finalize(mkTask());
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });

  it('skips the charge (and logs) when timing stamps are missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await finalize(mkTask({ source: 'api' }));
      expect(result).toEqual({ task_id: '01JFINAL01' });
      expect(applyLedgerEntry).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('01JFINAL01'));
    } finally {
      error.mockRestore();
    }
  });

  it('still succeeds when settlement throws (job must not fail)', async () => {
    applyLedgerEntry.mockRejectedValue(new Error('dynamodb throttled'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const task = mkTask({
        source: 'api',
        capacity_started_at: '2026-09-20T12:00:00.000Z',
        inference_finished_at: '2026-09-20T12:00:30.000Z',
        inference_instance_type: 'g5',
      });
      const result = await finalize(task);
      expect(result).toEqual({ task_id: '01JFINAL01' });
      expect(updateTask).toHaveBeenCalledWith('01JFINAL01', expect.objectContaining({ status: 'SUCCEEDED' }));
      expect(enqueueWebhook).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Usage settlement failed for api task 01JFINAL01'),
        expect.anything(),
      );
    } finally {
      error.mockRestore();
    }
  });
});
