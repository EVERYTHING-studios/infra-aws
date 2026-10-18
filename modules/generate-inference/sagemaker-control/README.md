# SageMaker control plane

The single us-east-1 control plane for the multi-region, multi-instance-type
SageMaker inference backend. The parent `generate-inference` module
instantiates this module ONCE (default provider) when
`inference_backend = "sagemaker"`; the regional stacks (buckets, per-type
Model/EndpointConfig/Endpoint sets, SNS topics, autoscaling) live in the
sibling `sagemaker-region/` module, one instance per candidate region per
precision chain (us-east-1, us-east-2, us-west-2 — the only regions where
SageMaker offers `ml.g7e.2xlarge`). This module receives the full
(region × instance type) endpoint list as `endpoints`, in the parent's
type-major chain-priority order, so its IAM policies and Lambda env wiring
cover every chain endpoint without further edits.

**Precision chains.** The same control plane serves BOTH engines: the v1
TRELLIS chain (`endpoints`, variant `trellis`) and, when deployed, the v2
Pixal3D chain (`endpoints_pixal3d`, variant `pixal3d` — see
`pixal3d_enabled` in the parent). Each chain elects independently with its
own SSM params; tasks are routed by their `model` field
(`precision-v1` default, `precision-v2` for Pixal3D). With
`endpoints_pixal3d = []` every v2 resource/env/permission is absent and the
module is byte-identical to its pre-v2 form.

Why a control plane at all: AWS exposes no "capacity availability" API, and
SageMaker has no native multi-region or multi-instance-type routing. An
instance type's capacity in a region is only proven by real provisioning
attempts, so the design keeps an endpoint deployed for every (type, region)
pair in the chain (free at zero instances), drives provisioning with real
tasks, **elects** the active endpoint from live evidence in cold-price
chain order, and **spreads** new work across the whole chain whenever no
pool can serve — every pool keeps asking AWS for capacity, so a shortage
costs queue time instead of stalling the chain on one pool.

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

**Spreading while the chain is dry.** Before using the election the
dispatcher reads the chain's capacity snapshot (the sentinel's
`capacity` param, ≤ 5 min old). If that snapshot says `no_healthy` — no pool
of the chain can serve right now — the task is placed on
`eligible[sumOfCharCodes(task_id) % eligible.length]` over every chain entry
whose class is not `FAILED`, instead of on the elected endpoint. Every dry
pool is still asking AWS for capacity and whichever one is granted it drains
immediately, so holding a share of the backlog on each is what keeps the
chain moving. This is **placement, never duplication**: one task is invoked
at exactly one endpoint, and a queued async request cannot be cancelled, so
there is no copy left behind to withdraw or pay for. The chosen entry's
region/type are persisted as usual, so the scaler and sentinel attribute the
task correctly. The election is untouched whenever any entry is HEALTHY
(including a stale or unreadable snapshot, or a missing `ParameterNotFound`
param — the pre-spread behaviour).

Env: `TASKS_TABLE`, `WORK_BUCKET`, `SAGEMAKER_ENDPOINTS`,
`ACTIVE_ENDPOINT_PARAM`, `CAPACITY_PARAM`, `SAGEMAKER_ENDPOINTS_PIXAL3D`,
`ACTIVE_ENDPOINT_PARAM_PIXAL3D`, `CAPACITY_PARAM_PIXAL3D`. The task's `model`
(`event.model ?? task.model ?? precision-v1`) selects the chain: v2 tasks
read the pixal3d param, capacity param and endpoint list; a v2 task on a
v2-off environment fails fast with a clear error.

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
attribute; legacy records without it attribute to us-east-1) **or that
endpoint's own `ApproximateBacklogSize` Maximum over the last 5 min is > 0**,
else 1 (idle). Busy attribution stays region-keyed by design: with multiple
endpoints per region this marks every sibling endpoint in a busy region busy
too — over-conservative by <= one cooldown (bounded cents, never kills a
mid-inference render) and needs no new task attribute. Region-keyed
attribution alone is not sufficient, though: a rescued task leaves its
original copy in the abandoned pool's queue while its record names only the
NEW region, so that pool's backlog is invisible to a region-keyed set. The
per-endpoint backlog read (one `cloudwatch:GetMetricData` call per candidate
region, one query per endpoint) closes that hole — a pool holding queued work
is never published idle, so its scale-to-zero alarm cannot override the
backlog-driven scale-up. Per-endpoint publication keeps every scale-to-zero
alarm fed and lets abandoned endpoints drain after a flip. Safe default 0 on
error — never scale down on monitoring failure.

