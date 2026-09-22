resource "aws_cloudwatch_metric_alarm" "screening_dlq_messages" {
  alarm_name          = "${local.queue_name}-dlq-messages-visible"
  alarm_description   = "Screening jobs have exhausted normal retries and are visible in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    QueueName = aws_sqs_queue.screening_dlq.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "screening_queue_age" {
  alarm_name          = "${local.queue_name}-oldest-message-age"
  alarm_description   = "Screening work has remained queued for more than five minutes across two evaluation periods."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    QueueName = aws_sqs_queue.screening_jobs.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "intake_errors" {
  alarm_name          = "${local.intake_lambda_function_name}-errors"
  alarm_description   = "The request intake Lambda reported one or more invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    FunctionName = aws_lambda_function.intake.function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.worker_lambda_function_name}-errors"
  alarm_description   = "The asynchronous screening worker reported one or more Lambda invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "status_errors" {
  alarm_name          = "${local.status_lambda_function_name}-errors"
  alarm_description   = "The submission status Lambda reported one or more invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    FunctionName = aws_lambda_function.status.function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx_errors" {
  alarm_name          = "${local.api_gateway_name}-${local.stage_name}-5xx-errors"
  alarm_description   = "API Gateway returned one or more server-side 5xx responses for the screening API stage."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = try(local.config.alarm_action_arns, [])

  dimensions = {
    ApiName = aws_api_gateway_rest_api.driver_license_api.name
    Stage   = aws_api_gateway_stage.driver_license_api_stage.stage_name
  }

  tags = local.common_tags
}
