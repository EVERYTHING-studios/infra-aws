import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { TaskRecord, TaskStatus } from './types.js';
import { requireEnv } from './env.js';

const TTL_DAYS = 90;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function taskKey(taskId: string): { pk: string } {
  return { pk: `TASK#${taskId}` };
}

export function ttlFromNow(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60;
}

/** Attributes derived from the record that keep the GSIs in sync. */
export function indexAttributes(record: Pick<TaskRecord, 'status' | 'created_at' | 'idempotency_key'>): Record<string, string> {
  const attrs: Record<string, string> = {
    gsi2pk: `STATUS#${record.status}`,
    gsi2sk: record.created_at,
  };
  if (record.idempotency_key) {
    attrs.gsi1pk = `IDEMPOTENCY#${record.idempotency_key}`;
  }
  return attrs;
}

export async function putTask(record: TaskRecord): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: requireEnv('TASKS_TABLE'),
      Item: { ...taskKey(record.task_id), ...record, ...indexAttributes(record) },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: requireEnv('TASKS_TABLE'),
      Key: taskKey(taskId),
    }),
  );
  return (result.Item as TaskRecord | undefined) ?? null;
}

export async function findByIdempotencyKey(key: string): Promise<TaskRecord | null> {
  const result = await client.send(
    new QueryCommand({
      TableName: requireEnv('TASKS_TABLE'),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `IDEMPOTENCY#${key}` },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as TaskRecord | undefined) ?? null;
}

export interface TaskUpdate {
  status?: TaskStatus;
  progress?: number;
  artifact_prefix?: string;
  model_urls?: TaskRecord['model_urls'];
  thumbnail_url?: string;
  error?: TaskRecord['error'];
  execution_arn?: string;
  inference_backend?: string;
  sagemaker_task_token?: string;
  finished_at?: string;
}

export async function updateTask(taskId: string, update: TaskUpdate): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { ...update, updated_at: now };
  if (update.status) {
    // Keep the status GSI in sync.
    fields.gsi2pk = `STATUS#${update.status}`;
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: requireEnv('TASKS_TABLE'),
      Key: taskKey(taskId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as TaskRecord;
}
