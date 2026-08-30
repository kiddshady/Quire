/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el documento
   Todo lo que sabe de pdf.js está acá adentro. El resto de la app habla de
   páginas, milímetros y lienzos; nunca de PDFPageProxy ni de viewports.

   Dos cosas que se pagan caro si se olvidan:

   · El worker corre en OTRO realm. El parche de compatibilidad (compat.mjs)
     hay que aplicarlo en los dos lados — acá y en worker-shim.mjs — porque un
     Object.defineProperty de este archivo no se ve desde el worker.

   · Los renders se CANCELAN. Al hacer scroll rápido se piden decenas de
     páginas por segundo; sin cancelar, pdf.js encola todos los trabajos y la
     app se arrastra durante varios segundos después de soltar la rueda.
   ═══════════════════════════════════════════════════════════════════════════ */

import '../../vendor/pdfjs/compat.mjs';
import * as pdfjs from '../../vendor/pdfjs/pdf.mjs';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'worker-shim.mjs';

/**
 * UN worker para todos los documentos abiertos.
 *
 * Librado a su suerte, pdf.js levanta un worker por documento: con cuatro
 * pestañas serían cuatro hilos, cada uno con su copia del código de pdf.js
 * cargada. Pasándole el nuestro, las cuatro comparten uno solo.
 *
 * Y no se lo lleva puesto cerrar una pestaña, aunque `destroy()` termine en
 * `this._worker?.destroy()`. La clave está en getDocument: `_worker` se
 * completa SOLO en la rama que lo crea él —`if (!worker) { worker =
 * PDFWorker.create(...); task._worker = worker }`—. Si el worker viene de
 * afuera esa rama no corre, `_worker` queda en null, y el destroy no encuentra
 * nada que destruir. O sea: quien trae el worker es el dueño de su vida. Este
 * vive lo que vive la app y no lo cierra nadie.
 */
let workerCompartido = null;
const worker = () => (workerCompartido ??= new pdfjs.PDFWorker({ name: 'quire' }));

/* PDF mide en puntos (1/72"). El papel se piensa en milímetros. */
export const PT_A_MM = 25.4 / 72;
export const MM_A_PT = 72 / 25.4;
export const ptAmm = (pt) => pt * PT_A_MM;
export const mmApt = (mm) => mm * MM_A_PT;

/** Los tamaños que Quire reconoce por nombre, en milímetros. */
export const TAMANOS = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  A6: [105, 148],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Executive: [184.2, 266.7],
  B5: [182, 257],
};

/**
 * Le pone nombre a un tamaño de página con 1,5 mm de tolerancia: los PDFs
 * reales rara vez traen 595,276×841,89 exactos, y un A4 que dice "210×297"
 * se lee mejor que uno que dice "209,9×296,9".
 */
export function nombrarTamano(anchoMM, altoMM, tolerancia = 1.5) {
  for (const [nombre, [a, b]] of Object.entries(TAMANOS)) {
    const derecho = Math.abs(anchoMM - a) <= tolerancia && Math.abs(altoMM - b) <= tolerancia;
    const girado = Math.abs(anchoMM - b) <= tolerancia && Math.abs(altoMM - a) <= tolerancia;
    if (derecho) return { nombre, apaisado: false };
    if (girado) return { nombre, apaisado: true };
  }
  return null;
}

/** "A4 · 210 × 297 mm" o "184,1 × 266,7 mm" si no es un tamaño conocido. */
export function describirTamano(anchoMM, altoMM) {
  const n = (v) => (Math.round(v * 10) / 10).toString().replace('.', ',');
  const medida = `${n(anchoMM)} × ${n(altoMM)} mm`;
  const conocido = nombrarTamano(anchoMM, altoMM);
  if (!conocido) return medida;
  return `${conocido.nombre}${conocido.apaisado ? ' apaisado' : ''} · ${medida}`;
}

/**
 * Deja un texto sacado del PDF listo para el portapapeles.
 *
 * Un PDF guarda "ﬁ" como un solo glifo y "ﬀ" como otro: pegados tal cual, el
 * buscador del editor de destino no los encuentra nunca. Los nulos aparecen en
 * archivos generados por herramientas que rellenan de más, y cortan el pegado
 * en seco a la mitad.
 */
