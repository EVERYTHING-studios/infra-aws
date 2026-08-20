# SageMaker inference backend (planned)

This submodule will replace the stub Lambda with real model inference while
keeping the same pipeline contract:

- **Input**: staged artifacts under `tasks/{task_id}/input/` in the work bucket,
  plus the task record (prompt, options) in DynamoDB.
- **Output**: a GLB at `tasks/{task_id}/raw/model.glb` in the work bucket.

## Planned resources

- `aws_sagemaker_model` + `aws_sagemaker_endpoint_configuration` with
  `async_inference_config` (S3 in/out prefixes in the work bucket, SNS success
  and error topics) + `aws_sagemaker_endpoint`.
- Callback Lambda subscribed to the SNS topics that calls
  `states:SendTaskSuccess` / `SendTaskFailure` with the task token.
- Application Auto Scaling target/policy on `ApproximateBacklogSize` with
  `min_capacity = 0` (scale-to-zero; async cold starts are acceptable).
- The state machine's `Inference` state switches from a plain Lambda invoke to
  `lambda:invoke.waitForTaskToken`, with the dispatch Lambda calling
  `InvokeEndpointAsync` and passing the token through
  `InferenceId`/custom attributes.

## Model candidates (early 2026)

| Task | Candidate | Notes |
| --- | --- | --- |
| image-to-3D | Hunyuan3D-2.1 | Open weights; shape-gen + PBR texture-paint stages map onto preview/refine |
| image-to-3D | TRELLIS / TripoSG | Alternatives worth benchmarking |
| fast tier | Stable Fast 3D | Cheap drafts |
| text-to-3D | FLUX/SDXL → image-to-3D | Chained as an extra state in the same state machine |

Instances: `ml.g5.2xlarge` to start; `ml.g6e.2xlarge` for larger models.

## Cutover

Set `INFERENCE_BACKEND=sagemaker` (env module variable `inference_backend`) —
prepare records the backend per task, so in-flight stub tasks finish cleanly.
