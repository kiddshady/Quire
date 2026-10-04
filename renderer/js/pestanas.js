/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — la franja de pestañas
   Dibuja los documentos abiertos y deja cambiar entre ellos. Nada de estado
   propio: todo lo que sabe se lo pregunta a estado.js, y se pone al día
   cuando ese avisa 'pestanas'.

   Vive fuera de #view a propósito. Las vistas se repintan al navegar y la
   franja no tiene por qué hacerlo: el documento activo es el mismo estés en el
   lector, en Imprimir o en Ajustes.

   Se pone al día por clave (reconcile, de motion.js), no se rehace. Hasta
   octubre de 2026 era un innerHTML entero en cada aviso, y con nodos nuevos
   nada podía transicionar: el subrayado de la activa nacía crecido, el fondo
   saltaba de una pestaña a la otra, la que se cerraba desaparecía de golpe y
   las demás saltaban a su lugar, y Enter sobre una pestaña dejaba el foco en
   el body porque el nodo enfocado ya no existía (shell-01, css-18, ux-18).
   Ahora cada pestaña es el MISMO nodo mientras viva: cambiar de activa solo
   le togglea las clases, la que se cierra sale esfumándose fuera del flujo y
   las otras viajan a su lugar.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, MAX_PESTANAS, activar, cerrarPestana, mover, alCambiar } from './estado.js';
import { Icons } from './icons.js';
import { Tooltip } from './overlays.js';
import { reconcile } from './motion.js';
import { esc } from './ui.js';

const franja = () => document.getElementById('qr-tabs');

/* Las pestañas que cuentan: la que se está cerrando sigue un rato en el DOM,
   absoluta y esfumándose, pero ya no es una pestaña. */
const VIVAS = '.qr-tab:not([data-state="closing"])';

/* Los de motion.js (T.move y --ox-ease): el ancho viaja junto con el FLIP de
   reconcile, así que tiene que durar y frenar igual. */
const VIAJE_MS = 280;
const EASE = 'cubic-bezier(.16, 1, .3, 1)';
const reducido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* La cruz lleva `data-tip` pero NO `data-tip-key`: Ctrl+W cierra la ACTIVA,
   así que anunciar el atajo en la cruz de una inactiva sería mentir. */
function itemPestana(p, activaId) {
  const nombre = p.doc?.nombre || 'documento.pdf';
  const ruta = p.doc?.ruta || nombre;
  const activa = p.id === activaId;
  return {
    key: `t:${p.id}`,
    nombre,
    ruta,
    activa,
    html: `<div class="qr-tab${activa ? ' is-active' : ''}"
           role="tab" tabindex="0" aria-selected="${activa}"
           data-pestana="${p.id}"
           data-tip="${esc(ruta)}" data-tip-side="bottom">
        <i data-icon="file"></i>
        <span class="qr-tab__nombre">${esc(nombre)}</span>
        <button class="qr-tab__cerrar" data-cerrar="${p.id}"
                data-tip="Cerrar" data-tip-side="bottom"
                aria-label="Cerrar ${esc(nombre)}"><i data-icon="close"></i></button>
      </div>`,
  };
}

/* El «+» es una pieza más de la lista, SIEMPRE presente: entraba y salía del
   DOM al llegar al tope y volver, de un cuadro al otro. Ahora se pliega a lo
   ancho con `hidden` (ox-plegable--ancho) y lo de al lado no salta.
   `data-lugar` está para que el html cambie cuando cambia el tope: es lo que
   le dice a reconcile que tiene que ponerlo al día. */
function itemMas(lugar) {
  return {
    key: 'mas',
    lugar,
    html: `<button class="qr-tabs__mas ox-plegable--ancho" id="qr-tab-mas" data-lugar="${lugar}"
              data-tip="Abrir otro PDF" data-tip-key="Ctrl O" data-tip-side="bottom"
              aria-label="Abrir otro PDF"${lugar ? '' : ' hidden'}><i data-icon="plus"></i></button>`,
  };
}

/* Pone al día una pieza que sigue, en el MISMO nodo: así corren las
   transiciones (el subrayado que crece, el fondo con --tr-color) y el foco se
   queda donde estaba. El contenido del «+» no se toca: ahí puede estar el
   relevo de «Abriendo…» que maneja app.js. */