export const normalizarTexto = (s) => pdfjs.normalizeUnicode(String(s)).replace(/\0/g, '');

class Documento {
  constructor(pdf, meta) {
    this._pdf = pdf;
    this.paginas = pdf.numPages;
    this.nombre = meta.nombre || 'documento.pdf';
    this.ruta = meta.ruta || null;
    this.tamano = meta.tamano ?? null;
    /* Los bytes originales quedan guardados: el motor de imposición y el de
       exportación trabajan sobre ELLOS con pdf-lib, no sobre lo que pdf.js
       tiene parseado. Reabrir el archivo del disco sería pedirle al usuario
       que no lo haya movido mientras tanto. */
    this.bytes = meta.bytes || null;

    this._cachePaginas = new Map();
    this._cacheGeometria = new Map();
    this._destruido = false;
  }

  async _pagina(n) {
    if (this._destruido) throw new Error('El documento ya se cerró');
    if (n < 1 || n > this.paginas) throw new Error(`No existe la página ${n}`);
    if (!this._cachePaginas.has(n)) this._cachePaginas.set(n, this._pdf.getPage(n));
    return this._cachePaginas.get(n);
  }

  /**
   * Geometría de una página YA rotada, en puntos y en milímetros.
   * `getViewport({scale:1})` aplica /Rotate, así que un A4 vertical con
   * /Rotate 90 devuelve 842×595 — que es como se ve y como se imprime.
   */
  async geometria(n) {
    if (this._cacheGeometria.has(n)) return this._cacheGeometria.get(n);
    const page = await this._pagina(n);
    const vp = page.getViewport({ scale: 1 });
    const g = {
      numero: n,
      anchoPt: vp.width,
      altoPt: vp.height,
      anchoMM: ptAmm(vp.width),
      altoMM: ptAmm(vp.height),
      rotacion: page.rotate || 0,
      apaisado: vp.width > vp.height,
    };
    g.etiqueta = describirTamano(g.anchoMM, g.altoMM);
    this._cacheGeometria.set(n, g);
    return g;
  }

  /** La geometría de todas las páginas. La necesita el scroll para saber cuánto mide el documento. */
  async geometrias() {
    const out = [];
    for (let n = 1; n <= this.paginas; n++) out.push(await this.geometria(n));
    return out;
  }

  /**
   * Dibuja una página en un canvas.
   *
   * Devuelve un objeto con `promesa` y `cancelar()`: quien pide el render es
   * responsable de cancelarlo si la página se fue de pantalla antes de que
   * termine. Un render cancelado rechaza con RenderingCancelledException, que
   * NO es un error que haya que mostrar.
   */
  render(n, { canvas, escala = 1, rotacionExtra = 0, dpr = window.devicePixelRatio || 1, preservar = false }) {
    let tarea = null;
    let cancelado = false;

    const promesa = (async () => {
      const page = await this._pagina(n);
      if (cancelado) return null;

      const rotacion = ((page.rotate || 0) + rotacionExtra) % 360;
      const viewport = page.getViewport({ scale: escala * dpr, rotation: rotacion });
      const ancho = Math.max(1, Math.floor(viewport.width));
      const alto = Math.max(1, Math.floor(viewport.height));

      /* Con `preservar`, se dibuja en un lienzo aparte y recién al final se
         vuelca al visible. Asignar `width` a un canvas lo BORRA, así que
         renderizar directo sobre el que se está viendo lo deja en blanco todo
         lo que tarde la página — al cambiar el zoom o plegar el panel, eso es
         un parpadeo. Con el doble buffer el visible nunca queda vacío: muestra
         el bitmap anterior, estirado por CSS, hasta que el nuevo está listo. */
      const destino = preservar ? document.createElement('canvas') : canvas;
      destino.width = ancho;
      destino.height = alto;

      // El tamaño en CSS va sin dpr: el dpr solo sube la resolución del bitmap.
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      const ctx = destino.getContext('2d', { alpha: false });
      tarea = page.render({ canvasContext: ctx, viewport, canvas: destino, background: '#ffffff' });
      await tarea.promise;

      if (preservar) {
        if (cancelado) { destino.width = 0; destino.height = 0; return null; }
        // El borrado y el volcado ocurren en el mismo frame: no se ve el hueco.
        canvas.width = ancho;
        canvas.height = alto;
        canvas.getContext('2d', { alpha: false }).drawImage(destino, 0, 0);
        destino.width = 0;
        destino.height = 0;
      }
      return { ancho, alto };
    })();

    return {
      promesa,
      cancelar() {
        cancelado = true;
        try { tarea?.cancel(); } catch { /* ya había terminado */ }
      },
    };
  }

