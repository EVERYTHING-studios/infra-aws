# SageMaker regional stack

One candidate region's full SageMaker async-inference stack. The parent
`generate-inference` module instantiates this module once per candidate region,
mapped to that region's provider; the dispatcher/callback/scaler/sentinel
Lambdas and the election SSM parameters live once in the sibling
`sagemaker-control/` module (us-east-1).

Candidate regions are fixed to the three regions where SageMaker offers
`ml.g7e.2xlarge` (verified via the pricing API): **us-east-1, us-east-2,
us-west-2**. The `aws.useast2` / `aws.uswest2` provider aliases in the envs are
exact, not a shortcut. A region's stack appears when it is appended to
`sagemaker_candidate_regions` (requires the per-type endpoint-usage quota >= 1
in that region — g5.2xlarge `L-9614C779`, g6e.2xlarge `L-F8D7F460`, g7e.2xlarge
`L-5AA715AC` — and replicated artifacts; see the add-a-region runbook in
`trellis2image/docs/sagemaker-iac-contract.md`).

The module keeps the same pipeline contract as before the multi-region refactor:

- **Input**: staged artifacts under `tasks/{task_id}/input/` in the work bucket,
  plus the task record (prompt, options) in DynamoDB.
- **Output**: a GLB at `tasks/{task_id}/raw/model.glb` in the work bucket.

## Model

TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) is the chosen model. Image and weights
locations come from this region's own SSM parameter store (see below). The full
SSM/IAM/resource contract is in `trellis2image/docs/sagemaker-iac-contract.md`;
instance sizing is in `trellis2image/docs/instance-sizing.md`.

## Bucket naming

The three buckets are named `generate-${env}-inference-{input,output,weights}-${account_id}`.
us-east-1 keeps the byte-identical legacy names (state surgery moved the
existing buckets into this module without recreation); alternate regions gain a
region suffix with the region's hyphens stripped — `-useast2` / `-uswest2`
(e.g. `generate-staging-inference-input-095256591532-useast2`).

## Resources

- **S3 buckets** — async input, async output, and the weights store, each with
  a public-access block and SSE-S3 (`AES256`). Input and output buckets expire
  transient artifacts after 7 days; the weights bucket holds a manually managed
  `model.tar.gz` and has NO expiry.
- **Weights SSM parameter** — `/trellis2image/${env}/s3/weights_bucket`,
  published with this region's bucket name. SSM is regional: the parameter name
  repeats in every region with region-local values, and
  `trellis2image/scripts/replicate_artifacts.sh` reads it (in the destination
  region) to target replication.
- **SSM data sources** — `/trellis2image/${env}/ecr/image_uri` and
  `/trellis2image/${env}/weights/s3_uri`, read through the regional provider
  from this region's own parameter store. In us-east-1 they are written by
  `push_image.sh` / `package_weights.sh`; in alternate regions by
  `replicate_artifacts.sh`.
- **Per-type SageMaker resources** — one `aws_sagemaker_model` +
  `aws_sagemaker_endpoint_configuration` + `aws_sagemaker_endpoint` per
  instance type in `var.instance_types` (`for_each`), names token-suffixed.
  Endpoint names are globally unique — us-east-1 keeps the unsuffixed
  legacy-style name (e.g. `${name_prefix}-sagemaker-g5`), alternate regions
  gain a region suffix (e.g. `...-sagemaker-g5-useast2`) — because the
  sentinel/dispatcher in `sagemaker-control` elect and look up endpoints by
  NAME across the whole (region × type) chain; SageMaker names themselves are
  only region-scoped. A per-type
  `random_id` suffix on each EndpointConfig name (keepers: image, weights,
  that type's container environment, the instance type — one random_id per
  type so one type's change doesn't rotate the others) lets image/weights
  changes roll forward via a new Model + EndpointConfig (blue/green endpoint
  update) instead of a recreate that would conflict with the live Endpoint.
  The Model and EndpointConfig depend on the three buckets so their
  creation-time validations (model-data S3 URI, execution-role
  `s3:ListBucket` on the output bucket) never race the bucket create in a
  fresh region. All of a region's endpoints share that region's SNS topics
  (the callback derives the source region from `EventSubscriptionArn`) and
  output bucket; the variant name stays `trellis` on every endpoint.
