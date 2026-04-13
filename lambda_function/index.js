'use strict';

const {
  analyzeDocument,
  badRequest,
  inspectImage,
  inspectOcrText,
  normalizeInvocationEvent,
  normalizePayload
} = require('./screening');

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json'
};

async function handler(event = {}) {
  try {
    const payload = normalizeInvocationEvent(event);
    const result = analyzeDocument(payload);

    return jsonResponse(200, result);
  } catch (error) {
    const statusCode = error.statusCode || 400;

    return jsonResponse(statusCode, {
      error: error.message || 'Unable to evaluate document payload',
      recommendation: 'Provide OCR text, base64 image data, or both.'
    });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body)
  };
}

module.exports = {
  handler,
  analyzeDocument,
  badRequest,
  inspectImage,
  inspectOcrText,
  jsonResponse,
  normalizeInvocationEvent,
  normalizePayload
};
