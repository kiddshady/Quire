'use strict';
/** Output Markdown: headings jerárquicos + tablas pipe + frontmatter opcional. */

const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function tableMd(t) {
  const lines = [];
  const width = Math.max(t.headers.length, ...t.rows.map((r) => r.length), 1);
  const pad = (r) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
  const headers = t.headers.length ? pad(t.headers) : Array(width).fill(' ');
  lines.push(`| ${headers.map(escCell).join(' | ')} |`);
  lines.push(`|${Array(width).fill(' --- ').join('|')}|`);
  for (const r of t.rows) lines.push(`| ${pad(r).map(escCell).join(' | ')} |`);
  return lines.join('\n');
}

function renderSection(section, out) {
  if (section.title) {
    const level = Math.min(Math.max(section.level + 1, 2), 6);
    out.push(`${'#'.repeat(level)} ${section.title}`);
  }
  for (const p of section.paragraphs) out.push(p);
  for (const t of section.tables) out.push(tableMd(t));
  for (const sub of section.subsections) renderSection(sub, out);
}

module.exports = {
  name: 'markdown',
  extension: '.md',
  description: 'Markdown limpio, con encabezados y tablas',

  async render(doc, options = {}) {
    const out = [];
    if (options.frontmatter !== false) {
      const fm = ['---'];
      const meta = doc.metadata || {};
      // Un nombre de archivo con comillas o backslashes rompe el YAML si va crudo.
      const yamlStr = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      if (meta.source) fm.push(`source: ${yamlStr(meta.source)}`);
      if (meta.engine) fm.push(`engine: ${yamlStr(meta.engine)}`);
      for (const k of ['pages', 'slides', 'questions', 'chars', 'ocrPages', 'hyphensRestored']) {
        if (meta[k] !== undefined) fm.push(`${k}: ${meta[k]}`);
      }
      fm.push(`extracted_at: ${new Date().toISOString()}`, '---', '');
      out.push(fm.join('\n').trim());
    }
    out.push(`# ${doc.title}`);
    for (const s of doc.sections) renderSection(s, out);
    return Buffer.from(out.join('\n\n') + '\n', 'utf8');
  },
};
