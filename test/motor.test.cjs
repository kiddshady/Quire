/* El motor de conversión en Node pelado, sin Electron.
   Convierte el cuestionario Moodle de fixtures y el PDF cobayo a todo lo que
   no necesite Chromium (markdown, txt, json, chunks), y mira ADENTRO de lo que
   salió: preguntas contadas, guiones, encabezados. La salida PDF se prueba en
   test/convertir.cjs, que sí levanta Electron.

   Al final, el chofer (src/conversion.cjs) con un `electron` de mentira en el
   caché de require: alcanza para probar cancelar, la carpeta de Descargas y
   el filtro de la ventana de imprimir, que viven ahí y no en el motor. */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const RAIZ = path.join(__dirname, '..');
const motor = require(path.join(RAIZ, 'src', 'motor', 'index.cjs'));
const salidaPdf = require(path.join(RAIZ, 'src', 'motor', 'outputs', 'pdf.cjs'));
const conversorPdf = require(path.join(RAIZ, 'src', 'motor', 'converters', 'pdf.cjs'));
const { decodeText } = require(path.join(RAIZ, 'src', 'motor', 'encoding.cjs'));

const MOODLE = path.join(__dirname, 'fixtures', 'ejemplo-moodle.htm');
const COBAYO = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

let pasadas = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pasadas++;
}

/** Un libro de `n` páginas con texto distinto en cada una (si se repite, removeRepeatedLines lo borra). */
async function libro(n) {
  const { PDFDocument, StandardFonts } = await import(pathToFileURL(path.join(RAIZ, 'renderer', 'vendor', 'pdf-lib', 'pdf-lib.mjs')).href);
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const palabras = 'receptor agonista dosis efecto hepatico renal clearance enzima sustrato inhibidor'.split(' ');
  let s = 7;
  const azar = () => { s = (s * 1103515245 + 12345) % 2147483648; return s; };
  for (let p = 1; p <= n; p++) {
    const hoja = d.addPage([595, 842]);
    for (let l = 0; l < 8; l++) {
      hoja.drawText(Array.from({ length: 9 }, () => palabras[azar() % palabras.length]).join(' '), { x: 50, y: 780 - l * 18, size: 10, font: f });
    }
  }
  return Buffer.from(await d.save());
}

/** Un «escaneado» de mentira: `n` páginas chicas sin una letra, que caen todas en la puerta del OCR. */
async function enBlanco(n) {
  const { PDFDocument } = await import(pathToFileURL(path.join(RAIZ, 'renderer', 'vendor', 'pdf-lib', 'pdf-lib.mjs')).href);
  const d = await PDFDocument.create();
  for (let p = 0; p < n; p++) d.addPage([200, 100]);
  return Buffer.from(await d.save());
}

/* Un PDF cifrado con contraseña de usuario, armado a mano: pdf-lib no cifra.
   El /U no corresponde a ninguna clave, así que la contraseña vacía no lo
   abre y pdf.js pide una (PasswordException «No password given»). */
