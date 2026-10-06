'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { createWorkerHandler } = require('./worker-handler');
const { callerOwner } = require('./submissions');
const { ALICE, BOB, IMAGE, TEXT, harness, queueRecord, request } = require('./fixtures/pipeline');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function failOnce(client, matches) {
  const send = client.send.bind(client);
  let failed = false;
  client.send = async (command) => {
    if (!failed && matches(command)) { failed = true; throw new Error('injected outage'); }
    return send(command);
  };
}

test('unsigned or body/header-spoofed callers are rejected before storage', async (t) => {
  const h = await harness(t);
  const event = request({ ocrText: TEXT, requestContext: { identity: ALICE }, ownerId: 'forged' });
  delete event.requestContext;
  event.headers['X-User-Arn'] = ALICE.userArn;
  assert.equal((await h.intake(event)).statusCode, 401);
  assert.equal((await h.status('a'.repeat(64), {})).statusCode, 401);
  assert.equal(h.objects.size, 0);
  assert.equal(h.sent.length, 0);
});

test('idempotency key validation rejects missing, repeated, and malformed values', async (t) => {
  const h = await harness(t);
  for (const headers of [{}, { 'Idempotency-Key': 'short' }, { 'Idempotency-Key': 'key with spaces' },
    { 'Idempotency-Key': 'valid-key', 'idempotency-key': 'other-key' }]) {
    assert.equal((await h.intake({ ...request(), headers })).statusCode, 400);
  }
  const event = request();
  event.multiValueHeaders = { 'Idempotency-Key': ['one-key-1', 'two-key-2'] };
  assert.equal((await h.intake(event)).statusCode, 400);
  assert.equal(h.objects.size, 0);
});

test('role sessions share ownership, but recreated roles and different accounts do not', () => {
  const owner = callerOwner({ requestContext: { identity: ALICE } });
  const second = { userArn: ALICE.userArn.replace('session-one', 'session-two'), caller: 'AROAALICE123:session-two' };
  assert.equal(callerOwner({ requestContext: { identity: second } }), owner);
  assert.notEqual(callerOwner({ requestContext: { identity: { ...ALICE, caller: 'AROANEW123:session-one' } } }), owner);
  assert.notEqual(callerOwner({ requestContext: { identity: { ...ALICE, userArn: ALICE.userArn.replace('111122223333', '444455556666') } } }), owner);
});

test('intake stores binary image, durable owner, and minimal queue reference', async (t) => {
  const h = await harness(t);
  const { response, body, id } = await h.submit();
  assert.equal(response.statusCode, 202);
  const item = await h.get(id);
  assert.equal(item.status, 'queued');
  assert.equal(item.ownerId, callerOwner({ requestContext: { identity: ALICE } }));
  assert.deepEqual(h.objects.get(item.sourceImageKey), Buffer.from(IMAGE, 'base64'));
  assert.equal(JSON.parse(h.objects.get(item.submissionKey)).payload.imageBase64, undefined);
  assert.deepEqual(h.sent, [{ submissionId: id }]);
  assert.equal(body.ownerId, undefined);
  assert.equal(body.submissionLocation, undefined);
});

test('duplicate intake returns the same submission without writing or enqueueing again', async (t) => {
  const h = await harness(t);
  const { event, id } = await h.submit();
  const count = h.objects.size;
  const duplicate = await h.submit(event);
  assert.equal(duplicate.id, id);
  assert.equal(h.objects.size, count);
  assert.equal(h.sent.length, 1);
  await h.process(id);
  assert.equal((await h.submit(event)).response.statusCode, 200);
});

test('canonical metadata ordering does not change the idempotency fingerprint', async (t) => {
  const h = await harness(t);
  const first = await h.submit(request({ ocrText: TEXT, metadata: { z: 1, a: 2 } }, 'stable-key'));
  const second = await h.submit(request({ ocrText: TEXT, metadata: { a: 2, z: 1 } }, 'stable-key'));
  assert.equal(second.id, first.id);
  assert.equal(second.response.statusCode, 202);
});

