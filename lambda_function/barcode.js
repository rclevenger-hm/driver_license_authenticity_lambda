'use strict';

const FIELD_MAP = {
  DBA: 'expirationDate',
  DBD: 'issueDate',
  DBB: 'birthDate',
  DCS: 'lastName',
  DAC: 'firstName',
  DAD: 'middleName',
  DAG: 'address',
  DAI: 'city',
  DAJ: 'state',
  DAK: 'postalCode',
  DAU: 'height',
  DCF: 'documentDiscriminator',
  DAQ: 'licenseNumber',
  DCA: 'licenseClass',
  DCB: 'restrictions',
  DCD: 'endorsements',
  DAY: 'eyeColor',
  DAZ: 'hairColor',
  DBC: 'sex'
};

function parseAamvaBarcode(barcodeData) {
  if (typeof barcodeData !== 'string' || !barcodeData.trim()) {
    return null;
  }

  const lines = barcodeData
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fields = {};
  for (const line of lines) {
    const code = line.slice(0, 3);
    const value = line.slice(3).trim();
    if (FIELD_MAP[code] && value) {
      fields[FIELD_MAP[code]] = value;
    }
  }

  const fieldCount = Object.keys(fields).length;
  if (fieldCount === 0) {
    return null;
  }

  return {
    format: /ANSI\s*\d+/i.test(barcodeData) ? 'aamva-pdf417' : 'pdf417-like',
    fieldCount,
    fields,
    screeningText: buildScreeningText(fields)
  };
}

function buildScreeningText(fields) {
  const parts = ['DRIVER LICENSE'];

  if (fields.licenseNumber) {
    parts.push(`DL NUMBER ${fields.licenseNumber}`);
  }
  if (fields.birthDate) {
    parts.push(`DOB ${fields.birthDate}`);
  }
  if (fields.issueDate) {
    parts.push(`ISSUED ${fields.issueDate}`);
  }
  if (fields.expirationDate) {
    parts.push(`EXPIRES ${fields.expirationDate}`);
  }
  if (fields.address) {
    parts.push(`ADDRESS ${fields.address}`);
  }
  if (fields.state) {
    parts.push(fields.state);
  }
  if (fields.licenseClass) {
    parts.push(`CLASS ${fields.licenseClass}`);
  }

  return parts.join(' ');
}

module.exports = {
  parseAamvaBarcode
};
