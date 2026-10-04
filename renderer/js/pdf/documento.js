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

/* El tope de píxeles de un bitmap, el mismo `maxCanvasPixels` del visor de
   pdf.js: 2^25, unos 33 Mpx (128 MB). Sin tope, una A4 a 600 % con dpr 1,25
   eran 28 Mpx por buffer, el doble mientras dura el render con `preservar`,
   por cada hoja de la precarga (lector-22). Pasado el tope se baja la
   resolución del bitmap y no su tamaño en pantalla: a zoom extremo la hoja
   se ve apenas más suave. */
export const MAX_PIXELES = 2 ** 25;

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
    /* Si se abrió con contraseña, esos bytes están CIFRADOS. pdf.js los
       descifra para leer, pero pdf-lib no sabe (la imposición y el aplanado de
       la tinta los cargan con ignoreEncryption): lo que arme con ellos sale
       en blanco o roto. Antes de ux-11 estos PDF ni abrían, así que nadie lo
       miraba; ahora Imprimir y Exportar tienen que mirarlo y avisar. */
    this.conClave = !!meta.conClave;
    /* Cifrado aunque nadie haya pedido contraseña: los PDF con contraseña de
       PROPIETARIO (restricciones de imprimir o copiar) pdf.js los abre sin
       preguntar, pero sus bytes también están cifrados y pdf-lib los copia en
       blanco. Las vistas miran las dos marcas para avisar de antemano. */
    this.cifrado = !!meta.cifrado || this.conClave;

    this._cachePaginas = new Map();
    this._cacheGeometria = new Map();
    /* Las miniaturas del panel, ya hechas imagen: nº de página → URL de un
       blob. Viven lo que vive el documento (destruir() las suelta), así que
       volver al lector o a la pestaña no las vuelve a pedir. */
    this._miniaturas = new Map();
    this._esquema = null;      // la promesa de esquema(), una sola por documento
    this._destruido = false;
  }

  /**
   * Suelta lo que pdf.js guarda de una página después de dibujarla: las
   * imágenes decodificadas y la lista de operadores. El PDFPageProxy queda
   * cacheado para siempre y sin esto cada hoja visitada se quedaba con lo suyo
   * en memoria, aunque el lector soltara el canvas: el único que prende esa
   * limpieza es cleanup(), y render() la apaga al empezar (lector-06). Es lo
   * mismo que hace el visor de pdf.js al sacar una página de su buffer. Si hay
   * un render en curso, pdf.js la deja pendiente y la hace al terminar.
   */
  soltar(n) {
    this._cachePaginas.get(n)?.then((p) => p.cleanup()).catch(() => {});
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

  /**
   * La geometría de todas las páginas. La necesita el scroll para saber cuánto
   * mide el documento.
   *
   * En lotes de 32 en paralelo y no de a una: cada geometría es una ida y
   * vuelta al worker, y en serie un libro de 1265 páginas eran 1265 esperas en
   * fila antes de mostrar nada. En lotes y no todas juntas para no encolarle
   * al worker mil pedidos de una (lector-24).
   */
  async geometrias() {
    const out = [];
    for (let desde = 1; desde <= this.paginas; desde += 32) {
      const hasta = Math.min(this.paginas, desde + 31);
      const lote = [];
      for (let n = desde; n <= hasta; n++) lote.push(this.geometria(n));
      out.push(...await Promise.all(lote));
    }
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
  render(n, { canvas, escala = 1, rotacionExtra = 0, dpr = window.devicePixelRatio || 1, preservar = false, tope = MAX_PIXELES }) {
    let tarea = null;
    let cancelado = false;

    const promesa = (async () => {
      const page = await this._pagina(n);
      if (cancelado) return null;

      const rotacion = ((page.rotate || 0) + rotacionExtra) % 360;
      let viewport = page.getViewport({ scale: escala * dpr, rotation: rotacion });
      // El tope de píxeles (ver MAX_PIXELES): se baja la resolución, no el tamaño.
      const area = viewport.width * viewport.height;
      if (area > tope) {
        viewport = page.getViewport({ scale: escala * dpr * Math.sqrt(tope / area) * 0.999, rotation: rotacion });
      }
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

      /* El tamaño en pantalla NO lo escribe el render: lo pone la caja de quien
         lo pide (el pliego del lector y el de Imprimir tienen su tamaño, y el
         canvas mide el 100 %). Escrito acá en línea, le ganaba al 100 % del CSS:
         al cambiar el zoom el pliego crecía y el bitmap viejo se quedaba del
         tamaño viejo hasta que terminaba el render nuevo —recortado al alejar,
         con blanco al costado al acercar—. Ahora se estira con su caja desde el
         primer cuadro, que es lo que promete el doble buffer de abajo. */

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
   * Devuelve el canvas SIN medidas CSS (render() no las escribe): el tamaño
   * en pantalla lo decide quien lo recibe. Con medidas puestas, una miniatura
   * se plantaba en el ancho que salió del render y dejaba aire muerto en su
   * contenedor.
   */
  async lienzo(n, { escala = 1, rotacionExtra = 0, dpr = 1 } = {}) {
    const canvas = document.createElement('canvas');
    /* Sin tope: exportar a imágenes pide los píxeles que pide, y un A3 a
       600 ppp se pasa del de pantalla. Ahí bajar la resolución sería mentir
       en el archivo que sale. */
    await this.render(n, { canvas, escala, rotacionExtra, dpr, tope: Infinity }).promesa;
    return canvas;
  }

  /** La miniatura de una página, si ya está hecha: la URL, o null. */
  miniaturaLista(n) {
    return this._miniaturas.get(n) || null;
  }

  /**
   * La miniatura de una página como imagen, para el panel del lector.
   *
   * Se dibuja una vez por documento —sin el giro del lector: lo pone el CSS—,
   * se pasa a un blob y queda como URL. Antes cada miniatura era un canvas de
   * unos 390 KB que no se soltaba nunca, y no había caché: leer un tratado con
   * el panel abierto juntaba cientos de MB y cada vuelta al lector las volvía
   * a renderizar todas (lector-11). Una imagen fuera de pantalla, además,
   * Chromium la puede descartar decodificada y volver a decodificar.
   *
   * Mismo contrato que render(): `promesa` (con la URL, o null si se canceló)
   * y `cancelar()`. Quien la pide la cancela si deja de importarle: al
   * cambiar de pestaña con miniaturas en vuelo, el bucle seguía pintando
   * páginas del documento anterior (lector-29).
   */
  miniatura(n, { ancho = 132, dpr = 2 } = {}) {
    let tarea = null;
    let cancelado = false;
    const promesa = (async () => {
      if (this._miniaturas.has(n)) return this._miniaturas.get(n);
      const g = await this.geometria(n);
      if (cancelado || this._destruido) return null;
      const canvas = document.createElement('canvas');
      tarea = this.render(n, { canvas, escala: ancho / g.anchoPt, dpr });
      const r = await tarea.promesa;
      if (!r || cancelado || this._destruido) { canvas.width = 0; canvas.height = 0; return null; }
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/webp', 0.9));
      canvas.width = 0;
      canvas.height = 0;
      this.soltar(n);
      if (!blob || this._destruido) return null;
      // Otra pedida de la misma página pudo llegar primero: gana la que ya está.
      if (this._miniaturas.has(n)) return this._miniaturas.get(n);
      const url = URL.createObjectURL(blob);
      this._miniaturas.set(n, url);
      return url;
    })();
    return {
      promesa,
      cancelar() {
        cancelado = true;
        tarea?.cancelar();
      },
    };
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
   * ¿Este PDF escribe sus guiones como guiones blandos (U+00AD)?
   *
   * pdf.js los tira en getTextContent() y no hay opción que lo evite, pero el
   * operator list sí trae los glifos. Se miran unas páginas repartidas por el
   * documento —no hace falta el libro entero para saberlo— y el buscador usa
   * la respuesta para plegar sin guiones (ver el encabezado de buscador.js).
   * La vuelta es más cara que leer el texto, por eso se cachea y se sondea
   * una sola vez por documento.
   */
  async usaGuionesBlandos({ paginas = 6 } = {}) {
    if (this._guionesBlandos !== undefined) return this._guionesBlandos;
    const total = this.paginas;
    const n = Math.min(paginas, total);
    const muestra = [...new Set(Array.from({ length: n }, (_, i) => 1 + Math.floor((i * total) / n)))];

    let hay = false;
    for (const num of muestra) {
      const page = await this._pagina(num);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length && !hay; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.showText) continue;
        const glifos = ops.argsArray[i]?.[0];
        if (!Array.isArray(glifos)) continue;
        if (glifos.some((g) => g && typeof g === 'object' && g.unicode === '­')) hay = true;
      }
      if (hay) break;
    }
    this._guionesBlandos = hay;
    return hay;
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
         `--total-scale-factor` sale de estas dos (ver .qr-texto en lector.css);
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

  /**
   * Marcadores del documento, aplanados con su nivel.
   *
   * La promesa queda guardada: el lector los pide recién al abrir la pestaña
   * Marcadores (lector-24), y mientras llegan se puede ir y volver a esa
   * pestaña varias veces. Sin esto, cada vuelta salía a resolverlos todos de
   * nuevo al worker.
   */
  esquema() {
    this._esquema ??= this._leerEsquema();
    return this._esquema;
  }

  async _leerEsquema() {
    const crudo = await this._pdf.getOutline().catch(() => null);
    if (!crudo?.length) return [];

    /* Primero se aplana el árbol, en orden, y después se resuelven los
       destinos en tandas. Antes iban de a uno —una o dos idas y vueltas al
       worker por marcador, en fila— y en un tratado con cientos de
       marcadores eso se pagaba entero antes de mostrar el documento
       (lector-24). El orden de salida es el del árbol igual. */
    const planos = [];
    const aplanar = (nodos, nivel) => {
      for (const nodo of nodos) {
        planos.push({ nodo, nivel });
        if (nodo.items?.length) aplanar(nodo.items, nivel + 1);
      }
    };
    aplanar(crudo, 0);

    const paginaDe = async (nodo) => {
      try {
        const destino = typeof nodo.dest === 'string'
          ? await this._pdf.getDestination(nodo.dest)
          : nodo.dest;
        if (destino?.[0]) return (await this._pdf.getPageIndex(destino[0])) + 1;
      } catch { /* un destino roto no invalida el resto del esquema */ }
      return null;
    };
    /* En lotes de 32, como geometrias(): todos juntos, un tratado con miles
       de marcadores le encolaba al worker miles de pedidos de una. Cada lote
       sale en orden, así que el resultado sigue el orden del árbol. */
    const paginas = [];
    for (let desde = 0; desde < planos.length; desde += 32) {
      const lote = planos.slice(desde, desde + 32);
      paginas.push(...await Promise.all(lote.map(({ nodo }) => paginaDe(nodo))));
      if (this._destruido) return [];
    }
    return planos.map(({ nodo, nivel }, i) => ({ titulo: nodo.title, nivel, pagina: paginas[i] }));
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
      cifrado: !!(info?.EncryptFilterName || info?.IsEncrypted),
    };
  }

  destruir() {
    if (this._destruido) return;
    this._destruido = true;
    for (const url of this._miniaturas.values()) URL.revokeObjectURL(url);
    this._miniaturas.clear();
    this._cachePaginas.clear();
    this._cacheGeometria.clear();
    this._pdf.destroy().catch(() => {});
  }
}

/* Quién pide la contraseña de un PDF protegido. Este archivo no sabe de
   carteles: el lector se anota con un Modal (ver pedirClave en lector.js).
   La función recibe { incorrecta, nombre } y devuelve la contraseña, o null
   si el usuario se arrepiente. */
let pedirClave = null;

/** Anota quién pide la contraseña de los PDF protegidos. */
export function alPedirClave(fn) {
  pedirClave = fn;
}

/* Lo que pdf.js tira al abrir, dicho en castellano. Antes llegaba tal cual al
   toast: «No password given», «Invalid PDF structure.» (ux-11). */
function traducirError(err, { cancelada }) {
  const nombre = err?.name || '';
  let mensaje = null;
  if (cancelada || nombre === 'PasswordException') mensaje = 'El PDF tiene contraseña y no se escribió la que lo abre.';
  else if (nombre === 'InvalidPDFException') mensaje = 'El archivo está dañado o no es un PDF.';
  else if (nombre === 'MissingPDFException') mensaje = 'No se encontró el archivo.';
  if (!mensaje) return err;
  const traducido = new Error(mensaje);
  traducido.cause = err;
  return traducido;
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
    /* Los decodificadores de imágenes que pdf.js 5 trae en WebAssembly: JBIG2
       (el blanco y negro de casi todo paper escaneado), JPEG 2000 y el manejo
       de color (qcms). Sin esta ruta no los encuentra y esas imágenes no se
       dibujan: la hoja queda en blanco aunque Chrome la muestre bien (pasó con
       un paper escaneado de Química Medicinal). Al lado van sus versiones en
       JS, por si el WebAssembly no se puede compilar. */
    wasmUrl: VENDOR + 'wasm/',
    // Sin esto, un PDF con JavaScript embebido puede pedirle cosas al visor.
    isEvalSupported: false,
  });

  /* Con contraseña de apertura, pdf.js pregunta acá (y vuelve a preguntar si
     la que se le dio no sirve: motivo 2). Sin nadie que pregunte, o si el
     usuario cancela, se le devuelve un error y la apertura falla con el
     mensaje de traducirError(). Los PDF que solo tienen contraseña de
     propietario (restricciones de imprimir o copiar) no pasan por acá. */
  let cancelada = false;
  let conClave = false;
  tarea.onPassword = (responder, motivo) => {
    conClave = true;
    const no = () => { cancelada = true; responder(new Error('Se canceló la contraseña')); };
    if (!pedirClave) { no(); return; }
    Promise.resolve(pedirClave({ incorrecta: motivo === 2, nombre: meta.nombre || '' }))
      .then((clave) => (clave == null ? no() : responder(String(clave))), no);
  };

  let pdf;
  try {
    pdf = await tarea.promise;
  } catch (err) {
    tarea.destroy().catch(() => {});
    throw traducirError(err, { cancelada });
  }
  // pdf.js informa el filtro de cifrado en los metadatos (EncryptFilterName).
  const info = (await pdf.getMetadata().catch(() => null))?.info;
  const cifrado = !!(info?.EncryptFilterName || info?.IsEncrypted);
  return new Documento(pdf, { ...meta, bytes: origen, conClave, cifrado });
}

export { Documento };
