'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handler, inspectImage, inspectOcrText } = require('./index');

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==';

test('returns a pass result when image and OCR text look plausible', async () => {
  const event = {
    body: JSON.stringify({
      imageBase64: SAMPLE_PNG_BASE64,
      ocrText: 'DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C'
    })
  };

  const response = await handler(event);
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, 'pass');
  assert.ok(payload.score >= 75);
  assert.match(payload.disclaimer, /plausibility screening/i);
});

test('returns review when OCR text is thin and image is undersized', async () => {
  const response = await handler({
    imageBase64: SAMPLE_PNG_BASE64,
    ocrText: 'DRIVER LICENSE DOB 01/02/1990 TX ADDRESS 123 MAIN ST'
  });

  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, 'review');
  assert.ok(payload.warnings.length >= 2);
});

test('rejects malformed requests that contain no analyzable content', async () => {
  const response = await handler({ body: '{}' });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 400);
  assert.match(payload.error, /imageBase64.*ocrText/i);
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
