# Inference backend for the generate pipeline.
#
# Today this is the stub Lambda: it simulates a model run and emits a fixture
# GLB at the pipeline contract location (tasks/{task_id}/raw/model.glb in the
# work bucket). The SageMaker async-inference backend lands later as a
# `sagemaker/` submodule behind the same contract — see sagemaker/README.md.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
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
