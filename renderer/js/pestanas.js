/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — la franja de pestañas
   Dibuja los documentos abiertos y deja cambiar entre ellos. Nada de estado
   propio: todo lo que sabe se lo pregunta a estado.js, y se repinta entero
   cuando ese avisa 'pestanas'.

   Vive fuera de #view a propósito. Las vistas se repintan al navegar y la
   franja no tiene por qué hacerlo: el documento activo es el mismo estés en el
   lector, en Imprimir o en Ajustes.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, MAX_PESTANAS, activar, cerrarPestana, alCambiar } from './estado.js';
import { Icons } from './icons.js';
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

  alCambiar((que) => { if (que === 'pestanas') pintar(); });
  pintar();
}
