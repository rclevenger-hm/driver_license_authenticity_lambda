"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { createInvocationLog } = require("./observability");
const { createIntakeHandler } = require("./intake-handler");
const { createStatusHandler } = require("./status-handler");
const { createWorkerHandler } = require("./worker-handler");
const { createReconcileHandler } = require("./reconcile-handler");
const {
  ALICE,
  BOB,
  IMAGE,
  TEXT,
  harness,
  queueRecord,
  request,
} = require("./fixtures/pipeline");

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const PRIVATE = "private-document-sentinel";
const outage = () =>
  Object.assign(new Error(PRIVATE), { name: PRIVATE, code: PRIVATE });
const named = (h, name) => h.logs.filter((entry) => entry.event === name);

test("log records allow only operational fields and trusted invocation IDs", () => {
  const logs = [];
  const log = createInvocationLog(
    {
      headers: { "X-Request-ID": PRIVATE },
      requestContext: {
        extendedRequestId: "gateway-request=",
        requestId: PRIVATE,
      },
    },
    { awsRequestId: REQUEST_ID },
    (line) => logs.push(JSON.parse(line)),
  );
  log("intake.accepted", {
    submissionId: "a".repeat(64),
    messageId: MESSAGE_ID,
    status: "queued",
    statusCode: 202,
    receiveCount: 2,
    body: TEXT,
    ownerId: PRIVATE,
    requestHash: PRIVATE,
    leaseToken: PRIVATE,
    error: outage(),
  });
  assert.deepEqual(logs[0], {
    service: "document-screening",
    event: "intake.accepted",
    lambdaRequestId: REQUEST_ID,
    apiRequestId: "gateway-request=",
    submissionId: "a".repeat(64),
    messageId: MESSAGE_ID,
    status: "queued",
    receiveCount: 2,
    statusCode: 202,
  });
  log(PRIVATE, { body: TEXT });
  assert.equal(logs.length, 1);
  createInvocationLog(
    { requestContext: { extendedRequestId: "invalid\nvalue" } },
    { awsRequestId: PRIVATE },
    (line) => logs.push(JSON.parse(line)),
  )("worker.failed", {
    submissionId: PRIVATE,
    messageId: PRIVATE,
    status: PRIVATE,
    stage: PRIVATE,
    receiveCount: Infinity,
    failed: -1,
    dispatched: "1",
    statusCode: 999,
  });
  assert.deepEqual(logs[1], {
    service: "document-screening",
    event: "worker.failed",
  });
});

test("intake, dispatch, worker and status correlate without changing queue or API schemas", async (t) => {
  const h = await harness(t);
  const send = h.sqsClient.send.bind(h.sqsClient);
  h.sqsClient.send = async (command) => {
    await send(command);
    return { MessageId: MESSAGE_ID };
  };
  const event = request(undefined, "sensitive-idempotency-key");
  event.requestContext.extendedRequestId = "intake-gateway=";
  const response = await createIntakeHandler(h.options)(event, {
    awsRequestId: REQUEST_ID,
  });
  const { submissionId } = JSON.parse(response.body);
  assert.deepEqual(h.sent, [{ submissionId }]);
  assert.equal(JSON.parse(response.body).lambdaRequestId, undefined);
  const record = queueRecord({ submissionId }, MESSAGE_ID);
  const worker = createWorkerHandler(h.options);
  assert.deepEqual(
    await worker({ Records: [record] }, { awsRequestId: OTHER_REQUEST_ID }),
    { batchItemFailures: [] },
  );
  await worker({ Records: [record] });
  await createStatusHandler(h.options)(
    {
      pathParameters: { submissionId },
      requestContext: { identity: ALICE, extendedRequestId: "status-gateway=" },
    },
    { awsRequestId: REQUEST_ID },
  );
  assert.deepEqual(
    h.logs.map((entry) => entry.event),
    [
      "dispatch.sent",
      "intake.accepted",
      "worker.claimed",
      "worker.completed",
      "worker.duplicate",
      "status.found",
    ],
  );
  assert.ok(h.logs.every((entry) => entry.submissionId === submissionId));
  assert.equal(named(h, "dispatch.sent")[0].messageId, MESSAGE_ID);
  assert.equal(named(h, "worker.completed")[0].messageId, MESSAGE_ID);
  assert.equal(
    named(h, "worker.completed")[0].lambdaRequestId,
    OTHER_REQUEST_ID,
  );
  assert.equal(named(h, "worker.completed")[0].apiRequestId, undefined);
  assert.equal(named(h, "status.found")[0].apiRequestId, "status-gateway=");
  const serialized = JSON.stringify(h.logs);
  for (const secret of [
    IMAGE,
    TEXT,
    ALICE.userArn,
    "sensitive-idempotency-key",
    "test-bucket",
    "analysisSummary",
    "reviewStatus",
  ])
    assert.ok(!serialized.includes(secret));
});

