'use strict';
/**
 * Decodificación de archivos de texto de origen desconocido.
 *
 * El truco viejo era decodificar como UTF-8 y, si aparecía el replacement char
 * (U+FFFD), rehacerlo como latin-1. El problema: alcanza UN byte corrupto —o un
 * U+FFFD que ya venía en el archivo— para degradar un documento UTF-8 entero a
 * latin-1 y llenarlo de "Ã©". TextDecoder en modo fatal responde la pregunta
 * real ("¿es UTF-8 válido?") en vez de adivinarla por un síntoma.
 */

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** @param {Buffer} buf @returns {string} texto, con el BOM y los CRLF ya sacados */
function decodeText(buf) {
  let text;
  try {
    text = utf8Strict.decode(buf);
  } catch {
    text = buf.toString('latin1');   // no era UTF-8: el fallback histórico de Moodle
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

module.exports = { decodeText };
