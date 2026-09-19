output "accounts_table_name" {
  value = aws_dynamodb_table.accounts.name
}

output "accounts_table_arn" {
  value = aws_dynamodb_table.accounts.arn
}
