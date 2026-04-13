'use strict';

const { randomUUID } = require('node:crypto');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const { jsonResponse, normalizeInvocationEvent } = require('./index');
const { decodeBase64Document } = require('./storage');

function createIntakeHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const sqsClient = options.sqsClient || new SQSClient({});
  const documentClient = options.documentClient || DynamoDBDocumentClient.from(
    options.dynamoClient || new DynamoDBClient({})
  );
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || randomUUID;
  const bucketName = options.bucketName || process.env.INTAKE_BUCKET_NAME;
  const queueUrl = options.queueUrl || process.env.INTAKE_QUEUE_URL;
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;
  const uploadPrefix = options.uploadPrefix || process.env.UPLOAD_PREFIX || 'uploads';
  const submissionPrefix = options.submissionPrefix || process.env.SUBMISSION_PREFIX || 'submissions';
  const resultPrefix = options.resultPrefix || process.env.RESULT_PREFIX || 'results';

  return async function handler(event = {}) {
    try {
      if (!bucketName || !queueUrl || !tableName) {
        throw configurationError('INTAKE_BUCKET_NAME, INTAKE_QUEUE_URL, and SUBMISSION_TABLE_NAME must be configured.');
      }

      const payload = normalizeInvocationEvent(event);
      const submissionId = createId();
      const submittedAt = now();
      const objectKey = `${submissionPrefix}/${submissionId}.json`;
      const resultKey = `${resultPrefix}/${submissionId}.json`;
      let sourceImage = null;

      if (payload.imageBase64) {
        const decodedImage = decodeBase64Document(payload.imageBase64);
        const uploadKey = `${uploadPrefix}/${submissionId}.${decodedImage.extension}`;

        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: uploadKey,
          Body: decodedImage.buffer,
          ContentType: decodedImage.mimeType
        }));

        sourceImage = {
          bucket: bucketName,
          key: uploadKey,
          mimeType: decodedImage.mimeType
        };
      }

      const submissionRecord = {
        submissionId,
        submittedAt,
        payload: {
          ...payload,
          imageBase64: undefined
        },
        sourceImage
      };

      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: JSON.stringify(submissionRecord),
        ContentType: 'application/json'
      }));

      await documentClient.send(new PutCommand({
        TableName: tableName,
        Item: {
          submissionId,
          status: 'queued',
          submittedAt,
          queue: 'screening',
          submissionBucket: bucketName,
          submissionKey: objectKey,
          sourceImageKey: sourceImage ? sourceImage.key : null,
          resultKey,
          lastUpdatedAt: submittedAt
        }
      }));

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          submissionId,
          bucket: bucketName,
          objectKey,
          resultKey,
          tableName,
          sourceImage
        })
      }));

      return jsonResponse(202, {
        submissionId,
        status: 'queued',
        submittedAt,
        queue: 'screening',
        submissionLocation: `s3://${bucketName}/${objectKey}`,
        resultLocation: `s3://${bucketName}/${resultKey}`,
        sourceImageLocation: sourceImage ? `s3://${bucketName}/${sourceImage.key}` : null,
        statusEndpoint: `/submissions/${submissionId}`
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