  /**
   * Render a un canvas nuevo, para miniaturas y exportación.
   *
   * Devuelve el canvas SIN medidas CSS: render() las escribe inline para que
   * una página encaje en su hueco del visor, pero acá el tamaño en pantalla lo
   * decide quien lo recibe. Dejarlas puestas hace que una miniatura se plante
   * en el ancho que salió del render y deje aire muerto en su contenedor.
   */
  async lienzo(n, { escala = 1, rotacionExtra = 0, dpr = 1 } = {}) {
    const canvas = document.createElement('canvas');
    await this.render(n, { canvas, escala, rotacionExtra, dpr }).promesa;
    canvas.style.width = '';
    canvas.style.height = '';
    return canvas;
  }

  /**
   * El viewport de una página: la matriz que lleva de coordenadas de página PDF
   * a píxeles en pantalla. La capa de tinta la necesita para que un trazo hecho
   * al 150% caiga en el mismo lugar del papel que uno hecho al 60%, y para
   * convertir el puntero a coordenadas de página con convertToPdfPoint().
   */
  async viewport(n, { escala = 1, rotacionExtra = 0 } = {}) {
    const page = await this._pagina(n);
    return page.getViewport({ scale: escala, rotation: ((page.rotate || 0) + rotacionExtra) % 360 });
  }

  /** El texto de una página, con la posición de cada fragmento (para buscar y seleccionar). */
  async texto(n) {
    const page = await this._pagina(n);
    const contenido = await page.getTextContent();
    return {
      plano: contenido.items.map((i) => i.str).join(''),
      items: contenido.items,
    };
  }

  /**
   * Los fragmentos de texto de una página, para el índice del buscador.
   *
   * Tres decisiones que tienen que quedar clavadas a lo que hace capaTexto(),
   * porque el buscador ubica una coincidencia por (fragmento, offset) y después
   * la pinta sobre los spans que armó la capa. Si las dos listas no son la
   * misma, el resaltado cae en otra palabra:
   *
   * · `disableNormalization: true` — el mismo crudo que pide la capa. Con la
   *   normalización activada pdf.js abre las ligaduras ("ﬁ" → "fi"), y un
   *   fragmento de largo distinto corre todos los offsets de ahí en adelante.
   *   Que "oficina" encuentre "oﬁcina" lo resuelve plegar(), en el buscador,
   *   que sabe volver del texto plegado al original.
   *
   * · Los ítems SIN `str` se filtran: son las marcas de contenido etiquetado,
   *   que la capa consume para estructurar pero no convierte en spans.
   *
   * · `hasEOL` viaja como `salto`. Sin él, el último renglón se pega con el
   *   primero de la línea siguiente y "de las" no se encuentra nunca — o peor,
   *   aparece un "estadoen" que en la hoja no existe.
   */
  async fragmentos(n) {
    const page = await this._pagina(n);
    const { items } = await page.getTextContent({ disableNormalization: true });
    return items
      .filter((it) => typeof it.str === 'string')
      .map((it) => ({ str: it.str, salto: !!it.hasEOL }));
  }

