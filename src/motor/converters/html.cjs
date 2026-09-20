'use strict';
/**
 * Converter HTML genérico (.htm/.html que NO son quiz de Moodle).
 * En Shapeshifter esto directamente fallaba; acá cualquier HTML sale como
 * documento estructurado por headings.
 */

const path = require('path');
const cheerio = require('cheerio');
const { makeDocument, makeSection, makeTable } = require('../document.cjs');
const { decodeText } = require('../encoding.cjs');

const collapse = (t) => (t || '').replace(/\s+/g, ' ').trim();

module.exports = {
  name: 'html',
  extensions: ['.htm', '.html'],
  description: 'HTML genérico → documento estructurado por encabezados',

  async extract(data, filename) {
    const $ = cheerio.load(decodeText(data));
    $('script, style, noscript, nav, iframe').remove();

    let title = collapse($('title').first().text()) || collapse($('h1').first().text());
    if (!title) title = path.basename(filename, path.extname(filename));

    const rootSection = makeSection({ title: '', level: 1 });
    const sections = [];
    let current = rootSection;

    $('body').find('h1, h2, h3, h4, p, li, pre, blockquote, table').each((_, el) => {
      const $el = $(el);
      const tag = el.tagName.toLowerCase();
      if (/^h[1-4]$/.test(tag)) {
        const level = Number(tag[1]);
        current = makeSection({ title: collapse($el.text()), level });
        sections.push(current);
        return;
      }
      if (tag === 'table') {
        if ($el.parents('table').length) return; // tablas anidadas: solo la externa
        const headers = $el.find('tr').first().find('th').map((_, c) => collapse($(c).text())).get();
        const rows = [];
        $el.find('tr').each((i, tr) => {
          const cells = $(tr).find('td').map((_, c) => collapse($(c).text())).get();
          if (cells.length) rows.push(cells);
        });
        if (headers.length || rows.length) current.tables.push(makeTable({ headers, rows }));
        return;
      }
      // Lo que vive dentro de una tabla ya salió en la tabla: volver a emitirlo
      // como párrafo duplica el contenido de cada celda.
      if ($el.parents('table').length) return;
      const text = collapse($el.text());
      if (!text) return;
      current.paragraphs.push(tag === 'li' ? `• ${text}` : text);
    });

    const finalSections = [];
    if (rootSection.paragraphs.length || rootSection.tables.length) finalSections.push(rootSection);
    finalSections.push(...sections.filter((s) => s.title || s.paragraphs.length || s.tables.length));

    return makeDocument({
      title,
      sections: finalSections,
      metadata: { source: filename, engine: 'html (cheerio)' },
    });
  },
};
