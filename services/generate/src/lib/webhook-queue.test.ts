import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
sendMock.mockResolvedValue({});
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sendMock;
  },
  SendMessageCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { enqueueWebhook, webhookEventFromTask } from './webhook-queue.js';
import { TaskRecord, WebhookEvent } from './types.js';

const baseTask: TaskRecord = {
  task_id: '01JTESTTASK',
  type: 'text-to-3d-preview',
  status: 'IN_PROGRESS',
  progress: 50,
  input: { prompt: 'a red chair' },
  options: {},
  user_id: '11111111-2222-4333-8444-555555555555',
  job_id: '01JTESTJOB',
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  ttl: 0,
};

beforeEach(() => {
  sendMock.mockClear();
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs/webhook';
});

afterEach(() => {
  delete process.env.CUSTOMER_WEBHOOK_QUEUE_URL;
});

describe('webhookEventFromTask', () => {
  it('carries the task owner and a unique event id', () => {
    const a = webhookEventFromTask(baseTask);
    const b = webhookEventFromTask(baseTask);
    expect(a.event).toBe('task.updated');
    expect(a.user_id).toBe(baseTask.user_id);
    expect(a.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.event_id).not.toBe(b.event_id);
  });
});

describe('enqueueWebhook routing', () => {
  it('sends api tasks to the customer queue only', async () => {
    process.env.CUSTOMER_WEBHOOK_QUEUE_URL = 'https://sqs/customer-webhook';
    await enqueueWebhook({ ...baseTask, source: 'api' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = (sendMock.mock.calls[0]![0] as { input: { QueueUrl: string; MessageBody: string } }).input;
    expect(input.QueueUrl).toBe('https://sqs/customer-webhook');
    const payload = JSON.parse(input.MessageBody) as WebhookEvent;
    expect(payload.user_id).toBe(baseTask.user_id);
    expect(payload.event).toBe('task.updated');
  });

  it('sends web-app and legacy tasks to the web-app queue', async () => {
    process.env.CUSTOMER_WEBHOOK_QUEUE_URL = 'https://sqs/customer-webhook';
    await enqueueWebhook({ ...baseTask, source: 'web-app' });
    await enqueueWebhook(baseTask); // source absent = legacy web-app task
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expect((call[0] as { input: { QueueUrl: string } }).input.QueueUrl).toBe('https://sqs/webhook');
    }
  });

  it('skips customer delivery (with a warning) when the customer queue is not configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await enqueueWebhook({ ...baseTask, source: 'api' });
      expect(sendMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CUSTOMER_WEBHOOK_QUEUE_URL/));
    } finally {
      warn.mockRestore();
    }
  });

  it('web-app delivery is unaffected by customer-queue misconfiguration', async () => {
    await enqueueWebhook({ ...baseTask, source: 'web-app' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0]![0] as { input: { QueueUrl: string } }).input.QueueUrl).toBe('https://sqs/webhook');
  });
});
