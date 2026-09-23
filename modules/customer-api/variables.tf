variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "dist_dir" {
  description = "Path to services/generate/dist containing bundled handlers."
  type        = string
}

variable "api_id" {
  description = "ID of the shared API Gateway (from the api-gateway module)."
  type        = string
}

variable "api_execution_arn" {
  description = "Execution ARN of the shared API Gateway."
  type        = string
}

variable "api_key_secret_arn" {
  description = "Secrets Manager secret holding the internal shared API key."
  type        = string
}

variable "tasks_table_name" {
  type = string
}

variable "tasks_table_arn" {
  type = string
}

variable "state_machine_arn" {
  description = "Pipeline state machine started by create-job."
  type        = string
}

variable "work_bucket_name" {
  type = string
}

variable "work_bucket_arn" {
  type = string
}

variable "customer_webhook_queue_url" {
  description = "Customer webhook queue (webhook-endpoint test pings)."
  type        = string
}

variable "customer_webhook_queue_arn" {
  type = string
}

variable "billing_rates_json" {
  description = "JSON map of instance type -> micro-USD per second (2x margin)."
  type        = string
}

variable "min_balance_micro_usd" {
  description = "Minimum prepay balance (micro-USD) required to start a job."
  type        = number
}
