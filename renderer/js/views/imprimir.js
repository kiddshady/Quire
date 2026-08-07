/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — imprimir
   El preview NO es una simulación: es el PDF impuesto de verdad, rasterizado
   con pdf.js. El mismo archivo que sale por la impresora. Por eso no puede
   mentir, y por eso todo cambio de control re-impone en vez de mover un dibujo.

   Lo único que el preview agrega encima es el marco del área no imprimible —
   el borde que el tóner no alcanza. Eso no está en el PDF porque no es del
   documento: es de la impresora.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar, emitir, impresoraActual, papelesDisponibles, aplicarPapel } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Menu, Modal } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc, attempt } from '../ui.js';
import { raf2, bindStepper } from '../motion.js';
import { plural } from '../format.js';
import { planCon, mm, aMM, papelParaElDriver } from '../imposicion/plan.js';
import { imponer, partirDuplex, extraerCaras } from '../imposicion/motor.js';
import { aplanarTinta, contarTinta } from '../tinta/aplanar.js';
import { abrirDocumento } from '../pdf/documento.js';

const api = window.onyx;

/* ── La tinta entra ANTES de imponer ─────────────────────────────────────────
   Así los trazos viajan con su página y terminan escalados, rotados y ubicados
   exactamente igual que el contenido — en un folleto, la anotación se dobla
   con la hoja. Si se aplanara después habría que rehacer toda la geometría de
   la imposición para la tinta, y sería otro camino que puede divergir.

   Se cachea por versión de la capa: reescribir el PDF entero en cada tecleo
   del campo de escala no aporta nada, la tinta no cambió. */
const cacheTinta = { version: -1, doc: null, bytes: null };

async function bytesParaImprimir() {
  if (!S.tinta || S.tinta.vacia) return S.doc.bytes;
  if (cacheTinta.doc === S.doc && cacheTinta.version === S.tinta.version) return cacheTinta.bytes;

  const bytes = await aplanarTinta(S.doc.bytes, S.tinta);
  cacheTinta.doc = S.doc;
  cacheTinta.version = S.tinta.version;
  cacheTinta.bytes = bytes;
  return bytes;
}

/* Cuántas hojas se generan para mirar. Más que esto no entra en pantalla y
   solo hace más lenta cada corrección de un número. */
const TOPE_PREVIEW = 24;

const V = {
  doc: null,          // el PDF impuesto, abierto con pdf.js
  bytes: null,
  calculo: null,
  hoja: 1,
  pendiente: null,
  render: null,
  generacion: 0,      // para descartar resultados de una imposición vieja
  imprimiendo: false,
};

/* ── El plan ─────────────────────────────────────────────────────────────── */

function planInicial() {
  const st = S.settings || {};
  const base = planCon({
    duplex: 'simplex',
    escala: { tipo: 'reducir', valor: 100 },
    respetarNoImprimible: st.mostrarNoImprimible !== false,
  });
  const papeles = papelesDisponibles();
  const preferido = papeles.find((p) => p.nombre === (st.papelDefecto || 'A4')) || papeles[0];
  return aplicarPapel(base, preferido?.id);
}

function plan() {
  if (!S.plan) S.plan = planInicial();
  return S.plan;
}

function cambiar(parche, { rehacer = true } = {}) {
  S.plan = { ...plan(), ...parche };
  if (rehacer) programarImposicion();
  pintarOpciones();
}

/* ── Imposición con debounce ─────────────────────────────────────────────── */

function programarImposicion() {
  clearTimeout(V.pendiente);
  marcarTrabajando(true);
  // 220 ms: alcanza para escribir "150" en el campo de escala sin que se
  // imponga tres veces, y no se siente como demora.
  V.pendiente = setTimeout(rehacerImposicion, 220);
}

async function rehacerImposicion() {
  if (!S.doc) return;
  const mio = ++V.generacion;

  try {
    const { bytes, calculo, parcial, generadas } = await imponer(
      await bytesParaImprimir(), plan(), S.geometrias, { limiteHojas: TOPE_PREVIEW }
    );
    if (mio !== V.generacion) return;   // llegó una imposición más nueva

    V.doc?.destruir();
    V.bytes = bytes;
    V.calculo = calculo;
    V.parcial = parcial;
    V.generadas = generadas;
    V.doc = await abrirDocumento(bytes, { nombre: 'preview.pdf' });
    V.hoja = Math.min(V.hoja, V.doc.paginas) || 1;

    if (mio !== V.generacion) { V.doc.destruir(); V.doc = null; return; }

    pintarHoja();
    pintarResumen();
  } catch (err) {
    if (mio !== V.generacion) return;
    console.error('[imprimir]', err);
    mostrarError(err.message);
  } finally {
    if (mio === V.generacion) marcarTrabajando(false);
  }
}

function marcarTrabajando(si) {
  document.getElementById('qr-preview')?.classList.toggle('is-trabajando', si);
}

function mostrarError(mensaje) {
  const cuerpo = document.getElementById('qr-preview-cuerpo');
  if (!cuerpo) return;
  cuerpo.innerHTML = `<div class="qr-preview__error">${Icons.svg('alert')}
    <span class="ox-label">No se pudo armar el pliego</span>
    <span class="ox-meta">${esc(mensaje)}</span></div>`;
}

