import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getTask, updateTask } from '../lib/tasks-repo.js';
import { requireEnv } from '../lib/env.js';
import { parseEndpointConfig, dispatchToRegion, type EndpointConfig } from '../lib/sagemaker.js';
import { enqueueWebhook } from '../lib/webhook-queue.js';
import type { PrecisionModel } from '../lib/types.js';

const ssm = new SSMClient({});
/**
 * SageMaker inference dispatcher. Invoked by the state machine's
 * `lambda:invoke.waitForTaskToken` Inference state with the pipeline context
 * plus the Step Functions task token. It reads the sentinel-maintained
 * `active_endpoint` SSM parameter for the TASK'S MODEL CHAIN (v1
 * trellis / v2 pixal3d — the elected endpoint's NAME, unique per region x
 * type), stages the input image into that endpoint's regional SageMaker
 * input bucket, kicks off `InvokeEndpointAsync` (InferenceId = task_id),
 * persists the task token and the target region on the task record so the
 * callback can recover both, and returns immediately — it does NOT wait for
 * inference.
 *
 * The state machine stays parked on the task token until the callback Lambda
 * calls SendTaskSuccess/SendTaskFailure.
 */
export interface DispatchInput {
  task_id: string;
  postprocess: string;
  task_token: string;
  /** Precision chain, threaded from the API request through the task record. */
  model?: PrecisionModel;
}

interface ChainEnv {
  /** Env var holding the chain's endpoint list JSON (e.g. SAGEMAKER_ENDPOINTS). */
  endpointsEnv: string;
  /** Env var holding the chain's active-endpoint SSM parameter name. */
  activeParamEnv: string;
}

const TRELLIS_CHAIN: ChainEnv = {
  endpointsEnv: 'SAGEMAKER_ENDPOINTS',
  activeParamEnv: 'ACTIVE_ENDPOINT_PARAM',
};
const PIXAL3D_CHAIN: ChainEnv = {
  endpointsEnv: 'SAGEMAKER_ENDPOINTS_PIXAL3D',
  activeParamEnv: 'ACTIVE_ENDPOINT_PARAM_PIXAL3D',
};

async function getActiveEndpointConfig(chain: ChainEnv): Promise<EndpointConfig> {
  const paramName = requireEnv(chain.activeParamEnv);
  const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const activeEndpoint = result.Parameter?.Value;
  if (!activeEndpoint) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }

  const configs = parseEndpointConfig(requireEnv(chain.endpointsEnv));
  const conf = configs.find((c) => c.endpointName === activeEndpoint);
  if (!conf) {
    throw new Error(
      `Active endpoint "${activeEndpoint}" (SSM ${paramName}) is not present in ${chain.endpointsEnv} ` +
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

  // The task's precision chain: the event payload (threaded from the API
  // request through the pipeline) wins, the persisted record is the
  // fallback, and absent means v1 — the pre-v2 default.
  const model: PrecisionModel = event.model ?? task.model ?? 'precision-v1';
  const chain = model === 'precision-v2' ? PIXAL3D_CHAIN : TRELLIS_CHAIN;
  if (model === 'precision-v2' && !process.env[chain.endpointsEnv]) {
    throw new Error('Task requested precision-v2 but no Pixal3D chain is configured (SAGEMAKER_ENDPOINTS_PIXAL3D is unset)');
  }

  const conf = await getActiveEndpointConfig(chain);

  await dispatchToRegion(task, conf);

  // Persist the task token so the callback can resume the state machine, and
  // the target region so the scaler and sentinel can attribute the task.
  const updated = await updateTask(task.task_id, {
    status: 'QUEUED',
    sagemaker_task_token: event.task_token,
    sagemaker_region: conf.region,
    progress: 25,
    inference_started_at: new Date().toISOString(),
    inference_instance_type: conf.instanceType,
  });

  await enqueueWebhook(updated);

  return { dispatched: true };
}
