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

variable "attach_policy" {
  description = "Whether to create the inline IAM policy. Must be a static true/false from the caller, not derived from policy_json's content — policy_json's value can be unknown at plan time on first apply (e.g. when it references a resource created in the same plan), which would make a count/for_each based on that value fail."
  type        = bool
  default     = false
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
