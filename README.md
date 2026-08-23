# infra-aws

Infrastructure-as-code for EVERYTHING Studios' AWS services, starting with
**generate** — the in-house 3D generation service that replaces Meshy.ai.

## Applying to a single environment

`envs/staging` and `envs/production` are independent composition roots, each with
its own S3 state key (`envs/<env>/terraform.tfstate`). Running Terraform in one
never touches the other — just `cd` into the env you want:

```bash
cd envs/staging      # or: cd envs/production
terraform init
terraform apply
```

CI never applies. It only plans both `envs/staging` and `envs/production` and fails
the check if either shows a pending diff — on every PR (blocking) and again on
push to `main` (non-blocking drift alarm; see `.github/workflows/terraform.yml`).
Applying is always a manual, local step using the engineer's own AWS credentials,
and must be done for both environments *before* merging a PR with infra changes.

Because CI can't gate a merge on the target branch having moved since your last
plan, consider enabling GitHub's "require branches to be up to date before
merging" branch protection rule to catch a PR going stale relative to a
concurrently-merged one. That specific rule requires GitHub Pro/Team on a private
repo (not available on Free), so it's optional — enable it manually if your plan
supports it.

## What lives here

```
infra-aws/
├── bootstrap/               # One-time account setup: TF state bucket + GitHub OIDC CI roles
├── modules/
│   ├── lambda-function/     # Internal helper: zip + deploy one TypeScript Lambda
│   ├── generate-api/        # HTTP API Gateway, custom domain, authorizer, task CRUD Lambdas
│   ├── generate-tasks/      # DynamoDB task table
│   ├── generate-pipeline/   # Step Functions pipeline, work bucket, webhook dispatcher, Fargate post-process
│   ├── generate-inference/  # Inference backend (stub Lambda or SageMaker async; SageMaker is live in staging)
│   └── ci-oidc/             # GitHub Actions OIDC provider (data source) + plan role (used by bootstrap)
├── services/generate/       # TypeScript Lambda source (esbuild-bundled to dist/)
├── containers/postprocess/  # Blender headless container: GLB → FBX/OBJ/USDZ + thumbnail
├── envs/staging/            # Composition root for staging
├── envs/production/         # Composition root for production
└── .github/workflows/       # CI: fmt/validate/test, plan-only drift check on PR + main
```

## The generate service

`generate` is an async 3D-generation API. The web-app calls it instead of Meshy;
everything else in the product (Supabase `meshy_jobs` table, S3 `model-assets`
bucket, CloudFront CDN) stays exactly where it is.

```
web-app ──POST /v1/tasks──▶ API GW ──▶ create-task λ ──▶ DynamoDB + Step Functions
                                                              │
   Prepare λ ──▶ Inference (stub λ | SageMaker async) ──▶ PostProcess (Fargate Blender | lite λ)
                                                              │
                              Finalize λ ──▶ model-assets S3 + CloudFront invalidation
                                                              │
web-app ◀──HMAC-signed webhook◀── dispatch λ ◀── SQS ◀────────┘
```

- **API**: `https://generate.everythingstudios.ai` (prod) / `https://staging-generate.everythingstudios.ai` (staging)
  - `POST /v1/tasks` → `202 {"task_id": "<ulid>"}`
  - `GET /v1/tasks/{id}` → status/progress/model_urls (Meshy-compatible status vocabulary)
  - `POST /v1/tasks/{id}/cancel`
  - `GET /v1/health` (unauthenticated)
  - Auth: `x-api-key` header, checked by a Lambda authorizer against Secrets Manager.
- **Outputs** are written directly to the existing `everything-generative-ar-{env}-model-assets`
  bucket at `model-assets/{userId}/{jobId}.glb` / `{jobId}-thumbnail.jpg`, served by the
  existing assets CloudFront distribution. Those buckets are **owned by the web-app's SST
  stack** — this repo only references them via data sources and grants itself access.
- **Two-stage text-to-3d** mirrors the Meshy interaction: the web-app's webhook handler
  triggers a `text-to-3d-refine` task when the preview task succeeds. The refine task
  resolves its parent via `preview_task_id` and reuses the parent's work-bucket artifacts.
- **Webhooks** to the web-app are signed: `x-generate-signature: sha256=HMAC(secret, "<timestamp>.<body>")`
  with `x-generate-timestamp`. Delivery is SQS-backed with 5 retries → DLQ + alarm.
