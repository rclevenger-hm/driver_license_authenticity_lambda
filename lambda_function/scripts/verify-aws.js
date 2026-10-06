"use strict";

// Run only against a disposable stack. See docs/RELIABILITY_AND_ACCESS.md.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { SignatureV4 } = require("@smithy/signature-v4");
const { Hash } = require("@smithy/hash-node");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

function syntheticPng() {
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(600, 0);
  header.writeUInt32BE(400, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(600 * 3, 208)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(400).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function http({
  credentials,
  region,
  url,
  method = "GET",
  body,
  headers = {},
  service = "execute-api",
  signed = true,
}) {
  const target = new URL(url);
  const input = {
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    method,
    headers: {
      host: target.host,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const request = signed
    ? await new SignatureV4({
        credentials,
        region,
        service,
        sha256: Hash.bind(null, "sha256"),
      }).sign(input)
    : input;
  const response = await fetch(target, {
    method,
    body: input.body,
    headers: request.headers,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  return { code: response.status, body: await response.json() };
}

async function until(check, seconds, failure) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(5000);
  }
  throw new Error(failure);
}

async function main() {
  const { values } = parseArgs({
    options: {
      outputs: { type: "string" },
      "expected-bucket": { type: "string" },
      "other-profile": { type: "string" },
      "allow-failure-test": { type: "boolean" },
      timeout: { type: "string", default: "2400" },
    },
  });
  assert.ok(
    values.outputs &&
      values["expected-bucket"] &&
      values["other-profile"] &&
      values["allow-failure-test"],
    "Required: --outputs file --expected-bucket name --other-profile name --allow-failure-test",
  );
  const outputs = Object.fromEntries(
    Object.entries(JSON.parse(readFileSync(values.outputs, "utf8"))).map(
      ([key, item]) => [key, item.value],
    ),
  );
  assert.ok(
    ["dev", "test", "verification"].includes(outputs.verification_environment),
    "Use a disposable nonproduction stack.",
  );
  assert.equal(
    outputs.intake_bucket_name,
    values["expected-bucket"],
    "Expected bucket must match deployment outputs.",
  );
  const region = outputs.aws_region;
  const endpoint = new URL(outputs.api_endpoint_url);
  const domain = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  assert.equal(endpoint.protocol, "https:");
  assert.ok(
    endpoint.hostname.endsWith(`.execute-api.${region}.${domain}`),
    "Expected an API Gateway endpoint.",
  );
  const credentials = defaultProvider();
  const otherCredentials = defaultProvider({
    profile: values["other-profile"],
  });
  const s3 = new S3Client({ credentials, region });
  const sqs = new SQSClient({ credentials, region });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ credentials, region }),
  );
  try {
    const keyResponse = await http({
      credentials,
      region,
      service: "apigateway",
      url: `https://apigateway.${region}.${domain}/apikeys/${outputs.api_key_id}?includeValue=true`,
    });
    assert.equal(
      keyResponse.code,
      200,
      "Primary profile needs GetApiKey for this stack.",
    );
    const apiKey = keyResponse.body.value;
    const key = randomUUID();
    const payload = {
      documentType: "driver-license",
      imageBase64: syntheticPng().toString("base64"),
      ocrText:
        "SYNTHETIC TEST DRIVER LICENSE CA DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2030",
    };
    const submit = (body, signed = true) =>
      http({
        credentials,
        region,
        url: endpoint.href,
        method: "POST",
        body,
        signed,
        headers: { "x-api-key": apiKey, "Idempotency-Key": key },
      });
    assert.ok(
      [401, 403].includes((await submit(payload, false)).code),
      "Unsigned request was accepted.",
    );
    const accepted = await submit(payload);
    assert.equal(accepted.code, 202, "Signed intake failed.");
    const id = accepted.body.submissionId;
    const replay = await submit(payload);
    assert.ok([200, 202].includes(replay.code));
    assert.equal(replay.body.submissionId, id);
    assert.equal((await submit({ ocrText: "different" })).code, 409);
    const statusUrl = new URL(
      outputs.status_endpoint_template.replace("{submissionId}", id),
    );
    assert.equal(statusUrl.origin, endpoint.origin);
    const status = (who = credentials) =>
      http({
        credentials: who,
        region,
        url: statusUrl.href,
        headers: { "x-api-key": apiKey },
      });
    assert.equal(
      (await status(otherCredentials)).code,
      404,
      "Foreign caller must receive 404; ensure its invoke policy is attached.",
    );
    await until(
      async () => {
        const response = await status();
        assert.equal(response.code, 200);
        return response.body.status === "completed";
      },
      180,
      "Image submission did not complete.",
    );
    const get = async (submissionId) =>
      (
        await ddb.send(
          new GetCommand({
            TableName: outputs.submission_table_name,
            Key: { submissionId },
            ConsistentRead: true,
          }),
        )
      ).Item;
    const item = await get(id);
    const original = await s3.send(
      new GetObjectCommand({
        Bucket: outputs.intake_bucket_name,
        Key: item.sourceImageKey,
      }),
    );
    assert.deepEqual(
      Buffer.from(await original.Body.transformToByteArray()),
      syntheticPng(),
    );
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: outputs.intake_bucket_name,
        Key: item.resultKey,
      }),
    );
    assert.equal(
      JSON.parse(await result.Body.transformToString()).submissionId,
      id,
    );
    console.log(
      "PASS: signed upload, idempotency, ownership, and real S3 image processing.",
    );

    const poisonId = createHash("sha256")
      .update(`verification:${key}`)
      .digest("hex");
    const now = new Date().toISOString();
    await ddb.send(
      new PutCommand({
        TableName: outputs.submission_table_name,
        ConditionExpression: "attribute_not_exists(submissionId)",
        Item: {
          submissionId: poisonId,
          ownerId: `verification:${key}`,
          status: "queued",
          submittedAt: now,
          lastUpdatedAt: now,
          submissionBucket: outputs.intake_bucket_name,
          submissionKey: `submissions/${poisonId}/intentionally-missing.json`,
        },
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: outputs.screening_queue_url,
        MessageBody: JSON.stringify({ submissionId: poisonId }),
      }),
    );
    console.log(
      `Waiting for real retries and DLQ arrival. Synthetic submission: ${poisonId}`,
    );
    await until(
      async () => {
        const batch = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: outputs.screening_dlq_url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 10,
          }),
        );
        let found = false;
        for (const message of batch.Messages || []) {
          if (JSON.parse(message.Body).submissionId === poisonId) {
            const failed = await get(poisonId);
            assert.equal(failed.status, "failed");
            assert.ok(
              failed.attemptCount >= 5,
              "Expected at least five real worker attempts.",
            );
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: outputs.screening_dlq_url,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
            found = true;
          } else {
            await sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: outputs.screening_dlq_url,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            );
          }
        }
        return found;
      },
      Number(values.timeout),
      `DLQ check timed out. Inspect synthetic submission ${poisonId}.`,
    );
    console.log(
      "PASS: recorded retries, terminal failed status, and actual DLQ arrival.",
    );
    console.log(
      "Remove the disposable stack and its versioned synthetic objects using the documented cleanup procedure.",
    );
  } finally {
    s3.destroy();
    sqs.destroy();
    ddb.destroy();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { syntheticPng };
