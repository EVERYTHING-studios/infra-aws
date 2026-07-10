variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "account_id" {
  description = "AWS account id (for CloudFront/EventBridge ARNs)."
  type        = string
}

variable "dist_dir" {
  description = "Path to services/generate/dist containing bundled handlers."
  type        = string
}

variable "tasks_table_name" {
  type = string
}

variable "tasks_table_arn" {
  type = string
}

variable "work_bucket_name" {
  description = "Internal bucket for intermediate pipeline artifacts."
  type        = string
}

variable "work_bucket_arn" {
  type = string
}

variable "assets_bucket_name" {
  description = "Existing model-assets bucket (owned by the web-app's SST stack)."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
}

variable "assets_base_url" {
  description = "Public CDN base URL for finished assets (e.g. https://staging-assets.everythingstudios.ai)."
  type        = string
}

variable "cloudfront_distribution_id" {
  description = "Assets CDN distribution id for post-refine invalidations. Empty disables invalidation."
  type        = string
  default     = ""
}

variable "webhook_url" {
  description = "web-app endpoint that receives task webhooks."
  type        = string
}

variable "webhook_secret_arn" {
  description = "Secrets Manager secret holding the webhook HMAC secret."
  type        = string
}

variable "inference_lambda_arn" {
  description = "Lambda invoked by the Inference state (stub today, SageMaker dispatcher later)."
  type        = string
}

variable "inference_backend" {
  description = "Backend recorded by prepare and used by the inference dispatch: stub | sagemaker."
  type        = string
  default     = "stub"
}

variable "postprocess_mode" {
  description = "Post-process path: lite (Lambda, GLB-only) | fargate (Blender container, all formats)."
  type        = string
  default     = "lite"

  validation {
    condition     = contains(["lite", "fargate"], var.postprocess_mode)
    error_message = "postprocess_mode must be lite or fargate."
  }
}

variable "postprocess_cpu" {
  type    = number
  default = 2048
}

variable "postprocess_memory" {
  type    = number
  default = 8192
}

variable "postprocess_image_tag" {
  type    = string
  default = "latest"
}

variable "vpc_id" {
  description = "VPC for the Fargate post-process task."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the Fargate post-process task (need a route to S3/ECR)."
  type        = list(string)
}
