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

variable "instance_types" {
  description = "SageMaker async endpoint instance types for this region — one endpoint per type (list order = the parent's cold-price chain order; election is handled by sagemaker-control). Allowed: ml.g5.2xlarge (A10G, 24 GB, low_vram derived \"1\"), ml.g6e.2xlarge (L40S, 45 GB), ml.g7e.2xlarge (RTX PRO 6000, 96 GB)."
  type        = list(string)

  validation {
    condition = length(var.instance_types) > 0 && alltrue([
      for t in var.instance_types :
      contains(["ml.g5.2xlarge", "ml.g6e.2xlarge", "ml.g7e.2xlarge"], t)
    ])
    error_message = "instance_types must be non-empty and contain only ml.g5.2xlarge, ml.g6e.2xlarge, or ml.g7e.2xlarge."
  }
}

variable "max_capacity" {
  description = "Autoscaling max instance count per endpoint variant (min is 0; one target per instance type). The instance-type quota is account-wide per region per type: every env's maxima must sum within that region's endpoint-usage quota (g5.2xlarge L-9614C779, g6e.2xlarge L-F8D7F460, g7e.2xlarge L-5AA715AC)."
  type        = number
  default     = 2
}
