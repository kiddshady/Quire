/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el lector
   Scroll continuo con virtualización. Solo se pintan las páginas que están en
   pantalla (más un margen), y las que se van se liberan.

   Por qué virtualizado y no "pinto todo": un PDF de 400 páginas a zoom 100%
   son 400 canvas de ~1200×1700 px. Eso es más de 3 GB de bitmaps. Con
   virtualización, la memoria no depende del largo del documento.

   El observador mira los CONTENEDORES, que ya tienen su tamaño final desde el
   principio (calculado con la geometría, sin haber pintado nada). Por eso el
   scroll mide bien el documento entero desde el primer frame y la barra no
   salta mientras se cargan las páginas.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, emitir, alCambiar } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Menu, Modal } from '../overlays.js';
import Router from '../router.js';
import { paint, head, esc, attempt } from '../ui.js';
import { exit, swap, frase, valor, reconcile, deslizarAncho, asentarPlegables } from '../motion.js';
import { fmtDec, relTime } from '../format.js';
import { HERRAMIENTAS, COLORES } from '../tinta/capa.js';
import { cablearTinta } from '../tinta/editor.js';
import { montarPuck } from '../puck.js';
import { registrar as registrarSeleccion, olvidar as olvidarSeleccion, olvidarTodo as olvidarSelecciones } from '../pdf/seleccion.js';
import { buscadorDe, ubicar } from '../pdf/buscador.js';
import { alPedirClave } from '../pdf/documento.js';
import { presentar } from '../presentar.js';

/* Los tokens de motion.css que se usan desde acá (t-2, t-3 y la curva de
   entrada): el giro espera a que la hoja termine de apagarse y el pliegue del
   panel acompaña al cajón con su misma duración y curva. */
const T2 = 180;
const T3 = 280;
const EASE = 'cubic-bezier(.16, 1, .3, 1)';

/* Cuánto se pinta fuera de la ventana, en pantallas. Con 0.6 el scroll rápido
   alcanza a mostrar el hueco; con 2 se pinta de más y en documentos pesados se
   nota al arrastrar la barra. */
const MARGEN_PRECARGA = 1.1;

const ZOOMS = [0.25, 0.35, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6];

/* Lo que sobrevive entre repintados de la vista. */
const V = {
  visor: null,
  observador: null,
  renders: new Map(),      // nº de página → tarea de render en curso
  textos: new Map(),       // nº de página → tarea de capa de texto en curso
  pintadas: new Set(),
  escalaHecha: 0,          // la escala a la que están medidas las hojas ahora
  desuscribir: null,
  panel: 'miniaturas',     // 'miniaturas' | 'esquema'
  panelAbierto: true,

  /* Tinta. El modo y la herramienta sobreviven a navegar a Imprimir y volver:
     que se apague sola sería como que se te caiga el lápiz al mirar otra cosa. */
  tintaActiva: false,
  herramienta: 'pluma',
  // El del resaltador sale de la hoja (--qr-resaltador-rgb, css-23): ver capa.js.
  colores: { pluma: HERRAMIENTAS.pluma.color, fibra: HERRAMIENTAS.fibra.color, resaltador: HERRAMIENTAS.resaltador.color },
  anchos: { pluma: 1.8, fibra: 4.5, resaltador: 14, borrador: 16 },
  editores: new Map(),     // nº de página → editor de tinta cableado

  /* El puck. Solo existe mientras la vista está pintada: se monta en
     cablearNavegacion() y se va con el DOM. Ver "Navegar con el puck". */
  puck: null,
  navegando: false,        // la barra espaciadora está apretada, anotando
  gesto: null,             // el arrastre en curso sobre el disco, si hay
  puntero: null,           // dónde está el puntero sobre el visor, en px del visor

  /* Búsqueda. El ÍNDICE no está acá: vive colgado del documento (buscadorDe),
     así que volver a una pestaña no vuelve a leer el libro entero. Lo que hay
     acá es el acto de buscar —la consulta, en cuál resultado estás—, y eso sí
     se reinicia al cambiar de documento: buscar es algo que estás haciendo
     ahora, no una propiedad del PDF como la página o el zoom. */
  buscador: null,
  consulta: '',
  actual: -1,              // índice en buscador.resultados, o -1 si ninguno
  pendiente: null,         // página cuyo resultado hay que centrar cuando monte
  divsTexto: new Map(),    // nº de página → los spans de su capa de texto

  raiz: null,              // .qr-lector del montaje de ahora
  destino: null,           // la página a la que va un irA() suave, hasta que llegue
  relojDestino: 0,
  fija: null,              // { n, st }: una hoja que irA() no pudo subir al tope (ver irA)
  observadorMini: null,    // las miniaturas que faltan pintar (ver vigilarMiniaturas)
  tareasMini: new Set(),   // las miniaturas en vuelo, para cancelarlas
  genMini: 0,              // sube cada vez que el panel cambia: corta el bucle viejo
  rueda: null,             // el zoom de Ctrl+rueda en curso (ver zoomRueda)
  relojRueda: 0,
  giro: null,              // un giro apagando lo pintado (ver girar)
  pliegue: null,           // el FLIP del panel que se pliega (ver alternarPanel)
  estirado: false,         // la pista estirada mientras cambia el tamaño (ver vigilarTamano)
  reescalados: 0,          // cuántos reescalar() hubo: lo cuentan las pruebas
};

/** La herramienta activa, ya resuelta con su color y grosor. */
function herramientaActual() {
  const base = HERRAMIENTAS[V.herramienta] || HERRAMIENTAS.pluma;
  return {
    ...base,
    id: V.herramienta,
    color: V.colores[V.herramienta] ?? base.color,
    ancho: V.anchos[V.herramienta] ?? base.ancho,
  };
}

/* ── Geometría en pantalla ───────────────────────────────────────────────── */

/** El tamaño de una página al zoom actual, ya con la rotación global aplicada. */
function medida(g, escala) {
  const girado = S.rotacion === 90 || S.rotacion === 270;
  const w = girado ? g.altoPt : g.anchoPt;
  const h = girado ? g.anchoPt : g.altoPt;
  return { ancho: Math.round(w * escala), alto: Math.round(h * escala) };
}

/**
 * La escala efectiva. En 'ancho' y 'pagina' se calcula contra el espacio
 * disponible; en 'fijo' es lo que el usuario eligió.
 *
 * Se mide contra la página MÁS ANCHA del documento y no contra la actual: si
 * cada página se ajustara sola, un documento con una hoja apaisada en el medio
 * cambiaría de escala al pasar por ella y se leería como un salto.
 */
function escalaActual() {
  if (S.modoZoom === 'fijo' || !V.visor || !S.geometrias.length) return S.zoom;

  const disponible = V.visor.clientWidth - 96;   // 48 de aire a cada lado
  const alto = V.visor.clientHeight - 72;
  const girado = S.rotacion === 90 || S.rotacion === 270;

  const maxAncho = Math.max(...S.geometrias.map((g) => (girado ? g.altoPt : g.anchoPt)));
  const maxAlto = Math.max(...S.geometrias.map((g) => (girado ? g.anchoPt : g.altoPt)));

  if (S.modoZoom === 'ancho') return Math.max(0.05, disponible / maxAncho);
  return Math.max(0.05, Math.min(disponible / maxAncho, alto / maxAlto));
}

/* ── Pintar y liberar páginas ────────────────────────────────────────────── */

function pintar(contenedor) {
  const n = Number(contenedor.dataset.pagina);
  if (V.pintadas.has(n) || V.renders.has(n)) return;

  const canvas = contenedor.querySelector('canvas');
  if (!canvas) return;

  const tarea = S.doc.render(n, {
    canvas,
    escala: escalaActual(),
    rotacionExtra: S.rotacion,
    // Que el repintado no deje la hoja en blanco mientras trabaja.
    preservar: true,
  });
  V.renders.set(n, tarea);

  /* La capa de texto NO espera al canvas: no depende de él y así el texto está
     listo para arrastrar apenas aparece la página. */
  montarTexto(contenedor, n);

  tarea.promesa
    .then(async (r) => {
      if (!r) return;                       // cancelado
      V.pintadas.add(n);
      contenedor.classList.add('is-pintada');
      await montarTinta(contenedor, n);
    })
    .catch((err) => {
      // Cancelar un render es normal al hacer scroll: no es un error a mostrar.
      if (err?.name === 'RenderingCancelledException') return;
      console.error(`[lector] página ${n}:`, err);
      marcarFallida(contenedor);
    })
    .finally(() => { if (V.renders.get(n) === tarea) V.renders.delete(n); });
}

/* Una hoja que pdf.js no pudo dibujar lo dice, y ofrece volver a probar.
   Antes quedaba en blanco con un hairline rojo casi invisible: no se sabía si
   estaba cargando, rota o si era así (ux-22). */
function marcarFallida(contenedor) {
  contenedor.classList.add('is-fallida');
  if (contenedor.querySelector(':scope > .qr-pliego__falla:not([data-state])')) return;
  const aviso = document.createElement('div');
  aviso.className = 'qr-pliego__falla';
  aviso.innerHTML = `${Icons.svg('alert')}
    <span class="ox-meta">No se pudo dibujar esta página.</span>
    <button class="ox-btn ox-btn--secondary ox-btn--sm" data-reintentar>${Icons.svg('retry')} Reintentar</button>`;
  contenedor.append(aviso);
}

/** Saca el aviso de falla (con su salida si se ve) y la marca. */
function quitarFallida(contenedor, { animar = true } = {}) {
  contenedor.classList.remove('is-fallida');
  for (const aviso of contenedor.querySelectorAll(':scope > .qr-pliego__falla')) {
    if (animar) exit(aviso, { fallback: 200 }); else aviso.remove();
  }
}

/**
 * Pone la capa de texto encima de una página: los spans transparentes que
 * hacen que el texto del PDF se pueda arrastrar con el mouse y copiar.
 *
 * Es DOM, no bitmap, así que su costo lo paga la virtualización igual que el de
 * los canvas: una página con mucho texto son miles de spans, pero solo existen
 * los de las páginas que están en pantalla.
 */
function montarTexto(contenedor, n) {
  const div = contenedor.querySelector('.qr-texto');
  if (!div || V.textos.has(n)) return;

  /* El div sobrevive a la virtualización, así que puede llegar acá ya
     registrado —al reescalar, por ejemplo—. Sin soltarlo primero, la cola de la
     selección queda huérfana: capaTexto() vacía el div y se la lleva puesta. */
  olvidarSeleccion(div);

  const tarea = S.doc.capaTexto(n, {
    contenedor: div,
    escala: escalaActual(),
    rotacionExtra: S.rotacion,
  });
  V.textos.set(n, tarea);

  tarea.promesa
    .then((r) => {
      if (!r) return;
      registrarSeleccion(div);
      /* Los spans se guardan porque son sobre lo que se resalta: una
         coincidencia sabe en qué fragmento cae, y el fragmento es uno de
         estos. */
      V.divsTexto.set(n, r.divs);
      const pos = marcarPagina(contenedor, n);
      /* Un salto a un resultado de una página que todavía no estaba montada
         termina acá: recién ahora se sabe DÓNDE cae la coincidencia. */
      if (pos && V.pendiente === n) { V.pendiente = null; centrarEn(contenedor, pos); }
    })
    .catch((err) => {
      // Cancelar es lo normal al hacer scroll: no es un error a mostrar.
      if (err?.name === 'AbortException') return;
      console.error(`[texto] página ${n}:`, err);
    })
    /* Solo se borra si el que está anotado sigue siendo ESTE. Liberar y volver
       a pintar rápido —scroll de ida y vuelta— deja a la tarea vieja
       terminando después de que la nueva se anotó: borrando a ciegas, la nueva
       queda huérfana, nadie la puede cancelar y el próximo pintar() arma una
       segunda capa encima. Dos capas son el texto duplicado al copiar. */
    .finally(() => { if (V.textos.get(n) === tarea) V.textos.delete(n); });
}

/**
 * Pone la capa de tinta encima de una página ya pintada, o la pone al día si
 * ya estaba.
 *
 * La tinta se cablea SIEMPRE, esté o no el modo de anotación activo: lo
 * anotado tiene que verse mientras leés, igual que se ve en el papel. Lo que
 * cambia con el modo es si captura el puntero. Y cablear no reserva nada: el
 * editor pide bitmap recién cuando la hoja tiene trazos o la punta pasa por
 * encima (lector-23, ver editor.js).
 */
async function montarTinta(contenedor, n) {
  if (!S.tinta || !S.doc) return;
  const doc = S.doc;
  const escala = escalaActual();
  const rotacion = S.rotacion;
  let viewport;
  try {
    viewport = await doc.viewport(n, { escala: escala * (window.devicePixelRatio || 1), rotacionExtra: rotacion });
  } catch (err) {
    console.error(`[tinta] página ${n}:`, err);
    return;
  }
  /* Mientras pdf.js contestaba, la hoja se pudo ir (liberar, otro documento)
     o la escala pudo cambiar: el render que viene después la vuelve a montar. */
  if (S.doc !== doc || !contenedor.isConnected || !V.pintadas.has(n)) return;
  if (escala !== escalaActual() || rotacion !== S.rotacion) return;

  /* El editor de la hoja SOBREVIVE al zoom y al giro (tinta-04): sigue con su
     canvas y su StrokeInput y solo cambia de viewport. Antes reescalar() lo
     destruía y esto lo volvía a cablear sobre un clon: entre el zoom y la hoja
     nítida el lápiz no escribía, y si el render terminaba con la punta
     apoyada, el pointerup caía en el clon y el trazo se perdía entero. */
  const vivo = V.editores.get(n);
  if (vivo?.vivo) { ponerViewport(vivo, viewport); return; }

  let canvas = contenedor.querySelector('.qr-tinta');
  if (!canvas) return;
  /* Un canvas que ya estuvo cableado se REEMPLAZA por un clon antes de volver
     a cablearlo. StrokeInput registra sus listeners sobre el elemento y no
     expone forma de sacarlos (viene de Scrawl tal cual y así se queda), así
     que cablear dos veces el mismo canvas deja dos StrokeInput escuchando y
     CADA TRAZO SE GUARDA DUPLICADO. Pasa con una hoja que se fue de la
     precarga (liberar destruye su editor) y vuelve. Un canvas que nunca se
     cableó no se clona. Va después del await, en una sola tarea: dos
     montajes de la misma hoja no se pisan. */
  if (canvas.__cableado) {
    const limpio = canvas.cloneNode(false);
    canvas.replaceWith(limpio);
    canvas = limpio;
  }
  canvas.__cableado = true;
  const editor = cablearTinta(canvas, {
    pagina: n,
    capa: S.tinta,
    viewport,
    resaltador: contenedor.querySelector('.qr-tinta-resaltador'),
    viva: contenedor.querySelector('.qr-tinta-viva'),
    herramienta: herramientaActual,
    /* La goma del otro extremo del lápiz borra con el tamaño del borrador de
       la barra, no con el grosor de la pluma (tinta-05). */
    goma: () => ({ ...HERRAMIENTAS.borrador, id: 'borrador', ancho: V.anchos.borrador }),
    activo: () => V.tintaActiva,
    onPan: panLateral,
    // La barra se entera por el evento 'tinta' de la capa, no por acá.
  });
  V.editores.set(n, editor);
}

const mismoViewport = (a, b) => !!a && !!b && Math.abs(a.scale - b.scale) < 1e-6
  && a.rotation === b.rotation && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

function ponerViewport(editor, viewport) {
  if (editor.vivo && !mismoViewport(editor.viewport, viewport)) editor.actualizar(viewport);
}

/* Con la escala o el giro nuevos, cada editor vivo pide su viewport y se pone
   al día apenas llega (pdf.js tiene la página en caché: es casi inmediato).
   Mientras tanto la tinta se estira con el pliego, como la hoja, y lo que se
   dibuje cae donde se ve: el editor convierte con la caja real del canvas. */
function actualizarEditores() {
  const doc = S.doc;
  const escala = V.escalaHecha;
  const rotacion = S.rotacion;
  const dpr = window.devicePixelRatio || 1;
  for (const [n, ed] of V.editores) {
    if (!ed.vivo) continue;
    doc.viewport(n, { escala: escala * dpr, rotacionExtra: rotacion }).then((vp) => {
      if (S.doc !== doc || V.editores.get(n) !== ed || V.escalaHecha !== escala || S.rotacion !== rotacion) return;
      ponerViewport(ed, vp);
    }).catch((err) => console.error(`[tinta] página ${n}:`, err));
  }
}

/* ── El botón lateral del lápiz desplaza (tinta-15) ─────────────────────────
   Con la tinta prendida el canvas se queda con el puntero, y el lápiz no
   tenía cómo mover la hoja sin soltar la herramienta (salvo el puck). El
   botón lateral —o la rueda apretada del mouse— arrastran la hoja como la
   mano del puck: el editor avisa las tres fases con el punto en px de la
   ventana, y acá se corre el scroll lo que se movió la mano. */
let paneoLateral = null;

function panLateral({ fase, x, y }) {
  const visor = V.visor;
  if (!visor) { paneoLateral = null; return; }
  if (fase === 'empezar') {
    // Moverse a mano suelta un salto a un resultado que esperaba su capa de texto (lector-34).
    V.pendiente = null;
    paneoLateral = { x, y, sl: visor.scrollLeft, st: visor.scrollTop };
  } else if (fase === 'mover' && paneoLateral) {
    visor.scrollLeft = paneoLateral.sl - (x - paneoLateral.x);
    visor.scrollTop = paneoLateral.st - (y - paneoLateral.y);
  } else {
    paneoLateral = null;
  }
}