test("missing, foreign, ownerless and invalid status requests remain indistinguishable in logs", async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  await h.documentClient.send(
    new PutCommand({
      TableName: "submissions",
      Item: { submissionId: "e".repeat(64), status: "completed" },
    }),
  );
  h.logs.length = 0;
  for (const submissionId of [id, "f".repeat(64), "e".repeat(64), PRIVATE]) {
    const response = await createStatusHandler(h.options)({
      pathParameters: { submissionId },
      requestContext: { identity: BOB },
    });
    assert.equal(response.statusCode, 404);
  }
  assert.equal(h.logs.length, 4);
  assert.ok(
    h.logs.every(
      (entry) => JSON.stringify(entry) === JSON.stringify(h.logs[0]),
    ),
  );
  assert.deepEqual(h.logs[0], {
    service: "document-screening",
    event: "status.not_found",
    statusCode: 404,
  });
  await h.intake({ body: PRIVATE });
  assert.equal(named(h, "intake.failed")[0].statusCode, 401);
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("ambiguous enqueue is deferred and reconciliation connects the later delivery", async (t) => {
  const h = await harness(t);
  const send = h.sqsClient.send.bind(h.sqsClient);
  h.sqsClient.send = async (command) => {
    await send(command);
    throw outage();
  };
  const { id, response } = await h.submit();
  assert.equal(response.statusCode, 202);
  assert.equal(named(h, "dispatch.sent").length, 0);
  assert.equal(named(h, "dispatch.deferred")[0].submissionId, id);
  assert.equal((await h.get(id)).status, "dispatch_pending");
  h.sqsClient.send = async (command) => {
    await send(command);
    return { MessageId: MESSAGE_ID };
  };
  assert.deepEqual(await h.reconcile({}, { awsRequestId: REQUEST_ID }), {
    dispatched: 1,
    failed: 0,
  });
  assert.equal(named(h, "dispatch.sent")[0].submissionId, id);
  assert.equal(named(h, "dispatch.sent")[0].lambdaRequestId, REQUEST_ID);
  assert.equal(named(h, "reconcile.finished")[0].dispatched, 1);
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("confirmed enqueue is distinct from failed queued-state persistence", async (t) => {
  const h = await harness(t);
  const send = h.documentClient.send.bind(h.documentClient);
  h.documentClient.send = async (command) => {
    if (command.input.ExpressionAttributeValues?.[":queued"] === "queued")
      throw outage();
    return send(command);
  };
  const { id } = await h.submit();
  assert.equal((await h.get(id)).status, "dispatch_pending");
  assert.deepEqual(
    h.logs.map((entry) => entry.event),
    ["dispatch.sent", "dispatch.deferred", "intake.accepted"],
  );
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("mixed batches log failed state persistence without dropping retries or mixing IDs", async (t) => {
  const h = await harness(t);
  const bad = await h.submit();
  const good = await h.submit();
  const item = await h.get(bad.id);
  h.objects.delete(item.submissionKey);
  const send = h.documentClient.send.bind(h.documentClient);
  h.documentClient.send = async (command) => {
    if (
      command.input.ExpressionAttributeValues?.[":error"] ===
      "PROCESSING_FAILED"
    )
      throw outage();
    return send(command);
  };
  h.logs.length = 0;
  const result = await h.worker(
    {
      Records: [
        queueRecord({ submissionId: bad.id }, MESSAGE_ID, 5),
        queueRecord({ submissionId: good.id }, OTHER_MESSAGE_ID),
      ],
    },
    { awsRequestId: REQUEST_ID },
  );
  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: MESSAGE_ID }],
  });
  const failure = named(h, "worker.failed")[0];
  assert.equal(failure.submissionId, bad.id);
  assert.equal(failure.messageId, MESSAGE_ID);
  assert.equal(failure.receiveCount, 5);
  assert.equal(failure.stage, "load_submission");
  assert.equal(failure.status, undefined);
  assert.equal(named(h, "worker.failure_state_unrecorded").length, 1);
  assert.equal(named(h, "worker.completed")[0].submissionId, good.id);
  assert.equal(named(h, "worker.completed")[0].messageId, OTHER_MESSAGE_ID);
  assert.equal((await h.get(bad.id)).status, "processing");
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("worker logs persisted retry and terminal states, but only publishes confirmed completion", async (t) => {
  const h = await harness(t);
  const { id } = await h.submit();
  const send = h.documentClient.send.bind(h.documentClient);
  h.documentClient.send = async (command) => {
    if (command.input.ExpressionAttributeValues?.[":result"]) throw outage();
    return send(command);
  };
  for (const receiveCount of [1, 5]) {
    assert.deepEqual(
      await h.worker({
        Records: [queueRecord({ submissionId: id }, MESSAGE_ID, receiveCount)],
      }),
      { batchItemFailures: [{ itemIdentifier: MESSAGE_ID }] },
    );
  }
  assert.deepEqual(
    named(h, "worker.failed").map((entry) => entry.status),
    ["retrying", "failed"],
  );
  assert.ok(
    named(h, "worker.failed").every(
      (entry) => entry.stage === "publish_result",
    ),
  );
  assert.equal(named(h, "worker.completed").length, 0);
  assert.equal((await h.get(id)).status, "failed");
});

test("malformed queue messages are retryable without logging their body or invalid IDs", async (t) => {
  const h = await harness(t);
  await h.worker({
    Records: [
      queueRecord(PRIVATE, MESSAGE_ID),
      queueRecord({ submissionId: PRIVATE }, OTHER_MESSAGE_ID),
    ],
  });
  assert.equal(named(h, "worker.failed").length, 2);
  assert.ok(
    named(h, "worker.failed").every(
      (entry) => entry.stage === "validate_message" && !entry.submissionId,
    ),
  );
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("reconciliation logs continuing outages before preserving its failure signal", async (t) => {
  const h = await harness(t);
  h.sqsClient.send = async () => {
    throw outage();
  };
  const { id } = await h.submit();
  await assert.rejects(h.reconcile(), /Dispatch reconciliation failed/);
  assert.equal(named(h, "reconcile.failed")[0].submissionId, id);
  assert.equal(named(h, "reconcile.finished")[0].failed, 1);
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("logging failures never change acceptance, reconciliation, processing, status or retries", async (t) => {
  const h = await harness(t);
  const options = {
    ...h.options,
    log: () => {
      throw outage();
    },
  };
  const intake = createIntakeHandler(options);
  const send = h.sqsClient.send.bind(h.sqsClient);
  h.sqsClient.send = async () => {
    throw outage();
  };
  const response = await intake(request());
  assert.equal(response.statusCode, 202);
  const { submissionId } = JSON.parse(response.body);
  h.sqsClient.send = send;
  assert.deepEqual(await createReconcileHandler(options)(), {
    dispatched: 1,
    failed: 0,
  });
  const worker = createWorkerHandler(options);
  assert.deepEqual(
    await worker({ Records: [queueRecord({ submissionId }, MESSAGE_ID)] }),
    { batchItemFailures: [] },
  );
  assert.equal(
    (
      await createStatusHandler(options)({
        pathParameters: { submissionId },
        requestContext: { identity: ALICE },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    await worker({ Records: [queueRecord(PRIVATE, MESSAGE_ID)] }),
    { batchItemFailures: [{ itemIdentifier: MESSAGE_ID }] },
  );
});

test("concurrent and warm invocations keep independent correlation context", async (t) => {
  const h = await harness(t);
  const intake = createIntakeHandler(h.options);
  const first = request();
  first.requestContext.extendedRequestId = "first-request=";
  const responses = await Promise.all([
    intake(first, { awsRequestId: REQUEST_ID }),
    intake(request(), { awsRequestId: OTHER_REQUEST_ID }),
  ]);
  for (const [index, response] of responses.entries()) {
    const { submissionId } = JSON.parse(response.body);
    const entries = h.logs.filter(
      (entry) => entry.submissionId === submissionId,
    );
    assert.equal(entries.length, 2);
    assert.ok(
      entries.every(
        (entry) =>
          entry.lambdaRequestId === [REQUEST_ID, OTHER_REQUEST_ID][index],
      ),
    );
    assert.ok(
      entries.every(
        (entry) => entry.apiRequestId === ["first-request=", undefined][index],
      ),
    );
  }
  const warm = await intake(request());
  const { submissionId } = JSON.parse(warm.body);
  assert.ok(
    h.logs
      .filter((entry) => entry.submissionId === submissionId)
      .every((entry) => !entry.lambdaRequestId && !entry.apiRequestId),
  );
});

test("null invocation metadata does not make logging change error responses", async (t) => {
  const logs = [];
  createInvocationLog(null, null, (line) => logs.push(JSON.parse(line)))(
    "intake.failed",
    { statusCode: 503 },
  );
  assert.deepEqual(logs, [
    { service: "document-screening", event: "intake.failed", statusCode: 503 },
  ]);
  const h = await harness(t);
  assert.equal((await h.intake(null, null)).statusCode, 503);
});

test("reconciler query and rotation errors log a fixed stage and preserve the original exception", async (t) => {
  const h = await harness(t);
  const send = h.documentClient.send.bind(h.documentClient);
  const error = outage();
  h.documentClient.send = async () => {
    throw error;
  };
  await assert.rejects(h.reconcile(), (caught) => caught === error);
  assert.equal(named(h, "reconcile.failed")[0].stage, "query_pending");
  assert.equal(named(h, "reconcile.finished").length, 0);
  h.documentClient.send = send;
  h.sqsClient.send = async () => {
    throw error;
  };
  const { id } = await h.submit();
  h.documentClient.send = async (command) => {
    if (command.input.UpdateExpression === "SET lastUpdatedAt = :now")
      throw error;
    return send(command);
  };
  await assert.rejects(h.reconcile(), (caught) => caught === error);
  const last = named(h, "reconcile.failed").at(-1);
  assert.equal(last.stage, "rotate_pending");
  assert.equal(last.submissionId, id);
  assert.ok(!JSON.stringify(h.logs).includes(PRIVATE));
});

test("reconciler summaries distinguish exhausted, deadline and page-limited passes", async (t) => {
  const h = await harness(t);
  await h.reconcile();
  const documentClient = {
    send: async () => ({ Items: [{ submissionId: "a".repeat(64) }] }),
  };
  const deadline = createReconcileHandler({ ...h.options, documentClient });
  assert.deepEqual(
    await deadline({}, { getRemainingTimeInMillis: () => 9000 }),
    { dispatched: 0, failed: 0 },
  );
  documentClient.send = async () => ({
    Items: [],
    LastEvaluatedKey: { submissionId: "a".repeat(64) },
  });
  await createReconcileHandler({ ...h.options, documentClient, maxPages: 1 })();
  assert.deepEqual(
    named(h, "reconcile.finished").map((entry) => entry.stopReason),
    ["exhausted", "deadline", "page_limit"],
  );
});
