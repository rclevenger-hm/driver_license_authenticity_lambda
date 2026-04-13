'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const { analyzeDocument, normalizePayload } = require('./screening');

function createWorkerHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const now = options.now || (() => new Date().toISOString());
  const defaultResultPrefix = options.resultPrefix || process.env.RESULT_PREFIX || 'results';

  return async function handler(event = {}) {
    const failures = [];

    for (const record of event.Records || []) {
      try {
        const message = parseJson(record.body, 'Queue record body must be valid JSON.');
        const submissionObject = await s3Client.send(new GetObjectCommand({
          Bucket: message.bucket,
          Key: message.objectKey
        }));

        const submissionRaw = await bodyToString(submissionObject.Body);
        const submission = parseJson(submissionRaw, 'Stored submission must be valid JSON.');
        const normalizedPayload = normalizePayload(submission.payload || submission);
        const analysis = analyzeDocument(normalizedPayload);
        const resultKey = message.resultKey || `${defaultResultPrefix}/${message.submissionId}.json`;

        await s3Client.send(new PutObjectCommand({
          Bucket: message.bucket,
          Key: resultKey,
          Body: JSON.stringify({
            submissionId: message.submissionId,
            status: 'completed',
            processedAt: now(),
            source: {
              bucket: message.bucket,
              objectKey: message.objectKey
            },
            analysis
          }),
          ContentType: 'application/json'
        }));
      } catch (error) {
        failures.push({
          itemIdentifier: record.messageId || record.messageID || 'unknown'
        });
      }
    }

    return {
      batchItemFailures: failures
    };
  };
}

async function bodyToString(body) {
  if (body == null) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8');
  }

  if (typeof body.transformToString === 'function') {
    return body.transformToString();
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  throw new Error('Unsupported S3 body type.');
}

function parseJson(value, errorMessage) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(errorMessage);
  }
}

module.exports = {
  bodyToString,
  createWorkerHandler,
  handler: createWorkerHandler()
};
