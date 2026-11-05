"use strict";

const EVENTS = new Set([
  "intake.accepted",
  "intake.failed",
  "dispatch.sent",
  "dispatch.deferred",
  "status.found",
  "status.not_found",
  "status.failed",
  "worker.claimed",
  "worker.completed",
  "worker.duplicate",
  "worker.failed",
  "worker.failure_state_unrecorded",
  "reconcile.failed",
  "reconcile.finished",
]);
const STATUSES = new Set([
  "dispatch_pending",
  "queued",
  "processing",
  "completed",
  "retrying",
  "failed",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGES = new Set([
  "validate_message",
  "read_submission",
  "claim",
  "load_submission",
  "load_image",
  "ocr",
  "analyze",
  "store_result",
  "publish_result",
  "query_pending",
  "dispatch",
  "rotate_pending",
]);
const STOP_REASONS = new Set(["exhausted", "deadline", "page_limit"]);

// Build records from a closed field set. Never serialize events, SDK errors,
// headers, caller identities, document fields, object keys, or lease tokens.
function createInvocationLog(event = {}, context = {}, write = console.info) {
  const invocation = {};
  if (
    typeof context?.awsRequestId === "string" &&
    UUID.test(context.awsRequestId)
  )
    invocation.lambdaRequestId = context.awsRequestId;
  const apiRequestId = event?.requestContext?.extendedRequestId;
  // API Gateway generates extendedRequestId; requestId can be client-supplied.
  if (
    typeof apiRequestId === "string" &&
    /^[A-Za-z0-9+/=_-]{1,128}$/.test(apiRequestId)
  )
    invocation.apiRequestId = apiRequestId;

  return (name, fields = {}) => {
    try {
      if (!EVENTS.has(name)) return;
      const record = {
        service: "document-screening",
        event: name,
        ...invocation,
      };
      if (
        typeof fields.submissionId === "string" &&
        /^[a-f0-9]{64}$/.test(fields.submissionId)
      )
        record.submissionId = fields.submissionId;
      if (typeof fields.messageId === "string" && UUID.test(fields.messageId))
        record.messageId = fields.messageId;
      if (STATUSES.has(fields.status)) record.status = fields.status;
      if (STAGES.has(fields.stage)) record.stage = fields.stage;
      if (STOP_REASONS.has(fields.stopReason))
        record.stopReason = fields.stopReason;
      for (const key of ["receiveCount", "dispatched", "failed"]) {
        if (Number.isSafeInteger(fields[key]) && fields[key] >= 0)
          record[key] = fields[key];
      }
      if (
        Number.isInteger(fields.statusCode) &&
        fields.statusCode >= 100 &&
        fields.statusCode <= 599
      )
        record.statusCode = fields.statusCode;
      write(JSON.stringify(record));
    } catch {
      // Observability must not change durable acceptance, leases, or retries.
    }
  };
}

module.exports = { createInvocationLog };
