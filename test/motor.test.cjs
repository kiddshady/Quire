/* El motor de conversión en Node pelado, sin Electron.
   Convierte el cuestionario Moodle de fixtures y el PDF cobayo a todo lo que
   no necesite Chromium (markdown, txt, json, chunks), y mira ADENTRO de lo que
   salió: preguntas contadas, guiones, encabezados. La salida PDF se prueba en
   test/convertir.cjs, que sí levanta Electron. */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RAIZ = path.join(__dirname, '..');
const motor = require(path.join(RAIZ, 'src', 'motor', 'index.cjs'));
const salidaPdf = require(path.join(RAIZ, 'src', 'motor', 'outputs', 'pdf.cjs'));

const MOODLE = path.join(__dirname, 'fixtures', 'ejemplo-moodle.htm');
const COBAYO = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

let pasadas = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pasadas++;
}

(async () => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-motor-'));

  // ── Registro ────────────────────────────────────────────────────────────
  const conversores = motor.listConverters().map((c) => c.name);
  const salidas = motor.listOutputs().map((o) => o.name);
  assert.deepEqual(conversores, ['moodle', 'html', 'pdf', 'docx', 'pptx', 'text']);
  assert.deepEqual(salidas, ['pdf', 'markdown', 'txt', 'json', 'chunks']);
  pasadas += 2;

  // Moodle gana al HTML genérico para .htm cuando hay preguntas.
  const datos = fs.readFileSync(MOODLE);
  ok(motor.findConverter('x.htm', datos).name === 'moodle', 'un .htm con div.que va a moodle');
  ok(motor.findConverter('x.htm', Buffer.from('<html><p>hola</p></html>')).name === 'html', 'un .htm pelado va al genérico');
  ok(motor.findConverter('x.xyz', null) === null, 'una extensión desconocida no tiene conversor');

  // ── Moodle → Document ───────────────────────────────────────────────────
  const doc = await motor.pipeline.extractDocument(MOODLE, {});
  const quiz = doc.metadata.quiz;
  ok(quiz && quiz.nTotal > 0, `el cuestionario trae preguntas (${quiz?.nTotal})`);
  ok(quiz.questions.every((q) => q.no > 0 && typeof q.state === 'string'), 'cada pregunta tiene número y estado');
  ok(doc.sections.some((s) => /^Pregunta \d+/.test(s.title)), 'las secciones se titulan "Pregunta N" en castellano');
  ok(!doc.sections.some((s) => /^Question \d+/.test(s.title)), 'no quedó ningún "Question N"');

  // El template del PDF se arma sin Chromium; imprimirlo es lo único que lo necesita.
  const html = salidaPdf.buildHtml(doc);
  ok(html.includes('<h1>') && html.length > 2000, `el template del examen tiene cuerpo (${html.length} chars)`);
  ok(!/Attempt review/.test(html), 'el template no habla en inglés');
  await assert.rejects(() => salidaPdf.render(doc, {}), /htmlToPdf/, 'sin htmlToPdf la salida PDF avisa en vez de explotar');
  pasadas++;

  // ── Lote a una carpeta ──────────────────────────────────────────────────
  const lote = await motor.pipeline.convertBatch({
    files: [MOODLE],
    outputs: ['markdown', 'txt', 'json', 'chunks'],
    options: { destino: { modo: 'carpeta', ruta: carpeta }, chunkSize: 600, chunkOverlap: 100 },
  });
  ok(lote.results[0].ok, `el lote convirtió sin error (${lote.results[0].error || 'ok'})`);
  ok(lote.results[0].outputs.length === 4, 'salieron las cuatro salidas');
  assert.deepEqual(lote.outDirs, [carpeta]);
  pasadas++;
  for (const o of lote.results[0].outputs) {
    ok(fs.existsSync(o.path) && fs.statSync(o.path).size === o.bytes, `${o.name} está en disco con su tamaño (${o.bytes})`);
  }
  const md = fs.readFileSync(path.join(carpeta, 'ejemplo-moodle.md'), 'utf8');
  ok(md.startsWith('---'), 'el markdown lleva frontmatter por defecto');
  ok(md.includes('## Pregunta 1'), 'el markdown tiene la primera pregunta');
  const json = JSON.parse(fs.readFileSync(path.join(carpeta, 'ejemplo-moodle.json'), 'utf8'));
  ok(json.sections?.length === doc.sections.length, 'el JSON trae todas las secciones');
  const chunks = fs.readFileSync(path.join(carpeta, 'ejemplo-moodle.chunks.json'), 'utf8');
  ok(chunks.length > 0, 'los chunks no salieron vacíos');

  // Convertir de nuevo al mismo lugar no pisa: numera.
  const otra = await motor.pipeline.convertBatch({
    files: [MOODLE], outputs: ['txt'], options: { destino: { modo: 'carpeta', ruta: carpeta } },
  });
  ok(otra.results[0].outputs[0].path.endsWith('ejemplo-moodle (2).txt'), 'la colisión de nombre se resuelve con " (2)"');

  // ── Junto al original ───────────────────────────────────────────────────
  const copia = path.join(carpeta, 'junto.htm');
  fs.copyFileSync(MOODLE, copia);
  fs.cpSync(path.join(__dirname, 'fixtures', 'ejemplo-moodle_files'), path.join(carpeta, 'junto_files'), { recursive: true });
  const junto = await motor.pipeline.convertBatch({ files: [copia], outputs: ['txt'], options: {} });
  ok(junto.results[0].outputs[0].path === path.join(carpeta, 'junto.txt'), 'sin destino, la salida cae al lado del original');

  // ── PDF → texto (pdf.js en Node, la parte que más se puede romper) ───────
  const pdf = await motor.pipeline.extractDocument(COBAYO, { ocr: false });
  ok(pdf.metadata.converter === 'pdf', 'el PDF lo tomó el conversor pdf');
  ok(pdf.metadata.pages > 0, `el cobayo tiene páginas con texto (${pdf.metadata.pages})`);
  ok(pdf.sections[0].title.startsWith('Página '), 'las secciones del PDF se titulan "Página N"');

  // ── Unir textos ─────────────────────────────────────────────────────────
  const a = path.join(carpeta, 'a.md'); fs.writeFileSync(a, '# A\n\nuno');
  const b = path.join(carpeta, 'b.txt'); fs.writeFileSync(b, 'dos');
  const unido = await motor.pipeline.mergeFiles({ files: [a, b], options: { destino: { modo: 'carpeta', ruta: carpeta } } });
  const texto = fs.readFileSync(unido.path, 'utf8');
  ok(texto.includes('## a') && texto.includes('## b') && texto.includes('\n---\n'), 'el unido lleva un encabezado por archivo y separadores');
  await assert.rejects(
    () => motor.pipeline.mergeFiles({ files: [a, COBAYO] }),
    /Combinar/, 'unir un PDF acá manda a Herramientas → Combinar',
  );
  pasadas++;
  await assert.rejects(() => motor.pipeline.mergeFiles({ files: [a] }), /2 archivos/);
  pasadas++;

  fs.rmSync(carpeta, { recursive: true, force: true });
  console.log(`motor: ${pasadas} aserciones OK`);
})().catch((err) => {
  console.error('motor FALLÓ:', err);
  process.exit(1);
});
