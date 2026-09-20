'use strict';
/**
 * Limpieza heurística de texto extraído (port de cleaners/text.py de Shapeshifter).
 * Opera sobre los párrafos del Document, in place sobre una copia superficial.
 */

const LINE_END_OK = /[.!?:;)\]"'»…]$/;
const STARTS_LOWER = /^[a-záéíóúüñ0-9(]/;

/** "pa-\nlabra" → "palabra" */
function dehyphenate(text) {
  return text.replace(/([a-záéíóúüñA-ZÁÉÍÓÚÜÑ])-\s*\n\s*([a-záéíóúüñ])/g, '$1$2');
}

/** Une líneas que evidentemente continúan la oración anterior. */
function joinLines(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const cur = line.trimEnd();
    if (out.length) {
      const prev = out[out.length - 1];
      if (prev && cur && !LINE_END_OK.test(prev.trimEnd()) && STARTS_LOWER.test(cur.trimStart())) {
        out[out.length - 1] = prev.trimEnd() + ' ' + cur.trimStart();
        continue;
      }
    }
    out.push(cur);
  }
  return out.join('\n');
}

/** Colapsa espacios horizontales múltiples y >2 saltos seguidos. */
function normalizeSpaces(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

/** Quita indentación al inicio de cada línea. */
function dedent(text) {
  return text.split('\n').map((l) => l.trimStart()).join('\n');
}

/**
 * Detecta y elimina líneas repetidas entre páginas (headers/footers de PDF).
 * Una línea que aparece (normalizando dígitos) en ≥3 páginas y en ≥30% del
 * total se considera mobiliario de página, no contenido.
 *
 * El tope de largo existe para no confundir un párrafo con un footer, pero
 * tiene que dar lugar a los avisos de copyright completos: el del Goodman &
 * Gilman ("©2023 McGraw Hill. All Rights Reserved. Terms of Use • Privacy
 * Policy • Notice • Accessibility") mide 96 chars y con el tope viejo de 70 se
 * colaba en las 2983 páginas. Ninguna línea de contenido real se repite en un
 * tercio del libro, así que el filtro de frecuencia ya alcanza.
 * @param {string[][]} pages  líneas por página
 */
const MAX_FURNITURE_LEN = 200;

function removeRepeatedLines(pages) {
  const norm = (l) => l.trim().replace(/\d+/g, '#');
  const counts = new Map();
  for (const page of pages) {
    const seen = new Set();
    for (const line of page) {
      const n = norm(line);
      if (!n || n.length > MAX_FURNITURE_LEN || seen.has(n)) continue;
      seen.add(n);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const minPages = Math.max(3, Math.ceil(pages.length * 0.3));
  const furniture = new Set([...counts].filter(([, c]) => c >= minPages).map(([n]) => n));
  if (!furniture.size) return pages;
  return pages.map((page) => page.filter((l) => !furniture.has(norm(l))));
}

/**
 * Aplica las opciones de limpieza a cada párrafo del Document.
 * @param {object} doc
 * @param {{dehyphenate?:boolean, joinLines?:boolean, normalizeSpaces?:boolean, dedent?:boolean}} opts
 */
function cleanDocument(doc, opts = {}) {
  const fns = [];
  if (opts.dehyphenate !== false) fns.push(dehyphenate);
  if (opts.dedent) fns.push(dedent);
  if (opts.joinLines !== false) fns.push(joinLines);
  if (opts.normalizeSpaces !== false) fns.push(normalizeSpaces);
  if (!fns.length) return doc;

  const cleanPara = (p) => fns.reduce((acc, fn) => fn(acc), p).trim();
  const walk = (section) => {
    section.paragraphs = section.paragraphs.map(cleanPara).filter(Boolean);
    section.subsections.forEach(walk);
  };
  doc.sections.forEach(walk);
  return doc;
}

module.exports = { dehyphenate, joinLines, normalizeSpaces, dedent, removeRepeatedLines, cleanDocument };
