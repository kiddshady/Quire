'use strict';
/**
 * Converter PDF → texto estructurado, con pdfjs-dist (pure JS, sin deps nativas).
 *
 * Pensado para aguantar libros largos: procesa página por página, libera cada
 * página con cleanup() y reporta progreso — el motivo #1 por el que la versión
 * pywebview se caía con PDFs grandes era cargar todo de una.
 *
 * OCR (opcional, default on): las páginas con menos de OCR_THRESHOLD chars de
 * texto (escaneadas) se renderizan con @napi-rs/canvas y pasan por
 * tesseract.js (spa+eng bundleado en assets/tessdata → offline). Si el OCR
 * falla por lo que sea, la conversión sigue sin él — nunca rompe el batch.
 */

const path = require('path');
const { makeDocument, makeSection } = require('../document.cjs');
const { removeRepeatedLines } = require('../cleaners.cjs');
const { crearPoolOcr } = require('../ocr.cjs');
const { revisar, conCorte, esCorte } = require('../corte.cjs');

// Fuentes estándar del propio pdfjs-dist: sin esto, los PDFs que no embeben
// Helvetica/Times pierden el mapeo de glifos (y pdf.js grita en consola).
// En Node, el build legacy de pdf.js 5 las lee con fs.readFile, así que va
// una RUTA —no una URL file://, que fs no entiende—. Pero pdf.js exige que
// termine en "/" literal (no en el separador de Windows), y fs acepta las dos
// barras, así que la barra que va es la de pdf.js.
const STANDARD_FONTS_URL =
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

const OCR_THRESHOLD = 30;  // chars mínimos para considerar que una página "tiene texto"
const OCR_SCALE = 2.5;     // ~180 dpi: buen balance velocidad/precisión
const SHY = '­';      // soft hyphen
const SNIFF_PAGES = 6;     // páginas de sondeo para decidir si hay que rescatar guiones

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist es ESM; import dinámico desde CJS. Cacheado para no re-importar.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/* Para test/motor.test.cjs: le pasa un pdf.js envuelto que anota las tareas
   que abre, y así puede mirar que una tarea que falló quedó destruida
   (main-18). El namespace del módulo ESM está congelado y no se puede espiar
   de otra forma. Con null vuelve al de verdad. */
function usarPdfjsParaTests(ns) {
  pdfjsPromise = ns ? Promise.resolve(ns) : null;
}

/* Ceder el hilo en cada vuelta de los bucles largos (main-03, paso 1). El
   motor corre en el proceso principal, y ahí pdf.js no tiene worker: cae al
   «fake worker», que hace todo el trabajo en el mismo hilo. El setImmediate
   es un seguro barato, no una mejora medible: el bucle de páginas ya cedía
   solo (en 0 de 300 páginas faltó una vuelta del event loop), así que lo que
   llega por IPC ya se atendía entre página y página. Queda para que eso no
   dependa de cómo resuelva sus promesas la próxima versión de pdf.js.

   Lo que NO arregla, medido en el main de Electron con un libro de 2000
   páginas (antes y después dan lo mismo, 285-316 ms de hueco máximo, lejos
   de los 50 ms que pide el plan): el hueco más largo está en el primer
   pedido a pdf.js, que indexa el documento entero y crece con el tamaño;
   después viene el armado del texto al final (~110 ms) y, con OCR, el
   render de cada página escaneada (~1,9 s por página a 300 dpi), que es
   sincrónico. Eso se va con el utilityProcess (paso 2 de main-03), que
   todavía no está: main-03 sigue abierto. */
const ceder = () => new Promise((r) => setImmediate(r));

/* pdf.js rechaza con su mensaje en inglés («No password given», «Invalid PDF
   structure.») y Convertir lo mostraba tal cual (main-18). Se reconocen por
   el nombre de la excepción, que es estable; el texto no. */
function traducirError(err) {
  const nombre = err && err.name;
  if (nombre === 'PasswordException') return new Error('Tiene contraseña: Quire no puede leerlo.');
  if (nombre === 'InvalidPDFException') return new Error('El PDF está dañado.');
  return err;
}

/**
 * Líneas de una página. pdf.js emite los items en orden de dibujo, no de
 * lectura: un watermark puede caer en medio de una frase y `cur += item.str`
 * lo pega sin espacio ("la" + "UNIVERSIDAD DE..." → "laUNIVERSIDAD"). Con
 * layoutAware miramos la geometría de cada item y cortamos donde el PDF corta.
 */
