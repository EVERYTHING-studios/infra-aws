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