test('same key and different content conflicts without replacing accepted data', async (t) => {
  const h = await harness(t);
  const first = await h.submit(request({ ocrText: TEXT }, 'stable-key'));
  const item = await h.get(first.id);
  const original = h.objects.get(item.submissionKey);
  const conflict = await h.submit(request({ ocrText: 'different' }, 'stable-key'));
  assert.equal(conflict.response.statusCode, 409);
  assert.equal(h.objects.get(item.submissionKey), original);
  assert.equal(h.sent.length, 1);
});

test('simultaneous conflicting intake cannot overwrite the winning submission', async (t) => {
  const h = await harness(t);
  const results = await Promise.all([
    h.submit(request({ ocrText: TEXT }, 'racing-key')),
    h.submit(request({ ocrText: 'different' }, 'racing-key'))
  ]);
  assert.deepEqual(results.map((r) => r.response.statusCode).sort(), [202, 409]);
  const winner = results.find((r) => r.response.statusCode === 202);
  const item = await h.get(winner.id);
  assert.equal(JSON.parse(h.objects.get(item.submissionKey)).payload.ocrText, JSON.parse(winner.event.body).ocrText);
});

test('simultaneous duplicate intake has one identity and completes once', async (t) => {
  const h = await harness(t);
  const event = request();
  const results = await Promise.all([h.submit(event), h.submit(event)]);
  assert.equal(results[0].id, results[1].id);
  for (const message of h.sent) await h.process(message.submissionId);
  assert.equal((await h.get(results[0].id)).attemptCount, 1);
});

test('different callers using the same key receive separate submissions', async (t) => {
  const h = await harness(t);
  const alice = await h.submit(request({ ocrText: TEXT }, 'shared-key', ALICE));
  const bob = await h.submit(request({ ocrText: TEXT }, 'shared-key', BOB));
  assert.notEqual(alice.id, bob.id);
  assert.equal((await h.status(alice.id, BOB)).statusCode, 404);
  assert.equal((await h.status(alice.id, ALICE)).statusCode, 200);
});

test('status hides foreign, unknown, and legacy ownerless records and internal fields', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  const missing = await h.status('f'.repeat(64));
  assert.equal((await h.status(id, BOB)).body, missing.body);
  await h.documentClient.send(new PutCommand({ TableName: 'submissions', Item: { submissionId: 'e'.repeat(64), status: 'completed' } }));
  assert.equal((await h.status('e'.repeat(64))).body, missing.body);
  const body = JSON.parse((await h.status(id)).body);
  for (const name of ['ownerId', 'requestHash', 'submissionBucket', 'submissionKey', 'sourceImageKey', 'leaseToken', 'resultKey']) {
    assert.equal(body[name], undefined);
  }
});

test('failed upload is not acknowledged and retry with the same key recovers', async (t) => {
  const h = await harness(t);
  failOnce(h.s3Client, () => true);
  const event = request();
  assert.equal((await h.submit(event)).response.statusCode, 503);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.submit(event)).response.statusCode, 202);
});

test('failed durable write after S3 storage retries safely without overwriting objects', async (t) => {
  const h = await harness(t);
  failOnce(h.documentClient, (c) => c.constructor.name === 'PutCommand');
  const event = request();
  assert.equal((await h.submit(event)).response.statusCode, 503);
  const count = h.objects.size;
  assert.equal((await h.submit(event)).response.statusCode, 202);
  assert.equal(h.objects.size, count);
});

test('enqueue outage returns durable pending acceptance and scheduled reconciliation recovers', async (t) => {
  const h = await harness(t);
  failOnce(h.sqsClient, () => true);
  const { response, id } = await h.submit();
  assert.equal(response.statusCode, 202);
  assert.equal((await h.get(id)).status, 'dispatch_pending');
  await h.reconcile();
  assert.equal((await h.get(id)).status, 'queued');
  assert.deepEqual(await h.process(id), { batchItemFailures: [] });
});

test('enqueue success followed by status-write outage can be reconciled without duplicate processing', async (t) => {
  const h = await harness(t);
  failOnce(h.documentClient, (c) => c.input.UpdateExpression?.includes(':queued'));
  const { id } = await h.submit();
  assert.equal((await h.get(id)).status, 'dispatch_pending');
  await h.reconcile();
  assert.equal(h.sent.length, 2);
  await h.process(id);
  await h.process(id);
  assert.equal((await h.get(id)).attemptCount, 1);
});

