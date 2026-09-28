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
export function indexAttributes(
  record: Pick<TaskRecord, 'user_id' | 'source' | 'status' | 'created_at' | 'idempotency_key'>,
): Record<string, string> {
  const attrs: Record<string, string> = {
    gsi2pk: `STATUS#${record.status}`,
    gsi2sk: record.created_at,
  };
  if (record.idempotency_key) {
    // API tasks scope idempotency per user; web-app tasks keep the global scope.
    attrs.gsi1pk =
      record.source === 'api'
        ? `USER#${record.user_id}#IDEMP#${record.idempotency_key}`
        : `IDEMPOTENCY#${record.idempotency_key}`;
  }
  if (record.source === 'api') {
    // Sparse per-user listing indexes; web-app tasks never write these.
    attrs.gsi3pk = `USER#${record.user_id}`;
    attrs.gsi3sk = record.created_at;
    attrs.gsi4pk = `USER#${record.user_id}#STATUS#${record.status}`;
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

export async function findByIdempotencyKey(key: string, userId?: string): Promise<TaskRecord | null> {
  // With userId, look in the per-user idempotency scope (API-created tasks);
  // without it, the web-app's global scope.
  const pk = userId ? `USER#${userId}#IDEMP#${key}` : `IDEMPOTENCY#${key}`;
  const result = await client.send(
    new QueryCommand({
      TableName: requireEnv('TASKS_TABLE'),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
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
  sagemaker_region?: string;
  finished_at?: string;
  inference_started_at?: string;
  inference_finished_at?: string;
  capacity_started_at?: string;
  inference_instance_type?: string;
  remove?: string[];
}

export async function updateTask(taskId: string, update: TaskUpdate): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const { remove: removeFields, ...updateFields } = update;
  const fields: Record<string, unknown> = { ...updateFields, updated_at: now };
  if (updateFields.status) {
    // Keep the status GSI in sync.
    fields.gsi2pk = `STATUS#${updateFields.status}`;
    // Keep the per-user status GSI in sync for API-created tasks.
    const current = await getTask(taskId);
    if (current?.source === 'api') {
      fields.gsi4pk = `USER#${current.user_id}#STATUS#${updateFields.status}`;
    }
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

  const removes: string[] = [];
  if (removeFields) {
    for (const key of removeFields) {
      names[`#${key}`] = key;
      removes.push(`#${key}`);
    }
  }

  let updateExpression = `SET ${sets.join(', ')}`;
  if (removes.length > 0) {
    updateExpression += ` REMOVE ${removes.join(', ')}`;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: requireEnv('TASKS_TABLE'),
      Key: taskKey(taskId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as TaskRecord;
}

export interface ListApiTasksOptions {
  status?: TaskStatus;
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export interface ListApiTasksResult {
  items: TaskRecord[];
  lastEvaluatedKey?: Record<string, unknown>;
}

/**
 * List a user's API-created jobs, newest first. Queries gsi3 (all statuses)
 * or gsi4 (single status); both are sparse, so users without API jobs return
 * empty items.
 */
export async function listApiTasksByUser(
  userId: string,
  opts: ListApiTasksOptions,
): Promise<ListApiTasksResult> {
  const result = await client.send(
    new QueryCommand({
      TableName: requireEnv('TASKS_TABLE'),
      IndexName: opts.status ? 'gsi4' : 'gsi3',
      KeyConditionExpression: opts.status ? 'gsi4pk = :pk' : 'gsi3pk = :pk',
      ExpressionAttributeValues: {
        ':pk': opts.status ? `USER#${userId}#STATUS#${opts.status}` : `USER#${userId}`,
      },
      ScanIndexForward: false,
      Limit: opts.limit,
      ExclusiveStartKey: opts.exclusiveStartKey,
    }),
  );
  return {
    items: (result.Items ?? []) as TaskRecord[],
    ...(result.LastEvaluatedKey ? { lastEvaluatedKey: result.LastEvaluatedKey } : {}),
  };
}
