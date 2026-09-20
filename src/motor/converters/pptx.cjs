'use strict';
/**
 * Converter PPTX → Document: una sección por diapositiva, notas como
 * subsección. Lee el XML de cada slide directo del zip (jszip); el XML de
 * PowerPoint es generado por máquina, así que la extracción por bloques
 * <a:p>/<a:t> es estable.
 */

const path = require('path');
const JSZip = require('jszip');
const { makeDocument, makeSection, makeTable } = require('../document.cjs');

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Texto de cada párrafo <a:p> dentro de un bloque XML. */
function paragraphsOf(xml) {
  const paras = [];
  for (const pm of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>|<a:p\/>/g)) {
    const runs = [...pm[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => xmlUnescape(m[1]));
    const text = runs.join('').trim();
    if (text) paras.push(text);
  }
  return paras;
}

function slideNumber(name) {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

module.exports = {
  name: 'pptx',
  extensions: ['.pptx'],
  description: 'PowerPoint (.pptx) → one section per slide',

  async extract(data, filename) {
    const zip = await JSZip.loadAsync(data);
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    if (!slideNames.length) throw new Error('El .pptx no tiene diapositivas legibles.');

    const sections = [];
    for (const name of slideNames) {
      const n = slideNumber(name);
      const xml = await zip.file(name).async('string');

      let slideTitle = '';
      const bodyParas = [];
      const tables = [];

      // Shapes: las que declaran placeholder type="title"/"ctrTitle" son el título.
      for (const spm of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
        const sp = spm[0];
        const paras = paragraphsOf(sp);
        if (!paras.length) continue;
        if (/type="(?:title|ctrTitle)"/.test(sp) && !slideTitle) {
          slideTitle = paras.join(' ');
        } else {
          bodyParas.push(...paras);
        }
      }

      // Tablas (graphicFrame > a:tbl)
      for (const tm of xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
        const rows = [];
        for (const trm of tm[0].matchAll(/<a:tr[ >][\s\S]*?<\/a:tr>/g)) {
          const cells = [...trm[0].matchAll(/<a:tc[ >][\s\S]*?<\/a:tc>|<a:tc\/>/g)]
            .map((c) => paragraphsOf(c[0]).join(' '));
          if (cells.some((c) => c)) rows.push(cells);
        }
        if (rows.length) tables.push(makeTable({ headers: [], rows }));
      }

      const section = makeSection({
        title: slideTitle ? `Diapositiva ${n} — ${slideTitle}` : `Diapositiva ${n}`,
        level: 2,
        paragraphs: bodyParas,
        tables,
      });

      // Notas del orador (best effort: notesSlideN suele corresponder a slideN).
      const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
      if (zip.files[notesName]) {
        const notesXml = await zip.file(notesName).async('string');
        const notes = paragraphsOf(notesXml).filter((p) => p !== String(n));
        if (notes.length) {
          section.subsections.push(makeSection({ title: 'Notas', level: 3, paragraphs: notes }));
        }
      }
      sections.push(section);
    }

    return makeDocument({
      title: path.basename(filename, path.extname(filename)),
      sections,
      metadata: { source: filename, engine: 'jszip', slides: slideNames.length },
    });
  },
};
