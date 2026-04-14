'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const { jsonResponse } = require('./index');

function createStatusHandler(options = {}) {
  const documentClient = options.documentClient || DynamoDBDocumentClient.from(
    options.dynamoClient || new DynamoDBClient({})
  );
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;

  return async function handler(event = {}) {
    try {
      if (!tableName) {
        throw configurationError('SUBMISSION_TABLE_NAME must be configured.');
      }

      const submissionId = getSubmissionId(event);

      if (!submissionId) {
        return jsonResponse(400, {
          error: 'submissionId path parameter is required.'
        });
      }

      const response = await documentClient.send(new GetCommand({
        TableName: tableName,
        Key: { submissionId }
      }));

      if (!response.Item) {
        return jsonResponse(404, {
          error: `No submission found for ${submissionId}.`
        });
      }

      return jsonResponse(200, response.Item);
    } catch (error) {
      const statusCode = error.statusCode || 500;

      return jsonResponse(statusCode, {
        error: error.message || 'Unable to fetch submission status'
      });
    }
  };
}

function getSubmissionId(event) {
  if (event && event.pathParameters && typeof event.pathParameters.submissionId === 'string') {
    return event.pathParameters.submissionId.trim();
  }

  if (event && typeof event.submissionId === 'string') {
    return event.submissionId.trim();
  }

  return '';
}

function configurationError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  return error;
}

module.exports = {
  createStatusHandler,
  handler: createStatusHandler()
};