/* ── Dibujar la hoja ─────────────────────────────────────────────────────── */

/* Dos cosas llaman a pintarHoja() casi a la vez al montar la vista: la
   imposición que termina y el ResizeObserver que se dispara con el primer
   observe(). Como la función es async (espera la geometría antes de tocar el
   DOM), las dos se cruzan: la segunda rehace el HTML y cancela el render de la
   primera, y si la cancelada es la última en resolver, el canvas se queda en
   opacity:0 y la hoja aparece EN BLANCO — con la clase is-pintada puesta, así
   que un test que solo mire la clase da verde igual.

   El token corta eso: solo el pintado más nuevo puede tocar el DOM. */
let generacionPintado = 0;

async function pintarHoja() {
  const cuerpo = document.getElementById('qr-preview-cuerpo');
  if (!cuerpo || !V.doc) return;

  const mio = ++generacionPintado;
  const g = await V.doc.geometria(V.hoja);
  if (mio !== generacionPintado) return;

  const caja = cuerpo.getBoundingClientRect();
  if (caja.width < 8 || caja.height < 8) return;   // todavía sin layout
  // 32 px de aire para que la hoja no toque los bordes del área de preview.
  const escala = Math.max(0.05, Math.min((caja.width - 64) / g.anchoPt, (caja.height - 64) / g.altoPt));

  const ancho = Math.round(g.anchoPt * escala);
  const alto = Math.round(g.altoPt * escala);

  cuerpo.innerHTML = `
    <div class="qr-pliego qr-pliego--preview" style="width:${ancho}px;height:${alto}px">
      <canvas class="qr-hoja"></canvas>
      ${marcoNoImprimible(g, escala)}
    </div>`;

  const canvas = cuerpo.querySelector('canvas');
  const pliego = cuerpo.querySelector('.qr-pliego');
  V.render?.cancelar();
  V.render = V.doc.render(V.hoja, { canvas, escala });
  V.render.promesa
    .then((r) => {
      // Solo el pintado vigente muestra su hoja: si este quedó viejo, su canvas
      // ya no está en el DOM y marcarlo pintado no significaría nada.
      if (r && mio === generacionPintado) pliego?.classList.add('is-pintada');
    })
    .catch((err) => { if (err?.name !== 'RenderingCancelledException') console.error(err); });

  pintarNavegacion();
}

/**
 * El marco de lo que el tóner no alcanza.
 *
 * Se dibuja como una banda sobre el papel, no como una línea: lo importante no
 * es dónde está el límite sino cuánta hoja queda afuera. Si algo del documento
 * cae en la banda, no se va a imprimir.
 */
function marcoNoImprimible(g, escala) {
  const p = plan();
  if (!p.imprimible || !S.settings?.mostrarNoImprimible) return '';

  const papelApaisado = g.anchoPt > g.altoPt;
  const naturalApaisado = p.papel.ancho > p.papel.alto;
  const im = p.imprimible;
  const [ix, iy, iw, ih] = papelApaisado !== naturalApaisado
    ? [im.y, im.x, im.alto, im.ancho]
    : [im.x, im.y, im.ancho, im.alto];

  const px = (v) => `${(mm(v) * escala).toFixed(2)}px`;
  const izq = mm(ix) * escala;
  const arriba = mm(iy) * escala;
  const der = g.anchoPt * escala - izq - mm(iw) * escala;
  const abajo = g.altoPt * escala - arriba - mm(ih) * escala;

  return `<div class="qr-noimprimible" aria-hidden="true"
    style="border-top-width:${arriba.toFixed(2)}px;border-right-width:${der.toFixed(2)}px;
           border-bottom-width:${abajo.toFixed(2)}px;border-left-width:${izq.toFixed(2)}px"
    data-tip="El tóner no llega a esta banda"></div>`;
}

function pintarNavegacion() {
  const nav = document.getElementById('qr-preview-nav');
  if (!nav || !V.doc || !V.calculo) return;

  const total = V.calculo.hojas.length;
  const hoja = V.calculo.hojas[V.hoja - 1];
  const cara = hoja?.cara ? (hoja.cara === 'frente' ? 'frente' : 'dorso') : null;
  const etiqueta = hoja?.etiquetaPoster
    ? `pág. ${esc(hoja.etiquetaPoster)}`
    : cara ? `${cara} de la hoja ${Math.ceil(V.hoja / 2)}` : '';

  nav.innerHTML = `
    <button class="ox-iconbtn ox-iconbtn--sm" id="qr-hoja-prev" ${V.hoja <= 1 ? 'disabled' : ''}
            data-tip="Hoja anterior"><i data-icon="chevronLeft"></i></button>
    <span class="qr-preview__cuenta">
      <span class="ox-num">${V.hoja}</span>
      <span class="ox-dim">de ${V.parcial ? `${V.generadas} <span class="ox-dim2">(de ${total})</span>` : total}</span>
    </span>
    <button class="ox-iconbtn ox-iconbtn--sm" id="qr-hoja-next" ${V.hoja >= V.doc.paginas ? 'disabled' : ''}
            data-tip="Hoja siguiente"><i data-icon="chevronRight"></i></button>
    ${etiqueta ? `<span class="ox-chip">${etiqueta}</span>` : ''}`;

  Icons.mount(nav);
  nav.querySelector('#qr-hoja-prev')?.addEventListener('click', () => irAHoja(V.hoja - 1));
  nav.querySelector('#qr-hoja-next')?.addEventListener('click', () => irAHoja(V.hoja + 1));
}

