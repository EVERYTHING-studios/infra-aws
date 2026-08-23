variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
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
  type = string
}

variable "work_bucket_arn" {
  type = string
}

variable "env" {
  description = "Environment name (staging|production). Selects the per-env SSM namespace and bucket suffix."
  type        = string
}

variable "inference_backend" {
  description = "Backend for the Inference state: stub (default) | sagemaker."
  type        = string
  default     = "stub"

  validation {
    condition     = contains(["stub", "sagemaker"], var.inference_backend)
    error_message = "inference_backend must be 'stub' or 'sagemaker'."
  }
}

variable "postprocess_mode" {
  description = "Post-process path (lite|fargate); forwarded to the SageMaker callback so it can reconstruct the pipeline context."
  type        = string
  default     = "lite"
}

variable "instance_type" {
  description = "SageMaker async endpoint instance type. Default ml.g6e.2xlarge (L40S, 45 GB VRAM). Set ml.g5.2xlarge (A10G, 24 GB VRAM) where quota and capacity allow."
  type        = string
  default     = "ml.g6e.2xlarge"
}
