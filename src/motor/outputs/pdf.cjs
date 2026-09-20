'use strict';
/**
 * Output PDF: arma el HTML (template examen Moodle o genérico) y lo imprime
 * con el Chromium de Electron vía una función `htmlToPdf` inyectada por el
 * main process (así el engine no depende de electron y se puede testear en
 * Node pelado con buildHtml).
 */

const { buildQuizHtml, buildGenericHtml } = require('./pdf-templates.cjs');

function buildHtml(doc) {
  const quiz = doc.metadata && doc.metadata.quiz;
  return quiz ? buildQuizHtml(quiz) : buildGenericHtml(doc);
}

module.exports = {
  name: 'pdf',
  extension: '.pdf',
  description: 'PDF impreso por Chromium (examen Moodle coloreado o documento genérico)',
  buildHtml,

  async render(doc, options = {}) {
    if (typeof options.htmlToPdf !== 'function') {
      throw new Error('La salida PDF necesita el Chromium de Electron (falta htmlToPdf).');
    }
    return options.htmlToPdf(buildHtml(doc));
  },
};
