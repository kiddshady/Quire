/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el cartel de las actualizaciones

   Un solo overlay que MUTA entre estados en vez de una cadena de modales. El
   flujo real es uno solo —hay una nueva → la bajo → la instalo— y partirlo en
   tres carteles que aparecen y desaparecen lo haría sentir tres cosas
   distintas.

   Dos decisiones que hacen que no moleste:

   · **No se abre solo salvo que haya algo que hacer.** Un "estás al día" o un
     error de red en cada arranque es exactamente lo que hace que la gente
     termine odiando a los actualizadores. Esos estados solo se muestran si la
     búsqueda la pediste vos (`estado.manual`).
   · **Cerrarlo no cancela nada.** La descarga sigue, y la statusbar la muestra.

   El cross-fade entre pasos se apoya en que los dos pasos comparten la misma
   celda de un grid: se superponen mientras uno se va y el otro entra, así que
   la caja no salta aunque el contenido cambie de alto.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast } from './overlays.js';
import { exit } from './motion.js';
import { esc } from './ui.js';
import { fmtBytes } from './format.js';

const api = window.onyx;

let estado = { fase: 'inactivo', actual: '' };
let overlay = null;
/* La versión que ya se anunció sola en esta sesión: sin esto, cada búsqueda
   automática vuelve a tirarte el cartel de la misma versión en la cara. */
let anunciada = null;

/* ── El guion ────────────────────────────────────────────────────────────────
   Qué dice la pantalla en cada fase. Sin DOM a propósito: es la tabla de
   decisión de toda la función, y así se puede probar entera sin red. */

export function guion(e = {}) {
  const version = e.version || '';
  switch (e.fase) {
    case 'buscando':
      return { spinner: true, titulo: 'Buscando actualizaciones', sub: `Estás en Quire ${e.actual}`, acciones: [] };

    case 'al-dia':
      return {
        icono: 'check',
        titulo: 'Estás al día',
        sub: `Quire ${e.actual} es la última que hay.`,
        acciones: [{ id: 'cerrar', label: 'Listo', variant: 'primary' }],
      };

    case 'disponible':
      return {
        icono: 'download',
        titulo: e.nombre || `Quire ${version}`,
        sub: `Tenés la ${e.actual}${e.bytes ? ` · la nueva pesa ${fmtBytes(e.bytes)}` : ''}`,
        acciones: [
          { id: 'notas', label: 'Ver las notas', icono: 'external' },
          { id: 'despues', label: 'Después' },
          { id: 'descargar', label: 'Descargar', variant: 'primary' },
        ],
      };

    case 'descargando':
      return {
        barra: e.progreso?.pct ?? 0,
        titulo: `Bajando Quire ${version}`,
        sub: avance(e.progreso),
        acciones: [{ id: 'cerrar', label: 'Seguir en segundo plano' }],
      };

    case 'listo':
      return {
        icono: 'check',
        titulo: `Quire ${version} está lista`,
        sub: 'Se instala al reiniciar. Si preferís seguir, entra sola la próxima vez que cierres Quire.',
        acciones: [
          { id: 'cerrar', label: 'Después' },
          { id: 'instalar', label: 'Reiniciar e instalar', variant: 'primary' },
        ],
      };

    case 'error':
      return {
        icono: 'alert',
        tono: 'error',
        titulo: 'No se pudo comprobar',
        sub: e.error || 'Algo falló buscando la actualización.',
        acciones: [
          { id: 'cerrar', label: 'Cerrar' },
          { id: 'buscar', label: 'Reintentar', variant: 'primary' },
        ],
      };

    case 'sin-soporte':
      return {
        icono: 'info',
        titulo: 'Esta copia no se actualiza sola',
        sub: e.motivo || '',
        acciones: [
          { id: 'cerrar', label: 'Entendido' },
          { id: 'notas', label: 'Ir a las descargas', icono: 'external' },
        ],
      };

    default:
      return {
        icono: 'info',
        titulo: 'Actualizaciones',
        sub: `Estás en Quire ${e.actual}`,
        acciones: [{ id: 'buscar', label: 'Buscar ahora', variant: 'primary' }],
      };
  }
}

