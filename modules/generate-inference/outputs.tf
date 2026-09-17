output "inference_lambda_arn" {
  description = "ARN of the Lambda the state machine invokes for the Inference state. Stub Lambda, or the SageMaker dispatcher when inference_backend = sagemaker."
  # `one(splat)` yields null when the sagemaker_control module has count=0
  # without raising an out-of-range index, so both ternary branches stay valid.
  value = var.inference_backend == "sagemaker" ? one(module.sagemaker_control[*].dispatcher_lambda_arn) : module.stub.arn
}

output "inference_lambda_function_name" {
  value = var.inference_backend == "sagemaker" ? one(module.sagemaker_control[*].dispatcher_lambda_function_name) : module.stub.function_name
}

output "sagemaker_execution_role_arn" {
  description = "SageMaker execution role ARN (assumed by the Model in every candidate region)."
  value       = aws_iam_role.sagemaker_execution.arn
}