function ponerAlDia(el, it) {
  if (it.key === 'mas') {
    el.hidden = !it.lugar;
    el.dataset.lugar = String(it.lugar);
    return;
  }
  el.classList.toggle('is-active', it.activa);
  el.setAttribute('aria-selected', String(it.activa));
  el.dataset.tip = it.ruta;
  const nombre = el.querySelector('.qr-tab__nombre');
  if (nombre && nombre.textContent !== it.nombre) nombre.textContent = it.nombre;
  el.querySelector('.qr-tab__cerrar')?.setAttribute('aria-label', `Cerrar ${it.nombre}`);
}

/** Dónde está cada pieza viva ahora mismo, como se VE (con lo que esté viajando). */
function medir(el) {
  const m = new Map();
  for (const n of el.children) if (n.dataset.state !== 'closing') m.set(n, n.getBoundingClientRect());
  return m;
}

/** Pone la franja al día con lo que diga estado.js. */
export function pintar() {
  const el = franja();
  if (!el) return;

  const abiertas = S.pestanas;
  const activaId = S.pestana?.id;
  const enfocada = el.contains(document.activeElement) ? document.activeElement : null;
  const antes = medir(el);
  const mas = el.querySelector('#qr-tab-mas');
  const masAntes = mas ? { hidden: mas.hidden, estilo: estiloMas(mas) } : null;

  const items = abiertas.map((p) => itemPestana(p, activaId));
  items.push(itemMas(abiertas.length < MAX_PESTANAS));
  reconcile(el, items, { update: ponerAlDia, created: (n) => Icons.mount(n) });
  acomodarAnchos(el, antes, masAntes);

  /* Reordenar mueve el nodo (insertBefore), y un nodo que se saca y se vuelve
     a poner pierde el foco. Si lo tenía una pestaña que se está cerrando, va a
     la activa: el anillo no puede quedarse en algo que se va. */
  if (enfocada) {
    const destino = enfocada.closest('[data-state="closing"]')
      ? el.querySelector(`${VIVAS}.is-active`)
      : enfocada;
    if (destino?.isConnected && document.activeElement !== destino) destino.focus({ preventScroll: true });
  }

  /* Con un documento la franja se pliega. Sigue en el DOM y sigue siendo ítem
     del grid: se esconde por alto, nunca con `hidden` — el porqué está en
     index.html, arriba del nodo. Y plegada es inerte: tenía alto 0 pero la
     pestaña, su cruz y el «+» seguían recibiendo el Tab, y el anillo
     desaparecía tres veces seguidas en controles invisibles (ux-18). */
  el.classList.toggle('is-visible', abiertas.length > 1);
  /* Al quedar inerte con el foco adentro (pasar de dos a una cerrando con
     Ctrl+W o con la cruz desde el teclado), el foco caía al body: lo que
     ux-18 quería evitar, por otro camino. Antes de apagarla, el foco va a
     algo que se ve: el visor en el lector; si no, lo primero enfocable y a
     la vista de la vista (no lo de un calco que se está yendo); y si no hay
     nada, el botón Abrir. */
  const inerte = abiertas.length < 2;
  if (inerte && el.contains(document.activeElement)) {
    const fuera = document.getElementById('qr-visor')
      || [...document.querySelectorAll('#view [tabindex="0"], #view button:not(:disabled), #view input:not(:disabled)')]
        .find((n) => n.getClientRects().length && !n.closest('[inert], [data-state="closing"], .ox-swap-out'))
      || document.getElementById('btn-abrir');
    fuera?.focus({ preventScroll: true });
  }
  el.inert = inerte;
}

/* Lo que el plegable del «+» transiciona, tal como se ve ahora. */
function estiloMas(n) {
  const cs = getComputedStyle(n);
  return {
    display: cs.display, width: cs.width, opacity: cs.opacity,
    paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
    marginLeft: cs.marginLeft, marginRight: cs.marginRight,
  };
}

/* reconcile() solo TRASLADA: si al cerrar o abrir una pestaña las demás
   cambian de ancho (en una ventana angosta se reparten el lugar: flex 1 1 0
   con techo de 240), ese ancho cambiaba de golpe mientras el FLIP corría. Acá
   el ancho viaja del que se veía al nuevo, y el FLIP se rehace contra la
   franja con los anchos de antes, que es lo que hay en el primer cuadro: lo
   que se ve es la suma de los dos y no salta. Con la ventana ancha (todas en
   su techo) no cambia ningún ancho y queda el FLIP de reconcile tal cual.

   El «+» entra en la cuenta. Cuando se pliega o se despliega (al llegar a
   cuatro o al bajar de cuatro) su ancho también cambia, y con su transición
   de CSS los anchos «finales» se medían en el cuadro 0, con el «+» todavía
   en 26 px: las pestañas quedaban clavadas en un final falso y, al terminar
   el viaje (280 ms), saltaban a su ancho de verdad. Medido a 900 px al abrir
   la cuarta: 205,5 quieta y en el cuadro siguiente 214, la x de la tercera de
   427 a 444 (auditoría 2F). Por eso, cuando el «+» cambia, se lo pone en su
   estado final sin transición (is-placing) para medir, y viaja él también
   por WAAPI, con la misma duración y curva que las pestañas: la suma de los
   anchos es la de la franja en todo momento. */
