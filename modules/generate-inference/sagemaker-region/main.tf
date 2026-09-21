# One candidate region's full SageMaker async-inference stack. Instantiated
# once per region (with that region's provider) by the parent module; the
# dispatcher/callback/scaler/sentinel Lambdas and the election SSM params
# live once in the sibling `sagemaker-control/` module (us-east-1).
#
# Every resource here is regional and created through the single mapped
# provider. Bucket names come from the parent module (var.bucket_names;
# us-east-1 keeps byte-identical legacy names, alternates gain a
# `-useast2`/`-uswest2` suffix). SSM is regional, so
# `/trellis2image/${env}/...` parameter names repeat per region with
# region-local values (seeded by trellis2image/scripts/replicate_artifacts.sh).
#
# NOTE on initial_instance_count: the hashicorp/aws provider hardcodes
# validation.IntAtLeast(1) on this field, so an endpoint config cannot be
# created at zero instances through Terraform. Steady-state zero is still the
# operating mode: min_capacity = 0 plus the EndpointIdle scale-to-zero alarm
# drain every region's endpoint when idle. The one consequence: the FIRST
# create of a new region's endpoint provisions one instance at apply time —
# a one-time capacity probe (SageMaker keeps retrying if the region is dry; a
# Failed endpoint needs delete-endpoint + re-apply, see the README).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  variant_name = "trellis"

  # SageMaker resource names reject dots: token per chain instance type, used
  # to suffix Model/EndpointConfig/Endpoint/policy/alarm names so each type's
  # resources are distinct and stable.
  type_token = {
    "ml.g5.2xlarge"  = "g5"
    "ml.g6e.2xlarge" = "g6e"
    "ml.g7e.2xlarge" = "g7e"
  }

  # SageMaker names are region-scoped, so a token-only endpoint name would be
  # identical in us-east-1 and us-east-2. The sentinel/dispatcher elect and
  # look up endpoints by NAME across the whole chain, so endpoint names must
  # be globally unique. Mirrors the bucket convention: us-east-1 keeps the
  # legacy-style unsuffixed names, alternates gain a region suffix with the
  # hyphens stripped. Only the Endpoint name uses this — Model/EndpointConfig
  # names are random-hex (region-scoped) and alarms/policies/AAS targets are
  # region-scoped resources.
  region_token = var.region == "us-east-1" ? "" : "-${replace(var.region, "-", "")}"

  # TRELLIS2_LOW_VRAM is derived per instance type (replaces the old low_vram
  # var): g5's 24 GB VRAM cannot hold all ~17 GB of models resident, so it
  # keeps models on CPU and swaps per-stage; g6e (45 GB) and g7e (96 GB) load
  # everything to GPU once at startup.
  low_vram_by_type = {
    "ml.g5.2xlarge"  = "1"
    "ml.g6e.2xlarge" = "0"
    "ml.g7e.2xlarge" = "0"
  }

  # Model container environment per instance type: the fixed base merged with
  # the per-type TRELLIS2_LOW_VRAM. Tracked by the endpoint_config keepers so
  # a change rolls a new Model + EndpointConfig (blue/green). Defined as a
  # local to avoid a circular dependency: random_id keepers must not reference
  # the model resource whose name derives from random_id.hex.
  model_environment_base = {
    HF_HOME                = "/opt/ml/model"
    HF_HUB_OFFLINE         = "1"
    TRELLIS2_EAGER_LOAD    = "1"
    TRELLIS2_PIPELINE_TYPE = "1024"
  }
  model_environment = {
    for t in var.instance_types : t => merge(local.model_environment_base, {
      TRELLIS2_LOW_VRAM = local.low_vram_by_type[t]
    })
  }
}

# ------------------------------------------------------------------
# S3 buckets: async input, async output, and the weights store. The
# weights bucket is published to regional SSM (same parameter name in
# every region); replicate_artifacts.sh reads it to target replication.
# ------------------------------------------------------------------

resource "aws_s3_bucket" "sagemaker_input" {
  bucket = var.bucket_names.input
}

resource "aws_s3_bucket" "sagemaker_output" {
  bucket = var.bucket_names.output
}

