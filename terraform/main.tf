locals {
  config = jsondecode(file("${path.module}/config.json"))

  region = local.config.region
  lambda_function_name = local.config.lambda_function_name
  api_gateway_name = local.config.api_gateway_name
  api_resource_path = local.config.api_resource_path
}

# Configure the AWS provider
provider "aws" {
  region = local.region
}

# AWS Lambda function
resource "aws_lambda_function" "driver_license_authenticity" {
  function_name    = local.lambda_function_name
  runtime          = "nodejs14.x"
  handler          = "index.handler"
  filename         = "lambda_function.zip"
  source_code_hash = filebase64sha256("lambda_function.zip")

  # Optional: Set environment variables if required
  # environment {
  #   variables = {
  #     EXAMPLE_ENV_VAR = "example-value"
  #   }
  # }

  # Optional: Define IAM role for the Lambda function
  # role = aws_iam_role.lambda_role.arn
}

# Optional: IAM Role for the Lambda function (if not using an existing role)
# resource "aws_iam_role" "lambda_role" {
#   name = "lambda-driver-license-authenticity-role"
#   assume_role_policy = jsonencode({
#     Version = "2012-10-17"
#     Statement = [
#       {
#         Action = "sts:AssumeRole"
#         Effect = "Allow"
#         Principal = {
#           Service = "lambda.amazonaws.com"
#         }
#       }
#     ]
#   })
# }

# Optional: IAM Policy for the Lambda function (if not using an existing policy)
# resource "aws_iam_policy" "lambda_policy" {
#   name = "lambda-driver-license-authenticity-policy"
#   policy = jsonencode({
#     Version = "2012-10-17"
#     Statement = [
#       {
#         Action = [
#           "comprehend:DetectText",  # Replace with the necessary actions for OCR
#           "comprehend:DetectDocumentText"
#         ]
#         Effect   = "Allow"
#         Resource = "*"
#       }
#     ]
#   })
# }

# Optional: Attach the policy to the Lambda role (if not using an existing policy)
# resource "aws_iam_role_policy_attachment" "lambda_policy_attachment" {
#   policy_arn = aws_iam_policy.lambda_policy.arn
#   role       = aws_iam_role.lambda_role.name
# }

# API Gateway
resource "aws_api_gateway_rest_api" "driver_license_api" {
  name        = local.api_gateway_name
  description = "API Gateway for driver's license authenticity validation"
}

resource "aws_api_gateway_resource" "driver_license_api_resource" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  parent_id   = aws_api_gateway_rest_api.driver_license_api.root_resource_id
  path_part   = "validate-license"
}

resource "aws_api_gateway_method" "driver_license_api_method" {
  rest_api_id   = aws_api_gateway_rest_api.driver_license_api.id
  resource_id   = aws_api_gateway_resource.driver_license_api_resource.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "driver_license_api_integration" {
  rest_api_id             = aws_api_gateway_rest_api.driver_license_api.id
  resource_id             = aws_api_gateway_resource.driver_license_api_resource.id
  http_method             = aws_api_gateway_method.driver_license_api_method.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.driver_license_authenticity.invoke_arn
}

resource "aws_api_gateway_method_response" "driver_license_api_method_response" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  resource_id = aws_api_gateway_resource.driver_license_api_resource.id
  http_method = aws_api_gateway_method.driver_license_api_method.http_method

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_integration_response" "driver_license_api_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  resource_id = aws_api_gateway_resource.driver_license_api_resource.id
  http_method = aws_api_gateway_method.driver_license_api_method.http_method

  response_templates = {
    "application/json" = ""
  }
}

# Optional: Define any additional resources, such as API deployment and domain name mapping.

# Output the API Gateway endpoint URL
output "api_endpoint_url" {
  value = aws_api_gateway_rest_api.driver_license_api.invoke_url
}