  /**
   * Arma la capa de texto de una página: un span transparente por fragmento,
   * puesto exactamente encima de las letras que pintó el canvas. Eso es lo que
   * hace que el texto del PDF se pueda arrastrar con el mouse y copiar — la
   * selección es la del navegador, cayendo sobre spans que no se ven.
   *
   * El contrato es el mismo que el de `render()`: `promesa` y `cancelar()`.
   * Quien la pide es responsable de cancelarla si la página se fue de pantalla.
   *
   * La escala va SIN dpr, al revés que en `render()` y en `viewport()`: acá lo
   * que se posiciona es DOM, que ya se mide en píxeles CSS. Multiplicar por el
   * dpr dejaría los spans al doble de tamaño, corridos de las letras.
   */
  capaTexto(n, { contenedor, escala = 1, rotacionExtra = 0 }) {
    let capa = null;
    let cancelado = false;

    const promesa = (async () => {
      const page = await this._pagina(n);
      if (cancelado) return null;

      const rotacion = ((page.rotate || 0) + rotacionExtra) % 360;
      const viewport = page.getViewport({ scale: escala, rotation: rotacion });

      /* pdf.js escribe el ancho de la capa como
         `round(down, var(--total-scale-factor) * <pt>px, var(--scale-round-x))`.
         `--total-scale-factor` sale de estas dos (ver .qr-texto en quire.css);
         sin ellas la expresión no resuelve y la capa se queda sin tamaño. */
      contenedor.style.setProperty('--scale-factor', escala);
      contenedor.style.setProperty('--user-unit', viewport.userUnit || 1);
      contenedor.replaceChildren();

      capa = new pdfjs.TextLayer({
        /* `disableNormalization` deja el texto CRUDO, con sus ligaduras y sus
           formas raras. Normalizarlo acá rompería la correspondencia con lo que
           se ve; se normaliza al copiar, que es cuando importa — ver
           normalizarTexto() y seleccion.js. */
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        }),
        container: contenedor,
        viewport,
      });

      await capa.render();
      if (cancelado) return null;
      /* Los spans salen para afuera porque el buscador los necesita: resalta
         armando un Range sobre el nodo de texto de cada uno y midiendo dónde
         cae. Van en el mismo orden que fragmentos(), uno por ítem —los <br> de
         los saltos de renglón se agregan al DOM pero NO entran en esta lista—,
         y esa correspondencia es la que hace que una coincidencia sepa sobre
         qué letras pintarse. */
      return { fragmentos: capa.textDivs.length, divs: capa.textDivs };
    })();

    return {
      promesa,
      cancelar() {
        cancelado = true;
        try { capa?.cancel(); } catch { /* ya había terminado */ }
      },
    };
  }

  /** Marcadores del documento, aplanados con su nivel. */
  async esquema() {
    const crudo = await this._pdf.getOutline().catch(() => null);
    if (!crudo?.length) return [];

    const salida = [];
    const recorrer = async (nodos, nivel) => {
      for (const nodo of nodos) {
        let pagina = null;
        try {
          const destino = typeof nodo.dest === 'string'
            ? await this._pdf.getDestination(nodo.dest)
            : nodo.dest;
          if (destino?.[0]) pagina = (await this._pdf.getPageIndex(destino[0])) + 1;
        } catch { /* un destino roto no invalida el resto del esquema */ }
        salida.push({ titulo: nodo.title, nivel, pagina });
        if (nodo.items?.length) await recorrer(nodo.items, nivel + 1);
      }
    };
    await recorrer(crudo, 0);
    return salida;
  }

  /** Título, autor, fechas. Lo que el PDF diga de sí mismo. */
  async metadatos() {
    const { info } = await this._pdf.getMetadata().catch(() => ({ info: {} }));
    return {
      titulo: info?.Title || null,
      autor: info?.Author || null,
      creador: info?.Creator || null,
      productor: info?.Producer || null,
      version: info?.PDFFormatVersion || null,
      cifrado: !!info?.IsEncrypted,
    };
  }

  destruir() {
    if (this._destruido) return;
    this._destruido = true;
    this._cachePaginas.clear();
    this._cacheGeometria.clear();
    this._pdf.destroy().catch(() => {});
  }
}

/**
 * Abre un PDF desde sus bytes.
 *
 * Los bytes se COPIAN antes de dárselos a pdf.js: pdf.js se queda con el
 * ArrayBuffer y lo deja "detached", así que sin la copia el mismo buffer no se
 * podría volver a usar después para imponer o exportar.
 */
export async function abrirDocumento(bytes, meta = {}) {
  const origen = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer ?? bytes);
  const paraPdfJs = origen.slice();

  const tarea = pdfjs.getDocument({
    data: paraPdfJs,
    worker: worker(),
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    // Sin esto, un PDF con JavaScript embebido puede pedirle cosas al visor.
    isEvalSupported: false,
  });

  const pdf = await tarea.promise;
  return new Documento(pdf, { ...meta, bytes: origen });
}

export { Documento };
