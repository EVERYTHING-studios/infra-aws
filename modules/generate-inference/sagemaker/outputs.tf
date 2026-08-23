output "endpoint_name" {
  description = "SageMaker async endpoint name."
  value       = aws_sagemaker_endpoint.this.name
}

output "endpoint_arn" {
  value = aws_sagemaker_endpoint.this.arn
}

output "dispatcher_lambda_arn" {
  description = "Dispatcher Lambda ARN — the state machine invokes this for the Inference state."
  value       = module.dispatcher.arn
}

output "dispatcher_lambda_function_name" {
  value = module.dispatcher.function_name
}

output "callback_lambda_arn" {
  description = "Callback Lambda ARN (subscribed to the SageMaker SNS topics)."
  value       = module.callback.arn
}
