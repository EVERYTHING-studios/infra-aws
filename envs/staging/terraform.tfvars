# Fill in from the account (aws ec2 describe-vpcs / describe-subnets):
vpc_id     = "vpc-CHANGE-ME"
subnet_ids = ["subnet-CHANGE-ME-a", "subnet-CHANGE-ME-b"]

# From the web-app SST stack (AssetsCdn distribution):
cloudfront_distribution_id = ""

inference_backend = "stub"
postprocess_mode  = "lite"
