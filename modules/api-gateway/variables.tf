variable "name_prefix" {
  description = "Resource name prefix for the API Gateway (e.g. everything-api-staging)."
  type        = string
}

variable "domain_name" {
  description = "Custom domain (e.g. api.everythingstudios.ai)."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone for the domain."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate covering the domain."
  type        = string
}
