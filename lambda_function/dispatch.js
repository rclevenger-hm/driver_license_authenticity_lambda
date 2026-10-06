"use strict";

const { SendMessageCommand } = require("@aws-sdk/client-sqs");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { conditionalFailure, getSubmission } = require("./submissions");

async function dispatchSubmission({
  documentClient,
  sqsClient,
  tableName,
  queueUrl,
  submissionId,
  now,
}) {
  const item = await getSubmission(documentClient, tableName, submissionId);
  if (!item || item.status !== "dispatch_pending") return item;

  // DynamoDB is the durable dispatch record. A timeout after SendMessage can
  // cause duplicate delivery, which the worker's conditional lease tolerates.
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ submissionId }),
    }),
  );
  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { submissionId },
        UpdateExpression: "SET #status = :queued, lastUpdatedAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":queued": "queued",
          ":pending": "dispatch_pending",
          ":now": now(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return response.Attributes;
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    // A worker may complete before the dispatcher records successful enqueue.
    return getSubmission(documentClient, tableName, submissionId);
  }
}

module.exports = { dispatchSubmission };
