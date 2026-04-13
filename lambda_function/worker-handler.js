'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const { parseAamvaBarcode } = require('./barcode');
const { analyzeDocument, normalizePayload } = require('./screening');
const { createOcrExtractor } = require('./ocr');

function createWorkerHandler(options = {}) {
  const s3Client = options.s3Client || new S3Client({});
  const documentClient = options.documentClient || DynamoDBDocumentClient.from(
    options.dynamoClient || new DynamoDBClient({})
  );
  const ocrExtractor = options.ocrExtractor || createOcrExtractor({
    textractClient: options.textractClient,
    enabled: options.ocrEnabled
  });
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
        const payloadWithBinary = { ...(submission.payload || submission) };
        const sourceImage = message.sourceImage || submission.sourceImage;
        const parsedBarcode = parseAamvaBarcode(payloadWithBinary.barcodeData);
        let extractedOcr = null;

        if (sourceImage && sourceImage.bucket && sourceImage.key) {
          const imageObject = await s3Client.send(new GetObjectCommand({
            Bucket: sourceImage.bucket,
            Key: sourceImage.key
          }));
          const imageBytes = await bodyToBuffer(imageObject.Body);
          payloadWithBinary.imageBase64 = imageBytes.toString('base64');

          if (!payloadWithBinary.ocrText) {
            extractedOcr = await ocrExtractor.extractText(imageBytes);
            if (extractedOcr.text) {
              payloadWithBinary.ocrText = extractedOcr.text;
            }
          }
        }

        if (parsedBarcode && parsedBarcode.screeningText) {
          payloadWithBinary.ocrText = payloadWithBinary.ocrText
            ? `${payloadWithBinary.ocrText} ${parsedBarcode.screeningText}`
            : parsedBarcode.screeningText;
          payloadWithBinary.metadata = {
            ...(payloadWithBinary.metadata || {}),
            stateCode: payloadWithBinary.metadata && payloadWithBinary.metadata.stateCode
              ? payloadWithBinary.metadata.stateCode
              : parsedBarcode.fields.state || null
          };
        }

        const normalizedPayload = normalizePayload(payloadWithBinary);
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
            ocr: extractedOcr ? {
              source: extractedOcr.source,
              extractedTextLength: extractedOcr.text.length
            } : null,
            barcode: parsedBarcode,
            analysis
          }),
          ContentType: 'application/json'
        }));

        if (message.tableName || process.env.SUBMISSION_TABLE_NAME) {
          const processedAt = now();
          await documentClient.send(new UpdateCommand({
            TableName: message.tableName || process.env.SUBMISSION_TABLE_NAME,
            Key: { submissionId: message.submissionId },
            UpdateExpression: 'SET #status = :status, processedAt = :processedAt, lastUpdatedAt = :lastUpdatedAt, resultKey = :resultKey, analysisSummary = :analysisSummary, analysisScore = :analysisScore, reviewStatus = :reviewStatus, ocrSource = :ocrSource, barcodeFormat = :barcodeFormat, warningsCount = :warningsCount, findingsCount = :findingsCount, detectedState = :detectedState, ocrTextLength = :ocrTextLength',
            ExpressionAttributeNames: {
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':status': 'completed',
              ':processedAt': processedAt,
              ':lastUpdatedAt': processedAt,
              ':resultKey': resultKey,
              ':analysisSummary': analysis.summary,
              ':analysisScore': analysis.score,
              ':reviewStatus': analysis.status,
              ':ocrSource': extractedOcr ? extractedOcr.source : 'provided',
              ':barcodeFormat': parsedBarcode ? parsedBarcode.format : null,
              ':warningsCount': analysis.warnings.length,
              ':findingsCount': analysis.findings.length,
              ':detectedState': analysis.textAnalysis ? analysis.textAnalysis.detectedState : null,
              ':ocrTextLength': payloadWithBinary.ocrText ? payloadWithBinary.ocrText.length : 0
            }
          }));
        }
      } catch (error) {
        const messageId = record.messageId || record.messageID || 'unknown';
        try {
          const message = parseJson(record.body, 'Queue record body must be valid JSON.');
          if (message.submissionId && (message.tableName || process.env.SUBMISSION_TABLE_NAME)) {
            const failedAt = now();
            await documentClient.send(new UpdateCommand({
              TableName: message.tableName || process.env.SUBMISSION_TABLE_NAME,
              Key: { submissionId: message.submissionId },
              UpdateExpression: 'SET #status = :status, lastUpdatedAt = :lastUpdatedAt, errorMessage = :errorMessage, failureCount = if_not_exists(failureCount, :zero) + :one',
              ExpressionAttributeNames: {
                '#status': 'status'
              },
              ExpressionAttributeValues: {
                ':status': 'failed',
                ':lastUpdatedAt': failedAt,
                ':errorMessage': error.message,
                ':zero': 0,
                ':one': 1
              }
            }));
          }
        } catch (statusError) {
          // Keep the original failure path intact if status persistence also fails.
        }

        failures.push({
          itemIdentifier: messageId
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

async function bodyToBuffer(body) {
  if (body == null) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
  bodyToBuffer,
  bodyToString,
  createWorkerHandler,
  handler: createWorkerHandler()
};