function irAHoja(n) {
  if (!V.doc) return;
  V.hoja = Math.max(1, Math.min(V.doc.paginas, n));
  pintarHoja();
}

/* ── Resumen ─────────────────────────────────────────────────────────────── */

function pintarResumen() {
  const el = document.getElementById('qr-resumen');
  if (!el || !V.calculo) return;

  const r = V.calculo.resumen;
  const p = plan();
  const copias = Math.max(1, p.copias || 1);
  const hojasTotales = r.hojasFisicas * copias;

  el.innerHTML = `
    <div class="qr-resumen__cifra">
      <span class="ox-stat__value ox-num">${hojasTotales}</span>
      <span class="ox-stat__label">${plural(hojasTotales, 'hoja de papel', 'hojas de papel')}</span>
    </div>
    <div class="ox-kv qr-resumen__kv">
      <span class="ox-kv__k">Páginas</span><span class="ox-kv__v ox-num">${r.paginasOriginales}</span>
      <span class="ox-kv__k">Caras</span><span class="ox-kv__v ox-num">${r.hojas}${copias > 1 ? ` × ${copias}` : ''}</span>
      <span class="ox-kv__k">Papel</span><span class="ox-kv__v">${esc(p.papel.nombre)}${V.calculo.papel.apaisado ? ' apaisado' : ''}</span>
      ${contarTinta(S.tinta) ? `<span class="ox-kv__k">Tinta</span>
        <span class="ox-kv__v">${contarTinta(S.tinta)} trazos, incluidos</span>` : ''}
    </div>
    ${r.desborde ? `
      <div class="qr-aviso">
        ${Icons.svg('alert', 'ox-icon--sm')}
        <span>Hay contenido fuera del área imprimible: eso no va a salir en el papel.
        Pasá la escala a <b>Ajustar</b> o desactivá el respeto del margen.</span>
      </div>` : ''}`;
  Icons.mount(el);
}

/* ── Opciones ────────────────────────────────────────────────────────────── */

const MODOS = [
  { id: 'simple', label: 'Simple', icono: 'file' },
  { id: 'nup', label: 'Múltiple', icono: 'nup' },
  { id: 'folleto', label: 'Folleto', icono: 'folleto' },
  { id: 'poster', label: 'Póster', icono: 'poster' },
];

const ESCALAS = [
  { id: 'ajustar', label: 'Ajustar' },
  { id: 'reducir', label: 'Solo reducir' },
  { id: 'real', label: 'Tamaño real' },
  { id: 'custom', label: 'Personalizada' },
];

