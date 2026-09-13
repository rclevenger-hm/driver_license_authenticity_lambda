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

  dimensions = {
    QueueName = aws_sqs_queue.screening_jobs.name
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

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }

  tags = local.common_tags
}
