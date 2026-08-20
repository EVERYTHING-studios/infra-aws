output "api_endpoint" {
  description = "Raw API Gateway endpoint (custom domain preferred)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "api_url" {
  description = "Public base URL of the generate API."
  value       = "https://${var.domain_name}"
}
