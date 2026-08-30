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
import { paint, head, empty, esc } from '../ui.js';
import { raf2 } from '../motion.js';
import { HERRAMIENTAS, COLORES } from '../tinta/capa.js';
import { cablearTinta } from '../tinta/editor.js';
import { registrar as registrarSeleccion, olvidar as olvidarSeleccion, olvidarTodo as olvidarSelecciones } from '../pdf/seleccion.js';
import { buscadorDe, ubicar } from '../pdf/buscador.js';

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
  desuscribir: null,
  panel: 'miniaturas',     // 'miniaturas' | 'esquema'
  panelAbierto: true,

  /* Tinta. El modo y la herramienta sobreviven a navegar a Imprimir y volver:
     que se apague sola sería como que se te caiga el lápiz al mirar otra cosa. */
  tintaActiva: false,
  herramienta: 'pluma',
  colores: { pluma: '#1a1a1a', fibra: '#c0392b', resaltador: '#f1c40f' },
  anchos: { pluma: 1.8, fibra: 4.5, resaltador: 14, borrador: 16 },
  editores: new Map(),     // nº de página → editor de tinta cableado

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
      contenedor.classList.add('is-fallida');
    })
    .finally(() => V.renders.delete(n));
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
 * Pone (o repone) la capa de tinta encima de una página ya pintada.
 *
 * El canvas de tinta existe SIEMPRE, esté o no el modo de anotación activo:
 * lo anotado tiene que verse mientras leés, igual que se ve en el papel. Lo
 * que cambia con el modo es si captura el puntero.
 */
async function montarTinta(contenedor, n) {
  if (!S.tinta || !S.doc) return;
  const viejo = contenedor.querySelector('.qr-tinta');
  if (!viejo) return;

  V.editores.get(n)?.destruir();

  /* El canvas se REEMPLAZA por un clon vacío antes de volver a cablearlo.
     StrokeInput registra sus listeners sobre el elemento y no expone forma de
     sacarlos (viene de Scrawl tal cual y así se queda), así que si el mismo
     canvas se cablea dos veces —y se cablea: reescalar() no rehace el DOM, solo
     cambia tamaños, y el observador vuelve a pintar la página— quedan dos
     StrokeInput escuchando y CADA TRAZO SE GUARDA DUPLICADO. Se ve solo si uno
     mira el contador: en pantalla los dos trazos caen exactamente encima. */
  const canvas = viejo.cloneNode(false);
  viejo.replaceWith(canvas);
  try {
    const viewport = await S.doc.viewport(n, {
      escala: escalaActual() * (window.devicePixelRatio || 1),
      rotacionExtra: S.rotacion,
    });
    const editor = cablearTinta(canvas, {
      pagina: n,
      capa: S.tinta,
      viewport,
      herramienta: herramientaActual,
      activo: () => V.tintaActiva,
      // La barra se entera por el evento 'tinta' de la capa, no por acá.
    });
    V.editores.set(n, editor);
  } catch (err) {
    console.error(`[tinta] página ${n}:`, err);
  }
}

