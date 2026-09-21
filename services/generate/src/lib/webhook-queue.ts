import { ulid } from 'ulid';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { TaskRecord, WebhookEvent } from './types.js';
import { requireEnv } from './env.js';

const sqs = new SQSClient({});

export function webhookEventFromTask(task: TaskRecord, now: Date = new Date()): WebhookEvent {
  return {
    event: 'task.updated',
    event_id: ulid(),
    user_id: task.user_id,
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
  const body = JSON.stringify(webhookEventFromTask(task));
  if (task.source === 'api') {
    // API-created tasks notify the customer's own registered endpoint. The
    // env is optional so local/unit tests and web-app-only deployments keep
    // working; skipping never blocks anything downstream.
    const queueUrl = process.env.CUSTOMER_WEBHOOK_QUEUE_URL;
    if (!queueUrl) {
      console.warn(
        `CUSTOMER_WEBHOOK_QUEUE_URL not set; skipping customer webhook for task ${task.task_id}`,
      );
      return;
    }
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    return;
  }
  // Web-app tasks (source absent = legacy) go to the web-app queue, byte-identical.
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: requireEnv('WEBHOOK_QUEUE_URL'),
      MessageBody: body,
    }),
  );
}
