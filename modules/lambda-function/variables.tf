variable "function_name" {
  description = "Lambda function name (also names the role and log group)."
  type        = string
}

variable "dist_dir" {
  description = "Directory containing the bundled handler (index.mjs and any fixtures)."
  type        = string
}

variable "environment" {
  description = "Environment variables for the function."
  type        = map(string)
  default     = {}
}

variable "policy_json" {
  description = "Optional inline IAM policy JSON granting the function's permissions."
  type        = string
  default     = null
}

variable "timeout" {
  description = "Function timeout in seconds."
  type        = number
  default     = 30
}

variable "memory_size" {
  description = "Function memory in MB."
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}
