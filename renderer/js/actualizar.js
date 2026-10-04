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
   celda de un grid: se superponen mientras uno se va y el otro entra. Si el
   nuevo es más alto (o más bajo), el alto de la caja viaja en vez de saltar,
   y el que se va queda clavado en su lugar mientras tanto.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast } from './overlays.js';
import { exit, swap, deslizarAlto, deslizarAncho } from './motion.js';
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

/* ── Números que corren ──────────────────────────────────────────────────────
   El porcentaje de la descarga llega veinte veces por segundo y cambiaba con
   textContent: en la statusbar pasaba de 10 a 20 a 30 de golpe (tests-16).
   Ahora corre desde lo que se ve AHORA hasta el último dato, y cada dato nuevo
   retoma la carrera donde iba en vez de volver a arrancar: es el roll() de
   Prism (recetas de motion-timing, §8). No es countTo() de motion.js a
   propósito: ese no se puede retomar, y dos carreras solapadas se pelearían
   el mismo texto. Puede correr varios números juntos (un objeto). */
function correr(el, a, pintar, { duracion = 420 } = {}) {
  const obj = typeof a === 'object' && a !== null;
  const st = el.__correr;
  if (!st) { el.__correr = { cur: a, a, raf: 0 }; pintar(a); return; }   // la primera vez, escribe
  if (JSON.stringify(st.a) === JSON.stringify(a)) return;
  cancelAnimationFrame(st.raf);
  st.a = a;
  const desde = st.cur;
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const lerp = (x, y, k) => (Number.isFinite(x) && Number.isFinite(y) ? x + (y - x) * k : y);
  const cuadro = (ahora) => {
    if (!el.isConnected) return;
    const k = ease(Math.min(1, (ahora - t0) / duracion));
    st.cur = obj ? Object.fromEntries(Object.keys(a).map((c) => [c, lerp(desde?.[c], a[c], k)])) : lerp(desde, a, k);
    pintar(st.cur);
    if (k < 1) st.raf = requestAnimationFrame(cuadro);
  };
  st.raf = requestAnimationFrame(cuadro);
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

/* Lo que se LEE de un paso. Dos estados con la misma firma no rehacen nada:
   al pedir una búsqueda, el proceso principal manda primero `manual` con la
   fase de antes, y rehacer ese paso idéntico era un cruce de un texto consigo
   mismo — se veía como letras temblando. */
function firma(e) {
  const g = guion(e);
  return [e.fase || 'inactivo', g.titulo, g.sub, g.acciones.map((a) => a.id).join()].join('|');
}

/* El relevo entre pasos (ver la skill de movimiento, regla 2). Los números van
   con el CSS: la salida dura 160 ms, el que llega espera 90. */
const ESPERA_RELEVO = 90;

/** Cambia el paso sin que la caja pegue un salto: los dos comparten celda. */
function repintar() {
  if (!overlay) return;
  const { cuerpo } = overlay;
  const viejo = cuerpo.querySelector('.qr-act__paso:not([data-state="closing"])');

  if (viejo?.dataset.fase === (estado.fase || 'inactivo') && estado.fase === 'descargando') {
    // Mismo paso, solo avanzó la descarga: mover la barra, no rehacer el paso.
    // La barra viaja con su transición de transform; el texto corre (correr).
    const fill = viejo.querySelector('.qr-prog__fill');
    if (fill) fill.style.setProperty('--qr-pct', (estado.progreso?.pct || 0).toFixed(4));
    const sub = viejo.querySelector('.qr-act__sub');
    if (sub) correrAvance(sub, estado.progreso);
    return;
  }

  const nueva = firma(estado);
  if (viejo?.dataset.firma === nueva) return;

  const el = paso(estado);
  el.dataset.firma = nueva;
  if (estado.fase === 'descargando') correrAvance(el.querySelector('.qr-act__sub'), estado.progreso);

  /* El alto viaja (shell-30). Los pasos comparten celda, así que la caja mide
     lo que mida el más alto: cuando el nuevo era más alto que el min-height,
     la caja crecía en un cuadro y el modal, centrado, se recentraba de golpe.
     El que se va queda clavado en su caja (salirDesdeDondeEsta) y ya no
     cuenta para el alto: el nuevo lo define solo, y deslizarAlto lleva la
     caja del alto de antes al de ahora. */
  deslizarAlto(cuerpo, () => {
    if (viejo && viejo.dataset.asoma && performance.now() < +viejo.dataset.asoma) {
      /* El que está llegando todavía espera su turno y no se vio nunca: se lo
         cambia por el nuevo en el mismo lugar, sin cruce. Si no, dos estados a
         60 ms apilaban tres y cuatro pasos a medio desvanecer. */
      viejo.replaceWith(el);
      el.classList.add('is-after');
      el.dataset.asoma = viejo.dataset.asoma;
      el.style.animationDelay = `${Math.max(0, +viejo.dataset.asoma - performance.now())}ms`;
    } else {
      if (viejo) salirDesdeDondeEsta(viejo, cuerpo);
      // Solo espera si hay a quién relevar: sin nadie saliendo, esperar es lentitud.
      if (viejo) {
        el.classList.add('is-after');
        el.dataset.asoma = String(performance.now() + ESPERA_RELEVO);
      }
      cuerpo.appendChild(el);
    }
  });
  setTimeout(() => overlay?.cuerpo.querySelector('.qr-act__paso:not([data-state="closing"]) .ox-btn--primary')?.focus(), 80);
}

/** El sub de la descarga, con sus números corriendo y la velocidad tal cual. */
function correrAvance(sub, p) {
  if (!sub) return;
  if (!p || !p.total) { sub.textContent = avance(p); return; }
  correr(sub, { pct: p.pct || 0, transferido: p.transferido || 0 },
    (v) => { sub.textContent = avance({ ...p, pct: v.pct, transferido: v.transferido }); });
}

/* Un paso que se va a mitad de su entrada tiene que irse desde la opacidad que
   tenía, no desde 1: la animación de salida reemplaza a la de entrada, y su
   punto de partida implícito es el estilo de base. Sin esto saltaba de 63 % a
   100 % y recién ahí se desvanecía. Se congela lo que se ve como estilo en
   línea y la salida (que no declara `from`) arranca de ahí.

   Y se clava en su caja, absoluto, donde estaba (shell-30): así no cuenta
   para el alto de la celda y, como se centra en vertical, tampoco se corre
   mientras la caja cambia de alto. La posición se mide sin el transform de su
   entrada (que se le congela aparte) y con decimales: con el ancho redondeado
   para abajo, un renglón centrado se partía en dos mientras se iba. Lleva
   `grid-area: auto` porque un hijo absoluto de una grilla CON área se ubica
   contra el área y no contra la caja. */
function salirDesdeDondeEsta(el, cuerpo) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const base = cuerpo.getBoundingClientRect();
  const m = cs.transform === 'none' ? { e: 0, f: 0 } : new DOMMatrixReadOnly(cs.transform);
  const bcs = getComputedStyle(cuerpo);
  Object.assign(el.style, {
    position: 'absolute',
    gridArea: 'auto',
    margin: '0',
    boxSizing: 'border-box',
    left: `${r.left - m.e - base.left - (parseFloat(bcs.borderLeftWidth) || 0)}px`,
    top: `${r.top - m.f - base.top - (parseFloat(bcs.borderTopWidth) || 0)}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    opacity: cs.opacity,
    transform: cs.transform === 'none' ? '' : cs.transform,
    animationDelay: '',
  });
  exit(el, { fallback: 240 });
}

/* Lo que se confirma antes de instalar, que cierra la app. Lo registra
   app.js (los cambios de Páginas sin guardar): este módulo no sabe de
   pestañas. Devuelve false si el usuario se arrepintió. */
let antesDeInstalarFn = null;
export function antesDeInstalar(fn) { antesDeInstalarFn = fn; }

async function accion(id) {
  switch (id) {
    case 'cerrar': case 'despues': cerrar(); break;
    case 'notas': window.open(estado.url, '_blank'); break;
    case 'buscar': await api.update.buscar({ manual: true }); break;
    case 'descargar': await api.update.descargar(); break;
    case 'instalar':
      cerrar();
      // Con cambios de Páginas sin guardar, primero se pregunta (app.js).
      if (antesDeInstalarFn && !(await antesDeInstalarFn())) break;
      await api.update.instalar();
      break;
    default: break;
  }
}

/* ── La statusbar ────────────────────────────────────────────────────────────
   Lo que queda visible cuando cerrás el cartel: sin esto, una descarga de 90 MB
   pasa a ser invisible y el "listo para instalar" se pierde. */

/* Nada aparece ni se va de golpe, tampoco acá. Cuatro casos:
   · mismo aviso, solo avanzó la descarga → el número corre en su lugar
     (correr), en el MISMO nodo;
   · aparece de la nada → el ítem es ox-plegable--ancho: al sacarle el
     `hidden` se despliega a lo ancho mientras se funde, y la impresora de al
     lado se corre de a poco en vez de saltar (shell-22, css-17);
   · se va → `hidden`: se desvanece y se pliega, primero lo de adentro y
     después la caja;
   · cambia de aviso (disponible → descargando → lista) → relevo del
     contenido en el lugar (swap con relevo) y el ancho del ítem viajando
     (deslizarAncho). Antes era un fundido de salida del ítem entero, otro de
     entrada, y el ancho cambiando de golpe en el medio.
   El contenido se escribe siempre con swap(): lleva su memoria del último
   html, y escribirlo por otro lado la desfasaría (corrección 8 del plan). Lo
   único que se escribe aparte es el número que corre, adentro de su span. */
const STAT_AVISOS = ['disponible', 'descargando', 'listo'];
let statAviso = null;

const pctDe = () => Math.round((estado.progreso?.pct || 0) * 100);

function contenidoStat(aviso) {
  if (aviso === 'descargando') {
    return {
      tip: 'Bajando la actualización',
      html: `${Icons.svg('download', 'ox-icon--sm')}<span class="ox-statusbar__value ox-num qr-stat-pct">${pctDe()}%</span>`,
    };
  }
  if (aviso === 'listo') {
    return {
      tip: 'Reiniciá para instalarla',
      html: `${Icons.svg('zap', 'ox-icon--sm')}<span class="ox-statusbar__value">Quire ${esc(estado.version || '')} lista</span>`,
    };
  }
  return {
    tip: 'Hay una versión nueva',
    html: `${Icons.svg('download', 'ox-icon--sm')}<span class="ox-statusbar__value">${esc(estado.version || '')}</span>`,
  };
}

function ponerStat(el, aviso, opciones) {
  const { tip, html } = contenidoStat(aviso);
  el.dataset.tip = tip;
  swap(el, html, opciones);
}

/* El número que corre arranca de lo que dice el span recién puesto: sin ese
   punto de partida, el primer avance después de pintar saltaba.

   Y el span dice el número de AHORA. swap() recuerda el html con el % del
   momento en que se puso, y correr() después escribe el span por su cuenta:
   bajando al 10 % (swap recuerda «10%»), corre hasta 60, llega un error y se
   reintenta desde 10. swap ve el mismo html y no hace nada, y el ítem se
   desplegaba diciendo «60%» (auditoría 2F). Por eso se escribe acá, con
   pctDe(), y se corta la carrera vieja: si todavía tenía cuadros, seguiría
   pintando sus números encima. */
function arrancarPct(el) {
  const v = el.querySelector(':scope > .qr-stat-pct');
  if (!v) return;
  cancelAnimationFrame(v.__correr?.raf);
  const txt = `${pctDe()}%`;
  if (v.textContent !== txt) v.textContent = txt;
  v.__correr = { cur: pctDe(), a: pctDe(), raf: 0 };
}

function pintarStatus() {
  const el = document.getElementById('stat-update');
  if (!el) return;
  const aviso = STAT_AVISOS.includes(estado.fase) ? estado.fase : null;

  if (aviso === statAviso) {
    if (aviso === 'descargando') {
      // Lo vivo, no lo que se está yendo en el calco de un relevo.
      const v = el.querySelector(':scope > .qr-stat-pct');
      if (v) correr(v, pctDe(), (n) => { v.textContent = `${Math.round(n)}%`; });
    } else if (aviso) {
      // El mismo aviso con otra versión: swap no hace nada si el html es igual.
      deslizarAncho(el, () => ponerStat(el, aviso, { relevo: true }));
    }
    return;
  }

  statAviso = aviso;
  if (!aviso) { el.hidden = true; return; }
  /* Con `hidden` todavía se ve mientras se pliega (allow-discrete): un aviso
     que llega en ese rato no se puede escribir en el lugar, se vería
     cambiar de golpe. Vuelve a desplegarse desde donde iba (la transición
     del plegable se da vuelta sola) y el contenido hace su relevo. */
  const plegandose = el.hidden && el.getAnimations().some((a) => a.playState === 'running');
  if (el.hidden && !plegandose) {
    // Escondido no se ve: el contenido va en el lugar, y el ítem se despliega.
    ponerStat(el, aviso);
    el.hidden = false;
  } else if (plegandose) {
    ponerStat(el, aviso, { relevo: true });
    el.hidden = false;
  } else {
    deslizarAncho(el, () => ponerStat(el, aviso, { relevo: true }));
  }
  arrancarPct(el);
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
