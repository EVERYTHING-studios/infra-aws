# Fill in from the account (aws ec2 describe-vpcs / describe-subnets):
vpc_id     = "vpc-0b1a89926db644682"
subnet_ids = ["subnet-0b1844d621a18491c", "subnet-0a8f3166ff4354d21", "subnet-0278be3dbed4262c5", "subnet-01851a28b42da9179", "subnet-01779a892bf7c9e0d", "subnet-0e43f0cde99e9f7a4"]

# From the web-app SST stack (AssetsCdn distribution):
cloudfront_distribution_id = ""

# SageMaker cutover (plan B3d/B4): set to "sagemaker" once the SageMaker
# endpoint is ready to serve staging traffic end-to-end. This provisions the
# Model/Endpoint + dispatcher/callback Lambdas and switches the pipeline's
# Inference state to .waitForTaskToken. Keep "stub" until staging is validated.
inference_backend = "sagemaker"
postprocess_mode  = "lite"

# SageMaker instance-type chain: one endpoint per (region x type); the
# capacity sentinel elects the first HEALTHY endpoint in this order.
# Chain = cold-cycle price order (g5 $0.39 -> g6e ~$0.70 -> g7e $0.86-0.93
# per cold request; see trellis2image/docs/instance-sizing.md). The image is
# multi-arch (sm_80/86/90/120) — no per-type build. low_vram is derived per
# type inside the sagemaker-region module ("1" on g5's 24 GB, "0" elsewhere).
# g7e dropped 2026-09-21: Blackwell still capacity-dry — endpoint creates
# Failed with InsufficientInstanceCapacity after ~30 min of retries in BOTH
# regions (the g7e chain tail was the entire apply's blocker: the control
# plane converges only after every regional endpoint, and a Failed g7e
# endpoint aborts it). The sentinel never elects a missing endpoint, so the
# chain prefix serves fine without it. Re-add "ml.g7e.2xlarge" as a one-line
# change + full apply once Blackwell capacity returns (quota L-5AA715AC is
# 4/2 and the multi-arch image still carries sm_120 kernels).
sagemaker_instance_types = ["ml.g5.2xlarge", "ml.g6e.2xlarge"]

# Endpoint autoscaling max. Per-type endpoint-usage quotas (checked 2026-09-19):
# g5.2xlarge L-9614C779 = 2, g6e.2xlarge L-F8D7F460 = 1, g7e.2xlarge
# L-5AA715AC = 4 in us-east-1 / 2 in us-east-2. 1 + 1 (staging + production)
# fits g5 and g7e; g6e quota = 1 per region means the two envs' g6e endpoints
# cannot both hold an instance at once in one region — apply staging first,
# let its endpoints scale to zero, then production (a Failed create from the
# quota race just needs delete-endpoint + re-apply).
sagemaker_max_capacity = 1

# Multi-region capacity: alternate regions with replicated artifacts
# (image/weights) and their own per-type SageMaker endpoints. Region order
# here = region priority WITHIN each chain type (type-major election: see
# modules/generate-inference/README + sagemaker-control). us-east-1 first:
# the chain head is g5 (mature Ampere capacity, quota 2 in both regions)
# and same-region dispatch with the us-east-1 control plane avoids
# cross-region input/GLB copies; the earlier us-east-2-first rationale
# (g7e Blackwell drought in us-east-1) applied to a g7e head, not a g5 head.
# On a drought the sentinel fails over within ~1 minute automatically.
# us-west-2 deferred after a second failed probe on 2026-09-17: quota
# L-5AA715AC = 2.0 there, but create-endpoint hit InsufficientInstanceCapacity
# twice in the morning and again after ~31 min of retrying in the afternoon.
# Its ECR repo + replicated artifacts (image/weights/SSM params) are still in
# place. To retry later: append "us-west-2", targeted-apply its buckets/SSM
# (already exist), re-run replicate_artifacts.sh with
# REPLICATE_REGIONS="us-west-2", then full apply.
sagemaker_candidate_regions = ["us-east-1", "us-east-2"]
