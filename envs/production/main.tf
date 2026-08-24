terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      service     = "generate"
      environment = local.env
      managed-by  = "terraform"
      repository  = "EVERYTHING-studios/infra-aws"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  env         = "production"
  name_prefix = "generate-${local.env}"
  dist_dir    = "${path.module}/../../services/generate/dist"

  domain_name     = "generate.everythingstudios.ai"
  assets_base_url = "https://assets.everythingstudios.ai"
  webhook_url     = "https://everythingstudios.ai/api/generate/webhook"

  # Shared *.everythingstudios.ai wildcard cert + zone (same as the web-app's SST stack).
  hosted_zone_id  = "Z01141872JPDWNBE74RD0"
  certificate_arn = "arn:aws:acm:us-east-1:095256591532:certificate/ba84a0d5-7004-487f-a7fb-f89f20117f21"
}

# ------------------------------------------------------------------
# Existing buckets (owned by the web-app's SST stack) — referenced only.
# ------------------------------------------------------------------

data "aws_s3_bucket" "model_assets" {
  bucket = "everything-generative-ar-${local.env}-model-assets"
}

# ------------------------------------------------------------------
# Internal work bucket for intermediate pipeline artifacts.
# ------------------------------------------------------------------

resource "aws_s3_bucket" "work" {
  bucket = "${local.name_prefix}-work-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "work" {
  bucket = aws_s3_bucket.work.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "work" {
  bucket = aws_s3_bucket.work.id

  rule {
    id     = "expire-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }
  }
}

# ------------------------------------------------------------------
# Secrets (shells only — set values with `aws secretsmanager put-secret-value`,
# see the repo README).
# ------------------------------------------------------------------

resource "aws_secretsmanager_secret" "api_key" {
  name        = "${local.name_prefix}-api-key"
  description = "API key the web-app presents as x-api-key to the generate API."
}

resource "aws_secretsmanager_secret" "webhook_secret" {
  name        = "${local.name_prefix}-webhook-secret"
  description = "HMAC secret for signing generate webhooks to the web-app."
}

# ------------------------------------------------------------------
# Service modules
# ------------------------------------------------------------------

module "tasks" {
  source = "../../modules/generate-tasks"

  table_name             = "${local.name_prefix}-tasks"
  point_in_time_recovery = true
}

module "inference" {
  source = "../../modules/generate-inference"
  env    = local.env

  name_prefix       = local.name_prefix
  dist_dir          = local.dist_dir
  tasks_table_name  = module.tasks.table_name
  tasks_table_arn   = module.tasks.table_arn
  work_bucket_name  = aws_s3_bucket.work.bucket
  work_bucket_arn   = aws_s3_bucket.work.arn
  inference_backend = var.inference_backend
  postprocess_mode  = var.postprocess_mode
  instance_type     = var.instance_type
  low_vram          = var.low_vram
}

module "pipeline" {
  source = "../../modules/generate-pipeline"

  name_prefix                = local.name_prefix
  account_id                 = data.aws_caller_identity.current.account_id
  dist_dir                   = local.dist_dir
  tasks_table_name           = module.tasks.table_name
  tasks_table_arn            = module.tasks.table_arn
  work_bucket_name           = aws_s3_bucket.work.bucket
  work_bucket_arn            = aws_s3_bucket.work.arn
  assets_bucket_name         = data.aws_s3_bucket.model_assets.bucket
  assets_bucket_arn          = data.aws_s3_bucket.model_assets.arn
  assets_base_url            = local.assets_base_url
  cloudfront_distribution_id = var.cloudfront_distribution_id
  webhook_url                = local.webhook_url
  webhook_secret_arn         = aws_secretsmanager_secret.webhook_secret.arn
  inference_lambda_arn       = module.inference.inference_lambda_arn
  inference_backend          = var.inference_backend
  postprocess_mode           = var.postprocess_mode
  vpc_id                     = var.vpc_id
  subnet_ids                 = var.subnet_ids
}

module "api" {
  source = "../../modules/generate-api"

  name_prefix        = local.name_prefix
  dist_dir           = local.dist_dir
  domain_name        = local.domain_name
  hosted_zone_id     = local.hosted_zone_id
  certificate_arn    = local.certificate_arn
  api_key_secret_arn = aws_secretsmanager_secret.api_key.arn
  tasks_table_name   = module.tasks.table_name
  tasks_table_arn    = module.tasks.table_arn
  state_machine_arn  = module.pipeline.state_machine_arn
  webhook_queue_url  = module.pipeline.webhook_queue_url
  webhook_queue_arn  = module.pipeline.webhook_queue_arn
}
