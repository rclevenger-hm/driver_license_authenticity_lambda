'use strict';

const { randomUUID } = require('node:crypto');
const dynalite = require('dynalite');
const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { createIntakeHandler } = require('../intake-handler');
const { createWorkerHandler } = require('../worker-handler');
const { createStatusHandler } = require('../status-handler');
const { createReconcileHandler } = require('../reconcile-handler');
const { getSubmission } = require('../submissions');

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==';
const TEXT = 'DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C';
const ALICE = { userArn: 'arn:aws:sts::111122223333:assumed-role/alice/session-one', caller: 'AROAALICE123:session-one' };
const BOB = { userArn: 'arn:aws:sts::111122223333:assumed-role/bob/session-one', caller: 'AROABOB456:session-one' };

function request(payload = { imageBase64: IMAGE, ocrText: TEXT }, key = randomUUID(), identity = ALICE) {
  return { body: JSON.stringify(payload), headers: { 'Idempotency-Key': key }, requestContext: { identity } };
}

function queueRecord(body, messageId = randomUUID(), receiveCount = 1) {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body), attributes: { ApproximateReceiveCount: String(receiveCount) } };
}

async function harness(t) {
  const server = dynalite({ createTableMs: 0 });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const client = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1
  });
  const documentClient = DynamoDBDocumentClient.from(client);
  const close = async () => { client.destroy(); await new Promise((resolve) => server.close(resolve)); };
  if (t) t.after(close);
  await client.send(new CreateTableCommand({
    TableName: 'submissions', BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'submissionId', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'lastUpdatedAt', AttributeType: 'S' }
    ],
    KeySchema: [{ AttributeName: 'submissionId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{
      IndexName: 'status-lastUpdatedAt-index', Projection: { ProjectionType: 'ALL' },
      KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'lastUpdatedAt', KeyType: 'RANGE' }]
    }]
  }));
  const objects = new Map();
  const sent = [];
  const reads = [];
  const s3Client = { async send(command) {
    const { Key, Body, IfNoneMatch } = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      if (IfNoneMatch === '*' && objects.has(Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      objects.set(Key, Body);
      return {};
    }
    reads.push(command.input);
    if (!objects.has(Key)) throw Object.assign(new Error('missing object'), { name: 'NoSuchKey' });
    return { Body: objects.get(Key) };
  } };
  const sqsClient = { async send(command) { sent.push(JSON.parse(command.input.MessageBody)); return { MessageId: randomUUID() }; } };
  let time = Date.parse('2026-10-06T00:00:00Z');
  const now = () => new Date(time).toISOString();
  const options = {
    documentClient, s3Client, sqsClient, bucketName: 'test-bucket',
    tableName: 'submissions', queueUrl: 'https://example.invalid/queue', now,
    ocrExtractor: { async extractText() { return { text: TEXT, source: 'textract' }; } }
  };
  return {
    objects, reads, sent, options, close, documentClient, s3Client, sqsClient,
    advance: (seconds) => { time += seconds * 1000; },
    intake: createIntakeHandler(options), worker: createWorkerHandler(options),
    status: (submissionId, identity = ALICE) => createStatusHandler(options)({ pathParameters: { submissionId }, requestContext: { identity } }),
    reconcile: createReconcileHandler(options),
    get: (id) => getSubmission(documentClient, 'submissions', id),
    async submit(event = request()) {
      const response = await createIntakeHandler(options)(event);
      const body = JSON.parse(response.body);
      return { response, body, id: body.submissionId, event };
    },
    async process(id, receiveCount = 1) {
      return createWorkerHandler(options)({ Records: [queueRecord({ submissionId: id }, 'message', receiveCount)] });
    }
  };
}

module.exports = { ALICE, BOB, IMAGE, TEXT, harness, queueRecord, request };
