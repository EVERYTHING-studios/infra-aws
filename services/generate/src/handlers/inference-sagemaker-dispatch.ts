import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig, dispatchToRegion, type EndpointConfig } from '../lib/sagemaker.js';

const ssm = new SSMClient({});
/**
 * SageMaker inference dispatcher. Invoked by the state machine's
 * `lambda:invoke.waitForTaskToken` Inference state with the pipeline context
 * plus the Step Functions task token. It reads the sentinel-maintained
 * `active_endpoint` SSM parameter (the elected endpoint's NAME — unique per
 * region x instance type), stages the input image into that endpoint's
 * regional SageMaker input bucket, kicks off `InvokeEndpointAsync`
 * (InferenceId = task_id), persists the task token and the target region on
 * the task record so the callback can recover both, and returns immediately
 * — it does NOT wait for inference.
 *
 * The state machine stays parked on the task token until the callback Lambda
 * calls SendTaskSuccess/SendTaskFailure.
 */
export interface DispatchInput {
  task_id: string;
  postprocess: string;
  task_token: string;
}

async function getActiveEndpointConfig(): Promise<EndpointConfig> {
  const paramName = requireEnv('ACTIVE_ENDPOINT_PARAM');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const activeEndpoint = result.Parameter?.Value;
  if (!activeEndpoint) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }

  const configs = parseEndpointConfig(requireEnv('SAGEMAKER_ENDPOINTS'));
  const conf = configs.find((c) => c.endpointName === activeEndpoint);
  if (!conf) {
    throw new Error(
      `Active endpoint "${activeEndpoint}" (SSM ${paramName}) is not present in SAGEMAKER_ENDPOINTS ` +
        `(configured: ${configs.map((c) => c.endpointName).join(', ')})`,
    );
  }
  return conf;
}

export async function handler(event: DispatchInput): Promise<{ dispatched: true }> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  const conf = await getActiveEndpointConfig();

  await dispatchToRegion(task, conf);

  // Persist the task token so the callback can resume the state machine, and
  // the target region so the scaler and sentinel can attribute the task.
  await updateTask(task.task_id, {
    sagemaker_task_token: event.task_token,
    sagemaker_region: conf.region,
    progress: 25,
    inference_started_at: new Date().toISOString(),
  });

  return { dispatched: true };
}