function liberar(contenedor) {
  const n = Number(contenedor.dataset.pagina);
  V.renders.get(n)?.cancelar();
  V.renders.delete(n);
  V.pintadas.delete(n);
  V.editores.get(n)?.destruir();
  V.editores.delete(n);
  V.textos.get(n)?.cancelar();
  V.textos.delete(n);
  contenedor.classList.remove('is-pintada');

  /* Los spans se van con la página. Vaciar el div a mano y no dejar que el
     próximo render lo pise: mientras la página está fuera de pantalla, miles de
     spans invisibles siguen siendo miles de nodos en el árbol. */
  const texto = contenedor.querySelector('.qr-texto');
  if (texto) { olvidarSeleccion(texto); texto.replaceChildren(); }

  /* Las marcas de la búsqueda se van con los spans sobre los que estaban
     medidas: sin esto quedarían pintadas sobre una capa vacía, y al volver la
     página se sumarían a las nuevas. */
  V.divsTexto.delete(n);
  const marcas = contenedor.querySelector('.qr-marcas');
  if (marcas) {
    /* Se apaga ADEMÁS de vaciarse. Vaciar y dejarla prendida deja una capa
       visible sin nada adentro, y esa combinación es un agujero: remarcarTodo()
       decide a quién visitar preguntando por hijos, así que una capa así no la
       vuelve a tocar nadie y se queda prendida para siempre. */
    marcas.classList.remove('is-visible');
    marcas.replaceChildren();
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
  const pista = V.visor.querySelector('.qr-pista');
  pista.innerHTML = S.geometrias.map((g) => {
    const { ancho, alto } = medida(g, escala);
    return `
      <div class="qr-pliego" data-pagina="${g.numero}" style="width:${ancho}px;height:${alto}px">
        <canvas class="qr-hoja"></canvas>
        <div class="qr-marcas"></div>
        <div class="qr-texto"></div>
        <canvas class="qr-tinta"></canvas>
        <span class="qr-pliego__num">${g.numero}</span>
      </div>`;
  }).join('');

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

/** Recalcula tamaños sin desarmar el DOM, y vuelve a pintar lo que se ve. */
function reescalar({ anclarEn = null } = {}) {
  if (!V.visor || !S.doc) return;

  const ancla = anclarEn ?? S.pagina;
  const escala = escalaActual();

  /* Se cancelan los renders en vuelo pero NO se tocan los bitmaps: el de la
     escala anterior, estirado por CSS, se ve borroso un instante y después se
     nitidiza. Liberarlos acá dejaría la hoja en blanco hasta que termine el
     repintado, que es justo el parpadeo que se quiere evitar. Los editores de
     tinta sí se sueltan: se recablean con el viewport nuevo. */
  for (const t of V.renders.values()) t.cancelar();
  V.renders.clear();
  V.pintadas.clear();
  for (const e of V.editores.values()) e.destruir();
  V.editores.clear();
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
    el.classList.remove('is-fallida');
    // is-pintada se MANTIENE: el canvas sigue teniendo la imagen anterior.
  });

  V.observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) pintar(e.target);
      else liberar(e.target);
    }
  }, { root: V.visor, rootMargin: `${Math.round(MARGEN_PRECARGA * 100)}% 0px` });

  V.visor.querySelectorAll('.qr-pliego').forEach((el) => V.observador.observe(el));

  // Volver a donde estabas: cambiar el zoom no debería perderte de página.
  irA(ancla, { suave: false });
  actualizarBarra();
}

function irA(n, { suave = true } = {}) {
  const destino = V.visor?.querySelector(`.qr-pliego[data-pagina="${n}"]`);
  if (!destino) return;
  V.visor.scrollTo({ top: destino.offsetTop - 24, behavior: suave ? 'smooth' : 'auto' });
  S.pagina = n;
  actualizarBarra();
}

/* ── Qué página estoy mirando ────────────────────────────────────────────── */

let tickScroll = null;

function alScrollear() {
  if (tickScroll) return;
  tickScroll = requestAnimationFrame(() => {
    tickScroll = null;
    if (!V.visor) return;

    // La página "actual" es la que cruza el tercio superior del visor: es la
    // que uno está leyendo, no la que ocupa más pantalla.
    const linea = V.visor.scrollTop + V.visor.clientHeight * 0.33;
    let actual = 1;
    for (const el of V.visor.querySelectorAll('.qr-pliego')) {
      if (el.offsetTop <= linea) actual = Number(el.dataset.pagina);
      else break;
    }
    if (actual !== S.pagina) {
      S.pagina = actual;
      actualizarBarra();
      marcarMiniatura();
    }
  });
}

/* ── Barra y chrome ──────────────────────────────────────────────────────── */

function actualizarBarra() {
  const campo = document.getElementById('qr-pagina-input');
  if (campo && document.activeElement !== campo) campo.value = S.pagina;

  const total = document.getElementById('qr-pagina-total');
  if (total) total.textContent = S.doc ? S.doc.paginas : '—';

  const z = document.getElementById('qr-zoom-valor');
  if (z) z.textContent = `${Math.round(escalaActual() * 100)}%`;

  const g = S.geometrias[S.pagina - 1];
  const medidaStat = document.getElementById('stat-medida');
  const medidaVal = document.getElementById('stat-medida-value');
  if (medidaStat && medidaVal && g) {
    medidaStat.hidden = false;
    medidaVal.textContent = g.etiqueta;
  }

  const pagStat = document.getElementById('stat-pagina');
  const pagVal = document.getElementById('stat-pagina-value');
  if (pagStat && pagVal && S.doc) {
    pagStat.hidden = false;
    pagVal.textContent = `${S.pagina} / ${S.doc.paginas}`;
  }
}

