# The generation pipeline: Step Functions orchestration, pipeline Lambdas,
# webhook delivery (SQS + dispatcher + DLQ), and the Fargate post-process
# task (Blender container).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_region" "current" {}

locals {
  container_name = "postprocess"
}

# ------------------------------------------------------------------
# Webhook delivery queue
# ------------------------------------------------------------------

resource "aws_sqs_queue" "webhook_dlq" {
  name                      = "${var.name_prefix}-webhook-dlq"
  message_retention_seconds = 14 * 24 * 60 * 60
}

resource "aws_sqs_queue" "webhook" {
  name                       = "${var.name_prefix}-webhook"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 24 * 60 * 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.webhook_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_metric_alarm" "webhook_dlq" {
  alarm_name          = "${var.name_prefix}-webhook-dlq-not-empty"
  alarm_description   = "Webhook deliveries to the web-app are failing and have hit the DLQ."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.webhook_dlq.name
  }
}

# ------------------------------------------------------------------
# Pipeline Lambdas
# ------------------------------------------------------------------

data "aws_iam_policy_document" "prepare" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }
}

module "prepare" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-prepare"
  dist_dir      = "${var.dist_dir}/prepare"
  timeout       = 120
  memory_size   = 512
  policy_json   = data.aws_iam_policy_document.prepare.json
  attach_policy = true

  environment = {
    TASKS_TABLE       = var.tasks_table_name
    WORK_BUCKET       = var.work_bucket_name
    INFERENCE_BACKEND = var.inference_backend
    POSTPROCESS_MODE  = var.postprocess_mode
  }
}

