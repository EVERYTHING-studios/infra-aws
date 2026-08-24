# Fill in from the account (aws ec2 describe-vpcs / describe-subnets):
vpc_id     = "vpc-CHANGE-ME"
subnet_ids = ["subnet-CHANGE-ME-a", "subnet-CHANGE-ME-b"]

# From the web-app SST stack (AssetsCdn distribution):
cloudfront_distribution_id = ""

inference_backend = "stub"
postprocess_mode  = "lite"

# SageMaker instance type: ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM,
# 1597 GB/s — 1.85x the memory bandwidth of g6e's L40S). The image is compiled
# for sm_120 only; to fall back to g6e/g5, build a multi-arch image
# (TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX") and set this to ml.g6e.2xlarge.
# low_vram="0" loads all ~17 GB models to GPU once (safe on 96 GB VRAM).
instance_type = "ml.g7e.2xlarge"
low_vram      = "0"
