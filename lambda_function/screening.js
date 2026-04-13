'use strict';

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'
]);

const LICENSE_TERMS = [
  /driver'?s?\s+license/i,
  /\boperator\b/i,
  /\bclass\b/i,
  /\bdl\b/i,
  /\blicense\b/i
];

const FIELD_PATTERNS = {
  birthDate: /\b(dob|date\s*of\s*birth|birth\s*date)\b/i,
  issueDate: /\b(issue|issued|iss)\b/i,
  expirationDate: /\b(exp|expires|expiration)\b/i,
  address: /\b(address|addr|street|st\.|avenue|ave\.|road|rd\.)\b/i,
  idNumber: /\b(dl|lic|license|id)\s*(number|no|#)\b/i,
  classCode: /\bclass\s*[a-z0-9]+\b/i
};

function normalizeInvocationEvent(event) {
  if (event && typeof event === 'object' && !('body' in event)) {
    return normalizePayload(event);
  }

  if (!event || typeof event !== 'object') {
    throw badRequest('Event payload must be an object.');
  }

  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '{}';

  let parsedBody;

  try {
    parsedBody = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch (error) {
    throw badRequest('Request body must be valid JSON.');
  }

  return normalizePayload(parsedBody);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw badRequest('Request payload must be a JSON object.');
  }

  const imageBase64 = firstString(payload.imageBase64, payload.image, payload.documentImageBase64);
  const ocrText = firstString(payload.ocrText, payload.text, payload.extractedText);
  const barcodeData = firstString(payload.barcodeData, payload.pdf417Data);
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

  if (!imageBase64 && !ocrText && !barcodeData) {
    throw badRequest('At least one of `imageBase64`, `ocrText`, or `barcodeData` is required.');
  }

  return {
    imageBase64,
    ocrText,
    barcodeData,
    metadata
  };
}

function analyzeDocument({ imageBase64, ocrText, metadata }) {
  const findings = [];
  const warnings = [];
  const inspectedChecks = [];
  let score = 50;

  let imageAnalysis = null;
  if (imageBase64) {
    imageAnalysis = inspectImage(imageBase64);
    inspectedChecks.push('image_format', 'image_dimensions', 'image_size');

    if (imageAnalysis.supported) {
      findings.push(`Image format detected as ${imageAnalysis.format}.`);
      score += 8;

      if (imageAnalysis.width >= 500 && imageAnalysis.height >= 300) {
        findings.push('Image resolution is sufficient for a first-pass review.');
        score += 8;
      } else {
        warnings.push('Image resolution is low and may hide tampering or text artifacts.');
        score -= 18;
      }

      if (imageAnalysis.aspectRatio >= 1.3 && imageAnalysis.aspectRatio <= 2.2) {
        findings.push('Image aspect ratio is consistent with a photographed ID card.');
        score += 6;
      } else {
        warnings.push('Image aspect ratio is unusual for a standard license card.');
        score -= 10;
      }

      if (imageAnalysis.byteLength < 15 * 1024) {
        warnings.push('Image payload is very small, which often means aggressive compression or placeholder content.');
        score -= 16;
      } else {
        score += 4;
      }
    } else {
      warnings.push('Image bytes were provided but the file signature was not recognized as JPEG, PNG, or GIF.');
      score -= 25;
    }
  }

  let textAnalysis = null;
  if (ocrText) {
    textAnalysis = inspectOcrText(ocrText, metadata);
    inspectedChecks.push(
      'document_keywords',
      'field_presence',
      'date_consistency',
      'state_detection'
    );

    score += textAnalysis.scoreDelta;
    findings.push(...textAnalysis.findings);
    warnings.push(...textAnalysis.warnings);
  }

  score = clamp(score, 0, 100);

  const decision = score >= 75 ? 'pass' : score >= 45 ? 'review' : 'reject';

  return {
    status: decision,
    score,
    summary: buildSummary(decision, score, findings, warnings),
    findings,
    warnings,
    inspectedChecks,
    imageAnalysis,
    textAnalysis,
    disclaimer: 'This service performs document plausibility screening only. It does not confirm legal authenticity or DMV issuance.'
  };
}

function inspectImage(imageBase64) {
  const cleanedBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bytes = Buffer.from(cleanedBase64, 'base64');

  const result = {
    supported: false,
    format: 'unknown',
    byteLength: bytes.length,
    width: null,
    height: null,
    aspectRatio: null
  };

  if (bytes.length < 10) {
    return result;
  }

  if (isPng(bytes)) {
    result.supported = true;
    result.format = 'png';
    result.width = bytes.readUInt32BE(16);
    result.height = bytes.readUInt32BE(20);
  } else if (isGif(bytes)) {
    result.supported = true;
    result.format = 'gif';
    result.width = bytes.readUInt16LE(6);
    result.height = bytes.readUInt16LE(8);
  } else if (isJpeg(bytes)) {
    const dimensions = getJpegDimensions(bytes);
    result.supported = Boolean(dimensions);
    result.format = 'jpeg';
    result.width = dimensions ? dimensions.width : null;
    result.height = dimensions ? dimensions.height : null;
  }

  if (result.width && result.height) {
    result.aspectRatio = Number((result.width / result.height).toFixed(2));
  }

  return result;
}

function inspectOcrText(ocrText, metadata) {
  const normalizedText = ocrText.replace(/\s+/g, ' ').trim();
  const uppercaseText = normalizedText.toUpperCase();
  const findings = [];
  const warnings = [];
  let scoreDelta = 0;

  const termMatches = LICENSE_TERMS.filter((pattern) => pattern.test(normalizedText)).length;
  if (termMatches >= 2) {
    findings.push('OCR text contains multiple license-related keywords.');
    scoreDelta += 16;
  } else if (termMatches === 1) {
    findings.push('OCR text contains a license-related keyword.');
    scoreDelta += 8;
  } else {
    warnings.push('OCR text is missing common driver license keywords.');
    scoreDelta -= 20;
  }

  const presentFields = detectFields(normalizedText);
  const presentFieldNames = Object.entries(presentFields)
    .filter(([, present]) => present)
    .map(([name]) => name);

  if (presentFieldNames.length >= 4) {
    findings.push(`OCR text includes core document fields: ${presentFieldNames.join(', ')}.`);
    scoreDelta += 18;
  } else if (presentFieldNames.length >= 2) {
    findings.push(`OCR text includes some expected fields: ${presentFieldNames.join(', ')}.`);
    scoreDelta += 8;
  } else {
    warnings.push('OCR text is missing several expected identity document fields.');
    scoreDelta -= 16;
  }

  const detectedState = detectStateCode(uppercaseText, metadata.stateCode);
  if (detectedState) {
    findings.push(`Detected U.S. jurisdiction code ${detectedState}.`);
    scoreDelta += 6;
  } else {
    warnings.push('No U.S. state or district code was detected in OCR text or metadata.');
    scoreDelta -= 8;
  }

  const dates = extractDates(normalizedText);
  const chronology = evaluateDateChronology(dates);
  findings.push(...chronology.findings);
  warnings.push(...chronology.warnings);
  scoreDelta += chronology.scoreDelta;

  if (normalizedText.length < 60) {
    warnings.push('OCR text is very short, which limits validation confidence.');
    scoreDelta -= 10;
  } else if (normalizedText.length > 120) {
    findings.push('OCR text contains enough content for basic plausibility checks.');
    scoreDelta += 6;
  }

  return {
    extractedFieldCount: presentFieldNames.length,
    detectedState,
    detectedDates: dates.map((date) => date.raw),
    findings,
    warnings,
    scoreDelta
  };
}

function detectFields(text) {
  return {
    birthDate: FIELD_PATTERNS.birthDate.test(text),
    issueDate: FIELD_PATTERNS.issueDate.test(text),
    expirationDate: FIELD_PATTERNS.expirationDate.test(text),
    address: FIELD_PATTERNS.address.test(text),
    idNumber: FIELD_PATTERNS.idNumber.test(text),
    classCode: FIELD_PATTERNS.classCode.test(text)
  };
}

function detectStateCode(uppercaseText, metadataStateCode) {
  if (typeof metadataStateCode === 'string') {
    const candidate = metadataStateCode.trim().toUpperCase();
    if (US_STATE_CODES.has(candidate)) {
      return candidate;
    }
  }

  const matches = uppercaseText.match(/\b[A-Z]{2}\b/g) || [];
  return matches.find((token) => US_STATE_CODES.has(token)) || null;
}

function extractDates(text) {
  const matches = [];
  const pattern = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;

  for (const match of text.matchAll(pattern)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = Number(match[3]);

    if (year < 100) {
      year += year > 50 ? 1900 : 2000;
    }

    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      Number.isInteger(year) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      matches.push({ raw: match[0], date });
    }
  }

  return matches.slice(0, 6);
}

