/* OCR de verdad, en Node pelado: fabrica un PDF "escaneado" —una página del
   cobayo rasterizada y metida como imagen, sin una sola letra de texto— y mira
   que el motor la reconozca con tesseract y los modelos de vendor/tessdata.

   Va aparte de motor.test.cjs porque tarda: levantar el worker de tesseract y
   reconocer una página lleva unos segundos. */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const RAIZ = path.join(__dirname, '..');
const motor = require(path.join(RAIZ, 'src', 'motor', 'index.cjs'));
const COBAYO = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');
const TESSDATA = path.join(RAIZ, 'vendor', 'tessdata');

(async () => {
  assert.ok(fs.existsSync(path.join(TESSDATA, 'spa.traineddata.gz')), 'falta vendor/tessdata/spa.traineddata.gz');
  assert.ok(fs.existsSync(path.join(TESSDATA, 'eng.traineddata.gz')), 'falta vendor/tessdata/eng.traineddata.gz');

  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-ocr-'));
  // Si la carpeta del caché no existe, tesseract deja los .traineddata en el cwd.
  fs.mkdirSync(path.join(carpeta, 'cache'));

  // ── 1. Rasterizar la primera página del cobayo ──────────────────────────
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const fuentes = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';
  const tarea = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(COBAYO)), isEvalSupported: false, standardFontDataUrl: fuentes });
  const doc = await tarea.promise;
  const pagina = await doc.getPage(1);
  const vp = pagina.getViewport({ scale: 2 });
  const lienzo = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vp }).promise;
  const png = await lienzo.encode('png');
  await tarea.destroy();

  // ── 2. Envolverla en un PDF sin capa de texto ───────────────────────────
  const { PDFDocument } = await import(pathToFileURL(path.join(RAIZ, 'renderer', 'vendor', 'pdf-lib', 'pdf-lib.mjs')).href);
  const escaneado = await PDFDocument.create();
  const img = await escaneado.embedPng(png);
  const hoja = escaneado.addPage([vp.width, vp.height]);
  hoja.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
  const rutaEscaneado = path.join(carpeta, 'escaneado.pdf');
  fs.writeFileSync(rutaEscaneado, await escaneado.save());

  // Sin OCR, esa página no tiene texto: es el punto de partida.
  const sinOcr = await motor.pipeline.extractDocument(rutaEscaneado, { ocr: false });
  assert.equal(sinOcr.metadata.pages, 0, 'el escaneado no debería tener texto sin OCR');

  // ── 3. Con OCR, lo lee ──────────────────────────────────────────────────
  const t0 = Date.now();
  const etapas = [];
  const conOcr = await motor.pipeline.extractDocument(rutaEscaneado, {
    ocr: true,
    tessdataPath: TESSDATA,
    ocrCachePath: path.join(carpeta, 'cache'),
  }, (p) => { if (p.label) etapas.push(p.label); });
  const ms = Date.now() - t0;

  assert.equal(conOcr.metadata.ocrError, undefined, `el OCR falló: ${conOcr.metadata.ocrError}`);
  assert.equal(conOcr.metadata.ocrPages, 1, 'tendría que haber pasado UNA página por OCR');
  assert.ok(etapas.some((l) => /^OCR /.test(l)), 'el progreso tiene que avisar la etapa de OCR');

  const texto = conOcr.sections.map((s) => s.paragraphs.join('\n')).join('\n');
  const letras = (texto.match(/\p{L}/gu) || []).length;
  // La primera página del cobayo dice "PÁGINA UNO", y eso tiene que salir.
  assert.ok(/P.GINA\s+UNO/i.test(texto), `el OCR no leyó "PÁGINA UNO": "${texto.slice(0, 80)}"`);

  // El cobayo real tiene tan poco texto por página (menos de 30 caracteres)
  // que también cae en la puerta del OCR. Lo que importa: pasar por OCR no
  // le arruina el texto que ya tenía.
  const real = await motor.pipeline.extractDocument(COBAYO, { ocr: true, tessdataPath: TESSDATA });
  const textoReal = real.sections.map((s) => s.paragraphs.join('\n')).join('\n');
  assert.ok(/P.GINA\s+UNO/i.test(textoReal), `el OCR pisó el texto real: "${textoReal.slice(0, 80)}"`);

  fs.rmSync(carpeta, { recursive: true, force: true });
  console.log(`ocr: 8 aserciones OK · ${letras} letras reconocidas en ${(ms / 1000).toFixed(1)} s`);
})().catch((err) => {
  console.error('ocr FALLÓ:', err);
  process.exit(1);
});