/** "42% · 39,4 MB de 93,8 MB · 2,1 MB/s" — mientras haya datos para decirlo. */
function avance(p) {
  if (!p || !p.total) return 'Empezando…';
  const partes = [`${Math.round((p.pct || 0) * 100)}%`, `${fmtBytes(p.transferido)} de ${fmtBytes(p.total)}`];
  if (p.bps > 0) partes.push(`${fmtBytes(p.bps)}/s`);
  return partes.join(' · ');
}

/* ── El paso, ya en DOM ─────────────────────────────────────────────────── */

/** Se exporta para poder pintar los siete estados en el test sin tocar la red. */
export function paso(e) {
  const g = guion(e);
  const el = document.createElement('div');
  el.className = `qr-act__paso${g.tono === 'error' ? ' qr-act__paso--error' : ''}`;
  el.dataset.fase = e.fase || 'inactivo';

  const marca = g.spinner
    ? `<div class="qr-act__marca">${Icons.spinner()}</div>`
    : g.icono ? `<div class="qr-act__marca">${Icons.svg(g.icono)}</div>` : '';

  /* La barra se escala con transform en vez de animar el ancho: el ancho
     remaqueta en cada frame, y esto llega veinte veces por segundo. */
  const barra = typeof g.barra === 'number'
    ? `<div class="qr-prog" role="progressbar"><div class="qr-prog__fill" style="--qr-pct:${g.barra.toFixed(4)}"></div></div>`
    : '';

  el.innerHTML = `
    ${marca}
    <div class="qr-act__titulo">${esc(g.titulo)}</div>
    <div class="qr-act__sub">${esc(g.sub)}</div>
    ${barra}
    <div class="qr-act__acciones">
      ${g.acciones.map((a) => `
        <button class="ox-btn ox-flashable ox-btn--${a.variant || 'ghost'}" data-accion="${a.id}">
          ${a.icono ? `<i data-icon="${a.icono}"></i>` : ''}${esc(a.label)}
        </button>`).join('')}
    </div>`;

  Icons.mount(el);
  return el;
}

/* ── El overlay ─────────────────────────────────────────────────────────── */

function capa() {
  let el = document.getElementById('ox-layer');
  if (!el) { el = document.createElement('div'); el.id = 'ox-layer'; document.body.appendChild(el); }
  return el;
}

export function abrir() {
  if (overlay) { repintar(); return; }

  const scrim = document.createElement('div');
  scrim.className = 'ox-scrim';

  const anim = document.createElement('div');
  anim.className = 'ox-modal__anim';

  const caja = document.createElement('div');
  caja.className = 'ox-modal qr-act';
  caja.style.width = 'min(440px, calc(100vw - 96px))';
  caja.setAttribute('role', 'dialog');
  caja.setAttribute('aria-modal', 'true');
  caja.innerHTML = `
    <div class="ox-modal__head">
      <div class="ox-grow"><div class="ox-modal__title">Actualizaciones</div></div>
      <button class="ox-iconbtn" data-accion="cerrar" data-tip="Cerrar" data-tip-key="Esc">${Icons.svg('close')}</button>
    </div>
    <div class="qr-act__cuerpo"></div>`;

  anim.appendChild(caja);
  capa().append(scrim, anim);
  Icons.mount(caja);

  scrim.addEventListener('click', cerrar);
  caja.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-accion]');
    if (b) accion(b.dataset.accion);
  });
  document.addEventListener('keydown', alTeclado, true);

  overlay = { scrim, anim, caja, cuerpo: caja.querySelector('.qr-act__cuerpo'), previo: document.activeElement };
  repintar();
}

export function cerrar() {
  if (!overlay) return;
  const { scrim, anim, previo } = overlay;
  overlay = null;
  document.removeEventListener('keydown', alTeclado, true);
  // exit() espera a que TERMINE la animación de salida; sin eso, parpadea.
  exit(scrim);
  exit(anim);
  previo?.focus?.();
}

function alTeclado(ev) {
  if (ev.key !== 'Escape' || !overlay) return;
  ev.preventDefault();
  ev.stopPropagation();
  cerrar();
}

