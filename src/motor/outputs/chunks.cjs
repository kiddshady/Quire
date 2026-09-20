'use strict';
/**
 * Output chunks RAG: trocea el texto plano en pedazos con solapamiento,
 * cortando preferentemente en límites naturales (\n\n > \n > ". " > ", ").
 * Port del splitter de Shapeshifter.
 */

const { rawText } = require('../document.cjs');

const SEPARATORS = ['\n\n', '\n', '. ', ', '];

function splitText(text, size, overlap) {
  const chunks = [];
  const len = text.length;
  let pos = 0;
  while (pos < len) {
    let end = Math.min(pos + size, len);
    if (end < len) {
      const windowStart = pos + Math.floor(size / 2);
      let cut = -1;
      for (const sep of SEPARATORS) {
        const idx = text.lastIndexOf(sep, end);
        if (idx > windowStart) { cut = idx + sep.length; break; }
      }
      if (cut > pos) end = cut;
    }
    const chunk = text.slice(pos, end);
    if (chunk.trim()) {
      chunks.push({ index: chunks.length, char_start: pos, char_end: end, n_chars: chunk.length, text: chunk });
    }
    if (end >= len) break;
    pos = Math.max(end - overlap, pos + 1);
  }
  return chunks;
}

module.exports = {
  name: 'chunks',
  extension: '.chunks.json',
  description: 'Fragmentos solapados para RAG',

  async render(doc, options = {}) {
    const size = Math.max(Number(options.chunkSize) || 1500, 100);
    const overlap = Math.min(Math.max(Number(options.chunkOverlap) || 200, 0), size - 1);
    const text = rawText(doc);
    const chunks = splitText(text, size, overlap);
    const payload = {
      source: doc.metadata && doc.metadata.source,
      title: doc.title,
      chunk_size: size,
      chunk_overlap: overlap,
      n_chunks: chunks.length,
      chunks,
    };
    return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  },
};
