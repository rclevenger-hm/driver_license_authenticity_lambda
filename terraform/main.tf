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

  region                      = local.config.region
  intake_lambda_function_name = local.config.intake_lambda_function_name
  worker_lambda_function_name = local.config.worker_lambda_function_name
  api_gateway_name            = local.config.api_gateway_name
  api_resource_path           = local.config.api_resource_path
  stage_name                  = try(local.config.stage_name, "prod")
  bucket_name                 = local.config.bucket_name
  queue_name                  = local.config.queue_name
  submission_prefix           = "submissions"
  result_prefix               = "results"
}

provider "aws" {
  region = local.region
}

resource "terraform_data" "lambda_dependencies" {
  triggers_replace = [
    filemd5("${path.module}/../lambda_function/package.json"),
    filemd5("${path.module}/../lambda_function/package-lock.json")
  ]

  provisioner "local-exec" {
    command     = "npm ci --omit=dev"
    working_dir = "${path.module}/../lambda_function"
  }
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_function"
  output_path = "${path.module}/lambda_function.zip"

  depends_on = [terraform_data.lambda_dependencies]
}

resource "aws_s3_bucket" "intake_bucket" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_versioning" "intake_bucket_versioning" {
  bucket = aws_s3_bucket.intake_bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "intake_bucket_encryption" {
  bucket = aws_s3_bucket.intake_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "intake_bucket_access" {
  bucket                  = aws_s3_bucket.intake_bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_sqs_queue" "screening_dlq" {
  name                      = "${local.queue_name}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "screening_jobs" {
  name                       = local.queue_name
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.screening_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_iam_role" "intake_lambda_execution" {
  name = "${local.intake_lambda_function_name}-execution-role"

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

resource "aws_iam_role" "worker_lambda_execution" {
  name = "${local.worker_lambda_function_name}-execution-role"

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

resource "aws_iam_role_policy_attachment" "intake_basic_execution" {
  role       = aws_iam_role.intake_lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "worker_sqs_execution" {
  role       = aws_iam_role.worker_lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"
}

resource "aws_iam_policy" "intake_pipeline_access" {
  name = "${local.intake_lambda_function_name}-pipeline-access"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.intake_bucket.arn}/${local.submission_prefix}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage"
        ]
        Resource = aws_sqs_queue.screening_jobs.arn
      }
    ]
  })
}

resource "aws_iam_policy" "worker_pipeline_access" {
  name = "${local.worker_lambda_function_name}-pipeline-access"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = [
          "${aws_s3_bucket.intake_bucket.arn}/${local.submission_prefix}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.intake_bucket.arn}/${local.result_prefix}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "intake_pipeline_access" {
  role       = aws_iam_role.intake_lambda_execution.name
  policy_arn = aws_iam_policy.intake_pipeline_access.arn
}

resource "aws_iam_role_policy_attachment" "worker_pipeline_access" {
  role       = aws_iam_role.worker_lambda_execution.name
  policy_arn = aws_iam_policy.worker_pipeline_access.arn
}

resource "aws_lambda_function" "intake" {
  function_name    = local.intake_lambda_function_name
  runtime          = "nodejs20.x"
  handler          = "intake-handler.handler"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  role             = aws_iam_role.intake_lambda_execution.arn
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      NODE_ENV           = "production"
      INTAKE_BUCKET_NAME = aws_s3_bucket.intake_bucket.bucket
      INTAKE_QUEUE_URL   = aws_sqs_queue.screening_jobs.id
      SUBMISSION_PREFIX  = local.submission_prefix
      RESULT_PREFIX      = local.result_prefix
    }
  }
}

resource "aws_lambda_function" "worker" {
  function_name    = local.worker_lambda_function_name
  runtime          = "nodejs20.x"
  handler          = "worker-handler.handler"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  role             = aws_iam_role.worker_lambda_execution.arn
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      NODE_ENV      = "production"
      RESULT_PREFIX = local.result_prefix
    }
  }
}

resource "aws_lambda_event_source_mapping" "worker_queue_mapping" {
  event_source_arn = aws_sqs_queue.screening_jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
}

resource "aws_api_gateway_rest_api" "driver_license_api" {
  name        = local.api_gateway_name
  description = "API Gateway for driver license intake and async screening"
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
  uri                     = aws_lambda_function.intake.invoke_arn
}

resource "aws_lambda_permission" "allow_api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake.function_name
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