function pdfConClave() {
  const hex = (n, b) => Buffer.alloc(n, b).toString('hex');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${hex(32, 0x4f)}> /U <${hex(32, 0x55)}> >>`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${hex(16, 0x49)}> <${hex(16, 0x49)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/* Un await colgado sin nada vivo detrás hace que Node salga solo con código
   0, a mitad de la prueba. Con cancelar en juego (promesas que el corte deja
   sin resolver) eso pasaría por verde: acá se vuelve una falla. */
let llegoAlFinal = false;
process.on('exit', (codigo) => {
  if (!llegoAlFinal && codigo === 0) {
    console.error('motor FALLÓ: el proceso se quedó sin nada que esperar antes de terminar la prueba (¿una promesa colgada?)');
    process.exitCode = 1;
  }
});

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

  // ── main-10: el sanitizador de Moodle ───────────────────────────────────
  /* Un alt con etiquetas escapadas tiene que salir como texto: attr() lo
     devuelve decodificado y antes se parseaba como HTML. Y una imagen de la
     carpeta VECINA (mismo prefijo) no se inlinea; la propia sí. */
  {
    const dirX = path.join(carpeta, 'carpeta_x');
    const dirX2 = path.join(carpeta, 'carpeta_x2');
    fs.mkdirSync(dirX); fs.mkdirSync(dirX2);
    fs.writeFileSync(path.join(dirX, 'propia.png'), PNG_1X1);
    fs.writeFileSync(path.join(dirX2, 'foto.png'), PNG_1X1);
    const quiz = path.join(dirX, 'quiz.htm');
    fs.writeFileSync(quiz, `<html><head><title>Prueba</title></head><body>
      <div class="que multichoice deferredfeedback correct"><div class="info"><span class="qno">1</span><div class="state">Correcta</div></div>
      <div class="content"><div class="formulation"><div class="qtext">
        <p>Hola <img src="no-existe.png" alt="&lt;img src=https://example.com/x.png&gt;&lt;meta http-equiv=refresh content=0&gt;"></p>
        <p><img src="..\\carpeta_x2\\foto.png" alt="vecina"></p>
        <p><img src="propia.png" alt="propia"></p>
      </div></div></div></div></body></html>`);
    const q = (await motor.pipeline.extractDocument(quiz, {})).metadata.quiz.questions[0];
    ok(q.qtextHtml.includes('[imagen: &lt;img src=https://example.com/x.png&gt;'), `el alt con etiquetas sale como texto: ${q.qtextHtml.slice(0, 160)}`);
    ok(!/<img src="https:|<meta/i.test(q.qtextHtml), 'el alt no se volvió <img> ni <meta> de verdad');
    ok(q.qtextHtml.includes('[imagen: vecina]'), 'la imagen de la carpeta vecina (mismo prefijo) no se inlinea');
    ok((q.qtextHtml.match(/src="data:image\/png;base64,/g) || []).length === 1, 'la imagen propia sí se inlinea, y es la única');
  }

  // ── main-19: texto de Windows y UTF-16 ──────────────────────────────────
  {
    const w1252 = Buffer.from([0x93, ...Buffer.from('Farmaco'), 0x94, 0x20, 0x96, 0x20, 0x97, 0x20, 0x85, 0x80]);
    ok(decodeText(w1252) === '“Farmaco” – — …€', `windows-1252 da comillas y guiones, no controles C1 (${JSON.stringify(decodeText(w1252))})`);
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hola ñandú\r\nchau', 'utf16le')]);
    ok(decodeText(le) === 'Hola ñandú\nchau', `UTF-16 LE con BOM (${JSON.stringify(decodeText(le))})`);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Hola ñandú', 'utf16le').swap16()]);
    ok(decodeText(be) === 'Hola ñandú', `UTF-16 BE con BOM (${JSON.stringify(decodeText(be))})`);
    ok(decodeText(Buffer.from('﻿cañón', 'utf8')) === 'cañón', 'UTF-8 con BOM sigue igual');
    // Y de punta a punta, por el conversor de texto.
    const viejo = path.join(carpeta, 'viejo.txt');
    fs.writeFileSync(viejo, Buffer.concat([Buffer.from('Apunte de '), w1252]));
    const doc = await motor.pipeline.extractDocument(viejo, {});
    const todo = doc.sections.map((s) => s.paragraphs.join('\n')).join('\n') + doc.title;
    ok(todo.includes('“Farmaco”'), `el .txt de Windows sale con sus comillas (${JSON.stringify(todo.slice(0, 60))})`);
  }

  // ── main-18: PDF con contraseña o dañado ────────────────────────────────
  /* El mensaje en castellano, y la tarea de pdf.js destruida aunque haya
     fallado al abrir. Para ver la tarea, el conversor usa un pdf.js envuelto
     que anota las que abre. */
  const conClave = path.join(carpeta, 'con-clave.pdf');
  fs.writeFileSync(conClave, pdfConClave());
  {
    const real = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const tareas = [];
    conversorPdf.usarPdfjsParaTests({ ...real, getDocument: (...a) => { const t = real.getDocument(...a); tareas.push(t); return t; } });
    try {
      await assert.rejects(() => motor.pipeline.extractDocument(conClave, { ocr: false }),
        (err) => err.message === 'Tiene contraseña: Quire no puede leerlo.', 'el PDF con contraseña avisa en castellano');
      pasadas++;
      ok(tareas.length === 1 && tareas[0].destroyed === true, 'la tarea del PDF con contraseña quedó destruida');
      const danado = path.join(carpeta, 'danado.pdf');
      fs.writeFileSync(danado, '%PDF-1.4\nesto no tiene ni un objeto\n%%EOF\n');
      await assert.rejects(() => motor.pipeline.extractDocument(danado, { ocr: false }),
        (err) => err.message === 'El PDF está dañado.', 'el PDF dañado avisa en castellano');
      pasadas++;
      ok(tareas.length === 2 && tareas[1].destroyed === true, 'la tarea del PDF dañado quedó destruida');
    } finally {
      conversorPdf.usarPdfjsParaTests(null);
    }
  }

  // ── herr-11: file-done trae el resultado de SU archivo ──────────────────
  {
    const dir = path.join(carpeta, 'rico');
    const eventos = [];
    const r = await motor.pipeline.convertBatch({
      files: [MOODLE, conClave], outputs: ['txt', 'markdown'],
      options: { destino: { modo: 'carpeta', ruta: dir } },
      onProgress: (e) => eventos.push(e),
    });
    const hechos = eventos.filter((e) => e.type === 'file-done');
    ok(hechos.length === 2, 'un file-done por archivo');
    const [bien, mal] = hechos;
    ok(bien.ok && Array.isArray(bien.outputs) && bien.outputs.length === 2 && bien.outputs.every((o, i) => o.path === r.results[0].outputs[i].path && o.bytes > 0),
      `el file-done del que salió trae sus salidas (${JSON.stringify(bien.outputs)})`);
    ok(bien.outDir === dir, 'y su carpeta');
    ok(bien.meta && bien.meta.converter === 'moodle' && bien.meta.questions > 0, `y su ficha (${JSON.stringify(bien.meta)})`);
    ok(!mal.ok && mal.error === 'Tiene contraseña: Quire no puede leerlo.' && Array.isArray(mal.outputs) && mal.outputs.length === 0, `el que falló trae el motivo (${mal.error})`);
    ok(eventos.indexOf(bien) < eventos.findIndex((e) => e.type === 'file-start' && e.index === 1), 'el primero avisa antes de que empiece el segundo');
  }

  // ── main-20: cancelar corta el lote ─────────────────────────────────────
  const grande = path.join(carpeta, 'libro.pdf');
  fs.writeFileSync(grande, await libro(400));
  {
    // Entre páginas: se corta en la página 5 de 400 y el segundo ni empieza.
    const dir = path.join(carpeta, 'corte-paginas');
    const control = new AbortController();
    const ev = [];
    const r = await motor.pipeline.convertBatch({
      files: [grande, MOODLE], outputs: ['txt'],
      options: { destino: { modo: 'carpeta', ruta: dir }, ocr: false },
      signal: control.signal,
      onProgress: (e) => { ev.push(e); if (e.type === 'stage' && e.done === 5) control.abort(); },
    });
    const paginas = ev.filter((e) => e.type === 'stage' && e.stage === 'extract');
    ok(r.cancelado === true, 'el resultado dice que se canceló');
    ok(paginas.length && paginas.at(-1).done <= 6, `cortó entre páginas (la última fue la ${paginas.at(-1)?.done} de 400)`);
    ok(r.results.length === 2 && r.results.every((x) => !x.ok && x.cancelado === true && x.error === 'Conversión cancelada.'),
      `una entrada por archivo, las dos canceladas (${JSON.stringify(r.results.map((x) => [x.ok, x.cancelado, x.error]))})`);
    ok(!ev.some((e) => e.type === 'file-start' && e.index === 1), 'el segundo archivo no llegó a empezar');
    const hecho = ev.find((e) => e.type === 'file-done');
    ok(hecho && hecho.cancelado === true && !hecho.ok, 'el file-done del interrumpido dice cancelado');
    const corte = ev.find((e) => e.type === 'batch-cancelled');
    ok(corte && corte.index === 0 && corte.total === 2, `batch-cancelled dice dónde se cortó (${JSON.stringify(corte)})`);
    ok(ev.at(-1).type === 'batch-done' && ev.at(-1).cancelado === true, 'batch-done cierra, con cancelado');
    ok(r.errors.length === 0, 'un corte no es un error');
    ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no quedó nada escrito, ni _errores.txt');
  }
  {
    // Entre archivos: el primero sale entero, el segundo no empieza.
    const dir = path.join(carpeta, 'corte-archivos');
    const control = new AbortController();
    const ev = [];
    const r = await motor.pipeline.convertBatch({
      files: [MOODLE, copia], outputs: ['txt'],
      options: { destino: { modo: 'carpeta', ruta: dir } },
      signal: control.signal,
      onProgress: (e) => { ev.push(e); if (e.type === 'file-done') control.abort(); },
    });
    ok(r.results[0].ok && r.results[0].outputs.length === 1, 'el que ya había terminado queda con su salida');
    ok(r.results[1].cancelado === true && !ev.some((e) => e.type === 'file-start' && e.index === 1), 'el siguiente no empieza');
    ok(ev.find((e) => e.type === 'batch-cancelled')?.index === 1, 'batch-cancelled apunta al que no empezó');
  }

  // ── Revisión de 0B2: el OCR del lote cuando algo falla ──────────────────
  const blanco = path.join(carpeta, 'escaneado-en-blanco.pdf');
  fs.writeFileSync(blanco, await enBlanco(6));
  const apunte = path.join(carpeta, 'apunte.txt');
  fs.writeFileSync(apunte, 'Apunte de Farmaco: receptores, agonistas y antagonistas.');
  const sinModelos = path.join(carpeta, 'tessdata-de-mentira');   // con el OCR prendido hace falta una ruta
  {
    /* Si tesseract.js no carga (el riesgo del build empaquetado), el lote
       sigue: el .txt sale entero y el escaneado sale sin OCR, con el motivo.
       Antes el require vivía en crearPoolOcr, que el pipeline llama para todo
       lote con el OCR prendido, y el lote entero rechazaba. */
    const cargar = Module._load;
    Module._load = function (pedido, ...resto) {
      if (pedido === 'tesseract.js') throw new Error("Cannot find module 'tesseract.js'");
      return cargar.call(this, pedido, ...resto);
    };
    let r;
    try {
      r = await motor.pipeline.convertBatch({
        files: [apunte, blanco], outputs: ['txt'],
        options: { destino: { modo: 'carpeta', ruta: path.join(carpeta, 'sin-tesseract') }, ocr: true, tessdataPath: sinModelos },
      }).catch((err) => ({ rechazo: err.message }));
    } finally {
      Module._load = cargar;
    }
    ok(!r.rechazo, `sin tesseract.js el lote no rechaza (${r.rechazo})`);
    ok(r.results?.[0].ok, 'el .txt sale aunque tesseract.js no cargue');
    ok(r.results?.[1].ok && /Cannot find module 'tesseract\.js'/.test(r.results[1].meta.ocrError || ''),
      `el escaneado sale sin OCR y con el motivo (${r.results?.[1].meta?.ocrError})`);
  }
  {
    /* Un reconocimiento que falla a mitad de un PDF: los que ya estaban en
       vuelo terminan ANTES del file-done de ese archivo. Antes, ocrPages
       tiraba en el acto y sus .then seguían avisando «OCR 3/6» con el index
       viejo después del file-done (y del batch-done), y ocupaban el pool
       cuando arrancaba el siguiente. Pool de mentira: el segundo
       reconocimiento falla a los 5 ms, los demás tardan 80. */
    const ocr = require(path.join(RAIZ, 'src', 'motor', 'ocr.cjs'));
    const crearPool = ocr.crearPoolOcr;
    let llamadas = 0;
    let enCurso = 0;
    ocr.crearPoolOcr = () => ({
      tope: 2,
      workers: 1,
      reconocer: () => {
        const k = ++llamadas;
        enCurso++;
        return new Promise((resolve, reject) => setTimeout(() => {
          enCurso--;
          if (k === 2) reject(new Error('el segundo reconocimiento falló'));
          else resolve(`texto reconocido ${k}`);
        }, k === 2 ? 5 : 80));
      },
      terminar: async () => {},
    });
    const ev = [];
    let enCursoAlSiguiente = null;
    let r;
    try {
      r = await motor.pipeline.convertBatch({
        files: [blanco, apunte], outputs: ['txt'],
        options: { destino: { modo: 'carpeta', ruta: path.join(carpeta, 'ocr-falla') }, ocr: true, tessdataPath: sinModelos },
        onProgress: (e) => {
          ev.push(e);
          if (e.type === 'file-start' && e.index === 1) enCursoAlSiguiente = enCurso;
        },
      });
      // Lo que hubiera quedado suelto tiene tiempo de avisar.
      await new Promise((listo) => setTimeout(listo, 250));
    } finally {
      ocr.crearPoolOcr = crearPool;
    }
    const hecho = ev.findIndex((e) => e.type === 'file-done' && e.index === 0);
    const tarde = ev.slice(hecho + 1).filter((e) => e.index === 0);
    ok(r.results[0].ok && r.results[0].meta.ocrError === 'el segundo reconocimiento falló',
      `el PDF sale sin OCR y con el motivo (${r.results[0].meta?.ocrError})`);
    ok(hecho >= 0 && tarde.length === 0, `después de su file-done no llega nada más de ese archivo: ${JSON.stringify(tarde.map((e) => e.label || e.type))}`);
    ok(enCursoAlSiguiente === 0, `cuando arranca el siguiente, el pool no tiene trabajos del anterior (${enCursoAlSiguiente})`);
  }
  {
    // Unir cortado resuelve con { cancelado: true }, como convertir, y no escribe nada.
    const control = new AbortController();
    control.abort();
    const dir = path.join(carpeta, 'unir-cortado');
    const r = await motor.pipeline.mergeFiles({ files: [a, b], options: { destino: { modo: 'carpeta', ruta: dir } }, signal: control.signal })
      .catch((err) => ({ rechazo: err.message }));
    ok(r.cancelado === true && !r.rechazo, `unir cortado vuelve con cancelado, no rechaza (${r.rechazo || JSON.stringify(r)})`);
    ok(!fs.existsSync(dir), 'y no escribe nada');
  }

  // ── El chofer: src/conversion.cjs con un electron de mentira ────────────
  /* USERPROFILE a una carpeta propia: os.homedir() lo lee en cada llamada, y
     así ni el código viejo (que caía a ~/Downloads) escribe en las Descargas
     de verdad si este test se corre al revés. */
  process.env.USERPROFILE = path.join(carpeta, 'casa');
  process.env.HOME = process.env.USERPROFILE;
  const descargas = path.join(carpeta, 'descargas-movidas');
  const enviados = [];
  let cortarEnLaPagina = 0;
  let cortarAlUnir = false;
  /* La ventana de imprimir y su partición, de mentira: htmlToPdf le pide la
     sesión a session.fromPartition y le cuelga un onBeforeRequest. Al cargar,
     la ventana le pregunta a ese filtro qué deja pasar, sin salir a ninguna
     red. */
  let filtroImprimir = null;
  const pasa = (url) => {
    let r = null;
    filtroImprimir({ url }, (x) => { r = x; });
    return Boolean(r) && !r.cancel;
  };
  const ventanasImprimir = [];
  class VentanaFalsa {
    static getFocusedWindow() { return null; }
    static getAllWindows() { return []; }
    constructor(opciones) {
      this.opciones = opciones;
      this.webContents = { on: () => {}, setWindowOpenHandler: () => {}, printToPDF: async () => Buffer.from('%PDF-de-mentira') };
      ventanasImprimir.push(this);
    }
    async loadURL(url) {
      this.url = url;
      this.durante = {
        propio: pasa(url),
        data: pasa('data:image/png;base64,iVBORw0KGgo='),
        unc: pasa('file://servidor/recurso/x.png'),
        otroLocal: pasa(pathToFileURL(path.join(carpeta, 'otro.html')).href),
        red: pasa('https://example.com/x.png'),
      };
    }
    destroy() {}
  }
  const electronFalso = {
    app: {
      isPackaged: false,
      getPath: (n) => (n === 'downloads' ? descargas : path.join(carpeta, `electron-${n}`)),
    },
    BrowserWindow: VentanaFalsa,
    dialog: {}, shell: {},
    session: { fromPartition: (nombre) => ({ nombre, webRequest: { onBeforeRequest: (fn) => { filtroImprimir = fn; } } }) },
  };
  const idElectron = require.resolve('electron');
  const falso = new Module(idElectron);
  falso.filename = idElectron;
  falso.exports = electronFalso;
  falso.loaded = true;
  require.cache[idElectron] = falso;
  const conversion = require(path.join(RAIZ, 'src', 'conversion.cjs'));
  conversion.iniciar(() => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_canal, e) => {
        enviados.push(e);
        if (cortarEnLaPagina && e.type === 'stage' && e.done === cortarEnLaPagina) conversion.cancelar();
        if (cortarAlUnir && e.type === 'merge') conversion.cancelar();
      },
    },
  }));

  {
    // main-14: «Descargas» es la carpeta que diga Electron, no ~/Downloads.
    const r = await conversion.convertir({ files: [MOODLE], outputs: ['txt'], options: { destino: { modo: 'descargas' } } });
    ok(r.results[0].ok && r.outDirs[0].startsWith(path.join(descargas, 'Quire')), `convertir a Descargas usa app.getPath('downloads') (${r.outDirs[0]})`);
    const u = await conversion.unir({ files: [a, b], options: { destino: { modo: 'descargas' } } });
    ok(u.path.startsWith(path.join(descargas, 'Quire')), `unir a Descargas también (${u.path})`);
  }
  {
    // main-20: conversion.cancelar() corta el lote en marcha, y después se puede volver a convertir.
    ok(conversion.cancelar() === false, 'sin un lote en marcha, cancelar no tiene nada que cortar');
    cortarEnLaPagina = 3;
    const dir = path.join(carpeta, 'corte-chofer');
    const r = await conversion.convertir({
      files: [grande, MOODLE], outputs: ['txt'], options: { destino: { modo: 'carpeta', ruta: dir }, ocr: false },
    });
    cortarEnLaPagina = 0;
    const paginas = enviados.filter((e) => e.type === 'stage' && e.stage === 'extract');
    ok(r.cancelado === true && r.results.every((x) => x.cancelado === true), 'conversion.cancelar() cortó el lote');
    ok(paginas.at(-1).done <= 4, `a la página siguiente (${paginas.at(-1).done} de 400)`);
    ok(enviados.some((e) => e.type === 'batch-cancelled'), 'la ventana recibió batch-cancelled');
    const otra = await conversion.convertir({ files: [MOODLE], outputs: ['txt'], options: { destino: { modo: 'carpeta', ruta: dir } } });
    ok(otra.results[0].ok && !otra.cancelado, 'después del corte, el candado se soltó y se puede convertir otra vez');
  }
  {
    // Unir cortado desde el chofer: el renderer recibe { cancelado }, no un error de IPC.
    cortarAlUnir = true;
    const dir = path.join(carpeta, 'unir-chofer');
    const u = await conversion.unir({ files: [a, b], options: { destino: { modo: 'carpeta', ruta: dir } } })
      .catch((err) => ({ rechazo: err.message }));
    cortarAlUnir = false;
    ok(u.cancelado === true && !u.rechazo, `conversion.unir cortado resuelve con cancelado (${u.rechazo || JSON.stringify(u)})`);
    ok(!fs.existsSync(dir), 'y no escribe nada');
  }
  {
    /* main-10, revisión de 0B2: la partición de imprimir deja pasar data: y
       el .html de ESA impresión, nada más. Antes pasaba cualquier file:,
       también una UNC con host, que Chromium resuelve por SMB (y eso puede
       entregar el hash NTLM del usuario). */
    fs.mkdirSync(path.join(carpeta, 'electron-temp'), { recursive: true });
    const pdf = await conversion.htmlToPdf('<p>hola</p>');
    const v = ventanasImprimir.at(-1);
    ok(pdf.toString() === '%PDF-de-mentira' && v.opciones.webPreferences.session?.nombre === 'quire-imprimir', 'imprime con su partición propia');
    ok(v.durante.propio && v.durante.data, `pasan el .html de la impresión y las data: (${JSON.stringify(v.durante)})`);
    ok(!v.durante.unc, 'una file: con host (UNC) no pasa');
    ok(!v.durante.otroLocal && !v.durante.red, `ni otro archivo local ni la red (${JSON.stringify(v.durante)})`);
    ok(!pasa(v.url), 'terminada la impresión, ni su propio .html pasa');
  }

  fs.rmSync(carpeta, { recursive: true, force: true });
  llegoAlFinal = true;
  console.log(`motor: ${pasadas} aserciones OK`);
})().catch((err) => {
  console.error('motor FALLÓ:', err);
  process.exit(1);
});
