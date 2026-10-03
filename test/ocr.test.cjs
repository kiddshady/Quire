/* OCR de verdad, en Node pelado: fabrica un PDF "escaneado" —una página del
   cobayo rasterizada y metida como imagen, sin una sola letra de texto— y mira
   que el motor la reconozca con tesseract y los modelos de vendor/tessdata.

   Va aparte de motor.test.cjs porque tarda: levantar el worker de tesseract y
   reconocer una página lleva unos segundos.

   También cuida lo de 0B2: el caché de los modelos no cae en el directorio
   de trabajo (main-21), un lote levanta los workers una sola vez y reconoce
   varias páginas a la vez sin mezclarlas (main-22) —también con el caché
   vacío, sin que un worker lo lea a medio escribir—, los modelos faltantes
   no tumban el proceso, y cancelar corta el OCR (main-20). */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const RAIZ = path.join(__dirname, '..');
const motor = require(path.join(RAIZ, 'src', 'motor', 'index.cjs'));
const tesseract = require('tesseract.js');
const COBAYO = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');
const TESSDATA = path.join(RAIZ, 'vendor', 'tessdata');

/* Si un await se queda colgado y no queda nada vivo (los workers de
   tesseract ya terminados), Node sale solo con código 0 y sin terminar la
   prueba: parecería que pasó. Medido al correr al revés el corte del OCR. */
let llegoAlFinal = false;
process.on('exit', (codigo) => {
  if (!llegoAlFinal && codigo === 0) {
    console.error('ocr FALLÓ: el proceso se quedó sin nada que esperar antes de terminar la prueba (¿una promesa colgada?)');
    process.exitCode = 1;
  }
});

