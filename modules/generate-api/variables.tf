variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "dist_dir" {
  description = "Path to services/generate/dist containing bundled handlers."
  type        = string
}

variable "domain_name" {
  description = "Custom domain (e.g. staging-generate.everythingstudios.ai)."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone for the domain."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate covering the domain (regional, us-east-1)."
  type        = string
}

variable "api_key_secret_arn" {
  description = "Secrets Manager secret holding the API key."
  type        = string
}

variable "tasks_table_name" {
  type = string
}

variable "tasks_table_arn" {
  type = string
}

variable "state_machine_arn" {
  description = "Pipeline state machine started by create-task."
  type        = string
}

variable "webhook_queue_url" {
  description = "Webhook queue (cancel-task notifies the web-app)."
  type        = string
}

variable "webhook_queue_arn" {
  type = string
}
