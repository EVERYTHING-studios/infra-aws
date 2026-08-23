# SageMaker async-inference backend. Created only when the parent module's
# `inference_backend = "sagemaker"` (count-gated there). Owns the Model,
# EndpointConfig, Endpoint, SNS topics, dispatcher/callback Lambdas, and the
# scale-to-zero autoscaling policy. Reads the ECR image URI and weights S3 URI
# from SSM (written by push_image.sh and package_weights.sh respectively).
#
# Cycle note: the callback Lambda scopes `states:SendTaskSuccess/Failure` to the
# pipeline state-machine ARN. The parent module constructs that ARN from
# `name_prefix` (the state machine is named `${name_prefix}-pipeline`) and passes
# it in as `state_machine_arn` — the pipeline module in turn needs the dispatcher
# ARN, so the ARN cannot flow from the pipeline module without a Terraform
# dependency cycle. The constructed ARN matches the pipeline module's naming.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  variant_name = "trellis"
}

# ------------------------------------------------------------------
# SSM inputs (written out-of-band): ECR image URI and weights model.tar.gz URI.
# weights_s3_uri is per-env: /trellis2image/{env}/weights/s3_uri (B1 decision 7).
# ------------------------------------------------------------------

data "aws_ssm_parameter" "image_uri" {
  name = "/trellis2image/ecr/image_uri"
}

data "aws_ssm_parameter" "weights_s3_uri" {
  name = "/trellis2image/${var.env}/weights/s3_uri"
}

# ------------------------------------------------------------------
# Model + EndpointConfig + Endpoint.
#
# A random suffix on the EndpointConfig name lets image/weights changes roll
# forward via a new config (blue/green endpoint update) instead of a recreate
# that would conflict with the live Endpoint. `keepers` tie the suffix to the
# image and weights values from SSM.
# ------------------------------------------------------------------

resource "random_id" "endpoint_config" {
  byte_length = 4

  keepers = {
    image   = data.aws_ssm_parameter.image_uri.value
    weights = data.aws_ssm_parameter.weights_s3_uri.value
    # Rotate the endpoint config (blue/green update) when the model environment
    # changes — SageMaker Models are immutable, so a new Model alone does NOT
    # update the running Endpoint; a new EndpointConfig + Endpoint update does.
    environment   = jsonencode(aws_sagemaker_model.this.primary_container[0].environment)
    instance_type = var.instance_type
  }
}

resource "aws_sagemaker_model" "this" {
  name               = "${var.name_prefix}-sagemaker-model"
  execution_role_arn = var.execution_role_arn

  primary_container {
    image = data.aws_ssm_parameter.image_uri.value

    # Use ModelDataSource (not ModelDataUrl) so SageMaker uses the large-artifact
    # download path. ModelDataUrl has a ~5 GB extraction limit; the packaged
    # weights tar.gz is ~13 GB. ModelDataSource.S3DataSource with
    # CompressionType=Gzip handles arbitrarily large tar.gz archives.
    model_data_source {
      s3_data_source {
        s3_uri           = data.aws_ssm_parameter.weights_s3_uri.value
        s3_data_type     = "S3Object"
        compression_type = "Gzip"
      }
    }

    environment = {
      HF_HOME        = "/opt/ml/model"
      HF_HUB_OFFLINE = "1"
    }
  }
}

resource "aws_sagemaker_endpoint_configuration" "this" {
  name = "${var.name_prefix}-sagemaker-${random_id.endpoint_config.hex}"

  production_variants {
    variant_name           = local.variant_name
    model_name             = aws_sagemaker_model.this.name
    instance_type          = var.instance_type
    initial_instance_count = 1
    initial_variant_weight = 1
    # The packaged weights (~16 GB) take time to download at provisioning.
    model_data_download_timeout_in_seconds = 3600
    # The model loads ~14 GB of weights into GPU memory at container startup
    # (module import); allow 10 min before SageMaker's /ping health check fails.
    container_startup_health_check_timeout_in_seconds = 600
  }

  async_inference_config {
    client_config {
      max_concurrent_invocations_per_instance = 1
    }

    output_config {
      s3_output_path = "s3://${var.output_bucket_name}/"

      notification_config {
        success_topic = aws_sns_topic.success.arn
        error_topic   = aws_sns_topic.error.arn
      }
    }
  }

  # create_before_destroy so the new config exists before the endpoint
  # switches to it and the old one is deleted — avoids the race where
  # UpdateEndpoint fails because the current config was already destroyed.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sagemaker_endpoint" "this" {
  name                 = "${var.name_prefix}-sagemaker"
  endpoint_config_name = aws_sagemaker_endpoint_configuration.this.name
}