function liberar(contenedor) {
  const n = Number(contenedor.dataset.pagina);
  /* Un salto a un resultado que esperaba que esta página montara su texto ya
     no tiene sentido si la página se fue: sin esto, minutos después, al volver
     a pasar por ella, la vista se iba sola al resultado (lector-34). */
  if (V.pendiente === n) V.pendiente = null;

  /* Nada que soltar, nada que hacer. Cada IntersectionObserver nuevo (al
     construir y en cada reescalado) avisa una vez por pliego, y los que no se
     ven llegan acá: en un libro de 1265 páginas eran más de mil vueltas de
     querySelector, replaceChildren y canvas a 0 por cada paso de zoom, sobre
     hojas que nunca se habían pintado (lector-35).
     El bitmap se mira aparte, por su ancho, y no por is-pintada: girar() le
     saca la clase a todas las hojas para apagarlas, y en un escaneo (sin capa
     de texto que delate a la hoja) las que quedaban fuera de vista después del
     giro se quedaban con su bitmap para siempre. */
  const texto = contenedor.querySelector('.qr-texto');
  const marcas = contenedor.querySelector('.qr-marcas');
  const conBitmap = [...contenedor.querySelectorAll('canvas')].some((c) => c.width);
  if (!contenedor.classList.contains('is-pintada') && !contenedor.classList.contains('is-fallida')
      && !V.renders.has(n) && !V.textos.has(n) && !V.editores.has(n)
      && !conBitmap && !texto?.firstChild && !marcas?.firstChild) return;

  V.renders.get(n)?.cancelar();
  V.renders.delete(n);
  V.pintadas.delete(n);
  V.editores.get(n)?.destruir();
  V.editores.delete(n);
  V.textos.get(n)?.cancelar();
  V.textos.delete(n);
  contenedor.classList.remove('is-pintada');
  /* La falla también se va: si al volver la página se pinta bien, quedaba
     dibujada y con el borde rojo encima (ux-22). Fuera de pantalla, sin salida. */
  quitarFallida(contenedor, { animar: false });
  /* Lo que pdf.js guarda de la página (las imágenes decodificadas y la lista
     de operadores) se suelta también: el PDFPageProxy queda cacheado para
     siempre, y sin esto cada hoja que pasaba por pantalla se quedaba con lo
     suyo en memoria aunque se soltara el canvas (lector-06). Va DESPUÉS de
     cancelar: con un render en curso, pdf.js deja la limpieza para cuando
     termine. */
  S.doc?.soltar?.(n);

  /* Los spans se van con la página. Vaciar el div a mano y no dejar que el
     próximo render lo pise: mientras la página está fuera de pantalla, miles de
     spans invisibles siguen siendo miles de nodos en el árbol. */
  if (texto) { olvidarSeleccion(texto); texto.replaceChildren(); }

  /* Las marcas de la búsqueda se van con los spans sobre los que estaban
     medidas: sin esto quedarían pintadas sobre una capa vacía, y al volver la
     página se sumarían a las nuevas. */
  V.divsTexto.delete(n);
  if (marcas) {
    /* Se apaga ADEMÁS de vaciarse. Vaciar y dejarla prendida deja una capa
       visible sin nada adentro, y esa combinación es un agujero: remarcarTodo()
       decide a quién visitar preguntando por hijos, así que una capa así no la
       vuelve a tocar nadie y se queda prendida para siempre. */
    marcas.classList.remove('is-visible');
    marcas.replaceChildren();
    marcas.style.transform = '';
    marcasPintadas.delete(marcas);
  }

  // Poner width en 0 libera el bitmap. Sin esto los canvas siguen ocupando su
  // memoria aunque ya no se vean, y la virtualización no sirve de nada.
  contenedor.querySelectorAll('canvas').forEach((c) => { c.width = 0; c.height = 0; });
}

function liberarTodo() {
  for (const t of V.renders.values()) t.cancelar();
  V.renders.clear();
  V.pintadas.clear();
  for (const e of V.editores.values()) e.destruir();
  V.editores.clear();
  for (const t of V.textos.values()) t.cancelar();
  V.textos.clear();
  V.divsTexto.clear();
  olvidarSelecciones();
  V.observador?.disconnect();
  V.observador = null;
}

/* ── Construcción del visor ──────────────────────────────────────────────── */

function construirPaginas() {
  if (!V.visor || !S.doc) return;

  const escala = escalaActual();
  V.escalaHecha = escala;
  const pista = V.visor.querySelector('.qr-pista');
  /* Los canvas nacen en 0×0 y no en los 300×150 de fábrica: así «tiene
     bitmap» se lee de su ancho (ver liberar), y una hoja que todavía no se
     pintó no reserva nada. */
  pista.innerHTML = S.geometrias.map((g) => {
    const { ancho, alto } = medida(g, escala);
    return `
      <div class="qr-pliego" data-pagina="${g.numero}" style="width:${ancho}px;height:${alto}px">
        <canvas class="qr-hoja" width="0" height="0"></canvas>
        <div class="qr-marcas"></div>
        <div class="qr-texto"></div>
        <canvas class="qr-tinta-resaltador" width="0" height="0"></canvas>
        <canvas class="qr-tinta" width="0" height="0"></canvas>
        <canvas class="qr-tinta-viva" width="0" height="0"></canvas>
        <span class="qr-pliego__num">${g.numero}</span>
      </div>`;
  }).join('');

  /* La escala de recién se midió con la pista VACÍA, sin la barra de scroll
     que aparece apenas entran las hojas: en ancho las hojas salían unos
     píxeles más anchas, y el ResizeObserver reescalaba al cuadro siguiente
     (y corría lo que se acababa de devolver con devolverLugar). Medida de
     nuevo con las hojas puestas, en la misma tarea, no la ve nadie. */
  const ahora = escalaActual();
  if (Math.abs(ahora - escala) > 1e-4) {
    V.escalaHecha = ahora;
    for (const el of pista.children) {
      const { ancho, alto } = medida(S.geometrias[Number(el.dataset.pagina) - 1], ahora);
      el.style.width = `${ancho}px`;
      el.style.height = `${alto}px`;
    }
  }

  V.observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) pintar(e.target);
      else liberar(e.target);
    }
  }, {
    root: V.visor,
    rootMargin: `${Math.round(MARGEN_PRECARGA * 100)}% 0px`,
  });

  pista.querySelectorAll('.qr-pliego').forEach((el) => V.observador.observe(el));
}

/* ── El ancla: qué punto del papel tiene que quedar dónde ────────────────────
   Cambiar la escala por cualquier camino (Ctrl+rueda, los botones, el menú,
   ajustar, el ResizeObserver) mandaba al tope de la página: reescalar()
   terminaba en irA() y la posición dentro de la hoja se perdía (lector-03).
   Ahora se fotografía qué punto del papel hay bajo un punto del visor —el
   puntero para la rueda, el centro para todo lo demás— y después de cambiar
   los tamaños se corrige el scroll para que ese punto siga ahí. Es la cuenta
   que ya hacía asentarZoom() para el puck, sacada para que la usen todos.

   Por rectángulos y no por offsetTop: así vale también con la pista escalada
   en vivo (el puck, la rueda, el estirado del resize), que es lo que se ve. */
function fotoAncla(x, y) {
  if (!V.visor) return null;
  const vr = V.visor.getBoundingClientRect();
  let ancla = null;
  for (const el of V.visor.querySelectorAll('.qr-pliego')) {
    const r = el.getBoundingClientRect();
    const top = r.top - vr.top;
    if (ancla && y < top) break;
    ancla = { el, x, y, fx: (x - (r.left - vr.left)) / r.width, fy: (y - top) / r.height };
  }
  return ancla;
}

const anclaCentro = () => (V.visor ? fotoAncla(V.visor.clientWidth / 2, V.visor.clientHeight / 2) : null);

/** Corre el scroll para que el punto del papel de `ancla` vuelva a caer donde estaba. */
function ponerAncla(ancla) {
  if (!ancla?.el?.isConnected || !V.visor) return;
  const vr = V.visor.getBoundingClientRect();
  const r = ancla.el.getBoundingClientRect();
  V.visor.scrollTop += (r.top - vr.top) + ancla.fy * r.height - ancla.y;
  V.visor.scrollLeft += (r.left - vr.left) + ancla.fx * r.width - ancla.x;
}

/**
 * Recalcula tamaños sin desarmar el DOM, y vuelve a pintar lo que se ve.
 *
 * `ancla` es el punto del papel que tiene que quedar quieto (de fotoAncla());
 * sin pasarla, el del centro del visor. Con `null`, no se toca el scroll.
 */
function reescalar({ ancla } = {}) {
  if (!V.visor || !S.doc) return;
  V.reescalados += 1;
  // Con otra escala, el scroll donde irA() dejó una hoja fija ya es otro lugar.
  V.fija = null;

  const punto = ancla === undefined ? anclaCentro() : ancla;
  const escala = escalaActual();
  V.escalaHecha = escala;

  /* Se cancelan los renders en vuelo pero NO se tocan los bitmaps: el de la
     escala anterior, estirado por CSS, se ve borroso un instante y después se
     nitidiza. Liberarlos acá dejaría la hoja en blanco hasta que termine el
     repintado, que es justo el parpadeo que se quiere evitar. Los editores de
     tinta tampoco se sueltan: siguen escuchando al lápiz y se ponen al día
     con el viewport nuevo (tinta-04, ver actualizarEditores). */
  for (const t of V.renders.values()) t.cancelar();
  V.renders.clear();
  V.pintadas.clear();
  /* La capa de texto sí se rehace: sus spans están calzados sobre las letras a
     la escala vieja, y un span corrido no se ve pero se selecciona mal. */
  for (const t of V.textos.values()) t.cancelar();
  V.textos.clear();
  /* Los spans de la escala vieja quedan a la basura, y con ellos las medidas
     de las marcas: se vuelven a tomar cuando la capa nueva esté montada. */
  V.divsTexto.clear();
  V.observador?.disconnect();
  V.observador = null;

  V.visor.querySelectorAll('.qr-pliego').forEach((el) => {
    const g = S.geometrias[Number(el.dataset.pagina) - 1];
    const { ancho, alto } = medida(g, escala);
    el.style.width = `${ancho}px`;
    el.style.height = `${alto}px`;
    if (el.classList.contains('is-fallida')) quitarFallida(el);
    // is-pintada se MANTIENE: el canvas sigue teniendo la imagen anterior, y
    // la hoja (100 % del pliego, ver render()) se estira con él desde ya.
    /* Las marcas de la búsqueda están en px de la escala vieja y no se
       vuelven a medir hasta que la capa de texto nueva monte: sin esto
       quedaban sobre otras palabras entre 100 y 500 ms y después saltaban.
       Se estiran con la hoja, y marcarPagina() saca el estirado al volver a
       medirlas (lector-04). */
    const capa = el.querySelector('.qr-marcas');
    const memo = capa && marcasPintadas.get(capa);
    if (memo && capa.firstChild) {
      capa.style.transformOrigin = '0 0';
      capa.style.transform = `scale(${escala / memo.escala})`;
    }
  });

  V.observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) pintar(e.target);
      else liberar(e.target);
    }
  }, { root: V.visor, rootMargin: `${Math.round(MARGEN_PRECARGA * 100)}% 0px` });

  V.visor.querySelectorAll('.qr-pliego').forEach((el) => V.observador.observe(el));
  actualizarEditores();

  // El mismo punto del papel donde estaba (ver fotoAncla). Antes: el tope de la página.
  if (punto) ponerAncla(punto);
  actualizarBarra();
}

/* Dónde arranca una hoja dentro del área de scroll del visor. El offsetParent
   de un pliego es el cuerpo del lector y no el visor, así que se descuenta lo
   que el visor tenga por encima dentro del cuerpo (hoy 0, pero no se apuesta). */
const topeDe = (el) => el.offsetTop - V.visor.offsetTop;

function irA(n, { suave = true } = {}) {
  const visor = V.visor;
  const destino = visor?.querySelector(`.qr-pliego[data-pagina="${n}"]`);
  if (!destino) return;
  const deseado = topeDe(destino) - 24;
  /* El top se acota a lo que el scroll puede dar. Las últimas hojas no
     llegan al borde de arriba (a 25 % entran varias en el último visor), y
     comparar contra el top sin acotar fijaba un destino hacia un lugar al que
     el scroll no iba a ir nunca. */
  const top = Math.min(Math.max(0, visor.scrollHeight - visor.clientHeight), Math.max(0, deseado));
  /* Mientras dura el viaje, la página es la de destino y no la que vaya
     cruzando el tercio de arriba. A zoom chico la línea del tercio ya cae en
     la hoja siguiente apenas se llega, alScrollear pisaba S.pagina con n+1 y
     el próximo «siguiente» saltaba a n+2: el contador iba 3, 5, 7 (lector-32).
     Si el scroll no se va a mover no hay viaje que esperar —salvo que haya
     otro en curso, que este scrollTo corta: ese destino pasa a ser n—. */
  if (suave && (Math.abs(visor.scrollTop - top) > 1 || V.destino != null)) fijarDestino(n);
  /* Y si la hoja no puede quedar arriba, al llegar tampoco manda
     paginaEnPantalla(): la hoja de tope más cercano al borde es una ANTERIOR,
     y S.pagina volvía a ella a los 1200 ms. A 25 %, irA(40) mostraba 40 y
     volvía a 38, y tres «siguiente» daban 38, 38, 38: no se llegaba más a
     las últimas. La de destino queda fija mientras el scroll siga donde la
     dejó; el primer movimiento del usuario la suelta (ver fijaVigente). */
  V.fija = top < deseado - 1 ? { n, st: top } : null;
  visor.scrollTo({ top, behavior: suave ? 'smooth' : 'auto' });
  const cambia = S.pagina !== n;
  S.pagina = n;
  actualizarBarra();
  /* alScrollear marca el panel solo si la página cambió, y acá ya cambió: sin
     esto, saltar con el campo o con un marcador dejaba la miniatura (o el
     capítulo) de antes marcada. */
  if (cambia) marcarMiniatura();
}

/**
 * Espacio y AvPág (con `dir` 1) bajan UNA PANTALLA antes de pasar de hoja;
 * Shift+Espacio y RePág suben. Saltar derecho a la siguiente se comía la
 * mitad de abajo de cada página en «Ajustar al ancho», que es el zoom de
 * arranque: una A4 vertical mide casi el doble que el visor (lector-18, ux-15;
 * decisión de Fran). El paso es una pantalla menos 48 px de respiro, para no
 * perder el renglón que estaba en el borde, y nunca se pasa de la hoja: llega
 * justo a su final (o a su tope, subiendo) y el toque siguiente cruza.
 */
function bajarPantalla(dir) {
  const visor = V.visor;
  const el = visor?.querySelector(`.qr-pliego[data-pagina="${S.pagina}"]`);
  if (!el) return;
  const alto = visor.clientHeight;
  const paso = Math.max(48, alto - 48);
  const tope = topeDe(el) - visor.scrollTop;         // el tope de la hoja, en px del visor
  if (dir > 0) {
    const fondo = tope + el.offsetHeight;
    if (fondo > alto + 1) {
      visor.scrollBy({ top: Math.min(paso, fondo - alto + 24), behavior: 'smooth' });
    } else if (S.pagina < S.doc.paginas) irA(S.pagina + 1);
    /* En la última, con su final ya a la vista, no hay a dónde ir. Antes
       caía en irA() a la MISMA hoja, que sube al tope: el toque de más al
       terminar de leer te tiraba media página para arriba. */
    return;
  }
  if (tope < 23) {
    visor.scrollBy({ top: -Math.min(paso, 24 - tope), behavior: 'smooth' });
    return;
  }
  // Ya en el tope de esta hoja: la anterior, desde su final.
  const previa = el.previousElementSibling;
  if (!previa) return;
  const falta = 24 - (topeDe(previa) - visor.scrollTop);
  if (falta <= paso) irA(S.pagina - 1);
  else visor.scrollBy({ top: -paso, behavior: 'smooth' });
}

/* El destino se suelta cuando el scroll termina (scrollend). El tope es por
   si no llega: un scroll que el usuario corta con la rueda igual dispara
   scrollend, pero uno que no se movió no dispara nada. */
function fijarDestino(n) {
  clearTimeout(V.relojDestino);
  V.destino = n;
  V.relojDestino = setTimeout(soltarDestino, 1200);
}
function soltarDestino() {
  clearTimeout(V.relojDestino);
  if (V.destino == null) return;
  V.destino = null;
  // Llegado, se mira de nuevo dónde quedó: con la regla de la hoja baja de
  // paginaEnPantalla(), la de destino sigue siendo la de destino (y si no
  // pudo subir al tope, la sostiene V.fija).
  alScrollear();
}

/* La hoja que irA() dejó fija porque no podía subir al tope, mientras el
   scroll siga exactamente donde la dejó. Si se movió, la soltó el usuario. */
function fijaVigente() {
  const f = V.fija;
  if (!f) return null;
  if (Math.abs(V.visor.scrollTop - f.st) <= 1) return f.n;
  V.fija = null;
  return null;
}

/* ── Qué página estoy mirando ────────────────────────────────────────────── */

let tickScroll = null;

/**
 * La página que se está leyendo, según dónde está el scroll.
 *
 * Es la que cruza el tercio superior del visor: la que uno está leyendo, no
 * la que ocupa más pantalla. Con hojas más bajas que ese tercio (25 % de zoom
 * en una ventana alta) la línea cruza varias, y ahí manda la que tiene el
 * tope más cerca del borde de arriba —donde irA() deja la hoja—: si no,
 * llegar a la n la contaba como n+1 (lector-32).
 */
function paginaEnPantalla() {
  const st = V.visor.scrollTop;
  const linea = st + V.visor.clientHeight * 0.33;
  let actual = 1;
  const arriba = [];
  for (const el of V.visor.querySelectorAll('.qr-pliego')) {
    const t = topeDe(el);
    if (t > linea) break;
    actual = Number(el.dataset.pagina);
    if (t >= st - 1) arriba.push({ n: actual, d: Math.abs(t - (st + 24)) });
  }
  if (arriba.length > 1) actual = arriba.reduce((a, b) => (b.d < a.d ? b : a)).n;
  return actual;
}

