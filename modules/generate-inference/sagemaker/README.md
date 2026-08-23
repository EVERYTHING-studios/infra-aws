# SageMaker inference backend

This submodule replaces the stub Lambda with real TRELLIS.2 model inference while
keeping the same pipeline contract:

- **Input**: staged artifacts under `tasks/{task_id}/input/` in the work bucket,
  plus the task record (prompt, options) in DynamoDB.
- **Output**: a GLB at `tasks/{task_id}/raw/model.glb` in the work bucket.

## Model

TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) is the chosen model. Image:
`095256591532.dkr.ecr.us-east-1.amazonaws.com/trellis2image:c374e66-serve-fix` (SSM
`/trellis2image/ecr/image_uri`). The full SSM/IAM/resource contract is in
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
  `tasks/{task_id}/raw/model.glb` in the work bucket, and calls
  `states:SendTaskSuccess`; on error calls `SendTaskFailure`.
- Application Auto Scaling on the endpoint variant with `min_capacity = 0`
  (scale-to-zero), `max_capacity = 2`; scale-up on `HasBacklogWithoutCapacity`,
  scale-in target tracking with `ScaleInCooldown = 300`.

## Weights persistence
The packaged pipeline (`model.tar.gz`, ~13.3 GB compressed: TRELLIS.2-4B +
DINOv3 + BiRefNet) is downloaded to `/opt/ml/model` at endpoint provisioning.
The tar is built with `--dereference` to resolve HuggingFace cache symlinks
(`snapshots/` → `blobs/`); SageMaker rejects tar archives containing symlinks.
`ModelDataSource.S3DataSource` is used instead of `ModelDataUrl` (which has a
~5 GB extraction limit). The container sets `HF_HOME=/opt/ml/model` so
HuggingFace loads from the local cache with no network fetch at serve time.
`model_data_download_timeout_in_seconds = 3600` (on `production_variants`)
accommodates the large download; `container_startup_health_check_timeout_in_seconds
= 600` covers the ~14 GB GPU weights load at container startup.

## Async output contract

The container returns GLB bytes directly from `/invocations` (no S3 write from
the container). SageMaker writes the response body to the configured
`S3OutputPath` and emits `inference.success` / `inference.error` marker files,
notifying via SNS per `EndpointConfig.NotificationConfig`. The callback Lambda
reads the GLB from the output bucket.

## Instances

`ml.g6e.2xlarge` (current steady-state instance; L40S GPU, 45 GB VRAM, 8 vCPU,
64 GiB RAM). `ml.g5.2xlarge` (A10G, 24 GB VRAM) was the target but had
account endpoint-quota=0; `ml.g5.xlarge` had `InsufficientInstanceCapacity`.
The image's `TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX"` covers the L40S
(sm_89) via PTX forward-compat from sm_90 — no rebuild was needed. If the
g5.2xlarge quota increase is approved later, the instance can flip back.
Multi-GPU instances (g5.12x+, p4d, p5) waste all but one GPU on this
single-GPU-per-render workload — see `trellis2image/docs/instance-sizing.md`.
The `serve` entrypoint script (`serving/serve`, symlinked to
`/usr/local/bin/serve`) satisfies the NVIDIA base image's `exec serve`
convention used by SageMaker.

## Cutover

Set `inference_backend = "sagemaker"` in the env `terraform.tfvars` — prepare
records the backend per task, so in-flight stub tasks finish cleanly. Keep
production on `stub` until staging is validated end-to-end.
