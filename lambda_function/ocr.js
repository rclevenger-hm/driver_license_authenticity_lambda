'use strict';

const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');

function createOcrExtractor(options = {}) {
  const textractClient = options.textractClient || new TextractClient({});
  const enabled = options.enabled !== undefined ? options.enabled : process.env.ENABLE_TEXTRACT_OCR === 'true';

  return {
    enabled,
    async extractText(documentBytes) {
      if (!enabled) {
        return {
          text: '',
          source: 'disabled',
          blocks: []
        };
      }

      const response = await textractClient.send(new DetectDocumentTextCommand({
        Document: {
          Bytes: documentBytes
        }
      }));

      const lines = (response.Blocks || [])
        .filter((block) => block.BlockType === 'LINE' && block.Text)
        .map((block) => block.Text.trim())
        .filter(Boolean);

      return {
        text: lines.join(' '),
        source: 'textract',
        blocks: response.Blocks || []
      };
    }
  };
}

module.exports = {
  createOcrExtractor
};
