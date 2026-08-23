import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { requireEnv } from '../lib/env.js';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const cloudwatch = new CloudWatchClient({});

export async function handler(): Promise<{ idle: number }> {
  const tableName = requireEnv('TASKS_TABLE');
  const endpointName = requireEnv('ENDPOINT_NAME');

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'gsi2',
        KeyConditionExpression: 'gsi2pk = :status',
        ExpressionAttributeValues: { ':status': 'STATUS#IN_PROGRESS' },
        FilterExpression: 'attribute_exists(sagemaker_task_token)',
        Limit: 100,
      }),
    );
    const activeCount = result.Items?.length ?? 0;
    const idle = activeCount > 0 ? 0 : 1;

    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'EverythingStudios/SageMaker',
        MetricData: [
          {
            MetricName: 'EndpointIdle',
            Dimensions: [{ Name: 'EndpointName', Value: endpointName }],
            Value: idle,
            Unit: 'None',
          },
        ],
      }),
    );

    return { idle };
  } catch (err) {
    console.error('Endpoint scaler check failed', err);
    // Safe default: publish 0 (busy) so the alarm does not fire on errors.
    try {
      await cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: 'EverythingStudios/SageMaker',
          MetricData: [
            {
              MetricName: 'EndpointIdle',
              Dimensions: [{ Name: 'EndpointName', Value: endpointName }],
              Value: 0,
              Unit: 'None',
            },
          ],
        }),
      );
    } catch (publishErr) {
      console.error('Failed to publish safe-default metric', publishErr);
    }
    return { idle: 0 };
  }
}