function marcarMiniatura() {
  const panel = document.getElementById('qr-panel-cuerpo');
  if (!panel || V.panel !== 'miniaturas') return;
  panel.querySelectorAll('.qr-mini').forEach((m) => {
    m.classList.toggle('is-actual', Number(m.dataset.pagina) === S.pagina);
  });
  const activa = panel.querySelector('.qr-mini.is-actual');
  if (activa) {
    const arriba = activa.offsetTop;
    const visible = arriba >= panel.scrollTop && arriba + activa.offsetHeight <= panel.scrollTop + panel.clientHeight;
    if (!visible) panel.scrollTo({ top: arriba - panel.clientHeight / 2 + activa.offsetHeight / 2, behavior: 'smooth' });
  }
}

/* ── Panel lateral ───────────────────────────────────────────────────────── */

async function pintarMiniaturas() {
  const cuerpo = document.getElementById('qr-panel-cuerpo');
  if (!cuerpo || !S.doc) return;

  cuerpo.innerHTML = S.geometrias.map((g) => `
    <button class="qr-mini${g.numero === S.pagina ? ' is-actual' : ''}" data-pagina="${g.numero}">
      <span class="qr-mini__hoja" style="aspect-ratio:${g.anchoPt} / ${g.altoPt}"></span>
      <span class="qr-mini__num">${g.numero}</span>
    </button>`).join('');

  /* Las miniaturas también se pintan bajo demanda: en un documento largo,
     generar 400 de una tarda más que abrir el archivo. */
  const obs = new IntersectionObserver(async (entradas, self) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      self.unobserve(e.target);
      const n = Number(e.target.dataset.pagina);
      const hoja = e.target.querySelector('.qr-mini__hoja');
      try {
        const g = S.geometrias[n - 1];
        const canvas = await S.doc.lienzo(n, { escala: 132 / g.anchoPt, dpr: 2 });
        canvas.className = 'qr-mini__lienzo';
        hoja.replaceChildren(canvas);
        e.target.classList.add('is-lista');
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.error(`[miniatura ${n}]`, err);
      }
    }
  }, { root: cuerpo, rootMargin: '200% 0px' });

  cuerpo.querySelectorAll('.qr-mini').forEach((m) => obs.observe(m));
  V.observadorMini = obs;
}

function pintarEsquema() {
  const cuerpo = document.getElementById('qr-panel-cuerpo');
  if (!cuerpo) return;

  if (!S.esquema.length) {
    cuerpo.innerHTML = `
      <div class="qr-panel__vacio">
        ${Icons.svg('marcador')}
        <span class="ox-meta">Este PDF no trae marcadores.</span>
      </div>`;
    return;
  }

  cuerpo.innerHTML = `<div class="qr-esquema">${S.esquema.map((e) => `
    <button class="qr-esquema__item" data-pagina="${e.pagina || ''}" style="--nivel:${e.nivel}"
            ${e.pagina ? '' : 'disabled'}>
      <span class="qr-esquema__titulo ox-truncate">${esc(e.titulo)}</span>
      ${e.pagina ? `<span class="qr-esquema__pag ox-num">${e.pagina}</span>` : ''}
    </button>`).join('')}</div>`;
}

