'use strict';
/**
 * Registro de converters (input → Document) y outputs (Document → bytes).
 * Los converters se prueban en orden: el primero cuya extensión matchee y cuyo
 * detect() (si existe) devuelva true, gana. Eso permite que Moodle tenga
 * prioridad sobre el HTML genérico para .htm/.html.
 */

const converters = [];
const outputs = [];

function registerConverter(conv) { converters.push(conv); }
function registerOutput(out) { outputs.push(out); }

function extOf(filename) {
  const m = /\.[^.\\/]+$/.exec(filename.toLowerCase());
  return m ? m[0] : '';
}

/**
 * @param {string} filename
 * @param {Buffer|null} data  Si está disponible, se usa para detect() (ej. Moodle).
 */
function findConverter(filename, data = null) {
  const ext = extOf(filename);
  const candidates = converters.filter((c) => c.extensions.includes(ext));
  for (const c of candidates) {
    if (!c.detect) return c;
    try {
      if (data && c.detect(data, filename)) return c;
    } catch { /* detect roto ≠ converter elegido */ }
  }
  // Segunda pasada: los que tienen detect pero no matchearon quedan descartados;
  // devolvemos el primero sin detect (el genérico).
  return candidates.find((c) => !c.detect) || null;
}

function getOutput(name) {
  return outputs.find((o) => o.name === name) || null;
}

function getConverterByName(name) {
  return converters.find((c) => c.name === name) || null;
}

function listConverters() {
  return converters.map(({ name, extensions, description }) => ({ name, extensions, description }));
}

function listOutputs() {
  return outputs.map(({ name, extension, description }) => ({ name, extension, description }));
}

module.exports = { registerConverter, registerOutput, findConverter, getOutput, getConverterByName, listConverters, listOutputs, extOf };
