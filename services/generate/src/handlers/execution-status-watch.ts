import { getTask, updateTask } from '../lib/tasks-repo.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';

interface ExecutionStatusEvent {
  detail?: {
    /** Execution name — the pipeline starts executions named by task_id. */
    name?: string;
    status?: string;
  };
}

const TERMINAL_FAILURES = ['TIMED_OUT', 'FAILED', 'ABORTED'];

/**
 * EventBridge watch on "Step Functions Execution Status Change" for the
 * pipeline state machine. Catches terminal failures the in-pipeline Catch
 * cannot: TIMED_OUT (and ABORTED on StopExecution races) otherwise strand
 * the task record in IN_PROGRESS forever.
 *
 * The IN_PROGRESS guard prevents double-firing: if the pipeline Catch
 * (fail-task) already ran, the record is FAILED and we skip; cancellations
 * mark the record CANCELED before StopExecution, so the ABORTED event skips.
 */
export async function handler(event: ExecutionStatusEvent): Promise<{ task_id: string } | undefined> {
  const d = event.detail;
  if (!d?.name || !d?.status) return;
  if (!TERMINAL_FAILURES.includes(d.status)) return;

  // No throw: the event may race record deletion.
  const task = await getTask(d.name);
  if (!task) return;
  if (task.status !== 'IN_PROGRESS') return;

  const updated = await updateTask(task.task_id, {
    status: 'FAILED',
    error: {
      code: 'execution_status',
      message: `pipeline execution ended ${d.status.toLowerCase()}`,
    },
    finished_at: new Date().toISOString(),
  });

  await enqueueWebhook(updated);
  return { task_id: task.task_id };
}
