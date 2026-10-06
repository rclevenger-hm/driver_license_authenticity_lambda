'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handler: screeningHandler, inspectImage, inspectOcrText } = require('./index');

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==';

test('direct screening handler still returns a pass result for plausible content', async () => {
  const event = {
    body: JSON.stringify({
      imageBase64: SAMPLE_PNG_BASE64,
      ocrText: 'DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C'
    })
  };

  const response = await screeningHandler(event);
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, 'pass');
  assert.ok(payload.score >= 75);
  assert.match(payload.disclaimer, /plausibility screening/i);
});

test('direct screening handler supports passport submissions', async () => {
  const event = {
    body: JSON.stringify({
      documentType: 'passport',
      ocrText: 'PASSPORT Passport No 123456789 Nationality USA Place of Birth CHICAGO Date of Birth 01/02/1990 Date of Issue 01/01/2020 Date of Expiry 01/01/2030 Issuing Authority UNITED STATES P<USADOE<<JANE<<<<<<<<<<<<<<<<<<<<<<< 1234567890USA9001021F3001012<<<<<<<<<<<<<<04'
    })
  };

  const response = await screeningHandler(event);
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.documentType, 'passport');
  assert.ok(payload.score >= 75);
  assert.equal(payload.textAnalysis.mrzDetected, true);
  assert.match(payload.disclaimer, /passport plausibility screening/i);
});

test('extracts PNG dimensions correctly', () => {
  const image = inspectImage(SAMPLE_PNG_BASE64);

  assert.equal(image.supported, true);
  assert.equal(image.format, 'png');
  assert.equal(image.width, 600);
  assert.equal(image.height, 400);
  assert.equal(image.aspectRatio, 1.5);
});

test('scores OCR text down when core document signals are missing', () => {
  const analysis = inspectOcrText('hello world 04/03/2025 random content', {});

  assert.ok(analysis.scoreDelta < 0);
  assert.ok(analysis.warnings.length > 0);
});
