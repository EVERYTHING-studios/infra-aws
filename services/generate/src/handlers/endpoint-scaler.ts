import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig, parseOptionalEndpointConfig, type EndpointConfig } from '../lib/sagemaker.js';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Look-back window for the per-endpoint backlog sample (5 x 60s datapoints). */
const BACKLOG_WINDOW_MS = 5 * 60 * 1000;

/**
 * Endpoints whose OWN async queue is non-empty: ApproximateBacklogSize
 * Maximum > 0 over the last BACKLOG_WINDOW_MS. The metric namespace is
 * regional, so this is one GetMetricData call per distinct region with one
 * query per endpoint in it. Empty or missing datapoints mean "no backlog",
 * which leaves the region-keyed result in charge for the common case.
 *
 * Query ids are positional (`e0`, `e1`, ...) rather than endpoint names
 * because GetMetricData requires ids to match [a-z][a-zA-Z0-9_]* and endpoint
 * names contain hyphens; the results are mapped back by position.
 */
async function endpointsHoldingBacklog(endpoints: EndpointConfig[]): Promise<Set<string>> {
  const byRegion = new Map<string, EndpointConfig[]>();
  for (const conf of endpoints) {
    const list = byRegion.get(conf.region) ?? [];
    list.push(conf);
    byRegion.set(conf.region, list);
  }

  const busy = new Set<string>();
  await Promise.all(
    [...byRegion].map(async ([region, confs]) => {
      const cloudwatch = new CloudWatchClient({ region });
      const result = await cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: new Date(Date.now() - BACKLOG_WINDOW_MS),
          EndTime: new Date(),
          MetricDataQueries: confs.map((conf, i) => ({
            Id: `e${i}`,
            MetricStat: {
              Metric: {
                Namespace: 'AWS/SageMaker',
                MetricName: 'ApproximateBacklogSize',
                Dimensions: [{ Name: 'EndpointName', Value: conf.endpointName }],
              },
              Period: 60,
              Stat: 'Maximum',
            },
          })),
        }),
      );
      for (const sample of result.MetricDataResults ?? []) {
        const conf = confs[Number(sample.Id?.slice(1))];
        if (conf && sample.Values?.some((value) => value > 0)) busy.add(conf.endpointName);
      }
    }),
  );
  return busy;
}

/**
 * Endpoint-idle publisher. Runs every minute (EventBridge). Queries the
 * IN_PROGRESS and QUEUED tasks that hold a SageMaker task token, attributes
 * each to its `sagemaker_region` (records pre-dating the multi-region
 * refactor attribute to us-east-1), and publishes an `EndpointIdle`
 * datapoint for EVERY configured endpoint of BOTH precision chains (the v1
 * chain from SAGEMAKER_ENDPOINTS, the v2 Pixal3D chain from
 * SAGEMAKER_ENDPOINTS_PIXAL3D when configured): 0 if that endpoint's region
 * has active tasks OR that endpoint's own async queue holds work, 1 if not.
 * QUEUED counts as busy: a request waiting in SageMaker's async queue is
 * still holding capacity intent, and marking its region idle would let
 * scale-to-zero kill the instance it is waiting on.
 *
 * Region-keyed attribution is deliberately over-conservative (with multiple
 * endpoints per region it marks every endpoint in a region with an
 * in-flight task as busy — delays a sibling endpoint's scale-to-zero by
 * <= one cooldown, bounded cents, never kills a mid-inference render) and
 * requires no new task attribute. It is NOT sufficient alone: a rescued task
 * leaves its original copy in the abandoned pool's async queue while its
 * record names only the NEW region, so that pool's backlog is invisible to a
 * region-keyed set — observed 2026-10-15, when the us-east-1 v2 endpoint
 * held ApproximateBacklogSize=1 while all four tasks were attributed to
 * us-east-2. Each endpoint's OWN backlog is therefore unioned in, so a pool
 * holding queued work is never published idle and the scale-to-zero alarm
 * cannot override its backlog-driven scale-up (observed: "Setting desired
 * instance count to 1" = Overridden at 20:32:54Z and 21:34:54Z, each
 * preceded by a successful scale-down).
 *
 * Publishing per endpoint keeps every endpoint's scale-to-zero alarm fed and
 * lets abandoned endpoints drain after the sentinel flips the election
 * elsewhere.
 */
export async function handler(): Promise<{ idle: number }> {
  const tableName = requireEnv('TASKS_TABLE');
  const endpoints = [
    ...parseEndpointConfig(requireEnv('SAGEMAKER_ENDPOINTS')),
    ...parseOptionalEndpointConfig(process.env.SAGEMAKER_ENDPOINTS_PIXAL3D),
  ];

  try {
    const results = await Promise.all(
      ['STATUS#IN_PROGRESS', 'STATUS#QUEUED'].map((status) =>
        docClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'gsi2',
            KeyConditionExpression: 'gsi2pk = :status',
            ExpressionAttributeValues: { ':status': status },
            FilterExpression: 'attribute_exists(sagemaker_task_token)',
            Limit: 100,
          }),
        ),
      ),
    );

    const busyRegions = new Set(
      results
        .flatMap((result) => result.Items ?? [])
        .map((item) => (item.sagemaker_region as string | undefined) ?? 'us-east-1'),
    );

    // A pool holding its own queued work is busy even when no task record
    // names its region (post-rescue leftovers).
    const backlogBusy = await endpointsHoldingBacklog(endpoints);
    const busyEndpoints = new Set(
      endpoints
        .filter((conf) => busyRegions.has(conf.region) || backlogBusy.has(conf.endpointName))
        .map((conf) => conf.endpointName),
    );

    await Promise.all(
      endpoints.map(async (conf) => {
        const cloudwatch = new CloudWatchClient({ region: conf.region });
        await cloudwatch.send(
          new PutMetricDataCommand({
            Namespace: 'EverythingStudios/SageMaker',
            MetricData: [
              {
                MetricName: 'EndpointIdle',
                Dimensions: [{ Name: 'EndpointName', Value: conf.endpointName }],
                Value: busyEndpoints.has(conf.endpointName) ? 0 : 1,
                Unit: 'None',
              },
            ],
          }),
        );
      }),
    );

    // Aggregate for the return value: idle only when no endpoint is busy.
    return { idle: busyEndpoints.size > 0 ? 0 : 1 };
  } catch (err) {
    console.error('Endpoint scaler check failed', err);
    // Safe default: publish 0 (busy) for every region so no alarm fires on errors.
    try {
      await Promise.all(
        endpoints.map(async (conf) => {
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
