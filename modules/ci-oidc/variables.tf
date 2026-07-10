variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to assume the CI roles."
  type        = string
}

variable "state_bucket_arn" {
  description = "ARN of the Terraform state bucket both roles need access to."
  type        = string
}
