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
