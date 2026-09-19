# Fill in from the account (aws ec2 describe-vpcs / describe-subnets):
vpc_id     = "vpc-0b1a89926db644682"
subnet_ids = ["subnet-0b1844d621a18491c", "subnet-0a8f3166ff4354d21", "subnet-0278be3dbed4262c5", "subnet-01851a28b42da9179", "subnet-01779a892bf7c9e0d", "subnet-0e43f0cde99e9f7a4"]

# From the web-app SST stack (AssetsCdn distribution):
cloudfront_distribution_id = ""

inference_backend = "sagemaker"
postprocess_mode  = "lite"

# SageMaker instance type: ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM,
# 1597 GB/s — 1.85x the memory bandwidth of g6e's L40S). The image is compiled
# for sm_120 only; to fall back to g6e/g5, build a multi-arch image
# (TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX") and set this to ml.g6e.2xlarge.
# low_vram="0" loads all ~17 GB models to GPU once (safe on 96 GB VRAM).
instance_type = "ml.g7e.2xlarge"
low_vram      = "0"

# Endpoint autoscaling max. Quota L-5AA715AC is per-region and now 4 in
# us-east-1; staging 1 + production 1 fits comfortably.
sagemaker_max_capacity = 1

# SageMaker candidate regions. List order = sentinel failback priority.
# us-east-2 first: the only region with demonstrated capacity (staging's
# endpoint has been InService there since 2026-09-17; us-east-1 hit
# InsufficientInstanceCapacity on every production create attempt,
# 2026-09-16 through 2026-09-18). us-east-1 stays as failback candidate —
# its regional stack (buckets/model/config) is already live.
# us-east-2 prerequisites per the add-a-region runbook: quota L-5AA715AC = 2.0
# (staging 1 + production 1 fits), artifacts replicated via
# trellis2image/scripts/replicate_artifacts.sh.
sagemaker_candidate_regions = ["us-east-2", "us-east-1"]
