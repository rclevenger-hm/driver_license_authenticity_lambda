output "lambda_function_arn" {
  description = "ARN of the AWS Lambda function."
  value       = aws_lambda_function.driver_license_authenticity.arn
}

output "api_endpoint_url" {
  description = "URL of the API Gateway endpoint."
  value       = aws_api_gateway_rest_api.driver_license_api.invoke_url
}