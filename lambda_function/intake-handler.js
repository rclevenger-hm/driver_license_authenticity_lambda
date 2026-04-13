'use strict';

const { randomUUID } = require('node:crypto');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const { jsonResponse, normalizeInvocationEvent } = require('./index');

function createIntakeHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const sqsClient = options.sqsClient || new SQSClient({});
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || randomUUID;
  const bucketName = options.bucketName || process.env.INTAKE_BUCKET_NAME;
  const queueUrl = options.queueUrl || process.env.INTAKE_QUEUE_URL;
  const submissionPrefix = options.submissionPrefix || process.env.SUBMISSION_PREFIX || 'submissions';
  const resultPrefix = options.resultPrefix || process.env.RESULT_PREFIX || 'results';

  return async function handler(event = {}) {
    try {
      if (!bucketName || !queueUrl) {
        throw configurationError('INTAKE_BUCKET_NAME and INTAKE_QUEUE_URL must be configured.');
      }

      const payload = normalizeInvocationEvent(event);
      const submissionId = createId();
      const submittedAt = now();
      const objectKey = `${submissionPrefix}/${submissionId}.json`;
      const resultKey = `${resultPrefix}/${submissionId}.json`;

      const submissionRecord = {
        submissionId,
        submittedAt,
        payload
      };

      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: JSON.stringify(submissionRecord),
        ContentType: 'application/json'
      }));

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          submissionId,
          bucket: bucketName,
          objectKey,
          resultKey
        })
      }));

      return jsonResponse(202, {
        submissionId,
        status: 'queued',
        submittedAt,
        queue: 'screening',
        submissionLocation: `s3://${bucketName}/${objectKey}`,
        resultLocation: `s3://${bucketName}/${resultKey}`
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;

      return jsonResponse(statusCode, {
        error: error.message || 'Unable to queue screening request'
      });
    }
  };
}

function configurationError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  return error;
}

module.exports = {
  createIntakeHandler,
  handler: createIntakeHandler()
};
