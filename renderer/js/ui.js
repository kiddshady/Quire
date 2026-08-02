/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — helpers de vista
   Lo que necesitan todas las vistas: pintar, encabezar, escapar, y mostrar
   estado. Nada de acá sabe de tu dominio; si tenés que importar algo de tu app
   en este archivo, va en el tuyo.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast } from './overlays.js';
import { initScrollFades } from './motion.js';

/** El contenedor de la vista activa. Lazy: no asume cuándo corre este módulo. */
let _view = null;
export function viewEl() {
  if (!_view || !_view.isConnected) _view = document.getElementById('view');
  return _view;
}

/* ── Escape ──────────────────────────────────────────────────────────────────
   Estas vistas arman HTML con plantillas, así que TODO dato que venga de
   afuera pasa por acá. No es paranoia: el nombre de un archivo con un "<" ya
   alcanza para romper el layout, y un mensaje de error puede traer cualquier
   cosa. Cuando el dato es puro texto, preferí .textContent y ni pienses. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ── Estado: forma + luminancia + movimiento ─────────────────────────────────
   La pieza central del sistema. La FORMA dice qué es la cosa, la LUMINANCIA si
   está viva, y el MOVIMIENTO es exclusivo de lo que está corriendo ahora. Con
   eso alcanza para leer una pantalla entera sin un solo color — que es
   justamente el punto: el rojo queda libre para significar "se rompió". */

/** Formas disponibles. Sumá las tuyas mapeando tipo → forma. */
export const SHAPES = ['circle', 'square', 'diamond', 'hex'];

export const STATE_LABEL = {
  idle: 'Sin usar',
  queued: 'En cola',
  running: 'Corriendo',
  waiting: 'Esperando',
  done: 'Listo',
  skipped: 'Omitido',
  failed: 'Falló',
};

/** Renombrá los estados con las palabras de tu dominio. */
export function setStateLabels(map) {
  Object.assign(STATE_LABEL, map);
}

export function mark(state, shape = 'circle') {
  return `<span class="ox-mark ox-mark--${shape}" data-state="${esc(state)}">
    <span class="ox-mark__halo"></span><span class="ox-mark__core"></span></span>`;
}

export function status(state, { shape = 'circle', label } = {}) {
  return `<span class="ox-status" data-state="${esc(state)}">
    ${mark(state, shape)}<span>${esc(label ?? STATE_LABEL[state] ?? state)}</span></span>`;
}

/* ── Pintar ──────────────────────────────────────────────────────────────── */

/**
 * Reemplaza la vista. Monta los íconos declarativos y cablea los esfumados de
 * scroll: si pintás sin pasar por acá, los <i data-icon> quedan vacíos y los
 * bordes del scroll se cortan duro.
 */
export function paint(html) {
  const el = viewEl();
  el.innerHTML = html;
  Icons.mount(el);
  initScrollFades(el);
  return el;
}

/** Encabezado de vista: migas, título, subtítulo y acciones a la derecha. */
export function head({ title, sub, crumbs, actions = '' } = {}) {
  const crumbHTML = crumbs
    ? `<nav class="ox-crumbs">${crumbs
        .map((c, i) => (i ? '<i data-icon="chevronRight"></i>' : '')
          + `<span class="ox-crumbs__item"${c.view ? ` data-goto="${esc(c.view)}"` : ''}`
          + `${c.param ? ` data-param="${esc(c.param)}"` : ''}>${esc(c.label)}</span>`)
        .join('')}</nav>`
    : '';
  return `
    <div class="ox-viewhead">
      <div class="ox-viewhead__text ox-grow">
        ${crumbHTML}
        <div class="ox-viewhead__title">${esc(title)}</div>
        ${sub ? `<div class="ox-viewhead__sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="ox-viewhead__actions">${actions}</div>
    </div>`;
}

/** Estado vacío centrado — el que se usa cuando todavía no hay nada. */
export function empty({ icon = 'inbox', title, text, actions = '' } = {}) {
  return `<div class="ox-grow" style="display:grid;place-items:center">
    <div class="ox-empty">${Icons.svg(icon)}
      <div class="ox-empty__title">${esc(title)}</div>
      ${text ? `<div class="ox-empty__text">${esc(text)}</div>` : ''}
      ${actions ? `<div class="ox-row" style="gap:8px;margin-top:6px">${actions}</div>` : ''}
    </div></div>`;
}

/* ── Errores ─────────────────────────────────────────────────────────────────
   Toda acción que puede fallar pasa por acá. El punto no es "no romper": es
   que el error se VEA. Un catch vacío convierte un bug en un misterio. */
export async function attempt(fn, { errorTitle = 'No se pudo completar' } = {}) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[${errorTitle}]`, err);
    Toast.error(errorTitle, err?.message || String(err));
    return null;
  }
}

/** Copia al portapapeles y lo confirma — copiar en silencio no se siente. */
export async function copy(text, { label = 'Copiado' } = {}) {
  try {
    await navigator.clipboard.writeText(String(text));
    Toast.show({ title: label, text: String(text), icon: 'copy' });
    return true;
  } catch (err) {
    Toast.error('No se pudo copiar', err.message);
    return false;
  }
}
