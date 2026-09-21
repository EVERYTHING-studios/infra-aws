# SageMaker Endpoint Performance Benchmarks

TRELLIS.2-4B image-to-3d inference on SageMaker async endpoints, measured in
staging (`us-east-1`, `AWS_PROFILE=aman-aws`). All measurements use
`scripts/measure-endpoint.sh` unless noted otherwise.

## Instance types

| Instance | GPU | VRAM | vCPU | RAM | $/hr |
|---|---|---|---|---|---|
| `ml.g7e.2xlarge` | RTX PRO 6000 (Blackwell) | 96 GB | 8 | 64 GiB | $4.20 |
| `ml.g6e.2xlarge` | L40S | 45 GB | 8 | 64 GiB | $2.80 |
| `ml.g5.2xlarge` | A10G | 24 GB | 8 | 32 GiB | $1.52 |

All are single-GPU instances; multi-GPU instances (g5.12x+, p4d, p5) waste all
but one GPU on this single-GPU-per-render workload. The deployment now runs
**one endpoint per (region × instance type)** with a capacity sentinel electing
by the **cold-price chain `g5 → g6e → g7e`** (measured cold-cycle costs:
$0.35 (re-measured 2026-09-21 on the multi-arch image) / ~$0.70 est /
$0.86–0.93 per cold request — see the per-instance
sections below). For this scale-to-zero endpoint cold cost dominates, so the
cheapest cold cycle wins even though g7e's warm cost ($0.067/req) is 10×
cheaper — g7e serves only when g5 AND g6e are both unavailable (Blackwell
capacity droughts made g7e the risky head; us-east-1 was dry all day
2026-09-17). The image is **multi-arch**
(`TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX"`, bundle `precision-v1.1`):
one image serves g5 (sm_86), g6e (sm_89), Hopper (sm_90), and g7e + the
local dev box (sm_120) — no per-type builds. `TRELLIS2_LOW_VRAM` is derived
per type in the sagemaker-region module: `"1"` on g5's 24 GB (cannot hold all
~17 GB of models resident), `"0"` on g6e/g7e. `ml.g7.2xlarge` (RTX PRO 4500
Blackwell, $3.15/hr) is **not recommended** — its memory bandwidth
(~800 GB/s) is *lower* than g6e's L40S (864 GB/s) while costing more per
hour, making it a cost-per-request regression (see § ml.g7e.2xlarge below
for the analysis).

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
(`e2e-test/T.png`, a presigned S3 URL) and produce a ~6 MB GLB (down from
~40 MB after GLB optimization — see "GLB optimization" below).

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
[Scale-to-zero](../modules/generate-inference/sagemaker-region/README.md#scale-to-zero)
in the sagemaker-region module README.

### Re-measure on the multi-arch image (2026-09-21, chain head)

First cold cycle after the precision-v1.1 multi-arch cutover (per-(region ×
type) endpoints, sentinel chain). Task `01M31BKJPW1Y061G0K7HDNDGX7`, submitted
after scale-to-zero, served by the chain head `generate-staging-sagemaker-g5`
(us-east-1) — confirmed via `InvocationsProcessed=1` on that endpoint:

```
Run type:           COLD (scale 0 -> 1)
Billable window:    822s  (06:53:03 -> 07:06:46)
  Cold start:       537s  (provision + image pull + weights load)
  Inference GPU:    239.5s  (ModelLatency)
  Cooldown:         285s  (last invocation -> scale-in end)
Queue wait:         675s  (request queued while instance provisioned)
Task wall-clock:    794s  (SUCCEEDED)
Hourly rate:        $1.52/hr (AWS Pricing API)
Est cost:           $0.35
```

vs the 2026-08-23 pre-multi-arch measurement (920s / $0.39): the cold cycle
is ~11% cheaper and the GPU render is **39% faster** (239.5s vs 396s cold /
388.6s warm on the Aug image) — the precision-v1 pipeline improvements carry
to Ampere. At 239.5s the warm cost is **$0.101/request** (was $0.164). The
run's GLB output measured **4.0 MB** (content-length) — the optimized output
class on the multi-arch image. E2e chain behavior verified in the same run:
dispatch via `active_endpoint`, SNS callback, task record
`sagemaker_region=us-east-1` matching the elected entry.


## ml.g7e.2xlarge (Blackwell RTX PRO 6000)

Deployed primary instance (staging, 2026-08-24). G7e (Blackwell, sm_120) offers 1,597 GB/s memory
bandwidth — 1.85× the g6e L40S's 864 GB/s — and 96 GB VRAM. The image is
compiled for sm_120 only (zero rebuild needed; sm_120 was already in the
prior arch list). All optimizations from this plan (low_vram=False, selective
model loading, multi-stage image, eager loading) are enabled by default.

### Cold start (local, same GPU as g7e)

Measured 2026-08-23 on the local dev box (RTX PRO 6000, sm_120 — identical to
g7e.2xlarge) with `TRELLIS2_LOW_VRAM=0` + `TRELLIS2_SKIP_UNUSED_MODELS=1`:

| Metric | Value |
|---|---|
| Cold (load + infer) | 131.4s |
| Model load (cold − warm) | ~82s |
| GLB size | 29.4 MB |

The ~82s model load (from local NVMe HF cache, read-only mount) includes
`from_pretrained` + `pipeline.cuda()` bulk-loading all ~14.5 GB of models to
GPU. On a real g7e endpoint the cold start also includes ECR image pull
(21.7 GB image, down from 30.6 GB) + S3 model.tar.gz download (~10.8 GB, down
from ~13.3 GB). The 50 Gbps network (vs g5's 10 Gbps) speeds both. Cloud cold
start measured below — see "Cloud cold-start (deployed)".

### Cloud cold-start (deployed)

Measured 2026-08-24 on the deployed staging endpoint (`ml.g7e.2xlarge`,
image `glb-fix2-staging`, weights 10.82 GB). Task
`01M0S7QA2MYSFYBE6B0BSJ384X` submitted after scale-to-zero (true 0→1 cold
start):

```
Run type:           COLD (scale 0 -> 1)
Billable window:    738s  (06:40:28 -> 06:52:46)
  Cold start:       392s  (provision + download + weights load)
  Inference GPU:    130.0s  (useful work)
  Cooldown:         346s  (last invocation -> scale-in end)
  Idle fraction:    100%  (cold start + cooldown / billable)
Queue wait:         631s
Task wall-clock:    687s (SUCCEEDED)
Hourly rate:        $4.20/hr
Est cost:           $0.86/request
```

**Repeatability — second run** (2026-08-24 22:54 UTC, task `01M0TZPFXDM7JXBK2RDJJ43K8M`):
billable `797s`, cold start `430s`, `ModelLatency` `123.8s`,
cooldown `367s`, est cost `$0.93/request`. Corroborates the initial run
within `+8.0%` on billable window / `-4.7%` on cold ModelLatency.

**Cold-start cost per request: $0.86** (738s billable × $4.20/3600). This is
the cost of a single request that triggers a 0→1 scale-up and subsequent
scale-down — the worst case for a cold, low-traffic endpoint. In steady
state with a warm instance, the per-request cost drops to $0.068 (see warm
inference below).

The 392s cold start breaks down as: instance provisioning (~5 min) + ECR
image pull (21.7 GB) + S3 weights download (10.8 GB) + eager model load
(~82s, per the local measurement). The first-invocation `ModelLatency` of
130.0s is ~2.25× the warm-run 57.8s — likely CUDA kernel JIT compilation
(`flex_gemm` first-call) on top of the eager load, since the model itself
should already be resident from `TRELLIS2_EAGER_LOAD=1`. The cold-start
`ModelLatency` is not a concern for steady-state cost; the warm-run number
is what matters.

> **Stale-image root cause (initial g7e deploy):** The first g7e deploy
> (image `4d72b4d-staging`, built Aug 23 22:00 UTC from commit `08c70e9`)
> predates the merge of `feat/glb-geometry-compression` (`f557697`) and the
> web-optimize commit (`4d72b4d`). That image had no gltfpack binary and no
> `_optimize_glb`/`_resize_textures` functions, producing ~40 MB GLBs. The
> rebuilt image (`glb-fix2-staging`) applies `_resize_textures` (4096→2048
> LANCZOS) + `gltfpack -cc -si 0.5` (geometry quantization + meshopt
> compression + 50% mesh simplification), dropping GLBs to ~6 MB — an 85%
> reduction.

### Warm inference (local, same GPU as g7e)

| Metric | Value |
|---|---|
| Warm inference (reuse pipeline) | **49.3s** |
| GLB size | 29.2 MB |

**49.3s vs g6e's 252.3s = 5.1× speedup.** This far exceeds the 1.5× break-even
threshold and even the 1.85× bandwidth-ratio estimate. The speedup combines
Blackwell's 1,597 GB/s memory bandwidth (1.85× g6e) with `low_vram=False`
(eliminating the 8+ per-request PCIe model swaps that the g6e baseline
suffered under `low_vram=True`). The GLB is smaller (29 MB vs 42.7 MB) only
because the local test used a simple synthetic image; cloud tests with real
images now produce ~6 MB GLBs after GLB optimization (see below). The 29.2 MB
local GLB predates the optimization code (`_resize_textures` + `gltfpack`).

### Cloud warm inference (deployed)

Measured 2026-08-24 on the deployed staging endpoint, immediately after the
cold run (instance still warm). Task `01M0S8CR3KJ1NX9E9MHYCX6CYD`:

| Metric | Value |
|---|---|
| Wall-clock | 65s |
| ModelLatency (GPU) | **57.8s** |
| GLB size | 6.0 MB |

**Repeatability — second run** (2026-08-24, task `01M0V0CXD9SQN3DAF9MW64NVCS`):
wall-clock `70s`, `ModelLatency` `63.7s` (derived),
GLB size `6.0` MB.

The warm `ModelLatency` of 57.8s is derived from the measurement window's
total `ModelLatency` (187.79s for 2 invocations) minus the cold run's
130.0s, since both invocations fell in the same CloudWatch period. The
glbfpack + texture-resize post-processing adds ~1-2s of CPU work inside
the `/invocations` call — negligible vs the ~58s GPU inference time.

```
Run type:           WARM (instance already provisioned)
Inference GPU work: 57.8s
Overhead:           0.000s
Task wall-clock:    65s (SUCCEEDED)
```

**57.8s vs g6e's 252.3s = 4.4× speedup** (cloud-to-cloud, same `T.png`
input). This exceeds the 1.5× break-even threshold by 2.9×, confirming g7e
as the cost-optimal instance. The 57.8s cloud warm time is close to the
49.3s local baseline (the ~9s difference is attributable to the real 1.7 MB
`T.png` input vs the local synthetic 256×256 image, plus SageMaker
invocation-framework overhead). GLB size (6.0 MB) is down 85% from the
~40 MB produced by the pre-optimization stale image.

### Cost analysis (warm runs, with low_vram=False)

| Scenario | Instance | Warm time | $/hr | $/request |
|---|---|---|---|---|
| Current g5 (staging, low_vram=True, Aug image) | g5.2xlarge | 389s | $1.52 | $0.164 |
| g5 multi-arch precision-v1.1 (2026-09-21, chain head) | g5.2xlarge | 239.5s | $1.52 | $0.101 |
| Current g6e (prod, low_vram=True) | g6e.2xlarge | 252s | $2.80 | $0.196 |
| G7 (NOT recommended) | g7.2xlarge | ~252s | $3.15 | $0.220 |
| **G7e + low_vram=False (CLOUD MEASURED)** | **g7e.2xlarge** | **57.8s** | **$4.20** | **$0.067** |
| G7e local (synthetic image) | g7e.2xlarge | 49.3s | $4.20 | $0.057 |
| G7e at 1.5× speedup (conservative est) | g7e.2xlarge | ~168s | $4.20 | $0.196 |

**G7e at the cloud-measured 57.8s warm time costs $0.067/request — 2.9×
cheaper than g6e ($0.196) and 2.4× cheaper than g5 ($0.164).** The 4.4×
cloud-to-cloud speedup over g6e (57.8s vs 252.3s, same `T.png` input) far
exceeds the 1.5× break-even threshold and even the 1.85× bandwidth-ratio
estimate. The combination of Blackwell's 1,597 GB/s memory bandwidth with
`low_vram=False` (eliminating per-request PCIe model swaps) is dramatically
more effective than bandwidth alone would predict.

G7e wins on cost-per-request when inference is ≥1.5× faster than g6e ($0.196
break-even). The measured 4.4× speedup confirms g7e as the cost-optimal
instance — no revert to g6e is needed. The local synthetic-image baseline
(49.3s, $0.057/req) is ~16% faster than the cloud real-image measurement
(57.8s, $0.067/req) due to input complexity (256×256 synthetic vs 1.7 MB real
image); both confirm the same conclusion.

### Why not ml.g7.2xlarge (RTX PRO 4500 Blackwell)

G7's memory bandwidth (~800 GB/s) is *lower* than the current g6e's L40S
(864 GB/s), and its hourly rate ($3.15) is *higher* than g6e ($2.80). For a
diffusion pipeline where sampling is memory-bandwidth-bound, G7 would be no
faster than g6e while costing more per hour — a cost-per-request *regression*
(252s × $3.15/3600 = $0.220/req vs g6e's $0.196). G7e's 1,597 GB/s is what
makes the Blackwell upgrade worthwhile.

## GLB optimization

The serving container applies two post-export optimizations to every GLB,
controlled by `DEFAULT_WEB_TEXTURE_SIZE=2048` and `DEFAULT_WEB_SIMPLIFY_RATIO=0.5`
in `serving/server.py`:

1. **Texture resize** (`_resize_textures` in `engine.py`): downscales all
   textures from 4096×4096 to 2048×2048 using Pillow LANCZOS resampling.
   Halves texture bytes with imperceptible quality loss for web display.
2. **Geometry compression** (`_optimize_glb` in `engine.py`): runs
   `gltfpack -cc -si 0.5` on the exported GLB. `-cc` enables meshopt
   compression (vertex quantization + buffer compression); `-si 0.5`
   simplifies meshes to 50% of their triangle count.

Measured impact (cloud, `T.png` input, `ml.g7e.2xlarge`):

| Metric | Before (stale image) | After (optimized image) |
|---|---|---|
| GLB size | ~40 MB | **~6 MB** (−85%) |
| Warm ModelLatency | 58.3s | 57.8s (~unchanged) |
| Warm wall-clock | 66s | 65s (~unchanged) |

The gltfpack + texture-resize post-processing adds ~1-2s of CPU work inside
the `/invocations` call — negligible vs the ~58s GPU inference time. The
optimization is pure post-export CPU work; it does not affect GPU inference
or the model pipeline.

## Comparison

| Metric | g7e.2xlarge (Blackwell) | g6e.2xlarge (L40S) | g5.2xlarge (A10G) |
|---|---|---|---|
| Hourly rate | $4.20 | $2.80 | $1.52 |
| VRAM | 96 GB | 45 GB | 24 GB |
| Cold start (provision + load) | 392s (~6.5 min) | ~5 min | 537s (~9 min, 2026-09-21) |
| Cold-start $/request | **$0.86** (738s × $4.20/hr) | — | **$0.35** (822s × $1.52/hr, 2026-09-21) |
| Model load (local, NVMe) | ~82s | — | — |
| Warm ModelLatency (GPU) | **57.8s** (cloud, measured) | 252.3s (4.2 min) | 239.5s (2026-09-21, precision-v1.1; 388.6s on Aug image) |
| Warm run est cost | **$0.068** (57.8s × $4.20/hr) | ~$0.20 (252s × $2.80/hr) | ~$0.10 (239.5s × $1.52/hr) |
| Speedup vs g6e (warm) | **4.4×** (cloud-to-cloud) | 1× | 0.65× |
| GLB size | **6.0 MB** (optimized) | 42.7 MB (pre-opt) | 42.8 MB (pre-opt) |
| Scale-to-zero (safe) | ~3 min (new alarm) | ~17 min (old) / ~3 min (new) | ~3 min (new) |
| low_vram | "0" (all models resident) | "0" (all models resident) | "1" (per-stage swap) |

**Second-run corroboration** (2026-08-24): a second cold+warm run
(tasks `01M0TZPFXDM7JXBK2RDJJ43K8M` / `01M0V0CXD9SQN3DAF9MW64NVCS`) measured cold-start
`$0.93/request` and warm `ModelLatency` `63.7s`, GLB `6.0` MB —
within `+8.0%` billable / `-4.7%` cold ModelLatency of the primary run, confirming the g7e numbers above are
representative, not a single-run artifact.

## Cost efficiency levers

1. **Scale-to-zero**: the custom `EndpointIdle` metric alarm reduces idle
   billing from ~17 min to ~3 min after each request. This is the single
   biggest cost win — without scale-to-zero, a single request per day would
   bill 24h × $4.20 = $100.80/day on g7e.
2. **Batching**: cold start + cooldown dominate a single-request cold run
   (100% idle fraction). Submitting a second request while the instance is
   warm eliminates its cold-start cost entirely.
3. **Instance selection (chain)**: the cold-price chain g5 → g6e → g7e is
   deployed as one endpoint per (region × type) and elected by the sentinel
   (see "Instance types" above). One multi-arch image serves all three —
   no per-type builds. g7e keeps the best warm economics ($0.067/req,
   1.85× g6e bandwidth, 96 GB VRAM) but the priciest cold cycle.
4. **low_vram derived per type**: on ≥45 GB VRAM instances (g6e, g7e), the
   module sets `low_vram="0"` — loads all ~17 GB of models to GPU once at
   startup, eliminating per-request CPU↔GPU swapping (8+ PCIe round-trips
   of ~2.5 GB). The single biggest warm-inference win. Not safe on g5
   (24 GB) — the module sets `low_vram="1"` there.
5. **Selective model loading**: the unused `tex_slat_flow_model_512` (~2.5 GB)
   is excluded from both the loaded models and the packaged weights tar,
   shrinking the artifact from ~13.3 GB to ~10.8 GB and speeding the S3
   download at provisioning.
6. **Multi-stage Dockerfile**: the runtime image uses `cudnn-runtime` (no CUDA
   toolkit), cutting the image from ~30.6 GB to well under ~22 GB — faster ECR
   pull on cold start.
7. **GSI2 query limit**: the `endpoint-scaler` Lambda queries GSI2 every
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
