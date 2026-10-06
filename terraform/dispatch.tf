resource "aws_iam_role" "dispatch_execution" {
  name = "${local.intake_lambda_function_name}-dispatch-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dispatch_basic_execution" {
  role       = aws_iam_role.dispatch_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "dispatch_access" {
  name = "dispatch-pending-submissions"
  role = aws_iam_role.dispatch_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${aws_dynamodb_table.submissions.arn}/index/status-lastUpdatedAt-index"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.submissions.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.screening_jobs.arn
      }
    ]
  })
}

resource "aws_lambda_function" "dispatch" {
  function_name                  = "${local.intake_lambda_function_name}-dispatch"
  runtime                        = "nodejs22.x"
  handler                        = "reconcile-handler.handler"
  filename                       = data.archive_file.lambda_zip.output_path
  source_code_hash               = data.archive_file.lambda_zip.output_base64sha256
  role                           = aws_iam_role.dispatch_execution.arn
  timeout                        = 60
  memory_size                    = 256
  reserved_concurrent_executions = 1
  environment {
    variables = {
      SUBMISSION_TABLE_NAME = aws_dynamodb_table.submissions.name
      INTAKE_QUEUE_URL      = aws_sqs_queue.screening_jobs.id
    }
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "dispatch" {
  name              = "/aws/lambda/${aws_lambda_function.dispatch.function_name}"
  retention_in_days = local.log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_event_rule" "dispatch_reconciliation" {
  name                = "${local.intake_lambda_function_name}-dispatch"
  schedule_expression = "rate(1 minute)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "dispatch_reconciliation" {
  rule       = aws_cloudwatch_event_rule.dispatch_reconciliation.name
  arn        = aws_lambda_function.dispatch.arn
  depends_on = [aws_lambda_permission.dispatch_schedule, aws_iam_role_policy.dispatch_access]
}

resource "aws_lambda_permission" "dispatch_schedule" {
  statement_id  = "AllowScheduledDispatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatch.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dispatch_reconciliation.arn
}

resource "aws_cloudwatch_metric_alarm" "dispatch_errors" {
  alarm_name          = "${local.intake_lambda_function_name}-dispatch-errors"
  alarm_description   = "Durably accepted submissions could not be dispatched."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])
  dimensions          = { FunctionName = aws_lambda_function.dispatch.function_name }
  tags                = local.common_tags
}
