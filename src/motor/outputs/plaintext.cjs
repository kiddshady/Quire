'use strict';
/** Output TXT: flatten total, mínimo ruido — ideal para pegar en un LLM. */

function renderSection(section, out) {
  if (section.title) out.push(section.title.toUpperCase());
  for (const p of section.paragraphs) out.push(p);
  for (const t of section.tables) {
    const lines = [];
    if (t.headers.length) lines.push(t.headers.join('\t'));
    for (const r of t.rows) lines.push(r.join('\t'));
    if (lines.length) out.push(lines.join('\n'));
  }
  for (const sub of section.subsections) renderSection(sub, out);
}

module.exports = {
  name: 'txt',
  extension: '.txt',
  description: 'Texto plano sin formato',

  async render(doc) {
    const out = [doc.title, '='.repeat(Math.min(doc.title.length, 60))];
    for (const s of doc.sections) renderSection(s, out);
    return Buffer.from(out.join('\n\n') + '\n', 'utf8');
  },
};
