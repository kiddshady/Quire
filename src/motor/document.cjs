'use strict';
/**
 * IR (representación intermedia) del motor de conversión. Nació en Omnimuter
 * y llegó a Quire entero: ver el encabezado de index.cjs.
 * Todo converter produce un Document; todo output lo consume.
 * Es la misma idea que el Document de Shapeshifter (Python), portada a JS plano.
 *
 * Document = { title, sections: [Section], metadata: {} }
 * Section  = { title, level, paragraphs: [string], tables: [Table], subsections: [Section] }
 * Table    = { headers: [string], rows: [[string]] }
 */

function makeDocument({ title = '', sections = [], metadata = {} } = {}) {
  return { title, sections, metadata };
}

function makeSection({ title = '', level = 1, paragraphs = [], tables = [], subsections = [] } = {}) {
  return { title, level, paragraphs, tables, subsections };
}

function makeTable({ headers = [], rows = [] } = {}) {
  return { headers, rows };
}

/** Serializa todo el documento a texto plano (bloques separados por \n\n). */
function rawText(doc) {
  const blocks = [];
  if (doc.title) blocks.push(doc.title);
  const walk = (section) => {
    if (section.title) blocks.push(section.title);
    for (const p of section.paragraphs) if (p && p.trim()) blocks.push(p.trim());
    for (const t of section.tables) {
      const lines = [];
      if (t.headers.length) lines.push(t.headers.join('\t'));
      for (const r of t.rows) lines.push(r.join('\t'));
      if (lines.length) blocks.push(lines.join('\n'));
    }
    for (const sub of section.subsections) walk(sub);
  };
  for (const s of doc.sections) walk(s);
  return blocks.join('\n\n');
}

module.exports = { makeDocument, makeSection, makeTable, rawText };
