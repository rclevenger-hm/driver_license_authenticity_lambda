terraform {
  required_version = ">= 1.5.0"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  config = jsondecode(file("${path.module}/config.json"))

  region               = local.config.region
  lambda_function_name = local.config.lambda_function_name
  api_gateway_name     = local.config.api_gateway_name
  api_resource_path    = local.config.api_resource_path
  stage_name           = try(local.config.stage_name, "prod")
}

provider "aws" {
  region = local.region
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_function"
  output_path = "${path.module}/lambda_function.zip"
}

resource "aws_iam_role" "lambda_execution" {
  name = "${local.lambda_function_name}-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "driver_license_authenticity" {
  function_name    = local.lambda_function_name
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  role             = aws_iam_role.lambda_execution.arn
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      NODE_ENV = "production"
    }
  }
}

resource "aws_api_gateway_rest_api" "driver_license_api" {
  name        = local.api_gateway_name
  description = "API Gateway for driver license plausibility screening"
}

resource "aws_api_gateway_resource" "driver_license_api_resource" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  parent_id   = aws_api_gateway_rest_api.driver_license_api.root_resource_id
  path_part   = local.api_resource_path
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

resource "aws_lambda_permission" "allow_api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.driver_license_authenticity.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.driver_license_api.execution_arn}/*/${aws_api_gateway_method.driver_license_api_method.http_method}${aws_api_gateway_resource.driver_license_api_resource.path}"
}

resource "aws_api_gateway_deployment" "driver_license_api_deployment" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id

  triggers = {
    redeployment = sha1(jsonencode({
      integration = aws_api_gateway_integration.driver_license_api_integration.id
      method      = aws_api_gateway_method.driver_license_api_method.id
      resource    = aws_api_gateway_resource.driver_license_api_resource.id
    }))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "driver_license_api_stage" {
  deployment_id = aws_api_gateway_deployment.driver_license_api_deployment.id
  rest_api_id   = aws_api_gateway_rest_api.driver_license_api.id
  stage_name    = local.stage_name
}