function alScrollear() {
  if (tickScroll) return;
  tickScroll = requestAnimationFrame(() => {
    tickScroll = null;
    if (!V.visor) return;
    const actual = V.destino ?? fijaVigente() ?? paginaEnPantalla();
    if (actual !== S.pagina) {
      S.pagina = actual;
      actualizarBarra();
      marcarMiniatura();
    }
    anotarLugar();
  });
}

/* ── Barra y chrome ──────────────────────────────────────────────────────── */

/* Lo que la barra y la statusbar escriben con la app andando. Ninguno con
   textContent: cambiaban de un cuadro al otro (lector-27, fw-09).
   · El zoom va SIEMPRE por valor(): en el gesto del puck y de la rueda cambia
     en cada cuadro, y mezclarlo con frase() o textContent desfasaba la memoria
     de cada uno (§1.8 del plan). Nace vacío y el montaje escribe el primero.
   · La página cambia con cada hoja que pasa: en su lugar y sin destello
     (swap sin opciones). Un destello por hoja sería un parpadeo constante.
   · La medida, con frase(): cuando cambia el tamaño de la hoja, relevo, y el
     ítem de la statusbar viaja de ancho en vez de empujar de golpe a los de
     al lado (deslizarAncho).
   El chrome (app.js) escribe lo mismo fuera del lector: con el mismo texto,
   swap() y frase() no hacen nada, así que dos escritores no se pisan. */
const textoPagina = () => `${S.pagina} / ${S.doc.paginas}`;
const textoZoom = (escala) => `${Math.round(escala * 100)}%`;

function actualizarBarra() {
  const campo = document.getElementById('qr-pagina-input');
  if (campo && document.activeElement !== campo) campo.value = S.pagina;

  valor(document.getElementById('qr-zoom-valor'), textoZoom(escalaActual()));

  const g = S.geometrias[S.pagina - 1];
  const medidaStat = document.getElementById('stat-medida');
  const medidaVal = document.getElementById('stat-medida-value');
  if (medidaStat && medidaVal && g) {
    const html = esc(g.etiqueta);
    if (medidaStat.hidden) { medidaStat.hidden = false; frase(medidaVal, html); }
    else deslizarAncho(medidaStat, () => frase(medidaVal, html));
  }

  const pagStat = document.getElementById('stat-pagina');
  const pagVal = document.getElementById('stat-pagina-value');
  if (pagStat && pagVal && S.doc) {
    pagStat.hidden = false;
    swap(pagVal, textoPagina());
  }
}

/** Lleva una fila a la vista dentro de su scroller, centrada, si no se ve entera. */
function traerALaVista(scroller, fila, { suave = true } = {}) {
  const arriba = fila.offsetTop;
  const visible = arriba >= scroller.scrollTop
    && arriba + fila.offsetHeight <= scroller.scrollTop + scroller.clientHeight;
  if (visible) return;
  const top = Math.max(0, arriba - scroller.clientHeight / 2 + fila.offsetHeight / 2);
  scroller.scrollTo({ top, behavior: suave ? 'smooth' : 'auto' });
}

/**
 * Marca en el panel dónde estás: la miniatura de la página, o el marcador del
 * capítulo. `suave: false` al montar, que no es un movimiento: aparecer
 * parado en la 200 con la columna en la 1 obligaba a buscarse a mano
 * (lector-10).
 */
function marcarMiniatura({ suave = true } = {}) {
  const panel = document.getElementById('qr-panel-cuerpo');
  if (!panel) return;
  if (V.panel === 'esquema') { marcarEsquema(panel, { suave }); return; }
  if (V.panel !== 'miniaturas') return;
  // Solo lo vivo: el calco del fundido del panel también tiene miniaturas.
  let activa = null;
  for (const m of panel.querySelectorAll(':scope > .qr-mini')) {
    const es = Number(m.dataset.pagina) === S.pagina;
    m.classList.toggle('is-actual', es);
    if (es) activa = m;
  }
  if (activa) traerALaVista(panel, activa, { suave });
}

/* Marcadores dice en qué capítulo estás: el último cuya página no pasó de la
   que estás leyendo. Antes no marcaba nada y había que buscarlo a ojo
   (lector-38). */
function marcarEsquema(panel, { suave = true } = {}) {
  let actual = null;
  const items = panel.querySelectorAll(':scope > .qr-esquema > .qr-esquema__item');
  for (const it of items) {
    const p = Number(it.dataset.pagina);
    if (p && p <= S.pagina) actual = it;
  }
  for (const it of items) it.classList.toggle('is-actual', it === actual);
  if (actual) traerALaVista(panel, actual, { suave });
}

/* ── Panel lateral ───────────────────────────────────────────────────────────
   Tres cosas en el mismo cuerpo (Miniaturas, Marcadores, Buscar). Cambiar de
   una a otra era un innerHTML: lo viejo se iba y lo nuevo aparecía en el mismo
   cuadro (lector-14). Ahora es un fundido —el panel es una superficie, con su
   fondo opaco—: lo viejo pasa a un calco encima y se esfuma, lo nuevo está
   entero y quieto debajo desde el primer cuadro. */

const girado = () => S.rotacion === 90 || S.rotacion === 270;

/* La miniatura se dibuja SIN el giro del lector y se gira por CSS: así la
   misma imagen cacheada sirve para las cuatro orientaciones, y girar no vuelve
   a pedirle nada a pdf.js (lector-30). Con 90 o 270, la caja de la hoja ya
   tiene la proporción girada y la imagen va centrada adentro, con el ancho y
   el alto cambiados, para que al girar llene la caja. */
function estiloGiro(g) {
  const r = S.rotacion;
  if (!r) return '';
  if (r === 180) return 'transform:rotate(180deg)';
  const w = ((g.anchoPt / g.altoPt) * 100).toFixed(3);
  const h = ((g.altoPt / g.anchoPt) * 100).toFixed(3);
  return `position:absolute;left:50%;top:50%;width:${w}%;height:${h}%;transform:translate(-50%, -50%) rotate(${r}deg)`;
}

const imgMini = (url, g, { entra = false } = {}) =>
  `<img class="qr-mini__lienzo${entra ? ' is-entrando' : ''}" src="${url}" alt="" draggable="false" style="${estiloGiro(g)}">`;

/* Las que ya están en la caché del documento van derecho en el HTML, ya
   listas y sin entrada: volver al lector (de Imprimir, de otra pestaña) las
   mostraba de a una con su fundido, como si fuera la primera vez (lector-11). */
function htmlMiniaturas() {
  const doc = S.doc;
  return S.geometrias.map((g) => {
    const url = doc.miniaturaLista?.(g.numero);
    const [w, h] = girado() ? [g.altoPt, g.anchoPt] : [g.anchoPt, g.altoPt];
    return `
    <button class="qr-mini${g.numero === S.pagina ? ' is-actual' : ''}${url ? ' is-lista' : ''}" data-pagina="${g.numero}">
      <span class="qr-mini__hoja" style="aspect-ratio:${w} / ${h}">${url ? imgMini(url, g) : ''}</span>
      <span class="qr-mini__num">${g.numero}</span>
    </button>`;
  }).join('');
}

/**
 * Las miniaturas se pintan bajo demanda: en un documento largo, generar 400
 * de una tarda más que abrir el archivo.
 *
 * Cada una se dibuja una vez por documento y queda como imagen (ver
 * Documento.miniatura): antes era un canvas de ~390 KB que no se soltaba
 * nunca, y leer un tratado de corrido con el panel abierto iba juntando
 * cientos de MB (lector-11).
 *
 * El bucle se corta si el panel cambió o si el documento ya es otro. Antes
 * seguía después de un Ctrl+Tab, leyendo S.geometrias y S.doc del documento
 * NUEVO después de cada await: con uno más corto llenaba la consola de
 * TypeError, con uno más largo pintaba páginas ajenas en nodos que ya no
 * estaban (lector-29). Por eso el documento y su geometría se fijan acá.
 */
function vigilarMiniaturas(cuerpo) {
  soltarMiniaturas();
  const doc = S.doc;
  const geos = S.geometrias;
  const gen = V.genMini;
  const sigue = (el) => V.genMini === gen && S.doc === doc && el.isConnected;

  const obs = new IntersectionObserver(async (entradas, self) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      self.unobserve(e.target);
      if (!sigue(e.target)) return;
      const n = Number(e.target.dataset.pagina);
      const g = geos[n - 1];
      try {
        /* En un Set y no en una sola variable: cada scroll del panel vuelve a
           disparar este callback mientras el anterior sigue en su await, así
           que puede haber varias en vuelo, y soltarMiniaturas() cancelaba
           solo la última. */
        const tarea = doc.miniatura(n, { ancho: 132, dpr: 2 });
        V.tareasMini.add(tarea);
        const url = await tarea.promesa.finally(() => V.tareasMini.delete(tarea));
        if (!url || !sigue(e.target)) { if (V.genMini !== gen) return; continue; }
        const img = document.createElement('img');
        img.src = url;
        // Decodificada antes de entrar: si no, el fundido arranca con la caja vacía.
        await img.decode().catch(() => {});
        if (!sigue(e.target)) { if (V.genMini !== gen) return; continue; }
        e.target.querySelector('.qr-mini__hoja')?.insertAdjacentHTML('beforeend', imgMini(url, g, { entra: true }));
        e.target.classList.add('is-lista');
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.error(`[miniatura ${n}]`, err);
      }
    }
  }, { root: cuerpo, rootMargin: '200% 0px' });

  cuerpo.querySelectorAll(':scope > .qr-mini:not(.is-lista)').forEach((m) => obs.observe(m));
  V.observadorMini = obs;
}

/* Corta lo que estaba pintando miniaturas: el observador, las que estaban en
   vuelo (se cancelan en pdf.js) y el bucle (por la generación). */
function soltarMiniaturas() {
  V.observadorMini?.disconnect();
  V.observadorMini = null;
  for (const t of V.tareasMini) t.cancelar();
  V.tareasMini.clear();
  V.genMini += 1;
}

function htmlEsquema() {
  /* Los marcadores pueden llegar después que el documento: resolverlos todos
     es una ida y vuelta al worker por destino, y en un tratado son cientos.
     Si el estado todavía no los trae, se piden acá, la primera vez que se
     abre la pestaña (lector-24). */
  if (!Array.isArray(S.esquema)) {
    const doc = S.doc;
    doc.esquema().then((lista) => {
      if (S.doc !== doc) return;
      S.esquema = lista;
      if (V.panel === 'esquema') ponerPanel('esquema', { fundir: true });
    }).catch((err) => console.error('[marcadores]', err));
    return `
      <div class="qr-panel__vacio">
        ${Icons.spinner()}
        <span class="ox-meta">Leyendo los marcadores…</span>
      </div>`;
  }
  if (!S.esquema.length) {
    return `
      <div class="qr-panel__vacio">
        ${Icons.svg('marcador')}
        <span class="ox-meta">Este PDF no trae marcadores.</span>
      </div>`;
  }
  return `<div class="qr-esquema">${S.esquema.map((e) => `
    <button class="qr-esquema__item" data-pagina="${e.pagina || ''}" style="--nivel:${e.nivel}"
            ${e.pagina ? '' : 'disabled'}>
      <span class="qr-esquema__titulo ox-truncate">${esc(e.titulo)}</span>
      ${e.pagina ? `<span class="qr-esquema__pag ox-num">${e.pagina}</span>` : ''}
    </button>`).join('')}</div>`;
}

/**
 * Pone en el cuerpo del panel lo de `cual`. Al montar la vista, derecho (el
 * primer llenado no es un cambio); al cambiar de pestaña del panel o al girar,
 * con fundido.
 *
 * El calco del fundido vive ADENTRO del cuerpo, que scrollea: se lo deja en el
 * borde de arriba (scroll a 0 antes de calcar) y se le devuelve a él el
 * scroll que tenía la lista, así lo que se va se ve donde estaba. Y se le
 * clava el acomodo viejo: .es-buscar cambia el display y el relleno del
 * cuerpo, y el calco los hereda en vivo —sin esto, las miniaturas que se iban
 * se corrían 12 px al pasar a Buscar—. Un absoluto adentro de un scroller se
 * va con el scroll: cuando lo nuevo se acomoda en su lugar (la miniatura
 * actual, centrada), el calco se corre lo mismo, así sigue tapando el panel
 * en vez de irse de vista en el primer cuadro.
 */
function ponerPanel(cual, { fundir = false } = {}) {
  const cuerpo = document.getElementById('qr-panel-cuerpo');
  if (!cuerpo || !S.doc) return;
  soltarMiniaturas();
  const html = cual === 'miniaturas' ? htmlMiniaturas() : cual === 'esquema' ? htmlEsquema() : htmlBuscar();
  /* Buscar no es una lista más: el cuerpo pasa a ser campo fijo arriba y lista
     con scroll propio abajo. Sin la clase, el campo scrollearía junto con los
     resultados y se iría de pantalla apenas hay unos cuantos. */
  const esBuscar = cual === 'buscar';

  let calco = null;
  if (!fundir) {
    cuerpo.classList.toggle('es-buscar', esBuscar);
    cuerpo.innerHTML = html;
  } else {
    const cs = getComputedStyle(cuerpo);
    const acomodo = { display: cs.display, flexDirection: cs.flexDirection, padding: cs.padding };
    const scroll = cuerpo.scrollTop;
    cuerpo.scrollTop = 0;
    cuerpo.classList.toggle('es-buscar', esBuscar);
    swap(cuerpo, html, { fundido: true });
    calco = cuerpo.firstElementChild?.classList.contains('ox-swap-out--fundido') ? cuerpo.firstElementChild : null;
    if (calco) {
      Object.assign(calco.style, acomodo, { overflow: 'hidden' });
      calco.scrollTop = scroll;
    }
  }
  Icons.mount(cuerpo);

  if (cual === 'miniaturas') vigilarMiniaturas(cuerpo);
  else if (cual === 'buscar') { cablearBuscar(); pintarResultados(); marcarLista({ suave: false }); }
  marcarMiniatura({ suave: false });
  if (calco && cuerpo.scrollTop) calco.style.top = `${(parseFloat(calco.style.top) || 0) + cuerpo.scrollTop}px`;
}

function cambiarPanel(cual) {
  if (cual === V.panel && document.getElementById('qr-panel-cuerpo')?.firstElementChild) return;
  V.panel = cual;
  document.querySelectorAll('.qr-panel__tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.panel === cual);
  });
  ponerPanel(cual, { fundir: true });
}

/* ── Buscar ──────────────────────────────────────────────────────────────────
   El motor está en pdf/buscador.js; acá vive lo que se ve. Dos mitades que se
   hablan por V.actual: la LISTA del panel y las MARCAS sobre la hoja.

   Las marcas no se pintan metiéndole spans a la capa de texto —que es lo que
   hace el visor de pdf.js—: se mide dónde cae cada coincidencia con un Range y
   se pinta un rectángulo aparte, en su propia capa. Es una decisión, no un
   atajo. La capa de texto es de la selección, y seleccion.js recorre su
   estructura hermano por hermano para mover la cola; partirle los spans al
   medio para envolver una coincidencia rompería justo eso. Midiendo, el
   resaltado no toca nada: lee.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Los temporizadores del apagado de cada capa de marcas. En un WeakMap y no
   colgados del nodo: el div es de la plantilla del pliego y sobrevive a la
   virtualización, así que lo que se le cuelgue encima también. */
const apagados = new WeakMap();

/* Con qué se pintó cada capa: los hits, los spans y la escala. Si al volver a
   marcarla nada de eso cambió (un Enter, F3, la flecha del panel, el
   repintado de una búsqueda en curso), no se rehace: solo se mueve
   `is-actual` de una marca a otra, y la transición de color de .qr-marca lleva
   el foco de una a la otra. Antes se recreaban TODAS con su entrada en cada
   Enter y en cada repintado de la búsqueda —seis por segundo—: los veinte
   resaltados de la hoja latían (lector-05, css-11). */
const marcasPintadas = new WeakMap();

/**
 * Apaga las marcas de una capa y recién después la vacía.
 *
 * Vaciar de una es lo que se ve mal: al borrar el campo, todo lo resaltado de
 * la hoja desaparecería en un frame. Se apaga con la transición de la capa y el
 * vaciado va atrás.
 *
 * El apagado va SIN condición, incluso con la capa ya vacía: una capa prendida
 * y sin hijos es un agujero, porque remarcarTodo() decide a quién visitar
 * preguntando justamente por los hijos y no la vuelve a tocar nunca más.
 */
function limpiarMarcas(capa) {
  marcasPintadas.delete(capa);
  capa.classList.remove('is-visible');
  if (!capa.firstChild) return;
  clearTimeout(apagados.get(capa));
  apagados.set(capa, setTimeout(() => {
    if (!capa.classList.contains('is-visible')) capa.replaceChildren();
  }, 200));
}

/**
 * Pinta las coincidencias de una página y devuelve dónde quedó la que está
 * enfocada —medida contra el pliego— o null si en esta página no está.
 *
 * Se llama cada vez que una página monta su capa de texto y cada vez que
 * cambia la consulta. Es SÍNCRONA a propósito: entre un await y su vuelta la
 * página puede haberse ido de pantalla, y las marcas terminarían medidas
 * contra unos spans y pintadas sobre otros.
 */
