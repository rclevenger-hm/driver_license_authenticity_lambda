output "lambda_function_arn" {
  description = "ARN of the AWS Lambda function."
  value       = aws_lambda_function.driver_license_authenticity.arn
}

output "api_endpoint_url" {
  description = "URL of the API Gateway endpoint."
  value       = "https://${aws_api_gateway_rest_api.driver_license_api.id}.execute-api.${local.region}.amazonaws.com/${aws_api_gateway_stage.driver_license_api_stage.stage_name}/${aws_api_gateway_resource.driver_license_api_resource.path_part}"
}