function pintarOpciones() {
  const el = document.getElementById('qr-opciones');
  if (!el) return;
  const p = plan();
  const imp = impresoraActual();

  el.innerHTML = `
    <div class="qr-op">
      <span class="ox-eyebrow">Impresora</span>
      <button class="ox-select" id="op-impresora">
        <span class="ox-truncate">${esc(S.impresora || 'Ninguna')}</span><i data-icon="chevronDown"></i>
      </button>
      ${imp?.soloMonocromo ? '<span class="ox-meta">Esta impresora es solo blanco y negro.</span>' : ''}
    </div>

    <div class="qr-op qr-op--par">
      <div class="ox-field">
        <label class="ox-field__label">Copias</label>
        <div class="ox-stepper" id="op-copias-stepper">
          <input class="ox-input ox-num" id="op-copias" type="number" min="1" max="${imp?.maxCopias || 999}"
                 value="${p.copias}">
          <div class="ox-stepper__btns">
            <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
            <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
          </div>
        </div>
      </div>
      <div class="ox-field">
        <label class="ox-field__label">Papel</label>
        <button class="ox-select" id="op-papel">
          <span class="ox-truncate">${esc(p.papel.nombre)}</span><i data-icon="chevronDown"></i>
        </button>
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Qué se imprime</span>
      <div class="ox-row" style="gap:8px">
        <button class="ox-select ox-grow" id="op-rango">
          <span>${p.rango === 'todo' ? 'Todas las páginas' : esc(p.rango)}</span><i data-icon="chevronDown"></i>
        </button>
      </div>
      <div class="ox-segmented" id="op-subconjunto">
        ${[['todas', 'Todas'], ['impares', 'Impares'], ['pares', 'Pares']].map(([id, l]) =>
    `<button class="ox-segmented__opt${p.subconjunto === id ? ' is-active' : ''}" data-value="${id}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Disposición</span>
      <div class="qr-modos" id="op-modo">
        ${MODOS.map((m) => `
          <button class="qr-modo${p.modo === m.id ? ' is-active' : ''}" data-value="${m.id}" data-tip="${m.label}">
            <i data-icon="${m.icono}"></i><span>${m.label}</span>
          </button>`).join('')}
      </div>
      ${opcionesDelModo(p)}
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Escala y orientación</span>
      <div class="ox-field">
        <button class="ox-select" id="op-escala">
          <span>${ESCALAS.find((e) => e.id === p.escala.tipo)?.label || 'Ajustar'}</span><i data-icon="chevronDown"></i>
        </button>
      </div>
      ${p.escala.tipo === 'custom' ? `
        <div class="ox-row" style="gap:10px;align-items:center">
          <input class="ox-slider ox-grow" id="op-escala-valor" type="range" min="10" max="400" step="1"
                 value="${p.escala.valor}" style="--ox-pct:${((p.escala.valor - 10) / 390 * 100).toFixed(1)}%">
          <span class="ox-chip ox-chip--mono" id="op-escala-eco">${p.escala.valor}%</span>
        </div>` : ''}
      <div class="ox-segmented" id="op-orientacion">
        ${[['auto', 'Automática'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']].map(([id, l]) =>
    `<button class="ox-segmented__opt${p.orientacion === id ? ' is-active' : ''}" data-value="${id}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Ambas caras</span>
      <div class="ox-segmented" id="op-duplex">
        ${[['simplex', 'Una cara'], ['largo', 'Lado largo'], ['corto', 'Lado corto']].map(([id, l]) =>
    `<button class="ox-segmented__opt${p.duplex === id ? ' is-active' : ''}" data-value="${id}">${l}</button>`).join('')}
      </div>
      ${p.duplex !== 'simplex' ? `
        <span class="ox-meta">
          ${S.settings?.duplexAsistido
    ? 'Quire imprime los frentes, te muestra cómo va el fajo de vuelta a la bandeja, y manda los dorsos en el orden correcto.'
    : 'Se lo pide al driver. Si tu impresora no tiene unidad dúplex, va a mostrar su propio cartel.'}
        </span>` : ''}
    </div>

    <div class="qr-op">
      <label class="ox-row" style="gap:12px;align-items:flex-start">
        <button class="ox-switch${p.respetarNoImprimible ? ' is-on' : ''}" id="op-margen"></button>
        <span class="ox-col" style="gap:2px">
          <span class="ox-label">Respetar el área imprimible</span>
          <span class="ox-meta">Ajusta el contenido a donde el tóner llega de verdad${
  p.imprimible ? ` (${aMM(mm(p.imprimible.ancho)).toFixed(0)} × ${aMM(mm(p.imprimible.alto)).toFixed(0)} mm)` : ''}.</span>
        </span>
      </label>
    </div>`;

  Icons.mount(el);
  cablearOpciones();
}

function opcionesDelModo(p) {
  if (p.modo === 'nup') {
    const grillas = [[1, 2], [2, 2], [2, 3], [3, 3], [4, 4]];
    return `
      <div class="ox-field">
        <label class="ox-field__label">Páginas por hoja</label>
        <div class="qr-grillas" id="op-nup-grilla">
          ${grillas.map(([f, c]) => `
            <button class="qr-grilla${p.nup.filas === f && p.nup.columnas === c ? ' is-active' : ''}"
                    data-filas="${f}" data-columnas="${c}">
              <span class="qr-grilla__n ox-num">${f * c}</span>
              <span class="ox-meta">${c}×${f}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="ox-field">
        <label class="ox-field__label">Orden</label>
        <button class="ox-select" id="op-nup-orden">
          <span>${{ horizontal: 'Horizontal', 'horizontal-inv': 'Horizontal invertido', vertical: 'Vertical', 'vertical-inv': 'Vertical invertido' }[p.nup.orden]}</span>
          <i data-icon="chevronDown"></i>
        </button>
      </div>
      <label class="ox-row" style="gap:12px">
        <button class="ox-switch${p.nup.borde ? ' is-on' : ''}" id="op-nup-borde"></button>
        <span class="ox-label">Dibujar el borde de cada página</span>
      </label>`;
  }

  if (p.modo === 'folleto') {
    return `
      <div class="ox-field">
        <label class="ox-field__label">Encuadernación</label>
        <div class="ox-segmented" id="op-folleto-lado">
          ${[['izquierda', 'Izquierda'], ['derecha', 'Derecha']].map(([id, l]) =>
    `<button class="ox-segmented__opt${p.folleto.encuadernacion === id ? ' is-active' : ''}" data-value="${id}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="ox-field">
        <label class="ox-field__label">Hojas por cuadernillo</label>
        <button class="ox-select" id="op-folleto-cuadernillo">
          <span>${p.folleto.porCuadernillo ? `${p.folleto.porCuadernillo} hojas` : 'Uno solo'}</span>
          <i data-icon="chevronDown"></i>
        </button>
        <span class="ox-field__hint">Un cuadernillo muy grueso no cierra bien al doblarlo.</span>
      </div>`;
  }

  if (p.modo === 'poster') {
    return `
      <div class="ox-field">
        <label class="ox-field__label">Agrandar a</label>
        <div class="ox-row" style="gap:10px;align-items:center">
          <input class="ox-slider ox-grow" id="op-poster-escala" type="range" min="100" max="1000" step="10"
                 value="${p.poster.escala}" style="--ox-pct:${((p.poster.escala - 100) / 900 * 100).toFixed(1)}%">
          <span class="ox-chip ox-chip--mono" id="op-poster-eco">${p.poster.escala}%</span>
        </div>
      </div>
      <div class="ox-field">
        <label class="ox-field__label">Solape entre hojas</label>
        <div class="ox-row" style="gap:10px;align-items:center">
          <input class="ox-slider ox-grow" id="op-poster-solape" type="range" min="0" max="30" step="1"
                 value="${p.poster.solape}" style="--ox-pct:${(p.poster.solape / 30 * 100).toFixed(1)}%">
          <span class="ox-chip ox-chip--mono" id="op-poster-solape-eco">${p.poster.solape} mm</span>
        </div>
        <span class="ox-field__hint">Material repetido para pegar sin que quede una línea blanca.</span>
      </div>
      <label class="ox-row" style="gap:12px">
        <button class="ox-switch${p.poster.marcas ? ' is-on' : ''}" id="op-poster-marcas"></button>
        <span class="ox-label">Marcas de corte en las esquinas</span>
      </label>`;
  }

  return '';
}

/* ── Cableado ────────────────────────────────────────────────────────────── */

function cablearOpciones() {
  const $ = (id) => document.getElementById(id);
  const p = plan();

  $('op-impresora')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, S.impresoras.map((x) => ({
      label: x.etiqueta, icon: 'printer', selected: x.nombre === S.impresora,
      hint: x.predeterminada ? 'del sistema' : '',
      onSelect: async () => {
        S.impresora = x.nombre;
        await api.settings.save({ impresora: x.nombre }).catch(() => {});
        // Cambiar de impresora cambia los papeles y el área imprimible.
        S.plan = aplicarPapel(plan(), plan().papel.id);
        emitir('impresoras');
        pintarOpciones();
        programarImposicion();
      },
    })), { align: 'start' });
  });

  $('op-papel')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, papelesDisponibles().map((x) => ({
      label: x.nombre,
      hint: `${x.ancho} × ${x.alto} mm`,
      selected: x.id === p.papel.id,
      onSelect: () => { S.plan = aplicarPapel(plan(), x.id); pintarOpciones(); programarImposicion(); },
    })), { align: 'start' });
  });

  /* Las flechas son nuestras, pero el que manda sigue siendo el input: bindStepper
     despacha 'change' sobre él, así que este listener no se entera de la
     diferencia entre escribir el número y apretar la flecha. */
  bindStepper($('op-copias-stepper'));
  $('op-copias')?.addEventListener('change', (e) => {
    cambiar({ copias: Math.max(1, parseInt(e.target.value, 10) || 1) }, { rehacer: false });
    pintarResumen();
  });

  $('op-rango')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [
      { label: 'Todas las páginas', selected: p.rango === 'todo', onSelect: () => cambiar({ rango: 'todo' }) },
      { label: `Solo la página ${S.pagina}`, onSelect: () => cambiar({ rango: String(S.pagina) }) },
      { sep: true },
      { label: 'Escribir un rango…', icon: 'edit', onSelect: pedirRango },
    ], { align: 'start' });
  });

  segmentado('op-subconjunto', (v) => cambiar({ subconjunto: v }));
  segmentado('op-orientacion', (v) => cambiar({ orientacion: v }));
  segmentado('op-duplex', (v) => cambiar({ duplex: v }));
  segmentado('op-folleto-lado', (v) => cambiar({ folleto: { ...p.folleto, encuadernacion: v } }));

  $('op-modo')?.querySelectorAll('.qr-modo').forEach((b) => {
    b.addEventListener('click', () => {
      const modo = b.dataset.value;
      const parche = { modo };
      /* Un folleto sin dúplex son dos pilas sueltas que hay que intercalar a
         mano. Si la impresora puede, se prende solo. */
      if (modo === 'folleto' && p.duplex === 'simplex' && impresoraActual()?.soportaDuplex) {
        parche.duplex = 'largo';
      }
      cambiar(parche);
    });
  });

  $('op-escala')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, ESCALAS.map((x) => ({
      label: x.label, selected: p.escala.tipo === x.id,
      onSelect: () => cambiar({ escala: { ...p.escala, tipo: x.id } }),
    })), { align: 'start' });
  });

  deslizador('op-escala-valor', 'op-escala-eco', (v) => `${v}%`, 10, 390,
    (v) => cambiar({ escala: { ...plan().escala, valor: v } }, { rehacer: false }));

  $('op-margen')?.addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('is-on');
    e.currentTarget.classList.toggle('is-on', on);
    cambiar({ respetarNoImprimible: on });
  });

  /* N-up */
  $('op-nup-grilla')?.querySelectorAll('.qr-grilla').forEach((b) => {
    b.addEventListener('click', () => cambiar({
      nup: { ...plan().nup, filas: +b.dataset.filas, columnas: +b.dataset.columnas },
    }));
  });
  $('op-nup-orden')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [
      ['horizontal', 'Horizontal'], ['horizontal-inv', 'Horizontal invertido'],
      ['vertical', 'Vertical'], ['vertical-inv', 'Vertical invertido'],
    ].map(([id, l]) => ({
      label: l, selected: plan().nup.orden === id,
      onSelect: () => cambiar({ nup: { ...plan().nup, orden: id } }),
    })), { align: 'start' });
  });
  $('op-nup-borde')?.addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('is-on');
    e.currentTarget.classList.toggle('is-on', on);
    cambiar({ nup: { ...plan().nup, borde: on } });
  });

  /* Folleto */
  $('op-folleto-cuadernillo')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, [0, 1, 2, 4, 8].map((n) => ({
      label: n ? `${plural(n, 'hoja', 'hojas')}` : 'Uno solo',
      selected: plan().folleto.porCuadernillo === n,
      onSelect: () => cambiar({ folleto: { ...plan().folleto, porCuadernillo: n } }),
    })), { align: 'start' });
  });

  /* Póster */
  deslizador('op-poster-escala', 'op-poster-eco', (v) => `${v}%`, 100, 900,
    (v) => cambiar({ poster: { ...plan().poster, escala: v } }, { rehacer: false }));
  deslizador('op-poster-solape', 'op-poster-solape-eco', (v) => `${v} mm`, 0, 30,
    (v) => cambiar({ poster: { ...plan().poster, solape: v } }, { rehacer: false }));
  $('op-poster-marcas')?.addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('is-on');
    e.currentTarget.classList.toggle('is-on', on);
    cambiar({ poster: { ...plan().poster, marcas: on } });
  });
}

