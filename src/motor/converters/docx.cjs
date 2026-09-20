'use strict';
/**
 * Converter DOCX → Document, vía mammoth (docx → HTML limpio) + cheerio.
 * Respeta la jerarquía de headings y extrae tablas.
 */

const path = require('path');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const { makeDocument, makeSection, makeTable } = require('../document.cjs');

const collapse = (t) => (t || '').replace(/\s+/g, ' ').trim();

module.exports = {
  name: 'docx',
  extensions: ['.docx'],
  description: 'Word (.docx) → documento estructurado',

  async extract(data, filename) {
    const result = await mammoth.convertToHtml(
      { buffer: data },
      {
        // No inlineamos imágenes acá: para libros con muchas figuras el base64
        // explota la memoria. El texto es lo que importa para md/txt/chunks.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      }
    );
    const $ = cheerio.load(result.value);
    $('img').replaceWith('');

    const rootSection = makeSection({ title: '', level: 1 });
    const sections = [];
    let current = rootSection;
    let title = '';

    $('body').children().each(function walkTop(_, el) {
      const $el = $(el);
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const text = collapse($el.text());
        if (!title && tag === 'h1') { title = text; return; }
        current = makeSection({ title: text, level: Math.min(Number(tag[1]), 4) });
        sections.push(current);
        return;
      }
      if (tag === 'table') {
        const headers = $el.find('tr').first().find('th').map((_, c) => collapse($(c).text())).get();
        const rows = [];
        $el.find('tr').each((_, tr) => {
          const cells = $(tr).find('td').map((_, c) => collapse($(c).text())).get();
          if (cells.length) rows.push(cells);
        });
        if (headers.length || rows.length) current.tables.push(makeTable({ headers, rows }));
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        $el.children('li').each((_, li) => {
          const text = collapse($(li).text());
          if (text) current.paragraphs.push(`• ${text}`);
        });
        return;
      }
      const text = collapse($el.text());
      if (text) current.paragraphs.push(text);
    });

    if (!title) title = path.basename(filename, path.extname(filename));
    const finalSections = [];
    if (rootSection.paragraphs.length || rootSection.tables.length) finalSections.push(rootSection);
    finalSections.push(...sections);

    return makeDocument({
      title,
      sections: finalSections,
      metadata: {
        source: filename,
        engine: 'mammoth',
        warnings: result.messages.length || undefined,
      },
    });
  },
};
