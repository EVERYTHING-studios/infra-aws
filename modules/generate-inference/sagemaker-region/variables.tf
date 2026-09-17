variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "env" {
  description = "Environment name (staging|production). Selects the per-env weights SSM namespace and bucket suffix."
  type        = string
}

variable "region" {
  description = "AWS region this stack deploys into (must match the mapped provider). us-east-1 keeps byte-identical legacy bucket names; alternates gain a region suffix."
  type        = string
}

variable "execution_role_arn" {
  description = "SageMaker execution role ARN (global IAM role owned by the parent module)."
  type        = string
}

variable "execution_role_policy_id" {
  description = "ID (role:name) of the execution-role policy attach in the parent module. Referenced only from the Model's tags to order Model creation after the policy attach — SageMaker validates ECR pull and model-data s3:GetObject at CreateModel time."
  type        = string
}

variable "callback_function_arn" {
  description = "Constructed ARN of the us-east-1 callback Lambda (owned by sagemaker-control). Constructed, not a module output, to break the control <-> regional reference cycle — same pattern as the pipeline state-machine ARN."
  type        = string
}

variable "bucket_names" {
  description = "S3 bucket names for this region's async input, async output, and weights stores. Owned by the parent module (single source with the execution-role policy, which must grant weights GetObject before CreateModel validates it)."
  type = object({
    input   = string
    output  = string
    weights = string
  })
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

variable "max_capacity" {
  description = "Autoscaling max instance count for the async endpoint variant (min is 0). The instance-type quota is account-wide per region: every env's maxima must sum within that region's ml.g7e.2xlarge endpoint-usage quota (L-5AA715AC)."
  type        = number
  default     = 2
}
