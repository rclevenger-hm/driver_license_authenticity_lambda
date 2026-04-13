'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handler: screeningHandler, inspectImage, inspectOcrText } = require('./index');
const { createIntakeHandler } = require('./intake-handler');
const { createStatusHandler } = require('./status-handler');
const { createWorkerHandler } = require('./worker-handler');

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==';

test('direct screening handler still returns a pass result for plausible content', async () => {
  const event = {
    body: JSON.stringify({
      imageBase64: SAMPLE_PNG_BASE64,
      ocrText: 'DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C'
    })
  };

  const response = await screeningHandler(event);
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, 'pass');
  assert.ok(payload.score >= 75);
  assert.match(payload.disclaimer, /plausibility screening/i);
});

test('intake handler stores the submission and queues a worker job', async () => {
  const calls = [];
  const fakeS3 = {
    async send(command) {
      calls.push({ service: 's3', input: command.input });
      return {};
    }
  };
  const fakeSqs = {
    async send(command) {
      calls.push({ service: 'sqs', input: command.input });
      return {};
    }
  };
  const fakeDoc = {
    async send(command) {
      calls.push({ service: 'ddb', input: command.input });
      return {};
    }
  };
  const handler = createIntakeHandler({
    s3Client: fakeS3,
    sqsClient: fakeSqs,
    documentClient: fakeDoc,
    bucketName: 'intake-bucket',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/jobs',
    tableName: 'submission-status',
    createId: () => 'submission-123',
    now: () => '2026-04-12T12:00:00.000Z'
  });

  const response = await handler({
    body: JSON.stringify({
      imageBase64: SAMPLE_PNG_BASE64,
      ocrText: 'DRIVER LICENSE TX DOB 01/02/1990 ADDRESS 123 MAIN ST'
    })
  });

  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 202);
  assert.equal(payload.status, 'queued');
  assert.equal(payload.submissionId, 'submission-123');
  assert.equal(calls.length, 4);
  assert.equal(calls[0].service, 's3');
  assert.equal(calls[0].input.Bucket, 'intake-bucket');
  assert.match(calls[0].input.Key, /uploads\/submission-123\.png$/);
  assert.equal(calls[1].service, 's3');
  assert.match(calls[1].input.Key, /submissions\/submission-123\.json$/);
  assert.equal(calls[2].service, 'ddb');
  assert.equal(calls[2].input.TableName, 'submission-status');
  assert.equal(calls[3].service, 'sqs');
  assert.match(calls[3].input.MessageBody, /submission-123/);
  assert.match(payload.sourceImageLocation, /uploads\/submission-123\.png$/);
  assert.equal(payload.statusEndpoint, '/submissions/submission-123');
});

test('worker handler reads a queued submission and writes screening results', async () => {
  const writes = [];
  const statusUpdates = [];
  const fakeS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'GetObjectCommand') {
        if (command.input.Key === 'uploads/submission-123.png') {
          return {
            Body: Buffer.from(SAMPLE_PNG_BASE64, 'base64')
          };
        }

        return {
          Body: JSON.stringify({
            submissionId: 'submission-123',
            payload: {
              ocrText: 'DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C'
            },
            sourceImage: {
              bucket: 'intake-bucket',
              key: 'uploads/submission-123.png',
              mimeType: 'image/png'
            }
          })
        };
      }

      if (name === 'PutObjectCommand') {
        writes.push(command.input);
        return {};
      }

      throw new Error(`Unexpected command: ${name}`);
    }
  };
  const fakeDoc = {
    async send(command) {
      statusUpdates.push(command.input);
      return {};
    }
  };

  const handler = createWorkerHandler({
    s3Client: fakeS3,
    documentClient: fakeDoc,
    now: () => '2026-04-12T12:05:00.000Z'
  });

  const response = await handler({
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          submissionId: 'submission-123',
          bucket: 'intake-bucket',
          objectKey: 'submissions/submission-123.json',
          resultKey: 'results/submission-123.json',
          tableName: 'submission-status',
          sourceImage: {
            bucket: 'intake-bucket',
            key: 'uploads/submission-123.png',
            mimeType: 'image/png'
          }
        })
      }
    ]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].Bucket, 'intake-bucket');
  assert.equal(writes[0].Key, 'results/submission-123.json');
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0].TableName, 'submission-status');

  const storedResult = JSON.parse(writes[0].Body);
  assert.equal(storedResult.status, 'completed');
  assert.equal(storedResult.analysis.status, 'pass');
});

