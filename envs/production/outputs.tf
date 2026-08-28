output "api_url" {
  value = module.api_gateway.api_url
}

output "state_machine_arn" {
  value = module.pipeline.state_machine_arn
}

output "postprocess_ecr_url" {
  value = module.pipeline.postprocess_ecr_url
}

output "api_key_secret_name" {
  value = aws_secretsmanager_secret.api_key.name
}

output "webhook_secret_name" {
  value = aws_secretsmanager_secret.webhook_secret.name
}
