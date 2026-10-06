"use strict";

const { createHash } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

function documentClientFor(options) {
  return (
    options.documentClient ||
    DynamoDBDocumentClient.from(options.dynamoClient || new DynamoDBClient({}))
  );
}

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function callerOwner(event) {
  // Only API Gateway's IAM-authenticated context is trusted. Never read identity
  // from the request body, query string, or client-supplied headers.
  const identity = event.requestContext && event.requestContext.identity;
  const arn = identity && identity.userArn;
  if (typeof arn !== "string") {
    throw httpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "An IAM-signed request is required.",
    );
  }
  const role = arn.match(
    /^arn:([^:]+):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/,
  );
  const user = arn.match(/^arn:([^:]+):iam::(\d{12}):user\/.+$/);
  if (!role && !user) {
    throw httpError(
      403,
      "UNSUPPORTED_PRINCIPAL",
      "Use an IAM user or assumed role.",
    );
  }
  // All sessions of one role share ownership; separate consumers need separate
  // roles. IAM's stable principal ID prevents ownership surviving role recreation.
  const principalId = identity.caller && identity.caller.split(":")[0];
  if (!principalId || !/^(AIDA|AROA)[A-Z0-9]+$/.test(principalId)) {
    throw httpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated principal ID is required.",
    );
  }
  return sha256(`${(role || user)[1]}:${(role || user)[2]}:${principalId}`);
}

function idempotencyKey(event) {
  const entries = Object.entries(event.headers || {}).filter(
    ([key]) => key.toLowerCase() === "idempotency-key",
  );
  const multi = Object.entries(event.multiValueHeaders || {}).filter(
    ([key]) => key.toLowerCase() === "idempotency-key",
  );
  if (
    entries.length > 1 ||
    multi.length > 1 ||
    multi.some(([, values]) => !Array.isArray(values) || values.length !== 1)
  ) {
    throw httpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Provide exactly one Idempotency-Key header.",
    );
  }
  const key = entries.length
    ? entries[0][1]
    : multi.length
      ? multi[0][1][0]
      : null;
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(key) ||
    (multi.length && multi[0][1][0] !== key)
  ) {
    throw httpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return key;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function getSubmission(client, tableName, submissionId) {
  const response = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { submissionId },
      ConsistentRead: true,
    }),
  );
  return response.Item;
}

function conditionalFailure(error) {
  return error.name === "ConditionalCheckFailedException";
}

function publicStatus(item) {
  const allowed = [
    "submissionId",
    "status",
    "submissionType",
    "submittedAt",
    "lastUpdatedAt",
    "processedAt",
    "analysisSummary",
    "analysisScore",
    "reviewStatus",
    "warningsCount",
    "findingsCount",
    "errorCode",
    "attemptCount",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]]),
  );
}

function publicError(error) {
  return {
    statusCode: error.statusCode || 503,
    body: {
      code:
        error.code ||
        (error.statusCode && error.statusCode < 500
          ? "INVALID_REQUEST"
          : "SERVICE_UNAVAILABLE"),
      error: error.statusCode
        ? error.message
        : "Service temporarily unavailable. Retry with the same Idempotency-Key.",
    },
  };
}

module.exports = {
  callerOwner,
  canonicalJson,
  conditionalFailure,
  documentClientFor,
  getSubmission,
  httpError,
  idempotencyKey,
  publicError,
  publicStatus,
  sha256,
};
