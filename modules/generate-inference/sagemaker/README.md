# SageMaker inference backend

This submodule replaces the stub Lambda with real TRELLIS.2 model inference while
keeping the same pipeline contract:

- **Input**: staged artifacts under `tasks/{task_id}/input/` in the work bucket,
  plus the task record (prompt, options) in DynamoDB.
- **Output**: a GLB at `tasks/{task_id}/raw/model.glb` in the work bucket.

## Model

TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) is the chosen model. Image:
`095256591532.dkr.ecr.us-east-1.amazonaws.com/trellis2image:c374e66-serve-fix` (SSM
`/trellis2image/{env}/ecr/image_uri`). The full SSM/IAM/resource contract is in
`trellis2image/docs/sagemaker-iac-contract.md`; instance sizing is in
`trellis2image/docs/instance-sizing.md`.

## Resources

- `aws_sagemaker_model` + `aws_sagemaker_endpoint_configuration` with
  `async_inference_config` (separate S3 input/output buckets, SNS success and
  error topics) + `aws_sagemaker_endpoint`.
- Dispatcher Lambda invoked by the state machine's `.waitForTaskToken` Inference
  state: copies the staged input image to the SageMaker input bucket, calls
  `InvokeEndpointAsync` with `InputLocation`, and returns immediately (does NOT
  wait for inference). The Step Functions task token is stored in DynamoDB
  (`sagemaker_task_token` attribute on the task record); `InferenceId = task_id`
  is used only for correlation. The callback Lambda recovers the token via
  `getTask(task_id)`.
- Callback Lambda subscribed to the SNS success/error topics: on success reads
  the GLB from the SageMaker output bucket, copies it to
  `tasks/{task_id}/raw/model.glb` in the work bucket, calls
  `states:SendTaskSuccess`, then clears `sagemaker_task_token` from the task
  record; on error calls `SendTaskFailure` and clears the token. The token is
  cleared after the SFN call so SNS retries can still recover it if the SFN call
  throws.
