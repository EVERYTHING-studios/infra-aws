import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig } from '../lib/sagemaker.js';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Endpoint-idle publisher. Runs every minute (EventBridge). Queries the
 * IN_PROGRESS tasks that hold a SageMaker task token, attributes each to its
 * `sagemaker_region` (records pre-dating the multi-region refactor attribute
 * to us-east-1), and publishes an `EndpointIdle` datapoint for EVERY
 * configured endpoint: 0 if that endpoint's region has active tasks, 1 if
 * not. Busy attribution stays region-keyed BY DESIGN: with multiple
 * endpoints per region this marks every endpoint in a region with an
 * in-flight task as busy — over-conservative (delays a sibling endpoint's
 * scale-to-zero by <= one cooldown, bounded cents, never kills a
 * mid-inference render) and requires no new task attribute. Publishing per
 * endpoint keeps every endpoint's scale-to-zero alarm fed and lets
 * abandoned endpoints drain after the sentinel flips the election
 * elsewhere.
 */
export async function handler(): Promise<{ idle: number }> {
  const tableName = requireEnv('TASKS_TABLE');
  const regions = parseEndpointConfig(requireEnv('SAGEMAKER_ENDPOINTS'));

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

    const busyRegions = new Set(
      (result.Items ?? []).map((item) => (item.sagemaker_region as string | undefined) ?? 'us-east-1'),
    );

    await Promise.all(
      regions.map(async (conf) => {
        const cloudwatch = new CloudWatchClient({ region: conf.region });
        await cloudwatch.send(
          new PutMetricDataCommand({
            Namespace: 'EverythingStudios/SageMaker',
            MetricData: [
              {
                MetricName: 'EndpointIdle',
                Dimensions: [{ Name: 'EndpointName', Value: conf.endpointName }],
                Value: busyRegions.has(conf.region) ? 0 : 1,
                Unit: 'None',
              },
            ],
          }),
        );
      }),
    );

    // Aggregate for the return value: idle only when no region has tasks.
    const idle = regions.some((conf) => busyRegions.has(conf.region)) ? 0 : 1;
    return { idle };
  } catch (err) {
    console.error('Endpoint scaler check failed', err);
    // Safe default: publish 0 (busy) for every region so no alarm fires on errors.
    try {
      await Promise.all(
        regions.map(async (conf) => {
          const cloudwatch = new CloudWatchClient({ region: conf.region });
          await cloudwatch.send(
            new PutMetricDataCommand({
              Namespace: 'EverythingStudios/SageMaker',
              MetricData: [
                {
                  MetricName: 'EndpointIdle',
                  Dimensions: [{ Name: 'EndpointName', Value: conf.endpointName }],
                  Value: 0,
                  Unit: 'None',
                },
              ],
            }),
          );
        }),
      );
    } catch (publishErr) {
      console.error('Failed to publish safe-default metric', publishErr);
    }
    return { idle: 0 };
  }
}