function cambiarPanel(cual) {
  V.panel = cual;
  document.querySelectorAll('.qr-panel__tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.panel === cual);
  });
  V.observadorMini?.disconnect();
  /* Buscar no es una lista más: el cuerpo pasa a ser campo fijo arriba y lista
     con scroll propio abajo. Sin la clase, el campo scrollearía junto con los
     resultados y se iría de pantalla apenas hay unos cuantos. */
  document.getElementById('qr-panel-cuerpo')?.classList.toggle('es-buscar', cual === 'buscar');
  if (cual === 'miniaturas') pintarMiniaturas();
  else if (cual === 'esquema') pintarEsquema();
  else pintarBuscar();
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

  const base = contenedor.getBoundingClientRect();
  const rango = document.createRange();
  const frag = document.createDocumentFragment();
  let foco = null;

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
        marca.style.left = `${r.left - base.left}px`;
        marca.style.top = `${r.top - base.top}px`;
        marca.style.width = `${r.width}px`;
        marca.style.height = `${r.height}px`;
        frag.append(marca);
        /* Relativa al PLIEGO y no a la pantalla: así centrarEn() no necesita
           saber por dónde va el scroll, que mientras hay una animación suave en
           curso es un número que se mueve. */
        if (esta && !foco) foco = { top: r.top - base.top, alto: r.height };
      }
    }
  }

  clearTimeout(apagados.get(capa));
  capa.replaceChildren(frag);
  capa.classList.add('is-visible');
  return foco;
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

function pintarBuscar() {
  const cuerpo = document.getElementById('qr-panel-cuerpo');
  if (!cuerpo) return;

  /* Dos renglones, y los dos SIEMPRE puestos. La fila de abajo podría
     aparecer recién cuando hay resultados, pero entonces el campo se movería
     de lugar justo mientras se escribe en él — y un campo que se corre bajo el
     cursor es de las pocas cosas que se sienten rotas aunque estén animadas.
     Sin nada buscado dice "—" y los botones no sirven, que es la verdad. */
  cuerpo.innerHTML = `
    <div class="qr-buscar">
      <div class="ox-inputwrap qr-buscar__campo">
        ${Icons.svg('search')}
        <input class="ox-input" id="qr-buscar-campo" placeholder="Buscar en el documento"
               spellcheck="false" autocomplete="off" value="${esc(V.consulta)}">
      </div>
      <div class="qr-buscar__barra">
        <span class="ox-meta qr-buscar__cuenta" id="qr-buscar-cuenta">—</span>
        <div class="ox-spacer"></div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-buscar-prev" disabled
                data-tip="Anterior" data-tip-key="Shift Enter"><i data-icon="chevronUp"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-buscar-next" disabled
                data-tip="Siguiente" data-tip-key="Enter"><i data-icon="chevronDown"></i></button>
      </div>
    </div>
    <div class="qr-buscar__lista" id="qr-buscar-lista"></div>`;

  Icons.mount(cuerpo);
  cablearBuscar();
  pintarResultados();
}

/** El "3/47" del campo, y los botones que dejan de servir sin resultados. */
function actualizarCuenta() {
  const cuenta = document.getElementById('qr-buscar-cuenta');
  const b = V.buscador;
  const hay = !!(b && V.consulta.trim() && b.total);

  if (cuenta) {
    /* Antes de pararse en una, el contador dice CUÁNTAS hay; parado en una,
       dice en cuál. "— de 30" era gramaticalmente correcto y se leía como un
       hueco, que es justo lo que un contador no puede parecer. */
    const plural = b && b.total === 1 ? 'coincidencia' : 'coincidencias';
    cuenta.textContent = !hay ? '—'
      : V.actual >= 0 ? `${V.actual + 1} de ${b.total}`
        : `${b.total} ${plural}`;
    cuenta.classList.toggle('is-vacia', !hay);
  }
  document.getElementById('qr-buscar-prev')?.toggleAttribute('disabled', !hay);
  document.getElementById('qr-buscar-next')?.toggleAttribute('disabled', !hay);
}

