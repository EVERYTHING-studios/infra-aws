# SageMaker control plane

The single us-east-1 control plane for the multi-region, multi-instance-type
SageMaker inference backend. The parent `generate-inference` module
instantiates this module ONCE (default provider) when
`inference_backend = "sagemaker"`; the regional stacks (buckets, per-type
Model/EndpointConfig/Endpoint sets, SNS topics, autoscaling) live in the
sibling `sagemaker-region/` module, one instance per candidate region
(us-east-1, us-east-2, us-west-2 — the only regions where SageMaker offers
`ml.g7e.2xlarge`). This module receives the full (region × instance type)
endpoint list as `endpoints`, in the parent's type-major chain-priority
order, so its IAM policies and Lambda env wiring cover every chain endpoint
without further edits.

Why a control plane at all: AWS exposes no "capacity availability" API, and
SageMaker has no native multi-region or multi-instance-type routing. An
instance type's capacity in a region is only proven by real provisioning
attempts, so the design keeps an endpoint deployed for every (type, region)
pair in the chain (free at zero instances), drives provisioning with real
tasks, and **elects** the active endpoint from live evidence in cold-price
chain order.

## Lambdas

All four keep the pre-refactor function names
(`{name_prefix}-inference-sagemaker-*`); sources are in
`services/generate/src/handlers/`.

### Dispatcher (`...-sagemaker-dispatch`)

Invoked by the state machine's `lambda:invoke.waitForTaskToken` Inference
state. Reads `active_endpoint` from SSM (the elected endpoint's NAME —
unique per region × type), looks the endpoint up in the
`SAGEMAKER_ENDPOINTS` JSON env, stages the input image into that endpoint's
regional input bucket (cross-region server-side S3 copy from the work
bucket), calls `InvokeEndpointAsync` (`InferenceId = task_id`), and returns
immediately — it does NOT wait for inference. The Step Functions task token
and the target region (`sagemaker_region`, bookkeeping only — the callback
derives truth from the SNS subscription ARN) are stored on the task record.

Env: `TASKS_TABLE`, `WORK_BUCKET`, `SAGEMAKER_ENDPOINTS`,
`ACTIVE_ENDPOINT_PARAM`.

### Callback (`...-sagemaker-callback`)

Subscribed to every region's success/error SNS topics (the subscriptions live
in `sagemaker-region`; the invoke permissions below). Derives the source
region for each SNS record from `record.EventSubscriptionArn`
(`arn:aws:sns:<region>:...`) and builds a region-scoped S3 client — robust
under any election flip. On success it reads the GLB from that region's output
bucket (bucket/key parsed from the message's `outputLocation`), copies it to
`tasks/{task_id}/raw/model.glb` in the work bucket, calls
`states:SendTaskSuccess`, then clears `sagemaker_task_token` (cleared after
the SFN call so SNS retries can still recover the token if the SFN call
throws). On error it calls `SendTaskFailure` and clears the token.

**Consumed-token guard:** after a sentinel re-dispatch, an abandoned region's
queue can still deliver a late duplicate callback against an
already-consumed token. SFN `InvalidToken` / `TaskDoesNotExist` /
`ResourceNotFound` errors on `SendTaskSuccess`/`SendTaskFailure` are logged
no-ops — the callback returns normally so SNS stops retrying instead of
retrying forever.

Env: `TASKS_TABLE`, `WORK_BUCKET`, `POSTPROCESS_MODE`.

### Scaler (`...-sagemaker-scaler`)

Queries the tasks table GSI2 for IN_PROGRESS tasks with an active
`sagemaker_task_token` and publishes `EndpointIdle` to CloudWatch namespace
`EverythingStudios/SageMaker` **for every configured endpoint each run**
(dimension `EndpointName`): value 0 (busy) if any in-flight task is
attributed to that endpoint's region (via the task's `sagemaker_region`
attribute; legacy records without it attribute to us-east-1), else 1 (idle).
Busy attribution stays region-keyed by design: with multiple endpoints per
region this marks every sibling endpoint in a busy region busy too —
over-conservative by <= one cooldown (bounded cents, never kills a
mid-inference render) and needs no new task attribute. Per-endpoint
publication keeps every scale-to-zero alarm fed and lets abandoned endpoints
drain after a flip. Safe default 0 on error — never scale down on monitoring
failure.

Env: `TASKS_TABLE`, `SAGEMAKER_ENDPOINTS`.

### Capacity sentinel (`...-sagemaker-sentinel`)

Runs every minute (same EventBridge rule as the scaler). Describes every
configured endpoint (`sagemaker:DescribeEndpoint`) and its scaling
activities (`application-autoscaling:DescribeScalingActivities` on resource
`endpoint/<name>/variant/trellis`), classifies each endpoint, elects the
active one, and re-dispatches stranded tasks. Details below.

Env: `TASKS_TABLE`, `WORK_BUCKET`, `SAGEMAKER_ENDPOINTS`,
`ACTIVE_ENDPOINT_PARAM`, `LAST_FLIP_PARAM`, `FLIP_COOLDOWN_SECONDS` (300).