Env: `TASKS_TABLE`, `SAGEMAKER_ENDPOINTS`, `SAGEMAKER_ENDPOINTS_PIXAL3D`
(both chains' endpoints are fed; `[]` = the v2 chain is absent).

### Capacity sentinel (`...-sagemaker-sentinel`)


Runs every minute (same EventBridge rule as the scaler). Describes every
configured endpoint (`sagemaker:DescribeEndpoint`) and its scaling
activities (`application-autoscaling:DescribeScalingActivities` on resource
`endpoint/<name>/variant/<variantName>`, per chain), classifies each
endpoint, elects the active one, publishes the chain's capacity snapshot for
the dispatcher's spread decision, and re-dispatches stranded tasks — the
whole pass runs independently per precision chain with per-chain SSM
params, and stranded tasks are partitioned by their own `model` so neither
chain rescues the other's tasks. Details below.

Env: `TASKS_TABLE`, `WORK_BUCKET`, `SAGEMAKER_ENDPOINTS`,
`ACTIVE_ENDPOINT_PARAM`, `LAST_FLIP_PARAM`, `CAPACITY_PARAM`,
`SAGEMAKER_ENDPOINTS_PIXAL3D`, `ACTIVE_ENDPOINT_PARAM_PIXAL3D`,
`LAST_FLIP_PARAM_PIXAL3D`, `CAPACITY_PARAM_PIXAL3D`,
`FLIP_COOLDOWN_SECONDS` (300, shared by both chains).

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

When the v2 chain is deployed, a second pair per region covers its
`-pixal3d`-suffixed topics (`AllowSNSSuccessPixal3dInvoke-<region>` /
`AllowSNSErrorPixal3dInvoke-<region>`); the set is empty when
`endpoints_pixal3d` is empty.

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
- `/generate/${env}/sagemaker/pixal3d/active_endpoint` and
  `.../pixal3d/last_flip` — the v2 (Pixal3D) chain's pair, identical
  semantics; created only when `endpoints_pixal3d` is non-empty.
- `/generate/${env}/sagemaker/capacity` — the chain's capacity snapshot,
  rewritten by the sentinel every minute and read by the dispatcher:
  `{"at":"<ISO>","no_healthy":<bool>,"classes":{"<endpoint name>":
  "FAILED"|"DROUGHT"|"PROVISIONING"|"HEALTHY"}}`. Terraform seeds it with an
  epoch timestamp and `no_healthy: false` so a dispatcher reading it before
  the first sentinel run falls back to the election; a snapshot older than
  5 min is ignored for the same reason. Same `ignore_changes`.
- `/generate/${env}/sagemaker/pixal3d/capacity` — the v2 chain's snapshot,
  identical semantics; created only when `endpoints_pixal3d` is non-empty.

## Endpoint classification

From `describe-endpoint` + scaling-activity evidence, per endpoint:

- `FAILED` — endpoint status `Failed`. Never self-heals; the sentinel never
  elects it. Recovery is manual (see `sagemaker-region/README.md`).
- `DROUGHT` — desired >= 1 but current = 0 with hard no-capacity evidence:
  a `FailureReason` naming `InsufficientInstanceCapacity`, or the latest
  scaling activity ended `Unfulfilled`/`Failed`, or a scale-up has been in
  flight longer than 15 min. On the 2026-10-15 us-east-2 `ml.g6e.2xlarge`
  shortage the evidence arrived in that order — `FailureReason` ~40 min in
  (inferred from `LastModifiedTime`; the API exposes no timestamp for it),
  the activity's `Unfulfilled` after 2h00m, and the 15-min rule at ~16 min —
  so the clock is the primary trigger and the explicit signals are fast-lane
  confirmations, not the reverse. A false DROUGHT is nearly free: it only
  orders routing (the pool keeps `DesiredInstanceCount=1`, keeps retrying on
  SageMaker's side, and stays in the dispatcher's spread set), which is why
  the window is deliberately not raised — measured successful cold starts are
  5-6 min (7 of the 8 successful scale-ups on the two staging v2 pools:
  4.9, 5.0, 5.5, 5.6, 6.0, 6.1, 8.7 min; outliers 31.5 and 50.8 min), so
  15 min is ~2.5x a typical start, and a longer window would only delay
  failover and the spread.
- `PROVISIONING` — endpoint status Creating/Updating/SystemUpdating, or a
  scale-up attempt in flight (desired > current with a Pending/InProgress
  activity) that is not DROUGHT. A fresh activity `StartTime` is a retry, not
  progress: dry pools re-issue attempts indefinitely (us-east-1 opened four
  `set to 1` attempts across 20:32Z-23:58Z on 2026-10-15, each left open ~1 h
  with no instance), so an in-flight attempt never extends the clock.
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
3. No HEALTHY candidate → stay, and **spread**: new tasks are placed across
   every non-FAILED pool (see the dispatcher), so each pool holds a share of
   the backlog and whichever one AWS grants capacity to drains immediately.
   Every endpoint keeps retrying for free; tasks wait on the state-machine
   timeout and the cancel API cleans them up.

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

**Cold-start window.** Rescue is the only path that creates a second
invocation of a task, and a queued async request can never be cancelled — the
abandoned copy stays in the old pool's queue and burns a full render whenever
that pool is next granted capacity, so every gratuitous rescue is potential
duplicate spend. A task whose own pool could still serve it is therefore
skipped for the first 20 min after dispatch (measured cold start ~20 min:
`docs/customer-api-staging-smoke-test.md`; the one observed rescue, task
`01M50HW06VJGCQS942G2DPTDEF`, was 20.3 min in). A task whose own pool is
`FAILED` can never be served from there and is rescued immediately; a task
with no `inference_started_at` stamp keeps the old behaviour. This bounds the
dry-pool ping-pong (flip to B → migrate everything → A regains capacity →
flip back → migrate again) that would otherwise multiply queued copies.

## Adding a region

See the runbook in `trellis2image/docs/sagemaker-iac-contract.md`: quota
approval, targeted Terraform apply of the new region's buckets, artifact
replication, full apply — the sentinel then picks the region up automatically
with no manual election step.
