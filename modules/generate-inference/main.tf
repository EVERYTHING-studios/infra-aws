# Inference backend for the generate pipeline.
#
# The default backend is the stub Lambda: it simulates a model run and emits a
# fixture GLB at the pipeline contract location (tasks/{task_id}/raw/model.glb
# in the work bucket). The SageMaker async-inference backend is multi-region
# AND multi-instance-type: the full regional stack (buckets, per-type
# Model/EndpointConfig/Endpoint sets, SNS topics, autoscaling) is deployed once
# per candidate region in `sagemaker-region/` — one endpoint per instance type
# in the cold-price chain — and a single us-east-1 control plane
# (`sagemaker-control/`) runs the dispatcher/callback/scaler/capacity-sentinel
# Lambdas and elects the active endpoint from live capacity evidence, in chain
# order (type-major, region-minor) — see sagemaker-region/README.md and
# sagemaker-control/README.md.
#
# Candidate regions are fixed to the three regions where SageMaker offers
# ml.g7e.2xlarge (us-east-1, us-east-2, us-west-2); the provider aliases
# below are exact, not a shortcut.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.useast2, aws.uswest2]
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

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
# SageMaker execution role (global IAM resource; the SageMaker Model in
# every candidate region assumes it). Its policy is fully constructed from
# region names (buckets, topics, logs, ECR repo) — NOT from module outputs —
# because SageMaker validates ECR pull, model-data GetObject, and
# output-bucket ListBucket at CreateModel/CreateEndpointConfig time, so the
# attach must precede the regional stacks. The region modules depends_on
# aws_iam_role_policy.sagemaker_execution_static; role -> policy -> regional
# modules -> control plane is a DAG, not a cycle. Scoped to TRELLIS (weights
# key trellis-weights/* per package_weights.sh default WEIGHTS_KEY, the
# trellis2image ECR repo). When a second model lands, decide explicitly
# whether to broaden this role or add a per-model role — do NOT silently
# broaden.
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

locals {
  pipeline_state_machine_arn = "arn:aws:states:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name_prefix}-pipeline"

  # Constructed (not a module output) to break the control <-> regional
  # reference cycle — same pattern as the state-machine ARN above. The
  # callback Lambda is named by sagemaker-control.
  callback_function_arn = "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${var.name_prefix}-inference-sagemaker-callback"

  # Every instantiated regional stack's region name (us-east-1 always;
  # alternates gated by sagemaker_candidate_regions).
  region_names = distinct(concat(["us-east-1"], var.sagemaker_candidate_regions))
  # Sentinel failback priority: sagemaker_candidate_regions order from the env
  # tfvars, with the always-on us-east-1 appended last when unlisted.
  region_priority = distinct(concat(var.sagemaker_candidate_regions, ["us-east-1"]))

  # Regional bucket names — single source for the sagemaker-region stacks
  # and the execution-role policy below. us-east-1 keeps byte-identical
  # legacy names; alternates gain a compacted region suffix (-useast2).
  region_bucket_names = {
    for r in local.region_names : r => {
      input   = "generate-${var.env}-inference-input-${data.aws_caller_identity.current.account_id}${r == "us-east-1" ? "" : "-${replace(r, "-", "")}"}"
      output  = "generate-${var.env}-inference-output-${data.aws_caller_identity.current.account_id}${r == "us-east-1" ? "" : "-${replace(r, "-", "")}"}"
      weights = "generate-${var.env}-inference-weights-${data.aws_caller_identity.current.account_id}${r == "us-east-1" ? "" : "-${replace(r, "-", "")}"}"
    }
  }

  # Region-keyed descriptors of every instantiated regional stack. try()
  # absorbs the out-of-range index when a gated instance has count = 0.
  sagemaker_regions = merge(
    try(module.sagemaker_region_useast1[0].this, {}),
    try(module.sagemaker_region_useast2[0].this, {}),
    try(module.sagemaker_region_uswest2[0].this, {}),
  )

  # Instance-type name tokens (must mirror sagemaker-region's type_token map;
  # consistency is enforced by the shared allowed-values validation on
  # sagemaker_instance_types / instance_types).
  type_tokens = {
    "ml.g5.2xlarge"  = "g5"
    "ml.g6e.2xlarge" = "g6e"
    "ml.g7e.2xlarge" = "g7e"
  }

  # Endpoint election priority — TYPE-MAJOR: for each instance type in
  # var.sagemaker_instance_types order (cold-price chain: g5 -> g6e -> g7e),
  # each region in region_priority order. Prices are region-invariant, so
  # the cheapest type in any region beats a pricier type in the preferred
  # region. Entries whose (region, type) endpoint is absent (gated/absent
  # region) drop out via the null filter; try() absorbs missing keys.
  endpoint_priority = [
    for e in flatten([
      for t in var.sagemaker_instance_types : [
        for r in local.region_priority : {
          region            = r
          instance_type     = t
          token             = local.type_tokens[t]
          endpoint_name     = try(local.sagemaker_regions[r].endpoints[local.type_tokens[t]].name, null)
          endpoint_arn      = try(local.sagemaker_regions[r].endpoints[local.type_tokens[t]].arn, null)
          input_bucket      = try(local.sagemaker_regions[r].input_bucket, null)
          input_bucket_arn  = try(local.sagemaker_regions[r].input_bucket_arn, null)
          success_topic_arn = try(local.sagemaker_regions[r].success_topic_arn, null)
          error_topic_arn   = try(local.sagemaker_regions[r].error_topic_arn, null)
        }
      ]
    ]) : e if e.endpoint_name != null
  ]
}