(async () => {
  assert.ok(fs.existsSync(path.join(TESSDATA, 'spa.traineddata.gz')), 'falta vendor/tessdata/spa.traineddata.gz');
  assert.ok(fs.existsSync(path.join(TESSDATA, 'eng.traineddata.gz')), 'falta vendor/tessdata/eng.traineddata.gz');

  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-ocr-'));
  const notas = [];
  // Si la carpeta del caché no existe, tesseract deja los .traineddata en el cwd.
  fs.mkdirSync(path.join(carpeta, 'cache'));

  // ── 1. Rasterizar las páginas del cobayo ────────────────────────────────
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const fuentes = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';
  const tarea = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(COBAYO)), isEvalSupported: false, standardFontDataUrl: fuentes });
  const doc = await tarea.promise;
  const fotos = [];   // { png, vp } de cada página: «PÁGINA UNO», «DOS», «TRES», «CUATRO»
  for (let n = 1; n <= Math.min(4, doc.numPages); n++) {
    const pagina = await doc.getPage(n);
    const vp = pagina.getViewport({ scale: 2 });
    const lienzo = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vp }).promise;
    fotos.push({ png: await lienzo.encode('png'), vp });
  }
  await tarea.destroy();
  assert.equal(fotos.length, 4, 'el cobayo tendría que tener 4 páginas');

  // ── 2. Envolverlas en PDFs sin capa de texto ────────────────────────────
  const { PDFDocument } = await import(pathToFileURL(path.join(RAIZ, 'renderer', 'vendor', 'pdf-lib', 'pdf-lib.mjs')).href);
  async function escanear(nombre, paginas) {
    const pdf = await PDFDocument.create();
    for (const i of paginas) {
      const { png, vp } = fotos[i];
      const img = await pdf.embedPng(png);
      pdf.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    }
    const ruta = path.join(carpeta, nombre);
    fs.writeFileSync(ruta, await pdf.save());
    return ruta;
  }
  const rutaEscaneado = await escanear('escaneado.pdf', [0]);

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
  const real = await motor.pipeline.extractDocument(COBAYO, { ocr: true, tessdataPath: TESSDATA, ocrCachePath: path.join(carpeta, 'cache') });
  const textoReal = real.sections.map((s) => s.paragraphs.join('\n')).join('\n');
  assert.ok(/P.GINA\s+UNO/i.test(textoReal), `el OCR pisó el texto real: "${textoReal.slice(0, 80)}"`);

  // ── 4. main-21: sin ocrCachePath, nada cae en el directorio de trabajo ──
  /* tesseract escribe el caché en `${cachePath || '.'}`: con el código viejo,
     correr esto dejaba spa.traineddata y eng.traineddata (41 MB) en la raíz
     del repo. Se corre con el cwd en una carpeta vacía y se mira que siga
     vacía. */
  {
    const cwd = path.join(carpeta, 'cwd');
    fs.mkdirSync(cwd);
    const antes = process.cwd();
    process.chdir(cwd);
    try {
      const d = await motor.pipeline.extractDocument(rutaEscaneado, { ocr: true, tessdataPath: TESSDATA });
      assert.equal(d.metadata.ocrError, undefined, `el OCR sin ocrCachePath falló: ${d.metadata.ocrError}`);
    } finally {
      process.chdir(antes);
    }
    const quedaron = fs.readdirSync(cwd);
    assert.deepEqual(quedaron, [], `sin ocrCachePath, tesseract dejó archivos en el cwd: ${quedaron.join(', ')}`);
  }

  // ── 5. main-22: un lote levanta los workers UNA vez ─────────────────────
  /* Dos escaneados de una página: antes, un worker (y una carga de spa+eng)
     por PDF; ahora el pool es del lote y la segunda página reusa el worker
     de la primera. Se cuentan los createWorker envolviendo el del módulo. */
  const crearWorker = tesseract.createWorker;
  let creados = 0;
  tesseract.createWorker = (...a) => { creados++; return crearWorker(...a); };
  try {
    const otro = await escanear('escaneado-dos.pdf', [1]);
    const lote = await motor.pipeline.convertBatch({
      files: [rutaEscaneado, otro], outputs: ['txt'],
      options: { destino: { modo: 'carpeta', ruta: path.join(carpeta, 'lote') }, ocr: true, tessdataPath: TESSDATA, ocrCachePath: path.join(carpeta, 'cache') },
    });
    assert.ok(lote.results.every((r) => r.ok && r.meta.ocrPages === 1 && !r.meta.ocrError),
      `el lote de dos escaneados tenía que salir con OCR: ${JSON.stringify(lote.results.map((r) => [r.ok, r.meta, r.error]))}`);
    assert.equal(creados, 1, `un lote de dos escaneados de una página tendría que levantar UN worker, levantó ${creados}`);
    const textos = lote.results.map((r) => fs.readFileSync(r.outputs[0].path, 'utf8'));
    assert.ok(/P.GINA\s+UNO/i.test(textos[0]) && /P.GINA\s+DOS/i.test(textos[1]), `cada archivo con su texto: ${JSON.stringify(textos.map((t) => t.slice(0, 40)))}`);

    // Cuatro páginas en un PDF: se reconocen a la vez, y cada texto en su página.
    creados = 0;
    const cuatro = await escanear('cuatro.pdf', [0, 1, 2, 3]);
    const d4 = await motor.pipeline.extractDocument(cuatro, { ocr: true, tessdataPath: TESSDATA, ocrCachePath: path.join(carpeta, 'cache') });
    assert.equal(d4.metadata.ocrPages, 4, `tendrían que pasar las 4 páginas por OCR: ${d4.metadata.ocrError}`);
    const porPagina = d4.sections.map((s) => s.paragraphs.join(' '));
    const esperadas = ['UNO', 'DOS', 'TRES', 'CUATRO'];
    assert.ok(esperadas.every((p, i) => new RegExp(`P.GINA\\s+${p}`, 'i').test(porPagina[i] || '')),
      `el OCR en paralelo mezcló las páginas: ${JSON.stringify(porPagina)}`);
    assert.ok(creados >= 1 && creados <= 3, `entre 1 y 3 workers para 4 páginas (${creados})`);
    notas.push(`${creados} worker(s) para 4 páginas`);
  } finally {
    tesseract.createWorker = crearWorker;
  }

  // ── 6. Sin modelos, el OCR cae y la conversión sigue ────────────────────
  /* Con el código viejo esto TUMBABA el proceso: tesseract.js, sin
     errorHandler, tira desde el listener del worker (ENOENT del
     .traineddata.gz) y es una excepción no atrapada. */
  {
    const sinModelos = await motor.pipeline.extractDocument(rutaEscaneado, {
      ocr: true, tessdataPath: path.join(carpeta, 'no-hay-modelos'), ocrCachePath: path.join(carpeta, 'cache-vacio'),
    });
    assert.ok(/traineddata|ENOENT/i.test(sinModelos.metadata.ocrError || ''), `sin modelos tendría que anotar el error de OCR: ${sinModelos.metadata.ocrError}`);
    assert.equal(sinModelos.metadata.ocrPages, undefined, 'sin modelos no hay páginas reconocidas');
  }

  // ── 7. main-20: cancelar en medio del OCR ───────────────────────────────
  /* Ocho páginas escaneadas y se corta con el primer reconocimiento. Como se
     adelantan a lo sumo tantas páginas como workers más una, sin el corte
     las que faltan se rasterizarían y reconocerían DESPUÉS de cancelar. Se
     anota cuándo arranca cada reconocimiento envolviendo el recognize de
     cada worker: después del corte no puede arrancar ninguno. Y los workers
     quedan terminados: si no, este proceso no terminaría (los worker_threads
     lo mantienen vivo). */
  {
    const ocho = await escanear('ocho.pdf', [0, 1, 2, 3, 0, 1, 2, 3]);
    const crear = tesseract.createWorker;
    const arranques = [];
    tesseract.createWorker = async (...a) => {
      const w = await crear(...a);
      const reconocer = w.recognize;
      w.recognize = (...b) => { arranques.push(Date.now()); return reconocer(...b); };
      return w;
    };
    const control = new AbortController();
    const t1 = Date.now();
    let tCorte = 0;
    let r;
    try {
      r = await motor.pipeline.convertBatch({
        files: [ocho], outputs: ['txt'],
        options: { destino: { modo: 'carpeta', ruta: path.join(carpeta, 'corte') }, ocr: true, tessdataPath: TESSDATA, ocrCachePath: path.join(carpeta, 'cache') },
        signal: control.signal,
        onProgress: (e) => {
          if (!tCorte && /^OCR 1\//.test(e.label || '')) { tCorte = Date.now(); control.abort(); }
        },
      });
    } finally {
      tesseract.createWorker = crear;
    }
    const tarde = arranques.filter((t) => t > tCorte).length;
    assert.ok(tCorte, 'el OCR tendría que haber empezado');
    assert.ok(r.cancelado && r.results[0].cancelado, `el lote tendría que volver cancelado: ${JSON.stringify(r.results[0])}`);
    assert.equal(tarde, 0, `después del corte arrancaron ${tarde} reconocimientos (de ${arranques.length})`);
    notas.push(`corte del OCR en ${Date.now() - tCorte} ms, ${arranques.length} de 8 páginas llegaron a tesseract (lote de ${Date.now() - t1} ms)`);
  }

  // ── 8. main-22 con el caché vacío: nadie lo lee a medio escribir ────────
  /* tesseract escribe el caché con un fs.writeFile que no es atómico, y un
     worker que lo lee a medio escribir pierde un idioma sin avisar: sus
     páginas salen sin tildes ni eñes y ocrError queda vacío. Lo encontró la
     revisión de 0B2 en 4 de 8 corridas, con 6 páginas iguales y el caché
     vacío; el paso 5 no lo veía porque usa el caché que ya llenó el paso 3.
     Se miran dos cosas: que con el caché vacío no arranque ningún worker
     hasta que el primero esté listo (eso no depende de la suerte) y que
     todas las páginas salgan con sus eñes y sus tildes. Lo primero es la
     guarda que no falla nunca al revés; lo segundo es el síntoma, y depende
     de los tiempos: páginas de 470×300 con un renglón, que se rasterizan en
     ~40 ms, hacen que el segundo y el tercer worker lean el caché justo
     mientras el primero lo escribe. Con el código viejo salió «La sefiora
     pidié una cancion en el afio del fiandu» en la mitad de las corridas;
     con páginas más grandes, casi nunca. */
  {
    const { StandardFonts } = await import(pathToFileURL(path.join(RAIZ, 'renderer', 'vendor', 'pdf-lib', 'pdf-lib.mjs')).href);
    const original = await PDFDocument.create();
    const helvetica = await original.embedFont(StandardFonts.Helvetica);
    original.addPage([470, 60]).drawText('La señora pidió una canción en el año del ñandú.', { x: 14, y: 22, size: 18, font: helvetica });
    const t = pdfjs.getDocument({ data: await original.save(), isEvalSupported: false, standardFontDataUrl: fuentes });
    const hoja = await (await t.promise).getPage(1);
    const vp = hoja.getViewport({ scale: 2 });
    const lienzo = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await hoja.render({ canvasContext: lienzo.getContext('2d'), viewport: vp }).promise;
    const png = await lienzo.encode('png');
    await t.destroy();
    const pdf = await PDFDocument.create();
    const img = await pdf.embedPng(png);
    for (let i = 0; i < 6; i++) pdf.addPage([470, 300]).drawImage(img, { x: 0, y: 240, width: 470, height: 60 });
    const seis = path.join(carpeta, 'senora.pdf');
    fs.writeFileSync(seis, await pdf.save());

    const crear = tesseract.createWorker;
    const orden = [];   // 'inicio 1', 'listo 1', 'inicio 2'…, en el orden en que pasan
    tesseract.createWorker = (...a) => {
      const k = orden.filter((e) => e.startsWith('inicio')).length + 1;
      orden.push(`inicio ${k}`);
      return crear(...a).then((w) => { orden.push(`listo ${k}`); return w; });
    };
    let d;
    try {
      d = await motor.pipeline.extractDocument(seis, {
        ocr: true, tessdataPath: TESSDATA, ocrCachePath: path.join(carpeta, 'cache-nuevo'),
        ocrWorkers: 3,          // el tope fijo: que no dependa de los núcleos de la máquina
        removeFooters: false,   // seis renglones iguales: el limpiador los tomaría por un pie de página
      });
    } finally {
      tesseract.createWorker = crear;
    }
    const iniciados = orden.filter((e) => e.startsWith('inicio')).length;
    assert.ok(iniciados >= 2, `con 6 páginas y tope 3 tendría que haber sumado workers (${orden.join(', ')})`);
    const listoPrimero = orden.indexOf('listo 1');
    assert.ok(listoPrimero >= 0 && orden.every((e, i) => !/^inicio [2-9]/.test(e) || i > listoPrimero),
      `con el caché vacío, un worker arrancó antes de que el primero terminara de escribirlo: ${orden.join(', ')}`);
    assert.equal(d.metadata.ocrError, undefined, `el OCR con el caché vacío falló: ${d.metadata.ocrError}`);
    assert.equal(d.metadata.ocrPages, 6, 'las 6 páginas pasan por OCR');
    const paginas = d.sections.map((s) => s.paragraphs.join(' '));
    const sinTildes = paginas.map((p, i) => [i + 1, p]).filter(([, p]) => !/ñ/.test(p) || !/[áéíóú]/.test(p));
    assert.ok(paginas.length === 6 && sinTildes.length === 0,
      `todas las páginas con eñes y tildes (si falta una, ese worker perdió 'spa'): ${JSON.stringify(sinTildes.length ? sinTildes : paginas)}`);
    notas.push(`caché vacío: ${iniciados} workers, ${orden.join(' → ')}`);
  }

  fs.rmSync(carpeta, { recursive: true, force: true });
  llegoAlFinal = true;
  console.log(`ocr: 27 aserciones OK · ${letras} letras reconocidas en ${(ms / 1000).toFixed(1)} s · ${notas.join(' · ')}`);
})().catch((err) => {
  console.error('ocr FALLÓ:', err);
  process.exit(1);
});
