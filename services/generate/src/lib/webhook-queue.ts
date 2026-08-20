import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { TaskRecord, WebhookEvent } from './types.js';
import { requireEnv } from './env.js';

const sqs = new SQSClient({});

export function webhookEventFromTask(task: TaskRecord, now: Date = new Date()): WebhookEvent {
  return {
    event: 'task.updated',
    task_id: task.task_id,
    type: task.type,
    status: task.status,
    progress: task.progress,
    model_urls: task.model_urls,
    thumbnail_url: task.thumbnail_url,
    error: task.error,
    timestamp: now.toISOString(),
  };
}

export async function enqueueWebhook(task: TaskRecord): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: requireEnv('WEBHOOK_QUEUE_URL'),
      MessageBody: JSON.stringify(webhookEventFromTask(task)),
    }),
  );
}