data "aws_iam_policy_document" "sagemaker_execution_static" {
  # The COMPLETE execution-role policy. Every ARN is constructed from region
  # names so the attach can precede the regional stacks (see the role
  # comment above); the region modules depends_on the attach resource.
  statement {
    actions   = ["s3:GetObject"]
    resources = [for names in values(local.region_bucket_names) : "arn:aws:s3:::${names.weights}/trellis-weights/*"]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = [for names in values(local.region_bucket_names) : "arn:aws:s3:::${names.input}/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [for names in values(local.region_bucket_names) : "arn:aws:s3:::${names.output}"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = [for names in values(local.region_bucket_names) : "arn:aws:s3:::${names.output}/*"]
  }

  statement {
    actions = ["sns:Publish"]
    resources = flatten([
      for r in local.region_names : [
        "arn:aws:sns:${r}:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-sagemaker-success",
        "arn:aws:sns:${r}:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-sagemaker-error",
      ]
    ])
  }

  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for r in local.region_names : "arn:aws:logs:${r}:${data.aws_caller_identity.current.account_id}:*"]
  }

  # One trellis2image ECR repo per candidate region, created out-of-band by
  # trellis2image/scripts/replicate_artifacts.sh (same as us-east-1's
  # push_image.sh). ARNs are constructed because the repos are not Terraform
  # resources in this stack.
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [for r in local.region_names : "arn:aws:ecr:${r}:${data.aws_caller_identity.current.account_id}:repository/trellis2image"]
  }

  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # global action — cannot be scoped to a resource
  }
}

resource "aws_iam_role_policy" "sagemaker_execution_static" {
  name   = "sagemaker-execution-static"
  role   = aws_iam_role.sagemaker_execution.id
  policy = data.aws_iam_policy_document.sagemaker_execution_static.json
}

# ------------------------------------------------------------------
# Regional stacks: one sagemaker-region instance per candidate region,
# each mapped to that region's provider. us-east-1 is always present when
# the sagemaker backend is on; the alternates appear when appended to
# sagemaker_candidate_regions (requires regional quota L-5AA715AC >= 1 and
# artifacts replicated via replicate_artifacts.sh — see
# trellis2image/docs/sagemaker-iac-contract.md).
# ------------------------------------------------------------------

module "sagemaker_region_useast1" {
  count  = var.inference_backend == "sagemaker" ? 1 : 0
  source = "./sagemaker-region"

  providers = { aws = aws }

  region                = "us-east-1"
  name_prefix           = var.name_prefix
  env                   = var.env
  execution_role_arn    = aws_iam_role.sagemaker_execution.arn
  callback_function_arn = local.callback_function_arn
  bucket_names          = local.region_bucket_names["us-east-1"]
  instance_types        = var.sagemaker_instance_types
  max_capacity          = var.sagemaker_max_capacity

  # Orders each regional Model create after the execution-role policy attach
  # (referenced from the Model's tags in sagemaker-region): SageMaker
  # validates ECR pull and model-data GetObject at CreateModel time. A plain
  # module depends_on would defer the module's SSM data reads to apply time
  # and cascade unknown keepers into Model/EndpointConfig replacements.
  execution_role_policy_id = aws_iam_role_policy.sagemaker_execution_static.id
}

module "sagemaker_region_useast2" {
  count  = var.inference_backend == "sagemaker" && contains(var.sagemaker_candidate_regions, "us-east-2") ? 1 : 0
  source = "./sagemaker-region"

  providers = { aws = aws.useast2 }

  region                = "us-east-2"
  name_prefix           = var.name_prefix
  env                   = var.env
  execution_role_arn    = aws_iam_role.sagemaker_execution.arn
  callback_function_arn = local.callback_function_arn
  bucket_names          = local.region_bucket_names["us-east-2"]
  instance_types        = var.sagemaker_instance_types
  max_capacity          = var.sagemaker_max_capacity

  # See the useast1 block: orders Model create after the policy attach.
  execution_role_policy_id = aws_iam_role_policy.sagemaker_execution_static.id
}

module "sagemaker_region_uswest2" {
  count  = var.inference_backend == "sagemaker" && contains(var.sagemaker_candidate_regions, "us-west-2") ? 1 : 0
  source = "./sagemaker-region"

  providers = { aws = aws.uswest2 }

  region                = "us-west-2"
  name_prefix           = var.name_prefix
  env                   = var.env
  execution_role_arn    = aws_iam_role.sagemaker_execution.arn
  callback_function_arn = local.callback_function_arn
  bucket_names          = local.region_bucket_names["us-west-2"]
  instance_types        = var.sagemaker_instance_types
  max_capacity          = var.sagemaker_max_capacity

  # See the useast1 block: orders Model create after the policy attach.
  execution_role_policy_id = aws_iam_role_policy.sagemaker_execution_static.id
}

# ------------------------------------------------------------------
# Control plane (once, us-east-1): dispatcher/callback/scaler/sentinel
# Lambdas, the EventBridge rule, SNS invoke permissions for every region's
# topics, and the active_endpoint/last_flip election parameters. Consumes
# the type-major endpoint priority list, so its IAM and env wiring cover
# every (region x instance type) endpoint in the chain.
# ------------------------------------------------------------------

module "sagemaker_control" {
  count  = var.inference_backend == "sagemaker" ? 1 : 0
  source = "./sagemaker-control"

  name_prefix       = var.name_prefix
  env               = var.env
  region_names      = local.region_names
  region_priority   = local.region_priority
  endpoints         = local.endpoint_priority
  tasks_table_name  = var.tasks_table_name
  tasks_table_arn   = var.tasks_table_arn
  work_bucket_name  = var.work_bucket_name
  work_bucket_arn   = var.work_bucket_arn
  dist_dir          = var.dist_dir
  state_machine_arn = local.pipeline_state_machine_arn
  postprocess_mode  = var.postprocess_mode
}
