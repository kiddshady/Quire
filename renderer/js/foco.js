/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el foco que vuelve
   Al cerrar algo que se lo había llevado (un modal, la presentación), el
   foco vuelve a quien lo tenía. Volver no es llegar con Tab, y Chromium no
   distingue: si se cerró con Escape, la última interacción fue una tecla y
   da el foco devuelto por foco de teclado. El botón que abriste con el mouse
   quedaba con el anillo puesto, como si lo hubieras elegido con Tab.

   Vuelve como estaba: con anillo solo si lo tenía cuando se fue. Quien llegó
   con Tab y abrió con Enter lo recupera, que es lo que necesita para seguir
   con el teclado; quien hizo clic, no.

   `focus({ focusVisible: false })` lo resolvería, pero Electron 40 lo ignora
   (lo mismo que en el visor, 1.0.1): la marca data-sin-anillo apaga el anillo
   (base.css) mientras dure ese foco y se va con el blur. Llegar después con
   Tab lo vuelve a mostrar.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Quién tiene el foco ahora y si se le ve el anillo: lo que se guarda al abrir. */
export function tomarFoco() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { el, anillo: el.matches(':focus-visible') };
}

/** Le devuelve el foco a quien lo tenía, como lo tenía. */
export function devolverFoco(guardado) {
  if (!guardado?.el?.isConnected) return;
  enfocar(guardado.el, { anillo: guardado.anillo });
}

/** Enfoca sin que se vea el anillo, salvo que se pida. */
export function enfocar(el, { anillo = false } = {}) {
  if (!el) return;
  if (anillo) delete el.dataset.sinAnillo;
  else {
    el.dataset.sinAnillo = '';
    el.addEventListener('blur', () => { delete el.dataset.sinAnillo; }, { once: true });
  }
  el.focus({ preventScroll: true });
}
