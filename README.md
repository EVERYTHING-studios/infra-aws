# infra-aws

Infrastructure-as-code for EVERYTHING Studios' AWS services, starting with
**generate** — an in-house 3D generation service available alongside Meshy.ai
(the web-app exposes a provider selector).

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
│   ├── api-gateway/        # Shared HTTP API Gateway, custom domain, Route53 (for all infra-aws services)
│   ├── generate-api/        # Authorizer, task CRUD Lambdas, routes (API GW owned by api-gateway)
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

`generate` is an async 3D-generation API. The web-app calls it alongside Meshy
(a provider selector in the UI chooses which backend to use); everything else
in the product (Supabase `generation_jobs` table, S3 `model-assets`
bucket, CloudFront CDN) stays exactly where it is.

```
web-app ──POST /v1/generate/tasks──▶ API GW ──▶ create-task λ ──▶ DynamoDB + Step Functions
                                                              │
   Prepare λ ──▶ Inference (stub λ | SageMaker async) ──▶ PostProcess (Fargate Blender | lite λ)
                                                              │
                              Finalize λ ──▶ model-assets S3 + CloudFront invalidation
                                                              │
web-app ◀──HMAC-signed webhook◀── dispatch λ ◀── SQS ◀────────┘
```

- **API**: `https://api.everythingstudios.ai` (prod) / `https://staging-api.everythingstudios.ai` (staging)
  - `POST /v1/generate/tasks` → `202 {"task_id": "<ulid>"}`
  - `GET /v1/generate/tasks/{id}` → status/progress/model_urls (Meshy-compatible status vocabulary)
  - `POST /v1/generate/tasks/{id}/cancel`
  - `GET /v1/generate/health` (unauthenticated)
  - Auth: `x-api-key` header, checked by a Lambda authorizer against Secrets Manager.
- **Shared API Gateway**: The `modules/api-gateway/` module owns the HTTP API Gateway, custom domain
  (`api.everythingstudios.ai` / `staging-api.everythingstudios.ai`), and Route53 record. The
  `generate-api` module connects its routes, authorizer, and Lambda integrations to the shared
  gateway via `api_id` and `api_execution_arn` inputs. Future infra-aws services will attach to the
  same gateway.
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
(SST secrets), plus `GENERATE_API_URL=https://staging-api.everythingstudios.ai`.

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
API=https://staging-api.everythingstudios.ai
KEY=$(aws secretsmanager get-secret-value --secret-id generate-staging-api-key --query SecretString --output text)

TASK=$(curl -s -X POST "$API/v1/generate/tasks" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "type": "text-to-3d-preview",
  "input": { "prompt": "a small ceramic teapot" },
  "output": { "user_id": "00000000-0000-4000-8000-000000000001", "job_id": "00000000-0000-4000-8000-000000000002" }
}' | jq -r .task_id)

