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

# SageMaker instance type: ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM,
# 1597 GB/s — 1.85x the memory bandwidth of g6e's L40S). The image is compiled
# for sm_120 only; to fall back to g6e/g5, build a multi-arch image
# (TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0;12.0+PTX") and set this to ml.g6e.2xlarge.
# low_vram="0" loads all ~17 GB models to GPU once (safe on 96 GB VRAM).
instance_type = "ml.g7e.2xlarge"
low_vram      = "0"