resource "aws_s3_bucket" "sagemaker_weights" {
  bucket = var.bucket_names.weights
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

# Weights bucket SSM param — regional (same name, region-local value).
resource "aws_ssm_parameter" "weights_bucket" {
  name  = "/trellis2image/${var.env}/s3/weights_bucket"
  type  = "String"
  value = aws_s3_bucket.sagemaker_weights.id
}

# ------------------------------------------------------------------
# SSM inputs (written out-of-band by push_image.sh / package_weights.sh in
# us-east-1, and by replicate_artifacts.sh in alternate regions). The
# regional provider reads this region's own parameter store.
# ------------------------------------------------------------------

data "aws_ssm_parameter" "image_uri" {
  name = "/trellis2image/${var.env}/ecr/image_uri"
}

data "aws_ssm_parameter" "weights_s3_uri" {
  name = "/trellis2image/${var.env}/weights/s3_uri"
}

# ------------------------------------------------------------------
# Model + EndpointConfig + Endpoint — one per instance type in
# var.instance_types (for_each). A random suffix on each EndpointConfig name
# lets image/weights changes roll forward via a new config (blue/green
# endpoint update) instead of a recreate that would conflict with the live
# Endpoint. `keepers` tie the suffix to the image and weights values from SSM
# (one random_id per type so one type's change doesn't rotate the others).
# ------------------------------------------------------------------

resource "random_id" "endpoint_config" {
  for_each = toset(var.instance_types)

  byte_length = 4

  keepers = {
    image   = data.aws_ssm_parameter.image_uri.value
    weights = data.aws_ssm_parameter.weights_s3_uri.value
    # Rotate the endpoint config (blue/green update) when the model environment
    # changes — SageMaker Models are immutable, so a new Model alone does NOT
    # update the running Endpoint; a new EndpointConfig + Endpoint update does.
    environment   = jsonencode(local.model_environment[each.key])
    instance_type = each.key
  }
}

resource "aws_sagemaker_model" "this" {
  for_each = toset(var.instance_types)

  name               = "${var.name_prefix}-sagemaker-model-${local.type_token[each.key]}-${random_id.endpoint_config[each.key].hex}"
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

    environment = local.model_environment[each.key]
  }

  # Dependency anchor, not metadata: referencing the execution-role policy
  # attach here orders this Model AFTER the attach (SageMaker validates ECR
  # pull and model-data s3:GetObject at CreateModel time). The
  # EndpointConfig and Endpoint order after the Model transitively.
  tags = {
    execution_role_policy = var.execution_role_policy_id
  }

  # Model creation validates the model-data S3 URI; the weights bucket must
  # not race its create in a fresh region.
  depends_on = [
    aws_s3_bucket.sagemaker_input,
    aws_s3_bucket.sagemaker_output,
    aws_s3_bucket.sagemaker_weights,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sagemaker_endpoint_configuration" "this" {
  for_each = toset(var.instance_types)

  name = "${var.name_prefix}-sagemaker-${local.type_token[each.key]}-${random_id.endpoint_config[each.key].hex}"

  production_variants {
    variant_name           = local.variant_name
    model_name             = aws_sagemaker_model.this[each.key].name
    instance_type          = each.key
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
      s3_output_path = "s3://${aws_s3_bucket.sagemaker_output.bucket}/"

      notification_config {
        success_topic = aws_sns_topic.success.arn
        error_topic   = aws_sns_topic.error.arn
      }
    }
  }

  # Endpoint-config creation validates the execution role may ListBucket the
  # output bucket; the bucket must not race its create in a fresh region.
  depends_on = [
    aws_s3_bucket.sagemaker_input,
    aws_s3_bucket.sagemaker_output,
    aws_s3_bucket.sagemaker_weights,
  ]

  # create_before_destroy so the new config exists before the endpoint
  # switches to it and the old one is deleted — avoids the race where
  # UpdateEndpoint fails because the current config was already destroyed.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sagemaker_endpoint" "this" {
  for_each = toset(var.instance_types)

  name                 = "${var.name_prefix}-sagemaker-${local.type_token[each.key]}${local.region_token}"
  endpoint_config_name = aws_sagemaker_endpoint_configuration.this[each.key].name
}


# ------------------------------------------------------------------
# SNS topics for async notifications. The single us-east-1 callback Lambda
# (sagemaker-control) is subscribed to both from every region — SNS
# cross-region Lambda delivery is supported. The callback derives the source
# region from each record's EventSubscriptionArn.
# ------------------------------------------------------------------

resource "aws_sns_topic" "success" {
  name = "${var.name_prefix}-sagemaker-success"
}

resource "aws_sns_topic" "error" {
  name = "${var.name_prefix}-sagemaker-error"
}

resource "aws_sns_topic_subscription" "success" {
  topic_arn = aws_sns_topic.success.arn
  protocol  = "lambda"
  endpoint  = var.callback_function_arn
}

resource "aws_sns_topic_subscription" "error" {
  topic_arn = aws_sns_topic.error.arn
  protocol  = "lambda"
  endpoint  = var.callback_function_arn
}

# ------------------------------------------------------------------
# Autoscaling: scale-to-zero (min 0, max = var.max_capacity) — one set per
# instance type. HasBacklogWithoutCapacity scales up from zero (target
# tracking can't, with zero instances there are no invocations-per-instance
# to track). Step scaling on the same metric scales back down when idle.
# ------------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  for_each = toset(var.instance_types)

  service_namespace  = "sagemaker"
  resource_id        = "endpoint/${aws_sagemaker_endpoint.this[each.key].name}/variant/${local.variant_name}"
  scalable_dimension = "sagemaker:variant:DesiredInstanceCount"

  min_capacity = 0
  max_capacity = var.max_capacity
}

# Scale-up from zero on backlog.
resource "aws_appautoscaling_policy" "scale_up" {
  for_each = toset(var.instance_types)

  name               = "${var.name_prefix}-sagemaker-scale-up-${local.type_token[each.key]}"
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension

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
  for_each = toset(var.instance_types)

  alarm_name          = "${var.name_prefix}-sagemaker-backlog-${local.type_token[each.key]}"
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
    EndpointName = aws_sagemaker_endpoint.this[each.key].name
  }

  alarm_actions = [aws_appautoscaling_policy.scale_up[each.key].arn]
}

# Scale-in to zero when the scaler Lambda (sagemaker-control) reports the
# endpoint idle for 3 minutes. Target tracking on InvocationsPerInstance
# does NOT work for async endpoints because the metric is absent (not zero)
# when idle.
resource "aws_appautoscaling_policy" "scale_down" {
  for_each = toset(var.instance_types)

  name               = "${var.name_prefix}-sagemaker-scale-down-${local.type_token[each.key]}"
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension

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
  for_each = toset(var.instance_types)

  alarm_name          = "${var.name_prefix}-sagemaker-scale-to-zero-${local.type_token[each.key]}"
  alarm_description   = "Scale the SageMaker async endpoint to zero when idle (no active invocations for 3 minutes)."
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
    EndpointName = aws_sagemaker_endpoint.this[each.key].name
  }

  alarm_actions = [aws_appautoscaling_policy.scale_down[each.key].arn]
}