function acomodarAnchos(el, antes, masAntes) {
  const mas = el.querySelector('#qr-tab-mas');
  /* Cambia si se pliega o se despliega, o si todavía viajaba de un cambio
     anterior (pintar() corre con cada aviso, también al activar): en ese
     caso se retoma desde donde iba, como las pestañas, en vez de cortarlo. */
  const masCambia = !!(mas && masAntes && antes.has(mas) && !reducido()
    && (mas.hidden !== masAntes.hidden || mas.__ancho?.playState === 'running'));
  if (masCambia) {
    mas.__ancho?.cancel();
    mas.__ancho = null;
    mas.classList.add('is-placing');
  }

  const quedan = [...el.children].filter((n) => n.dataset.state !== 'closing' && antes.has(n));
  // Lo que todavía viajaba de un cambio anterior se corta acá: el ancho final
  // se mide sin eso, y el de partida ya está en `antes`, tal como se veía.
  for (const n of quedan) { n.__ancho?.cancel(); n.__ancho = null; }
  const cambian = reducido() ? [] : quedan.filter((n) => n.classList.contains('qr-tab')
    && Math.abs(n.getBoundingClientRect().width - antes.get(n).width) > 0.5);
  // Los finales, con todo en su lugar final: antes de poner a viajar a nadie.
  const finales = new Map(cambian.map((n) => [n, n.getBoundingClientRect().width]));

  if (masCambia) {
    /* Ya medido en su final: se le devuelve la transición (no corre nada,
       el valor no cambia) y el viaje lo hace la animación, desde lo que se
       veía antes del cambio. */
    const hasta = estiloMas(mas);
    mas.classList.remove('is-placing');
    mas.__ancho = mas.animate([masAntes.estilo, hasta], { duration: VIAJE_MS, easing: EASE });
  }
  if (!cambian.length && !masCambia) return;

  for (const n of cambian) {
    const fijo = (w) => ({ flexGrow: 0, flexShrink: 0, flexBasis: `${w}px` });
    n.__ancho = n.animate([fijo(antes.get(n).width), fijo(finales.get(n))], { duration: VIAJE_MS, easing: EASE });
  }
  // El FLIP de nuevo, ahora contra el primer cuadro de verdad. Va en __move,
  // que es lo que reconcile cancela si llega otro cambio en el medio.
  for (const n of quedan) {
    n.__move?.cancel();
    n.__move = null;
    const dx = antes.get(n).left - n.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) continue;
    n.__move = n.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: VIAJE_MS, easing: EASE });
  }
}

/**
 * Engancha la franja una sola vez, al arrancar. Los handlers van al contenedor
 * y no a cada pestaña: así sirven también para las que nazcan después.
 */
export function cablear({ alAbrir }) {
  const el = franja();
  if (!el) return;

  const cerrar = (id) => cerrarPestana(id).catch((err) => console.error('[pestañas]', err));

  el.addEventListener('click', (e) => {
    /* El click que cierra un arrastre no es un click: la pestaña ya se activó
       al soltarla. */
    if (tragarClick) { tragarClick = false; return; }

    const cruz = e.target.closest('[data-cerrar]');
    if (cruz) return cerrar(Number(cruz.dataset.cerrar));

    if (e.target.closest('#qr-tab-mas')) return alAbrir();

    const tab = e.target.closest('[data-pestana]');
    if (tab && tab.dataset.state !== 'closing') activar(Number(tab.dataset.pestana));
  });

  /* Botón del medio para cerrar, como en cualquier navegador. Va en `auxclick`
     y no en `mousedown`: cerrar antes de que se suelte el botón hace que el
     gesto se sienta disparado a destiempo. */
  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('[data-pestana]');
    if (!tab) return;
    e.preventDefault();
    cerrar(Number(tab.dataset.pestana));
  });

  /* Las pestañas son divs con tabindex, no botones, porque llevan un botón
     adentro (la cruz) y un botón dentro de otro no es HTML válido. El precio
     es cablear a mano lo que un <button> trae de fábrica. */
  el.addEventListener('keydown', (e) => {
    const tab = e.target.closest('[data-pestana]');
    if (!tab || e.target.closest('[data-cerrar]')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activar(Number(tab.dataset.pestana));
    }
  });

  cablearArrastre(el);

  alCambiar((que) => { if (que === 'pestanas') pintar(); });
  pintar();
}