function segmentado(id, alElegir) {
  const el = document.getElementById(id);
  el?.querySelectorAll('.ox-segmented__opt').forEach((b) => {
    b.addEventListener('click', () => {
      el.querySelectorAll('.ox-segmented__opt').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      alElegir(b.dataset.value);
    });
  });
}

/**
 * Un slider que actualiza su eco en cada movimiento pero solo re-impone al
 * soltarlo: imponer en cada píxel del arrastre haría que se trabe.
 */
function deslizador(idInput, idEco, formato, min, rango, alCambiarValor) {
  const input = document.getElementById(idInput);
  const eco = document.getElementById(idEco);
  if (!input) return;
  input.addEventListener('input', () => {
    const v = +input.value;
    input.style.setProperty('--ox-pct', `${((v - min) / rango * 100).toFixed(1)}%`);
    if (eco) eco.textContent = formato(v);
    alCambiarValor(v);
  });
  input.addEventListener('change', () => programarImposicion());
}

async function pedirRango() {
  const cuerpo = document.createElement('div');
  cuerpo.className = 'ox-field';
  cuerpo.innerHTML = `
    <label class="ox-field__label">Páginas</label>
    <input class="ox-input ox-input--mono" spellcheck="false" placeholder="1-7, 12, 20-">
    <span class="ox-field__hint">Tramos y sueltas separadas por coma. Un tramo al revés
      (<span class="ox-mono">9-5</span>) sale al revés. Sobre ${S.doc.paginas} páginas.</span>`;
  const input = cuerpo.querySelector('input');
  input.value = plan().rango === 'todo' ? '' : plan().rango;

  const ok = await Modal.show({
    title: 'Rango de páginas',
    body: cuerpo,
    width: 440,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Aplicar', value: true, variant: 'primary', autofocus: true }],
  });
  if (!ok) return;
  cambiar({ rango: input.value.trim() || 'todo' });
}

