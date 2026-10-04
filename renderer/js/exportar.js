/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — exportar páginas como imágenes
   Esto NO usa pdf-lib: rasterizar es trabajo de pdf.js. Se renderiza cada
   página a un canvas a la resolución pedida y se saca el bitmap en el formato
   elegido.

   El DPI es el parámetro que importa y el que casi ningún visor deja tocar.
   Un PDF mide en puntos (1/72"), así que la escala de render es dpi/72: a 300
   dpi una A4 sale de 2480 × 3508 px, que es lo que hace falta para que una
   imagen impresa no se vea blanda.

   La tinta va incluida: se dibuja en un lienzo aparte, transparente, y se
   compone encima de la página antes de sacar el bitmap. Exportar una página
   anotada tiene que traer la anotación.
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
 * Las páginas de la lista que a ese DPI no entran en un canvas. `geometrias`
 * es la lista del documento (la de S.geometrias, base 0) o una función
 * n → geometría.
 *
 * Mirar solo la primera no alcanza: en un lote A4 con un plano A1 en el
 * medio, el A1 a 600 dpi da casi 20 000 px de lado (imprimir-28).
 */
export function paginasQueNoEntran(geometrias, paginas, dpi) {
  const geo = typeof geometrias === 'function' ? geometrias : (n) => geometrias[n - 1];
  return paginas.filter((n) => {
    const g = geo(n);
    return g && medidaAlDPI(g, dpi).excedeLimite;
  });
}

/** «La página 4», «Las páginas 3 y 7», «Las páginas 3, 7 y 9 (y 2 más)». */
export function nombrarPaginas(lista) {
  if (lista.length === 1) return `La página ${lista[0]}`;
  const vistas = lista.slice(0, 3);
  const resto = lista.length - vistas.length;
  const frase = resto
    ? `${vistas.join(', ')} (y ${resto} más)`
    : `${vistas.slice(0, -1).join(', ')} y ${vistas.at(-1)}`;
  return `Las páginas ${frase}`;
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
 *   rotaciones giros extra por página, como los cambios pendientes de Páginas
 *   onImagen(img)  si está, cada imagen se le entrega apenas se codifica (y
 *                  se espera a que termine) y NO se guarda: la lista que
 *                  vuelve trae las medidas sin los bytes. Es para escribir de
 *                  a una (herr-17): juntarlas todas antes de escribir la
 *                  primera eran cientos de MB en el renderer a 600 dpi, y un
 *                  error en la página 150 tiraba lo ya hecho.
 *   onProgreso(hecho, total)  después de cada imagen; con onImagen, cuando
 *                  ya se entregó, así la barra cuenta las escritas.
 * @returns {Promise<Array<{nombre:string, bytes?:ArrayBuffer, ancho:number, alto:number}>>}
 */
export async function exportarImagenes(doc, {
  paginas,
  formato = 'png',
  dpi = 150,
  calidad = 0.92,
  capa = null,
  rotacion = 0,
  rotaciones = null,
  nombreBase = null,
  onImagen = null,
  onProgreso = null,
} = {}) {
  const fmt = FORMATOS[formato];
  if (!fmt) throw new Error(`Formato desconocido: ${formato}`);
  if (!paginas?.length) throw new Error('No hay páginas para exportar');

  const escala = dpi / 72;
  const base = (nombreBase ?? doc.nombre).replace(/\.pdf$/i, '');
  const ancho = String(Math.max(...paginas)).length;
  const salida = [];

  /* Todas las medidas ANTES de empezar (imprimir-28). Adentro del bucle, la
     página 40 de 50 que no entraba se descubría después de rasterizar las 39
     anteriores, y se perdía todo. Es barato: la geometría no rasteriza. */
  const geos = new Map();
  for (const n of paginas) geos.set(n, await doc.geometria(n));
  const grandes = paginasQueNoEntran((n) => geos.get(n), paginas, dpi);
  if (grandes.length) {
    const m = medidaAlDPI(geos.get(grandes[0]), dpi);
    const cuales = nombrarPaginas(grandes);
    throw new Error(grandes.length === 1
      ? `${cuales} a ${dpi} dpi daría ${m.ancho} × ${m.alto} px, y el máximo es ${LADO_MAXIMO}. Bajá el DPI.`
      : `${cuales} no entran a ${dpi} dpi: pasan de ${LADO_MAXIMO} px de lado. Bajá el DPI.`);
  }

  for (const [i, n] of paginas.entries()) {
    /* dpr 1 a propósito: acá el tamaño lo fija el DPI pedido, no la densidad
       de la pantalla. Con dpr del sistema, exportar daría distinto según el
       monitor en el que estuviera abierta la app. */
    /* `rotacion` cubre el giro global del lector; `rotaciones` permite sumar
       el giro particular que todavía está pendiente en la vista Páginas. */
    const rotacionPagina = rotacion + (rotaciones?.[n] || 0);
    const canvas = await doc.lienzo(n, { escala, rotacionExtra: rotacionPagina, dpr: 1 });

    /* La tinta va en su propio lienzo, transparente, y se compone encima
       (imprimir-01, tinta-01). dibujarTrazos arranca con un clearRect de todo
       el lienzo —en el editor es lo correcto: su canvas es solo de tinta—, y
       el de la página nació con `alpha: false`, donde borrar deja NEGRO
       opaco: la página exportada salía negra con los trazos encima. */
    if (capa?.trazos(n).length) {
      const viewport = await doc.viewport(n, { escala, rotacionExtra: rotacionPagina });
      const tinta = document.createElement('canvas');
      tinta.width = canvas.width;
      tinta.height = canvas.height;
      dibujarTrazos(tinta.getContext('2d'), capa.trazos(n), viewport, { dpr: 1 });
      canvas.getContext('2d').drawImage(tinta, 0, 0);
      tinta.width = 0;
      tinta.height = 0;
    }

    const blob = await new Promise((res, rej) => {
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error(`No se pudo codificar la página ${n} como ${fmt.etiqueta}`))),
        fmt.mime,
        fmt.calidad ? calidad : undefined
      );
    });

    const img = {
      nombre: `${base}-${String(n).padStart(ancho, '0')}.${fmt.ext}`,
      bytes: await blob.arrayBuffer(),
      ancho: canvas.width,
      alto: canvas.height,
      pagina: n,
    };

    // Liberar el bitmap: a 600 dpi cada canvas son ~200 MB y quedarse con
    // todos en memoria voltea la app antes de la décima página.
    canvas.width = 0;
    canvas.height = 0;

    if (onImagen) {
      await onImagen(img);
      salida.push({ ...img, bytes: undefined });   // los bytes ya se fueron
    } else {
      salida.push(img);
    }

    onProgreso?.(i + 1, paginas.length);
  }

  return salida;
}
