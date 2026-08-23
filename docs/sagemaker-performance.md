# SageMaker Endpoint Performance Benchmarks

TRELLIS.2-4B image-to-3d inference on SageMaker async endpoints, measured in
staging (`us-east-1`, `AWS_PROFILE=aman-aws`). All measurements use
`scripts/measure-endpoint.sh` unless noted otherwise.

## Instance types

| Instance | GPU | VRAM | vCPU | RAM | $/hr |
|---|---|---|---|---|---|
| `ml.g6e.2xlarge` | L40S | 45 GB | 8 | 64 GiB | $2.80 |
| `ml.g5.2xlarge` | A10G | 24 GB | 8 | 32 GiB | $1.52 |

Both are single-GPU instances; multi-GPU instances (g5.12x+, p4d, p5) waste all
but one GPU on this single-GPU-per-render workload. The g5.2xlarge was the
original target but had account endpoint-quota=0; the g6e.2xlarge was used
until the quota was approved. Staging now runs g5.2xlarge; production defaults
to g6e.2xlarge.

## Methodology

`scripts/measure-endpoint.sh` correlates a task's DynamoDB record with
CloudWatch metrics and Application Auto Scaling activities to decompose the
billable window:

- **Billable window**: scale-up activity start → scale-in activity end (the
  period the instance is provisioned and incurring charges).
- **Cold start**: first invocation timestamp − scale-up start (provisioning +
  model download + GPU weights load).
- **Inference GPU**: `ModelLatency` sum (pure GPU work, microseconds → seconds).
- **Cooldown**: scale-in end − last invocation (alarm evaluation + scale-down
  activity).
- **Idle fraction**: `(cold start + cooldown) / billable` — the fraction of the
  billable window that is not useful GPU work.

Cold runs start from `CurrentInstanceCount = 0` (scale-to-zero). Warm runs
reuse an already-provisioned instance. All tasks use the same test input
(`e2e-test/T.png`, a presigned S3 URL) and produce a ~42 MB GLB.

## ml.g6e.2xlarge (L40S)

Measured 2026-08-23 during initial e2e verification (commit `9057153`).

### Cold start

Total cold-start time: **~10 min 39 sec** (639s), measured from scale-up to
task completion. Breakdown from commit log:

- Provisioning: ~5 min (instance boot + container pull)
- Inference (including model weights load): ~5.5 min (330s)
- Pure GPU inference (`ModelLatency`): **252.3s** (4.2 min)

### Warm run

Task `01M0P9AGPN3JGN2267N4BZD5T2` (first successful invocation, instance
already warm from prior failed attempts):

| Metric | Value |
|---|---|
| Wall-clock | 265s (4.4 min) |
| ModelLatency (GPU) | 252.3s (4.2 min) |
| Pipeline overhead | 12.7s (prepare + dispatch + callback + postprocess) |
| GLB size | 42.7 MB |

### Scale-to-zero

With the original 3-period `HasBacklogWithoutCapacity` alarm: **~5 min**
(3-min alarm evaluation + 2-min shutdown). This was fast but **unsafe** — the
alarm fired mid-inference, causing an endless scale-up/scale-down cycle. The
workaround (15 evaluation periods) made it safe but extended scale-to-zero to
~17 min, wasting 15 min of idle billing before each scale-down.

## ml.g5.2xlarge (A10G)

Measured 2026-08-23 after switching staging to g5.2xlarge.

### Cold run

Task `01M0QNQM563TP1BJEG08F9CPYQ` (submitted after scale-to-zero, single
scale-up/scale-down cycle, no mid-inference kill):

```
Run type:           COLD (scale 0 -> 1)
Billable window:    920s  (16:06:17 -> 16:21:37)
  Cold start:       643s  (provision + download + weights load)
  Inference GPU:    396s  (useful work)
  Cooldown:         277s  (last invocation -> scale-in end)
  Idle fraction:    100%  (cold start + cooldown / billable)
Queue wait:         850s  (request queued while instance provisioned)
Task wall-clock:    899s  (SUCCEEDED)
Hourly rate:        $1.52/hr
Est cost:           $0.39
```

Timeline:
- 16:02 — task submitted, endpoint at 0 instances
- 16:06 — backlog alarm fires (2 consecutive periods), scale-up begins
- 16:11 — instance provisioned, request picked up
- 16:17 — inference completes (ModelLatency 396.3s), callback clears token
- 16:18 — `EndpointIdle` metric goes to 1 (idle)
- 16:21 — scale-to-zero alarm fires (3 consecutive idle periods), instance
  terminates

