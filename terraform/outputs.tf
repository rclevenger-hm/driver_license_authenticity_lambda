output "intake_lambda_function_arn" {
  description = "ARN of the intake Lambda function."
  value       = aws_lambda_function.intake.arn
}

output "worker_lambda_function_arn" {
  description = "ARN of the worker Lambda function."
  value       = aws_lambda_function.worker.arn
}

output "status_lambda_function_arn" {
  description = "ARN of the status lookup Lambda function."
  value       = aws_lambda_function.status.arn
}

output "intake_bucket_name" {
  description = "S3 bucket used to store queued submissions and screening results."
  value       = aws_s3_bucket.intake_bucket.bucket
}

output "submission_table_name" {
  description = "DynamoDB table used to persist submission status."
  value       = aws_dynamodb_table.submissions.name
}

output "screening_queue_url" {
  description = "SQS queue URL used for asynchronous screening jobs."
  value       = aws_sqs_queue.screening_jobs.id
}

output "api_endpoint_url" {
  description = "URL of the API Gateway intake endpoint."
  value       = "https://${aws_api_gateway_rest_api.driver_license_api.id}.execute-api.${local.region}.amazonaws.com/${aws_api_gateway_stage.driver_license_api_stage.stage_name}/${aws_api_gateway_resource.driver_license_api_resource.path_part}"
}

output "status_endpoint_template" {
  description = "Template URL for submission status lookups."
  value       = "https://${aws_api_gateway_rest_api.driver_license_api.id}.execute-api.${local.region}.amazonaws.com/${aws_api_gateway_stage.driver_license_api_stage.stage_name}/${aws_api_gateway_resource.submissions_resource.path_part}/{submissionId}"
}

output "api_key_id" {
  description = "API Gateway API key identifier for clients."
  value       = aws_api_gateway_api_key.driver_license_client.id
}
