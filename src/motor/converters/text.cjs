'use strict';
/**
 * Converter de texto plano / markdown: párrafos separados por líneas en blanco.
 */

const path = require('path');
const { makeDocument, makeSection } = require('../document.cjs');
const { decodeText } = require('../encoding.cjs');

module.exports = {
  name: 'text',
  extensions: ['.txt', '.md', '.markdown', '.rst', '.text', '.log'],
  description: 'Texto plano o Markdown → párrafos',

  async extract(data, filename) {
    const text = decodeText(data);
    let title = path.basename(filename, path.extname(filename));

    const lines = text.split('\n');
    let startIdx = 0;
    const h1 = lines.findIndex((l) => /^#\s+/.test(l));
    if (h1 !== -1 && h1 < 5) {
      title = lines[h1].replace(/^#\s+/, '').trim();
      startIdx = h1 + 1;
    }

    const paragraphs = [];
    let buf = [];
    for (const line of lines.slice(startIdx)) {
      if (!line.trim()) {
        if (buf.length) { paragraphs.push(buf.join('\n')); buf = []; }
      } else {
        buf.push(line);
      }
    }
    if (buf.length) paragraphs.push(buf.join('\n'));

    return makeDocument({
      title,
      sections: [makeSection({ title: '', level: 1, paragraphs })],
      metadata: { source: filename, engine: 'text', chars: text.length },
    });
  },
};
