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

/* Lo que windows-1252 pone en 0x80-0x9F, que es justo donde latin-1 tiene
   caracteres de control C1 (main-19). Ahí viven las comillas tipográficas,
   los guiones largos y los puntos suspensivos: un .txt viejo de Windows con
   «“Farmaco”» salía con cuadraditos. El resto de los bytes coincide con
   latin-1. Va como tabla propia y no como `new TextDecoder('windows-1252')`
   porque en Node 22 ese decoder devuelve exactamente lo mismo que latin-1
   (U+0093 para 0x93, lo probó la verificación del hallazgo), y en el Node de
   Electron no hay por qué fiarse de otra cosa. Los cinco huecos que
   windows-1252 no define (0x81, 0x8D, 0x8F, 0x90, 0x9D) quedan como en
   latin-1, igual que en el estándar WHATWG. */
const CP1252 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

function windows1252(buf) {
  return buf.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]);
}

/* UTF-16 con BOM: lo que el Bloc de notas viejo guardaba como «Unicode». No
   pasa el UTF-8 estricto (FF FE no es UTF-8 válido) y caía a latin-1, con un
   NUL entre letra y letra: «ÿþH o l a». Se decodifica con Buffer y no con
   TextDecoder('utf-16be'), que depende de que el ICU de turno lo traiga. Sin
   BOM no se adivina: sería apostar. */
function utf16(buf) {
  if (buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const par = buf.subarray(2, 2 + ((buf.length - 2) & ~1));
    return Buffer.from(par).swap16().toString('utf16le');
  }
  return null;
}

/** @param {Buffer} buf @returns {string} texto, con el BOM y los CRLF ya sacados */
function decodeText(buf) {
  let text = utf16(buf);
  if (text === null) {
    try {
      text = utf8Strict.decode(buf);
    } catch {
      text = windows1252(buf);   // no era UTF-8: el fallback histórico de Moodle, con las comillas de Windows
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

module.exports = { decodeText };