### Warm inference

Task `01M0QFQ6G8CV0YMXVMHE7PY6VN` (first successful invocation on g5, instance
warm from prior scale-up):

| Metric | Value |
|---|---|
| ModelLatency (GPU) | 388.6s (6.5 min) |
| GLB size | 42.8 MB |

### Scale-to-zero

With the custom `EndpointIdle` metric alarm (3 evaluation periods):
**~3 min** (3-min alarm evaluation + ~30s scale-down activity). This is both
safe and fast — the metric stays `0` (busy) while any `sagemaker_task_token`
exists, so the alarm cannot fire mid-inference. See
[Scale-to-zero](../modules/generate-inference/sagemaker/README.md#scale-to-zero)
in the sagemaker module README.

## Comparison

| Metric | g6e.2xlarge (L40S) | g5.2xlarge (A10G) |
|---|---|---|
| Hourly rate | $2.80 | $1.52 |
| Cold start (provision + load) | ~5 min | ~10.7 min |
| Warm ModelLatency (GPU) | 252.3s (4.2 min) | 388.6s (6.5 min) |
| Warm run est cost | ~$0.20 (252s × $2.80/hr) | ~$0.16 (389s × $1.52/hr) |
| Cold run wall-clock | ~10.7 min | 899s (15.0 min) |
| GLB size | 42.7 MB | 42.8 MB |
| Scale-to-zero (safe) | ~17 min (old alarm) / ~3 min (new) | ~3 min (new) |
| Cold run est cost | ~$0.50 (639s × $2.80/hr) | $0.39 (920s × $1.52/hr) |

The g6e.2xlarge (L40S) is **54% faster** at inference (252s vs 389s) but
**84% more expensive** per hour ($2.80 vs $1.52). For a single cold request:
- g6e: ~$0.50 (faster, but higher hourly rate)
The g5 is cheaper per request in both cases — the lower hourly rate more than
compensates for the slower inference. Warm runs are ~$0.16 (g5) vs ~$0.20
(g6e); cold runs are ~$0.39 (g5) vs ~$0.50 (g6e). The g6e's speed advantage
pays off when batching multiple requests within a single billable window — the
higher throughput (more requests/min) amortizes the higher hourly rate.

## Cost efficiency levers

1. **Scale-to-zero**: the custom `EndpointIdle` metric alarm reduces idle
   billing from ~17 min to ~3 min after each request. This is the single
   biggest cost win — without scale-to-zero, a single request per day would
   bill 24h × $1.52 = $36.50/day on g5.
2. **Batching**: cold start + cooldown dominate a single-request cold run
   (100% idle fraction). Submitting a second request while the instance is
   warm eliminates its cold-start cost entirely.
3. **Instance selection**: g5.2xlarge is cheaper per cold request ($0.39 vs
   $0.50) but g6e.2xlarge has higher throughput (252s vs 389s per request).
   The crossover point is ~2-3 requests per billable window, above which
   g6e's throughput advantage overcomes its higher hourly rate.
4. **GSI2 query limit**: the `endpoint-scaler` Lambda queries GSI2 every
   minute with `Limit: 100`. At low task volume this is negligible
   (<$1/month). If volume grows, reduce to `Limit: 1` (we only need to know
   if count > 0, not the exact count).

## Reproducing

```bash
# Submit a cold-run task (after scale-to-zero):
API=https://staging-generate.everythingstudios.ai
KEY=$(AWS_PROFILE=aman-aws aws secretsmanager get-secret-value \
  --secret-id generate-staging-api-key --query SecretString --output text)
IMG_URL=$(AWS_PROFILE=aman-aws aws s3 presign \
  s3://generate-staging-inference-input-095256591532/e2e-test/T.png --expires-in 7200)

TASK_ID=$(curl -s -X POST "$API/v1/tasks" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"type\":\"image-to-3d\",\"input\":{\"image_urls\":[\"$IMG_URL\"]},\"output\":{\"user_id\":\"00000000-0000-4000-8000-000000000001\",\"job_id\":\"00000000-0000-4000-8000-000000000004\"}}" \
  | jq -r .task_id)

# Poll until SUCCEEDED, then measure:
AWS_PROFILE=aman-aws TASK_ID=$TASK_ID bash scripts/measure-endpoint.sh
```

Note: CloudWatch metrics (ModelLatency, InvocationsProcessed) can lag by 5-10
min after inference completes. If the measurement report shows 0 invocations,
wait and re-run.