function pintarResultados() {
  const lista = document.getElementById('qr-buscar-lista');
  if (!lista) return;
  actualizarCuenta();

  const b = V.buscador;
  const paginas = S.doc?.paginas ?? 0;

  if (!V.consulta.trim()) {
    lista.innerHTML = `
      <div class="qr-panel__vacio">
        ${Icons.svg('search')}
        <span class="ox-meta">Escribí para buscar en las ${paginas} páginas.</span>
        <span class="ox-meta qr-buscar__nota">Encuentra el texto de verdad del PDF, el mismo que se
        puede seleccionar con el mouse. Si el archivo es un escaneo —una foto de la hoja— no hay
        texto que buscar.</span>
      </div>`;
    return;
  }

  if (!b?.resultados.length) {
    /* Mientras recorre dice por dónde va. Sin esto, buscar en un tratado de
       mil páginas se ve igual que buscar algo que no está: vacío y quieto. */
    const texto = b?.terminada
      ? `Sin coincidencias para «${esc(V.consulta.trim())}».`
      : `Leyendo la página ${b?.leidas ?? 0} de ${paginas}…`;
    lista.innerHTML = `
      <div class="qr-panel__vacio">
        ${Icons.svg(b?.terminada ? 'search' : 'clock')}
        <span class="ox-meta">${texto}</span>
      </div>`;
    return;
  }

  const filas = b.resultados.map((r, i) => `
    <button class="qr-hit${i === V.actual ? ' is-actual' : ''}" data-i="${i}">
      <span class="qr-hit__texto">${esc(r.antes)}<mark>${esc(r.medio)}</mark>${esc(r.despues)}</span>
      <span class="qr-hit__pag ox-num">${r.pagina}</span>
    </button>`).join('');

  /* Los dos pies dicen lo que la lista NO muestra: que todavía falta recorrer,
     o que hay más coincidencias de las que entraron. Una lista recortada en
     silencio se lee como una lista completa. */
  const pie = !b.terminada
    ? `<div class="qr-buscar__pie ox-meta">Buscando… ${b.leidas} de ${paginas} páginas</div>`
    : b.recortada
      ? `<div class="qr-buscar__pie ox-meta">Se listan ${b.resultados.length} de ${b.total}. Las demás se resaltan igual en la hoja.</div>`
      : '';

  lista.innerHTML = filas + pie;
}

/** Deja marcado en la lista el resultado en el que estás, y lo trae a la vista. */
function marcarLista() {
  const lista = document.getElementById('qr-buscar-lista');
  if (!lista) return;
  lista.querySelectorAll('.qr-hit').forEach((f) => {
    f.classList.toggle('is-actual', Number(f.dataset.i) === V.actual);
  });

  const fila = lista.querySelector('.qr-hit.is-actual');
  if (!fila) return;
  const arriba = fila.offsetTop;
  const visible = arriba >= lista.scrollTop
    && arriba + fila.offsetHeight <= lista.scrollTop + lista.clientHeight;
  if (!visible) {
    lista.scrollTo({ top: arriba - lista.clientHeight / 2 + fila.offsetHeight / 2, behavior: 'smooth' });
  }
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
      else { campo.blur(); V.visor?.focus(); }
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
  if (barra) barra.hidden = !V.tintaActiva;
  /* Mientras se anota, el canvas de tinta captura el puntero. La clase va en
     el visor y no en cada pliego para que un solo toggle alcance. */
  V.visor?.classList.toggle('is-anotando', V.tintaActiva);
  if (V.tintaActiva) pintarBarraTinta();
}

function pintarBarraTinta() {
  const barra = document.getElementById('qr-tintabarra');
  if (!barra || !S.tinta) return;

  const h = herramientaActual();
  const esBorrador = V.herramienta === 'borrador';

  barra.innerHTML = `
    <div class="qr-tintabarra__grupo">
      ${Object.entries(HERRAMIENTAS).map(([id, t]) => `
        <button class="ox-iconbtn ox-iconbtn--sm qr-tool${V.herramienta === id ? ' is-on' : ''}"
                data-tinta-tool="${id}" data-tip="${t.etiqueta}"><i data-icon="${t.icono}"></i></button>`).join('')}
    </div>

    <div class="ox-vr"></div>

    ${esBorrador ? '' : `
      <div class="qr-tintabarra__grupo qr-colores">
        ${COLORES.map((c) => `
          <button class="qr-color${h.color === c ? ' is-on' : ''}" data-tinta-color="${c}"
                  style="--tinta:${c}" data-tip="${c}"></button>`).join('')}
      </div>
      <div class="ox-vr"></div>`}

    <div class="qr-tintabarra__grupo qr-grosor">
      <span class="ox-meta">${esBorrador ? 'Tamaño' : 'Grosor'}</span>
      <input class="ox-slider" id="qr-tinta-ancho" type="range"
             min="${esBorrador ? 6 : 0.5}" max="${esBorrador ? 48 : 24}" step="0.5" value="${h.ancho}"
             style="--ox-pct:${porcentajeAncho(h.ancho, esBorrador)}%">
      <span class="ox-chip ox-chip--mono" id="qr-tinta-ancho-eco">${h.ancho} pt</span>
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

    <span class="ox-chip qr-tinta-cuenta" id="qr-tinta-cuenta"></span>`;

  Icons.mount(barra);
  cablearBarraTinta();
  actualizarBarraTinta();
}

