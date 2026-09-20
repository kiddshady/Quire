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

/**
 * OCR de un conjunto de páginas. Devuelve Map<pageNum, líneas[]>.
 * Cualquier error se propaga: el caller decide degradar con gracia.
 */
async function ocrPages(doc, pageNums, options, onProgress) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker(options.ocrLangs || 'spa+eng', 1, {
    langPath: options.tessdataPath,
    cachePath: options.ocrCachePath || undefined,
    gzip: true,
  });
  const out = new Map();
  try {
    for (let i = 0; i < pageNums.length; i++) {
      const n = pageNums[i];
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: OCR_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const png = await canvas.encode('png');
      const { data } = await worker.recognize(png);
      const text = (data && data.text ? data.text : '').trim();
      out.set(n, text ? text.split('\n').map((l) => l.trimEnd()) : []);
      if (onProgress) {
        onProgress({ done: i + 1, total: pageNums.length, label: `OCR ${i + 1}/${pageNums.length} (página ${n})` });
      }
    }
  } finally {
    await worker.terminate().catch(() => {});
  }
  return out;
}

module.exports = {
  name: 'pdf',
  extensions: ['.pdf'],
  description: 'PDF → texto por páginas (pdf.js, con OCR para las escaneadas)',

  async extract(data, filename, options = {}, onProgress) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: STANDARD_FONTS_URL,
    });
    const doc = await task.promise;

    const pages = [];
    let title = '';
    let ocrCount = 0;
    let ocrError = null;
    let hyphensRestored = 0;
    const layoutAware = options.layoutAware !== false;

    try {
      const meta = await doc.getMetadata().catch(() => null);
      title = (meta && meta.info && meta.info.Title || '').trim();

      // ¿Este PDF codifica sus guiones como U+00AD? Solo entonces vale la pena
      // pagar el getOperatorList de cada página (es ~2-3× más caro que el texto).
      let rescueHyphens = false;
      if (options.restoreHyphens !== false) {
        for (const n of probePages(doc.numPages, SNIFF_PAGES)) {
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
