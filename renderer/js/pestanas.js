/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — la franja de pestañas
   Dibuja los documentos abiertos y deja cambiar entre ellos. Nada de estado
   propio: todo lo que sabe se lo pregunta a estado.js, y se repinta entero
   cuando ese avisa 'pestanas'.

   Vive fuera de #view a propósito. Las vistas se repintan al navegar y la
   franja no tiene por qué hacerlo: el documento activo es el mismo estés en el
   lector, en Imprimir o en Ajustes.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, MAX_PESTANAS, activar, cerrarPestana, mover, alCambiar } from './estado.js';
import { Icons } from './icons.js';
import { Tooltip } from './overlays.js';
import { esc } from './ui.js';

const franja = () => document.getElementById('qr-tabs');

/** Repinta la franja entera. Son cuatro nodos como mucho: no hace falta más. */
export function pintar() {
  const el = franja();
  if (!el) return;

  const abiertas = S.pestanas;
  const activaId = S.pestana?.id;

  /* La cruz lleva `data-tip` pero NO `data-tip-key`: Ctrl+W cierra la ACTIVA,
     así que anunciar el atajo en la cruz de una inactiva sería mentir. */
  el.innerHTML = abiertas.map((p) => {
    const nombre = p.doc?.nombre || 'documento.pdf';
    return `
      <div class="qr-tab${p.id === activaId ? ' is-active' : ''}"
           role="tab" tabindex="0" aria-selected="${p.id === activaId}"
           data-pestana="${p.id}"
           data-tip="${esc(p.doc?.ruta || nombre)}" data-tip-side="bottom">
        <i data-icon="file"></i>
        <span class="qr-tab__nombre">${esc(nombre)}</span>
        <button class="qr-tab__cerrar" data-cerrar="${p.id}"
                data-tip="Cerrar" data-tip-side="bottom"
                aria-label="Cerrar ${esc(nombre)}"><i data-icon="close"></i></button>
      </div>`;
  }).join('') + (abiertas.length < MAX_PESTANAS ? `
      <button class="qr-tabs__mas" id="qr-tab-mas"
              data-tip="Abrir otro PDF" data-tip-key="Ctrl O" data-tip-side="bottom"
              aria-label="Abrir otro PDF"><i data-icon="plus"></i></button>` : '');

  // paint() monta los íconos de la vista; esto vive afuera y los monta solo.
  Icons.mount(el);

  /* Con un documento la franja se pliega. Sigue en el DOM y sigue siendo ítem
     del grid: se esconde por alto, nunca con `hidden` — el porqué está en
     index.html, arriba del nodo. */
  el.classList.toggle('is-visible', abiertas.length > 1);
}

/**
 * Engancha la franja una sola vez, al arrancar. Los handlers van al contenedor
 * y no a cada pestaña: el contenido se reemplaza en cada repintado, los
 * listeners de adentro se irían con él.
 */
export function cablear({ alAbrir }) {
  const el = franja();
  if (!el) return;

  const cerrar = (id) => cerrarPestana(id).catch((err) => console.error('[pestañas]', err));

  el.addEventListener('click', (e) => {
    /* El click que cierra un arrastre no es un click: la pestaña ya se activó
       al soltarla, y dejarlo pasar repintaría la franja en mitad del asentado. */
    if (tragarClick) { tragarClick = false; return; }

    const cruz = e.target.closest('[data-cerrar]');
    if (cruz) return cerrar(Number(cruz.dataset.cerrar));

    if (e.target.closest('#qr-tab-mas')) return alAbrir();

    const tab = e.target.closest('[data-pestana]');
    if (tab) activar(Number(tab.dataset.pestana));
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
   gesto, no sobre el DOM en vivo: la franja se repinta entera con cada aviso,
   y medir en cada movimiento sería medir nodos que ya no están. */

/* Levantada por el pointerup que cierra un arrastre, para que el click que
   viene atrás no active nada. Vive fuera del gesto porque el click llega
   cuando el gesto ya se soltó. */
let tragarClick = false;

/* Los píxeles que hay que moverse antes de que un click se convierta en
   arrastre. Sin umbral, el temblor de la mano al clickear ya despegaría la
   pestaña y el click nunca llegaría. */
const UMBRAL = 4;

function cablearArrastre(el) {
  /** @type {null | { tab: HTMLElement, id: number, puntero: number, x0: number, desde: number, hasta: number, rects: DOMRect[], paso: number, vivo: boolean }} */
  let g = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-cerrar]')) return;
    const tab = e.target.closest('[data-pestana]');
    if (!tab) return;

    const tabs = [...el.querySelectorAll('[data-pestana]')];
    if (tabs.length < 2) return;

    const rects = tabs.map((t) => t.getBoundingClientRect());
    const desde = tabs.indexOf(tab);
    g = {
      tab, id: Number(tab.dataset.pestana), puntero: e.pointerId,
      x0: e.clientX, desde, hasta: desde, rects,
      /* Todas miden lo mismo (flex: 1 1 0 con el mismo techo), así que la
         distancia entre dos vecinas es una sola. Es lo que se corre cada
         una al hacer lugar. */
      paso: rects[1].left - rects[0].left,
      vivo: false,
    };
  });

  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.puntero) return;
    const dx = e.clientX - g.x0;

    if (!g.vivo) {
      if (Math.abs(dx) < UMBRAL) return;
      g.vivo = true;
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
  el.querySelectorAll('[data-pestana]').forEach((t, k) => {
    if (k === g.desde) return;
    let corr = 0;
    if (g.desde < k && k <= g.hasta) corr = -g.paso;    // le pasé por encima yendo a la derecha
    else if (g.hasta <= k && k < g.desde) corr = g.paso; // yendo a la izquierda
    t.style.transform = corr ? `translateX(${corr}px)` : '';
  });
}

/**
 * Al soltar, la pestaña no salta a su lugar: se desliza hasta el hueco que
 * las vecinas le dejaron, y recién cuando llegó se cambia el orden de verdad.
 * El repintado que sigue la pone en ese mismo lugar sin transform, así que el
 * cambio de DOM no se ve.
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
    el.classList.remove('is-reordering');
    /* Limpiar a mano y no confiar en el repintado: si no cambió nada, no hay
       aviso y no hay repintado. */
    tab.classList.remove('is-settling');
    el.querySelectorAll('[data-pestana]').forEach((t) => { t.style.transform = ''; });
    mover(id, hasta);
    activar(id);
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