test('ambiguous enqueue timeout cannot regress a worker that already completed', async (t) => {
  const h = await harness(t);
  const send = h.sqsClient.send.bind(h.sqsClient);
  h.sqsClient.send = async (command) => { await send(command); throw new Error('response lost'); };
  const { id } = await h.submit();
  await h.process(id);
  h.sqsClient.send = send;
  await h.reconcile();
  assert.equal(h.sent.length, 1);
  assert.equal((await h.get(id)).status, 'completed');
});

test('worker completion before dispatch status update stays completed', async (t) => {
  const h = await harness(t);
  h.sqsClient.send = async (command) => {
    await h.process(JSON.parse(command.input.MessageBody).submissionId);
    return {};
  };
  const { id } = await h.submit();
  assert.equal((await h.get(id)).status, 'completed');
});

test('duplicate worker delivery preserves result pointer, timestamps, and attempt count', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  await h.process(id);
  const before = await h.get(id);
  const count = h.objects.size;
  h.advance(100);
  await h.process(id);
  assert.deepEqual(await h.get(id), before);
  assert.equal(h.objects.size, count);
});

test('processing failure retries, then completes and removes the error', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  failOnce(h.s3Client, (c) => c.constructor.name === 'GetObjectCommand');
  assert.deepEqual(await h.process(id), { batchItemFailures: [{ itemIdentifier: 'message' }] });
  assert.equal((await h.get(id)).status, 'retrying');
  assert.deepEqual(await h.process(id, 2), { batchItemFailures: [] });
  const item = await h.get(id);
  assert.equal(item.status, 'completed');
  assert.equal(item.errorCode, undefined);
  assert.equal(item.attemptCount, 2);
});

test('last failed delivery is terminal in status but remains failed in the batch for DLQ handling', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  failOnce(h.s3Client, (c) => c.constructor.name === 'GetObjectCommand');
  assert.deepEqual(await h.process(id, 5), { batchItemFailures: [{ itemIdentifier: 'message' }] });
  assert.equal((await h.get(id)).status, 'failed');
  // An operator can redrive after repair; the source delivery counter restarts.
  await h.process(id);
  assert.equal((await h.get(id)).status, 'completed');
});

test('a second worker cannot process an active lease', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  const started = deferred();
  const resume = deferred();
  const send = h.s3Client.send.bind(h.s3Client);
  let paused = false;
  h.s3Client.send = async (command) => {
    if (!paused && command.constructor.name === 'GetObjectCommand') {
      paused = true; started.resolve(); await resume.promise;
    }
    return send(command);
  };
  const first = h.process(id);
  await started.promise;
  assert.deepEqual(await h.process(id), { batchItemFailures: [{ itemIdentifier: 'message' }] });
  resume.resolve();
  assert.deepEqual(await first, { batchItemFailures: [] });
  assert.equal((await h.get(id)).attemptCount, 1);
});

test('expired lease is reclaimed and a late worker cannot replace the published result', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  const started = deferred();
  const resume = deferred();
  const send = h.s3Client.send.bind(h.s3Client);
  let paused = false;
  h.s3Client.send = async (command) => {
    if (!paused && command.constructor.name === 'GetObjectCommand') {
      paused = true; started.resolve(); await resume.promise;
    }
    return send(command);
  };
  const stale = h.process(id);
  await started.promise;
  h.advance(91);
  assert.deepEqual(await h.process(id), { batchItemFailures: [] });
  const winner = await h.get(id);
  resume.resolve();
  assert.deepEqual(await stale, { batchItemFailures: [{ itemIdentifier: 'message' }] });
  assert.deepEqual(await h.get(id), winner);
  assert.equal(winner.attemptCount, 2);
});

test('expired lease cannot publish even when no replacement worker has arrived', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit(request({ imageBase64: IMAGE }));
  const worker = createWorkerHandler({ ...h.options, ocrExtractor: {
    async extractText() { h.advance(91); return { text: TEXT, source: 'textract' }; }
  } });
  assert.deepEqual(await worker({ Records: [queueRecord({ submissionId: id }, 'expired')] }), { batchItemFailures: [{ itemIdentifier: 'expired' }] });
  assert.equal((await h.get(id)).status, 'processing');
  await h.process(id);
  assert.equal((await h.get(id)).status, 'completed');
});