function pageLines(textContent, layoutAware = true) {
  const lines = [];
  let cur = '';
  let prev = null;                     // { xEnd, y, h } del item anterior
  const flush = (force) => {
    if (force || cur.trim()) lines.push(cur.trimEnd());
    cur = '';
  };

  for (const item of textContent.items) {
    if (layoutAware && item.str) {
      const t = item.transform;
      const x = t[4];
      const y = t[5];
      const h = Math.abs(t[3]) || item.height || 10;
      if (prev) {
        if (Math.abs(y - prev.y) > h * 0.5) {
          flush(false);                // otro renglón: el orden de dibujo saltó
        } else {
          const gap = x - prev.xEnd;
          if (gap < -h * 0.5) flush(false);                       // volvió a la izquierda
          else if (gap > h * 0.2 && cur && !/\s$/.test(cur) && !/^\s/.test(item.str)) {
            cur += ' ';                // hueco horizontal: era una separación, no un pegote
          }
        }
      }
      prev = { xEnd: x + (item.width || 0), y, h };
    }
    if (item.str) cur += item.str;
    if (item.hasEOL) { flush(true); prev = null; }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/** Agrupa líneas en párrafos separados por líneas vacías. */
function linesToParagraphs(lines) {
  const paras = [];
  let buf = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (buf.length) { paras.push(buf.join('\n')); buf = []; }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) paras.push(buf.join('\n'));
  return paras;
}

// ---------------- Rescate de guiones ----------------
//
// Algunos generadores (McGraw Hill / AccessMedicine, entre otros) no emiten
// NINGÚN guión ASCII: codifican todos sus guiones como soft hyphen (U+00AD).
// pdf.js clasifica U+00AD como "invisible format mark" (\p{Cf}) y lo descarta
// en getTextContent() sin opción para conservarlo, así que "HMG-CoA" sale
// "HMGCoA" y "5-HT" sale "5HT" — el texto se lee, pero las búsquedas mueren.
// El operator list sí trae esos glifos, así que lo recorremos para armar un
// diccionario "forma pegada → forma con guión" y lo aplicamos al final, cuando
// ya vimos el documento entero.

/** Bloques de texto dibujados en una página, con los U+00AD incluidos. */
function operatorBlocks(ops, OPS) {
  const parts = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.showText) continue;
    const glyphs = ops.argsArray[i][0];
    if (!Array.isArray(glyphs)) continue;
    let s = '';
    for (const g of glyphs) {
      if (!g || typeof g === 'number') continue;
      if (typeof g.unicode === 'string') s += g.unicode;
    }
    parts.push(s);
  }
  return parts;
}

const LEAD_RE = /^[^\p{L}\p{N}]+/u;
const TRAIL_RE = /[^\p{L}\p{N}]+$/u;

/**
 * Cosecha "HMG­CoA:" → map["HMGCoA"] = "HMG-CoA". Los ambiguos se descartan.
 *
 * Se pasa dos veces sobre los mismos bloques, unidos de las dos maneras. Un
 * showText nuevo empieza en cada cambio de fuente, así que "α­amino…" o
 * "N­metiltransferasa" llegan partidos justo en el guión: uniendo con espacio
 * esos términos no se cosechan nunca, y son media nomenclatura de farmacología
 * (prefijos griegos y estereoquímicos). Uniendo sin espacio se recuperan. La
 * variante con espacio va primera porque es la que no puede fusionar palabras
 * vecinas, y una clave espuria de la segunda solo se aplicaría si el texto de
 * salida trae exactamente esa misma fusión.
 */
function harvestBlocks(blocks, map, conflicts) {
  harvestHyphens(blocks.join(' '), map, conflicts);
  harvestHyphens(blocks.join(''), map, conflicts);
}

function harvestHyphens(text, map, conflicts) {
  for (const tok of text.split(/\s+/)) {
    if (!tok.includes(SHY)) continue;
    const core = tok.replace(LEAD_RE, '').replace(TRAIL_RE, '');
    if (!core.includes(SHY)) continue;
    const flat = core.split(SHY).join('');
    if (flat.length < 3) continue;
    if (conflicts.has(flat)) continue;
    const hyphenated = core.split(SHY).join('-');
    const prev = map.get(flat);
    if (prev === undefined) map.set(flat, hyphenated);
    else if (prev !== hyphenated) { map.delete(flat); conflicts.add(flat); }
  }
}

