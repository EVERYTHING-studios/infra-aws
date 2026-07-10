variable "aws_region" {
  description = "Region for the state bucket and CI roles."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform state for all environments."
  type        = string
  default     = "everything-infra-tfstate-095256591532"
}

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to assume the CI roles via OIDC."
  type        = string
  default     = "EVERYTHING-studios/infra-aws"
}
