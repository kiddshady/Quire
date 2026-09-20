'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — motor de conversión
   Lo que era Omnimuter (C:\tools\omnimuter), traído a Quire en septiembre de
   2026 para que el lector también sepa CREAR documentos y SACARLES el texto:

     entrada → converter → Document (IR) → cleaners → output → bytes

   · Converters: Moodle (.htm de revisión de cuestionario), HTML, PDF (con OCR
     para las páginas escaneadas y rescate de guiones), DOCX, PPTX y texto.
   · Outputs: PDF (impreso por Chromium a partir de un template HTML),
     Markdown, texto plano, JSON y fragmentos para RAG.

   Es Node pelado a propósito: nada de acá requiere electron. Lo único que
   necesita Chromium —volver HTML un PDF— entra inyectado como `htmlToPdf`
   desde src/conversion.cjs, así el motor se prueba con `node test/motor.test.cjs`.

   El orden de registro importa para .htm/.html: Moodle (con detect) antes que
   el HTML genérico.
   ═══════════════════════════════════════════════════════════════════════════ */

const registry = require('./registry.cjs');

registry.registerConverter(require('./converters/moodle.cjs'));
registry.registerConverter(require('./converters/html.cjs'));
registry.registerConverter(require('./converters/pdf.cjs'));
registry.registerConverter(require('./converters/docx.cjs'));
registry.registerConverter(require('./converters/pptx.cjs'));
registry.registerConverter(require('./converters/text.cjs'));

registry.registerOutput(require('./outputs/pdf.cjs'));
registry.registerOutput(require('./outputs/markdown.cjs'));
registry.registerOutput(require('./outputs/plaintext.cjs'));
registry.registerOutput(require('./outputs/structured.cjs'));
registry.registerOutput(require('./outputs/chunks.cjs'));

module.exports = {
  ...registry,
  pipeline: require('./pipeline.cjs'),
  cleaners: require('./cleaners.cjs'),
};
