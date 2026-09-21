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

variable "sagemaker_instance_types" {
  description = "SageMaker async endpoint instance types — one endpoint per (region x type); list order = the sentinel's cold-price chain order (default: g5 -> g6e -> g7e, cheapest cold cycle first). low_vram is derived per type inside the sagemaker-region module."
  type        = list(string)
  default     = ["ml.g5.2xlarge", "ml.g6e.2xlarge", "ml.g7e.2xlarge"]

  validation {
    condition = length(var.sagemaker_instance_types) > 0 && alltrue([
      for t in var.sagemaker_instance_types :
      contains(["ml.g5.2xlarge", "ml.g6e.2xlarge", "ml.g7e.2xlarge"], t)
    ])
    error_message = "sagemaker_instance_types must be non-empty and contain only ml.g5.2xlarge, ml.g6e.2xlarge, or ml.g7e.2xlarge."
  }
}
variable "sagemaker_max_capacity" {
  description = "SageMaker endpoint autoscaling max (min 0). The instance-type quota is account-wide per region per type: every env's maxima must sum within each region's endpoint-usage quota (g5.2xlarge L-9614C779, g6e.2xlarge L-F8D7F460, g7e.2xlarge L-5AA715AC)."
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
