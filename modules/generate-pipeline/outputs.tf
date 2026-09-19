output "state_machine_arn" {
  value = aws_sfn_state_machine.pipeline.arn
}

output "webhook_queue_url" {
  value = aws_sqs_queue.webhook.url
}

output "webhook_queue_arn" {
  value = aws_sqs_queue.webhook.arn
}

output "customer_webhook_queue_url" {
  value = aws_sqs_queue.customer_webhook.url
}

output "customer_webhook_queue_arn" {
  value = aws_sqs_queue.customer_webhook.arn
}

output "customer_webhook_dlq_name" {
  value = aws_sqs_queue.customer_webhook_dlq.name
}

output "webhook_dlq_name" {
  value = aws_sqs_queue.webhook_dlq.name
}

output "postprocess_ecr_url" {
  value = aws_ecr_repository.postprocess.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}
