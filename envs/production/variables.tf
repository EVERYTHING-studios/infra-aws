variable "vpc_id" {
  description = "VPC for the Fargate post-process task (the account's default VPC works)."
  type        = string
}

variable "subnet_ids" {
  description = "Public subnets for the Fargate post-process task."
  type        = list(string)
}

variable "cloudfront_distribution_id" {
  description = "Assets CDN distribution id (from the web-app SST stack) for post-refine invalidations. Empty disables invalidation."
  type        = string
  default     = ""
}

variable "inference_backend" {
  description = "stub | sagemaker"
  type        = string
  default     = "stub"
}

variable "postprocess_mode" {
  description = "lite | fargate — switch to fargate once the postprocess image is pushed to ECR."
  type        = string
  default     = "lite"
}

variable "instance_type" {
  description = "SageMaker async endpoint instance type. Default ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM, 1597 GB/s). g6e.2xlarge (L40S, 45 GB) is the fallback; g5.2xlarge (A10G, 24 GB) requires low_vram=\"1\"."
  type        = string
  default     = "ml.g7e.2xlarge"
}

variable "low_vram" {
  description = "TRELLIS2_LOW_VRAM env: \"0\" (default) loads all models to GPU once (requires >=45 GB VRAM); \"1\" keeps models on CPU per-stage (safe on g5 24 GB)."
  type        = string
  default     = "0"
}

variable "sagemaker_max_capacity" {
  description = "SageMaker endpoint autoscaling max (min 0). Account-wide g7e quota L-5AA715AC is 4 in us-east-1 (per-region in the candidate regions); env maxima must sum within each region's quota."
  type        = number
  default     = 2
}

variable "sagemaker_candidate_regions" {
  description = "Regions with a full SageMaker stack. SageMaker offers ml.g7e.2xlarge only in us-east-1/us-east-2/us-west-2; quota L-5AA715AC must be >= 1 before a region is appended. Order = sentinel failback priority."
  type        = list(string)
  default     = ["us-east-1"]
}
