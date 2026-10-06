"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient } = require("@aws-sdk/client-sqs");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { jsonResponse, normalizeInvocationEvent } = require("./index");
const { decodeBase64Document } = require("./storage");
const { dispatchSubmission } = require("./dispatch");
const {
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
} = require("./submissions");

function createIntakeHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const sqsClient = options.sqsClient || new SQSClient({});
  const documentClient = documentClientFor(options);
  const now = options.now || (() => new Date().toISOString());
  const bucketName = options.bucketName || process.env.INTAKE_BUCKET_NAME;
  const queueUrl = options.queueUrl || process.env.INTAKE_QUEUE_URL;
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;
  const uploadPrefix =
    options.uploadPrefix || process.env.UPLOAD_PREFIX || "uploads";
  const submissionPrefix =
    options.submissionPrefix || process.env.SUBMISSION_PREFIX || "submissions";

  return async function handler(event = {}) {
    try {
      const ownerId = callerOwner(event);
      const key = idempotencyKey(event);
      if (!bucketName || !queueUrl || !tableName)
        throw new Error("Intake configuration is missing.");
      if (
        typeof event.body === "string" &&
        Buffer.byteLength(event.body) > 5 * 1024 * 1024
      ) {
        throw httpError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body must not exceed 5 MiB.",
        );
      }
      const payload = normalizeInvocationEvent(event);
      const requestHash = sha256(canonicalJson(payload));
      const submissionId = sha256(`${ownerId}:${key}`);
      let item = await getSubmission(documentClient, tableName, submissionId);
      if (!item) {
        const submittedAt = now();
        // Content-addressed, immutable objects keep concurrent requests using
        // the same key with different payloads from replacing the winner's data.
        const objectKey = `${submissionPrefix}/${submissionId}/${requestHash}.json`;
        let sourceImage = null;
        if (payload.imageBase64) {
          const decoded = decodeBase64Document(payload.imageBase64);
          const uploadKey = `${uploadPrefix}/${submissionId}/${requestHash}.${decoded.extension}`;
          await putImmutable(s3Client, {
            Bucket: bucketName,
            Key: uploadKey,
            Body: decoded.buffer,
            ContentType: decoded.mimeType,
          });
          sourceImage = {
            bucket: bucketName,
            key: uploadKey,
            mimeType: decoded.mimeType,
          };
        }
        await putImmutable(s3Client, {
          Bucket: bucketName,
          Key: objectKey,
          Body: JSON.stringify({
            submissionId,
            payload: { ...payload, imageBase64: undefined },
            sourceImage,
          }),
          ContentType: "application/json",
        });
        item = {
          submissionId,
          ownerId,
          requestHash,
          status: "dispatch_pending",
          submissionType: payload.documentType,
          submittedAt,
          lastUpdatedAt: submittedAt,
          submissionBucket: bucketName,
          submissionKey: objectKey,
          sourceImageKey: sourceImage ? sourceImage.key : null,
          hasImage: Boolean(sourceImage),
          hasProvidedOcr: Boolean(payload.ocrText),
          hasBarcodeData: Boolean(payload.barcodeData),
          processingVersion: "2026-10-06.a",
        };
        try {
          await documentClient.send(
            new PutCommand({
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(submissionId)",
            }),
          );
        } catch (error) {
          if (!conditionalFailure(error)) throw error;
          item = await getSubmission(documentClient, tableName, submissionId);
        }
      }
      if (!item) throw new Error("Submission could not be read.");
      if (item.ownerId !== ownerId || item.requestHash !== requestHash) {
        throw httpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used for a different payload.",
        );
      }
      if (item.status === "dispatch_pending") {
        try {
          item =
            (await dispatchSubmission({
              documentClient,
              sqsClient,
              tableName,
              queueUrl,
              submissionId,
              now,
            })) || item;
        } catch (error) {
          // Durable acceptance succeeded. Scheduled reconciliation will retry
          // dispatch, including ambiguous SQS or DynamoDB responses.
        }
      }
      return jsonResponse(item.status === "completed" ? 200 : 202, {
        ...publicStatus(item),
        statusEndpoint: `/submissions/${submissionId}`,
      });
    } catch (error) {
      const response = publicError(error);
      return jsonResponse(response.statusCode, response.body);
    }
  };
}

async function putImmutable(s3Client, input) {
  try {
    await s3Client.send(new PutObjectCommand({ ...input, IfNoneMatch: "*" }));
  } catch (error) {
    if (
      error.name !== "PreconditionFailed" &&
      error.$metadata?.httpStatusCode !== 412
    )
      throw error;
  }
}

module.exports = { createIntakeHandler, handler: createIntakeHandler() };
