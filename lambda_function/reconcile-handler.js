'use strict';

const { SQSClient } = require('@aws-sdk/client-sqs');
const { QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { dispatchSubmission } = require('./dispatch');
const { conditionalFailure, documentClientFor } = require('./submissions');

function createReconcileHandler(options = {}) {
  const documentClient = documentClientFor(options);
  const sqsClient = options.sqsClient || new SQSClient({});
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;
  const queueUrl = options.queueUrl || process.env.INTAKE_QUEUE_URL;
  const now = options.now || (() => new Date().toISOString());
  const maxPages = options.maxPages || 10;

  return async function handler(_event = {}, context = {}) {
    if (!tableName || !queueUrl) throw new Error('Dispatch configuration is missing.');
    const summary = { dispatched: 0, failed: 0 };
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await documentClient.send(new QueryCommand({
        TableName: tableName, IndexName: 'status-lastUpdatedAt-index',
        KeyConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': 'dispatch_pending' },
        Limit: 25, ExclusiveStartKey: cursor
      }));
      for (const item of response.Items || []) {
        if (context.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < 10000) return summary;
        try {
          const current = await dispatchSubmission({ documentClient, sqsClient, tableName, queueUrl, submissionId: item.submissionId, now });
          if (current && current.status !== 'dispatch_pending') summary.dispatched += 1;
        } catch (error) {
          summary.failed += 1;
          // Rotate failed records behind older work so one poison record cannot
          // starve the bounded scheduled query. Do not regress worker state.
          try {
            await documentClient.send(new UpdateCommand({
              TableName: tableName, Key: { submissionId: item.submissionId },
              UpdateExpression: 'SET lastUpdatedAt = :now',
              ConditionExpression: '#status = :pending',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':now': now(), ':pending': 'dispatch_pending' }
            }));
          } catch (updateError) {
            if (!conditionalFailure(updateError)) throw updateError;
          }
        }
      }
      cursor = response.LastEvaluatedKey;
      if (!cursor) break;
    }
    if (summary.failed) throw new Error(`Dispatch reconciliation failed for ${summary.failed} submission(s).`);
    return summary;
  };
}

module.exports = { createReconcileHandler, handler: createReconcileHandler() };
