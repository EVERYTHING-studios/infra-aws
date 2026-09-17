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
  description = "SageMaker async endpoint instance type. Default ml.g7e.2xlarge (Blackwell RTX PRO 6000, 96 GB VRAM, 1597 GB/s). g6e.2xlarge (L40S, 45 GB) is the fallback; g5.2xlarge (A10G, 24 GB) requires low_vram=\"1\"."
  type        = string
  default     = "ml.g7e.2xlarge"
}

variable "low_vram" {
  description = "TRELLIS2_LOW_VRAM env forwarded to the SageMaker container: \"0\" (default) loads all models to GPU once (requires >=45 GB VRAM); \"1\" keeps models on CPU per-stage (safe on g5 24 GB)."
  type        = string
  default     = "0"
}

variable "sagemaker_max_capacity" {
  description = "SageMaker endpoint autoscaling max (min 0). Account-wide instance-type quota is shared across envs: staging + production maxima must sum within the ml.g7e.2xlarge endpoint-usage quota (L-5AA715AC)."
  type        = number
  default     = 2
}

variable "sagemaker_candidate_regions" {
  description = "Regions with a full SageMaker stack. SageMaker offers ml.g7e.2xlarge only in us-east-1/us-east-2/us-west-2; quota L-5AA715AC must be >= 1 before a region is appended. Order = sentinel failback priority."
  type        = list(string)
  default     = ["us-east-1"]

  validation {
    condition     = alltrue([for r in var.sagemaker_candidate_regions : contains(["us-east-1", "us-east-2", "us-west-2"], r)])
    error_message = "sagemaker_candidate_regions may only contain us-east-1, us-east-2, us-west-2 (the only regions offering ml.g7e.2xlarge)."
  }
}
