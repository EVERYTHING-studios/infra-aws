variable "table_name" {
  description = "DynamoDB table name (e.g. generate-tasks-staging)."
  type        = string
}

variable "point_in_time_recovery" {
  description = "Enable PITR (recommended for production)."
  type        = bool
  default     = false
}