# ------------------------------------------------------------------
# SNS topics for async notifications. The callback Lambda is subscribed to
# both; it dispatches on the message's invocationStatus.
# ------------------------------------------------------------------

resource "aws_sns_topic" "success" {
  name = "${var.name_prefix}-sagemaker-success"
}

resource "aws_sns_topic" "error" {
  name = "${var.name_prefix}-sagemaker-error"
}

# ------------------------------------------------------------------
# Dispatcher Lambda: invoked by the state machine's
# lambda:invoke.waitForTaskToken Inference state. Copies the staged input image
# to the SageMaker input bucket, calls InvokeEndpointAsync (InferenceId =
# task_id so the callback recovers the task), stores the Step Functions task
# token on the task record, and returns immediately. The task token is too long
# for SageMaker's InferenceId (<=128 chars), so it is persisted in DynamoDB and
# recovered by the callback via getTask(task_id).
# ------------------------------------------------------------------

data "aws_iam_policy_document" "dispatcher" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.input_bucket_arn}/*"]
  }

  statement {
    actions   = ["sagemaker:InvokeEndpointAsync"]
    resources = [aws_sagemaker_endpoint.this.arn]
  }

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }
}

module "dispatcher" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-dispatch"
  dist_dir      = "${var.dist_dir}/inference-sagemaker-dispatch"
  timeout       = 60
  memory_size   = 256
  policy_json   = data.aws_iam_policy_document.dispatcher.json
  attach_policy = true

  environment = {
    TASKS_TABLE             = var.tasks_table_name
    WORK_BUCKET             = var.work_bucket_name
    SAGEMAKER_ENDPOINT_NAME = aws_sagemaker_endpoint.this.name
    SAGEMAKER_INPUT_BUCKET  = var.input_bucket_name
  }
}

# ------------------------------------------------------------------
# Callback Lambda: subscribed to the success/error SNS topics. On success it
# reads the GLB from the SageMaker output bucket, copies it to the pipeline
# contract location (tasks/{task_id}/raw/model.glb in the work bucket), then
# calls SendTaskSuccess with the pipeline context so the state machine resumes
# at ChoosePostProcess. On error it calls SendTaskFailure.
# ------------------------------------------------------------------

data "aws_iam_policy_document" "callback" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.output_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["states:SendTaskSuccess", "states:SendTaskFailure"]
    resources = [var.state_machine_arn]
  }
}

data "aws_iam_policy_document" "scaler" {
  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${var.tasks_table_arn}/index/gsi2"]
  }

  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
  }
}

module "callback" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-callback"
  dist_dir      = "${var.dist_dir}/inference-sagemaker-callback"
  timeout       = 120
  memory_size   = 512
  policy_json   = data.aws_iam_policy_document.callback.json
  attach_policy = true

  environment = {
    TASKS_TABLE             = var.tasks_table_name
    WORK_BUCKET             = var.work_bucket_name
    SAGEMAKER_OUTPUT_BUCKET = var.output_bucket_name
    POSTPROCESS_MODE        = var.postprocess_mode
  }
}

module "endpoint_scaler" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-scaler"
  dist_dir      = "${var.dist_dir}/endpoint-scaler"
  timeout       = 30
  memory_size   = 128
  policy_json   = data.aws_iam_policy_document.scaler.json
  attach_policy = true

  environment = {
    TASKS_TABLE   = var.tasks_table_name
    ENDPOINT_NAME = aws_sagemaker_endpoint.this.name
  }
}

resource "aws_cloudwatch_event_rule" "scaler" {
  name                = "${var.name_prefix}-sagemaker-scaler"
  schedule_expression = "rate(1 minute)"
  state               = "ENABLED"
}

resource "aws_cloudwatch_event_target" "scaler" {
  rule      = aws_cloudwatch_event_rule.scaler.name
  target_id = "endpoint-scaler"
  arn       = module.endpoint_scaler.arn
}

resource "aws_lambda_permission" "eventbridge_scaler" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scaler.arn
  function_name = module.endpoint_scaler.function_name
}

resource "aws_sns_topic_subscription" "success" {
  topic_arn = aws_sns_topic.success.arn
  protocol  = "lambda"
  endpoint  = module.callback.arn
}

resource "aws_sns_topic_subscription" "error" {
  topic_arn = aws_sns_topic.error.arn
  protocol  = "lambda"
  endpoint  = module.callback.arn
}

resource "aws_lambda_permission" "sns_success" {
  statement_id  = "AllowSNSSuccessInvoke"
  action        = "lambda:InvokeFunction"
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.success.arn
  function_name = module.callback.function_name
}

resource "aws_lambda_permission" "sns_error" {
  statement_id  = "AllowSNSErrorInvoke"
  action        = "lambda:InvokeFunction"
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.error.arn
  function_name = module.callback.function_name
}

# ------------------------------------------------------------------
# Autoscaling: scale-to-zero (min 0, max 2). HasBacklogWithoutCapacity scales
# up from zero (target tracking can't, with zero instances there are no
# invocations-per-instance to track). Target tracking on
# InvocationsPerInstance scales down to min when idle.
# ------------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "sagemaker"
  resource_id        = "endpoint/${aws_sagemaker_endpoint.this.name}/variant/${local.variant_name}"
  scalable_dimension = "sagemaker:variant:DesiredInstanceCount"

  min_capacity = 0
  max_capacity = 2
}

# Scale-up from zero on backlog.
resource "aws_appautoscaling_policy" "scale_up" {
  name               = "${var.name_prefix}-sagemaker-scale-up"
  resource_id        = aws_appautoscaling_target.this.resource_id
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 300

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "backlog" {
  alarm_name          = "${var.name_prefix}-sagemaker-backlog"
  alarm_description   = "Scale up the SageMaker async endpoint when requests are queued with no capacity."
  namespace           = "AWS/SageMaker"
  metric_name         = "HasBacklogWithoutCapacity"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  # HasBacklogWithoutCapacity reports with EndpointName only (no VariantName).
  dimensions = {
    EndpointName = aws_sagemaker_endpoint.this.name
  }

  alarm_actions = [aws_appautoscaling_policy.scale_up.arn]
}

# Scale-in to zero when there is no backlog. Target tracking on
# InvocationsPerInstance does NOT work for async endpoints because the metric
# is absent (not zero) when idle, so the policy never fires. Step scaling on
# HasBacklogWithoutCapacity (the same metric used for scale-up) is the
# reliable pattern for async scale-to-zero.
resource "aws_appautoscaling_policy" "scale_down" {
  name               = "${var.name_prefix}-sagemaker-scale-down"
  resource_id        = aws_appautoscaling_target.this.resource_id
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 180

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "scale_to_zero" {
  alarm_name          = "${var.name_prefix}-sagemaker-scale-to-zero"
  alarm_description   = "Scale the SageMaker async endpoint to zero when idle (no active invocations for 3 minutes). Replaces the broken HasBacklogWithoutCapacity alarm that fired mid-inference."
  namespace           = "EverythingStudios/SageMaker"
  metric_name         = "EndpointIdle"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # If the scaler Lambda stops publishing, scale down as a safety measure
  # rather than keeping the instance alive forever.
  treat_missing_data = "breaching"

  dimensions = {
    EndpointName = aws_sagemaker_endpoint.this.name
  }

  alarm_actions = [aws_appautoscaling_policy.scale_down.arn]
}