/* ── Imprimir de verdad ──────────────────────────────────────────────────── */

async function imprimirAhora() {
  if (V.imprimiendo || !S.doc) return;
  if (!S.impresora) return Toast.error('No hay impresora elegida', 'Elegí una arriba de todo.');

  V.imprimiendo = true;
  const boton = document.getElementById('qr-imprimir');
  boton?.setAttribute('disabled', '');
  const original = boton?.innerHTML;
  if (boton) boton.innerHTML = `${Icons.spinner()} Armando el pliego…`;

  try {
    // Se impone COMPLETO: el preview mostraba solo las primeras hojas.
    const { bytes, calculo } = await imponer(await bytesParaImprimir(), plan(), S.geometrias);
    const p = plan();
    /* La hoja del CÁLCULO, no la del plan: `p.papel` es el nominal y siempre
       está vertical, mientras que un folleto o un N-up apaisado salen
       acostados. Declarar el nominal era mandarle al driver un tamaño que no
       era el de las páginas del archivo.

       Del par que devuelve papelParaElDriver solo viaja el nombre: la
       orientación la saca el ayudante de las páginas del PDF, y el intercalado
       de copias lo decide el driver — no hay por dónde pedirlo. */
    const hoja = papelParaElDriver(calculo.papel);
    const comun = {
      deviceName: S.impresora,
      copies: p.copias,
      pageSize: hoja.pageSize,
    };

    const asistido = p.duplex !== 'simplex' && S.settings?.duplexAsistido;
    if (asistido && calculo.hojas.length > 1) {
      await imprimirDuplexAsistido(bytes, calculo, comun, p);
    } else {
      if (boton) boton.innerHTML = `${Icons.spinner()} Mandando a la impresora…`;
      const r = await api.print.imprimir(bytes, {
        ...comun,
        duplexMode: p.duplex === 'simplex' ? 'simplex' : p.duplex === 'corto' ? 'shortEdge' : 'longEdge',
        etiqueta: p.modo,
      });
      if (r?.cancelado) return;
      Toast.show({
        title: 'Mandado a imprimir',
        text: `${plural(calculo.resumen.hojasFisicas * p.copias, 'hoja', 'hojas')} · ${S.impresora}`,
        icon: 'printer',
      });
    }
  } catch (err) {
    console.error('[imprimir]', err);
    Toast.error('No se pudo imprimir', err.message);
  } finally {
    V.imprimiendo = false;
    boton?.removeAttribute('disabled');
    if (boton && original) boton.innerHTML = original;
  }
}