watch -n 2 "curl -s $API/v1/generate/tasks/$TASK -H 'x-api-key: $KEY" | jq '{status, progress, model_urls}'"
# → SUCCEEDED with model_urls.glb on the staging assets CDN, and an HMAC-signed
#   webhook POSTed to the configured webhook_url.
```

## SageMaker inference backend

The real model swaps in behind the same pipeline contract (work-bucket input prefix in,
GLB at `tasks/{task_id}/raw/model.glb` out) by setting `INFERENCE_BACKEND=sagemaker`. The
backend is **multi-region and multi-instance-type**: the full regional stack is deployed
once per candidate region with one endpoint per chain instance type, and a capacity
sentinel elects the active endpoint from live evidence in cold-price chain order.

- **Model**: TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) is the chosen model. The inference image
  is in ECR as `trellis2image:c374e66-serve-fix`
  (`095256591532.dkr.ecr.us-east-1.amazonaws.com/trellis2image:c374e66-serve-fix`), and the SSM params
  `/trellis2image/ecr/repository_uri` and `/trellis2image/{env}/ecr/image_uri` are written.
- **Regional stacks** (`modules/generate-inference/sagemaker-region/`): one instance per
  candidate region — us-east-1, us-east-2, us-west-2, the only regions where SageMaker offers
  `ml.g7e.2xlarge` — each with its own provider alias (`aws.useast2`/`aws.uswest2`), S3
  input/output/weights buckets (us-east-1 keeps the legacy names; alternates gain
  `-useast2`/`-uswest2` suffixes), and one Model/EndpointConfig/Endpoint per instance type
  in the chain (endpoint names token-suffixed and globally unique — unsuffixed in
  us-east-1, e.g. `...-sagemaker-g5`, region-suffixed in alternates, e.g.
  `...-sagemaker-g5-useast2` — the sentinel elects and the dispatcher looks up
  endpoints by NAME across the whole chain), plus SNS topics and
  scale-to-zero autoscaling per endpoint. A 0-instance endpoint is free, so idle chain
  endpoints cost ~nothing (weights bucket + ECR image storage only).
- **Control plane + election** (`modules/generate-inference/sagemaker-control/`): the
  dispatcher/callback/scaler Lambdas plus a capacity-sentinel Lambda, all in us-east-1. AWS
  exposes no capacity-availability API, so the sentinel (EventBridge `rate(1 minute)`)
  classifies every chain endpoint FAILED / DROUGHT / PROVISIONING / HEALTHY from
  describe-endpoint + scaling-activity evidence and flips the `active_endpoint` SSM
  parameter (`/generate/{env}/sagemaker/active_endpoint`, value = the elected endpoint's
  NAME) with a 300 s cooldown. The dispatcher reads it and stages input + invokes on the
  elected endpoint; failback to a higher-priority chain entry happens only once that
  endpoint is healthy-PROVEN; tasks stranded in an abandoned region are re-dispatched
  automatically. See the module READMEs for the full election rules.
- **SageMaker async inference** endpoints: S3 in/out, SNS success/error topics → callback
  Lambda → `SendTaskSuccess` (the state machine's inference state becomes `.waitForTaskToken`).
  The container returns GLB bytes directly from `/invocations`; SageMaker writes them to the
  configured `S3OutputPath` — the container does **not** write to S3 itself.
- **Scale-to-zero**: autoscaling on `HasBacklogWithoutCapacity`, `MinCapacity = 0`,
  `MaxCapacity = 2` — multi-minute cold starts are fine for an async pipeline, in every
  candidate region.
- **Instances**: one endpoint per (region × type) with the sentinel electing by the
  cold-price chain `ml.g5.2xlarge → ml.g6e.2xlarge → ml.g7e.2xlarge` (g5 = A10G, 24 GB,
  $0.39/cold req; g6e = L40S, 45 GB; g7e = RTX PRO 6000, 96 GB, $0.86–0.93/cold req —
  best warm economics at $0.067/req but Blackwell-capacity-drought-prone and priciest
  cold). The image is multi-arch (`TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX"`): one
  image serves g5 (sm_86), g6e (sm_89), Hopper (sm_90), and g7e + the local dev box
  (sm_120). `TRELLIS2_LOW_VRAM` is derived per type inside the sagemaker-region module
  ("1" on g5's 24 GB, "0" on g6e/g7e). Multi-GPU instances (g5.12x+, p4d, p5) waste all
  but one GPU on this single-GPU-per-render workload. See
  `trellis2image/docs/instance-sizing.md`.
- **Contract**: the precise SSM parameter handoff, IAM, and resource list is in
  `trellis2image/docs/sagemaker-iac-contract.md` (this repo is app-only; Terraform lives
  here) — including the **add-a-region runbook** (quota approval → targeted bucket apply →
  `replicate_artifacts.sh` → full apply → automatic election).

### Deployed

The SageMaker backend is live in staging:

- **Phase 1**: S3 buckets (weights, input, output), SSM phase-1 params, SageMaker execution
  role (with `s3:ListBucket`+`s3:PutObject` on output bucket, `sns:Publish` on SNS topics).
- **Phase 2**: TRELLIS.2 pipeline weights packaged as `model.tar.gz` (~13.3 GB, symlink-free
  via `--dereference`) and uploaded to the weights bucket.
- **Phase 3**: SageMaker Model (`ModelDataSource.S3DataSource`, not `ModelDataUrl`),
  EndpointConfig (`ml.g7e.2xlarge`, `container_startup_health_check_timeout = 600`),
  Endpoint, autoscaling (min=0/max=2, `ChangeInCapacity` step scaling), dispatcher
  + callback Lambdas, state machine `.waitForTaskToken` wiring.
- **Multi-region refactor** (applied to staging 2026-09-17): the single `sagemaker/`
  submodule was split into `sagemaker-region/` (per-candidate-region stack) +
  `sagemaker-control/` (us-east-1 control plane with the sentinel); staging currently runs
  with `sagemaker_candidate_regions = ["us-east-1"]`.

**Remaining**: quota approvals (`L-5AA715AC`) in us-east-2/us-west-2, then the add-a-region
runbook per candidate as each lands; and the production migration below.

**Production warning**: `envs/production` still uses the old module layout in its Terraform
state. It must NOT be planned or applied until it gets the same refactor — aliased providers
plus the identical `terraform state mv` surgery staging received. Until then Terraform fails
loudly on the missing provider configuration aliases; that is intentional, a fail-safe
against an accidental destroy.

## Conventions

- Terraform ≥ 1.10 (native S3 state locking via `use_lockfile`), AWS provider `~> 6.0`, `us-east-1`.
- Environments are directories (`envs/staging`, `envs/production`) with separate state
  keys in `s3://everything-infra-tfstate-095256591532` — no workspaces.
- Naming is verb-based (`generate-*`), never vendor-based.
