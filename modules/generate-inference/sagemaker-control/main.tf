# Control plane for the multi-region, multi-instance-type SageMaker inference
# backend. Instantiated ONCE (us-east-1, default provider) by the parent
# module when inference_backend = "sagemaker". Owns:
#
#   - the dispatcher / callback / scaler Lambdas (same function names as the
#     pre-refactor sagemaker/ submodule),
#   - the capacity-sentinel Lambda (endpoint election + stranded-task rescue),
#   - the EventBridge rate(1 minute) rule targeting scaler + sentinel,
#   - per-topic SNS invoke permissions for the callback Lambda, one pair per
#     candidate region,
#   - the `active_endpoint` / `last_flip` SSM parameters the sentinel mutates
#     at runtime (value changes are ignored here).
#
# The regional stacks (buckets, per-type Models/Endpoints, topics,
# autoscaling) live in the sibling `sagemaker-region/` module, one instance
# per candidate region. This module receives the (region x type) endpoint
# list — `endpoints`, in the sentinel's type-major chain-priority order — so
# all IAM policies and Lambda env wiring here cover every chain endpoint.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

locals {
  # Ordered endpoint entries for the handlers' SAGEMAKER_ENDPOINTS env.
  # Array order = the sentinel's election priority (parent's type-major
  # chain order). A JSON array, not an object — object keys serialize in
  # lexicographic order, which would destroy the chain ordering.
  endpoints_json = jsonencode([
    for e in var.endpoints : {
      region       = e.region
      instanceType = e.token
      endpointName = e.endpoint_name
      inputBucket  = e.input_bucket
    }
  ])

  # Region-shared view of the endpoint list (buckets + topic ARNs are
  # identical for every endpoint in a region, so last-wins is safe). Keyed
  # for for_each over regions.
  regions_by_name = { for e in var.endpoints : e.region => e }
}

# ------------------------------------------------------------------
# Election SSM parameters. The sentinel flips active_endpoint (the elected
# endpoint's NAME — unique per region x type) on capacity evidence and
# stamps last_flip; Terraform only owns their creation.
# ------------------------------------------------------------------

resource "aws_ssm_parameter" "active_endpoint" {
  name        = "/generate/${var.env}/sagemaker/active_endpoint"
  description = "SageMaker endpoint name currently receiving dispatches; flipped at runtime by the capacity-sentinel Lambda."
  type        = "String"
  # Initial value: the chain head (first entry of var.endpoints). The
  # sentinel overwrites this at runtime — value changes are deliberately
  # ignored below.
  value = var.endpoints[0].endpoint_name

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "last_flip" {
  name        = "/generate/${var.env}/sagemaker/last_flip"
  description = "ISO timestamp of the sentinel's last active_endpoint flip; drives the flip cooldown."
  type        = "String"
  # Epoch so the first flip is never blocked by the cooldown.
  value = "1970-01-01T00:00:00.000Z"

  lifecycle {
    ignore_changes = [value]
  }
}

# ------------------------------------------------------------------
# Dispatcher Lambda: invoked by the state machine's
# lambda:invoke.waitForTaskToken Inference state. Reads active_endpoint from
# SSM, stages the input image into the elected endpoint's regional input
# bucket, calls InvokeEndpointAsync (InferenceId = task_id), and stores the
# Step Functions task token + target region on the task record.
# ------------------------------------------------------------------

data "aws_iam_policy_document" "dispatcher" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = toset([for e in var.endpoints : "${e.input_bucket_arn}/*"])
  }

  statement {
    actions   = ["sagemaker:InvokeEndpointAsync"]
    resources = [for e in var.endpoints : e.endpoint_arn]
  }

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.active_endpoint.arn, aws_ssm_parameter.last_flip.arn]
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
    TASKS_TABLE           = var.tasks_table_name
    WORK_BUCKET           = var.work_bucket_name
    SAGEMAKER_ENDPOINTS   = local.endpoints_json
    ACTIVE_ENDPOINT_PARAM = aws_ssm_parameter.active_endpoint.name
  }
}

# ------------------------------------------------------------------
# Callback Lambda: subscribed to every region's success/error SNS topics.
# On success it reads the GLB from that region's output bucket (region
# parsed from EventSubscriptionArn), copies it to the pipeline contract
# location in the work bucket, then calls SendTaskSuccess. On error it
# calls SendTaskFailure. Consumed-token errors are logged no-ops (late
# duplicate callbacks after a sentinel re-dispatch).
# ------------------------------------------------------------------