function marcarPagina(contenedor, n) {
  const capa = contenedor.querySelector('.qr-marcas');
  if (!capa) return null;

  const divs = V.divsTexto.get(n);
  const hits = V.buscador?.porPagina.get(n);
  const indice = V.buscador?.indiceListo(n);
  if (!divs || !hits?.length || !indice) { limpiarMarcas(capa); return null; }

  /* La capa de texto y el índice tienen que ser la MISMA lista de fragmentos:
     el índice ubica una coincidencia por (fragmento, offset) y acá se busca ese
     fragmento por su número. Si alguna vez dejaran de coincidir —una versión de
     pdf.js que arme la capa distinto— no se resalta nada y se avisa. Es mucho
     mejor que pintar sobre las letras equivocadas: un resaltado corrido no se
     lee como un error, se lee como que el buscador encontró otra cosa. */
  if (divs.length !== indice.fragmentos) {
    console.warn(`[buscar] página ${n}: la capa tiene ${divs.length} fragmentos y el índice ${indice.fragmentos}`);
    limpiarMarcas(capa);
    return null;
  }

  const res = V.buscador.resultados[V.actual];
  const enfocada = res && res.pagina === n ? res.enPagina : -1;

  const memo = marcasPintadas.get(capa);
  if (memo && memo.hits === hits && memo.divs === divs && memo.escala === V.escalaHecha && capa.firstChild) {
    if (memo.actual !== enfocada) {
      for (const m of capa.children) m.classList.toggle('is-actual', Number(m.dataset.k) === enfocada);
      memo.actual = enfocada;
    }
    clearTimeout(apagados.get(capa));
    capa.classList.add('is-visible');
    return memo.focos.get(enfocada) ?? null;
  }

  const base = contenedor.getBoundingClientRect();
  const rango = document.createRange();
  const frag = document.createDocumentFragment();
  // Dónde cae cada coincidencia (su primer pedazo), para centrarla sin volver a medir.
  const focos = new Map();

  for (let k = 0; k < hits.length; k++) {
    const esta = k === enfocada;
    for (const seg of ubicar(indice, hits[k].desde, hits[k].hasta)) {
      const nodo = divs[seg.i]?.firstChild;
      if (!nodo || nodo.nodeType !== Node.TEXT_NODE) continue;
      rango.setStart(nodo, Math.min(seg.a, nodo.length));
      rango.setEnd(nodo, Math.min(seg.b, nodo.length));

      /* Un solo Range puede dar VARIOS rectángulos: una coincidencia que cruza
         el final del renglón se ve en dos pedazos, y cada pedazo es su marca. */
      for (const r of rango.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const marca = document.createElement('div');
        marca.className = esta ? 'qr-marca is-actual' : 'qr-marca';
        marca.dataset.k = k;
        marca.style.left = `${r.left - base.left}px`;
        marca.style.top = `${r.top - base.top}px`;
        marca.style.width = `${r.width}px`;
        marca.style.height = `${r.height}px`;
        frag.append(marca);
        /* Relativa al PLIEGO y no a la pantalla: así centrarEn() no necesita
           saber por dónde va el scroll, que mientras hay una animación suave en
           curso es un número que se mueve. */
        if (!focos.has(k)) focos.set(k, { top: r.top - base.top, alto: r.height });
      }
    }
  }

  clearTimeout(apagados.get(capa));
  capa.replaceChildren(frag);
  // Medidas de nuevo: el estirado que les puso reescalar() ya no hace falta.
  capa.style.transform = '';
  capa.classList.add('is-visible');
  marcasPintadas.set(capa, { hits, divs, escala: V.escalaHecha, actual: enfocada, focos });
  return focos.get(enfocada) ?? null;
}

/**
 * Vuelve a medir las marcas de todas las páginas que están en pantalla, y
 * devuelve dónde quedó la coincidencia enfocada — con su pliego — si cayó en
 * alguna de ellas.
 *
 * Que las repase TODAS y no solo la que interesa es el punto. La marca viva es
 * una sola en todo el documento, pero la anterior vive en OTRA hoja: repintando
 * únicamente la de destino, la de antes se queda encendida y quedan dos
 * "actuales" en pantalla, cada una diciendo que es la que el contador numera.
 */
function remarcarTodo() {
  if (!V.visor) return null;
  let foco = null;
  for (const el of V.visor.querySelectorAll('.qr-pliego')) {
    const n = Number(el.dataset.pagina);
    if (!V.divsTexto.has(n) && !el.querySelector('.qr-marcas')?.firstChild) continue;
    const pos = marcarPagina(el, n);
    if (pos) foco = { contenedor: el, pos };
  }
  return foco;
}

/**
 * Deja una coincidencia en el medio del visor. `pos` viene de marcarPagina() y
 * está medida contra el pliego.
 *
 * La cuenta sale del LAYOUT —el offsetTop del pliego más el alto de la marca
 * adentro de él— y no del scroll de ahora. Es la misma coordenada que usa irA(),
 * y la razón es que apretar "siguiente" dos veces seguidas encuentra la primera
 * animación todavía en vuelo: sumando el scrollTop de ese momento, el salto se
 * pasaba de largo justo lo que le faltaba a la animación anterior.
 */
function centrarEn(contenedor, pos) {
  if (!V.visor || !pos || !contenedor) return;
  const y = contenedor.offsetTop + pos.top - (V.visor.clientHeight - pos.alto) / 2;
  V.visor.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

/**
 * El primer resultado a partir de la página que estás mirando.
 *
 * El "siguiente" se cuenta desde acá y no desde el principio del documento:
 * buscando una palabra parado en la página 200, el primer Enter tiene que
 * llevar a la 201 y no a la 3. Es la diferencia entre un buscador que te
 * acompaña y uno que te manda de vuelta al principio cada vez.
 */
function resultadoDesdeAca(direccion) {
  const res = V.buscador?.resultados || [];
  if (!res.length) return -1;
  if (direccion > 0) {
    const i = res.findIndex((r) => r.pagina >= S.pagina);
    return i === -1 ? 0 : i;
  }
  for (let i = res.length - 1; i >= 0; i--) if (res[i].pagina <= S.pagina) return i;
  return res.length - 1;
}

/** Salta al resultado siguiente o al anterior. */
function navegarBusqueda(direccion) {
  const res = V.buscador?.resultados || [];
  if (!res.length) return;
  irAlResultado(V.actual < 0 ? resultadoDesdeAca(direccion) : V.actual + direccion);
}

/** Va al resultado número i de la lista, dando la vuelta por los extremos. */
function irAlResultado(i) {
  const res = V.buscador?.resultados || [];
  if (!res.length) return;

  V.actual = ((i % res.length) + res.length) % res.length;
  const r = res[V.actual];

  marcarLista();
  actualizarCuenta();

  const contenedor = V.visor?.querySelector(`.qr-pliego[data-pagina="${r.pagina}"]`);
  if (!contenedor) return;

  S.pagina = r.pagina;
  actualizarBarra();
  marcarMiniatura();

  /* Si la página ya tiene su capa de texto, dónde cae la coincidencia se sabe
     ahora mismo y se va derecho ahí. Si no, primero hay que acercarla para que
     la virtualización la monte, y el centrado fino lo termina montarTexto()
     cuando los spans existan — por eso queda anotada en V.pendiente. */
  const foco = remarcarTodo();
  if (foco) { V.pendiente = null; centrarEn(foco.contenedor, foco.pos); return; }

  V.pendiente = r.pagina;
  V.visor.scrollTo({ top: Math.max(0, contenedor.offsetTop - 24), behavior: 'auto' });
}

/* ── El panel de búsqueda ────────────────────────────────────────────────── */

function htmlBuscar() {
  /* Dos renglones, y los dos SIEMPRE puestos. La fila de abajo podría
     aparecer recién cuando hay resultados, pero entonces el campo se movería
     de lugar justo mientras se escribe en él — y un campo que se corre bajo el
     cursor es de las pocas cosas que se sienten rotas aunque estén animadas.
     Sin nada buscado dice "—" y los botones no sirven, que es la verdad.

     La cuenta nace VACÍA y la llena actualizarCuenta() con frase(): con el
     «—» en el HTML, el primer dato contaba como cambio (lector-26). */
  return `
    <div class="qr-buscar">
      <div class="ox-inputwrap qr-buscar__campo">
        ${Icons.svg('search')}
        <input class="ox-input" id="qr-buscar-campo" placeholder="Buscar en el documento"
               spellcheck="false" autocomplete="off" value="${esc(V.consulta)}">
      </div>
      <div class="qr-buscar__barra">
        <span class="ox-meta qr-buscar__cuenta" id="qr-buscar-cuenta"></span>
        <div class="ox-spacer"></div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-buscar-prev" disabled
                data-tip="Anterior" data-tip-key="Shift Enter"><i data-icon="chevronUp"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-buscar-next" disabled
                data-tip="Siguiente" data-tip-key="Enter"><i data-icon="chevronDown"></i></button>
      </div>
    </div>
    <div class="qr-buscar__lista" id="qr-buscar-lista"></div>`;
}

/** El "3 de 47" del campo, y los botones que dejan de servir sin resultados. */
function actualizarCuenta() {
  const cuenta = document.getElementById('qr-buscar-cuenta');
  const b = V.buscador;
  const hay = !!(b && V.consulta.trim() && b.total);

  if (cuenta) {
    /* Antes de pararse en una, el contador dice CUÁNTAS hay; parado en una,
       dice en cuál. "— de 30" era gramaticalmente correcto y se leía como un
       hueco, que es justo lo que un contador no puede parecer.

       Con frase(): de «2 de 47» a «3 de 47» cambia solo la cifra y destella en
       su lugar; de «47 coincidencias» a «1 de 47» cambia la frase y se releva.
       Con textContent las dos cosas eran un corte (lector-26). */
    const plural = b && b.total === 1 ? 'coincidencia' : 'coincidencias';
    frase(cuenta, !hay ? '—'
      : V.actual >= 0 ? `${V.actual + 1} de ${b.total}`
        : `${b.total} ${plural}`);
    cuenta.classList.toggle('is-vacia', !hay);
  }
  document.getElementById('qr-buscar-prev')?.toggleAttribute('disabled', !hay);
  document.getElementById('qr-buscar-next')?.toggleAttribute('disabled', !hay);
}

/* El texto de la pista, con su plural: «las 1 páginas» con un PDF de una
   hoja (ux-26). */
const textoPista = (paginas) => (paginas === 1
  ? 'Escribí para buscar en la página.'
  : `Escribí para buscar en las ${paginas} páginas.`);

/**
 * La lista de resultados, puesta al día POR CLAVE con reconcile().
 *
 * Antes era un innerHTML en cada letra y en cada repintado de la búsqueda en
 * curso (hasta seis por segundo): los estados se cortaban de un cuadro al
 * otro, pasado el tope cada aviso rearmaba 2000 filas iguales, y un clic que
 * empezaba sobre una fila reemplazada antes del pointerup se perdía
 * (lector-08). Ahora:
 * · cada resultado es `${pagina}:${enPagina}` y sigue siendo el MISMO nodo
 *   mientras siga en la lista;
 * · los vacíos son piezas con su texto en la clave (`vacio:sin:<consulta>`),
 *   así «sin coincidencias» para dos consultas distintas se relevan;
 * · lo que cambia seguido (el «Leyendo la página N…», el pie con el avance)
 *   es una pieza de clave fija cuyo texto va por frase(): una clave con el
 *   número se iría y volvería en cada aviso;
 * · si no cambió ni la consulta, ni la cantidad, ni si hay pie, las filas no
 *   se tocan: solo el pie.
 */
function pintarResultados() {
  const lista = document.getElementById('qr-buscar-lista');
  if (!lista) return;
  actualizarCuenta();

  const b = V.buscador;
  const paginas = S.doc?.paginas ?? 0;
  const consulta = V.consulta.trim();
  const textos = new Map();     // clave → lo que va por frase() adentro de la pieza

  let items;
  if (!consulta) {
    items = [{ key: 'vacio:pista', html: `
      <div class="qr-panel__vacio">
        ${Icons.svg('search')}
        <span class="ox-meta">${textoPista(paginas)}</span>
        <span class="ox-meta qr-buscar__nota">Encuentra el texto de verdad del PDF, el mismo que se
        puede seleccionar con el mouse. Si el archivo es un escaneo —una foto de la hoja— no hay
        texto que buscar.</span>
      </div>` }];
  } else if (!b?.resultados.length) {
    /* Mientras recorre dice por dónde va. Sin esto, buscar en un tratado de
       mil páginas se ve igual que buscar algo que no está: vacío y quieto. */
    if (b?.terminada) {
      items = [{ key: `vacio:sin:${consulta}`, html: `
        <div class="qr-panel__vacio">
          ${Icons.svg('search')}
          <span class="ox-meta">Sin coincidencias para «${esc(consulta)}».</span>
        </div>` }];
    } else {
      items = [{ key: 'vacio:leyendo', html: `
        <div class="qr-panel__vacio">
          ${Icons.svg('clock')}
          <span class="ox-meta" data-frase></span>
        </div>` }];
      textos.set('vacio:leyendo', `Leyendo la página ${b?.leidas ?? 0} de ${paginas}…`);
    }
  } else {
    /* Los dos pies dicen lo que la lista NO muestra: que todavía falta
       recorrer, o que hay más coincidencias de las que entraron. Una lista
       recortada en silencio se lee como una lista completa. */
    const pie = !b.terminada
      ? `Buscando… ${b.leidas} de ${paginas} páginas`
      : b.recortada ? `Se listan ${b.resultados.length} de ${b.total}. Las demás se resaltan igual en la hoja.` : '';

    const memo = lista.__pintada;
    const igual = memo && memo.buscador === b && memo.consulta === consulta
      && memo.n === b.resultados.length && memo.conPie === !!pie;
    if (igual) {
      const el = lista.querySelector(':scope > [data-key="pie"]');
      if (el && pie) frase(el, esc(pie));
      return;
    }

    items = b.resultados.map((r, i) => ({ key: `${r.pagina}:${r.enPagina}`, html: `
      <button class="qr-hit${i === V.actual ? ' is-actual' : ''}" data-i="${i}">
        <span class="qr-hit__texto">${esc(r.antes)}<mark>${esc(r.medio)}</mark>${esc(r.despues)}</span>
        <span class="qr-hit__pag ox-num">${r.pagina}</span>
      </button>` }));
    if (pie) {
      items.push({ key: 'pie', html: '<div class="qr-buscar__pie ox-meta"></div>' });
      textos.set('pie', pie);
    }
    lista.__pintada = { buscador: b, consulta, n: b.resultados.length, conPie: !!pie };
  }
  if (!b?.resultados.length) lista.__pintada = null;

  reconcile(lista, items);
  for (const [clave, texto] of textos) {
    const pieza = lista.querySelector(`:scope > [data-key="${CSS.escape(clave)}"]:not([data-state=closing])`);
    const destino = pieza?.matches('[data-frase]') || clave === 'pie' ? pieza : pieza?.querySelector('[data-frase]');
    if (destino) frase(destino, esc(texto));
  }
}

/** Deja marcado en la lista el resultado en el que estás, y lo trae a la vista. */
function marcarLista({ suave = true } = {}) {
  const lista = document.getElementById('qr-buscar-lista');
  if (!lista) return;
  let fila = null;
  // Las que reconcile() deja saliendo no cuentan: siguen en el DOM un rato.
  for (const f of lista.querySelectorAll(':scope > .qr-hit:not([data-state=closing])')) {
    const es = Number(f.dataset.i) === V.actual;
    f.classList.toggle('is-actual', es);
    if (es) fila = f;
  }
  if (fila) traerALaVista(lista, fila, { suave });
}

/**
 * Lanza una búsqueda.
 *
 * No salta a ningún resultado: resalta y se queda quieto. Saltar mientras se
 * escribe es lo que hace el buscador del navegador, y adentro de un documento
 * de papel se siente distinto — la hoja se te va de abajo del ojo cada vez que
 * agregás una letra. Acá el salto lo pedís vos, con Enter o con las flechas, y
 * mientras tanto ves dónde está lo que buscás sin perder dónde estabas.
 */
async function lanzarBusqueda(consulta) {
  if (!S.doc) return;
  V.consulta = consulta;
  V.actual = -1;
  V.pendiente = null;

  // Al cambiar de pestaña, el buscador de antes es el de otro documento.
  if (V.buscador?.doc !== S.doc) V.buscador = buscadorDe(S.doc);

  let pedido = false;
  let ultimo = 0;
  const repintar = () => {
    if (pedido) return;
    pedido = true;
    /* Seis repintados por segundo como techo, y no uno por aviso. En un tratado
       con miles de coincidencias, alAvanzar() llega decenas de veces por
       segundo y cada repintado rearma una lista de cientos de filas: sin freno,
       la app se sentiría trabada justo mientras trabaja. La cuenta va contra el
       último pintado de verdad, así que si el documento es corto y termina
       antes, no se pierde nada — abajo se pinta igual al salir. */
    setTimeout(() => {
      pedido = false;
      ultimo = performance.now();
      if (V.consulta !== consulta) return;
      pintarResultados();
      remarcarTodo();
    }, Math.max(0, 160 - (performance.now() - ultimo)));
  };

  await V.buscador.buscar(consulta, { alAvanzar: repintar });

  // Mientras leía llegó otra consulta: lo que terminó ya no es lo que se ve.
  if (V.consulta !== consulta) return;
  pintarResultados();
  remarcarTodo();
}

function cablearBuscar() {
  const campo = document.getElementById('qr-buscar-campo');
  let reloj = null;

  campo?.addEventListener('input', () => {
    clearTimeout(reloj);
    /* Un respiro antes de salir a leer el documento: sin él, escribir
       "compensación" son doce recorridas completas, once de ellas tiradas. */
    reloj = setTimeout(() => lanzarBusqueda(campo.value), 180);
  });

  campo?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      /* Con texto, Escape limpia; ya limpio, suelta el campo. Dos escapes
         seguidos te devuelven al documento sin tocar el mouse. */
      if (campo.value) { campo.value = ''; clearTimeout(reloj); lanzarBusqueda(''); }
      else { campo.blur(); devolverAlVisor(); }
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(reloj);
    // Enter sobre una consulta ya buscada avanza; sobre una recién escrita, busca.
    if (campo.value !== V.consulta) lanzarBusqueda(campo.value);
    else navegarBusqueda(e.shiftKey ? -1 : 1);
  });

  document.getElementById('qr-buscar-prev')?.addEventListener('click', () => navegarBusqueda(-1));
  document.getElementById('qr-buscar-next')?.addEventListener('click', () => navegarBusqueda(1));

  document.getElementById('qr-buscar-lista')?.addEventListener('click', (e) => {
    const fila = e.target.closest('.qr-hit');
    if (fila) irAlResultado(Number(fila.dataset.i));
  });
}

