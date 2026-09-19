# Customer API: per-user API keys (accounts DynamoDB table, hashed at rest),
# request authorizers (customer per-user keys + internal shared key), and the
# management/jobs route handlers. Routes attach to the shared api-gateway
# module's HTTP API, same as generate-api.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# ------------------------------------------------------------------
# Accounts & API keys store
# ------------------------------------------------------------------

resource "aws_dynamodb_table" "accounts" {
  name         = "${var.name_prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  # Keys write gsi1pk = USER#{user_id}#KEYS, gsi1sk = created_at, so an
  # account's keys can be listed newest-first.
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = false
  }
}

locals {
  accounts_table_arn = aws_dynamodb_table.accounts.arn
}

# ------------------------------------------------------------------
# Handlers
# ------------------------------------------------------------------

data "aws_iam_policy_document" "customer_authorizer" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [local.accounts_table_arn]
  }
}

module "customer_authorizer" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-customer-authorizer"
  dist_dir      = "${var.dist_dir}/customer-authorizer"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.customer_authorizer.json
  attach_policy = true

  environment = {
    ACCOUNTS_TABLE = aws_dynamodb_table.accounts.name
  }
}

data "aws_iam_policy_document" "internal_authorizer" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.api_key_secret_arn]
  }
}

# The internal authorizer reuses the existing shared-key authorizer bundle —
# the exact check the web-app's own requests pass today. Revocation of the
# shared key is unchanged.
module "internal_authorizer" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-internal-authorizer"
  dist_dir      = "${var.dist_dir}/authorizer"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.internal_authorizer.json
  attach_policy = true

  environment = {
    API_KEY_SECRET_ARN = var.api_key_secret_arn
  }
}

data "aws_iam_policy_document" "keys" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [local.accounts_table_arn, "${local.accounts_table_arn}/index/*"]
  }
}

module "keys" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-keys"
  dist_dir      = "${var.dist_dir}/keys"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.keys.json
  attach_policy = true

  environment = {
    ACCOUNTS_TABLE = aws_dynamodb_table.accounts.name
  }
}

data "aws_iam_policy_document" "webhook_endpoint" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [local.accounts_table_arn, "${local.accounts_table_arn}/index/*"]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.customer_webhook_queue_arn]
  }
}

module "webhook_endpoint" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-webhook-endpoint"
  dist_dir      = "${var.dist_dir}/webhook-endpoint"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.webhook_endpoint.json
  attach_policy = true

  environment = {
    ACCOUNTS_TABLE            = aws_dynamodb_table.accounts.name
    CUSTOMER_WEBHOOK_QUEUE_URL = var.customer_webhook_queue_url
  }
}

data "aws_iam_policy_document" "create_job" {
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

module "create_job" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-create-job"
  dist_dir      = "${var.dist_dir}/create-job"
  timeout       = 30
  policy_json   = data.aws_iam_policy_document.create_job.json
  attach_policy = true

  environment = {
    TASKS_TABLE       = var.tasks_table_name
    STATE_MACHINE_ARN = var.state_machine_arn
  }
}

data "aws_iam_policy_document" "get_job" {
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [var.tasks_table_arn]
  }
}

module "get_job" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-get-job"
  dist_dir      = "${var.dist_dir}/get-job"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.get_job.json
  attach_policy = true

  environment = {
    TASKS_TABLE = var.tasks_table_name
  }
}

data "aws_iam_policy_document" "list_jobs" {
  statement {
    actions   = ["dynamodb:Query"]
    resources = [var.tasks_table_arn, "${var.tasks_table_arn}/index/gsi3", "${var.tasks_table_arn}/index/gsi4"]
  }
}

module "list_jobs" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-list-jobs"
  dist_dir      = "${var.dist_dir}/list-jobs"
  timeout       = 10
  policy_json   = data.aws_iam_policy_document.list_jobs.json
  attach_policy = true

  environment = {
    TASKS_TABLE = var.tasks_table_name
  }
}

# ------------------------------------------------------------------
# Authorizers + routes (attached to the shared api-gateway module)
# ------------------------------------------------------------------

resource "aws_apigatewayv2_authorizer" "customer" {
  api_id                            = var.api_id
  name                              = "customer"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = module.customer_authorizer.invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  # Both credential headers are accepted; the response cache is keyed per
  # identity tuple. Revocation latency is bounded by the TTL below.
  identity_sources = [
    "$request.header.Authorization",
    "$request.header.x-api-key",
  ]
  authorizer_result_ttl_in_seconds = 300
}

resource "aws_lambda_permission" "customer_authorizer" {
  statement_id  = "AllowApiGatewayCustomerAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.customer_authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/authorizers/${aws_apigatewayv2_authorizer.customer.id}"
}

resource "aws_apigatewayv2_authorizer" "internal" {
  api_id                            = var.api_id
  name                              = "internal"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = module.internal_authorizer.invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.x-api-key"]
  authorizer_result_ttl_in_seconds  = 300
}

resource "aws_lambda_permission" "internal_authorizer" {
  statement_id  = "AllowApiGatewayInternalAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.internal_authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/authorizers/${aws_apigatewayv2_authorizer.internal.id}"
}

locals {
  routes = {
    # Customer surface — per-user API key authorizer.
    "POST /v1/jobs" = {
      lambda     = module.create_job
      authorizer = "customer"
    }
    "GET /v1/jobs/{id}" = {
      lambda     = module.get_job
      authorizer = "customer"
    }
    "GET /v1/jobs" = {
      lambda     = module.list_jobs
      authorizer = "customer"
    }
    "GET /v1/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "customer"
    }
    "PUT /v1/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "customer"
    }
    "DELETE /v1/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "customer"
    }
    "POST /v1/webhook-endpoint/rotate" = {
      lambda     = module.webhook_endpoint
      authorizer = "customer"
    }
    "POST /v1/webhook-endpoint/test" = {
      lambda     = module.webhook_endpoint
      authorizer = "customer"
    }

    # Internal surface — shared-key authorizer; the web-app dashboard proxies
    # here. Never exposed to end users.
    "POST /v1/accounts/{user_id}/keys" = {
      lambda     = module.keys
      authorizer = "internal"
    }
    "GET /v1/accounts/{user_id}/keys" = {
      lambda     = module.keys
      authorizer = "internal"
    }
    "DELETE /v1/accounts/{user_id}/keys/{key_id}" = {
      lambda     = module.keys
      authorizer = "internal"
    }
    "GET /v1/accounts/{user_id}/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "internal"
    }
    "PUT /v1/accounts/{user_id}/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "internal"
    }
    "DELETE /v1/accounts/{user_id}/webhook-endpoint" = {
      lambda     = module.webhook_endpoint
      authorizer = "internal"
    }
    "POST /v1/accounts/{user_id}/webhook-endpoint/rotate" = {
      lambda     = module.webhook_endpoint
      authorizer = "internal"
    }
    "POST /v1/accounts/{user_id}/webhook-endpoint/test" = {
      lambda     = module.webhook_endpoint
      authorizer = "internal"
    }
  }
}

resource "aws_apigatewayv2_integration" "routes" {
  for_each = local.routes

  api_id                 = var.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.lambda.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes

  api_id             = var.api_id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.routes[each.key].id}"
  authorization_type = "CUSTOM"
  authorizer_id = (
    each.value.authorizer == "customer" ? aws_apigatewayv2_authorizer.customer.id : aws_apigatewayv2_authorizer.internal.id
  )
}

resource "aws_lambda_permission" "routes" {
  for_each = local.routes

  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = each.value.lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/*/*"
}
