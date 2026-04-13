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
  name_suffix = trimspace(try(local.config.name_suffix, ""))
  suffix      = local.name_suffix != "" ? "-${local.name_suffix}" : ""

  region                      = local.config.region
  intake_lambda_function_name = "${local.config.intake_lambda_function_name}${local.suffix}"
  worker_lambda_function_name = "${local.config.worker_lambda_function_name}${local.suffix}"
  status_lambda_function_name = "${local.config.status_lambda_function_name}${local.suffix}"
  api_gateway_name            = "${local.config.api_gateway_name}${local.suffix}"
  api_resource_path           = local.config.api_resource_path
  stage_name                  = try(local.config.stage_name, "prod")
  bucket_name                 = "${local.config.bucket_name}${local.suffix}"
  queue_name                  = "${local.config.queue_name}${local.suffix}"
  submission_table_name       = "${local.config.submission_table_name}${local.suffix}"
  enable_textract_ocr         = try(local.config.enable_textract_ocr, true)
  log_retention_days          = try(local.config.log_retention_days, 14)
  submission_retention_days   = try(local.config.submission_retention_days, 30)
  result_retention_days       = try(local.config.result_retention_days, 180)
  submission_prefix           = "submissions"
  result_prefix               = "results"
  common_tags                 = try(local.config.tags, {})
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
  tags   = local.common_tags
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

resource "aws_s3_bucket_lifecycle_configuration" "intake_bucket_lifecycle" {
  bucket = aws_s3_bucket.intake_bucket.id

  rule {
    id     = "expire-submissions"
    status = "Enabled"

    filter {
      prefix = "${local.submission_prefix}/"
    }

    expiration {
      days = local.submission_retention_days
    }
  }

  rule {
    id     = "expire-results"
    status = "Enabled"

    filter {
      prefix = "${local.result_prefix}/"
    }

    expiration {
      days = local.result_retention_days
    }
  }
}

resource "aws_sqs_queue" "screening_dlq" {
  name                      = "${local.queue_name}-dlq"
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "screening_jobs" {
  name                       = local.queue_name
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  tags                       = local.common_tags

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.screening_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_dynamodb_table" "submissions" {
  name         = local.submission_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "submissionId"
  tags         = local.common_tags

  attribute {
    name = "submissionId"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "lastUpdatedAt"
    type = "S"
  }

  attribute {
    name = "reviewStatus"
    type = "S"
  }

  attribute {
    name = "processedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "status-lastUpdatedAt-index"
    hash_key        = "status"
    range_key       = "lastUpdatedAt"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "reviewStatus-processedAt-index"
    hash_key        = "reviewStatus"
    range_key       = "processedAt"
    projection_type = "ALL"
  }
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

resource "aws_iam_role" "status_lambda_execution" {
  name = "${local.status_lambda_function_name}-execution-role"

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

resource "aws_iam_role_policy_attachment" "status_basic_execution" {
  role       = aws_iam_role.status_lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
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
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem"
        ]
        Resource = aws_dynamodb_table.submissions.arn
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
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.submissions.arn
      },
      {
        Effect = "Allow"
        Action = [
          "textract:DetectDocumentText"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_policy" "status_pipeline_access" {
  name = "${local.status_lambda_function_name}-pipeline-access"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem"
        ]
        Resource = aws_dynamodb_table.submissions.arn
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

resource "aws_iam_role_policy_attachment" "status_pipeline_access" {
  role       = aws_iam_role.status_lambda_execution.name
  policy_arn = aws_iam_policy.status_pipeline_access.arn
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
      SUBMISSION_TABLE_NAME = aws_dynamodb_table.submissions.name
      SUBMISSION_PREFIX  = local.submission_prefix
      RESULT_PREFIX      = local.result_prefix
    }
  }

  tags = local.common_tags
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
      NODE_ENV              = "production"
      RESULT_PREFIX         = local.result_prefix
      SUBMISSION_TABLE_NAME = aws_dynamodb_table.submissions.name
      ENABLE_TEXTRACT_OCR   = local.enable_textract_ocr ? "true" : "false"
    }
  }

  tags = local.common_tags
}

resource "aws_lambda_function" "status" {
  function_name    = local.status_lambda_function_name
  runtime          = "nodejs20.x"
  handler          = "status-handler.handler"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  role             = aws_iam_role.status_lambda_execution.arn
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      NODE_ENV              = "production"
      SUBMISSION_TABLE_NAME = aws_dynamodb_table.submissions.name
    }
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "intake" {
  name              = "/aws/lambda/${aws_lambda_function.intake.function_name}"
  retention_in_days = local.log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${aws_lambda_function.worker.function_name}"
  retention_in_days = local.log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "status" {
  name              = "/aws/lambda/${aws_lambda_function.status.function_name}"
  retention_in_days = local.log_retention_days
  tags              = local.common_tags
}

resource "aws_lambda_event_source_mapping" "worker_queue_mapping" {
  event_source_arn = aws_sqs_queue.screening_jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
}

resource "aws_api_gateway_rest_api" "driver_license_api" {
  name        = local.api_gateway_name
  description = "API Gateway for driver license intake and async screening"
  tags        = local.common_tags
}

resource "aws_api_gateway_resource" "driver_license_api_resource" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  parent_id   = aws_api_gateway_rest_api.driver_license_api.root_resource_id
  path_part   = local.api_resource_path
}

resource "aws_api_gateway_resource" "submissions_resource" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  parent_id   = aws_api_gateway_rest_api.driver_license_api.root_resource_id
  path_part   = "submissions"
}

resource "aws_api_gateway_resource" "submission_id_resource" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id
  parent_id   = aws_api_gateway_resource.submissions_resource.id
  path_part   = "{submissionId}"
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

resource "aws_api_gateway_method" "submission_status_method" {
  rest_api_id   = aws_api_gateway_rest_api.driver_license_api.id
  resource_id   = aws_api_gateway_resource.submission_id_resource.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "submission_status_integration" {
  rest_api_id             = aws_api_gateway_rest_api.driver_license_api.id
  resource_id             = aws_api_gateway_resource.submission_id_resource.id
  http_method             = aws_api_gateway_method.submission_status_method.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.status.invoke_arn
}

resource "aws_lambda_permission" "allow_api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.driver_license_api.execution_arn}/*/${aws_api_gateway_method.driver_license_api_method.http_method}${aws_api_gateway_resource.driver_license_api_resource.path}"
}

resource "aws_lambda_permission" "allow_api_gateway_status" {
  statement_id  = "AllowStatusExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.driver_license_api.execution_arn}/*/${aws_api_gateway_method.submission_status_method.http_method}${aws_api_gateway_resource.submission_id_resource.path}"
}

resource "aws_api_gateway_deployment" "driver_license_api_deployment" {
  rest_api_id = aws_api_gateway_rest_api.driver_license_api.id

  triggers = {
    redeployment = sha1(jsonencode({
      integration = aws_api_gateway_integration.driver_license_api_integration.id
      status_integration = aws_api_gateway_integration.submission_status_integration.id
      method      = aws_api_gateway_method.driver_license_api_method.id
      status_method = aws_api_gateway_method.submission_status_method.id
      resource    = aws_api_gateway_resource.driver_license_api_resource.id
      status_resource = aws_api_gateway_resource.submission_id_resource.id
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
  tags          = local.common_tags
}
