'use strict';

const { jsonResponse } = require('./index');
const { callerOwner, documentClientFor, getSubmission, publicError, publicStatus } = require('./submissions');

function createStatusHandler(options = {}) {
  const documentClient = documentClientFor(options);
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;

  return async function handler(event = {}) {
    try {
      const ownerId = callerOwner(event);
      if (!tableName) throw new Error('Status configuration is missing.');
      const submissionId = event.pathParameters && event.pathParameters.submissionId;
      if (typeof submissionId !== 'string' || !/^[a-f0-9]{64}$/.test(submissionId)) {
        return jsonResponse(404, { code: 'NOT_FOUND', error: 'Submission not found.' });
      }
      const item = await getSubmission(documentClient, tableName, submissionId);
      // Missing, foreign, and legacy ownerless records are indistinguishable.
      if (!item || item.ownerId !== ownerId) {
        return jsonResponse(404, { code: 'NOT_FOUND', error: 'Submission not found.' });
      }
      return jsonResponse(200, publicStatus(item));
    } catch (error) {
      const response = publicError(error);
      return jsonResponse(response.statusCode, response.body);
    }
  };
}

module.exports = { createStatusHandler, handler: createStatusHandler() };
