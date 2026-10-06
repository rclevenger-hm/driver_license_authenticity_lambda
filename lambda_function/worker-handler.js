"use strict";

const { randomUUID } = require("node:crypto");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { parseAamvaBarcode } = require("./barcode");
const { analyzeDocument, normalizePayload } = require("./screening");
const { createOcrExtractor } = require("./ocr");
const {
  conditionalFailure,
  documentClientFor,
  getSubmission,
} = require("./submissions");

function createWorkerHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const documentClient = documentClientFor(options);
  const ocrExtractor =
    options.ocrExtractor ||
    createOcrExtractor({
      textractClient: options.textractClient,
      enabled: options.ocrEnabled,
    });
  const now = options.now || (() => new Date().toISOString());
  const createToken = options.createToken || randomUUID;
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;
  const bucketName = options.bucketName || process.env.INTAKE_BUCKET_NAME;
  const resultPrefix =
    options.resultPrefix || process.env.RESULT_PREFIX || "results";
  const leaseSeconds = Number(
    options.leaseSeconds || process.env.WORKER_LEASE_SECONDS || 90,
  );
  const maxReceiveCount = Number(
    options.maxReceiveCount || process.env.MAX_RECEIVE_COUNT || 5,
  );
  const epoch = () => Math.floor(Date.parse(now()) / 1000);

  return async function handler(event = {}) {
    if (!tableName || !bucketName)
      throw new Error("Worker configuration is missing.");
    const failures = [];
    for (const record of event.Records || []) {
      let submissionId;
      let leaseToken;
      try {
        const message = parseJson(record.body, "Invalid queue message.");
        if (
          !message ||
          typeof message.submissionId !== "string" ||
          !/^[a-f0-9]{64}$/.test(message.submissionId)
        ) {
          throw new Error("Invalid submission ID.");
        }
        submissionId = message.submissionId;
        let item = await getSubmission(documentClient, tableName, submissionId);
        if (!item || !item.ownerId || item.submissionBucket !== bucketName)
          throw new Error("Unknown submission.");
        if (item.status === "completed") continue;
        const candidateToken = createToken();
        try {
          const claimed = await documentClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { submissionId },
              UpdateExpression:
                "SET #status = :processing, leaseToken = :token, leaseExpiresAt = :expires, lastUpdatedAt = :updated, attemptCount = if_not_exists(attemptCount, :zero) + :one",
              ConditionExpression:
                "attribute_exists(ownerId) AND (#status IN (:pending, :queued, :retrying, :failed) OR (#status = :processing AND leaseExpiresAt <= :now))",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":processing": "processing",
                ":pending": "dispatch_pending",
                ":queued": "queued",
                ":retrying": "retrying",
                ":failed": "failed",
                ":token": candidateToken,
                ":expires": epoch() + leaseSeconds,
                ":now": epoch(),
                ":updated": now(),
                ":zero": 0,
                ":one": 1,
              },
              ReturnValues: "ALL_NEW",
            }),
          );
          item = claimed.Attributes;
          leaseToken = candidateToken;
        } catch (error) {
          if (conditionalFailure(error)) {
            const current = await getSubmission(
              documentClient,
              tableName,
              submissionId,
            );
            if (current && current.status === "completed") continue;
          }
          throw error;
        }
        // Locations come exclusively from the durable record, not SQS input.
        const object = await s3Client.send(
          new GetObjectCommand({ Bucket: bucketName, Key: item.submissionKey }),
        );
        const submission = parseJson(
          await bodyToString(object.Body),
          "Invalid stored submission.",
        );
        if (submission.submissionId !== submissionId)
          throw new Error("Submission mismatch.");
        const payload = { ...submission.payload };
        const parsedBarcode = parseAamvaBarcode(payload.barcodeData);
        let extractedOcr = null;
        if (item.sourceImageKey) {
          const imageObject = await s3Client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: item.sourceImageKey,
            }),
          );
          const imageBytes = await bodyToBuffer(imageObject.Body);
          payload.imageBase64 = imageBytes.toString("base64");
          if (!payload.ocrText) {
            extractedOcr = await ocrExtractor.extractText(imageBytes);
            if (extractedOcr.text) payload.ocrText = extractedOcr.text;
          }
        }
        if (parsedBarcode && parsedBarcode.screeningText) {
          payload.ocrText = payload.ocrText
            ? `${payload.ocrText} ${parsedBarcode.screeningText}`
            : parsedBarcode.screeningText;
          payload.metadata = {
            ...(payload.metadata || {}),
            stateCode:
              payload.metadata?.stateCode || parsedBarcode.fields.state || null,
          };
        }
        const analysis = analyzeDocument(normalizePayload(payload));
        const processedAt = now();
        // Every attempt has its own immutable object. Only a current lease may
        // publish its pointer; a late worker cannot overwrite a newer result.
        const resultKey = `${resultPrefix}/${submissionId}/${leaseToken}.json`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: resultKey,
            IfNoneMatch: "*",
            ContentType: "application/json",
            Body: JSON.stringify({
              submissionId,
              status: "completed",
              processedAt,
              ocr: extractedOcr
                ? {
                    source: extractedOcr.source,
                    extractedTextLength: extractedOcr.text.length,
                  }
                : null,
              barcode: parsedBarcode,
              analysis,
            }),
          }),
        );
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { submissionId },
            UpdateExpression:
              "SET #status = :completed, processedAt = :processed, lastUpdatedAt = :processed, resultKey = :result, analysisSummary = :summary, analysisScore = :score, reviewStatus = :review, warningsCount = :warnings, findingsCount = :findings, submissionType = :type REMOVE leaseToken, leaseExpiresAt, errorCode",
            ConditionExpression:
              "#status = :processing AND leaseToken = :token AND leaseExpiresAt > :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":completed": "completed",
              ":processing": "processing",
              ":token": leaseToken,
              ":now": epoch(),
              ":processed": processedAt,
              ":result": resultKey,
              ":summary": analysis.summary,
              ":score": analysis.score,
              ":review": analysis.status,
              ":warnings": analysis.warnings.length,
              ":findings": analysis.findings.length,
              ":type": analysis.documentType,
            },
          }),
        );
      } catch (error) {
        if (submissionId && leaseToken) {
          try {
            const lastAttempt =
              Number(record.attributes?.ApproximateReceiveCount || 1) >=
              maxReceiveCount;
            await documentClient.send(
              new UpdateCommand({
                TableName: tableName,
                Key: { submissionId },
                UpdateExpression:
                  "SET #status = :next, lastUpdatedAt = :updated, errorCode = :error REMOVE leaseToken, leaseExpiresAt",
                ConditionExpression:
                  "#status = :processing AND leaseToken = :token AND leaseExpiresAt > :now",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":processing": "processing",
                  ":next": lastAttempt ? "failed" : "retrying",
                  ":token": leaseToken,
                  ":now": epoch(),
                  ":updated": now(),
                  ":error": "PROCESSING_FAILED",
                },
              }),
            );
          } catch (statusError) {
            // Preserve retry even if the state update fails or the lease was lost.
          }
        }
        failures.push({ itemIdentifier: record.messageId || record.messageID });
      }
    }
    return { batchItemFailures: failures };
  };
}

async function bodyToString(body) {
  if (body == null) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }

  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  throw new Error("Unsupported S3 body type.");
}

async function bodyToBuffer(body) {
  if (body == null) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 body type.");
}

function parseJson(value, errorMessage) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(errorMessage);
  }
}

module.exports = {
  bodyToBuffer,
  bodyToString,
  createWorkerHandler,
  handler: createWorkerHandler(),
};