const porcentajeAncho = (v, esBorrador) => {
  const [min, max] = esBorrador ? [6, 48] : [0.5, 24];
  return (((v - min) / (max - min)) * 100).toFixed(1);
};

function cablearBarraTinta() {
  const barra = document.getElementById('qr-tintabarra');
  if (!barra) return;

  barra.querySelectorAll('[data-tinta-tool]').forEach((b) => {
    b.addEventListener('click', () => { V.herramienta = b.dataset.tintaTool; pintarBarraTinta(); });
  });

  barra.querySelectorAll('[data-tinta-color]').forEach((b) => {
    b.addEventListener('click', () => {
      V.colores[V.herramienta] = b.dataset.tintaColor;
      pintarBarraTinta();
    });
  });

  const slider = document.getElementById('qr-tinta-ancho');
  slider?.addEventListener('input', () => {
    const v = +slider.value;
    V.anchos[V.herramienta] = v;
    slider.style.setProperty('--ox-pct', `${porcentajeAncho(v, V.herramienta === 'borrador')}%`);
    document.getElementById('qr-tinta-ancho-eco').textContent = `${v} pt`;
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
  if (!S.tinta?.limpiarPagina(S.pagina)) return;
  V.editores.get(S.pagina)?.redibujar();
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

  await S.tinta.borrarTodo();
  for (const ed of V.editores.values()) ed.redibujar();
  actualizarBarraTinta();
  Toast.show({ title: 'Tinta borrada', icon: 'borrador' });
}

function actualizarBarraTinta() {
  if (!S.tinta) return;
  const cuenta = document.getElementById('qr-tinta-cuenta');
  if (cuenta) {
    const n = S.tinta.cuenta;
    cuenta.textContent = n ? `${n} ${n === 1 ? 'trazo' : 'trazos'}` : 'sin trazos';
    cuenta.classList.toggle('is-vacia', !n);
  }
  document.getElementById('qr-tinta-deshacer')?.toggleAttribute('disabled', !S.tinta.historial.length);
  document.getElementById('qr-tinta-rehacer')?.toggleAttribute('disabled', !S.tinta.deshechos.length);
  // Sin nada dibujado no hay nada que borrar, y un botón que no hace nada miente.
  document.getElementById('qr-tinta-limpiar')?.toggleAttribute('disabled', S.tinta.vacia);
}

function deshacerTinta() {
  if (!S.tinta?.deshacer()) return;
  for (const ed of V.editores.values()) ed.redibujar();
  actualizarBarraTinta();
}

function rehacerTinta() {
  if (!S.tinta?.rehacer()) return;
  for (const ed of V.editores.values()) ed.redibujar();
  actualizarBarraTinta();
}

/* ── Zoom ────────────────────────────────────────────────────────────────── */

function zoomA(valor, { modo = 'fijo' } = {}) {
  S.modoZoom = modo;
  if (modo === 'fijo') S.zoom = Math.max(0.05, Math.min(8, valor));
  reescalar();
}

function zoomPaso(direccion) {
  const actual = escalaActual();
  const lista = direccion > 0 ? ZOOMS : [...ZOOMS].reverse();
  const siguiente = lista.find((z) => (direccion > 0 ? z > actual + 0.001 : z < actual - 0.001));
  zoomA(siguiente ?? actual);
}

/* ── La vista ────────────────────────────────────────────────────────────── */

export function viewLector() {
  /* La suscripción va ANTES del early return, y esto no es cosmético: la
     pantalla de "no hay documento" también tiene que enterarse cuando aparece
     uno. Suscribiéndose después del return, abrir un PDF estando parado acá
     no repintaba nada —Router.go('lector') es un no-op si ya estás en
     'lector'— y el documento recién se veía al cambiar de vista y volver. */
  Router.onLeave(alCambiar((que) => {
    if (que === 'documento') { reiniciarBusqueda(); Router.refresh({ animar: true }); }
    else if (que === 'tinta' && V.tintaActiva) actualizarBarraTinta();
  }));

  if (!S.doc) {
    paint(head({ title: 'Documento' }) + empty({
      icon: 'quire',
      title: 'No hay ningún PDF abierto',
      text: 'Abrí uno con el botón de arriba, arrastralo a la ventana, o apretá Ctrl+O. Quire no toca el archivo original: lo que anotes y lo que impongas para imprimir se guardan aparte.',
      actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
    }));
    return;
  }

  paint(`
    <div class="qr-lector">

      <div class="qr-barra">
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-toggle-panel"
                data-tip="Panel lateral" data-tip-key="Ctrl B"><i data-icon="panel"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-prev" data-tip="Página anterior"><i data-icon="chevronUp"></i></button>
        <div class="qr-paginador">
          <input class="ox-input qr-paginador__campo ox-num" id="qr-pagina-input"
                 value="${S.pagina}" spellcheck="false" aria-label="Página">
          <span class="ox-meta">de</span>
          <span class="ox-num qr-paginador__total" id="qr-pagina-total">${S.doc.paginas}</span>
        </div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-next" data-tip="Página siguiente"><i data-icon="chevronDown"></i></button>

        <!-- Este divisor no es solo un divisor: el borde derecho del panel
             lateral cae justo acá. Ver --qr-panel-w en quire.css. -->
        <div class="ox-vr" id="qr-vr-zoom"></div>

        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-zoom-menos" data-tip="Alejar" data-tip-key="Ctrl −"><i data-icon="zoomOut"></i></button>
        <button class="ox-btn ox-btn--ghost ox-btn--sm qr-zoom-valor" id="qr-zoom-valor" data-tip="Nivel de zoom">100%</button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-zoom-mas" data-tip="Acercar" data-tip-key="Ctrl +"><i data-icon="zoomIn"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-fit-ancho" data-tip="Ajustar al ancho"><i data-icon="ancho"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-fit-pagina" data-tip="Ajustar a la página"><i data-icon="fit"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-rotar-izq" data-tip="Girar a la izquierda"><i data-icon="rotarIzq"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-rotar-der" data-tip="Girar a la derecha"><i data-icon="rotarDer"></i></button>

        <div class="ox-vr"></div>

        <button class="ox-iconbtn ox-iconbtn--sm${V.tintaActiva ? ' is-on' : ''}" id="qr-tinta-toggle"
                data-tip="Anotar con la tablet" data-tip-key="Ctrl E"><i data-icon="tinta"></i></button>

        <div class="ox-spacer"></div>

        <button class="ox-btn ox-btn--primary ox-btn--sm ox-flashable" data-goto="imprimir">
          <i data-icon="printer"></i> Imprimir
        </button>
      </div>

      <div class="qr-tintabarra" id="qr-tintabarra" ${V.tintaActiva ? '' : 'hidden'}></div>

      <div class="qr-lector__cuerpo">
        <aside class="qr-panel${V.panelAbierto ? '' : ' is-collapsed'}" id="qr-panel">
          <div class="qr-panel__tabs">
            <button class="qr-panel__tab${V.panel === 'miniaturas' ? ' is-active' : ''}" data-panel="miniaturas">Páginas</button>
            <button class="qr-panel__tab${V.panel === 'esquema' ? ' is-active' : ''}" data-panel="esquema">Marcadores</button>
            <button class="qr-panel__tab${V.panel === 'buscar' ? ' is-active' : ''}" data-panel="buscar">Buscar</button>
          </div>
          <div class="qr-panel__cuerpo" id="qr-panel-cuerpo"></div>
        </aside>

        <div class="qr-visor" id="qr-visor" tabindex="0">
          <div class="qr-pista"></div>
        </div>
      </div>
    </div>`);

  V.visor = document.getElementById('qr-visor');
  V.visor.addEventListener('scroll', alScrollear, { passive: true });
  /* Ojo: acá NO va scrollFade(). Las superficies de visualización de Quire son
     la excepción declarada a la regla del esfumado — el porqué está en
     quire.css, arriba de .qr-visor. */

  construirPaginas();
  cambiarPanel(V.panel);
  actualizarBarra();
  if (V.tintaActiva) { pintarBarraTinta(); V.visor.classList.add('is-anotando'); }
  raf2(() => irA(S.pagina, { suave: false }));

  cablear();

  /* El ancho disponible cambia con la ventana y al plegar el panel: en modo
     ajustado, el zoom tiene que seguirlo. */
  const ro = new ResizeObserver(() => {
    if (S.modoZoom !== 'fijo') reescalar();
  });
  ro.observe(V.visor);

  /* Un solo camino para refrescar la barra de tinta: la capa avisa que cambió
     y acá se responde. Antes también la actualizaba el editor al terminar un
     trazo, y con dos caminos el contador se desincronizaba — decía "sin
     trazos" con uno ya dibujado. */
  Router.onLeave(() => {
    ro.disconnect();
    V.observadorMini?.disconnect();
    liberarTodo();
    V.visor?.removeEventListener('scroll', alScrollear);
    V.visor = null;
  });
}

function cablear() {
  const $ = (id) => document.getElementById(id);

  $('qr-prev')?.addEventListener('click', () => irA(Math.max(1, S.pagina - 1)));
  $('qr-next')?.addEventListener('click', () => irA(Math.min(S.doc.paginas, S.pagina + 1)));

  const campo = $('qr-pagina-input');
  const saltar = () => {
    const n = Math.max(1, Math.min(S.doc.paginas, parseInt(campo.value, 10) || 1));
    campo.value = n;
    irA(n);
  };
  campo?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saltar(); campo.blur(); } });
  campo?.addEventListener('blur', saltar);

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

  $('qr-rotar-izq')?.addEventListener('click', () => { S.rotacion = (S.rotacion + 270) % 360; reescalar(); });
  $('qr-rotar-der')?.addEventListener('click', () => { S.rotacion = (S.rotacion + 90) % 360; reescalar(); });

  $('qr-toggle-panel')?.addEventListener('click', () => {
    V.panelAbierto = !V.panelAbierto;
    $('qr-panel').classList.toggle('is-collapsed', !V.panelAbierto);
    /* El hueco se libera de una, sin animar: el panel se desliza por su cuenta
       con transform. Si el padding también transicionara, el visor
       remaquetaría en cada frame y las páginas parpadearían. */
    document.querySelector('.qr-lector__cuerpo')?.classList.toggle('sin-panel', !V.panelAbierto);
  });

  $('qr-tinta-toggle')?.addEventListener('click', () => alternarTinta());

  document.querySelectorAll('.qr-panel__tab').forEach((t) => {
    t.addEventListener('click', () => cambiarPanel(t.dataset.panel));
  });

  $('qr-panel-cuerpo')?.addEventListener('click', (e) => {
    const destino = e.target.closest('[data-pagina]');
    if (destino?.dataset.pagina) irA(Number(destino.dataset.pagina));
  });

  /* Ctrl+rueda hace zoom, como en cualquier visor. Sin passive:false el
     navegador ya hizo su propio zoom antes de que podamos evitarlo. */
  V.visor.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomPaso(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

/** Atajos del lector. Se registran una vez, en app.js. */
export function atajosLector(e) {
  if (!S.doc || Router.name !== 'lector') return false;
  const enCampo = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  if (!enCampo && (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey))) {
    e.preventDefault(); irA(Math.min(S.doc.paginas, S.pagina + 1)); return true;
  }
  if (!enCampo && (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey))) {
    e.preventDefault(); irA(Math.max(1, S.pagina - 1)); return true;
  }
  if (!enCampo && e.key === 'Home') { e.preventDefault(); irA(1); return true; }
  if (!enCampo && e.key === 'End') { e.preventDefault(); irA(S.doc.paginas); return true; }

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
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); deshacerTinta(); return true; }
  if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); rehacerTinta(); return true;
  }
  // Con el modo activo, los números eligen herramienta como en cualquier editor.
  if (V.tintaActiva && !enCampo && !e.ctrlKey && /^[1-4]$/.test(e.key)) {
    e.preventDefault();
    V.herramienta = Object.keys(HERRAMIENTAS)[+e.key - 1];
    pintarBarraTinta();
    return true;
  }
  return false;
}

export { irA, reescalar, abrirBusqueda };
