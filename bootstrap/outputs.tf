output "state_bucket" {
  description = "Terraform state bucket name."
  value       = aws_s3_bucket.tfstate.bucket
}

output "plan_role_arn" {
  description = "Set as the AWS_PLAN_ROLE_ARN GitHub repository variable."
  value       = module.ci_oidc.plan_role_arn
}
