import { describe, expect, it } from 'vitest';
import { isTerminal, toApiTask, TaskRecord } from './types.js';

const record: TaskRecord = {
  task_id: '01JTEST',
  type: 'text-to-3d-preview',
  status: 'IN_PROGRESS',
  progress: 42,
  input: { prompt: 'a teapot' },
  options: {},
  user_id: '11111111-2222-4333-8444-555555555555',
  job_id: '99999999-8888-4777-8666-555555555555',
  created_at: '2026-07-10T12:00:00.000Z',
  updated_at: '2026-07-10T12:01:00.000Z',
  ttl: 1789000000,
};

describe('toApiTask', () => {
  it('exposes only the public fields with explicit nulls', () => {
    expect(toApiTask(record)).toEqual({
      task_id: '01JTEST',
      type: 'text-to-3d-preview',
      status: 'IN_PROGRESS',
      progress: 42,
      model_urls: null,
      thumbnail_url: null,
      error: null,
      created_at: '2026-07-10T12:00:00.000Z',
      finished_at: null,
    });
    // Internal fields must not leak to API callers.
    expect(toApiTask(record)).not.toHaveProperty('artifact_prefix');
    expect(toApiTask(record)).not.toHaveProperty('execution_arn');
  });

  it('passes through outputs when present', () => {
    const done = toApiTask({
      ...record,
      status: 'SUCCEEDED',
      progress: 100,
      model_urls: { glb: 'https://assets.example/model-assets/u/j.glb' },
      thumbnail_url: 'https://assets.example/model-assets/u/j-thumbnail.jpg',
      finished_at: '2026-07-10T12:05:00.000Z',
    });
    expect(done.model_urls?.glb).toContain('.glb');
    expect(done.finished_at).toBe('2026-07-10T12:05:00.000Z');
  });
});

describe('isTerminal', () => {
  it('classifies statuses', () => {
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
    expect(isTerminal('SUCCEEDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELED')).toBe(true);
  });
});
