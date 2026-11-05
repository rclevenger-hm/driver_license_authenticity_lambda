"use strict";

const { SQSClient } = require("@aws-sdk/client-sqs");
const { QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { dispatchSubmission } = require("./dispatch");
const { createInvocationLog } = require("./observability");
const { conditionalFailure, documentClientFor } = require("./submissions");

function createReconcileHandler(options = {}) {
  const documentClient = documentClientFor(options);
  const sqsClient = options.sqsClient || new SQSClient({});
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;
  const queueUrl = options.queueUrl || process.env.INTAKE_QUEUE_URL;
  const now = options.now || (() => new Date().toISOString());
  const maxPages = options.maxPages || 10;

  return async function handler(_event = {}, context = {}) {
    const log = createInvocationLog(_event, context, options.log);
    if (!tableName || !queueUrl)
      throw new Error("Dispatch configuration is missing.");
    const summary = { dispatched: 0, failed: 0 };
    const finish = (stopReason) => {
      log("reconcile.finished", { ...summary, stopReason });
      if (summary.failed)
        throw new Error(
          `Dispatch reconciliation failed for ${summary.failed} submission(s).`,
        );
      return summary;
    };
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      let response;
      try {
        response = await documentClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "status-lastUpdatedAt-index",
            KeyConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":pending": "dispatch_pending" },
            Limit: 25,
            ExclusiveStartKey: cursor,
          }),
        );
      } catch (error) {
        log("reconcile.failed", { stage: "query_pending" });
        throw error;
      }
      for (const item of response.Items || []) {
        if (
          context.getRemainingTimeInMillis &&
          context.getRemainingTimeInMillis() < 10000
        )
          return finish("deadline");
        try {
          const current = await dispatchSubmission({
            documentClient,
            sqsClient,
            tableName,
            queueUrl,
            submissionId: item.submissionId,
            now,
            log,
          });
          if (current && current.status !== "dispatch_pending")
            summary.dispatched += 1;
        } catch (error) {
          log("reconcile.failed", {
            submissionId: item.submissionId,
            stage: "dispatch",
          });
          summary.failed += 1;
          // Rotate failed records behind older work so one poison record cannot
          // starve the bounded scheduled query. Do not regress worker state.
          try {
            await documentClient.send(
              new UpdateCommand({
                TableName: tableName,
                Key: { submissionId: item.submissionId },
                UpdateExpression: "SET lastUpdatedAt = :now",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":now": now(),
                  ":pending": "dispatch_pending",
                },
              }),
            );
          } catch (updateError) {
            if (!conditionalFailure(updateError)) {
              log("reconcile.failed", {
                submissionId: item.submissionId,
                stage: "rotate_pending",
              });
              throw updateError;
            }
          }
        }
      }
      cursor = response.LastEvaluatedKey;
      if (!cursor) break;
    }
    return finish(cursor ? "page_limit" : "exhausted");
  };
}

module.exports = { createReconcileHandler, handler: createReconcileHandler() };
