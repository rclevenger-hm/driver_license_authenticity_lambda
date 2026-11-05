"use strict";

const { jsonResponse } = require("./index");
const { createInvocationLog } = require("./observability");
const {
  callerOwner,
  documentClientFor,
  getSubmission,
  publicError,
  publicStatus,
} = require("./submissions");

function createStatusHandler(options = {}) {
  const documentClient = documentClientFor(options);
  const tableName = options.tableName || process.env.SUBMISSION_TABLE_NAME;

  return async function handler(event = {}, context = {}) {
    const log = createInvocationLog(event, context, options.log);
    try {
      const ownerId = callerOwner(event);
      if (!tableName) throw new Error("Status configuration is missing.");
      const submissionId =
        event.pathParameters && event.pathParameters.submissionId;
      if (
        typeof submissionId !== "string" ||
        !/^[a-f0-9]{64}$/.test(submissionId)
      ) {
        log("status.not_found", { statusCode: 404 });
        return jsonResponse(404, {
          code: "NOT_FOUND",
          error: "Submission not found.",
        });
      }
      const item = await getSubmission(documentClient, tableName, submissionId);
      // Missing, foreign, and legacy ownerless records are indistinguishable.
      if (!item || item.ownerId !== ownerId) {
        log("status.not_found", { statusCode: 404 });
        return jsonResponse(404, {
          code: "NOT_FOUND",
          error: "Submission not found.",
        });
      }
      log("status.found", {
        submissionId,
        status: item.status,
        statusCode: 200,
      });
      return jsonResponse(200, publicStatus(item));
    } catch (error) {
      const response = publicError(error);
      log("status.failed", { statusCode: response.statusCode });
      return jsonResponse(response.statusCode, response.body);
    }
  };
}

module.exports = { createStatusHandler, handler: createStatusHandler() };
