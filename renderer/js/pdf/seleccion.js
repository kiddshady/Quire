/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — la selección de texto
   La capa de texto (documento.js → capaTexto) pone los spans; acá vive lo que
   hace que ARRASTRAR sobre ellos se sienta como arrastrar sobre un documento.

   El problema que resuelve, que no es obvio hasta que se ve:

   Los spans están posicionados en absoluto, uno por fragmento, y entre uno y
   otro hay HUECOS — el interlineado, los márgenes, el aire entre columnas.
   Cuando el mouse cruza un hueco, el navegador no encuentra nada que
   seleccionar debajo y salta al siguiente nodo del DOM que sí tenga texto:
   normalmente el ÚLTIMO de la página. Arrastrás tres palabras y se te pinta la
   hoja entera.

   La solución es la de pdf.js, y viene de ahí: una "cola" —un div vacío y
   seleccionable— que se va reinsertando justo detrás del punto donde está el
   cursor. Mientras se arrastra, el nodo más cercano al puntero es siempre la
   cola, así que el salto cae ahí y no al final del documento.

   La versión de pdf.js tiene además una rama para Firefox. Acá no: adentro de
   Electron el motor es Chromium y solo Chromium.
   ═══════════════════════════════════════════════════════════════════════════ */

import { normalizarTexto } from './documento.js';

/** div de la capa → { cola, ac }. El AbortController suelta sus listeners. */
const capas = new Map();

/* Los listeners de `document` se registran UNA vez, con la primera capa, y se
   sueltan con la última. Registrarlos por capa sería multiplicarlos por la
   cantidad de páginas en pantalla, y `selectionchange` es de los eventos que
   más se disparan que hay. */
let global = null;

/** Pone la capa de texto en servicio: le agrega la cola y la deja copiable. */
export function registrar(div) {
  if (capas.has(div)) return;

  const cola = document.createElement('div');
  cola.className = 'qr-texto__cola';
  div.append(cola);

  const ac = new AbortController();
  const { signal } = ac;

  div.addEventListener('mousedown', () => div.classList.add('is-seleccionando'), { signal });

  /* El copiado se intercepta para normalizar. Sin esto, lo que se pega trae las
     ligaduras crudas del PDF — ver normalizarTexto(). */
  div.addEventListener('copy', (e) => {
    e.clipboardData.setData('text/plain', normalizarTexto(document.getSelection().toString()));
    e.preventDefault();
    e.stopPropagation();
  }, { signal });

  capas.set(div, { cola, ac });
  activarGlobal();
}

/**
 * Saca la capa de servicio. Se llama al liberar una página que se fue de
 * pantalla, y tiene que soltar los listeners: el div sobrevive a la
 * virtualización —está en la plantilla del pliego— así que volver a
 * registrarlo sin haber soltado nada dejaría dos handlers de `copy` peleando
 * por el portapapeles.
 */
export function olvidar(div) {
  const reg = capas.get(div);
  if (!reg) return;
  reg.ac.abort();
  reg.cola.remove();
  capas.delete(div);
  div.classList.remove('is-seleccionando');
  if (!capas.size) { global?.abort(); global = null; }
}

/** Suelta todas las capas de una. Para cuando el lector se desmonta entero. */
export function olvidarTodo() {
  for (const div of [...capas.keys()]) olvidar(div);
}

/* ── Los listeners globales ──────────────────────────────────────────────── */

function activarGlobal() {
  if (global) return;
  global = new AbortController();
  const { signal } = global;

  /* Terminado el arrastre, la cola vuelve a su lugar (el final de la capa) y
     pierde su tamaño: fuera de una selección en curso es un div de cero píxeles
     que no le estorba a nadie. */
  const soltar = (div, cola) => {
    div.append(cola);
    cola.style.width = '';
    cola.style.height = '';
    div.classList.remove('is-seleccionando');
  };
  const soltarTodas = () => { for (const [div, { cola }] of capas) soltar(div, cola); };

  let apretado = false;
  document.addEventListener('pointerdown', () => { apretado = true; }, { signal });
  document.addEventListener('pointerup', () => { apretado = false; soltarTodas(); }, { signal });
  /* Si la ventana pierde el foco a mitad del arrastre no llega ningún
     pointerup, y la cola se quedaría estirada para siempre. */
  window.addEventListener('blur', () => { apretado = false; soltarTodas(); }, { signal });
  document.addEventListener('keyup', () => { if (!apretado) soltarTodas(); }, { signal });

  let previo = null;
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) { soltarTodas(); return; }

    /* Solo las capas que el rango toca quedan "seleccionando". Las demás
       sueltan la cola: una selección de tres páginas no tiene por qué dejar
       colas estiradas en las otras cuarenta que hay pintadas. */
    const activas = new Set();
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      for (const div of capas.keys()) if (!activas.has(div) && r.intersectsNode(div)) activas.add(div);
    }
    for (const [div, { cola }] of capas) {
      if (activas.has(div)) div.classList.add('is-seleccionando');
      else soltar(div, cola);
    }

    const rango = sel.getRangeAt(0);
    moverLaCola(rango, previo);
    previo = rango.cloneRange();
  }, { signal });
}

/**
 * Reinserta la cola pegada al borde vivo de la selección — el que se está
 * moviendo con el mouse, que es el final si arrastrás hacia abajo y el
 * principio si arrastrás hacia arriba.
 */
function moverLaCola(rango, previo) {
  /* Si el rango nuevo termina donde terminaba el anterior, el que se movió fue
     el principio: estás arrastrando hacia atrás. */
  const desdeElInicio = !!previo && (
    rango.compareBoundaryPoints(Range.END_TO_END, previo) === 0
    || rango.compareBoundaryPoints(Range.START_TO_END, previo) === 0
  );

  let ancla = desdeElInicio ? rango.startContainer : rango.endContainer;
  if (ancla.nodeType === Node.TEXT_NODE) ancla = ancla.parentNode;

  /* El borde cayó justo en el arranque de un nodo, o sea al final del anterior:
     ahí va la cola. Se camina hacia atrás, pero CON FRENO — la selección pudo
     haber empezado fuera de una capa de texto (en el panel, en la barra), y
     entonces arriba no hay hermano que valga y la subida se sale del documento.
     pdf.js no frena porque en su visor el arrastre siempre nace adentro. */
  if (!desdeElInicio && rango.endOffset === 0) {
    do {
      while (ancla && !ancla.previousSibling) ancla = ancla.parentNode;
      if (!ancla) return;
      ancla = ancla.previousSibling;
    } while (ancla && !ancla.childNodes.length);
    if (!ancla) return;
  }

  const capa = ancla.parentElement?.closest('.qr-texto');
  const cola = capas.get(capa)?.cola;
  if (!cola) return;

  /* Estirada al tamaño de la capa, la cola cubre todos los huecos: cualquier
     salto del navegador cae adentro de ella. */
  cola.style.width = capa.style.width;
  cola.style.height = capa.style.height;
  cola.style.userSelect = 'text';
  ancla.parentElement.insertBefore(cola, desdeElInicio ? ancla : ancla.nextSibling);
}
