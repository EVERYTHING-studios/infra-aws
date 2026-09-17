# Single-key map { region = {...} } so the parent can merge the per-region
# instances into one region-keyed map with merge().
output "this" {
  description = "Per-region stack descriptor keyed by region."
  value = {
    (var.region) = {
      region             = var.region
      endpoint_name      = aws_sagemaker_endpoint.this.name
      endpoint_arn       = aws_sagemaker_endpoint.this.arn
      input_bucket       = aws_s3_bucket.sagemaker_input.bucket
      input_bucket_arn   = aws_s3_bucket.sagemaker_input.arn
      output_bucket_arn  = aws_s3_bucket.sagemaker_output.arn
      weights_bucket_arn = aws_s3_bucket.sagemaker_weights.arn
      success_topic_arn  = aws_sns_topic.success.arn
      error_topic_arn    = aws_sns_topic.error.arn
    }
  }
}
