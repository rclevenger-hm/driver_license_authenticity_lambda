'use strict';

const assert = require('node:assert/strict');

const { createIntakeHandler } = require('../intake-handler');
const { createWorkerHandler } = require('../worker-handler');
const { createStatusHandler } = require('../status-handler');

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==';

async function main() {
  const s3Objects = new Map();
  const statusItems = new Map();
  const queuedMessages = [];

  const fakeS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'PutObjectCommand') {
        s3Objects.set(command.input.Key, command.input.Body);
        return {};
      }

      if (name === 'GetObjectCommand') {
        return {
          Body: s3Objects.get(command.input.Key)
        };
      }

      throw new Error(`Unsupported S3 command: ${name}`);
    }
  };

  const fakeDocumentClient = {
    async send(command) {
      const name = command.constructor.name;

      if (name === 'PutCommand') {
        statusItems.set(command.input.Item.submissionId, command.input.Item);
        return {};
      }

      if (name === 'UpdateCommand') {
        const current = statusItems.get(command.input.Key.submissionId) || {};
        const next = {
          ...current,
          status: command.input.ExpressionAttributeValues[':status'],
          lastUpdatedAt: command.input.ExpressionAttributeValues[':lastUpdatedAt'],
          resultKey: command.input.ExpressionAttributeValues[':resultKey'] || current.resultKey,
          reviewStatus: command.input.ExpressionAttributeValues[':reviewStatus'] || current.reviewStatus,
          analysisScore: command.input.ExpressionAttributeValues[':analysisScore'] || current.analysisScore
        };
        statusItems.set(command.input.Key.submissionId, next);
        return {};
      }

      if (name === 'GetCommand') {
        return {
          Item: statusItems.get(command.input.Key.submissionId)
        };
      }

      throw new Error(`Unsupported DynamoDB command: ${name}`);
    }
  };

  const fakeSqs = {
    async send(command) {
      queuedMessages.push(JSON.parse(command.input.MessageBody));
      return {};
    }
  };

  const intakeHandler = createIntakeHandler({
    s3Client: fakeS3,
    sqsClient: fakeSqs,
    documentClient: fakeDocumentClient,
    bucketName: 'smoke-bucket',
    queueUrl: 'https://example.invalid/queue',
    tableName: 'submission-status',
    createId: () => 'smoke-123',
    now: () => '2026-04-12T12:00:00.000Z'
  });

  const intakeResponse = await intakeHandler({
    body: JSON.stringify({
      imageBase64: SAMPLE_PNG_BASE64,
      ocrText: 'DRIVER LICENSE TX DOB 01/02/1990 ADDRESS 123 MAIN ST'
    })
  });
  const intakeBody = JSON.parse(intakeResponse.body);
  assert.equal(intakeResponse.statusCode, 202);
  assert.equal(intakeBody.submissionId, 'smoke-123');
  assert.equal(queuedMessages.length, 1);

  const workerHandler = createWorkerHandler({
    s3Client: fakeS3,
    documentClient: fakeDocumentClient,
    ocrExtractor: {
      async extractText() {
        return { text: '', source: 'disabled' };
      }
    },
    now: () => '2026-04-12T12:05:00.000Z'
  });

  const workerResponse = await workerHandler({
    Records: [
      {
        messageId: 'smoke-msg-1',
        body: JSON.stringify(queuedMessages[0])
      }
    ]
  });
  assert.deepEqual(workerResponse, { batchItemFailures: [] });

  const statusHandler = createStatusHandler({
    tableName: 'submission-status',
    documentClient: fakeDocumentClient
  });
  const statusResponse = await statusHandler({
    pathParameters: {
      submissionId: 'smoke-123'
    }
  });
  const statusBody = JSON.parse(statusResponse.body);

  assert.equal(statusResponse.statusCode, 200);
  assert.equal(statusBody.status, 'completed');
  assert.ok(statusBody.analysisScore > 0);

  console.log('Smoke test passed: intake -> queue -> worker -> status lookup');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