test('result publication failure creates no authoritative pointer and retry completes safely', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  failOnce(h.documentClient, (c) => c.input.UpdateExpression?.includes('resultKey ='));
  await h.process(id);
  assert.equal((await h.get(id)).resultKey, undefined);
  await h.process(id);
  const item = await h.get(id);
  assert.equal(item.status, 'completed');
  assert.ok(h.objects.has(item.resultKey));
  assert.equal([...h.objects.keys()].filter((key) => key.startsWith('results/')).length, 2);
});

test('mixed batch reports only failed records and processes later valid messages', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  const result = await h.worker({ Records: [queueRecord('{bad json', 'bad'), queueRecord({ submissionId: id }, 'good')] });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
  assert.equal((await h.get(id)).status, 'completed');
});

test('worker ignores queue-supplied bucket, table, source image, and result locations', async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  await h.worker({ Records: [queueRecord({ submissionId: id, bucket: 'foreign', tableName: 'foreign', objectKey: 'foreign', sourceImage: { bucket: 'foreign', key: 'foreign' }, resultKey: 'foreign' })] });
  assert.equal((await h.get(id)).status, 'completed');
  assert.ok(h.reads.every((read) => read.Bucket === 'test-bucket' && read.Key !== 'foreign'));
  assert.equal(h.objects.has('foreign'), false);
});

test('unknown and ownerless jobs cannot create or mutate submission state', async (t) => {
  const h = await harness(t);
  const id = 'f'.repeat(64);
  assert.deepEqual(await h.process(id), { batchItemFailures: [{ itemIdentifier: 'message' }] });
  assert.equal(await h.get(id), undefined);
  await h.documentClient.send(new PutCommand({ TableName: 'submissions', Item: { submissionId: id, status: 'queued', submissionBucket: 'test-bucket' } }));
  await h.process(id);
  assert.equal((await h.get(id)).status, 'queued');
});

test('reconciliation paginates pending submissions and leaves completed jobs untouched', async (t) => {
  const h = await harness(t);
  h.sqsClient.send = async () => { throw new Error('offline'); };
  const items = await Promise.all(Array.from({ length: 27 }, () => h.submit(request({ ocrText: TEXT }))));
  h.sqsClient.send = async (command) => { h.sent.push(JSON.parse(command.input.MessageBody)); return {}; };
  const summary = await h.reconcile();
  assert.equal(summary.dispatched, 27);
  assert.equal(h.sent.length, 27);
  for (const item of items) assert.equal((await h.get(item.id)).status, 'queued');
});

test('reconciliation exposes continuing outages for its Lambda error alarm', async (t) => {
  const h = await harness(t);
  h.sqsClient.send = async () => { throw new Error('offline'); };
  const { id } = await h.submit();
  h.advance(60);
  await assert.rejects(h.reconcile(), /Dispatch reconciliation failed/);
  assert.equal((await h.get(id)).status, 'dispatch_pending');
});


test('worker preserves image OCR, barcode enrichment, and passport support', async (t) => {
  const h = await harness(t);
  const cases = [
    { payload: { imageBase64: IMAGE }, check: (r) => assert.equal(r.ocr.source, 'textract') },
    { payload: { barcodeData: 'ANSI 636026080102\nDAQD1234567\nDAJTX\nDBB01021990\nDBD01012020\nDBA01012028\nDCAC' },
      check: (r) => assert.equal(r.barcode.fields.state, 'TX') },
    { payload: { documentType: 'passport', ocrText: 'PASSPORT Nationality USA Passport No 123456789' },
      check: (r) => assert.equal(r.analysis.documentType, 'passport') }
  ];
  for (const { payload, check } of cases) {
    const { id } = await h.submit(request(payload));
    assert.deepEqual(await h.process(id), { batchItemFailures: [] });
    const item = await h.get(id);
    check(JSON.parse(h.objects.get(item.resultKey)));
  }
});
