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
  contenedor.classList.remove('is-pintada');

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
  if (cual === 'miniaturas') pintarMiniaturas();
  else pintarEsquema();
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
      <button class="ox-iconbtn ox-iconbtn--sm" id="qr-tinta-menu"
              data-tip="Más"><i data-icon="more"></i></button>
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

  document.getElementById('qr-tinta-menu')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [
      {
        label: `Borrar la tinta de la página ${S.pagina}`,
        icon: 'borrador',
        disabled: !S.tinta.trazos(S.pagina).length,
        onSelect: () => {
          S.tinta.limpiarPagina(S.pagina);
          V.editores.get(S.pagina)?.redibujar();
          actualizarBarraTinta();
        },
      },
      { sep: true },
      {
        label: 'Borrar toda la tinta del documento',
        icon: 'trash',
        danger: true,
        disabled: S.tinta.vacia,
        onSelect: async () => {
          const ok = await Modal.confirm({
            title: '¿Borrar toda la tinta?',
            sub: `Se van ${S.tinta.cuenta} trazos de ${S.tinta.paginasConTinta().length} páginas. El PDF no se toca — nunca se tocó.`,
            confirmLabel: 'Borrar todo',
            danger: true,
          });
          if (!ok) return;
          await S.tinta.borrarTodo();
          for (const ed of V.editores.values()) ed.redibujar();
          actualizarBarraTinta();
          Toast.show({ title: 'Tinta borrada', icon: 'borrador' });
        },
      },
    ], { align: 'end' });
  });
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
    if (que === 'documento') Router.refresh();
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
          <span class="ox-num" id="qr-pagina-total">${S.doc.paginas}</span>
        </div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="qr-next" data-tip="Página siguiente"><i data-icon="chevronDown"></i></button>

        <div class="ox-vr"></div>

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

export { irA, reescalar };