- **Inference is pluggable** via `INFERENCE_BACKEND`:
  - `stub` (today): copies a fixture GLB through the pipeline so everything is E2E-testable.
  - `sagemaker` (live in staging): async inference endpoints; see [SageMaker inference backend](#sagemaker-inference-backend).

## One-time bootstrap

Requires local AWS admin credentials. Run once per account:

```bash
cd bootstrap
terraform init            # local state
terraform apply           # creates the TF state bucket + GitHub OIDC provider + CI roles
```

Then configure the GitHub repo:
1. Repo **variables**: `AWS_PLAN_ROLE_ARN` (from bootstrap outputs).
2. GitHub **environments**: `staging` and `production` (as needed for any non-CI use).

## Deploying an environment

CI never applies — it only plans and fails the check on a pending diff. Deploying is
always this manual step, run locally with your own AWS credentials, before merging:

```bash
cd services/generate && npm ci && npm run build   # bundles Lambdas to dist/
cd ../../envs/staging
terraform init
terraform apply
```

After the **first** apply, set the secret values (Terraform creates the secret shells only):

```bash
aws secretsmanager put-secret-value \
  --secret-id generate-staging-api-key \
  --secret-string "$(openssl rand -hex 32)"
aws secretsmanager put-secret-value \
  --secret-id generate-staging-webhook-secret \
  --secret-string "$(openssl rand -hex 32)"
```

Give the same two values to the web-app as `GENERATE_API_KEY` and `GENERATE_WEBHOOK_SECRET`
(SST secrets), plus `GENERATE_API_URL=https://staging-generate.everythingstudios.ai`.

And push the post-process container (optional until Fargate post-processing is enabled;
the pipeline defaults to the "lite" Lambda post-process until then):

```bash
cd containers/postprocess
docker build -t postprocess .
docker tag postprocess "$(terraform -chdir=../../envs/staging output -raw postprocess_ecr_url):latest"
docker push "$(terraform -chdir=../../envs/staging output -raw postprocess_ecr_url):latest"
```

Then set `postprocess_mode = "fargate"` in the env's `terraform.tfvars`.

## Smoke test (staging, stub backend)

```bash
API=https://staging-generate.everythingstudios.ai
KEY=$(aws secretsmanager get-secret-value --secret-id generate-staging-api-key --query SecretString --output text)

TASK=$(curl -s -X POST "$API/v1/tasks" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "type": "text-to-3d-preview",
  "input": { "prompt": "a small ceramic teapot" },
  "output": { "user_id": "00000000-0000-4000-8000-000000000001", "job_id": "00000000-0000-4000-8000-000000000002" }
}' | jq -r .task_id)

watch -n 2 "curl -s $API/v1/tasks/$TASK -H 'x-api-key: $KEY' | jq '{status, progress, model_urls}'"
# → SUCCEEDED with model_urls.glb on the staging assets CDN, and an HMAC-signed
#   webhook POSTed to the configured webhook_url.
```

## SageMaker inference backend

The real model swaps in behind the same pipeline contract (work-bucket input prefix in,
GLB at `tasks/{task_id}/raw/model.glb` out) by setting `INFERENCE_BACKEND=sagemaker` and
adding the `generate-inference/sagemaker` submodule:

- **Model**: TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) is the chosen model. The inference image
  is in ECR as `trellis2image:c374e66-serve-fix`
  (`095256591532.dkr.ecr.us-east-1.amazonaws.com/trellis2image:c374e66-serve-fix`), and the SSM params
  `/trellis2image/ecr/repository_uri` and `/trellis2image/ecr/image_uri` are written.
- **SageMaker async inference** endpoints: S3 in/out, SNS success/error topics → callback
  Lambda → `SendTaskSuccess` (the state machine's inference state becomes `.waitForTaskToken`).
  The container returns GLB bytes directly from `/invocations`; SageMaker writes them to the
  configured `S3OutputPath` — the container does **not** write to S3 itself.
- **Scale-to-zero**: autoscaling on `HasBacklogWithoutCapacity`, `MinCapacity = 0`,
  `MaxCapacity = 2` — multi-minute cold starts are fine for an async pipeline.
- **Instances**: `ml.g6e.2xlarge` (L40S, 45 GB VRAM, 8 vCPU, 64 GiB RAM) — the current
  steady-state instance. `ml.g5.2xlarge` (A10G, 24 GB) was the target but had endpoint-quota=0;
  `ml.g5.xlarge` had `InsufficientInstanceCapacity`. If the g5.2xlarge quota increase is approved,
  the instance can flip back. Multi-GPU instances (g5.12x+, p4d, p5) waste all but one GPU on
  this single-GPU-per-render workload. See `trellis2image/docs/instance-sizing.md`.
- **Contract**: the precise SSM parameter handoff, IAM, and resource list is in
  `trellis2image/docs/sagemaker-iac-contract.md` (this repo is app-only; Terraform lives here).

### Deployed

All three phases are ✅ DONE in staging:

- **Phase 1** ✅: S3 buckets (weights, input, output), SSM phase-1 params, SageMaker execution
  role (with `s3:ListBucket`+`s3:PutObject` on output bucket, `sns:Publish` on SNS topics).
- **Phase 2** ✅: TRELLIS.2 pipeline weights packaged as `model.tar.gz` (~13.3 GB, symlink-free
  via `--dereference`) and uploaded to the weights bucket.
- **Phase 3** ✅: SageMaker Model (`ModelDataSource.S3DataSource`, not `ModelDataUrl`),
  EndpointConfig (`ml.g6e.2xlarge`, `container_startup_health_check_timeout = 600`),
  Endpoint (InService), autoscaling (min=0/max=2, `ChangeInCapacity` step scaling), dispatcher
  + callback Lambdas, state machine `.waitForTaskToken` wiring.

**Remaining:** e2e verification (submit a test task via the staging API) and production cutover
(after staging is validated).

## Conventions

- Terraform ≥ 1.10 (native S3 state locking via `use_lockfile`), AWS provider `~> 5.x`, `us-east-1`.
- Environments are directories (`envs/staging`, `envs/production`) with separate state
  keys in `s3://everything-infra-tfstate-095256591532` — no workspaces.
- Naming is verb-based (`generate-*`), never vendor-based.
