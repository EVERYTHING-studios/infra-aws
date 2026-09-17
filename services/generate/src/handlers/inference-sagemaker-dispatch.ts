import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import { parseRegionConfig, dispatchToRegion, type RegionConfig } from '../lib/sagemaker.js';

const ssm = new SSMClient({});
/**
 * SageMaker inference dispatcher. Invoked by the state machine's
 * `lambda:invoke.waitForTaskToken` Inference state with the pipeline context
 * plus the Step Functions task token. It reads the sentinel-maintained
 * `active_region` SSM parameter, stages the input image into that region's
 * SageMaker input bucket, kicks off `InvokeEndpointAsync` (InferenceId =
 * task_id), persists the task token and the target region on the task record
 * so the callback can recover both, and returns immediately — it does NOT
 * wait for inference.
 *
 * The state machine stays parked on the task token until the callback Lambda
 * calls SendTaskSuccess/SendTaskFailure.
 */
export interface DispatchInput {
  task_id: string;
  postprocess: string;
  task_token: string;
}

async function getActiveRegionConfig(): Promise<RegionConfig> {
  const paramName = requireEnv('ACTIVE_REGION_PARAM');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const activeRegion = result.Parameter?.Value;
  if (!activeRegion) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }

  const configs = parseRegionConfig(requireEnv('SAGEMAKER_REGIONS'));
  const conf = configs.find((c) => c.region === activeRegion);
  if (!conf) {
    throw new Error(
      `Active region "${activeRegion}" (SSM ${paramName}) is not present in SAGEMAKER_REGIONS ` +
        `(configured: ${configs.map((c) => c.region).join(', ')})`,
    );
  }
  return conf;
}

export async function handler(event: DispatchInput): Promise<{ dispatched: true }> {
  const task = await getTask(event.task_id);
  if (!task) {
    throw new Error(`Task ${event.task_id} not found`);
  }

  const conf = await getActiveRegionConfig();

  await dispatchToRegion(task, conf);

  // Persist the task token so the callback can resume the state machine, and
  // the target region so the scaler and sentinel can attribute the task.
  await updateTask(task.task_id, {
    sagemaker_task_token: event.task_token,
    sagemaker_region: conf.region,
    progress: 25,
  });

  return { dispatched: true };
}
