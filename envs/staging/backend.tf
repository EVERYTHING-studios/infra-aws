terraform {
  backend "s3" {
    bucket       = "everything-infra-tfstate-095256591532"
    key          = "envs/staging/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
