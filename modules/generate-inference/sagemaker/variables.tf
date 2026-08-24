variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "env" {
  description = "Environment name (staging|production). Selects the per-env weights SSM namespace."
  type        = string
}

variable "execution_role_arn" {
  description = "SageMaker execution role ARN (created in phase 1)."
  type        = string
}

variable "work_bucket_name" {
  description = "Internal work bucket holding staged inputs and the raw GLB output location."
  type        = string
}

variable "work_bucket_arn" {
  type = string
}

variable "input_bucket_name" {
  description = "SageMaker async input bucket (InputLocation target)."
  type        = string
}

variable "input_bucket_arn" {
  type = string
}

variable "output_bucket_name" {
  description = "SageMaker async output bucket (S3OutputPath; callback reads the GLB here)."
  type        = string
}

variable "output_bucket_arn" {
  type = string
}

variable "tasks_table_name" {
  type = string
}

variable "tasks_table_arn" {
  type = string
}

variable "dist_dir" {
  description = "Path to services/generate/dist containing bundled handlers."
  type        = string
}

variable "state_machine_arn" {
  description = "Pipeline state-machine ARN, scoped as the SendTaskSuccess/Failure IAM resource. Constructed by the parent module to avoid a dependency cycle with the pipeline module."
  type        = string
}

variable "postprocess_mode" {
  description = "Post-process path (lite|fargate); passed to the callback so it can reconstruct the pipeline context for SendTaskSuccess."
  type        = string
  default     = "lite"
}

variable "instance_type" {
  description = "SageMaker async endpoint instance type. Default ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM, 1597 GB/s). g6e.2xlarge (L40S, 45 GB) is the fallback; g5.2xlarge (A10G, 24 GB) requires low_vram=\"1\"."
  type        = string
  default     = "ml.g7e.2xlarge"
}

variable "low_vram" {
  description = "TRELLIS2_LOW_VRAM env: \"0\" (default) loads all ~17 GB models to GPU once at startup (requires >=45 GB VRAM: g6e/g7e). \"1\" keeps models on CPU and swaps per-stage (safe on g5 24 GB)."
  type        = string
  default     = "0"
}