/** Devuelve el texto con los guiones repuestos, y cuántos repuso. */
function applyHyphens(text, map) {
  let count = 0;
  const out = text.replace(/\S+/g, (tok) => {
    const lead = LEAD_RE.exec(tok);
    const trail = TRAIL_RE.exec(tok);
    const a = lead ? lead[0].length : 0;
    const b = trail ? trail[0].length : 0;
    const core = tok.slice(a, tok.length - b);
    const hit = core && map.get(core);
    if (!hit) return tok;
    count++;
    return tok.slice(0, a) + hit + tok.slice(tok.length - b);
  });
  return { text: out, count };
}

/** Páginas repartidas por todo el documento, para sondear sin leerlo entero. */
function probePages(total, k) {
  const n = Math.min(k, total);
  const out = [];
  for (let i = 0; i < n; i++) out.push(1 + Math.floor((i * total) / n));
  return [...new Set(out)];
}

/** Una página rasterizada para el OCR, en PNG. */
async function rasterizar(doc, n, createCanvas) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: OCR_SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  page.cleanup();
  return canvas.encode('png');
}

/**
 * OCR de un conjunto de páginas. Devuelve Map<pageNum, líneas[]>.
 * Cualquier error se propaga: el caller decide degradar con gracia.
 *
 * Mientras tesseract reconoce una página, acá ya se rasteriza la siguiente
 * (main-22): el render corre en este hilo y el reconocimiento en los workers,
 * así que se solapan. Se adelantan como mucho tantas páginas como workers
 * más una, para no apilar PNGs de varios MB en memoria. La ganancia hoy es
 * chica: medido en Electron con 4 páginas escaneadas a 300 dpi, 10,4 s → 9,7 s,
 * porque lo que manda es el render (~1,9 s por página, en este hilo) y no
 * tesseract. Lo que más se ahorra es en lotes: un worker por lote y no uno
 * por PDF.
 */
async function ocrPages(doc, pageNums, options, onProgress) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { signal } = options;
  const propio = !options.ocrPool;
  const pool = options.ocrPool || crearPoolOcr(options);
  const out = new Map();
  const enVuelo = new Set();
  let hechas = 0;
  let fallo = null;
  const esperar = async (p) => {
    await conCorte(p, signal);
    if (fallo) throw fallo;
  };
  try {
    for (const n of pageNums) {
      await ceder();
      revisar(signal);
      while (enVuelo.size > pool.tope) await esperar(Promise.race(enVuelo));
      if (fallo) throw fallo;
      const png = await rasterizar(doc, n, createCanvas);
      revisar(signal);
      const tarea = pool.reconocer(png)
        .then((texto) => {
          const t = texto.trim();
          out.set(n, t ? t.split('\n').map((l) => l.trimEnd()) : []);
          hechas++;
          if (onProgress && !fallo && !(signal && signal.aborted)) {
            onProgress({ done: hechas, total: pageNums.length, label: `OCR ${hechas}/${pageNums.length} (página ${n})` });
          }
        })
        // Cada trabajo se atrapa acá (si no, los que fallan después del
        // primero quedan como rechazos sin atender) y el primero se propaga.
        .catch((err) => { if (!fallo) fallo = err; })
        .finally(() => enVuelo.delete(tarea));
      enVuelo.add(tarea);
    }
    await esperar(Promise.all(enVuelo));
  } finally {
    /* Si se sale por una falla (un reconocimiento que falló, un render que
       tiró), los trabajos que ya estaban en vuelo siguen corriendo en el pool
       del lote. Sin esta espera, su .then seguía avisando «OCR 3/6» con el
       index de este archivo después de su file-done —y hasta después de
       batch-done—, y ocupaban los workers cuando el PDF siguiente arrancaba
       su OCR. Lo armó la revisión de 0B2 con un pool falso donde falla el
       segundo reconocimiento. Con un corte no se espera: el pipeline termina
       el pool en el acto, y eso los suelta a todos. */
    if (!(signal && signal.aborted)) await Promise.allSettled(enVuelo);
    if (propio) await pool.terminar();
  }
  return out;
}

