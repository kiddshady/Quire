'use strict';
/**
 * Pipeline de conversión: archivo → converter → cleaners → outputs → disco.
 *
 * El destino lo decide quien llama (`options.destino`), no el motor:
 *   { modo: 'junto' }                 cada salida al lado de su original
 *   { modo: 'descargas' }             Descargas\Quire\YYYY-MM-DD\ (plano por día)
 *   { modo: 'carpeta', ruta: '...' }  todo a una carpeta elegida
 * Las colisiones de nombre se resuelven con " (2)", " (3)", etc.: acá no se
 * pisa nada que ya exista.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { findConverter, getOutput, getConverterByName, extOf } = require('./registry.cjs');
const { cleanDocument } = require('./cleaners.cjs');
const { decodeText } = require('./encoding.cjs');
const ocr = require('./ocr.cjs');
const { CANCELADA, esCorte, revisar } = require('./corte.cjs');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function dateStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const stemOf = (file) => path.basename(file, path.extname(file));

/** Carpeta del día: Descargas\Quire\YYYY-MM-DD (se crea si no existe). */
async function dailyDir(outRoot) {
  const root = outRoot || path.join(os.homedir(), 'Downloads');
  const dir = path.join(root, 'Quire', dateStr());
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Resuelve la carpeta de salida para UN archivo según el destino elegido. */
async function dirDeSalida(filePath, destino = {}) {
  const modo = destino.modo || 'junto';
  if (modo === 'carpeta') {
    if (!destino.ruta) throw new Error('Falta la carpeta de destino.');
    await fsp.mkdir(destino.ruta, { recursive: true });
    return destino.ruta;
  }
  if (modo === 'descargas') return dailyDir(destino.outRoot);
  return path.dirname(filePath);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** "stem.ext" libre en dir: si ya existe, "stem (2).ext", "stem (3).ext"… */
async function uniquePath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}${ext}`);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

/** Convierte UN archivo a un Document limpio (sin guardar nada). */
async function extractDocument(filePath, options = {}, onProgress) {
  const data = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  const converter = options.forceConverter
    ? getConverterByName(options.forceConverter)
    : findConverter(name, data);
  if (!converter) throw new Error(`No hay conversor para "${name}".`);
  const doc = await converter.extract(data, name, { ...options, sourcePath: filePath }, onProgress);
  cleanDocument(doc, options);
  doc.metadata.converter = converter.name;
  return doc;
}

/** El resultado de un archivo al que el corte no lo dejó empezar. */
const sinEmpezar = (filePath) => ({
  file: path.basename(filePath), path: filePath, ok: false, outputs: [], error: CANCELADA, cancelado: true,
});

/**
 * Convierte un lote y guarda cada salida donde diga `options.destino`.
 *
 * Eventos de `onProgress`, en orden:
 *   file-start       { index, total, file }
 *   stage            { index, file, stage: 'extract', done, total, label } | { …, stage: 'render', output }
 *   file-done        { index, total, file, ok, error, cancelado, outputs, outDir, meta }
 *   batch-cancelled  { index, total, file }   solo si se canceló: dónde se cortó
 *   batch-done       { outDirs, cancelado }
 *
 * `file-done` trae las salidas, la carpeta, la ficha y el motivo del error
 * (herr-11): con eso la fila de Convertir se pone al día apenas termina SU
 * archivo, sin esperar al último del lote. El resultado del invoke queda como
 * confirmación.
 *
 * Cancelar (main-20): `signal` es el de un AbortController que maneja quien
 * llama. Se mira antes de cada archivo, entre páginas (pdf.cjs) y antes de
 * escribir: un archivo sale con todas sus salidas o con ninguna. El
 * interrumpido y los que no llegaron a empezar vuelven con `cancelado: true`,
 * así el resultado sigue teniendo una entrada por archivo del lote. Un corte
 * no es un error: no va a `errors` ni a `_errores.txt`.
 *
 * @param {object} p
 * @param {string[]} p.files        rutas absolutas
 * @param {string[]} p.outputs      nombres de outputs ('pdf', 'markdown', ...)
 * @param {object}   p.options      opciones de limpieza/outputs/ocr/destino
 * @param {function} p.onProgress   (evt) => void
 * @param {function} [p.htmlToPdf]  html → Buffer (inyectado por main, para el output pdf)
 * @param {AbortSignal} [p.signal]  para cancelar el lote
 */
async function convertBatch(p) {
  const options = p.options || {};
  const { signal } = p;
  /* Un pool de OCR para todo el lote (main-22). No arranca ningún worker
     hasta que un PDF lo necesite; al cancelar se termina en el acto, para que
     tesseract no siga reconociendo páginas que nadie va a usar. */
  const ocrPool = options.ocr !== false && options.tessdataPath ? ocr.crearPoolOcr(options) : null;
  const alCortar = () => { if (ocrPool) ocrPool.terminar(); };
  if (signal) signal.addEventListener('abort', alCortar, { once: true });
  try {
    return await recorrerLote({ ...p, options, ocrPool });
  } finally {
    if (signal) signal.removeEventListener('abort', alCortar);
    if (ocrPool) await ocrPool.terminar();
  }
}

async function recorrerLote({ files, outputs, options, onProgress = () => {}, htmlToPdf, signal, ocrPool }) {
  const results = [];
  const errors = [];
  const outDirs = new Set();
  let cortado = false;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const name = path.basename(filePath);
    if (signal && signal.aborted) {
      cortado = true;
      onProgress({ type: 'batch-cancelled', index: i, total: files.length, file: name });
      for (const f of files.slice(i)) results.push(sinEmpezar(f));
      break;
    }
    onProgress({ type: 'file-start', index: i, total: files.length, file: name });

    const result = { file: name, path: filePath, ok: false, outputs: [], error: null };
    try {
      const outDir = await dirDeSalida(filePath, options.destino);
      outDirs.add(outDir);

      const doc = await extractDocument(filePath, { ...options, ocrPool, signal }, (prog) =>
        onProgress({ type: 'stage', index: i, file: name, stage: 'extract', ...prog })
      );
      // Última mirada antes de escribir: de acá en más el archivo sale entero.
      revisar(signal);

      const stem = stemOf(name);
      for (const outName of outputs) {
        const output = getOutput(outName);
        if (!output) throw new Error(`Salida desconocida: ${outName}`);
        onProgress({ type: 'stage', index: i, file: name, stage: 'render', output: outName });
        const bytes = await output.render(doc, { ...options, htmlToPdf });
        const outPath = await uniquePath(outDir, stem, output.extension);
        await fsp.writeFile(outPath, bytes);
        result.outputs.push({ name: outName, path: outPath, bytes: bytes.length });
      }
      result.ok = true;
      result.outDir = outDir;
      result.meta = {
        converter: doc.metadata.converter,
        engine: doc.metadata.engine,
        pages: doc.metadata.pages,
        slides: doc.metadata.slides,
        questions: doc.metadata.questions,
        correct: doc.metadata.correct,
        ocrPages: doc.metadata.ocrPages,
        ocrError: doc.metadata.ocrError,
        hyphensRestored: doc.metadata.hyphensRestored,
      };
    } catch (err) {
      if (esCorte(err)) {
        cortado = true;
        result.cancelado = true;
        result.error = CANCELADA;
      } else {
        result.error = err && err.message ? err.message : String(err);
        errors.push(`[${timestamp()}] ${name}: ${result.error}`);
      }
    }
    results.push(result);
    onProgress({
      type: 'file-done', index: i, total: files.length, file: name,
      ok: result.ok, error: result.error, cancelado: Boolean(result.cancelado),
      outputs: result.outputs, outDir: result.outDir, meta: result.meta,
    });
    if (cortado) {
      onProgress({ type: 'batch-cancelled', index: i, total: files.length, file: name });
      for (const f of files.slice(i + 1)) results.push(sinEmpezar(f));
      break;
    }
  }

  /* Los errores quedan por escrito solo cuando todo fue a una misma carpeta
     elegida: con "junto al original" no hay un lugar único donde dejarlos, y
     el renderer ya los muestra uno por uno. */
  if (errors.length && outDirs.size === 1 && (options.destino?.modo || 'junto') !== 'junto') {
    const [dir] = outDirs;
    await fsp.appendFile(path.join(dir, '_errores.txt'), errors.join('\n') + '\n', 'utf8').catch(() => {});
  }

  onProgress({ type: 'batch-done', outDirs: [...outDirs], cancelado: cortado });
  return { outDirs: [...outDirs], results, errors, cancelado: cortado };
}

// ---------------- Unir textos ----------------

const TEXT_EXTS = ['.md', '.markdown', '.txt', '.text', '.log', '.rst'];

/**
 * Une archivos de texto (.md/.txt/...) en UN .md, respetando el orden dado:
 * "## <nombre>" por archivo, separados por "---" (el formato que ya usaba
 * Shapeshifter). Los PDFs no se unen acá: eso es Herramientas → Combinar, que
 * copia las páginas sin re-renderizar y acepta imágenes.
 *
 * Cancelar tiene el mismo contrato que convertBatch: un corte no es un error,
 * así que resuelve con `{ cancelado: true }` y no escribe nada. Antes tiraba
 * el error de corte, y el renderer lo recibía como una falla de IPC («Error
 * invoking remote method 'conv:unir': Error: Conversión cancelada.») mientras
 * que convertir volvía con `cancelado` (lo marcó la revisión de 0B2).
 */
async function mergeFiles({ files, options = {}, onProgress = () => {}, signal }) {
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error('Para unir hacen falta al menos 2 archivos.');
  }
  const exts = files.map((f) => extOf(path.basename(f)));
  if (!exts.every((e) => TEXT_EXTS.includes(e))) {
    throw new Error('Acá se unen textos (.md, .txt). Para unir PDFs, usá Herramientas → Combinar.');
  }

  const parts = [];
  try {
    for (let i = 0; i < files.length; i++) {
      revisar(signal);   // cancelado: no se escribe nada
      onProgress({ type: 'merge', index: i, total: files.length, file: path.basename(files[i]) });
      const content = decodeText(await fsp.readFile(files[i])).trim();
      parts.push(`## ${stemOf(files[i])}\n\n${content}`);
    }
    revisar(signal);
  } catch (err) {
    if (esCorte(err)) return { cancelado: true };
    throw err;
  }
  const bytes = Buffer.from(parts.join('\n\n---\n\n') + '\n', 'utf8');

  const outDir = await dirDeSalida(files[0], options.destino);
  const outPath = await uniquePath(outDir, `unido_${timestamp()}`, '.md');
  await fsp.writeFile(outPath, bytes);
  onProgress({ type: 'merge-done', outDir, path: outPath });
  return { outDir, path: outPath, bytes: bytes.length, files: files.length };
}

/** Preview: un archivo → markdown (sin escribir a disco). */
async function preview(filePath, options = {}) {
  const doc = await extractDocument(filePath, options);
  const markdown = await getOutput('markdown').render(doc, { ...options, frontmatter: false });
  return {
    markdown: markdown.toString('utf8'),
    meta: doc.metadata,
    title: doc.title,
  };
}

module.exports = { convertBatch, extractDocument, mergeFiles, preview, timestamp, dailyDir, TEXT_EXTS };