- **SNS success/error topics** + Lambda subscriptions. The single us-east-1
  callback Lambda (owned by `sagemaker-control`, ARN constructed by the parent
  to break the control ↔ regional reference cycle) is subscribed to both topics
  from every region — SNS cross-region Lambda delivery is supported. The
  callback derives the source region from each record's `EventSubscriptionArn`.
- **Application Auto Scaling** on every endpoint variant with
  `min_capacity = 0` (scale-to-zero), `max_capacity = var.max_capacity`
  (default 2, per endpoint). Scale-up on `HasBacklogWithoutCapacity`
  (2 consecutive periods); scale-down on the custom `EndpointIdle` metric
  (3 consecutive idle minutes) published per endpoint by the scaler Lambda in
  `sagemaker-control`. See [Scale-to-zero](#scale-to-zero) below.

The SageMaker execution role is a global IAM resource owned by the parent
module; its policy is rebuilt from the merged regional descriptors so it covers
every candidate region's buckets, topics, logs, and `trellis2image` ECR repo.

## Scale-to-zero

The async endpoints scale to zero when idle, so you only pay for GPU time when
a request is actually in flight — in every candidate region, including the
idle ones (a 0-instance endpoint is free). Two alarms drive each endpoint's
autoscaling policies:

- **Scale-up** (`HasBacklogWithoutCapacity >= 1` for 2 min): fires when a request
  is queued with no instance to serve it. Step scaling `+1`, 300s cooldown.
- **Scale-to-zero** (`EndpointIdle >= 1` for 3 min): fires when no in-flight
  SageMaker invocation in this region has an active `sagemaker_task_token`. Step
  scaling `-1`, 180s cooldown. `treat_missing_data = breaching` — if the scaler
  Lambda stops publishing, the alarm fires after 3 min as a safety measure
  rather than keeping the instance alive forever. (Busy attribution is
  region-keyed by design: while any endpoint in the region has an in-flight
  task, every sibling endpoint in that region also reports busy — over-
  conservative by one cooldown at most, bounded cents, never kills a
  mid-inference render.)

### Why a custom metric

SageMaker's built-in `HasBacklogWithoutCapacity` drops to 0 the moment a queued
request is **picked up** by the instance — not when inference **completes**.
With short evaluation periods the scale-down alarm fires mid-inference, killing
the instance and causing an endless scale-up/scale-down cycle that never
completes a request. The scaler Lambda publishes a custom `EndpointIdle` metric
every minute for every configured endpoint (dimension `EndpointName`); the
callback Lambda clears the `sagemaker_task_token` after the SNS success/failure
notification, so the metric drops to idle only after inference truly finishes.

### Cold-run measurement

`infra-aws/scripts/measure-endpoint.sh` produces a billable breakdown for a
single task (pass `AWS_PROFILE` and `TASK_ID`). Cold start (provisioning + the
~13 GB weights download + GPU weights load) plus the ~3 min cooldown dominate
the billable window for a single-request cold run, so batching requests within
the billable window is the main lever for cost efficiency.

## Weights persistence

The packaged pipeline (`model.tar.gz`, ~13 GB compressed: TRELLIS.2-4B +
DINOv3 + BiRefNet, with the unused `tex_slat_flow_model_512` excluded) is
downloaded to `/opt/ml/model` at endpoint provisioning — from this region's
weights bucket. The tar is built with `--dereference` to resolve HuggingFace
cache symlinks (`snapshots/` → `blobs/`); SageMaker rejects tar archives
containing symlinks. `ModelDataSource.S3DataSource` is used instead of
`ModelDataUrl` (which has a ~5 GB extraction limit). The container sets
`HF_HOME=/opt/ml/model` (and `HF_HUB_OFFLINE=1`) so HuggingFace loads from the
local cache with no network fetch at serve time. `model_data_download_timeout_in_seconds
= 3600` (on `production_variants`) accommodates the large download;
`container_startup_health_check_timeout_in_seconds = 600` covers the ~14 GB GPU
weights load at container startup (eager-loaded before `/ping` returns 200).

## Async output contract

The container returns GLB bytes directly from `/invocations` (no S3 write from
the container). SageMaker writes the response body to the configured
`S3OutputPath` and emits `inference.success` / `inference.error` marker files,
notifying via SNS per `EndpointConfig.NotificationConfig`. The callback Lambda
reads the GLB from the regional output bucket.

## Instances

The module deploys **one endpoint per instance type** in
`var.instance_types` (the parent's cold-price chain, default
`ml.g5.2xlarge → ml.g6e.2xlarge → ml.g7e.2xlarge`; election across them is
handled by the sentinel in `sagemaker-control`). The image is multi-arch
(`TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX"` in the trellis2image
Dockerfile): ONE image serves g5 (A10G, 24 GB, sm_86), g6e (L40S, 45 GB,
sm_89), Hopper (sm_90), and g7e (RTX PRO 6000, 96 GB, sm_120) plus the local
dev box — no per-type builds. Multi-GPU instances (g5.12x+, p4d, p5) waste all
but one GPU on this single-GPU-per-render workload — see
`trellis2image/docs/instance-sizing.md`.

The container environment is per-type:

- `TRELLIS2_LOW_VRAM` — derived per instance type inside this module
  (replaces the old `low_vram` variable): `"1"` on `ml.g5.2xlarge` (its 24 GB
  VRAM cannot hold all ~17 GB of models resident), `"0"` on g6e/g7e (>= 45 GB
  loads all models to GPU once at startup — no per-request PCIe swapping).
- `TRELLIS2_EAGER_LOAD = "1"` — loads the pipeline at container startup (before
  `/ping` returns 200) so the first request gets warm-speed latency and load
  failures surface during endpoint creation.
- `TRELLIS2_PIPELINE_TYPE = "1024"` — the default `1024_cascade` pipeline.
- `TRELLIS2_SKIP_UNUSED_MODELS` — defaults to `"1"` (set in the image, not TF):
  drops the unused `tex_slat_flow_model_512` (~2.5 GB) from the loaded model
  set.

The `serve` entrypoint script (`serving/serve`, symlinked to
`/usr/local/bin/serve`) satisfies the NVIDIA base image's `exec serve`
convention used by SageMaker.

## initial_instance_count deviation (honest note)

The original design called for `initial_instance_count = 0` so a new endpoint
would create `InService` at zero instances in seconds, with no capacity
consequence at apply time. **The hashicorp/aws provider hardcodes
`validation.IntAtLeast(1)` on `aws_sagemaker_endpoint_configuration`'s
`initial_instance_count`, so an endpoint cannot be created at zero instances
through Terraform.** The module therefore sets `initial_instance_count = 1` on
every per-type EndpointConfig.

Steady-state zero still holds: `min_capacity = 0` plus the per-region
`EndpointIdle` scale-to-zero alarm drains every endpoint when idle. The two
consequences:

- The **first create** of an endpoint provisions one instance at apply time —
  a one-time capacity probe. On a dry (type, region) the apply hangs waiting
  for the instance and the endpoint may end `Failed`; recovery is below.
- **UpdateEndpoint on an existing endpoint rolls the config's initial count**,
  so an endpoint-config roll must not happen while that (type, region) is dry —
  it would re-enter the capacity lottery. Schedule config rolls (image/weights
  changes) for when the endpoint is healthy, or accept that the apply waits.

## Failed-endpoint recovery

A `Failed` endpoint never self-heals, and the capacity sentinel in
`sagemaker-control` never elects a `Failed` endpoint. Recovery is manual:

```bash
aws --profile aman-aws sagemaker delete-endpoint \
  --region <region> --endpoint-name <name_prefix>-sagemaker-<token><-regionsuffix>   # e.g. ...-sagemaker-g5-useast2
cd envs/<env> && AWS_PROFILE=aman-aws terraform apply   # recreates the endpoint
```

Deleting only the endpoint (not the Model/EndpointConfig) lets Terraform
recreate it against the existing config; the apply provisions one instance
(the deviation above) and the scale-to-zero alarm drains it once idle.
