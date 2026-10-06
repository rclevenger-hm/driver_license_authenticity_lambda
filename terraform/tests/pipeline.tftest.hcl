mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/test-role"
    }
  }
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::111122223333:policy/test-policy"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:111122223333:test-queue"
      id  = "https://sqs.us-east-1.amazonaws.com/111122223333/test-queue"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::test-bucket"
    }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:us-east-1:111122223333:table/test-submissions"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:111122223333:function:test-function"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:111122223333:function:test-function/invocations"
    }
  }
  mock_resource "aws_api_gateway_rest_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-east-1:111122223333:test-api"
    }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:us-east-1:111122223333:rule/test-dispatch"
    }
  }
}

mock_provider "archive" {}

# Prevent the packaging provisioner from changing the local dependency tree.
override_resource {
  target = terraform_data.lambda_dependencies
  values = { id = "test-dependencies" }
}

run "pipeline_contract" {
  command = apply

  assert {
    condition     = contains(aws_lambda_event_source_mapping.worker_queue_mapping.function_response_types, "ReportBatchItemFailures")
    error_message = "SQS must honor the worker's partial batch failures."
  }
  assert {
    condition     = aws_sqs_queue.screening_jobs.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout && tonumber(aws_lambda_function.worker.environment[0].variables.WORKER_LEASE_SECONDS) > aws_lambda_function.worker.timeout
    error_message = "Queue visibility and processing leases must outlive worker execution."
  }
  assert {
    condition     = aws_api_gateway_method.driver_license_api_method.authorization == "AWS_IAM" && aws_api_gateway_method.submission_status_method.authorization == "AWS_IAM"
    error_message = "Intake and status must authenticate callers."
  }
  assert {
    condition     = contains(jsondecode(aws_iam_policy.intake_pipeline_access.policy).Statement[0].Resource, "${aws_s3_bucket.intake_bucket.arn}/uploads/*") && contains(jsondecode(aws_iam_policy.worker_pipeline_access.policy).Statement[0].Resource, "${aws_s3_bucket.intake_bucket.arn}/uploads/*")
    error_message = "Intake writes and worker reads must cover uploaded images."
  }
  assert {
    condition     = length(jsondecode(aws_iam_policy.intake_pipeline_access.policy).Statement[0].Resource) == 2 && length(jsondecode(aws_iam_policy.worker_pipeline_access.policy).Statement[0].Resource) == 2
    error_message = "Image access must remain scoped to uploads and submissions."
  }
  assert {
    condition     = aws_lambda_function.dispatch.handler == "reconcile-handler.handler" && aws_cloudwatch_event_rule.dispatch_reconciliation.schedule_expression == "rate(1 minute)"
    error_message = "Durable pending work requires a scheduled reconciler."
  }
  assert {
    condition     = aws_lambda_function.worker.environment[0].variables.INTAKE_BUCKET_NAME == aws_s3_bucket.intake_bucket.bucket && aws_lambda_function.worker.environment[0].variables.SUBMISSION_TABLE_NAME == aws_dynamodb_table.submissions.name
    error_message = "Workers must use configured resources rather than queue-controlled locations."
  }
  assert {
    condition     = aws_lambda_function.intake.runtime == "nodejs22.x" && aws_lambda_function.worker.runtime == "nodejs22.x" && aws_lambda_function.status.runtime == "nodejs22.x" && aws_lambda_function.dispatch.runtime == "nodejs22.x"
    error_message = "Deployed runtimes must match the tested Node.js runtime."
  }
}