function evaluateDateChronology(dates) {
  const findings = [];
  const warnings = [];
  let scoreDelta = 0;

  if (dates.length < 2) {
    warnings.push('Not enough dates were detected to check document chronology.');
    return { findings, warnings, scoreDelta: scoreDelta - 6 };
  }

  const sorted = [...dates].sort((left, right) => left.date - right.date);
  const earliest = sorted[0].date;
  const latest = sorted[sorted.length - 1].date;
  const ageYears = (Date.now() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  const spanYears = (latest.getTime() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  if (ageYears >= 16 && ageYears <= 110) {
    findings.push('At least one detected date is consistent with a plausible birth date.');
    scoreDelta += 8;
  } else {
    warnings.push('Detected dates do not suggest a plausible holder age.');
    scoreDelta -= 10;
  }

  if (spanYears >= 3 && spanYears <= 100) {
    findings.push('Detected dates follow a reasonable issue-to-expiration timeline.');
    scoreDelta += 8;
  } else {
    warnings.push('Detected dates do not follow a typical license lifespan.');
    scoreDelta -= 8;
  }

  return { findings, warnings, scoreDelta };
}

function buildSummary(status, score, findings, warnings) {
  if (status === 'pass') {
    return `Pre-screen passed with score ${score}. The submission looks plausible, but should still be verified against official or manual checks.`;
  }

  if (status === 'review') {
    return `Manual review recommended. Score ${score} with ${warnings.length} warning(s) and ${findings.length} positive signal(s).`;
  }

  return `Submission rejected at pre-screen with score ${score}. The document is missing too many expected signals for automated intake.`;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPng(buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function isGif(buffer) {
  return buffer.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a';
}

function isJpeg(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8;
}

function getJpegDimensions(buffer) {
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const blockLength = buffer.readUInt16BE(offset + 2);

    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }

    if (!blockLength || blockLength < 2) {
      break;
    }

    offset += 2 + blockLength;
  }

  return null;
}

module.exports = {
  analyzeDocument,
  badRequest,
  inspectImage,
  inspectOcrText,
  normalizeInvocationEvent,
  normalizePayload
};