module.exports = {
  name: 'pdf',
  extensions: ['.pdf'],
  description: 'PDF → texto por páginas (pdf.js, con OCR para las escaneadas)',
  usarPdfjsParaTests,

  async extract(data, filename, options = {}, onProgress) {
    const { signal } = options;
    revisar(signal);
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: STANDARD_FONTS_URL,
    });

    const pages = [];
    let title = '';
    let ocrCount = 0;
    let ocrError = null;
    let hyphensRestored = 0;
    const layoutAware = options.layoutAware !== false;

    // El await de la tarea va ADENTRO del try (main-18): si rechaza —con
    // contraseña, dañado— el finally igual destruye la tarea de pdf.js. Antes
    // estaba afuera y el destroy no se llamaba nunca en ese caso.
    try {
      const doc = await task.promise.catch((err) => { throw traducirError(err); });
      const meta = await doc.getMetadata().catch(() => null);
      title = (meta && meta.info && meta.info.Title || '').trim();

      // ¿Este PDF codifica sus guiones como U+00AD? Solo entonces vale la pena
      // pagar el getOperatorList de cada página (es ~2-3× más caro que el texto).
      let rescueHyphens = false;
      if (options.restoreHyphens !== false) {
        for (const n of probePages(doc.numPages, SNIFF_PAGES)) {
          await ceder();
          revisar(signal);
          const page = await doc.getPage(n);
          try {
            if (operatorBlocks(await page.getOperatorList(), pdfjs.OPS).join('').includes(SHY)) {
              rescueHyphens = true;
              break;
            }
          } catch { /* si el sondeo falla, seguimos sin rescate */ }
          finally { page.cleanup(); }
        }
      }

      const hyphenMap = new Map();
      const conflicts = new Set();

      for (let p = 1; p <= doc.numPages; p++) {
        await ceder();
        revisar(signal);
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        pages.push(pageLines(content, layoutAware));
        if (rescueHyphens) {
          try {
            harvestBlocks(operatorBlocks(await page.getOperatorList(), pdfjs.OPS), hyphenMap, conflicts);
          } catch { /* una página sin operator list no invalida el resto */ }
        }
        page.cleanup();
        if (onProgress) {
          const suffix = rescueHyphens ? ' +guiones' : '';
          onProgress({ done: p, total: doc.numPages, label: `página ${p}/${doc.numPages}${suffix}` });
        }
      }

      // Páginas escaneadas (casi sin texto) → OCR, si está habilitado y hay tessdata.
      if (options.ocr !== false && options.tessdataPath) {
        const sparse = [];
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].join('').trim().length < OCR_THRESHOLD) sparse.push(i + 1);
        }
        if (sparse.length) {
          try {
            const ocred = await ocrPages(doc, sparse, options, onProgress);
            for (const [n, lines] of ocred) {
              if (lines.length) pages[n - 1] = lines;
            }
            ocrCount = sparse.length;
          } catch (err) {
            // Un corte pedido no es un OCR caído: corta la conversión entera.
            if (esCorte(err)) throw err;
            // OCR caído ≠ conversión caída: seguimos con lo extraído.
            ocrError = err && err.message ? err.message : String(err);
          }
        }
      }

      // El diccionario recién está completo acá: se aplica al documento entero.
      if (hyphenMap.size) {
        for (let i = 0; i < pages.length; i++) {
          pages[i] = pages[i].map((line) => {
            const { text, count } = applyHyphens(line, hyphenMap);
            hyphensRestored += count;
            return text;
          });
        }
      }
    } finally {
      // pdfjs v6: destroy() vive en el loading task, no en el document proxy.
      // El cleanup jamás debe abortar una conversión que ya terminó bien.
      try { await task.destroy(); } catch { /* best effort */ }
    }

    const cleanedPages = options.removeFooters !== false ? removeRepeatedLines(pages) : pages;
    if (!title) title = path.basename(filename, path.extname(filename));

    const sections = cleanedPages.map((lines, i) =>
      makeSection({ title: `Página ${i + 1}`, level: 2, paragraphs: linesToParagraphs(lines) })
    ).filter((s) => s.paragraphs.length);

    const totalChars = sections.reduce(
      (acc, s) => acc + s.paragraphs.reduce((a, p) => a + p.length, 0), 0);

    return makeDocument({
      title,
      sections,
      metadata: {
        source: filename,
        engine: 'pdfjs-dist' + (ocrCount ? ' + tesseract' : ''),
        pages: sections.length,
        chars: totalChars,
        ocrPages: ocrCount || undefined,
        ocrError: ocrError || undefined,
        hyphensRestored: hyphensRestored || undefined,
      },
    });
  },
};