/**
 * Dúplex en dos pasadas, manejado por nosotros.
 *
 * El orden de la vuelta es lo que más se equivoca: al dar vuelta la pila, la
 * hoja que quedó arriba es la ÚLTIMA que salió. Por eso los dorsos se mandan
 * invertidos (ver partirDuplex). Y por eso el diálogo del medio muestra un
 * dibujo en vez de solo texto: "dalo vuelta" admite cuatro interpretaciones y
 * tres están mal.
 */
async function imprimirDuplexAsistido(bytes, calculo, comun, p) {
  const { frentes, dorsos, hojasDePapel } = partirDuplex(calculo.hojas.length);

  const pdfFrentes = await extraerCaras(bytes, frentes);
  const r1 = await api.print.imprimir(pdfFrentes, { ...comun, duplexMode: 'simplex', etiqueta: 'frentes' });
  if (r1?.cancelado) return;

  const seguir = await Modal.show({
    title: 'Ahora volvé a cargar el fajo',
    sub: `Salieron ${plural(hojasDePapel, 'hoja', 'hojas')}. Sacalas de la bandeja de salida SIN cambiarles el orden.`,
    body: diagramaVuelta(p.duplex),
    width: 520,
    dismissible: false,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Listo, imprimir los dorsos', value: true, variant: 'primary', autofocus: true },
    ],
  });
  if (!seguir) {
    Toast.show({ title: 'Quedaron los frentes', text: 'Los dorsos no se mandaron.', icon: 'info' });
    return;
  }

  const pdfDorsos = await extraerCaras(bytes, dorsos);
  const r2 = await api.print.imprimir(pdfDorsos, { ...comun, duplexMode: 'simplex', etiqueta: 'dorsos' });
  if (r2?.cancelado) return;

  Toast.show({
    title: 'Listo',
    text: `${plural(hojasDePapel, 'hoja impresa', 'hojas impresas')} de los dos lados.`,
    icon: 'check',
  });
}

/**
 * El dibujo de cómo va el papel de vuelta. Todo SVG propio.
 *
 * ── Esto lo corrigió el papel, no la teoría ──────────────────────────────────
 * Hasta el 2 ago 2026 este cartel decía "girala por el lado largo, como si
 * pasaras la hoja de un cuaderno" — que es lo que dicen casi todos los drivers,
 * y que en la P1102w está MAL. Falla de la peor manera posible: la segunda
 * pasada imprime los dorsos ENCIMA de los frentes y se pierde el fajo entero.
 *
 * El movimiento correcto sale de dos hechos del recorrido del papel:
 *
 *   1. La bandeja carga BOCA ARRIBA (se imprime la cara que mira al techo) y la
 *      hoja sale BOCA ABAJO, porque el recorrido le da una vuelta de campana
 *      alrededor del fusor. O sea: cuando la agarrás, la cara en blanco ya está
 *      mirando para arriba. Darla vuelta es exactamente lo que la arruina.
 *
 *   2. Esa misma vuelta de campana deja el borde de cabecera del lado de acá.
 *      Para que el dorso salga con la cabeza en el MISMO borde que el frente
 *      —que es lo que significa encuadernar por el lado largo— ese borde tiene
 *      que volver a entrar primero: girar 180° EN EL PLANO, como un volante,
 *      sin despegar la hoja de la mesa.
 *
 * De ahí salen las dos únicas variantes, que son complementarias porque la
 * diferencia entre encuadernar por un lado o por el otro ES, exactamente, ese
 * giro de 180°:
 *
 *      lado largo → girar media vuelta en el plano
 *      lado corto → no girar, entra tal como salió
 *
 * En las dos, la pila NUNCA se da vuelta. Por eso el dibujo marca el borde de
 * cabecera con un triángulo: es lo único que se mueve, y es lo que distingue
 * "girar" de "dar vuelta". El texto impreso va punteado en las dos pilas porque
 * en las dos queda del lado de abajo — lo que se intuye a través de la hoja, no
 * lo que se ve.
 */