/** Ctrl+F: abre el panel en Buscar y pone el cursor en el campo. */
function abrirBusqueda() {
  if (!V.panelAbierto) document.getElementById('qr-toggle-panel')?.click();
  if (V.panel !== 'buscar') cambiarPanel('buscar');
  const campo = document.getElementById('qr-buscar-campo');
  campo?.focus();
  campo?.select();
}

/** Al cambiar de documento la búsqueda arranca de cero. El índice no: es del PDF. */
function reiniciarBusqueda() {
  V.buscador?.cancelar();
  V.buscador = null;
  V.consulta = '';
  V.actual = -1;
  V.pendiente = null;
}

/* ── Tinta ───────────────────────────────────────────────────────────────── */

function alternarTinta(forzar = null) {
  V.tintaActiva = forzar ?? !V.tintaActiva;
  document.getElementById('qr-tinta-toggle')?.classList.toggle('is-on', V.tintaActiva);
  const barra = document.getElementById('qr-tintabarra');
  /* Se arma ANTES de prenderse: así se despliega ya con su alto final, en vez
     de crecer vacía y volver a crecer al llenarse. */
  if (V.tintaActiva) armarBarraTinta();
  if (barra) barra.hidden = !V.tintaActiva;
  /* La barra se despliega; los colores de adentro, no: nacen con su ancho.
     Hasta recién estaban en una caja con display:none, y su primer estilo
     disparaba el @starting-style del pliegue (crecían de 0 a lo ancho
     mientras la barra crecía de alto). */
  if (V.tintaActiva) asentarPlegables(document.getElementById('qr-colores-pliegue'));
  /* Mientras se anota, el canvas de tinta captura el puntero. La clase va en
     el visor y no en cada pliego para que un solo toggle alcance. */
  V.visor?.classList.toggle('is-anotando', V.tintaActiva);
  /* Apagada, el canvas deja de recibir el puntero y no llega ningún
     pointerleave: el anillo de la punta (tinta-21) se quedaría pintado. */
  if (!V.tintaActiva) for (const ed of V.editores.values()) ed.reposo?.();
  if (!V.tintaActiva && V.navegando) salirNav();
}

const textoAncho = (v) => `${fmtDec(v, 1)} pt`;
const textoCuenta = (n) => (n ? `${n} ${n === 1 ? 'trazo' : 'trazos'}` : 'sin trazos');

/**
 * Arma la barra de tinta, UNA vez por montaje de la vista. Después, elegir
 * herramienta, color o tamaño la pone al día en su lugar
 * (sincronizarBarraTinta).
 *
 * Antes cada clic (y cada tecla 1 a 4) rehacía la barra entera con innerHTML:
 * el anillo del seleccionado saltaba de un botón al otro en vez de pasar por
 * su transición, el grupo de colores aparecía y desaparecía de golpe al ir y
 * volver del borrador y corría todo lo de la derecha unos 170 px, el rótulo y
 * el slider cambiaban en seco, y el botón con foco se perdía (lector-12,
 * tinta-08).
 *
 * Nace con los valores ya escritos (rótulo, eco y cuenta): así el primer
 * llenado no cuenta como cambio para swap(), valor() y frase(), y nada
 * destella al montar.
 */
function armarBarraTinta() {
  const barra = document.getElementById('qr-tintabarra');
  if (!barra || !S.tinta) return;
  /* Ya armada (se apagó y se vuelve a prender en el mismo montaje): se pone
     al día también la cuenta y lo que se puede deshacer, que con la barra
     apagada el evento 'tinta' no toca. */
  if (barra.__armada) { sincronizarBarraTinta(); actualizarBarraTinta(); return; }
  barra.__armada = true;

  const h = herramientaActual();
  const esBorrador = V.herramienta === 'borrador';

  barra.innerHTML = `
    <div class="qr-tintabarra__grupo">
      ${Object.entries(HERRAMIENTAS).map(([id, t], i) => `
        <button class="ox-iconbtn ox-iconbtn--sm qr-tool${V.herramienta === id ? ' is-on' : ''}"
                data-tinta-tool="${id}" data-tip="${t.etiqueta}" data-tip-key="${i + 1}"><i data-icon="${t.icono}"></i></button>`).join('')}
    </div>

    <div class="ox-vr"></div>

    <!-- Los colores no tienen sentido con el borrador: se pliegan a lo ancho
         (y lo de la derecha los acompaña) en vez de desaparecer de golpe. -->
    <div class="qr-colores-pliegue ox-plegable--ancho" id="qr-colores-pliegue"${esBorrador ? ' hidden' : ''}>
      <div class="qr-tintabarra__grupo qr-colores">
        ${COLORES.map((c) => `
          <button class="qr-color${h.color === c.hex ? ' is-on' : ''}" data-tinta-color="${c.hex}"
                  style="--tinta:${c.hex}" data-tip="${c.nombre}"></button>`).join('')}
      </div>
      <div class="ox-vr"></div>
    </div>

    <div class="qr-tintabarra__grupo qr-grosor">
      <span class="ox-meta qr-grosor__rotulo" id="qr-tinta-rotulo">${esBorrador ? 'Tamaño' : 'Grosor'}</span>
      <input class="ox-slider" id="qr-tinta-ancho" type="range" step="0.5">
      <span class="ox-chip ox-chip--mono" id="qr-tinta-ancho-eco">${textoAncho(h.ancho)}</span>
    </div>

    <div class="ox-spacer"></div>

    <div class="qr-tintabarra__grupo">
      <button class="ox-iconbtn ox-iconbtn--sm" id="qr-tinta-deshacer"
              data-tip="Deshacer" data-tip-key="Ctrl Z"><i data-icon="undo"></i></button>
      <button class="ox-iconbtn ox-iconbtn--sm" id="qr-tinta-rehacer"
              data-tip="Rehacer" data-tip-key="Ctrl Y"><i data-icon="redo"></i></button>
      <!-- Neutro, no rojo: el peligro se dice en el cartel que confirma, que es
           donde de verdad se decide. Un botón rojo fijo en la barra le gastaría
           al rojo su único trabajo, que es avisar cuando algo pasa. -->
      <button class="ox-iconbtn ox-iconbtn--sm" id="qr-tinta-limpiar"
              data-tip="Borrar toda la tinta"><i data-icon="trash"></i></button>
      <button class="ox-iconbtn ox-iconbtn--sm" id="qr-tinta-menu"
              data-tip="Más opciones"><i data-icon="more"></i></button>
    </div>

    <span class="ox-chip qr-tinta-cuenta${S.tinta.cuenta ? '' : ' is-vacia'}" id="qr-tinta-cuenta">${textoCuenta(S.tinta.cuenta)}</span>`;

  Icons.mount(barra);
  // Las memorias de swap() y valor() arrancan en lo que ya dice: no es un cambio.
  swap(document.getElementById('qr-tinta-rotulo'), esBorrador ? 'Tamaño' : 'Grosor');
  valor(document.getElementById('qr-tinta-ancho-eco'), textoAncho(h.ancho));
  /* El pliegue de los colores nace en su lugar: si la barra ya está a la
     vista, desplegarse desde 0 sería un movimiento que nadie pidió. */
  asentarPlegables(document.getElementById('qr-colores-pliegue'));
  cablearBarraTinta();
  sincronizarBarraTinta();
  actualizarBarraTinta();
}

/** Pone la barra al día con la herramienta, el color y el tamaño, sin rehacerla. */
function sincronizarBarraTinta() {
  const barra = document.getElementById('qr-tintabarra');
  if (!barra?.__armada) return;
  const h = herramientaActual();
  const esBorrador = V.herramienta === 'borrador';

  // Los encendidos se mueven con su transición (--tr-color, el anillo del color).
  barra.querySelectorAll('[data-tinta-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tintaTool === V.herramienta));
  barra.querySelectorAll('[data-tinta-color]').forEach((b) => b.classList.toggle('is-on', b.dataset.tintaColor === h.color));
  const pliegue = document.getElementById('qr-colores-pliegue');
  if (pliegue) pliegue.hidden = esBorrador;

  // «Grosor» y «Tamaño» son dos palabras: relevo, no un cambio en seco.
  swap(document.getElementById('qr-tinta-rotulo'), esBorrador ? 'Tamaño' : 'Grosor', { relevo: true });

  const slider = document.getElementById('qr-tinta-ancho');
  if (slider) {
    const [min, max] = esBorrador ? [6, 48] : [0.5, 24];
    slider.min = min;
    slider.max = max;
    slider.value = h.ancho;
    slider.style.setProperty('--ox-pct', `${porcentajeAncho(h.ancho, esBorrador)}%`);
  }
  valor(document.getElementById('qr-tinta-ancho-eco'), textoAncho(h.ancho));
}

const porcentajeAncho = (v, esBorrador) => {
  const [min, max] = esBorrador ? [6, 48] : [0.5, 24];
  return (((v - min) / (max - min)) * 100).toFixed(1);
};

function cablearBarraTinta() {
  const barra = document.getElementById('qr-tintabarra');
  if (!barra) return;

  barra.querySelectorAll('[data-tinta-tool]').forEach((b) => {
    b.addEventListener('click', () => { V.herramienta = b.dataset.tintaTool; sincronizarBarraTinta(); });
  });

  barra.querySelectorAll('[data-tinta-color]').forEach((b) => {
    b.addEventListener('click', () => {
      V.colores[V.herramienta] = b.dataset.tintaColor;
      sincronizarBarraTinta();
    });
  });

  const slider = document.getElementById('qr-tinta-ancho');
  slider?.addEventListener('input', () => {
    const v = +slider.value;
    V.anchos[V.herramienta] = v;
    slider.style.setProperty('--ox-pct', `${porcentajeAncho(v, V.herramienta === 'borrador')}%`);
    // Con coma, como el resto de la app (tinta-25, ux-25), y en su lugar.
    valor(document.getElementById('qr-tinta-ancho-eco'), textoAncho(v));
  });

  document.getElementById('qr-tinta-deshacer')?.addEventListener('click', deshacerTinta);
  document.getElementById('qr-tinta-rehacer')?.addEventListener('click', rehacerTinta);

  document.getElementById('qr-tinta-limpiar')?.addEventListener('click', borrarTodaLaTinta);

  document.getElementById('qr-tinta-menu')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [
      {
        label: `Borrar la tinta de la página ${S.pagina}`,
        icon: 'borrador',
        disabled: !S.tinta.trazos(S.pagina).length,
        onSelect: borrarTintaDeLaPagina,
      },
      { sep: true },
      {
        /* La misma acción que el botón de al lado, a propósito: el botón es
           para encontrarla, el menú para el que ya sabe que está acá. Los dos
           llaman a la MISMA función — dos entradas está bien, dos copias de la
           lógica es como se desincronizan. */
        label: 'Borrar toda la tinta del documento',
        icon: 'trash',
        danger: true,
        disabled: S.tinta.vacia,
        onSelect: borrarTodaLaTinta,
      },
    ], { align: 'end' });
  });
}

/** Borra lo anotado en la página que estás mirando. Se deshace con Ctrl+Z. */
function borrarTintaDeLaPagina() {
  const n = S.pagina;
  const habia = S.tinta?.trazos(n) || [];
  if (!S.tinta?.limpiarPagina(n)) return;
  /* Se funde en t-2 en vez de irse de un cuadro al otro mientras el menú
     todavía se está yendo (lector-33, tinta-13). */
  V.editores.get(n)?.fundir({ salen: habia });
  actualizarBarraTinta();
}

/**
 * Borra la tinta del documento entero, con confirmación.
 *
 * Pregunta y no se deshace: `borrarTodo()` vacía también el historial y borra
 * el archivo guardado, así que un Ctrl+Z después no la trae de vuelta. Por eso
 * el cartel dice CUÁNTO se va — "¿estás seguro?" a secas no le da a nadie con
 * qué decidir.
 */
async function borrarTodaLaTinta() {
  if (!S.tinta || S.tinta.vacia) return;

  const trazos = S.tinta.cuenta;
  const paginas = S.tinta.paginasConTinta().length;
  const ok = await Modal.confirm({
    title: '¿Borrar toda la tinta?',
    sub: `Se van ${trazos} ${trazos === 1 ? 'trazo' : 'trazos'} de ${paginas} ${paginas === 1 ? 'página' : 'páginas'}, y esto no se deshace. El PDF no se toca — nunca se tocó.`,
    confirmLabel: 'Borrar todo',
    danger: true,
  });
  if (!ok) return;

  /* Lo que tenía cada hoja montada, antes de borrar: es lo que se funde. Al
     confirmar, las anotaciones a la vista se iban de golpe mientras el cartel
     todavía se esfumaba (lector-33). */
  const capa = S.tinta;
  const habia = new Map([...V.editores.keys()].map((n) => [n, capa.trazos(n)]));
  await capa.borrarTodo();
  if (S.tinta !== capa) return;
  for (const [n, ed] of V.editores) ed.fundir({ salen: habia.get(n) || [] });
  actualizarBarraTinta();
  Toast.show({ title: 'Tinta borrada', icon: 'borrador' });
}

function actualizarBarraTinta() {
  if (!S.tinta) return;
  const cuenta = document.getElementById('qr-tinta-cuenta');
  if (cuenta) {
    const n = S.tinta.cuenta;
    /* frase(): de «3 trazos» a «4 trazos» destella la cifra en su lugar; de
       «sin trazos» a «1 trazo», relevo. Con textContent cambiaba de golpe, y
       con la goma varias veces seguidas (tinta-18). */
    frase(cuenta, textoCuenta(n));
    cuenta.classList.toggle('is-vacia', !n);
  }
  document.getElementById('qr-tinta-deshacer')?.toggleAttribute('disabled', !S.tinta.historial.length);
  document.getElementById('qr-tinta-rehacer')?.toggleAttribute('disabled', !S.tinta.deshechos.length);
  // Sin nada dibujado no hay nada que borrar, y un botón que no hace nada miente.
  document.getElementById('qr-tinta-limpiar')?.toggleAttribute('disabled', S.tinta.vacia);
}

/* deshacer() y rehacer() devuelven la operación con su página (tinta-12): se
   redibuja SOLO ese editor, y no todos los montados, y lo que cambia se
   funde en vez de aparecer o desaparecer de un cuadro al otro (tinta-13). */
function deshacerTinta() {
  const op = S.tinta?.deshacer();
  if (!op) return;
  fundirOperacion(op, false);
  actualizarBarraTinta();
  avisarSiNoSeVe(op, false);
}

function rehacerTinta() {
  const op = S.tinta?.rehacer();
  if (!op) return;
  fundirOperacion(op, true);
  actualizarBarraTinta();
  avisarSiNoSeVe(op, true);
}

/* Qué se va y qué llega con cada operación del historial. La goma es la
   rara: deshacerla devuelve los trazos enteros donde hoy hay pedazos, y los
   pedazos van `debajo` para que lo único que se funda sea el tramo borrado
   (ver fundir() en editor.js). */
function fundirOperacion(op, rehace) {
  const ed = V.editores.get(op.pagina);
  if (!ed?.vivo) return;
  if (op.tipo === 'recortar') {
    const originales = op.cortes.map((c) => c.original);
    const pedazos = op.cortes.flatMap((c) => c.piezas);
    ed.fundir(rehace ? { salen: originales, debajo: pedazos } : { entran: originales, debajo: pedazos });
    return;
  }
  // Deshacer un trazo lo saca; deshacer un borrado lo trae. Rehacer, al revés.
  const sale = (op.tipo === 'agregar') !== rehace;
  ed.fundir(sale ? { salen: op.trazos } : { entran: op.trazos });
}

/* Qué hizo el Ctrl+Z, dicho por el tipo de la operación. Decía «Se deshizo
   un trazo» para todo, también al devolver la tinta de una página entera,
   que son muchos trazos. */
function textoHistorial(op, rehace) {
  if (op.tipo === 'recortar') return rehace ? 'Se rehízo la goma' : 'Se deshizo la goma';
  if (op.tipo === 'borrar') {
    if (rehace) return 'Se volvió a borrar la tinta';
    const n = op.trazos?.length || 0;
    return n === 1 ? 'Volvió un trazo' : `Volvieron ${n} trazos`;
  }
  return rehace ? 'Se rehízo un trazo' : 'Se deshizo un trazo';
}

/** ¿Algo de esa hoja está dentro del visor ahora? */
function seVe(n) {
  const el = V.visor?.querySelector(`.qr-pliego[data-pagina="${n}"]`);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const v = V.visor.getBoundingClientRect();
  return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
}

/* El historial de la tinta es del documento, no de la página que se mira: un
   Ctrl+Z puede sacar un trazo de la página 30 mientras leés la 5. Sin aviso
   no se entera nadie, y ese trazo se guarda borrado a los 900 ms (decisión de
   Fran: el Toast, junto con limitar Ctrl+Z a la tinta prendida). */
function avisarSiNoSeVe(op, rehace) {
  const pagina = op?.pagina;
  if (!pagina || seVe(pagina)) return;
  Toast.show({ title: textoHistorial(op, rehace), text: `En la página ${pagina}.`, icon: rehace ? 'redo' : 'undo' });
}

