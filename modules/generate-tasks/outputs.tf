output "table_name" {
  value = aws_dynamodb_table.tasks.name
}

output "table_arn" {
  value = aws_dynamodb_table.tasks.arn
}

output "table_index_arns" {
  value = "${aws_dynamodb_table.tasks.arn}/index/*"
}
