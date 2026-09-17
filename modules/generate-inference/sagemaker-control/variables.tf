variable "name_prefix" {
  description = "Resource name prefix (e.g. generate-staging)."
  type        = string
}

variable "env" {
  description = "Environment name (staging|production). Selects the SSM namespace for the election parameters."
  type        = string
}

variable "region_names" {
  description = "Static list of deployed candidate regions (us-east-1 plus sagemaker_candidate_regions). Resources that need for_each iterate over this — NOT over var.regions, whose values are known only after apply when a region's stack is being created."
  type        = list(string)
}

variable "region_priority" {
  description = "Candidate regions in sentinel failback priority order (sagemaker_candidate_regions order, us-east-1 appended last when unlisted). Same region set as region_names, reordered."
  type        = list(string)
}

variable "regions" {
  description = "Region-keyed descriptors of every candidate region's SageMaker stack (output of the parent's merged sagemaker-region instances)."
  type = map(object({
    region             = string
    endpoint_name      = string
    endpoint_arn       = string
    input_bucket       = string
    input_bucket_arn   = string
    output_bucket_arn  = string
    weights_bucket_arn = string
    success_topic_arn  = string
    error_topic_arn    = string
  }))
}

variable "tasks_table_name" {
  type = string
}

variable "tasks_table_arn" {
  type = string
}

variable "work_bucket_name" {
  type = string
}

variable "work_bucket_arn" {
  type = string
}

variable "dist_dir" {
  description = "Path to services/generate/dist containing bundled handlers."
  type        = string
}

variable "state_machine_arn" {
  description = "Pipeline state-machine ARN, scoped as the SendTaskSuccess/Failure IAM resource. Constructed by the parent module to avoid a dependency cycle with the pipeline module."
  type        = string
}

variable "postprocess_mode" {
  description = "Post-process path (lite|fargate); passed to the callback so it can reconstruct the pipeline context for SendTaskSuccess."
  type        = string
  default     = "lite"
}
