import { getTask, updateTask } from '../lib/tasks-repo.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';

interface FailInput {
  task_id: string;
  error?: {
    Error?: string;
    Cause?: string;
  };
}

/**
 * Catch-all failure state: mark the task FAILED with a caller-safe error and
 * notify the web-app so it can refund credits.
 */
export async function handler(event: FailInput): Promise<{ task_id: string }> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  // Don't clobber a cancellation that raced the pipeline.
  if (task.status === 'CANCELED') {
    return { task_id: task.task_id };
  }

  let message = 'generation failed';
  if (event.error?.Cause) {
    try {
      const cause = JSON.parse(event.error.Cause);
      if (typeof cause.errorMessage === 'string') {
        message = cause.errorMessage;
      }
    } catch {
      message = event.error.Cause.slice(0, 500);
    }
  }

  const updated = await updateTask(task.task_id, {
    status: 'FAILED',
    error: { code: event.error?.Error ?? 'pipeline_error', message },
    finished_at: new Date().toISOString(),
  });

  await enqueueWebhook(updated);
  return { task_id: task.task_id };
}