## EventBridge

One `rate(1 minute)` rule with two targets: the scaler and the sentinel
(`aws_lambda_permission` for each). Kept on a single rule so the two runs stay
in lockstep — the scaler's `EndpointIdle` publication and the sentinel's
classification see the same minute's evidence.

## SNS invoke permissions

`aws_lambda_permission` for the callback Lambda, `for_each` over the distinct
regions in the `endpoints` list — one pair per candidate region
(`AllowSNSSuccessInvoke-<region>` / `AllowSNSErrorInvoke-<region>`), with
that region's topic ARNs as `source_arn` (topics are region-shared across
the region's per-type endpoints). The permission lives in the Lambda's
region (us-east-1); the source topic ARN is regional — SNS cross-region
Lambda delivery supports this.

## Election SSM parameters

- `/generate/${env}/sagemaker/active_endpoint` — the NAME of the endpoint
  currently receiving dispatches (globally unique across the chain: us-east-1
  endpoints are unsuffixed, e.g. `generate-staging-sagemaker-g5`, alternates
  gain a region suffix, e.g. `...-sagemaker-g5-useast2`). Terraform only owns
  its creation
  (initial value = the chain head, `var.endpoints[0]`); the sentinel flips it
  at runtime, so the resource carries
  `lifecycle { ignore_changes = [value] }`.
- `/generate/${env}/sagemaker/last_flip` — ISO timestamp of the sentinel's
  last flip; drives the cooldown. Initial value is epoch so the first flip is
  never blocked. Same `ignore_changes`. One global cooldown covers the whole
  chain (prevents chain flapping, not just per-endpoint oscillation).

## Endpoint classification

From `describe-endpoint` + scaling-activity evidence, per endpoint:

- `FAILED` — endpoint status `Failed`. Never self-heals; the sentinel never
  elects it. Recovery is manual (see `sagemaker-region/README.md`).
- `DROUGHT` — InService/Updating with desired >= 1 but current = 0 and the
  latest scaling activity ended `Unfulfilled`/`Failed` — proven no capacity.
- `PROVISIONING` — endpoint status Creating/Updating/SystemUpdating, or a
  scale-up attempt in flight (desired > current with a Pending/InProgress
  activity). A provisioning attempt takes 15-25 min to prove itself; flipping
  mid-provisioning would thrash.
- `HEALTHY` — InService and (current >= 1 or desired = 0) and not DROUGHT.
  Within HEALTHY, a region is **proven** if an instance is running now or the
  latest scaling activity recently scaled UP successfully (within 1 h). A
  successful scale-down proves nothing about capacity and must not make an
  idle region steal traffic back.

## Election rules

Candidate order in `SAGEMAKER_ENDPOINTS` = the parent's `endpoint_priority`
list: **type-major** — for each instance type in `sagemaker_instance_types`
order (the cold-price chain g5 → g6e → g7e from the env tfvars), each region
in `sagemaker_candidate_regions` priority order. Prices are region-invariant,
so the cheapest type in any region beats a pricier type in the preferred
region.

1. Active is HEALTHY or PROVISIONING → no flip, **except failback**: flip to
   a higher-priority (earlier in the chain) endpoint only when it is
   healthy-**proven**. An idle-unproven endpoint must not steal traffic and
   re-enter the capacity lottery.
2. Active is DROUGHT or FAILED → flip to the first HEALTHY endpoint.
   Idle-unproven counts here — the flip itself is the probe: the next task's
   backlog alarm scales that endpoint from zero; success proves capacity,
   `Unfulfilled` (~10-30 min) refutes it and the sentinel moves on.
3. No HEALTHY candidate → stay. Every endpoint keeps retrying for free;
   tasks wait on the state machine timeout and the cancel API cleans them up.

Every flip writes the elected endpoint name to `active_endpoint` +
`last_flip` and is rate-limited by the 300 s cooldown (anti-flapping;
combined with the ~10-30 min it takes `Unfulfilled` evidence to appear,
oscillation periods stay >= 30 min).

## Stranded-task rescue

On each run, while the active endpoint is HEALTHY: any IN_PROGRESS task with
a stored task token whose recorded `sagemaker_region` differs from the active
endpoint's region is re-dispatched to the active endpoint (the input image is
still in the work bucket at `tasks/{id}/input/0`; `InferenceId = task_id` is
unchanged, so the parked state-machine token resumes normally on the new
endpoint's success callback) and its `sagemaker_region` is updated. The
task's DynamoDB key update is conditional on the record still existing. A
late duplicate callback from the abandoned region hits an already-consumed
token — the callback's consumed-token guard makes it a logged no-op. Net
effect: a drought onset costs an in-flight task ~10-35 min (evidence + flip
+ re-dispatch) instead of the 1 h state-machine timeout.

## Adding a region

See the runbook in `trellis2image/docs/sagemaker-iac-contract.md`: quota
approval, targeted Terraform apply of the new region's buckets, artifact
replication, full apply — the sentinel then picks the region up automatically
with no manual election step.