data "aws_iam_policy_document" "postprocess_lite" {
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.assets_bucket_arn}/model-assets/*"]
  }
}

module "postprocess_lite" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-postprocess-lite"
  dist_dir      = "${var.dist_dir}/postprocess-lite"
  timeout       = 120
  memory_size   = 512
  policy_json   = data.aws_iam_policy_document.postprocess_lite.json
  attach_policy = true

  environment = {
    TASKS_TABLE   = var.tasks_table_name
    WORK_BUCKET   = var.work_bucket_name
    ASSETS_BUCKET = var.assets_bucket_name
  }
}

data "aws_iam_policy_document" "finalize" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.webhook.arn]
  }

  dynamic "statement" {
    for_each = var.cloudfront_distribution_id == "" ? [] : [1]

    content {
      actions   = ["cloudfront:CreateInvalidation"]
      resources = ["arn:aws:cloudfront::${var.account_id}:distribution/${var.cloudfront_distribution_id}"]
    }
  }
}

module "finalize" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-finalize"
  dist_dir      = "${var.dist_dir}/finalize"
  timeout       = 60
  policy_json   = data.aws_iam_policy_document.finalize.json
  attach_policy = true

  environment = {
    TASKS_TABLE                = var.tasks_table_name
    WEBHOOK_QUEUE_URL          = aws_sqs_queue.webhook.url
    ASSETS_BASE_URL            = var.assets_base_url
    CLOUDFRONT_DISTRIBUTION_ID = var.cloudfront_distribution_id
  }
}

data "aws_iam_policy_document" "fail_task" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.webhook.arn]
  }
}

module "fail_task" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-fail-task"
  dist_dir      = "${var.dist_dir}/fail-task"
  timeout       = 60
  policy_json   = data.aws_iam_policy_document.fail_task.json
  attach_policy = true

  environment = {
    TASKS_TABLE       = var.tasks_table_name
    WEBHOOK_QUEUE_URL = aws_sqs_queue.webhook.url
  }
}

data "aws_iam_policy_document" "webhook_dispatch" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.webhook_secret_arn]
  }

  statement {
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.webhook.arn]
  }
}

module "webhook_dispatch" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-webhook-dispatch"
  dist_dir      = "${var.dist_dir}/webhook-dispatch"
  timeout       = 30
  policy_json   = data.aws_iam_policy_document.webhook_dispatch.json
  attach_policy = true

  environment = {
    WEBHOOK_URL        = var.webhook_url
    WEBHOOK_SECRET_ARN = var.webhook_secret_arn
  }
}

resource "aws_lambda_event_source_mapping" "webhook" {
  event_source_arn        = aws_sqs_queue.webhook.arn
  function_name           = module.webhook_dispatch.function_name
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

# ------------------------------------------------------------------
# Fargate post-process (Blender container)
# ------------------------------------------------------------------

resource "aws_ecr_repository" "postprocess" {
  name                 = "${var.name_prefix}-postprocess"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name_prefix
}

resource "aws_cloudwatch_log_group" "postprocess" {
  name              = "/ecs/${var.name_prefix}-postprocess"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "postprocess_execution" {
  name               = "${var.name_prefix}-postprocess-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "postprocess_execution" {
  role       = aws_iam_role.postprocess_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "postprocess_task" {
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.assets_bucket_arn}/model-assets/*"]
  }
}

resource "aws_iam_role" "postprocess_task" {
  name               = "${var.name_prefix}-postprocess-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "postprocess_task" {
  name   = "permissions"
  role   = aws_iam_role.postprocess_task.id
  policy = data.aws_iam_policy_document.postprocess_task.json
}

resource "aws_ecs_task_definition" "postprocess" {
  family                   = "${var.name_prefix}-postprocess"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.postprocess_cpu
  memory                   = var.postprocess_memory
  execution_role_arn       = aws_iam_role.postprocess_execution.arn
  task_role_arn            = aws_iam_role.postprocess_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.container_name
      image     = "${aws_ecr_repository.postprocess.repository_url}:${var.postprocess_image_tag}"
      essential = true
      environment = [
        { name = "TASKS_TABLE", value = var.tasks_table_name },
        { name = "WORK_BUCKET", value = var.work_bucket_name },
        { name = "ASSETS_BUCKET", value = var.assets_bucket_name },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.postprocess.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "postprocess"
        }
      }
    }
  ])
}

resource "aws_security_group" "postprocess" {
  name        = "${var.name_prefix}-postprocess"
  description = "Egress-only for the post-process Fargate task"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ------------------------------------------------------------------
# State machine
# ------------------------------------------------------------------

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      module.prepare.arn,
      var.inference_lambda_arn,
      module.postprocess_lite.arn,
      module.finalize.arn,
      module.fail_task.arn,
    ]
  }

  statement {
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.postprocess.arn_without_revision, aws_ecs_task_definition.postprocess.arn]
  }

  statement {
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["*"]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.postprocess_execution.arn, aws_iam_role.postprocess_task.arn]
  }

  # Managed EventBridge rule Step Functions uses for ecs:runTask.sync.
  statement {
    actions = [
      "events:PutTargets",
      "events:PutRule",
      "events:DescribeRule",
    ]
    resources = ["arn:aws:events:${data.aws_region.current.name}:${var.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.name_prefix}-pipeline-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "sfn" {
  name   = "permissions"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

resource "aws_sfn_state_machine" "pipeline" {
  name     = "${var.name_prefix}-pipeline"
  role_arn = aws_iam_role.sfn.arn

  definition = templatefile(
    var.inference_backend == "sagemaker"
    ? "${path.module}/state-machine-sagemaker.asl.json.tftpl"
    : "${path.module}/state-machine.asl.json.tftpl",
    {
      prepare_arn          = module.prepare.arn
      inference_arn        = var.inference_lambda_arn
      postprocess_lite_arn = module.postprocess_lite.arn
      finalize_arn         = module.finalize.arn
      fail_task_arn        = module.fail_task.arn
      cluster_arn          = aws_ecs_cluster.this.arn
      task_definition_arn  = aws_ecs_task_definition.postprocess.arn
      container_name       = local.container_name
      subnets_json         = jsonencode(var.subnet_ids)
      security_group_id    = aws_security_group.postprocess.id
    }
  )
}
