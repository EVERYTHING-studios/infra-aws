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

variable "sagemaker_instance_types" {
  description = "SageMaker async endpoint instance types — one endpoint per (region x type) in every candidate region; list order = the sentinel's cold-price chain order. low_vram is derived per type inside the module."
  type        = list(string)
  default     = ["ml.g5.2xlarge", "ml.g6e.2xlarge", "ml.g7e.2xlarge"]
}

variable "sagemaker_max_capacity" {
  description = "SageMaker endpoint autoscaling max (min 0). Instance-type quota is account-wide per region per type: staging + production maxima must sum within each region's endpoint-usage quota (g5.2xlarge L-9614C779 = 2, g6e.2xlarge L-F8D7F460 = 1, g7e.2xlarge L-5AA715AC = 4/2 in us-east-1/us-east-2, checked 2026-09-19)."
  type        = number
  default     = 2
}

variable "sagemaker_candidate_regions" {
  description = "Regions with a full SageMaker stack (us-east-1/us-east-2/us-west-2 — the only regions offering ml.g7e.2xlarge). Each (type, region) needs its endpoint-usage quota >= 1 before the type's endpoint can be created there. Order = sentinel region priority within each chain instance type."
  type        = list(string)
  default     = ["us-east-1"]
}