/* ── Navegar con el puck ─────────────────────────────────────────────────────
   Mientras se anota, el canvas de tinta se queda con el puntero y el lápiz no
   puede ni scrollear ni acercarse. Con la barra espaciadora apretada aparece
   el disco de puck.js bajo el puntero: apoyar en el núcleo y arrastrar hace
   zoom, apoyar en el anillo —o en cualquier otro lado del visor— desplaza.
   Es el gesto de Scrawl, para no soltar el lápiz.

   El visor escucha los eventos, no el disco (que es puro afiche): con la
   clase is-navegando los canvas de tinta dejan pasar el puntero y el
   pointerdown cae acá. Soltar la barra a mitad de un arrastre no lo corta:
   el gesto empezado manda, y el disco se queda hasta que el lápiz se levante.

   ── El zoom en vivo ───────────────────────────────────────────────────────
   Reescalar de verdad es volver a pedirle a pdf.js cada página, y hacerlo
   por frame mientras se arrastra sería imposible. Mientras dura el gesto la
   pista entera se escala con un transform con origen en el centro del disco
   —lo que está debajo del puck es lo que no se mueve—, y al soltar se hace el
   reescalado de verdad y se corrige el scroll para que ese mismo punto del
   papel siga bajo el disco. Las hojas se ven borrosas un instante al llegar,
   igual que con Ctrl+rueda: es el bitmap viejo estirado hasta que se
   nitidiza. */

/* Cuántos píxeles de arrastre duplican la escala. Es el número de Scrawl:
   con 180, el núcleo entero (48 px) cubre un 20 % de zoom, que es el rango en
   el que uno ajusta, y cruzar el visor de arriba abajo lleva de ver la hoja
   entera a mirar la letra. */
const ZOOM_ARRASTRE_PX = 180;

/** Dónde cayó un evento, en px del visor (0,0 = su esquina, sin el scroll). */
function enVisor(e) {
  const r = V.visor.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function cablearNavegacion() {
  const ancla = document.getElementById('qr-puck-ancla');
  if (!ancla || !V.visor) return;
  const visor = V.visor;

  V.puck = montarPuck(ancla);
  V.navegando = false;
  V.gesto = null;
  V.puntero = null;

  visor.addEventListener('pointermove', (e) => {
    const pt = enVisor(e);
    V.puntero = pt;

    const g = V.gesto;
    if (!g) {
      if (V.navegando) { V.puck.hover(V.puck.zonaEn(pt.x, pt.y)); cursorNav(); }
      return;
    }
    if (e.pointerId !== g.puntero) return;

    if (g.tipo === 'pan') {
      visor.scrollLeft = g.sl - (pt.x - g.x0);
      visor.scrollTop = g.st - (pt.y - g.y0);
      return;
    }
    /* Función de cuánto se movió la mano desde que apoyó, no acumulado frame
       a frame: volver al punto de partida devuelve la escala exacta. El tope
       es el mismo de zoomA(), aplicado acá para que la vista previa no
       prometa un zoom que después no se cumple. */
    const objetivo = Math.max(0.05, Math.min(8, g.escala * Math.pow(2, (g.y0 - pt.y) / ZOOM_ARRASTRE_PX)));
    g.k = objetivo / g.escala;
    zoomVivo(g);
  });
  visor.addEventListener('pointerleave', () => {
    V.puntero = null;
    if (V.navegando && !V.gesto) V.puck.hover(null);
    cursorNav();
  });

  visor.addEventListener('pointerdown', (e) => {
    if (!V.navegando || V.gesto || e.button !== 0) return;
    /* Sin esto el navegador arranca una selección de texto o le da el foco a
       lo que haya abajo, y el arrastre se ve peleando con eso. */
    e.preventDefault();
    const pt = enVisor(e);
    visor.setPointerCapture(e.pointerId);

    if (V.puck.zonaEn(pt.x, pt.y) === 'nucleo') {
      // el zoom pivotea sobre el centro del disco, no sobre donde apoyaste: el
      // puck es la lupa, y lo que está abajo del disco es lo que no se mueve
      V.gesto = { tipo: 'zoom', puntero: e.pointerId, y0: pt.y, escala: escalaActual(), k: 1, ax: V.puck.x, ay: V.puck.y };
      V.puck.activo('nucleo');
      prepararZoomVivo(V.gesto);
    } else {
      V.gesto = { tipo: 'pan', puntero: e.pointerId, x0: pt.x, y0: pt.y, sl: visor.scrollLeft, st: visor.scrollTop };
      V.puck.activo('anillo');
    }
    cursorNav();
  });

  const soltar = (e) => {
    const g = V.gesto;
    if (!g || e.pointerId !== g.puntero) return;
    V.gesto = null;
    V.puck.activo(null);
    if (g.tipo === 'zoom') asentarZoom(g);

    if (V.navegando) V.puck.hover(V.puntero ? V.puck.zonaEn(V.puntero.x, V.puntero.y) : null);
    /* La barra se soltó a mitad del arrastre y el gesto se dejó terminar
       igual: recién ahora se apaga el modo navegación. */
    else salirNav();
    cursorNav();
  };
  visor.addEventListener('pointerup', soltar);
  visor.addEventListener('pointercancel', soltar);

  /* Soltar la barra. Va en window y no en el visor: el foco puede estar en
     cualquier botón de la barra de tinta. Y se previene el default por lo
     mismo: un keyup de espacio sobre un botón con foco le dispara el click, y
     el último botón que tocaste fue, casi seguro, el lapicito. */
  const alSoltarTecla = (e) => {
    if (e.key !== ' ' || !V.tintaActiva) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    /* Si la barra no abrió el puck (el foco estaba en un botón al que se llegó
       con Tab, o en un cartel), el keyup es de ese botón: prevenirlo le
       comería el clic que Espacio le da al soltarse. */
    if (!V.navegando) return;
    e.preventDefault();
    V.navegando = false;
    if (!V.gesto) salirNav();
  };
  // Si la ventana pierde el foco con la barra apretada, el keyup nunca llega.
  const alPerderFoco = () => { if (V.navegando && !V.gesto) salirNav(); };
  window.addEventListener('keyup', alSoltarTecla);
  window.addEventListener('blur', alPerderFoco);

  Router.onLeave(() => {
    window.removeEventListener('keyup', alSoltarTecla);
    window.removeEventListener('blur', alPerderFoco);
    V.puck = null;
    V.navegando = false;
    V.gesto = null;
    V.puntero = null;
  });
}

function entrarNav() {
  if (!V.puck || !V.visor) return;
  V.navegando = true;
  /* La capa del disco se calza sobre el visor: el panel lateral puede estar
     plegado o no, y el borde izquierdo del visor se mueve con eso. */
  document.getElementById('qr-puck-ancla').style.left = `${V.visor.offsetLeft}px`;
  // sin puntero sobre el visor (la barra se apretó con el mouse afuera) el
  // disco va al centro: sigue sirviendo, y ahí el zoom pivotea en el medio
  const x = V.puntero ? V.puntero.x : V.visor.clientWidth / 2;
  const y = V.puntero ? V.puntero.y : V.visor.clientHeight / 2;
  V.puck.mostrar(x, y);
  V.puck.hover(V.puck.zonaEn(x, y));
  V.visor.classList.add('is-navegando');
  cursorNav();
}

function salirNav() {
  V.navegando = false;
  V.puck?.ocultar();
  V.visor?.classList.remove('is-navegando');
  if (V.visor) delete V.visor.dataset.cursor;
}

/* El cursor mientras se navega, como en Scrawl. En el anillo —y en el resto
   del visor, que también desplaza— es la mano: abierta mientras apuntás,
   cerrada mientras arrastrás, que ahí la mano es toda la señal de que la hoja
   se mueve. Sobre el núcleo y durante el zoom desaparece: el disco ya ilumina
   la zona bajo el puntero, y la flecha del sistema no agrega ubicación y
   encima tapa la lupa, que es lo que dice que ahí se hace zoom. El CSS lo
   lee de data-cursor (ver .qr-visor.is-navegando en lector.css). */
function cursorNav() {
  if (!V.visor?.classList.contains('is-navegando')) return;
  const g = V.gesto;
  const sobreNucleo = !g && V.puntero && V.puck?.zonaEn(V.puntero.x, V.puntero.y) === 'nucleo';
  V.visor.dataset.cursor = g?.tipo === 'zoom' || sobreNucleo ? 'none'
    : g?.tipo === 'pan' ? 'grabbing' : 'grab';
}

function prepararZoomVivo(g) {
  const pista = V.visor.querySelector('.qr-pista');
  g.pista = pista;
  pista.classList.add('is-escalando');
  /* A 'fijo' desde el primer frame, no al soltar. La pista escalada agranda el
     área de scroll y le hace aparecer la barra horizontal al visor; eso lo
     achica, el ResizeObserver lo ve, y en modo 'ancho' respondería con un
     reescalar() en mitad del gesto que salta al tope de la página. Con la
     misma escala en 'fijo' no cambia nada a la vista y el observador no
     tiene nada que hacer. Si el gesto termina en nada, se devuelve el modo. */
  g.modo = S.modoZoom;
  S.modoZoom = 'fijo';
  S.zoom = g.escala;
  // el origen va en coordenadas de la pista, que es el visor más el scroll
  pista.style.transformOrigin = `${g.ax + V.visor.scrollLeft}px ${g.ay + V.visor.scrollTop}px`;
}

function zoomVivo(g) {
  g.pista.style.transform = `scale(${g.k})`;
  // el porcentaje de la barra sigue al gesto: es el único número que importa.
  // Por valor(), como en los pasos: ver actualizarBarra().
  valor(document.getElementById('qr-zoom-valor'), textoZoom(g.escala * g.k));
}

/** Al soltar el núcleo (o al parar la rueda): el reescalado de verdad, con el
    mismo punto del papel bajo el disco. */
function asentarZoom(g) {
  /* Qué punto del papel hay bajo el disco, con la pista todavía escalada: es
     lo que se ve, y lo que tiene que seguir bajo el disco cuando las hojas
     cambien de tamaño (ver fotoAncla). */
  const ancla = V.visor ? fotoAncla(g.ax, g.ay) : null;
  g.pista.classList.remove('is-escalando');
  g.pista.style.transform = '';
  g.pista.style.transformOrigin = '';

  if (Math.abs(g.k - 1) < 0.01) { S.modoZoom = g.modo; actualizarBarra(); return; }
  zoomA(g.escala * g.k, { ancla });
}

/* ── Zoom ────────────────────────────────────────────────────────────────── */

/* El ancla por defecto es el centro del visor: los botones, los atajos, el
   menú y los ajustes no tienen un puntero que respetar (lector-03). */
function zoomA(escala, { modo = 'fijo', ancla } = {}) {
  if (V.rueda) terminarRueda();
  S.modoZoom = modo;
  if (modo === 'fijo') S.zoom = Math.max(0.05, Math.min(8, escala));
  reescalar({ ancla });
}

function zoomPaso(direccion) {
  const actual = escalaActual();
  const lista = direccion > 0 ? ZOOMS : [...ZOOMS].reverse();
  const siguiente = lista.find((z) => (direccion > 0 ? z > actual + 0.001 : z < actual - 0.001));
  zoomA(siguiente ?? actual);
}

/* ── Ctrl+rueda: zoom continuo ────────────────────────────────────────────────
   Cada evento era un paso entero de ZOOMS y un reescalado completo: un
   pellizco de touchpad o una rueda libre mandan decenas de eventos chicos por
   segundo, y pasaban de 100 % a 600 % de un tirón mientras la app rehacía
   todo en cada paso (lector-19; Fran eligió el continuo). Ahora la rueda hace
   lo mismo que el núcleo del puck: la pista se escala en vivo con origen en
   el puntero, `deltaY` decide cuánto (100 px de una muesca son un poco menos
   que un paso de ZOOMS), y el reescalado de verdad va 150 ms después del
   último evento, con el punto del papel bajo el puntero en su lugar. */
const RUEDA_DUPLICA = 300;    // px de deltaY que duplican (o parten) la escala

function zoomRueda(e) {
  if (V.gesto || V.giro) return;
  const pt = enVisor(e);
  let g = V.rueda;
  if (!g) {
    g = { escala: escalaActual(), k: 1, ax: pt.x, ay: pt.y };
    V.rueda = g;
    prepararZoomVivo(g);
  }
  // Líneas o páginas (deltaMode 1 y 2) en píxeles, como manda Chromium casi siempre.
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * V.visor.clientHeight : e.deltaY;
  const objetivo = Math.max(0.05, Math.min(8, g.escala * g.k * Math.pow(2, -dy / RUEDA_DUPLICA)));
  g.k = objetivo / g.escala;
  zoomVivo(g);
  clearTimeout(V.relojRueda);
  V.relojRueda = setTimeout(terminarRueda, 150);
}

function terminarRueda() {
  clearTimeout(V.relojRueda);
  const g = V.rueda;
  V.rueda = null;
  if (g && V.visor) asentarZoom(g);
}

/* ── Girar ────────────────────────────────────────────────────────────────────
   Girar cambia la forma de cada pliego, y el bitmap viejo no tiene cómo
   acompañarla: en el primer cuadro salía recortado dentro de la hoja
   apaisada, y mientras llegaba el render nuevo, aplastado (lector-07). Ahora
   lo pintado se apaga primero (la hoja con su propia transición, la tinta y
   las marcas con .is-girando), recién apagado se cambia la geometría, y cada
   hoja vuelve con el fundido de is-pintada cuando tiene su bitmap girado.
   Nunca se ve un bitmap deformado. Dos clics seguidos suman. */
function girar(paso) {
  if (!V.visor) return;
  if (V.giro) { V.giro.paso += paso; return; }
  // La pestaña se anota por si la vista se va antes de terminar (ver onLeave).
  V.giro = { paso, pestana: S.pestana, reloj: setTimeout(terminarGiro, T2 + 20) };
  V.visor.classList.add('is-girando');
  // Los renders en vuelo se cortan: uno que terminara ahora volvería a encender la hoja.
  for (const t of V.renders.values()) t.cancelar();
  V.renders.clear();
  V.pintadas.clear();
  for (const el of V.visor.querySelectorAll('.qr-pliego.is-pintada')) el.classList.remove('is-pintada');
}

function terminarGiro() {
  const g = V.giro;
  V.giro = null;
  if (!g || !V.visor) return;
  clearTimeout(g.reloj);
  const ancla = anclaCentro();
  /* Las marcas de la geometría vieja se vacían mientras no se ven: vuelven
     con la capa de texto nueva.
     La tinta NO se vacía a mano. Los editores siguen (tinta-04) y reescalar()
     les da el viewport girado: actualizar() rehace sus bitmaps en la misma
     tarea. Vaciarlos acá rompía el giro que termina donde empezó (izquierda y
     derecha seguidas, o cuatro del mismo lado): el viewport era el mismo,
     nadie llamaba a actualizar() y la tinta no volvía hasta el próximo trazo
     en esa hoja (revisión del paquete 3A). Mientras tanto no se ve nada
     deformado: la tinta está apagada hasta que su hoja vuelve a ser
     is-pintada, y para eso el render girado ya terminó. */
  for (const el of V.visor.querySelectorAll('.qr-pliego')) {
    const capa = el.querySelector('.qr-marcas');
    if (capa?.firstChild) { capa.classList.remove('is-visible'); capa.replaceChildren(); capa.style.transform = ''; marcasPintadas.delete(capa); }
  }
  S.rotacion = (((S.rotacion + g.paso * 90) % 360) + 360) % 360;
  reescalar({ ancla });
  V.visor.classList.remove('is-girando');
  // Las miniaturas se giran por CSS: el panel se rearma con fundido (lector-30).
  if (V.panel === 'miniaturas') ponerPanel('miniaturas', { fundir: true });
}

/* ── Plegar el panel ──────────────────────────────────────────────────────────
   El hueco del panel se libera de un saque y SIN transición: si el padding
   transicionara, el visor remaquetaría en cada cuadro y las hojas
   parpadearían (ver .qr-panel en lector.css). Pero las hojas están centradas,
   y en ese mismo cuadro saltaban media panel hacia el costado mientras el
   cajón todavía se deslizaba; en ancho o en página, encima, cambiaban de
   escala de golpe un cuadro después (lector-15, css-28).

   Ahora es un FLIP sobre la pista, que va por el compositor y no le dice nada
   al ResizeObserver: se mide dónde estaba la primera hoja visible, se cambia
   el hueco, y la pista arranca corrida a donde estaba y viaja a su lugar con
   la misma duración y curva que el cajón. En ancho o en página la escala
   viaja en el mismo transform, con origen en el centro del visor nuevo (el
   punto que reescalar() va a dejar quieto), y el reescalado de verdad va UNA
   vez, al terminar. */
function alternarPanel() {
  terminarPliegue();
  V.panelAbierto = !V.panelAbierto;
  const panel = document.getElementById('qr-panel');
  const cuerpo = document.querySelector('.qr-lector__cuerpo');
  const pista = V.visor?.querySelector('.qr-pista');
  const ref = pista && primeraVisible();
  const r0 = ref?.getBoundingClientRect();

  panel?.classList.toggle('is-collapsed', !V.panelAbierto);
  cuerpo?.classList.toggle('sin-panel', !V.panelAbierto);
  if (!ref || !V.visor) return;

  const r1 = ref.getBoundingClientRect();      // ya con el hueco nuevo
  const dx = r0.left - r1.left;
  const k = S.modoZoom === 'fijo' ? 1 : escalaActual() / V.escalaHecha;
  if (Math.abs(dx) < 0.5 && Math.abs(k - 1) < 1e-4) return;

  pista.style.transformOrigin = `${V.visor.scrollLeft + V.visor.clientWidth / 2}px ${V.visor.scrollTop + V.visor.clientHeight / 2}px`;
  pista.classList.add('is-escalando');
  const anim = pista.animate(
    [{ transform: `translateX(${dx}px)` }, { transform: Math.abs(k - 1) < 1e-4 ? 'none' : `scale(${k})` }],
    { duration: T3, easing: EASE, fill: 'forwards' },
  );
  V.pliegue = { anim, pista, k, reloj: setTimeout(terminarPliegue, T3 + 200) };
  anim.finished.then(() => terminarPliegue(), () => {});
}

/** La primera hoja que asoma en el visor: la referencia del FLIP. */
function primeraVisible() {
  const v = V.visor.getBoundingClientRect();
  for (const el of V.visor.querySelectorAll('.qr-pliego')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > v.top) return r.top < v.bottom ? el : null;
  }
  return null;
}

