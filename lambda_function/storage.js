'use strict';

function decodeBase64Document(imageBase64) {
  const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = match ? match[1] : null;
  const rawBase64 = match ? match[2] : imageBase64;
  const buffer = Buffer.from(rawBase64.replace(/\s+/g, ''), 'base64');

  return {
    buffer,
    mimeType: mimeType || detectMimeType(buffer),
    extension: extensionForMimeType(mimeType || detectMimeType(buffer))
  };
}

function detectMimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }

  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString('ascii');
    if (gifHeader === 'GIF89a' || gifHeader === 'GIF87a') {
      return 'image/gif';
    }
  }

  return 'application/octet-stream';
}

function extensionForMimeType(mimeType) {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

module.exports = {
  decodeBase64Document
};
