/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — exportar páginas como imágenes
   Esto NO usa pdf-lib: rasterizar es trabajo de pdf.js. Se renderiza cada
   página a un canvas a la resolución pedida y se saca el bitmap en el formato
   elegido.

   El DPI es el parámetro que importa y el que casi ningún visor deja tocar.
   Un PDF mide en puntos (1/72"), así que la escala de render es dpi/72: a 300
   dpi una A4 sale de 2480 × 3508 px, que es lo que hace falta para que una
   imagen impresa no se vea blanda.

   La tinta va incluida: se dibuja encima del mismo canvas antes de sacar el
   bitmap. Exportar una página anotada tiene que traer la anotación.
   ═══════════════════════════════════════════════════════════════════════════ */

import { dibujarTrazos } from './tinta/capa.js';

export const FORMATOS = {
  png: { mime: 'image/png', ext: 'png', etiqueta: 'PNG', calidad: false, alfa: true },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', etiqueta: 'JPEG', calidad: true, alfa: false },
  webp: { mime: 'image/webp', ext: 'webp', etiqueta: 'WEBP', calidad: true, alfa: true },
};

export const DPIS = [72, 96, 150, 200, 300, 600];

/* Un canvas de más de ~16 mil píxeles de lado no lo aloja el navegador y el
   render devuelve un lienzo en blanco sin avisar. Se avisa antes. */
const LADO_MAXIMO = 16000;

/**
 * Cuánto va a medir una página al DPI pedido. Para mostrarlo antes de exportar.
 *
 * Trunca —no redondea— porque es lo que hace el render: el canvas se dimensiona
 * con `Math.floor` del viewport. Con `Math.round` la app prometía 1240 px y
 * entregaba 1239. Un píxel no le arruina el día a nadie, pero un número que no
 * es el que sale es exactamente lo que esta app existe para no hacer.
 */
export function medidaAlDPI(geometria, dpi) {
  const escala = dpi / 72;
  return {
    ancho: Math.max(1, Math.floor(geometria.anchoPt * escala)),
    alto: Math.max(1, Math.floor(geometria.altoPt * escala)),
    excedeLimite: Math.max(geometria.anchoPt, geometria.altoPt) * escala > LADO_MAXIMO,
  };
}

/**
 * Exporta páginas como imágenes.
 *
 * @param {import('./pdf/documento.js').Documento} doc
 * @param {object} opciones
 *   paginas   números de página (base 1)
 *   formato   'png' | 'jpeg' | 'webp'
 *   dpi       resolución
 *   calidad   0..1, solo para jpeg y webp
 *   capa      capa de tinta, o null
 *   rotacion  giro extra, el mismo que se ve en el lector
 *   onProgreso(hecho, total)
 * @returns {Promise<Array<{nombre:string, bytes:ArrayBuffer, ancho:number, alto:number}>>}
 */
export async function exportarImagenes(doc, {
  paginas,
  formato = 'png',
  dpi = 150,
  calidad = 0.92,
  capa = null,
  rotacion = 0,
  nombreBase = null,
  onProgreso = null,
} = {}) {
  const fmt = FORMATOS[formato];
  if (!fmt) throw new Error(`Formato desconocido: ${formato}`);
  if (!paginas?.length) throw new Error('No hay páginas para exportar');

  const escala = dpi / 72;
  const base = (nombreBase ?? doc.nombre).replace(/\.pdf$/i, '');
  const ancho = String(Math.max(...paginas)).length;
  const salida = [];

  for (const [i, n] of paginas.entries()) {
    const geo = await doc.geometria(n);
    const medida = medidaAlDPI(geo, dpi);
    if (medida.excedeLimite) {
      throw new Error(
        `La página ${n} a ${dpi} dpi daría ${medida.ancho} × ${medida.alto} px, y el máximo es ${LADO_MAXIMO}. Bajá el DPI.`
      );
    }

    /* dpr 1 a propósito: acá el tamaño lo fija el DPI pedido, no la densidad
       de la pantalla. Con dpr del sistema, exportar daría distinto según el
       monitor en el que estuviera abierta la app. */
    const canvas = await doc.lienzo(n, { escala, rotacionExtra: rotacion, dpr: 1 });

    if (capa?.trazos(n).length) {
      const viewport = await doc.viewport(n, { escala, rotacionExtra: rotacion });
      dibujarTrazos(canvas.getContext('2d'), capa.trazos(n), viewport, { dpr: 1 });
    }

    const blob = await new Promise((res, rej) => {
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error(`No se pudo codificar la página ${n} como ${fmt.etiqueta}`))),
        fmt.mime,
        fmt.calidad ? calidad : undefined
      );
    });

    salida.push({
      nombre: `${base}-${String(n).padStart(ancho, '0')}.${fmt.ext}`,
      bytes: await blob.arrayBuffer(),
      ancho: canvas.width,
      alto: canvas.height,
      pagina: n,
    });

    // Liberar el bitmap: a 600 dpi cada canvas son ~200 MB y quedarse con
    // todos en memoria voltea la app antes de la décima página.
    canvas.width = 0;
    canvas.height = 0;

    onProgreso?.(i + 1, paginas.length);
  }

  return salida;
}
