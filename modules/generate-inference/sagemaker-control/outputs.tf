output "dispatcher_lambda_arn" {
  description = "Dispatcher Lambda ARN — the state machine invokes this for the Inference state."
  value       = module.dispatcher.arn
}

output "dispatcher_lambda_function_name" {
  value = module.dispatcher.function_name
}

output "callback_lambda_arn" {
  description = "Callback Lambda ARN (subscribed to every region's SageMaker SNS topics)."
  value       = module.callback.arn
}

output "active_region_param_name" {
  description = "SSM parameter holding the currently active SageMaker region (mutated by the sentinel at runtime)."
  value       = aws_ssm_parameter.active_region.name
}
