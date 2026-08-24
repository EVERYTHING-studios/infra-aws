# Public HTTP API for the generate service: custom domain, Lambda authorizer
# (x-api-key against Secrets Manager), and the task CRUD handlers.

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
  # arn:aws:states:<region>:<account>:stateMachine:<name> -> execution arn prefix
  execution_arn_prefix = replace(var.state_machine_arn, ":stateMachine:", ":execution:")
}

# ------------------------------------------------------------------
# Handlers
# ------------------------------------------------------------------

data "aws_iam_policy_document" "authorizer" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.api_key_secret_arn]
  }
}

module "authorizer" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-authorizer"
  dist_dir      = "${var.dist_dir}/authorizer"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.authorizer.json
  attach_policy = true

  environment = {
    API_KEY_SECRET_ARN = var.api_key_secret_arn
  }
}

data "aws_iam_policy_document" "create_task" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${var.tasks_table_arn}/index/*"]
  }

  statement {
    actions   = ["states:StartExecution"]
    resources = [var.state_machine_arn]
  }
}

module "create_task" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-create-task"
  dist_dir      = "${var.dist_dir}/create-task"
  timeout       = 30
  policy_json   = data.aws_iam_policy_document.create_task.json
  attach_policy = true

  environment = {
    TASKS_TABLE       = var.tasks_table_name
    STATE_MACHINE_ARN = var.state_machine_arn
  }
}

data "aws_iam_policy_document" "get_task" {
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [var.tasks_table_arn]
  }
}

module "get_task" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-get-task"
  dist_dir      = "${var.dist_dir}/get-task"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.get_task.json
  attach_policy = true

  environment = {
    TASKS_TABLE = var.tasks_table_name
  }
}

data "aws_iam_policy_document" "cancel_task" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["states:StopExecution"]
    resources = ["${local.execution_arn_prefix}:*"]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.webhook_queue_arn]
  }
}

module "cancel_task" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-cancel-task"
  dist_dir      = "${var.dist_dir}/cancel-task"
  timeout       = 30
  policy_json   = data.aws_iam_policy_document.cancel_task.json
  attach_policy = true

  environment = {
    TASKS_TABLE       = var.tasks_table_name
    WEBHOOK_QUEUE_URL = var.webhook_queue_url
  }
}

module "health" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-health"
  dist_dir      = "${var.dist_dir}/health"
  timeout       = 5
  memory_size   = 128
}

# ------------------------------------------------------------------
# HTTP API
# ------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = var.name_prefix
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_apigatewayv2_authorizer" "api_key" {
  api_id                            = aws_apigatewayv2_api.this.id
  name                              = "api-key"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = module.authorizer.invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.x-api-key"]
  authorizer_result_ttl_in_seconds  = 300
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowApiGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.api_key.id}"
}

locals {
  routes = {
    "POST /v1/tasks" = {
      lambda     = module.create_task
      authorized = true
    }
    "GET /v1/tasks/{id}" = {
      lambda     = module.get_task
      authorized = true
    }
    "POST /v1/tasks/{id}/cancel" = {
      lambda     = module.cancel_task
      authorized = true
    }
    "GET /v1/health" = {
      lambda     = module.health
      authorized = false
    }
  }
}

resource "aws_apigatewayv2_integration" "routes" {
  for_each = local.routes

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.lambda.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.routes[each.key].id}"
  authorization_type = each.value.authorized ? "CUSTOM" : "NONE"
  authorizer_id      = each.value.authorized ? aws_apigatewayv2_authorizer.api_key.id : null
}

resource "aws_lambda_permission" "routes" {
  for_each = local.routes

  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = each.value.lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# ------------------------------------------------------------------
# Custom domain
# ------------------------------------------------------------------

resource "aws_apigatewayv2_domain_name" "this" {
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "this" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
