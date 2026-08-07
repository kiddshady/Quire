'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — qué es el archivo
   Por su FIRMA, nunca por la extensión: un .pdf puede ser cualquier cosa, y un
   .png renombrado también. Acá se decide qué entra a la app.

   La lista es corta a propósito: son los formatos que se pueden volver página
   de un PDF. PNG y JPEG entran sin re-encodear; el WEBP hay que decodificarlo,
   y de eso se ocupa el renderer, que es el único que tiene canvas.

   Sin Electron, para poder testearlo — igual que argv.cjs.
   ═══════════════════════════════════════════════════════════════════════════ */

const EXT_IMAGEN = ['png', 'jpg', 'jpeg', 'webp'];

const FIRMAS = [
  { formato: 'pdf', firma: [0x25, 0x50, 0x44, 0x46] },                              // %PDF
  { formato: 'png', firma: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { formato: 'jpeg', firma: [0xff, 0xd8, 0xff] },
  // "RIFF" y, después de los 4 bytes del tamaño, "WEBP": la firma va partida.
  { formato: 'webp', firma: [0x52, 0x49, 0x46, 0x46], enOcho: [0x57, 0x45, 0x42, 0x50] },
];

/** 'pdf' | 'png' | 'jpeg' | 'webp' | null */
function formatoDe(bytes) {
  if (!bytes) return null;
  for (const f of FIRMAS) {
    if (bytes.length < f.firma.length) continue;
    if (!f.firma.every((b, i) => bytes[i] === b)) continue;
    // Un RIFF cortado antes del "WEBP" no es un WEBP, es un RIFF cualquiera.
    if (f.enOcho && (bytes.length < 12 || !f.enOcho.every((b, i) => bytes[8 + i] === b))) continue;
    return f.formato;
  }
  return null;
}

module.exports = { EXT_IMAGEN, FIRMAS, formatoDe };