function diagramaVuelta(duplex) {
  const porElLargo = duplex !== 'corto';
  const cuerpo = document.createElement('div');
  cuerpo.className = 'qr-vuelta';

  /* La pila de la derecha es la misma hoja después del movimiento. Con el giro,
     el texto del dorso queda cabeza abajo y la marca pasa al borde de abajo. */
  const fantasmaDerecha = porElLargo
    ? 'M210 46h26M194 56h42M194 66h42'
    : 'M194 46h42M194 56h42M194 66h26';
  const marcaDerecha = porElLargo
    ? 'M207 96h16l-8-9z'
    : 'M207 16h16l-8 9z';

  cuerpo.innerHTML = `
    <svg class="qr-vuelta__svg" viewBox="0 0 260 124" aria-hidden="true">
      <g class="qr-vuelta__pila">
        <rect x="14" y="26" width="62" height="80" rx="3"/>
        <rect x="18" y="21" width="62" height="80" rx="3"/>
        <rect x="22" y="16" width="62" height="80" rx="3"/>
        <path class="qr-vuelta__fantasma" d="M32 46h42M32 56h42M32 66h26"/>
        <path class="qr-vuelta__marca" d="M45 16h16l-8 9z"/>
      </g>
      <g class="qr-vuelta__flecha">
        ${porElLargo
    /* Flecha circular cerrada sobre su eje: gira en el lugar, no se levanta. */
    ? '<path d="M141 41A22 22 0 1 1 119 41"/><path d="M114.3 47.8L119 41L110.8 41.7"/>'
      + '<circle class="qr-vuelta__eje" cx="130" cy="60" r="1.6"/>'
    : '<path d="M108 60h38"/><path d="M138 52l8 8-8 8"/>'}
      </g>
      <g class="qr-vuelta__pila qr-vuelta__pila--vuelta">
        <rect x="176" y="26" width="62" height="80" rx="3"/>
        <rect x="180" y="21" width="62" height="80" rx="3"/>
        <rect x="184" y="16" width="62" height="80" rx="3"/>
        <path class="qr-vuelta__fantasma" d="${fantasmaDerecha}"/>
        <path class="qr-vuelta__marca" d="${marcaDerecha}"/>
      </g>
    </svg>
    <div class="qr-vuelta__texto">
      <p><b>No las des vuelta.</b> Salieron con la cara impresa para abajo, así que la cara
      en blanco ya está mirando para arriba — y esa es la que se imprime. Pasarlas como la
      hoja de un cuaderno es el error clásico: los dorsos caen encima de los frentes.</p>
      ${porElLargo
    ? `<p><b>Giralas media vuelta apoyadas en la mesa</b>, como un volante y sin levantarlas:
       el borde que te quedó cerca es el que tiene que entrar primero.</p>`
    : `<p><b>No las gires:</b> entran tal como salieron, con el mismo borde hacia la
       impresora.</p>`}
      <p class="ox-meta">Tampoco les cambies el orden: los dorsos ya se mandaron invertidos
      porque la bandeja toma de arriba. Verificado en una HP LaserJet P1102w, que saca la hoja
      boca abajo; si la tuya la saca boca arriba, además hay que darlas vuelta.</p>
    </div>`;
  return cuerpo;
}

/* ── La vista ────────────────────────────────────────────────────────────── */

export function viewImprimir() {
  // Antes del early return: la pantalla vacía tiene que reaccionar cuando
  // aparece un documento (ver la nota en lector.js).
  Router.onLeave(alCambiar((que) => { if (que === 'documento') Router.refresh(); }));

  if (!S.doc) {
    paint(head({ title: 'Imprimir' }) + empty({
      icon: 'printer',
      title: 'No hay ningún documento abierto',
      text: 'Abrí un PDF y volvé acá. Vas a poder armar folletos, poner varias páginas por hoja, partir una página en varias hojas, y ver exactamente qué va a salir en el papel.',
      actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
    }));
    return;
  }

  paint(head({
    title: 'Imprimir',
    sub: esc(S.doc.nombre),
    crumbs: [{ label: 'Documento', view: 'lector' }, { label: 'Imprimir' }],
  }) + `
    <div class="ox-viewbody">
      <div class="ox-viewbody__main">
        <div class="qr-preview" id="qr-preview">
          <div class="qr-preview__cuerpo" id="qr-preview-cuerpo"></div>
          <div class="qr-preview__nav" id="qr-preview-nav"></div>
        </div>
      </div>

      <aside class="ox-inspector qr-inspector">
        <div class="ox-inspector__body" id="qr-opciones"></div>
        <div class="ox-inspector__foot qr-pie">
          <div class="qr-resumen" id="qr-resumen"></div>
          <button class="ox-btn ox-btn--primary ox-flashable qr-pie__boton" id="qr-imprimir">
            <i data-icon="printer"></i> Imprimir
          </button>
        </div>
      </aside>
    </div>`);

  pintarOpciones();
  document.getElementById('qr-imprimir')?.addEventListener('click', imprimirAhora);

  V.hoja = 1;
  raf2(() => rehacerImposicion());

  // El preview se re-encaja cuando cambia el tamaño disponible.
  const ro = new ResizeObserver(() => { if (V.doc) pintarHoja(); });
  const cuerpo = document.getElementById('qr-preview-cuerpo');
  if (cuerpo) ro.observe(cuerpo);

  Router.onLeave(() => {
    ro.disconnect();
    clearTimeout(V.pendiente);
    V.render?.cancelar();
    V.generacion++;              // invalida cualquier imposición en vuelo
    V.doc?.destruir();
    V.doc = null;
  });
}

export { imprimirAhora };