/* Termina el pliegue: con la pista todavía en su estado final se toma el
   ancla, y en la misma tarea se suelta el transform y se reescala. Ningún
   cuadro ve la pista sin escalar con las hojas viejas. */
function terminarPliegue() {
  const p = V.pliegue;
  if (!p) return;
  V.pliegue = null;
  clearTimeout(p.reloj);
  const reescala = V.visor && S.modoZoom !== 'fijo' && Math.abs(escalaActual() - V.escalaHecha) > 1e-4;
  const ancla = reescala ? anclaCentro() : null;
  p.anim.cancel();
  p.pista.style.transformOrigin = '';
  p.pista.classList.remove('is-escalando');
  if (reescala) reescalar({ ancla });
}

/* ── El tamaño del visor ──────────────────────────────────────────────────────
   El ancho disponible cambia con la ventana, con el panel y con la franja de
   pestañas: en modo ajustado, el zoom tiene que seguirlo. Pero reescalar es
   caro —cancela renders, rehace la capa de texto y los editores—, y en ancho
   cada cuadro del arrastre del borde de la ventana cambiaba la escala: las
   hojas nunca llegaban a nitidizarse y la CPU se disparaba (lector-16).

   Mientras el tamaño se mueve, la pista solo se ESTIRA (un transform, como el
   zoom en vivo, con origen en el centro del visor), y el reescalado de verdad
   va 150 ms después del último aviso, UNA vez, con el punto del centro en su
   lugar. Si algo del chasis todavía se está moviendo (la barra de tinta que
   se pliega, la franja de pestañas que aparece) se espera a que termine: la
   guarda miraba solo la barra, y en «Página entera» abrir un segundo
   documento reescalaba en cada cuadro del pliegue de la franja (css-15).

   El estirado va al cuadro siguiente y no adentro del callback: cambia el
   área de scroll, y hacerlo adentro es el "ResizeObserver loop" que Chromium
   reporta como error de consola. */
function vigilarTamano() {
  let cuadro = 0;
  let reloj = 0;
  const moviendose = () => ['qr-tintabarra', 'qr-tabs']
    .some((id) => document.getElementById(id)?.getAnimations().length);

  const asentar = () => {
    reloj = 0;
    if (!V.visor || V.pliegue || V.giro) return;
    if (moviendose()) { reloj = setTimeout(asentar, 60); return; }
    const estirado = !!V.estirado;
    const cambia = S.modoZoom !== 'fijo' && Math.abs(escalaActual() - V.escalaHecha) > 1e-4;
    // El ancla con el estirado todavía puesto: es lo que se ve.
    const ancla = cambia ? anclaCentro() : null;
    if (estirado) soltarEstirado();
    if (cambia) reescalar({ ancla });
  };

  const ro = new ResizeObserver(() => {
    if (S.modoZoom === 'fijo' || V.pliegue || V.giro) return;
    cancelAnimationFrame(cuadro);
    cuadro = requestAnimationFrame(() => {
      if (!V.visor || V.pliegue || V.giro || S.modoZoom === 'fijo') return;
      estirar();
      clearTimeout(reloj);
      reloj = setTimeout(asentar, 150);
    });
  });
  ro.observe(V.visor);

  Router.onLeave(() => {
    ro.disconnect();
    cancelAnimationFrame(cuadro);
    clearTimeout(reloj);
  });
}

/** Estira la pista a la escala que pide el tamaño de ahora, sin reescalar. */
function estirar() {
  const pista = V.visor?.querySelector('.qr-pista');
  if (!pista) return;
  const k = escalaActual() / V.escalaHecha;
  if (Math.abs(k - 1) < 1e-4) { if (V.estirado) soltarEstirado(); return; }
  V.estirado = true;
  pista.classList.add('is-escalando');
  pista.style.transformOrigin = `${V.visor.scrollLeft + V.visor.clientWidth / 2}px ${V.visor.scrollTop + V.visor.clientHeight / 2}px`;
  pista.style.transform = `scale(${k})`;
}

function soltarEstirado() {
  V.estirado = false;
  const pista = V.visor?.querySelector('.qr-pista');
  if (!pista) return;
  pista.style.transform = '';
  pista.style.transformOrigin = '';
  pista.classList.remove('is-escalando');
}

/* ── El inicio: sin documento, los recientes (ux-21) ───────────────────────────
   El main lleva una lista de recientes, con un chequeo de si cada archivo
   sigue existiendo (src/documentos.cjs), y el preload la publica desde
   siempre, pero el renderer no la usaba en ningún lado: con «Reabrir» apagado
   o después de cerrar todo, para volver al apunte de ayer había que buscarlo
   de nuevo en el explorador. Ahora el vacío del lector los lista debajo de
   «Abrir un PDF»: hasta 8, con la carpeta en mono, hace cuánto, y apagados
   los que ya no están.

   La lista es de reconcile(): entra fila por fila la primera vez y después se
   pone al día por ruta. La última que se pintó queda acá, y el repintado (un
   'cargando' que no llegó a nada, volver de otra vista) la pone en el mismo
   tick que paint(): así no vuelve a entrar ni empuja el vacío cuando llega la
   respuesta del main. */
const RECIENTES_MAX = 8;
let recientesVistos = null;
let genRecientes = 0;

const carpetaDe = (ruta) => String(ruta || '').replace(/[\\/][^\\/]*$/, '');

function filaReciente(r) {
  const existe = r.existe !== false;
  return {
    key: r.ruta,
    html: `
      <button class="ox-listitem qr-reciente${existe ? '' : ' is-perdido'}" data-ruta="${esc(r.ruta)}"${existe ? '' : ' aria-disabled="true"'}>
        ${Icons.svg('file')}
        <span class="ox-listitem__main">
          <span class="ox-listitem__title">${esc(r.nombre || r.ruta)}</span>
          <span class="ox-listitem__sub qr-reciente__carpeta">${esc(carpetaDe(r.ruta))}</span>
        </span>
        <span class="ox-listitem__aside ox-meta">${existe ? esc(relTime(r.abierto)) : 'ya no está'}</span>
      </button>`,
  };
}

function pintarInicio() {
  const hay = !!recientesVistos?.length;
  paint(head({ title: 'Documento' }) + `
    <div class="ox-grow ox-scroll qr-inicio">
      <div class="ox-empty">${Icons.svg('quire')}
        <div class="ox-empty__title">No hay ningún PDF abierto</div>
        <div class="ox-empty__text">Abrí uno con el botón de arriba, arrastralo a la ventana, o apretá Ctrl+O. Quire no toca el archivo original: lo que anotes y lo que impongas para imprimir se guardan aparte.</div>
        <div class="ox-row" style="gap:8px;margin-top:6px">
          <button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>
        </div>
      </div>
      <!-- Nace plegado si todavía no se sabe si hay recientes: se despliega
           cuando el main contesta, en vez de aparecer de golpe. -->
      <section class="qr-recientes ox-plegable" id="qr-recientes"${hay ? '' : ' hidden'}>
        <div class="qr-recientes__cabeza">
          <span class="ox-label">Recientes</span>
          <div class="ox-spacer"></div>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" id="qr-olvidar-recientes">Olvidar recientes</button>
        </div>
        <div class="ox-list qr-recientes__lista" id="qr-recientes-lista"></div>
      </section>
    </div>`);

  const caja = document.getElementById('qr-recientes');
  const lista = document.getElementById('qr-recientes-lista');
  // Lo que ya se había visto, asentado y en esta misma tarea.
  if (hay) {
    reconcile(lista, recientesVistos.map(filaReciente), { enter: false });
    asentarPlegables(caja);
  }

  lista.addEventListener('click', (e) => {
    const fila = e.target.closest('.qr-reciente');
    if (fila && !fila.classList.contains('is-perdido')) abrirReciente(fila.dataset.ruta);
  });
  document.getElementById('qr-olvidar-recientes')?.addEventListener('click', olvidarRecientes);

  const gen = ++genRecientes;
  Promise.resolve(window.onyx?.docs?.recientes?.()).then((todos) => {
    if (gen !== genRecientes || !lista.isConnected) return;
    ponerRecientes((Array.isArray(todos) ? todos : []).slice(0, RECIENTES_MAX));
  }).catch((err) => console.error('[recientes]', err));
}

function ponerRecientes(l) {
  const caja = document.getElementById('qr-recientes');
  const lista = document.getElementById('qr-recientes-lista');
  if (!caja || !lista) return;
  recientesVistos = l;
  if (!l.length) { plegarRecientes(caja, lista); return; }
  caja.hidden = false;
  reconcile(lista, l.map(filaReciente), { update: ponerReciente });
}

/* Una fila que ya se ve se pone al día en el lugar, sin el parpadeo de la
   fila entera que reconcile() hace por defecto. Ese parpadeo era una WAAPI de
   1 a 0 y otra de 0 a 1 sin fill: al terminar, la opacidad de una fila que
   pasaba a «ya no está» caía en seco de 1 a .45, y la de una que volvía
   saltaba de .45 a 1 al arrancar (revisión del paquete 3A). Ahora la clase
   cambia sola y la opacidad viaja con su transición (.qr-reciente en
   lector.css), y cada texto que cambió pasa por frase(): «hace 2 min» a
   «hace 3 min» es un destello en el lugar, «ya no está» un relevo. */
function ponerReciente(el, it) {
  const t = document.createElement('template');
  t.innerHTML = it.html.trim();
  const nu = t.content.firstElementChild;
  el.classList.toggle('is-perdido', nu.classList.contains('is-perdido'));
  if (nu.hasAttribute('aria-disabled')) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
  el.dataset.ruta = nu.dataset.ruta;
  for (const sel of ['.ox-listitem__title', '.qr-reciente__carpeta', '.ox-listitem__aside']) {
    const viejo = el.querySelector(sel);
    const nuevo = nu.querySelector(sel);
    if (viejo && nuevo) frase(viejo, nuevo.innerHTML);
  }
}

/* Se va la caja entera, plegándose: el alto baja con in-out y la opacidad con
   cubic-out (.ox-plegable), así lo de adentro ya casi no se ve cuando la caja
   empieza a cerrarse de verdad. Las filas se sueltan cuando terminó, ya sin
   nadie que las mire. Sacarlas antes por reconcile() las dejaba absolutas y
   la lista se achicaba de un cuadro al otro: el vacío, que va centrado,
   saltaba para arriba. */
function plegarRecientes(caja, lista) {
  if (caja.hidden) { lista.replaceChildren(); return; }
  caja.hidden = true;
  setTimeout(() => { if (caja.hidden) lista.replaceChildren(); }, 400);
}

async function olvidarRecientes() {
  const boton = document.getElementById('qr-olvidar-recientes');
  if (boton) boton.disabled = true;
  const ok = await attempt(() => window.onyx.docs.olvidarRecientes(), { errorTitle: 'No se pudieron olvidar los recientes' });
  if (boton) boton.disabled = false;
  if (!ok) return;
  genRecientes++;                    // una respuesta vieja que llegue tarde no los trae de vuelta
  ponerRecientes([]);
}

/* Un clic abre como el diálogo: por la fila de aperturas del shell (app.js,
   auditoría 2F), con el mismo evento que usa Convertir. Abrir por su cuenta
   (docs.leer + abrir acá mismo) se salteaba esa fila: mientras se leía el
   archivo no salía «Abriendo…», un segundo clic en otro reciente corría en
   paralelo con el primero o con la sesión del arranque, y no pasaba por
   hayLugar() ni daba el aviso de abierto (revisión del paquete 3A). */
function abrirReciente(ruta) {
  if (!ruta) return;
  window.dispatchEvent(new CustomEvent('quire:abrir-ruta', { detail: { ruta } }));
}

/* ── La vista ────────────────────────────────────────────────────────────── */

export function viewLector() {
  /* La suscripción va ANTES del early return, y esto no es cosmético: la
     pantalla de "no hay documento" también tiene que enterarse cuando aparece
     uno. Suscribiéndose después del return, abrir un PDF estando parado acá
     no repintaba nada —Router.go('lector') es un no-op si ya estás en
     'lector'— y el documento recién se veía al cambiar de vista y volver. */
  /* Se repinta solo si de verdad cambió el documento que se mira. 'documento'
     llegaba también sin cambio (cerrar una pestaña de fondo, la sesión
     abriendo las demás) y el lector se fundía sobre el mismo PDF: rehacía
     todas las hojas y miniaturas y borraba la búsqueda (lector-20). Desde 1B
     el estado lo emite menos; esto lo cuida de este lado igual. */
  const docPintado = S.doc;
  const cargandoPintado = S.cargando > 0;
  Router.onLeave(alCambiar((que) => {
    if (que === 'documento' && S.doc !== docPintado) { reiniciarBusqueda(); Router.refresh(); }
    /* Sin documento, el lector dice «Abriendo…» mientras algo se abre, en vez
       de «No hay ningún PDF abierto» con su botón (shell-05). */
    else if (que === 'cargando' && !S.doc && (S.cargando > 0) !== cargandoPintado) Router.refresh();
    else if (que === 'tinta' && V.tintaActiva) actualizarBarraTinta();
  }));


  if (!S.doc && S.cargando > 0) {
    paint(head({ title: 'Documento' }) + `
      <div class="ox-grow qr-abriendo">
        <div class="ox-empty">${Icons.spinner()}
          <div class="ox-empty__title">Abriendo…</div>
        </div>
      </div>`);
    return;
  }

  if (!S.doc) {
    pintarInicio();
    return;
  }

  paint(`
    <div class="qr-lector ox-bleed">

      <div class="qr-barra">
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-toggle-panel"
                data-tip="Panel lateral" data-tip-key="Ctrl B"><i data-icon="panel"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-prev" data-tip="Página anterior" data-tip-key="RePág"><i data-icon="chevronUp"></i></button>
        <div class="qr-paginador">
          <input class="ox-input qr-paginador__campo ox-num" id="qr-pagina-input"
                 value="${S.pagina}" spellcheck="false" aria-label="Página">
          <span class="ox-meta">de</span>
          <span class="ox-num qr-paginador__total" id="qr-pagina-total">${S.doc.paginas}</span>
        </div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-next" data-tip="Página siguiente" data-tip-key="AvPág"><i data-icon="chevronDown"></i></button>

        <!-- Este divisor no es solo un divisor: el borde derecho del panel
             lateral cae justo acá. Ver --qr-panel-w en lector.css. -->
        <div class="ox-vr" id="qr-vr-zoom"></div>

        <!-- El nivel nace vacío: lo escribe el montaje cuando el visor ya se
             puede medir (en ancho o en página la escala depende de él). Con
             un «100%» de relleno, el primer valor real destellaba como si
             hubiera cambiado (lector-27). -->
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-zoom-menos" data-tip="Alejar" data-tip-key="Ctrl -"><i data-icon="zoomOut"></i></button>
        <button class="ox-btn ox-btn--ghost ox-btn--sm qr-zoom-valor" id="qr-zoom-valor" data-tip="Nivel de zoom" data-tip-key="Ctrl 0"></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-zoom-mas" data-tip="Acercar" data-tip-key="Ctrl +"><i data-icon="zoomIn"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-fit-ancho" data-tip="Ajustar al ancho"><i data-icon="ancho"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-fit-pagina" data-tip="Ajustar a la página"><i data-icon="fit"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-rotar-izq" data-tip="Girar a la izquierda"><i data-icon="rotarIzq"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-rotar-der" data-tip="Girar a la derecha"><i data-icon="rotarDer"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm qr-tool${V.tintaActiva ? ' is-on' : ''}" id="qr-tinta-toggle"
                data-tip="Anotar con la tablet" data-tip-key="Ctrl E"><i data-icon="tinta"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-presentar"
                data-tip="Presentar" data-tip-key="F5"><i data-icon="presentar"></i></button>

        <div class="ox-spacer"></div>

        <button class="ox-btn ox-btn--primary ox-btn--sm ox-flashable" data-goto="imprimir"
                data-tip="Imprimir" data-tip-key="Ctrl P">
          <i data-icon="printer"></i> Imprimir
        </button>
        <!-- Con un solo documento la franja de pestañas está plegada y su cruz
             no se ve: sin esto, cerrarlo era Ctrl+W o nada (ux-02). La
             plomería (data-action="cerrar") ya la atiende app.js. -->
        <button class="ox-iconbtn ox-iconbtn--sm" data-action="cerrar"
                data-tip="Cerrar documento" data-tip-key="Ctrl W"><i data-icon="close"></i></button>
      </div>

      <div class="qr-tintabarra ox-plegable" id="qr-tintabarra" ${V.tintaActiva ? '' : 'hidden'}></div>

      <!-- sin-panel nace puesto si el panel venía plegado: el padding del
           hueco solo lo sacaba el botón, y al volver al lector (Imprimir,
           Ctrl+Tab, otro PDF) quedaba una franja vacía de 236 px a la
           izquierda y, en ancho, las hojas más chicas (lector-02). -->
      <div class="qr-lector__cuerpo${V.panelAbierto ? '' : ' sin-panel'}">
        <aside class="qr-panel${V.panelAbierto ? '' : ' is-collapsed'}" id="qr-panel">
          <!-- «Miniaturas» y no «Páginas»: Páginas es la vista del rail que
               quita y gira hojas, otra cosa (ux-37). -->
          <div class="qr-panel__tabs">
            <button class="qr-panel__tab${V.panel === 'miniaturas' ? ' is-active' : ''}" data-panel="miniaturas">Miniaturas</button>
            <button class="qr-panel__tab${V.panel === 'esquema' ? ' is-active' : ''}" data-panel="esquema">Marcadores</button>
            <button class="qr-panel__tab${V.panel === 'buscar' ? ' is-active' : ''}" data-panel="buscar"
                    data-tip="Buscar en el documento" data-tip-key="Ctrl F">Buscar</button>
          </div>
          <div class="qr-panel__cuerpo" id="qr-panel-cuerpo"></div>
        </aside>

        <div class="qr-visor" id="qr-visor" tabindex="0">
          <div class="qr-pista"></div>
        </div>
        <!-- Donde vive el puck: una capa del tamaño exacto del visor, fuera
             de él para que el scroll no se la lleve. Ver lector.css. -->
        <div class="qr-puck-ancla" id="qr-puck-ancla"></div>
      </div>
    </div>`);

  V.raiz = document.querySelector('.qr-lector');
  V.visor = document.getElementById('qr-visor');
  V.visor.addEventListener('scroll', alScrollear, { passive: true });
  V.visor.addEventListener('scrollend', soltarDestino);
  /* Ojo: acá NO va scrollFade(). Las superficies de visualización de Quire son
     la excepción declarada a la regla del esfumado — el porqué está en
     lector.css, arriba de .qr-visor. */

  /* El orden importa, y todo va en esta misma tarea:
     1. La barra de tinta se arma ANTES de medir nada: su alto entra en el del
        visor, y en «Página entera» la escala sale de ahí.
     2. Los plegables que nacen visibles (la barra de tinta, si estaba
        prendida) se asientan en su alto. Su @starting-style los hacía crecer
        desde 0 en cada montaje —volver de Imprimir, cambiar de pestaña— y
        corrían la hoja 40 px debajo del fundido del router; en página, además,
        la escala se medía con la barra en 0 y al terminar se reescalaba
        (lector-13, tinta-09). repintar() ya lo hace al refrescar; al navegar
        no, así que va acá.
     3. Las hojas, y el lugar donde estabas, sincrónico: el layout ya está y
        offsetTop lo fuerza. Esperar dos cuadros dejaba el tope de la página
        (no tu renglón) y arrancaba los renders de las páginas 1 a 3 para
        cancelarlos enseguida (lector-21). */
  if (V.tintaActiva) { armarBarraTinta(); V.visor.classList.add('is-anotando'); }
  asentarPlegables(V.raiz);

  construirPaginas();
  devolverLugar();
  // El primer nivel de zoom, escrito en seco: es un llenado, no un cambio (ver actualizarBarra).
  document.getElementById('qr-zoom-valor').textContent = textoZoom(escalaActual());
  actualizarBarra();
  ponerPanel(V.panel);

  cablear();
  cablearNavegacion();
  vigilarTamano();

  /* Un solo camino para refrescar la barra de tinta: la capa avisa que cambió
     y acá se responde. Antes también la actualizaba el editor al terminar un
     trazo, y con dos caminos el contador se desincronizaba — decía "sin
     trazos" con uno ya dibujado. */
  Router.onLeave(() => {
    soltarMiniaturas();
    if (V.rueda) { clearTimeout(V.relojRueda); V.rueda = null; }
    /* Un giro a mitad de su apagado se aplica igual, sin reescalar (la vista
       se va). Antes se tiraba: un Ctrl+P o un Ctrl+Tab dentro de los 200 ms
       de un clic en girar perdía el clic sin aviso. Se escribe en SU pestaña
       y no en S: con Ctrl+Tab, cuando esto corre S ya es el documento nuevo. */
    if (V.giro) {
      const { paso, pestana, reloj } = V.giro;
      clearTimeout(reloj);
      V.giro = null;
      if (pestana && S.pestanas.includes(pestana)) pestana.rotacion = (((pestana.rotacion + paso * 90) % 360) + 360) % 360;
    }
    if (V.pliegue) { clearTimeout(V.pliegue.reloj); V.pliegue.anim.cancel(); V.pliegue = null; }
    V.estirado = false;
    soltarDestino();
    V.fija = null;
    liberarTodo();
    V.visor?.removeEventListener('scroll', alScrollear);
    V.visor?.removeEventListener('scrollend', soltarDestino);
    V.visor = null;
    V.raiz = null;
  });
}