/** Cambia el paso sin que la caja pegue un salto: los dos comparten celda. */
function repintar() {
  if (!overlay) return;
  const { cuerpo } = overlay;
  const viejo = cuerpo.querySelector('.qr-act__paso:not([data-state="closing"])');

  if (viejo?.dataset.fase === (estado.fase || 'inactivo') && estado.fase === 'descargando') {
    // Mismo paso, solo avanzó la descarga: mover la barra, no rehacer el paso.
    const fill = viejo.querySelector('.qr-prog__fill');
    if (fill) fill.style.setProperty('--qr-pct', (estado.progreso?.pct || 0).toFixed(4));
    const sub = viejo.querySelector('.qr-act__sub');
    if (sub) sub.textContent = avance(estado.progreso);
    return;
  }

  if (viejo) exit(viejo, { fallback: 320 });
  cuerpo.appendChild(paso(estado));
  setTimeout(() => overlay?.cuerpo.querySelector('.ox-btn--primary')?.focus(), 80);
}

async function accion(id) {
  switch (id) {
    case 'cerrar': case 'despues': cerrar(); break;
    case 'notas': window.open(estado.url, '_blank'); break;
    case 'buscar': await api.update.buscar({ manual: true }); break;
    case 'descargar': await api.update.descargar(); break;
    case 'instalar':
      cerrar();
      await api.update.instalar();
      break;
    default: break;
  }
}

/* ── La statusbar ────────────────────────────────────────────────────────────
   Lo que queda visible cuando cerrás el cartel: sin esto, una descarga de 90 MB
   pasa a ser invisible y el "listo para instalar" se pierde. */

function pintarStatus() {
  const el = document.getElementById('stat-update');
  if (!el) return;

  if (estado.fase === 'descargando') {
    el.hidden = false;
    el.dataset.tip = 'Bajando la actualización';
    el.innerHTML = `${Icons.svg('download', 'ox-icon--sm')}<span class="ox-statusbar__value ox-num">${Math.round((estado.progreso?.pct || 0) * 100)}%</span>`;
  } else if (estado.fase === 'listo') {
    el.hidden = false;
    el.dataset.tip = 'Reiniciá para instalarla';
    el.innerHTML = `${Icons.svg('zap', 'ox-icon--sm')}<span class="ox-statusbar__value">Quire ${esc(estado.version || '')} lista</span>`;
  } else if (estado.fase === 'disponible') {
    el.hidden = false;
    el.dataset.tip = 'Hay una versión nueva';
    el.innerHTML = `${Icons.svg('download', 'ox-icon--sm')}<span class="ox-statusbar__value">${esc(estado.version || '')}</span>`;
  } else {
    el.hidden = true;
    el.innerHTML = '';
  }
}

/* ── Arranque ───────────────────────────────────────────────────────────── */

/** El estado que ve el resto de la app (Ajustes lo muestra). */
export const leer = () => estado;

const oyentes = new Set();

/** Suscribirse a los cambios. Devuelve la baja, para pasársela a Router.onLeave. */
export function alCambiar(cb) {
  oyentes.add(cb);
  return () => oyentes.delete(cb);
}

export async function iniciar({ avisar = true } = {}) {
  const el = document.getElementById('stat-update');
  el?.addEventListener('click', abrir);

  api.update.onCambio(aplicar);
  estado = await api.update.estado().catch(() => estado);
  pintarStatus();

  if (!avisar || estado.fase === 'sin-soporte') return;

  /* Cuatro segundos: que el documento termine de abrirse primero. Buscar una
     actualización nunca puede competir con lo que el usuario vino a hacer. */
  setTimeout(() => api.update.buscar({ manual: false }).catch(() => {}), 4000);
}

function aplicar(nuevo) {
  const antes = estado.fase;
  estado = nuevo || estado;
  pintarStatus();
  if (overlay) repintar();
  for (const cb of oyentes) { try { cb(estado); } catch { /* un oyente roto no frena a los otros */ } }

  // Terminó de bajar con el cartel cerrado: avisar sin robar el foco.
  if (estado.fase === 'listo' && antes === 'descargando' && !overlay) {
    Toast.show({
      title: `Quire ${estado.version} está lista`,
      text: 'Reiniciá para instalarla.',
      icon: 'zap',
      duration: 9000,
    });
  }

  if (overlay) return;

  const hayQueHacerAlgo = estado.fase === 'disponible' || estado.fase === 'listo';
  const loPediste = estado.manual && ['al-dia', 'error', 'disponible', 'listo'].includes(estado.fase);

  if (loPediste || (hayQueHacerAlgo && anunciada !== estado.version)) {
    if (hayQueHacerAlgo) anunciada = estado.version;
    abrir();
  }
}
