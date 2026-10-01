import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../lib/env.js';
import { TASK_STATUSES, TASK_TYPES } from '../lib/types.js';
import { json } from '../lib/http.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * GET /v1/generate/admin/stats — aggregate counts of API-customer jobs
 * (source = 'api'). Scans the tasks table with a filter; fine at current
 * volume. Task records carry a 90-day TTL, so counts only cover that window.
 */
export async function handler(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tableName = requireEnv('TASKS_TABLE');

  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  const byType = Object.fromEntries(TASK_TYPES.map((t) => [t, 0])) as Record<string, number>;
  let total = 0;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#src = :api',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':api': 'api' },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      total += 1;
      const status = item['status'];
      if (typeof status === 'string' && status in byStatus) {
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      const type = item['type'];
      if (typeof type === 'string' && type in byType) {
        byType[type] = (byType[type] ?? 0) + 1;
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return json(200, {
    total,
    by_status: byStatus,
    by_type: byType,
    window_note: 'Task records expire after 90 days (TTL); counts reflect the last 90 days only.',
  });
}
