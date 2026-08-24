# Inference backend for the generate pipeline.
#
# The default backend is the stub Lambda: it simulates a model run and emits a
# fixture GLB at the pipeline contract location (tasks/{task_id}/raw/model.glb
# in the work bucket). The SageMaker async-inference backend lives in the
# `sagemaker/` submodule behind the same contract, selected via
# `inference_backend = "sagemaker"` — see sagemaker/README.md. The ECR image
# (`trellis2image:c374e66-serve-fix`) and SSM `/trellis2image/ecr/*` params are
# ready; the SageMaker backend is live in staging (endpoint InService on
# `ml.g6e.2xlarge`).

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
# Data sources for the SageMaker foundation. The ECR repo `trellis2image`
# is owned out-of-band by push_image.sh (shared across envs) and only
# referenced here — never created or imported. See B1b/B1 decision 4.
# ------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_ecr_repository" "trellis2image" {
  name = "trellis2image"
}

data "aws_iam_policy_document" "stub" {
  statement {
    actions = ["dynamodb:GetItem", "dynamodb:UpdateItem"]

    resources = [var.tasks_table_arn]
  }

  statement {
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${var.work_bucket_arn}/*"]
  }
}

module "stub" {
  source = "../lambda-function"

  function_name = "${var.name_prefix}-inference-stub"
  dist_dir      = "${var.dist_dir}/inference-stub"
  timeout       = 120
  memory_size   = 512
  policy_json   = data.aws_iam_policy_document.stub.json
  attach_policy = true

  environment = {
    TASKS_TABLE = var.tasks_table_name
    WORK_BUCKET = var.work_bucket_name
  }
}

# ------------------------------------------------------------------
# SageMaker foundation (phase 1) — S3 buckets, weights SSM param, and the
# execution role. No SageMaker Model/Endpoint here (phase 3). Buckets are
# generic and capability-named (generate-*), not model-specific, so future
# SageMaker-backed models reuse the same plumbing. Per env because this
# module is invoked once per env from each composition root.
# ------------------------------------------------------------------

resource "aws_s3_bucket" "sagemaker_input" {
  bucket = "generate-${var.env}-inference-input-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "sagemaker_output" {
  bucket = "generate-${var.env}-inference-output-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "sagemaker_weights" {
  bucket = "generate-${var.env}-inference-weights-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "sagemaker_input" {
  bucket = aws_s3_bucket.sagemaker_input.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "sagemaker_output" {
  bucket = aws_s3_bucket.sagemaker_output.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "sagemaker_weights" {
  bucket = aws_s3_bucket.sagemaker_weights.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sagemaker_input" {
  bucket = aws_s3_bucket.sagemaker_input.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sagemaker_output" {
  bucket = aws_s3_bucket.sagemaker_output.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sagemaker_weights" {
  bucket = aws_s3_bucket.sagemaker_weights.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Input + output buckets expire transient artifacts after 7 days. The weights
# bucket holds a manually managed artifact (model.tar.gz) and has NO expiry.
resource "aws_s3_bucket_lifecycle_configuration" "sagemaker_input" {
  bucket = aws_s3_bucket.sagemaker_input.id

  rule {
    id     = "expire-inputs"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "sagemaker_output" {
  bucket = aws_s3_bucket.sagemaker_output.id

  rule {
    id     = "expire-outputs"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }
  }
}

# Weights bucket SSM param — per env. Only the weights bucket is published to
# SSM; input/output are passed as Terraform vars to the phase-3 dispatcher/
# callback Lambdas (same stack, no cross-repo handoff needed). ECR SSM params
# are owned by push_image.sh, NOT here.
resource "aws_ssm_parameter" "weights_bucket" {
  name  = "/trellis2image/${var.env}/s3/weights_bucket"
  type  = "String"
  value = aws_s3_bucket.sagemaker_weights.id
}

# ------------------------------------------------------------------
# SageMaker execution role. Created in phase 1 but unused until phase 3 (the
# SageMaker Model references it); idle and harmless until then. Scoped to
# TRELLIS for now (weights key trellis-weights/* per package_weights.sh
# default WEIGHTS_KEY, the trellis2image ECR repo). When a second model
# lands, decide explicitly whether to broaden this role or add a per-model
# role — do NOT silently broaden.
# ------------------------------------------------------------------

data "aws_iam_policy_document" "sagemaker_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["sagemaker.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sagemaker_execution" {
  name               = "${var.name_prefix}-sagemaker-execution"
  assume_role_policy = data.aws_iam_policy_document.sagemaker_assume.json
}

data "aws_iam_policy_document" "sagemaker_execution" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.sagemaker_weights.arn}/trellis-weights/*"]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.sagemaker_input.arn}/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.sagemaker_output.arn]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.sagemaker_output.arn}/*"]
  }

  statement {
    actions = ["sns:Publish"]
    resources = [
      local.sagemaker_sns_success_arn,
      local.sagemaker_sns_error_arn,
    ]
  }

  statement {
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*",
    ]
  }

  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [data.aws_ecr_repository.trellis2image.arn]
  }

  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # global action — cannot be scoped to a resource
  }
}

resource "aws_iam_role_policy" "sagemaker_execution" {
  role   = aws_iam_role.sagemaker_execution.id
  policy = data.aws_iam_policy_document.sagemaker_execution.json
}

# ------------------------------------------------------------------
# Phase 3 — SageMaker Model/Endpoint + dispatcher/callback Lambdas. Only
# instantiated when inference_backend = "sagemaker"; the stub Lambda above
# handles the default. The state-machine ARN is constructed from name_prefix
# (the pipeline names its state machine ${name_prefix}-pipeline) rather than
# passed in, because the pipeline module consumes this module's dispatcher ARN
# — taking the ARN from the pipeline module would form a Terraform dependency
# cycle. See sagemaker/main.tf for the contract.
# ------------------------------------------------------------------

locals {
  pipeline_state_machine_arn = "arn:aws:states:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name_prefix}-pipeline"
  sagemaker_sns_success_arn  = "arn:aws:sns:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-sagemaker-success"
  sagemaker_sns_error_arn    = "arn:aws:sns:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-sagemaker-error"
}

module "sagemaker" {
  count      = var.inference_backend == "sagemaker" ? 1 : 0
  source     = "./sagemaker"
  depends_on = [aws_iam_role_policy.sagemaker_execution]

  name_prefix        = var.name_prefix
  env                = var.env
  execution_role_arn = aws_iam_role.sagemaker_execution.arn
  work_bucket_name   = var.work_bucket_name
  work_bucket_arn    = var.work_bucket_arn
  input_bucket_name  = aws_s3_bucket.sagemaker_input.bucket
  input_bucket_arn   = aws_s3_bucket.sagemaker_input.arn
  output_bucket_name = aws_s3_bucket.sagemaker_output.bucket
  output_bucket_arn  = aws_s3_bucket.sagemaker_output.arn
  tasks_table_name   = var.tasks_table_name
  tasks_table_arn    = var.tasks_table_arn
  dist_dir           = var.dist_dir
  state_machine_arn  = local.pipeline_state_machine_arn
  postprocess_mode   = var.postprocess_mode
  instance_type      = var.instance_type
  low_vram           = var.low_vram
}
