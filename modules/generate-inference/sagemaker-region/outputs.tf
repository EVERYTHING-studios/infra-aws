# Single-key map { region = {...} } so the parent can merge the per-region
# instances into one region-keyed map with merge(). `endpoints` is keyed by
# the per-type name token (g5/g6e/g7e) — one entry per instance type.
output "this" {
  description = "Per-region stack descriptor keyed by region."
  value = {
    (var.region) = {
      region             = var.region
      input_bucket       = aws_s3_bucket.sagemaker_input.bucket
      input_bucket_arn   = aws_s3_bucket.sagemaker_input.arn
      output_bucket_arn  = aws_s3_bucket.sagemaker_output.arn
      weights_bucket_arn = aws_s3_bucket.sagemaker_weights.arn
      success_topic_arn  = aws_sns_topic.success.arn
      error_topic_arn    = aws_sns_topic.error.arn
      endpoints = {
        for t in var.instance_types : local.type_token[t] => {
          name = aws_sagemaker_endpoint.this[t].name
          arn  = aws_sagemaker_endpoint.this[t].arn
        }
      }
    }
  }
}
