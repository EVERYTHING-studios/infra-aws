output "inference_lambda_arn" {
  description = "ARN of the Lambda the state machine invokes for the Inference state."
  value       = module.stub.arn
}

output "inference_lambda_function_name" {
  value = module.stub.function_name
}