/* ── El lugar ─────────────────────────────────────────────────────────────────
   De cada pestaña se guardaba solo la página: volver a ella (o de Imprimir)
   te dejaba en el encabezado de la hoja y había que buscar el renglón
   (lector-21). Ahora se guarda la fracción de la hoja que cae en el borde de
   arriba del visor, y el corrimiento de costado. En fracción y no en píxeles:
   en «Ajustar al ancho» la escala depende del visor, que puede haber cambiado
   mientras tanto. */
function anotarLugar() {
  if (!V.visor || !S.doc || V.destino != null) return;
  const el = V.visor.querySelector(`.qr-pliego[data-pagina="${S.pagina}"]`);
  if (!el) return;
  S.lugar = {
    pagina: S.pagina,
    fraccion: (V.visor.scrollTop - topeDe(el)) / (el.offsetHeight || 1),
    scrollLeft: V.visor.scrollLeft,
  };
}

function devolverLugar() {
  const l = S.lugar;
  const el = l && l.pagina === S.pagina && V.visor.querySelector(`.qr-pliego[data-pagina="${l.pagina}"]`);
  if (!el) { irA(S.pagina, { suave: false }); return; }
  V.visor.scrollTop = topeDe(el) + l.fraccion * el.offsetHeight;
  V.visor.scrollLeft = l.scrollLeft;
}

/* Devuelve el foco al documento desde un campo (Enter o Escape) sin el
   anillo. El foco llega por una tecla y Chromium lo da por foco de teclado:
   el visor quedaba recuadrado después de cada salto de página. El anillo es
   para quien LLEGA al visor con Tab, no para quien vuelve a leer.
   `focus({ focusVisible: false })` lo arreglaría, pero Electron 40 lo ignora:
   la marca lo apaga mientras dure este foco y se va con el blur. */
function devolverAlVisor() {
  const visor = V.visor;
  if (!visor) return;
  visor.dataset.sinAnillo = '';
  visor.addEventListener('blur', () => { delete visor.dataset.sinAnillo; }, { once: true });
  visor.focus({ preventScroll: true });
}

function cablear() {
  const $ = (id) => document.getElementById(id);

  $('qr-prev')?.addEventListener('click', () => irA(Math.max(1, S.pagina - 1)));
  $('qr-next')?.addEventListener('click', () => irA(Math.min(S.doc.paginas, S.pagina + 1)));

  /* El campo de página navega SOLO si se escribió algo. Antes cada blur
     saltaba a lo que dijera el campo, que mientras tiene el foco no se pone al
     día: entrar al «12», scrollear hasta la 20 con la rueda y hacer clic en la
     hoja te devolvía a la 12; entrar y salir sin escribir te llevaba al tope
     de la página y perdías el renglón. Y una letra suelta mandaba a la 1
     (lector-17, ux-32). Ahora: Enter navega, Escape restaura y vuelve al
     documento, salir sin cambios no mueve nada, y lo que no es un número no
     se toma. */
  const campo = $('qr-pagina-input');
  let alEntrar = '';
  let saltado = false;
  const restaurar = () => { campo.value = S.pagina; };
  const saltar = () => {
    const n = parseInt(campo.value, 10);
    if (!Number.isFinite(n)) { restaurar(); return; }
    const destino = Math.max(1, Math.min(S.doc.paginas, n));
    campo.value = destino;
    irA(destino);
  };
  campo?.addEventListener('focus', () => { alEntrar = campo.value; saltado = false; });
  campo?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saltar(); saltado = true; devolverAlVisor(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restaurar(); saltado = true; devolverAlVisor(); }
  });
  campo?.addEventListener('blur', () => {
    if (saltado) { saltado = false; return; }
    if (campo.value.trim() === alEntrar.trim()) restaurar();
    else saltar();
  });

  $('qr-zoom-menos')?.addEventListener('click', () => zoomPaso(-1));
  $('qr-zoom-mas')?.addEventListener('click', () => zoomPaso(1));
  $('qr-fit-ancho')?.addEventListener('click', () => zoomA(0, { modo: 'ancho' }));
  $('qr-fit-pagina')?.addEventListener('click', () => zoomA(0, { modo: 'pagina' }));

  $('qr-zoom-valor')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [
      { label: 'Ajustar al ancho', icon: 'ancho', selected: S.modoZoom === 'ancho', onSelect: () => zoomA(0, { modo: 'ancho' }) },
      { label: 'Ajustar a la página', icon: 'fit', selected: S.modoZoom === 'pagina', onSelect: () => zoomA(0, { modo: 'pagina' }) },
      { sep: true },
      ...[0.5, 0.75, 1, 1.5, 2, 4].map((z) => ({
        label: `${z * 100}%`,
        selected: S.modoZoom === 'fijo' && Math.abs(S.zoom - z) < 0.001,
        onSelect: () => zoomA(z),
      })),
    ], { align: 'center' });
  });

  $('qr-rotar-izq')?.addEventListener('click', () => girar(-1));
  $('qr-rotar-der')?.addEventListener('click', () => girar(1));

  $('qr-toggle-panel')?.addEventListener('click', alternarPanel);

  $('qr-tinta-toggle')?.addEventListener('click', () => alternarTinta());
  $('qr-presentar')?.addEventListener('click', () => empezarPresentacion(1));

  document.querySelectorAll('.qr-panel__tab').forEach((t) => {
    t.addEventListener('click', () => cambiarPanel(t.dataset.panel));
  });

  $('qr-panel-cuerpo')?.addEventListener('click', (e) => {
    const destino = e.target.closest('[data-pagina]');
    if (destino?.dataset.pagina) irA(Number(destino.dataset.pagina));
  });

  // «Reintentar» en una hoja que no se pudo dibujar (ux-22).
  V.visor.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-reintentar]');
    const pliego = boton?.closest('.qr-pliego');
    if (!pliego) return;
    quitarFallida(pliego);
    pintar(pliego);
  });

  /* Ctrl+rueda hace zoom, como en cualquier visor (ver zoomRueda). Sin
     passive:false el navegador ya hizo su propio zoom antes de que podamos
     evitarlo. Y la rueda sin Ctrl es el usuario moviéndose: suelta un salto a
     un resultado que esperaba su capa de texto (lector-34). */
  V.visor.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) { V.pendiente = null; return; }
    e.preventDefault();
    zoomRueda(e);
  }, { passive: false });
  // Lo mismo si arrastra la barra de scroll (el pointerdown cae en el visor mismo).
  V.visor.addEventListener('pointerdown', (e) => { if (e.target === V.visor) V.pendiente = null; });
}

/** Atajos del lector. Se registran una vez, en app.js. */
export function atajosLector(e) {
  if (!S.doc || Router.name !== 'lector') return false;
  /* Con un cartel o un menú abierto, el teclado es de ellos. El onKey del
     Modal solo ataja Escape y Tab: el resto bajaba hasta acá y movía el
     documento de atrás —Espacio sobre «Borrar todo» sacaba el puck detrás del
     velo en vez de apretar el botón, y AvPág corría la hoja que no se ve—
     (lector-31). */
  if (Modal.isOpen || Menu.isOpen) return false;
  const enCampo = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  /* Presentar: F5 desde el principio y Mayús+F5 desde la que estás mirando,
     como en PowerPoint. Mientras se presenta, el teclado lo atiende
     presentar.js y no llega hasta acá. */
  if (e.key === 'F5' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (!e.repeat) empezarPresentacion(e.shiftKey ? S.pagina : 1);
    return true;
  }
  /* Un botón al que se llegó con Tab se aprieta con Espacio, como en
     cualquier ventana. Uno que quedó enfocado por un clic (el lapicito, que
     es lo último que tocás antes de anotar) NO: ahí Espacio sigue siendo el
     puck o la página siguiente. La diferencia la lleva focoPorTeclado, no
     :focus-visible: en Chromium un botón enfocado con el mouse pasa a
     cumplirlo apenas se aprieta cualquier tecla, y Espacio sobre el lapicito
     recién tocado le daba el clic y apagaba la tinta. */
  const espacio = e.key === ' ' && !enCampo && !(e.target.tagName === 'BUTTON' && focoPorTeclado);

  /* Anotando, la barra espaciadora es el puck (ver "Navegar con el puck") y
     va ANTES de la página siguiente, que es lo que sigue siendo sin tinta.
     Se traga también los repeat de Windows: mantener la barra es el gesto. */
  if (espacio && V.tintaActiva && V.puck) {
    e.preventDefault();
    if (!e.repeat && !V.navegando) entrarNav();
    return true;
  }

  /* AvPág, RePág, Inicio y Fin no son de ningún botón: valen siempre fuera
     de un campo. Solo Espacio se le cede al botón al que se llegó con Tab. */
  const navega = !enCampo
    && (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End' || espacio);
  // Moverse con el teclado suelta un salto a un resultado que quedó esperando (lector-34).
  if (navega) V.pendiente = null;

  if (navega && (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey))) {
    e.preventDefault(); bajarPantalla(1); return true;
  }
  if (navega && (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey))) {
    e.preventDefault(); bajarPantalla(-1); return true;
  }
  if (navega && e.key === 'Home') { e.preventDefault(); irA(1); return true; }
  if (navega && e.key === 'End') {
    e.preventDefault();
    /* Ya en la última, Fin es su final. irA() a la misma hoja subía al tope:
       apretar Fin leyendo el pie de la última te tiraba para arriba. */
    if (S.pagina === S.doc.paginas) V.visor?.scrollTo({ top: V.visor.scrollHeight, behavior: 'smooth' });
    else irA(S.doc.paginas);
    return true;
  }

  if (e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomPaso(1); return true; }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoomPaso(-1); return true; }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); zoomA(1); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    document.getElementById('qr-toggle-panel')?.click();
    return true;
  }

  /* Buscar. Van con e.ctrlKey y con F3, así que valen también con el foco
     adentro de un campo: es justo donde uno los aprieta. */
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); abrirBusqueda(); return true; }
  if (e.key === 'F3') {
    e.preventDefault();
    // Sin nada buscado todavía, F3 abre el panel en vez de no hacer nada.
    if (V.buscador?.resultados.length) navegarBusqueda(e.shiftKey ? -1 : 1);
    else abrirBusqueda();
    return true;
  }

  /* Tinta */
  if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); alternarTinta(); return true; }
  /* Deshacer y rehacer son de la tinta SOLO con la tinta prendida, y nunca
     con el foco en un campo. Antes se tomaban siempre: en Buscar, Ctrl+Z no
     le devolvía la letra al campo (el preventDefault le sacaba su deshacer) y
     en cambio borraba el último trazo, quizás de la página 30 mientras se
     miraba la 5, y la capa lo guardaba en disco a los 900 ms. Un Ctrl+Z de
     reflejo leyendo, con la barra cerrada, hacía lo mismo sin que se viera
     nada (lector-01, tinta-06, ux-04; decisión de Fran). */
  const deshace = e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z';
  const rehace = e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'));
  if ((deshace || rehace) && (enCampo || !V.tintaActiva)) return false;
  if (deshace) { e.preventDefault(); deshacerTinta(); return true; }
  if (rehace) { e.preventDefault(); rehacerTinta(); return true; }
  // Con el modo activo, los números eligen herramienta como en cualquier editor.
  if (V.tintaActiva && !enCampo && !e.ctrlKey && /^[1-4]$/.test(e.key)) {
    e.preventDefault();
    V.herramienta = Object.keys(HERRAMIENTAS)[+e.key - 1];
    sincronizarBarraTinta();
    return true;
  }
  return false;
}

/* Al terminar, el lector queda en la diapositiva donde terminaste. */
function empezarPresentacion(desde) {
  presentar({
    desde,
    alTerminar: (n) => { if (Router.name === 'lector' && S.doc) irA(n, { suave: false }); },
  });
}

/* ── La contraseña ────────────────────────────────────────────────────────────
   Un PDF con contraseña de apertura daba un toast rojo en inglés («No password
   given») y no había forma de escribirla (ux-11). documento.js no sabe de
   carteles: le pasa el pedido a quien se anotó, y el lector se anota al
   cargarse (app.js lo importa al arrancar, antes de abrir nada). Devuelve la
   contraseña, o null si se cancela. */
async function pedirClave({ incorrecta = false, nombre = '' } = {}) {
  const cuerpo = document.createElement('div');
  cuerpo.className = 'qr-clave';
  cuerpo.innerHTML = `
    <div class="ox-inputwrap">
      ${Icons.svg('lock')}
      <input class="ox-input" type="password" autocomplete="off" spellcheck="false" aria-label="Contraseña">
    </div>
    ${incorrecta ? '<span class="ox-meta qr-clave__error">Esa contraseña no abre el archivo. Probá de nuevo.</span>' : ''}`;
  const quien = nombre ? `«${nombre}»` : 'Este PDF';
  const v = await Modal.show({
    title: incorrecta ? 'Contraseña incorrecta' : 'Este PDF tiene contraseña',
    sub: `${quien} está protegido. Quire la usa solo para abrirlo: no la guarda.`,
    body: cuerpo,
    width: 420,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Abrir', value: 'abrir', variant: 'primary' },
    ],
  });
  return v === 'abrir' ? cuerpo.querySelector('input').value : null;
}
alPedirClave(pedirClave);

/* Cómo llegó el foco, a mano: con Tab o con el puntero. Lo mira atajosLector
   para saber si Espacio es del botón enfocado o del puck. Van en captura para
   enterarse antes que nadie, y una sola vez por ventana (el módulo carga una). */
let focoPorTeclado = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') focoPorTeclado = true; }, true);
document.addEventListener('pointerdown', () => { focoPorTeclado = false; }, true);

/* Para las pruebas (test/lector.cjs): cuántas veces se reescaló, y en qué
   escala están medidas las hojas. Solo lectura. */
const diagnostico = () => ({ reescalados: V.reescalados, escalaHecha: V.escalaHecha, panel: V.panel, pendiente: V.pendiente });

export { irA, reescalar, abrirBusqueda, diagnostico };