test('worker handler can enrich missing OCR text from the OCR extractor', async () => {
  const writes = [];
  const handler = createWorkerHandler({
    s3Client: {
      async send(command) {
        const name = command.constructor.name;
        if (name === 'GetObjectCommand') {
          if (command.input.Key === 'uploads/submission-ocr.png') {
            return {
              Body: Buffer.from(SAMPLE_PNG_BASE64, 'base64')
            };
          }

          return {
            Body: JSON.stringify({
              submissionId: 'submission-ocr',
              payload: {},
              sourceImage: {
                bucket: 'intake-bucket',
                key: 'uploads/submission-ocr.png',
                mimeType: 'image/png'
              }
            })
          };
        }

        if (name === 'PutObjectCommand') {
          writes.push(command.input);
          return {};
        }

        throw new Error(`Unexpected command: ${name}`);
      }
    },
    documentClient: {
      async send() {
        return {};
      }
    },
    ocrExtractor: {
      async extractText() {
        return {
          text: 'DRIVER LICENSE TX DOB 01/02/1990 ADDRESS 123 MAIN ST',
          source: 'textract'
        };
      }
    },
    now: () => '2026-04-12T12:05:00.000Z'
  });

  const response = await handler({
    Records: [
      {
        messageId: 'msg-ocr',
        body: JSON.stringify({
          submissionId: 'submission-ocr',
          bucket: 'intake-bucket',
          objectKey: 'submissions/submission-ocr.json',
          resultKey: 'results/submission-ocr.json',
          tableName: 'submission-status'
        })
      }
    ]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  const storedResult = JSON.parse(writes[0].Body);
  assert.equal(storedResult.ocr.source, 'textract');
  assert.ok(storedResult.analysis.score > 0);
});

test('worker handler reports failed queue items for retry', async () => {
  const statusUpdates = [];
  const handler = createWorkerHandler({
    s3Client: {
      async send() {
        throw new Error('boom');
      }
    },
    documentClient: {
      async send(command) {
        statusUpdates.push(command.input);
        return {};
      }
    }
  });

  const response = await handler({
    Records: [
      {
        messageId: 'msg-2',
        body: JSON.stringify({
          submissionId: 'bad',
          bucket: 'intake-bucket',
          objectKey: 'submissions/bad.json',
          tableName: 'submission-status'
        })
      }
    ]
  });

  assert.deepEqual(response, {
    batchItemFailures: [{ itemIdentifier: 'msg-2' }]
  });
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0].TableName, 'submission-status');
});

test('status handler returns stored submission state', async () => {
  const handler = createStatusHandler({
    tableName: 'submission-status',
    documentClient: {
      async send() {
        return {
          Item: {
            submissionId: 'submission-123',
            status: 'completed',
            reviewStatus: 'pass'
          }
        };
      }
    }
  });

  const response = await handler({
    pathParameters: {
      submissionId: 'submission-123'
    }
  });

  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.submissionId, 'submission-123');
  assert.equal(payload.status, 'completed');
});

test('extracts PNG dimensions correctly', () => {
  const image = inspectImage(SAMPLE_PNG_BASE64);

  assert.equal(image.supported, true);
  assert.equal(image.format, 'png');
  assert.equal(image.width, 600);
  assert.equal(image.height, 400);
  assert.equal(image.aspectRatio, 1.5);
});

test('scores OCR text down when core document signals are missing', () => {
  const analysis = inspectOcrText('hello world 04/03/2025 random content', {});

  assert.ok(analysis.scoreDelta < 0);
  assert.ok(analysis.warnings.length > 0);
});
