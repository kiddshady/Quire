/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — aplanar la tinta sobre el PDF
   Escribe los trazos como paths VECTORIALES dentro del PDF. No se rasteriza
   nada: la tinta sale con la resolución de la impresora, igual que el texto, y
   el documento sigue siendo un PDF normal — no hay que convertirlo a imagen ni
   partirlo en pedazos para poder imprimirlo anotado.

   Se hace sobre una copia en memoria. El archivo del disco no se toca nunca.

   Y se hace ANTES de imponer: así la tinta viaja con su página y termina
   escalada, rotada y ubicada igual que el contenido, sin que el motor de
   imposición tenga que saber que existe.

   ── El vuelco de la Y ──────────────────────────────────────────────────────
   Los trazos están en coordenadas de página PDF (Y hacia arriba), pero
   drawSvgPath interpreta el path como SVG (Y hacia abajo) desde el ancla que
   se le pasa. Con el ancla en el borde superior y el path volcado, las dos
   convenciones se encuentran. Lo COMPARTIDO entre pantalla y papel es el
   contorno —la geometría— no el string: en canvas el vuelco lo hace la matriz
   del viewport, acá lo hace esta función.
   ═══════════════════════════════════════════════════════════════════════════ */

import { PDFDocument, rgb } from '../../vendor/pdf-lib/pdf-lib.mjs';
import { contornoDeTrazo, pathDeContorno } from './contorno.js';

function aRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '#000'));
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/**
 * Devuelve una copia del PDF con la tinta incrustada.
 * Si no hay trazos, devuelve los bytes originales sin tocar: reescribir un PDF
 * para no agregarle nada solo lo engorda y le cambia los metadatos.
 *
 * @param {Uint8Array} bytes
 * @param {import('./capa.js').CapaDeTinta} capa
 * @param {{soloPaginas?: number[]}} opciones
 */
export async function aplanarTinta(bytes, capa, { soloPaginas = null } = {}) {
  if (!capa || capa.vacia) return bytes;

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = doc.getPageCount();
  let escritos = 0;

  for (const numero of capa.paginasConTinta()) {
    if (soloPaginas && !soloPaginas.includes(numero)) continue;
    if (numero < 1 || numero > total) continue;

    const pagina = doc.getPage(numero - 1);
    const alto = pagina.getSize().height;

    /* Los resaltadores primero, para que la tinta opaca de la pluma quede por
       encima. Mismo orden que en pantalla — si no, lo impreso no coincide. */
    const trazos = capa.trazos(numero);
    const orden = [
      ...trazos.filter((t) => t.herramienta === 'resaltador'),
      ...trazos.filter((t) => t.herramienta !== 'resaltador'),
    ];

    for (const t of orden) {
      const vertices = contornoDeTrazo(t.puntos, {
        ancho: t.ancho,
        sensible: t.herramienta !== 'resaltador',
      });
      if (!vertices.length) continue;

      // Y volcada: el ancla queda en el borde superior y el path baja desde ahí.
      const d = pathDeContorno(vertices.map(([x, y]) => [x, alto - y]));

      pagina.drawSvgPath(d, {
        x: 0,
        y: alto,
        color: aRgb(t.color),
        opacity: t.opacidad ?? 1,
        borderWidth: 0,
      });
      escritos++;
    }
  }

  if (!escritos) return bytes;
  return doc.save({ useObjectStreams: true });
}

/** Cuántos trazos se van a escribir. Para avisarlo antes de imprimir. */
export function contarTinta(capa, soloPaginas = null) {
  if (!capa) return 0;
  let n = 0;
  for (const p of capa.paginasConTinta()) {
    if (soloPaginas && !soloPaginas.includes(p)) continue;
    n += capa.trazos(p).length;
  }
  return n;
}
