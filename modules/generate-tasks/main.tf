# DynamoDB task table for the generate service.
#
# Item layout:
#   pk      = TASK#{task_id}            (ULID task ids)
#   gsi1pk  = IDEMPOTENCY#{key}         (sparse; create-task replay protection)
#   gsi2pk  = STATUS#{status}, gsi2sk = created_at   (ops sweeps / stuck-task queries)
#   ttl     = epoch seconds, 90 days after creation

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_dynamodb_table" "tasks" {
  name         = var.table_name
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
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }
}