/* ── Arrastrar para reordenar ────────────────────────────────────────────────
   Con el puntero, no con la API de drag & drop del navegador: esa dibuja una
   foto semitransparente de la pestaña que no se puede estilar y el cursor
   nativo de "prohibido" mientras buscás dónde soltar. Acá la pestaña de
   verdad sigue al puntero con un transform, y las vecinas se corren para
   hacerle lugar con su propia transición.

   Los transforms se calculan sobre los rectángulos medidos al empezar el
   gesto, no sobre el DOM en vivo: medir en cada movimiento mediría también
   los transforms que el propio gesto les puso a las vecinas. */

/* Levantada por el pointerup que cierra un arrastre, para que el click que
   viene atrás no active nada. Vive fuera del gesto porque el click llega
   cuando el gesto ya se soltó. */
let tragarClick = false;

/* Los píxeles que hay que moverse antes de que un click se convierta en
   arrastre. Sin umbral, el temblor de la mano al clickear ya despegaría la
   pestaña y el click nunca llegaría. */
const UMBRAL = 4;

function cablearArrastre(el) {
  /** @type {null | { tab: HTMLElement, id: number, puntero: number, x0: number, vivo: boolean, desde?: number, hasta?: number, rects?: DOMRect[], paso?: number }} */
  let g = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-cerrar]')) return;
    const tab = e.target.closest('[data-pestana]');
    if (!tab || tab.dataset.state === 'closing') return;

    if (el.querySelectorAll(VIVAS).length < 2) return;
    g = { tab, id: Number(tab.dataset.pestana), puntero: e.pointerId, x0: e.clientX, vivo: false };
  });

  /* Se mide recién cuando el gesto se vuelve arrastre, y no en el pointerdown:
     un click suelto no tiene por qué tocar nada. Lo que todavía viajaba de un
     cambio anterior (el FLIP de reconcile, un ancho) se da por terminado: si
     no, los rectángulos saldrían a mitad de camino, y una animación le gana
     al transform en línea con que el gesto corre a las vecinas. */
  const empezar = () => {
    const tabs = [...el.querySelectorAll(VIVAS)];
    for (const t of tabs) { t.__move?.finish(); t.__ancho?.finish(); }
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const desde = tabs.indexOf(g.tab);
    Object.assign(g, {
      desde, hasta: desde, rects,
      /* Todas miden lo mismo (flex: 1 1 0 con el mismo techo), así que la
         distancia entre dos vecinas es una sola. Es lo que se corre cada
         una al hacer lugar. */
      paso: rects[1].left - rects[0].left,
    });
  };

  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.puntero) return;
    const dx = e.clientX - g.x0;

    if (!g.vivo) {
      if (Math.abs(dx) < UMBRAL) return;
      g.vivo = true;
      empezar();
      /* Capturar el puntero es lo que deja soltar fuera de la franja sin
         perder el gesto, y de paso lo que evita que el hover de las vecinas
         se dispare mientras se pasa por encima. */
      g.tab.setPointerCapture(g.puntero);
      g.tab.classList.add('is-dragging');
      el.classList.add('is-reordering');
      Tooltip.hide(true);
    }

    /* La pestaña no se sale de la fila de pestañas: se frena contra la primera
       y la última. Pasarse no significa nada y se vería arrastrando una
       pestaña por encima del botón de abrir otro. */
    const mia = g.rects[g.desde];
    const min = g.rects[0].left - mia.left;
    const max = g.rects.at(-1).right - mia.right;
    const d = Math.max(min, Math.min(max, dx));
    g.tab.style.transform = `translateX(${d}px)`;

    /* A qué lugar iría si la soltaras ahora: cuántas de las otras quedaron con
       su centro a la izquierda del centro de esta. Cruzar el centro de una
       vecina es lo que te hace ocupar su lugar, no rozarle el borde. */
    const centro = mia.left + mia.width / 2 + d;
    const hasta = g.rects.filter((r, k) => k !== g.desde && r.left + r.width / 2 < centro).length;
    if (hasta !== g.hasta) {
      g.hasta = hasta;
      correrVecinas(el, g);
    }
  });

  const soltar = (e) => {
    if (!g || e.pointerId !== g.puntero) return;
    const gesto = g;
    g = null;
    if (!gesto.vivo) return;

    tragarClick = true;
    /* Si el click no llega (un pointercancel, por ejemplo), la bandera no se
       puede quedar levantada: se comería el próximo click de verdad. El click
       de un pointerup se despacha en la misma vuelta, antes que cualquier
       timer, así que esto la baja recién cuando ya pasó su oportunidad. */
    setTimeout(() => { tragarClick = false; }, 0);

    asentar(el, gesto);
  };
  el.addEventListener('pointerup', soltar);
  el.addEventListener('pointercancel', soltar);
}