data "aws_iam_policy_document" "callback" {
  statement {
    actions   = ["s3:GetObject"]
    resources = toset([for e in var.endpoints : "${e.output_bucket_arn}/*"])
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

module "callback" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-callback"
  dist_dir      = "${var.dist_dir}/inference-sagemaker-callback"
  timeout       = 120
  memory_size   = 512
  policy_json   = data.aws_iam_policy_document.callback.json
  attach_policy = true

  environment = {
    TASKS_TABLE      = var.tasks_table_name
    WORK_BUCKET      = var.work_bucket_name
    POSTPROCESS_MODE = var.postprocess_mode
  }
}

# ------------------------------------------------------------------
# Scaler Lambda: publishes EndpointIdle for EVERY configured region each
# run (0 if that region has IN_PROGRESS token-bearing tasks, else 1) so
# each region's scale-to-zero alarm stays fed and abandoned regions drain
# after a flip.
# ------------------------------------------------------------------

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

module "endpoint_scaler" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-scaler"
  dist_dir      = "${var.dist_dir}/endpoint-scaler"
  timeout       = 30
  memory_size   = 128
  policy_json   = data.aws_iam_policy_document.scaler.json
  attach_policy = true

  environment = {
    TASKS_TABLE         = var.tasks_table_name
    SAGEMAKER_ENDPOINTS = local.endpoints_json
  }
}

# ------------------------------------------------------------------
# Capacity-sentinel Lambda: classifies every configured endpoint from
# DescribeEndpoint + DescribeScalingActivities evidence, flips
# active_endpoint per the election rules (with cooldown), and re-dispatches
# stranded tasks to the active endpoint.
# ------------------------------------------------------------------

data "aws_iam_policy_document" "sentinel" {
  statement {
    actions   = ["sagemaker:DescribeEndpoint"]
    resources = [for e in var.endpoints : e.endpoint_arn]
  }

  statement {
    # Read-only; the action does not support useful resource scoping.
    actions   = ["application-autoscaling:DescribeScalingActivities"]
    resources = ["*"]
  }

  statement {
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [aws_ssm_parameter.active_endpoint.arn, aws_ssm_parameter.last_flip.arn]
  }

  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${var.tasks_table_arn}/index/gsi2"]
  }

  statement {
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  # Re-dispatching stranded tasks = the same copy + invoke as the dispatcher.
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = toset([for e in var.endpoints : "${e.input_bucket_arn}/*"])
  }

  statement {
    actions   = ["sagemaker:InvokeEndpointAsync"]
    resources = [for e in var.endpoints : e.endpoint_arn]
  }
}

module "capacity_sentinel" {
  source = "../../lambda-function"

  function_name = "${var.name_prefix}-inference-sagemaker-sentinel"
  dist_dir      = "${var.dist_dir}/capacity-sentinel"
  timeout       = 60
  memory_size   = 256
  policy_json   = data.aws_iam_policy_document.sentinel.json
  attach_policy = true

  environment = {
    TASKS_TABLE           = var.tasks_table_name
    WORK_BUCKET           = var.work_bucket_name
    SAGEMAKER_ENDPOINTS   = local.endpoints_json
    ACTIVE_ENDPOINT_PARAM = aws_ssm_parameter.active_endpoint.name
    LAST_FLIP_PARAM       = aws_ssm_parameter.last_flip.name
    FLIP_COOLDOWN_SECONDS = "300"
  }
}

# ------------------------------------------------------------------
# EventBridge: one rate(1 minute) rule, two targets (scaler + sentinel).
# ------------------------------------------------------------------

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

resource "aws_cloudwatch_event_target" "sentinel" {
  rule      = aws_cloudwatch_event_rule.scaler.name
  target_id = "capacity-sentinel"
  arn       = module.capacity_sentinel.arn
}

resource "aws_lambda_permission" "eventbridge_scaler" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scaler.arn
  function_name = module.endpoint_scaler.function_name
}

resource "aws_lambda_permission" "eventbridge_sentinel" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scaler.arn
  function_name = module.capacity_sentinel.function_name
}

# ------------------------------------------------------------------
# SNS -> callback Lambda permissions, one pair per candidate region's
# success/error topics (cross-region SNS -> Lambda delivery is supported;
# the permission lives in the Lambda's region, the source_arn is the
# regional topic).
# ------------------------------------------------------------------

resource "aws_lambda_permission" "sns_success" {
  # for_each over the STATIC region set derived from the endpoint list:
  # var.endpoints values are known only after apply while a regional stack is
  # being created, which Terraform rejects as a for_each key source.
  for_each = toset(keys(local.regions_by_name))

  statement_id  = "AllowSNSSuccessInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  principal     = "sns.amazonaws.com"
  source_arn    = local.regions_by_name[each.key].success_topic_arn
  function_name = module.callback.function_name
}

resource "aws_lambda_permission" "sns_error" {
  for_each = toset(keys(local.regions_by_name))

  statement_id  = "AllowSNSErrorInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  principal     = "sns.amazonaws.com"
  source_arn    = local.regions_by_name[each.key].error_topic_arn
  function_name = module.callback.function_name
}