- Application Auto Scaling on the endpoint variant with `min_capacity = 0`
  (scale-to-zero), `max_capacity = 2`. Scale-up on `HasBacklogWithoutCapacity`
  (2 consecutive periods); scale-down on a custom `EndpointIdle` metric
  published by the `endpoint-scaler` Lambda (3 consecutive idle minutes). See
  [Scale-to-zero](#scale-to-zero) below.
- `endpoint-scaler` Lambda (EventBridge `rate(1 minute)`): queries DynamoDB GSI2
  for IN_PROGRESS tasks with an active `sagemaker_task_token`, publishes
  `EndpointIdle = 0` (busy) or `1` (idle) to CloudWatch namespace
  `EverythingStudios/SageMaker`. Safe default `0` on error — never scale down on
  monitoring failure.

## Scale-to-zero

The async endpoint scales to zero when idle, so you only pay for GPU time when
a request is actually in flight. Two alarms drive the autoscaling policies:

- **Scale-up** (`HasBacklogWithoutCapacity >= 1` for 2 min): fires when a request
  is queued with no instance to serve it. Step scaling `+1`, 300s cooldown.
- **Scale-to-zero** (`EndpointIdle >= 1` for 3 min): fires when no in-flight
  SageMaker invocation has an active `sagemaker_task_token`. Step scaling `-1`,
  180s cooldown. `treat_missing_data = breaching` — if the scaler Lambda stops
  publishing, the alarm fires after 3 min as a safety measure rather than
  keeping the instance alive forever.

### Why a custom metric

SageMaker's built-in `HasBacklogWithoutCapacity` drops to 0 the moment a queued
request is **picked up** by the instance — not when inference **completes**.
With short evaluation periods the scale-down alarm fires mid-inference, killing
the instance and causing an endless scale-up/scale-down cycle that never
completes a request. Extending the evaluation periods to 15 (the old workaround)
made it safe but wasted 15 min of idle billing before each scale-down.

The fix: the `endpoint-scaler` Lambda publishes a custom `EndpointIdle` metric
every minute. The callback Lambda clears the `sagemaker_task_token` after the
SNS success/failure notification, so the metric drops to idle only after
inference truly finishes. Scale-to-zero then fires in ~3 min, not 15.

### Cold-run measurement

`scripts/measure-endpoint.sh` produces a billable breakdown for a single task.
Pass a `TASK_ID` to measure one run end-to-end:

```bash
AWS_PROFILE=aman-aws TASK_ID=<task_id> bash scripts/measure-endpoint.sh
```

The report decomposes the billable window (scale-up start -> scale-in end) into:

- **Cold start** — provisioning + model download + GPU weights load (first
  invocation timestamp - scale-up start). ~10 min on `ml.g5.2xlarge`.
- **Inference GPU** — `ModelLatency` sum (actual GPU work). ~6.5 min for
  TRELLIS.2-4B image-to-3d.
- **Cooldown** — scale-in end - last invocation (3 evaluation periods + the
  scale-down activity). ~3 min with the custom-metric alarm.
- **Idle fraction** — `(cold start + cooldown) / billable`, the fraction of the
  billable window that is not useful GPU work.

Reference cold run (`ml.g5.2xlarge`, 2026-08-23, task
`01M0QNQM563TP1BJEG08F9CPYQ`):

```
Run type:           COLD (scale 0 -> 1)
Billable window:    920s
  Cold start:       643s  (provision + download + weights load)
  Inference GPU:    396s  (useful work)
  Cooldown:         277s  (last invocation -> scale-in end)
  Idle fraction:    100%  (cold start + cooldown / billable)
Queue wait:         850s  (request queued while instance provisioned)
Task wall-clock:    899s  (SUCCEEDED)
Hourly rate:        $1.52/hr (ml.g5.2xlarge)
Est cost:           $0.39
```

The cold run completed in a single scale-up/scale-down cycle — no mid-inference
kill. The old 15-minute idle wait before scale-down is eliminated; cooldown is
now ~3 min. Cold start + cooldown dominate the billable window for a
single-request cold run (100% idle fraction), so batching requests within the
billable window is the main lever for cost efficiency.

## Weights persistence
The packaged pipeline (`model.tar.gz`, ~10.8 GB compressed: TRELLIS.2-4B +
DINOv3 + BiRefNet, with the unused `tex_slat_flow_model_512` excluded) is
downloaded to `/opt/ml/model` at endpoint provisioning. The tar is built with
`--dereference` to resolve HuggingFace cache symlinks (`snapshots/` → `blobs/`);
SageMaker rejects tar archives containing symlinks. `ModelDataSource.S3DataSource`
is used instead of `ModelDataUrl` (which has a ~5 GB extraction limit). The
container sets `HF_HOME=/opt/ml/model` so HuggingFace loads from the local cache
with no network fetch at serve time. `model_data_download_timeout_in_seconds =
3600` (on `production_variants`) accommodates the large download;
`container_startup_health_check_timeout_in_seconds = 600` covers the ~14 GB GPU
weights load at container startup (eager-loaded before `/ping` returns 200).

## Async output contract

The container returns GLB bytes directly from `/invocations` (no S3 write from
the container). SageMaker writes the response body to the configured
`S3OutputPath` and emits `inference.success` / `inference.error` marker files,
notifying via SNS per `EndpointConfig.NotificationConfig`. The callback Lambda
reads the GLB from the output bucket.

## Instances

`ml.g7e.2xlarge` (Blackwell RTX PRO 6000, 96 GB VRAM, 1,597 GB/s memory
bandwidth, 8 vCPU, 64 GiB RAM) is the primary instance. The image is compiled
for sm_120 only (`TORCH_CUDA_ARCH_LIST="12.0+PTX"`); to fall back to g6e/g5,
build a multi-arch image (`TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX"
./scripts/build_image.sh trellis2image:multiarch`) and set `instance_type` in
the env tfvars. `ml.g6e.2xlarge` (L40S, 45 GB) is the fallback; `ml.g5.2xlarge`
(A10G, 24 GB) is the budget option but requires `low_vram = "1"` (its 24 GB
VRAM cannot hold all ~17 GB of models resident). Multi-GPU instances (g5.12x+,
p4d, p5) waste all but one GPU on this single-GPU-per-render workload — see
`trellis2image/docs/instance-sizing.md`.

The container environment sets:
- `TRELLIS2_LOW_VRAM` — forwarded from the `low_vram` Terraform variable
  (default `"0"`). `"0"` loads all ~17 GB models to GPU once at startup (no
  per-request PCIe swapping); requires ≥45 GB VRAM (g6e/g7e). `"1"` keeps models
  on CPU and swaps per-stage (safe on g5 24 GB).
- `TRELLIS2_EAGER_LOAD = "1"` — loads the pipeline at container startup (before
  `/ping` returns 200) so the first request gets warm-speed latency and load
  failures surface during endpoint creation.
- `TRELLIS2_SKIP_UNUSED_MODELS` — defaults to `"1"` (set in the image, not TF):
  drops the unused `tex_slat_flow_model_512` (~2.5 GB) from the loaded model
  set. The default `1024_cascade` pipeline never references it.

The `serve` entrypoint script (`serving/serve`, symlinked to
`/usr/local/bin/serve`) satisfies the NVIDIA base image's `exec serve`
convention used by SageMaker.

## Cutover

Set `inference_backend = "sagemaker"` in the env `terraform.tfvars` — prepare
records the backend per task, so in-flight stub tasks finish cleanly. Keep
production on `stub` until staging is validated end-to-end.