/** Corre las vecinas para dejarle un hueco a la arrastrada en `g.hasta`. */
function correrVecinas(el, g) {
  el.querySelectorAll(VIVAS).forEach((t, k) => {
    if (k === g.desde) return;
    let corr = 0;
    if (g.desde < k && k <= g.hasta) corr = -g.paso;    // le pasé por encima yendo a la derecha
    else if (g.hasta <= k && k < g.desde) corr = g.paso; // yendo a la izquierda
    t.style.transform = corr ? `translateX(${corr}px)` : '';
  });
}

/**
 * Al soltar, la pestaña no salta a su lugar: se desliza hasta el hueco que
 * las vecinas le dejaron, todavía levantada, y recién cuando llegó se cambia
 * el orden de verdad.
 *
 * El aterrizaje tiene un orden, y es el de la corrección 6 del plan de la
 * auditoría (shell-01). Con la franja por clave, mover() la pone al día con
 * reconcile, que mide dónde está cada pestaña ANTES de cambiar el orden y
 * hace viajar a la que vea corrida. Si para entonces los transforms ya se
 * limpiaron pero el nodo sigue en su lugar viejo del DOM, reconcile la ve en
 * el lugar viejo y la hace volver desde ahí: la pestaña saltaba atrás y
 * venía de nuevo. Por eso, en la misma tarea y en este orden:
 *   1. se saca la clase que transiciona los transforms;
 *   2. se limpian los transforms y el nodo pasa a su lugar nuevo del DOM:
 *      donde se ve no cambia, porque el transform la tenía justo ahí;
 *   3. mover(): reconcile encuentra el orden que ya está y no mueve nada;
 *   4. recién ahí se apoya (sale is-settling): el aspecto levantado se funde
 *      en el MISMO nodo, con --tr-color, en vez de irse de un cuadro al otro.
 *
 * La activa al final es la que arrastraste, como en cualquier navegador:
 * agarrar una pestaña es elegirla. Si no se movió de lugar, es un click largo
 * y vale lo mismo que un click.
 */
function asentar(el, g) {
  const { tab, id, desde, hasta, paso } = g;

  /* Sigue levantada mientras se desliza —aterriza recién al llegar— pero ya
     con transición de transform: el cambio de valor de abajo se anima en vez
     de saltar. */
  tab.classList.replace('is-dragging', 'is-settling');
  tab.style.transform = `translateX(${(hasta - desde) * paso}px)`;

  const terminar = () => {
    tab.removeEventListener('transitionend', alTerminar);
    const conFoco = document.activeElement === tab;
    el.classList.remove('is-reordering');                        // 1
    const vivas = [...el.querySelectorAll(VIVAS)];
    for (const t of vivas) t.style.transform = '';               // 2
    if (hasta !== desde) {
      const resto = vivas.filter((t) => t !== tab);
      el.insertBefore(tab, resto[hasta] || el.querySelector('#qr-tab-mas'));
    }
    if (conFoco && document.activeElement !== tab) tab.focus({ preventScroll: true });
    mover(id, hasta);                                            // 3
    activar(id);
    tab.classList.remove('is-settling');                         // 4
  };

  /* Que termine de deslizarse. El timeout es la red: si el transform ya valía
     eso (o la ventana perdió el foco a mitad de camino) no hay transitionend,
     y sin red la franja quedaría en modo arrastre para siempre. */
  let hecho = false;
  const una = () => { if (!hecho) { hecho = true; terminar(); } };
  const alTerminar = (e) => { if (e.propertyName === 'transform') una(); };
  tab.addEventListener('transitionend', alTerminar);
  setTimeout(una, 260);
}
