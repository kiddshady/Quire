/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — imprimir
   El preview NO es una simulación: es el PDF impuesto de verdad, rasterizado
   con pdf.js. El mismo archivo que sale por la impresora. Por eso no puede
   mentir, y por eso todo cambio de control re-impone en vez de mover un dibujo.

   Lo único que el preview agrega encima es el marco del área no imprimible —
   el borde que el tóner no alcanza. Eso no está en el PDF porque no es del
   documento: es de la impresora.

   ── Cómo se pone al día (auditoría de octubre de 2026, paquete 2C) ─────────
   Hasta la 0.10 todo se rehacía con innerHTML: el panel de opciones entero en
   cada clic (los switches no deslizaban, las cápsulas de los segmentados
   medían 0 y el foco se perdía), el resumen y la navegación en cada pintado,
   y la hoja del preview pasaba por un papel en blanco en cada cambio. Ahora:
   · el panel, el resumen y la navegación se arman UNA vez al montar la vista
     y después solo se sincronizan sobre los mismos nodos (motion-timing §9);
   · la hoja nueva se pinta DEBAJO de la vieja y recién cuando tiene su
     bitmap la vieja se esfuma encima (un fundido a mano: swap() inserta en el
     acto y no puede esperar a un canvas que se está pintando);
   · el pliego en blanco, la cuenta y el resumen salen de calcularHojas() en
     el mismo tick en que se monta la vista: lo único que llega tarde es el
     contenido del canvas, y entra con su fundido.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar, emitir, impresoraActual, papelesDisponibles, aplicarPapel } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Menu, Modal } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc } from '../ui.js';
import {
  raf2, exit, swap, bindStepper, bindSwitcher, numero, frase, valor, deslizarAncho, tick,
} from '../motion.js';
import { plural, fmtDec } from '../format.js';
import { planCon, mm, aMM, papelParaElDriver, calcularHojas, paginasDelPlan } from '../imposicion/plan.js';
import { imponer, partirDuplex, extraerCaras, limpiarCacheOrigen } from '../imposicion/motor.js';
import { aplanarTinta, contarTinta } from '../tinta/aplanar.js';
import { abrirDocumento } from '../pdf/documento.js';

const api = window.onyx;
const $ = (id) => document.getElementById(id);

/* ── La tinta entra ANTES de imponer ─────────────────────────────────────────
   Así los trazos viajan con su página y terminan escalados, rotados y ubicados
   exactamente igual que el contenido — en un folleto, la anotación se dobla
   con la hoja. Si se aplanara después habría que rehacer toda la geometría de
   la imposición para la tinta, y sería otro camino que puede divergir.

   Se cachea por versión de la capa: reescribir el PDF entero en cada tecleo
   del campo de escala no aporta nada, la tinta no cambió.

   La caché cuelga del documento (imprimir-27, tinta-27). Era una variable del
   módulo con el documento y la copia aplanada adentro: cerrar la pestaña no
   la soltaba, y un escaneo anotado de 150 MB seguía ocupando su memoria hasta
   imprimir otra cosa con tinta. Con un WeakMap la entrada se va con el
   documento, y dos pestañas anotadas ya no se pisan la única entrada. */
const cacheTinta = new WeakMap();

async function bytesParaImprimir() {
  const doc = S.doc;
  if (!S.tinta || S.tinta.vacia) return doc.bytes;
  const guardada = cacheTinta.get(doc);
  if (guardada && guardada.version === S.tinta.version) return guardada.bytes;

  // La versión se toma ANTES de aplanar: un trazo que llega mientras tanto no
  // queda adentro, y con la de después se daría por incluido.
  const version = S.tinta.version;
  const bytes = await aplanarTinta(doc.bytes, S.tinta);
  cacheTinta.set(doc, { version, bytes });
  return bytes;
}

/* Cuántas hojas se imponen para mirar, alrededor de la que se está viendo.
   Era un tope de 24 desde el principio del documento: un 4×4 embebía 384
   páginas para mostrar una, y la flecha se apagaba en «24 (de 100)» —lo de
   más allá no se podía revisar antes de imprimirlo— (imprimir-13). Ahora la
   ventana va con la hoja: ocho, dos para atrás y el resto para adelante, y al
   salirse de ella se vuelve a imponer donde se está mirando. */
const VENTANA = 8;
const ATRAS = 2;

/* A partir de cuántas hojas de papel el resumen destaca el total. No se pide
   confirmación (lo decidió Fran, ux-29): se ve, y si las copias multiplican,
   se dice cuántas por copia. */
const MUCHAS_HOJAS = 20;

const V = {
  doc: null,          // el PDF impuesto (la ventana), abierto con pdf.js
  calculo: null,      // el cálculo con el que se impuso V.doc
  impuesto: null,     // el plan con el que se impuso V.doc (para el marco)
  desde: 0,           // índice (base 0) de la primera hoja de V.doc en el cálculo
  generadas: 0,
  plano: null,        // el cálculo del plan VIGENTE: resumen y navegación
  alDia: false,       // V.doc corresponde al plan vigente
  hoja: 1,            // la hoja que se mira, sobre el total del plan
  pendiente: null,
  generacion: 0,      // para descartar resultados de una imposición vieja
  enVuelo: false,
  otraVez: false,
  montada: false,     // la vista está a la vista (ver rehacerImposicion)
  imprimiendo: false,
  pliego: null,       // el que se ve
  entrante: null,     // el que se está pintando debajo
  render: null,
  reescala: null,
  timerReescala: null,
  segmentos: new Map(),   // id → la función que vuelve a medir su cápsula
  syncCopias: null,
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

/* El papel y el área imprimible son de la IMPRESORA, no del plan: el plan
   recuerda con cuál se armaron y, si cambió, se vuelven a pedir. Antes se
   congelaban al crear el plan, y cambiar de impresora en Ajustes, «Releer
   impresoras», una pestaña que ya tenía plan o una primera visita antes de
   que llegaran las capacidades dejaban la banda gris y el ajuste del
   contenido de otra impresora (imprimir-09). Si el papel no existe en la
   nueva, se busca el de la misma medida.

   No se decide por el NOMBRE de la impresora: «Releer impresoras» con la
   misma y capacidades nuevas (otra área, otro juego de papeles) no cambia el
   nombre, y el plan se quedaba con el área vieja (lo midió la revisión del
   2C). Se compara lo que el plan tiene contra lo que la impresora da hoy para
   ese papel, y si difiere se vuelve a aplicar. Si no cambió nada devuelve el
   MISMO objeto: cambiar() compara contra él. */
function plan() {
  if (!S.plan) {
    S.plan = { ...planInicial(), impresora: S.impresora };
    return S.plan;
  }
  const papeles = papelesDisponibles();
  const viejo = S.plan.papel;
  const mismo = papeles.find((x) => x.id === viejo.id)
    || papeles.find((x) => Math.abs(x.ancho - viejo.ancho) <= 1 && Math.abs(x.alto - viejo.alto) <= 1)
    || papeles.find((x) => x.nombre === (S.settings?.papelDefecto || 'A4'))
    || papeles[0];
  const hoy = aplicarPapel(S.plan, mismo?.id);
  // Las copias, dentro de lo que acepta la impresora de hoy.
  const copias = Math.min(S.plan.copias || 1, impresoraActual()?.maxCopias || 999);
  const firma = (x) => JSON.stringify([x.papel, x.imprimible ?? null]);
  if (firma(hoy) !== firma(S.plan) || copias !== (S.plan.copias || 1) || S.plan.impresora !== S.impresora) {
    S.plan = { ...hoy, copias, impresora: S.impresora };
  }
  return S.plan;
}

/* Un cambio del plan. Si no cambió nada, no pasa nada: tocar la opción que ya
   estaba elegida re-imponía y la hoja se apagaba y volvía (imprimir-24).
   El panel ya no se rehace: se sincroniza sobre los mismos nodos. */
function cambiar(parche, { rehacer = true } = {}) {
  const antes = plan();
  const nuevo = { ...antes, ...parche };
  if (JSON.stringify(nuevo) === JSON.stringify(antes)) return false;
  S.plan = nuevo;
  sincronizarOpciones();
  if (rehacer) {
    ponerAlDia();
    if (V.plano) programarImposicion();
  } else pintarResumen();
  return true;
}

/* El cálculo del plan vigente es síncrono y barato (aritmética de
   rectángulos): el resumen y la cuenta de hojas se ponen al día en el acto,
   mientras la hoja se re-impone atenuada. */
function ponerAlDia() {
  if (!S.doc) return;
  V.alDia = false;
  let c = null;
  try { c = calcularHojas(plan(), S.geometrias); } catch (err) { console.error('[imprimir]', err); }
  if (!c || !c.hojas.length) {
    V.plano = null;
    mostrarError('El plan no deja ninguna página para imprimir');
    return;
  }
  V.plano = c;
  V.hoja = Math.max(1, Math.min(c.hojas.length, V.hoja));
  ponerNavegacion();
  pintarResumen();
  avisarPapel();
}

/* ── Imposición: una en vuelo y a lo sumo una pendiente ──────────────────────
   El token de generación descartaba el resultado viejo pero no frenaba el
   trabajo: si imponer tardaba más que el intervalo entre clics, varias
   corrían a la vez en el hilo principal y competían entre ellas y con la
   interfaz (imprimir-13). Ahora un pedido nuevo invalida lo que está en
   vuelo, y si hay una corriendo, espera a que termine: corre solo la última. */

function programarImposicion({ ya = false } = {}) {
  clearTimeout(V.pendiente);
  V.generacion += 1;
  marcarTrabajando(true);
  // 220 ms: alcanza para escribir "150" en el campo de escala sin que se
  // imponga tres veces, y no se siente como demora.
  V.pendiente = setTimeout(rehacerImposicion, ya ? 0 : 220);
}

function ventanaPara(hoja, total) {
  return Math.max(0, Math.min(hoja - 1 - ATRAS, total - VENTANA));
}

async function rehacerImposicion() {
  /* Con la vista desmontada no se impone nada: el pedido que quedaba
     pendiente cuando se salía con una imposición en vuelo (un PDF pesado y
     dos toques seguidos) se largaba igual desde el finally, imponía el
     documento entero y dejaba en V.doc un PDF de pdf.js que nadie destruía
     (revisión del 2C). */
  if (!S.doc || !V.montada) return;
  if (V.enVuelo) { V.otraVez = true; return; }
  V.enVuelo = true;
  const mio = V.generacion;
  const p = plan();

  try {
    const total = V.plano?.hojas.length || 1;
    const r = await imponer(await bytesParaImprimir(), p, S.geometrias,
      { limiteHojas: VENTANA, desde: ventanaPara(V.hoja, total) });
    if (mio !== V.generacion) return;   // llegó un pedido más nuevo

    /* Primero se abre el nuevo y recién después se suelta el viejo, cuando la
       hoja nueva ya está pintada. Destruirlo antes dejaba a V.doc apuntando a
       un documento cerrado durante el await, y una flecha o un resize en ese
       rato tiraban «El documento ya se cerró» sin catch (imprimir-32). */
    const doc = await abrirDocumento(r.bytes, { nombre: 'preview.pdf' });
    if (mio !== V.generacion) { doc.destruir(); return; }

    const viejo = V.doc;
    Object.assign(V, {
      doc, calculo: r.calculo, impuesto: p, desde: r.desde, generadas: r.generadas,
      plano: r.calculo, alDia: true,
    });
    V.hoja = Math.max(1, Math.min(r.calculo.hojas.length, V.hoja));
    sacarError();
    ponerNavegacion();
    pintarResumen();

    await pintarHoja();
    // marcarTrabajando(false) recién con la hoja nueva a la vista: antes se
    // sacaba en el finally y lo que volvía a pleno era la hoja VIEJA (css-03).
    if (mio === V.generacion) marcarTrabajando(false);
    if (viejo && viejo !== V.doc) viejo.destruir();
  } catch (err) {
    if (mio !== V.generacion) return;
    console.error('[imprimir]', err);
    mostrarError(err.message);
    marcarTrabajando(false);
  } finally {
    V.enVuelo = false;
    if (V.otraVez) { V.otraVez = false; rehacerImposicion(); }
  }
}

function marcarTrabajando(si) {
  $('qr-preview')?.classList.toggle('is-trabajando', si);
}

/* Un error deja el preview INVÁLIDO, no la hoja anterior: antes V.doc y el
   cálculo seguían siendo los de la imposición de antes, y una flecha o un
   resize volvían a pintar encima del error una hoja que no era la que se iba
   a imprimir, con un resumen que tampoco (imprimir-15). La hoja se esfuma, la
   navegación se apaga y el mensaje entra con un relevo; cuando vuelve a
   andar, sale igual. */
function mostrarError(mensaje) {
  clearTimeout(V.pendiente);
  V.generacion += 1;
  marcarTrabajando(false);   // el cartel no se lee atenuado
  V.render?.cancelar();
  V.reescala?.cancelar();
  if (V.entrante) { V.entrante.remove(); V.entrante = null; }
  if (V.pliego) { retirar(V.pliego); V.pliego = null; }
  V.doc?.destruir();
  Object.assign(V, { doc: null, calculo: null, plano: null, alDia: false, desde: 0, generadas: 0 });
  ponerNavegacion();
  pintarResumen();
  swap($('qr-preview-aviso'), `<div class="qr-preview__error">${Icons.svg('alert')}
    <span class="ox-label">No se pudo armar el pliego</span>
    <span class="ox-meta ox-copyable">${esc(mensaje)}</span></div>`, { relevo: true });
}

function sacarError() {
  swap($('qr-preview-aviso'), '');
}

/* ── La hoja ─────────────────────────────────────────────────────────────── */

/* Varias cosas piden pintar casi a la vez (la imposición que termina, una
   flecha, el resize). El token hace que solo el pintado más nuevo pueda
   mostrar su hoja: si este quedó viejo, su pliego ya no está en el DOM. */
let generacionPintado = 0;

/** El tamaño del pliego en pantalla. Sale del papel del cálculo: es el mismo
    que el de las páginas del PDF impuesto (motor.js las crea de ese papel). */
function medidas(calculo = V.calculo) {
  const cuerpo = $('qr-preview-cuerpo');
  const papel = calculo?.papel;
  if (!cuerpo || !papel) return null;
  const caja = cuerpo.getBoundingClientRect();
  if (caja.width < 8 || caja.height < 8) return null;   // todavía sin layout
  // 32 px de aire para que la hoja no toque los bordes del área de preview.
  const escala = Math.max(0.05, Math.min((caja.width - 64) / papel.ancho, (caja.height - 64) / papel.alto));
  return { escala, ancho: Math.round(papel.ancho * escala), alto: Math.round(papel.alto * escala) };
}

/* Con una impresora solo blanco y negro el trabajo sale en gris
   (impresion.cjs le pide `monochrome`): el preview también, o mostraría la
   tinta roja en rojo (imprimir-25). */
const esMono = () => !!impresoraActual()?.soloMonocromo;

function nuevoPliego(m, { relevo, p = V.impuesto, calculo = V.calculo }) {
  const el = document.createElement('div');
  el.className = `qr-pliego qr-pliego--preview${relevo ? ' qr-pliego--relevo' : ''}${esMono() ? ' is-mono' : ''}`;
  el.style.width = `${m.ancho}px`;
  el.style.height = `${m.alto}px`;
  el.innerHTML = `<canvas class="qr-hoja"></canvas>${marcoNoImprimible(p, calculo)}`;
  $('qr-preview-cuerpo').insertBefore(el, $('qr-preview-aviso'));
  return el;
}

/**
 * Pinta la hoja V.hoja. La hoja que se ve no se toca hasta que la nueva tiene
 * su bitmap (imprimir-03, css-02):
 * · Si todavía no hay ninguna pintada (el pliego en blanco del montaje), se
 *   pinta sobre él y el contenido entra con un fundido, como en el lector.
 * · Si no, el pliego nuevo va DEBAJO, en la misma celda de la grilla, y
 *   cuando pdf.js termina se muestra mientras el viejo se esfuma encima. Si
 *   pdf.js tarda más de 400 ms, se muestra igual y el contenido entra con su
 *   fundido cuando llega: mejor un papel que se llena que una espera muda.
 * Devuelve una promesa que se resuelve cuando la hoja nueva está a la vista.
 */
function pintarHoja() {
  const cuerpo = $('qr-preview-cuerpo');
  if (!cuerpo || !V.doc || !V.calculo) return Promise.resolve();
  const m = medidas();
  if (!m) return Promise.resolve();

  const n = V.hoja - V.desde;   // la página adentro del PDF de la ventana
  if (n < 1 || n > V.generadas) { programarImposicion({ ya: true }); return Promise.resolve(); }

  const mio = ++generacionPintado;
  // Lo que se estaba pintando debajo y nadie llegó a ver se va sin más.
  V.render?.cancelar();
  if (V.entrante) { V.entrante.remove(); V.entrante = null; }

  let el;
  if (V.pliego && !V.pliego.classList.contains('is-pintada')) {
    el = V.pliego;                 // el pliego en blanco: se llena en el lugar
    el.style.width = `${m.ancho}px`;
    el.style.height = `${m.alto}px`;
    ponerMarco(el, V.impuesto, V.calculo);
    el.classList.toggle('is-mono', esMono());
  } else {
    // Siempre entra fundiéndose: si no había ninguna (después de un error),
    // el papel no puede aparecer de golpe.
    el = nuevoPliego(m, { relevo: true });
    if (V.pliego) V.entrante = el;
    else V.pliego = el;
  }

  const canvas = el.querySelector('canvas');
  el.__escala = m.escala;
  const tarea = V.doc.render(n, { canvas, escala: m.escala });
  V.render = tarea;
  return new Promise((listo) => {
    const tope = setTimeout(() => { if (mio === generacionPintado) mostrar(el, false); listo(); }, 400);
    tarea.promesa
      .then((r) => {
        clearTimeout(tope);
        if (r && mio === generacionPintado) mostrar(el, true);
      })
      .catch((err) => {
        clearTimeout(tope);
        if (err?.name !== 'RenderingCancelledException') console.error('[imprimir]', err);
      })
      .finally(listo);
  });
}

/* El pliego entra a la vista. Si llega pintado y todavía no se veía, el canvas
   queda opaco en el acto (está tapado por el pliego, que es el que hace el
   fundido) y recién después se muestra el pliego: con los dos fundidos a la
   vez el contenido entraba más tarde que el papel. */
function mostrar(el, pintada) {
  if (!el.isConnected) return;
  if (pintada) {
    el.classList.add('is-pintada');
    void getComputedStyle(el.querySelector('canvas')).opacity;
  }
  if (!el.classList.contains('is-mostrada')) {
    el.classList.add('is-mostrada');
    if (V.entrante === el) {
      const viejo = V.pliego;
      V.pliego = el;
      V.entrante = null;
      if (viejo && viejo !== el) retirar(viejo);
    }
  }
  // Si la ventana cambió de tamaño mientras se pintaba, se repinta a escala.
  const m = medidas();
  if (pintada && m && Math.abs(m.escala - el.__escala) > 1e-3) reescalar();
}

/** El pliego que se va: encima del nuevo, esfumándose (ox-desvanecer). */
function retirar(el) {
  el.classList.add('qr-pliego--saliente');
  el.inert = true;
  el.setAttribute('aria-hidden', 'true');
  exit(el, { fallback: 480 });
}

/* Al redimensionar, el pliego que se ve cambia de tamaño en el acto y su
   bitmap se estira por CSS (el canvas mide el 100 % del pliego); 120 ms
   después del último cambio se repinta a la escala nueva sobre el MISMO
   canvas, con el doble buffer de documento.js. Antes cada cuadro del resize
   rehacía el pliego con un canvas vacío y cancelaba el render anterior: el
   papel quedaba en blanco mientras se arrastraba el borde (imprimir-14). La
   navegación ya no se toca. */
function reescalar() {
  const m = medidas();
  if (!m) return;
  for (const el of [V.pliego, V.entrante]) {
    if (!el) continue;
    el.style.width = `${m.ancho}px`;
    el.style.height = `${m.alto}px`;
  }
  clearTimeout(V.timerReescala);
  V.timerReescala = setTimeout(() => {
    const el = V.pliego;
    const m2 = medidas();
    if (!el || !m2 || !V.doc || V.entrante) return;
    if (!el.classList.contains('is-pintada')) { pintarHoja(); return; }
    if (Math.abs(m2.escala - el.__escala) < 1e-3) return;
    const n = V.hoja - V.desde;
    if (n < 1 || n > V.generadas) return;
    el.__escala = m2.escala;
    V.reescala?.cancelar();
    V.reescala = V.doc.render(n, { canvas: el.querySelector('canvas'), escala: m2.escala, preservar: true });
    V.reescala.promesa.catch((err) => {
      if (err?.name !== 'RenderingCancelledException') console.error('[imprimir]', err);
    });
  }, 120);
}

/**
 * El marco de lo que el tóner no alcanza.
 *
 * Se dibuja como una banda sobre el papel, no como una línea: lo importante no
 * es dónde está el límite sino cuánta hoja queda afuera. Si algo del documento
 * cae en la banda, no se va a imprimir.
 *
 * Va en PORCENTAJES del pliego (y no en px, como antes): así acompaña al
 * pliego cuando cambia de tamaño sin recalcular nada. La banda es un
 * `clip-path` con el rectángulo de afuera y el de adentro: el clip recorta
 * también el puntero, y el tooltip sale solo sobre la banda. Antes la caja
 * entera recibía el pointerover y el tooltip salía en el medio de la hoja
 * (imprimir-17).
 */
function marcoNoImprimible(p, calculo) {
  const papel = calculo?.papel;
  if (!p?.imprimible || !S.settings?.mostrarNoImprimible || !papel) return '';
  return `<div class="qr-noimprimible" aria-hidden="true" style="${estiloMarco(p, papel)}"
    data-tip="El tóner no llega a esta banda"></div>`;
}

function estiloMarco(p, papel) {
  const papelApaisado = papel.ancho > papel.alto;
  const naturalApaisado = p.papel.ancho > p.papel.alto;
  const im = p.imprimible;
  const [ix, iy, iw, ih] = papelApaisado !== naturalApaisado
    ? [im.y, im.x, im.alto, im.ancho]
    : [im.x, im.y, im.ancho, im.alto];
  const ancho = aMM(papel.ancho);
  const alto = aMM(papel.alto);
  const pct = (v, de) => `${(Math.max(0, v) / de * 100).toFixed(3)}%`;
  return `--qr-ni-arr:${pct(iy, alto)};--qr-ni-der:${pct(ancho - ix - iw, ancho)};`
    + `--qr-ni-aba:${pct(alto - iy - ih, alto)};--qr-ni-izq:${pct(ix, ancho)}`;
}

/* El marco del pliego en blanco, puesto al día en el lugar: si cambia el
   área, la banda viaja (las variables están registradas con @property). */
function ponerMarco(el, p, calculo) {
  const html = marcoNoImprimible(p, calculo);
  const marco = el.querySelector('.qr-noimprimible');
  if (marco && html) marco.setAttribute('style', estiloMarco(p, calculo.papel));
  else if (marco) exit(marco, { fallback: 260 });
  else if (html) el.insertAdjacentHTML('beforeend', html);
}

/* ── Navegación ──────────────────────────────────────────────────────────────
   Vive en el HTML de la vista y se pone al día: la cuenta con numero() y
   frase(), la etiqueta de la cara con un relevo y un chip que se pliega a lo
   ancho. Antes se rehacía en cada pintado (y en cada cuadro de un resize): la
   cuenta y la etiqueta saltaban, y el botón con foco se moría al primer paso
   (imprimir-11). */

function etiquetaDe(hoja, n) {
  if (!hoja) return '';
  if (hoja.etiquetaPoster) return `pág. ${hoja.etiquetaPoster}`;
  if (hoja.cara) return `${hoja.cara === 'frente' ? 'frente' : 'dorso'} de la hoja ${Math.ceil(n / 2)}`;
  return '';
}

function ponerNavegacion() {
  const c = V.plano;
  const total = c?.hojas.length || 0;
  const prev = $('qr-hoja-prev');
  const next = $('qr-hoja-next');
  if (!prev || !next) return;
  prev.disabled = !total || V.hoja <= 1;
  next.disabled = !total || V.hoja >= total;
  ponerCuenta(total);

  const chip = $('qr-nav-chip');
  const texto = $('qr-nav-chip-texto');
  const etiqueta = esc(etiquetaDe(c?.hojas[V.hoja - 1], V.hoja));
  if (!etiqueta) { chip.hidden = true; return; }
  if (chip.hidden) {
    // Plegado no se ve: se escribe en el lugar y el chip se despliega con él.
    swap(texto, etiqueta);
    chip.hidden = false;
  } else deslizarAncho(chip, () => swap(texto, etiqueta, { relevo: true }));
}

/* La cuenta «3 de 8». Sin plano (el preview en error) se vacía esfumándose:
   antes solo se escribía con hojas, y durante el error seguía diciendo la de
   antes —«1 de 2» al lado de «Nada para imprimir»— (imprimir-15, revisión
   del 2C). Lo vacío se marca para que la vuelta entre con un relevo: numero()
   compara contra el texto, y el que se está yendo todavía está en el DOM. */
function ponerCuenta(total) {
  const actual = $('qr-nav-actual');
  if (!actual) return;
  if (!total) {
    if (!actual.__vacia && actual.textContent.trim()) {
      actual.__vacia = true;
      swap(actual, '');
    }
    frase($('qr-nav-total'), '');
    return;
  }
  if (actual.__vacia) {
    actual.__vacia = false;
    swap(actual, String(V.hoja));
  } else numero(actual, V.hoja);
  frase($('qr-nav-total'), `de ${total}`);
}

function irAHoja(n) {
  const total = V.plano?.hojas.length || 0;
  if (!total) return;
  const h = Math.max(1, Math.min(total, n));
  if (h === V.hoja) return;
  V.hoja = h;
  ponerNavegacion();
  // Con una imposición pendiente, la que llega ya pinta la hoja nueva.
  if (!V.doc || !V.alDia) return;
  if (h > V.desde && h <= V.desde + V.generadas) pintarHoja().catch(() => {});
  else programarImposicion({ ya: true });
}

/* ── Resumen ─────────────────────────────────────────────────────────────────
   Armado una vez, con la cifra VACÍA en el HTML: si naciera en «0», el primer
   dato real contaría como cambio y destellaría al montar. Después se pone al
   día en el lugar: frase() para lo que es una frase (si cambian solo las
   cifras destella; «1 hoja» → «2 hojas» se releva), numero() para un número
   suelto, y la fila de Tinta y el aviso siempre en el DOM, plegables. Antes
   era un innerHTML en cada imposición y en cada flecha de Copias
   (imprimir-10, css-16). */

/** La sugerencia del aviso, nombrando solo lo que cambiaría algo: con el
    margen ya apagado (o sin área informada) pedía apagarlo igual, y con un
    nombre que el switch no tiene (imprimir-30, ux-27). Cuando hay desborde la
    escala es Tamaño real o Personalizada: Ajustar siempre lo arregla.

    El switch se nombra solo si apagarlo se lleva el desborde: al 150 % o al
    200 % el contenido se sale del papel mismo, y se le pedía al usuario algo
    que no resolvía lo que el aviso describe (revisión del 2C). El cálculo de
    prueba es el mismo, aritmética de rectángulos. */
function textoDesborde(p) {
  let margen = false;
  if (p.respetarNoImprimible && p.imprimible) {
    try {
      margen = !calcularHojas({ ...p, respetarNoImprimible: false }, S.geometrias).resumen.desborde;
    } catch { margen = false; }
  }
  return 'Hay contenido fuera del área imprimible: eso no va a salir en el papel. '
    + `Pasá la escala a <b>Ajustar</b>${margen ? ' o apagá <b>Respetar el área imprimible</b>' : ''}.`;
}

function pintarResumen() {
  const cifra = $('qr-res-hojas');
  if (!cifra) return;
  const c = V.plano;
  const p = plan();
  const boton = $('qr-imprimir');

  if (!c) {
    frase(cifra, 'Nada para imprimir');
    $('qr-res-cifra').classList.remove('is-mucho');
    $('qr-res-detalle').hidden = true;
    numero($('qr-res-paginas'), 0);
    frase($('qr-res-caras'), '0');
    // El papel del plan, sin la orientación: esa era del cálculo que ya no
    // vale, y quedaba diciendo «A4 apaisado» (revisión del 2C).
    frase($('qr-res-papel'), esc(p.papel.nombre));
    $('qr-res-aviso').hidden = true;
    if (boton && !V.imprimiendo) boton.disabled = true;
    return;
  }

  const r = c.resumen;
  const copias = Math.max(1, p.copias || 1);
  const total = r.hojasFisicas * copias;
  frase(cifra, plural(total, 'hoja de papel', 'hojas de papel'));
  $('qr-res-cifra').classList.toggle('is-mucho', total >= MUCHAS_HOJAS);
  const detalle = $('qr-res-detalle');
  if (copias > 1) frase($('qr-res-detalle-texto'), `${plural(r.hojasFisicas, 'hoja', 'hojas')} por copia, ${copias} copias`);
  detalle.hidden = copias <= 1;

  numero($('qr-res-paginas'), r.paginasOriginales);
  frase($('qr-res-caras'), copias > 1 ? `${r.hojas} × ${copias}` : String(r.hojas));
  frase($('qr-res-papel'), esc(`${p.papel.nombre}${c.papel.apaisado ? ' apaisado' : ''}`));

  const trazos = contarTinta(S.tinta);
  if (trazos) frase($('qr-res-tinta'), `${plural(trazos, 'trazo', 'trazos')}, incluidos`);
  for (const el of document.querySelectorAll('#qr-resumen .qr-resumen__tinta')) el.hidden = !trazos;

  if (r.desborde) frase($('qr-res-aviso-texto'), textoDesborde(p));
  $('qr-res-aviso').hidden = !r.desborde;
  if (boton && !V.imprimiendo) boton.disabled = false;
}

/* ── Opciones ────────────────────────────────────────────────────────────── */

/* Los tooltips de los modos dicen qué hacen: repetían el rótulo que ya se lee
   abajo del ícono (ux-19). */
const MODOS = [
  { id: 'simple', label: 'Simple', icono: 'file', tip: 'Una página en cada hoja' },
  { id: 'nup', label: 'Múltiple', icono: 'nup', tip: 'Varias páginas en cada hoja' },
  { id: 'folleto', label: 'Folleto', icono: 'folleto', tip: 'Cuadernillo para doblar al medio' },
  { id: 'poster', label: 'Póster', icono: 'poster', tip: 'Una página partida en varias hojas' },
];

const ESCALAS = [
  { id: 'ajustar', label: 'Ajustar' },
  { id: 'reducir', label: 'Solo reducir' },
  { id: 'real', label: 'Tamaño real' },
  { id: 'custom', label: 'Personalizada' },
];

const ORDENES = {
  horizontal: 'Horizontal', 'horizontal-inv': 'Horizontal invertido',
  vertical: 'Vertical', 'vertical-inv': 'Vertical invertido',
};

/* El mismo texto que Ajustes para «no hay impresoras» (ux-20): dice qué hacer. */
const SIN_IMPRESORAS = 'Instalá una impresora en Windows y tocá Releer impresoras en Ajustes.';

const nombreImpresora = () => impresoraActual()?.etiqueta || S.impresora || 'Ninguna';
const textoRango = (p) => (p.rango === 'todo' ? 'Todas las páginas' : p.rango);
const textoEscala = (p) => ESCALAS.find((e) => e.id === p.escala.tipo)?.label || 'Ajustar';
const textoCuadernillo = (p) => (p.folleto.porCuadernillo ? plural(p.folleto.porCuadernillo, 'hoja', 'hojas') : 'Uno solo');

/* «Se lo pide al driver» era un tecnicismo (ux-28). */
const notaDuplex = () => (S.settings?.duplexAsistido
  ? 'Quire imprime los frentes, te muestra cómo va el fajo de vuelta a la bandeja, y manda los dorsos en el orden correcto.'
  : 'Se lo pide a la impresora: si no tiene dúplex, va a mostrar su propio cartel.');

const notaMargen = (p) => `Ajusta el contenido a donde el tóner llega de verdad${
  p.imprimible ? ` (${fmtDec(aMM(mm(p.imprimible.ancho)), 0)} × ${fmtDec(aMM(mm(p.imprimible.alto)), 0)} mm)` : ''}.`;

const pct = (v, min, rango) => `${((v - min) / rango * 100).toFixed(1)}%`;

const opcion = (id, label, activa) =>
  `<button class="ox-segmented__opt${activa ? ' is-active' : ''}" data-value="${id}">${label}</button>`;

/* El panel entero, una sola vez. Lo que depende de otra opción (el slider de
   Personalizada, la frase del dúplex, el aviso de monocromo y el del papel)
   vive siempre en el DOM como .ox-plegable: aparecía y se iba de golpe y el
   panel cambiaba de alto en un cuadro (imprimir-04). */
function panelHTML(p) {
  const imp = impresoraActual();
  return `
    <div class="qr-op">
      <span class="ox-eyebrow">Impresora</span>
      <button class="ox-select" id="op-impresora">
        <span class="ox-truncate" id="op-impresora-nombre">${esc(nombreImpresora())}</span><i data-icon="chevronDown"></i>
      </button>
      <span class="ox-meta ox-plegable" id="op-mono"${imp?.soloMonocromo ? '' : ' hidden'}>Esta impresora es solo blanco y negro: la vista previa va en grises.</span>
    </div>

    <div class="qr-op qr-op--par">
      <div class="ox-field">
        <label class="ox-field__label" for="op-copias">Copias</label>
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
        <span class="ox-field__label">Papel</span>
        <button class="ox-select" id="op-papel">
          <span class="ox-truncate" id="op-papel-nombre">${esc(p.papel.nombre)}</span><i data-icon="chevronDown"></i>
        </button>
      </div>
      <span class="ox-meta ox-plegable qr-op__aviso" id="op-papel-aviso" hidden>Este papel no se le puede pedir por nombre a la impresora: va a salir en el que tenga puesto.</span>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Qué se imprime</span>
      <button class="ox-select" id="op-rango">
        <span class="ox-truncate" id="op-rango-texto">${esc(textoRango(p))}</span><i data-icon="chevronDown"></i>
      </button>
      <div class="ox-segmented" id="op-subconjunto">
        ${[['todas', 'Todas'], ['impares', 'Impares'], ['pares', 'Pares']].map(([id, l]) => opcion(id, l, p.subconjunto === id)).join('')}
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Disposición</span>
      <div class="qr-modos" id="op-modo">
        ${MODOS.map((m) => `
          <button class="qr-modo${p.modo === m.id ? ' is-active' : ''}" data-value="${m.id}" data-tip="${m.tip}">
            <i data-icon="${m.icono}"></i><span>${m.label}</span>
          </button>`).join('')}
      </div>
      <div class="qr-op__modo" id="op-modo-bloque">${opcionesDelModo(p)}</div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Escala y orientación</span>
      <button class="ox-select" id="op-escala">
        <span class="ox-truncate" id="op-escala-texto">${textoEscala(p)}</span><i data-icon="chevronDown"></i>
      </button>
      <div class="ox-row qr-deslizador ox-plegable" id="op-escala-fila"${p.escala.tipo === 'custom' ? '' : ' hidden'}>
        <input class="ox-slider ox-grow" id="op-escala-valor" type="range" min="10" max="400" step="1"
               value="${p.escala.valor}" style="--ox-pct:${pct(p.escala.valor, 10, 390)}">
        <span class="ox-chip ox-chip--mono" id="op-escala-eco">${p.escala.valor}%</span>
      </div>
      <div class="ox-segmented" id="op-orientacion">
        ${[['auto', 'Automática'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']].map(([id, l]) => opcion(id, l, p.orientacion === id)).join('')}
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Ambas caras</span>
      <div class="ox-segmented" id="op-duplex">
        ${[['simplex', 'Una cara'], ['largo', 'Lado largo'], ['corto', 'Lado corto']].map(([id, l]) => opcion(id, l, p.duplex === id)).join('')}
      </div>
      <span class="ox-meta ox-plegable" id="op-duplex-nota"${p.duplex === 'simplex' ? ' hidden' : ''}>${notaDuplex()}</span>
    </div>

    <div class="qr-op">
      <label class="ox-row qr-fila qr-fila--arriba">
        <button class="ox-switch${p.respetarNoImprimible ? ' is-on' : ''}" id="op-margen"></button>
        <span class="ox-col qr-apilado">
          <span class="ox-label">Respetar el área imprimible</span>
          <span class="ox-meta" id="op-margen-nota">${notaMargen(p)}</span>
        </span>
      </label>
    </div>`;
}

/* El bloque de cada modo es UNA caja (un solo nodo raíz) que se releva al
   cambiar de modo, con el alto deslizándose. En Simple no hay nada: la caja
   queda vacía, sin alto, y el margen negativo del bloque se come el gap de
   la columna. */
function opcionesDelModo(p) {
  if (p.modo === 'nup') {
    const grillas = [[1, 2], [2, 2], [2, 3], [3, 3], [4, 4]];
    return `<div class="qr-op__campos">
      <div class="ox-field">
        <span class="ox-field__label">Páginas por hoja</span>
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
        <span class="ox-field__label">Orden</span>
        <button class="ox-select" id="op-nup-orden">
          <span class="ox-truncate" id="op-nup-orden-texto">${ORDENES[p.nup.orden]}</span><i data-icon="chevronDown"></i>
        </button>
      </div>
      <label class="ox-row qr-fila">
        <button class="ox-switch${p.nup.borde ? ' is-on' : ''}" id="op-nup-borde"></button>
        <span class="ox-label">Dibujar el borde de cada página</span>
      </label>
    </div>`;
  }

  if (p.modo === 'folleto') {
    return `<div class="qr-op__campos">
      <div class="ox-field">
        <span class="ox-field__label">Encuadernación</span>
        <div class="ox-segmented" id="op-folleto-lado">
          ${[['izquierda', 'Izquierda'], ['derecha', 'Derecha']].map(([id, l]) => opcion(id, l, p.folleto.encuadernacion === id)).join('')}
        </div>
      </div>
      <div class="ox-field">
        <span class="ox-field__label">Hojas por cuadernillo</span>
        <button class="ox-select" id="op-folleto-cuadernillo">
          <span class="ox-truncate" id="op-folleto-cuadernillo-texto">${textoCuadernillo(p)}</span><i data-icon="chevronDown"></i>
        </button>
        <span class="ox-field__hint">Un cuadernillo muy grueso no cierra bien al doblarlo.</span>
      </div>
    </div>`;
  }

  if (p.modo === 'poster') {
    return `<div class="qr-op__campos">
      <div class="ox-field">
        <span class="ox-field__label">Agrandar a</span>
        <div class="ox-row qr-deslizador">
          <input class="ox-slider ox-grow" id="op-poster-escala" type="range" min="100" max="1000" step="10"
                 value="${p.poster.escala}" style="--ox-pct:${pct(p.poster.escala, 100, 900)}">
          <span class="ox-chip ox-chip--mono" id="op-poster-eco">${p.poster.escala}%</span>
        </div>
      </div>
      <div class="ox-field">
        <span class="ox-field__label">Solape entre hojas</span>
        <div class="ox-row qr-deslizador">
          <input class="ox-slider ox-grow" id="op-poster-solape" type="range" min="0" max="30" step="1"
                 value="${p.poster.solape}" style="--ox-pct:${pct(p.poster.solape, 0, 30)}">
          <span class="ox-chip ox-chip--mono" id="op-poster-solape-eco">${p.poster.solape} mm</span>
        </div>
        <span class="ox-field__hint">Material repetido para pegar sin que quede una línea blanca.</span>
      </div>
      <label class="ox-row qr-fila">
        <button class="ox-switch${p.poster.marcas ? ' is-on' : ''}" id="op-poster-marcas"></button>
        <span class="ox-label">Marcas de corte en las esquinas</span>
      </label>
    </div>`;
  }

  // Vacío pero con su nodo: así el relevo al volver a Simple tiene a qué
  // deslizar el alto (con '' lo viejo se iba EN el flujo y el alto caía de
  // golpe al final).
  return '<div class="qr-op__campos qr-op__campos--vacio"></div>';
}

/* Un rótulo que cambia (el nombre del papel, de la impresora, el rango): un
   relevo en su lugar. Recuerda el último para no relevar lo mismo, y la
   primera vez adopta lo que ya dice el HTML sin animar nada. */
function rotulo(el, html) {
  if (!el || el.__rotulo === html) return;
  const primera = el.__rotulo === undefined;
  el.__rotulo = html;
  if (primera && el.innerHTML.trim() === html.trim()) return;
  swap(el, html, { relevo: true });
}

/* Elige una opción de un segmentado desde afuera (el plan cambió por otro
   lado: el folleto que prende el dúplex) y hace viajar la cápsula. */
function elegir(id, valor_) {
  const seg = $(id);
  const opt = seg?.querySelector(`.ox-segmented__opt[data-value="${CSS.escape(String(valor_))}"]`);
  if (!opt || opt.classList.contains('is-active')) return;
  seg.querySelectorAll('.ox-segmented__opt').forEach((o) => o.classList.toggle('is-active', o === opt));
  V.segmentos.get(id)?.();
}

/* Los segmentados con bindSwitcher: la cápsula nace en su lugar y viaja, y el
   clic sobre la opción activa no hace nada. Se cableaban a mano cambiando la
   clase, y la cápsula medía 0 para siempre: la opción elegida solo se notaba
   por el color del texto (fw-05, imprimir-05). */
function segmentado(id, alElegir) {
  const el = $(id);
  if (!el) return;
  V.segmentos.set(id, bindSwitcher(el, alElegir));
}

/* Un switch: la perilla se mueve sobre el MISMO nodo (antes el panel se
   rehacía y la perilla aparecía del otro lado sin viajar). */
const conmutar = (el) => {
  const on = !el.classList.contains('is-on');
  el.classList.toggle('is-on', on);
  return on;
};

/* Lo que el usuario tiene agarrado no se pisa desde el plan: el slider
   mientras se arrastra, el campo de copias mientras se escribe. */
const agarrado = (el) => el && document.activeElement === el;

function sincronizarOpciones() {
  if (!$('qr-opciones')) return;
  const p = plan();
  const imp = impresoraActual();

  rotulo($('op-impresora-nombre'), esc(nombreImpresora()));
  $('op-mono').hidden = !imp?.soloMonocromo;

  const copias = $('op-copias');
  copias.max = String(imp?.maxCopias || 999);
  if (!agarrado(copias) && copias.value !== String(p.copias)) copias.value = String(p.copias);
  V.syncCopias?.();

  rotulo($('op-papel-nombre'), esc(p.papel.nombre));
  rotulo($('op-rango-texto'), esc(textoRango(p)));
  elegir('op-subconjunto', p.subconjunto);

  for (const b of $('op-modo').querySelectorAll('.qr-modo')) b.classList.toggle('is-active', b.dataset.value === p.modo);
  const bloque = $('op-modo-bloque');
  if (bloque.__modo !== p.modo) {
    bloque.__modo = p.modo;
    deslizarBloque(bloque, () => swap(bloque, opcionesDelModo(p), { relevo: true }));
    Icons.mount(bloque);
    cablearBloque();
  } else sincronizarBloque(p);

  rotulo($('op-escala-texto'), textoEscala(p));
  $('op-escala-fila').hidden = p.escala.tipo !== 'custom';
  sincronizarSlider('op-escala-valor', 'op-escala-eco', p.escala.valor, (v) => `${v}%`, 10, 390);
  elegir('op-orientacion', p.orientacion);
  elegir('op-duplex', p.duplex);
  $('op-duplex-nota').hidden = p.duplex === 'simplex';
  $('op-margen').classList.toggle('is-on', !!p.respetarNoImprimible);
  frase($('op-margen-nota'), notaMargen(p));
}

/* deslizarAlto (motion.js) con una diferencia: al ACHICARSE, la caja espera
   a que lo de adentro casi no se vea antes de plegarse. deslizarAlto pliega
   en el acto, al mismo tiempo que el calco de lo viejo se esfuma, y al pasar
   de Múltiple a Simple cortaba la grilla mientras se veía: a los 87 ms la
   caja iba por 104 de 158 px con lo viejo al 51 %, hasta tapar el 17 % de lo
   visible (lo midió la revisión del 2C; motion-timing §10: al achicarse,
   primero se va lo de adentro y después se pliega la caja). La caja espera
   100 ms y se pliega in-out, que en sus primeros cuadros casi no se mueve;
   `fill: backwards` la tiene en el alto viejo durante la espera. Medido por
   cuadro: el calco va 100 → 93 → 71 → 50 → 28 → 15 → 7 % y la caja sigue
   en 158 px hasta el 28 %, 157 con el 15 % y 156 con el 7 %. Crecer va sin
   espera: primero se abre y después entra lo nuevo. Comparte `__glide` con
   deslizarAlto, así uno corta al otro. Si sirve en otro lado, va a Onyx. */
const ESPERA_PLIEGUE = 100;
const DURACION_ALTO = 180;                        // T.size de motion.js
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)'; // --ox-ease-both
const reducido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function deslizarBloque(el, cambio) {
  const h0 = el.getBoundingClientRect().height;
  el.__glide?.cancel();
  cambio();
  const h1 = el.getBoundingClientRect().height;
  if (Math.abs(h1 - h0) < 1 || reducido() || typeof el.animate !== 'function') return;
  const achica = h1 < h0;
  el.__glide = el.animate(
    [{ height: `${h0}px`, overflow: 'clip' }, { height: `${h1}px`, overflow: 'clip' }],
    achica
      ? { duration: DURACION_ALTO, delay: ESPERA_PLIEGUE, easing: EASE_BOTH, fill: 'backwards' }
      : { duration: DURACION_ALTO, easing: EASE_BOTH },
  );
}

function sincronizarBloque(p) {
  if (p.modo === 'nup') {
    for (const b of document.querySelectorAll('#op-nup-grilla .qr-grilla')) {
      b.classList.toggle('is-active', +b.dataset.filas === p.nup.filas && +b.dataset.columnas === p.nup.columnas);
    }
    rotulo($('op-nup-orden-texto'), ORDENES[p.nup.orden]);
    $('op-nup-borde')?.classList.toggle('is-on', !!p.nup.borde);
  } else if (p.modo === 'folleto') {
    elegir('op-folleto-lado', p.folleto.encuadernacion);
    rotulo($('op-folleto-cuadernillo-texto'), textoCuadernillo(p));
  } else if (p.modo === 'poster') {
    sincronizarSlider('op-poster-escala', 'op-poster-eco', p.poster.escala, (v) => `${v}%`, 100, 900);
    sincronizarSlider('op-poster-solape', 'op-poster-solape-eco', p.poster.solape, (v) => `${v} mm`, 0, 30);
    $('op-poster-marcas')?.classList.toggle('is-on', !!p.poster.marcas);
  }
}

function sincronizarSlider(idInput, idEco, v, formato, min, rango) {
  const input = $(idInput);
  if (!input || agarrado(input) || +input.value === v) return;
  input.value = String(v);
  input.style.setProperty('--ox-pct', pct(v, min, rango));
  valor($(idEco), formato(v));
}

/* ── El papel que no se puede pedir por nombre ───────────────────────────────
   SumatraPDF solo entiende nombres: un papel fuera de la lista del proceso
   principal viaja sin `paper=` y sale en el que tenga puesto el driver,
   corrido. Antes pasaba en silencio (imprimir-19). La lista se pide una vez. */
let papelesPedibles = null;
const pedibles = () => (papelesPedibles ??= Promise.resolve(api?.print?.papelesConNombre?.())
  .then((l) => new Set(Array.isArray(l) ? l : []))
  .catch(() => null));

async function sePuedePedir(pageSize) {
  if (typeof pageSize !== 'string') return false;
  const lista = await pedibles();
  return !lista || lista.has(pageSize);   // sin lista no se sabe: no se avisa
}

async function avisarPapel() {
  const c = V.plano;
  const aviso = $('op-papel-aviso');
  if (!aviso) return;
  if (!c) { aviso.hidden = true; return; }
  const si = await sePuedePedir(papelParaElDriver(c.papel).pageSize);
  if (aviso.isConnected) aviso.hidden = si;
}

/* ── Cableado ────────────────────────────────────────────────────────────── */

function cablearOpciones() {
  $('op-impresora')?.addEventListener('click', (e) => {
    if (!S.impresoras.length) {
      Toast.error('No hay impresoras', SIN_IMPRESORAS);
      return;
    }
    Menu.show(e.currentTarget, S.impresoras.map((x) => ({
      label: x.etiqueta, icon: 'printer', selected: x.nombre === S.impresora,
      hint: x.predeterminada ? 'del sistema' : '',
      onSelect: async () => {
        if (x.nombre === S.impresora) return;
        S.impresora = x.nombre;
        await api.settings.save({ impresora: x.nombre }).catch(() => {});
        // El oyente de 'impresoras' pone al día el papel, el área y el panel.
        emitir('impresoras');
      },
    })), { align: 'start' });
  });

  $('op-papel')?.addEventListener('click', (e) => {
    Menu.show(e.currentTarget, papelesDisponibles().map((x) => ({
      label: x.nombre,
      // Con coma, como el resto de la app: «215,9 × 279,4 mm» (ux-25).
      hint: `${fmtDec(x.ancho)} × ${fmtDec(x.alto)} mm`,
      selected: x.id === plan().papel.id,
      onSelect: () => cambiar(aplicarPapel(plan(), x.id)),
    })), { align: 'start' });
  });

  /* Las flechas son nuestras, pero el que manda sigue siendo el input:
     bindStepper despacha 'change' sobre él, así que este listener no se entera
     de la diferencia entre escribir el número y apretar la flecha.

     Lo escrito se acota a [1, máximo] y se escribe de vuelta en el campo:
     «0» o un campo vacío dejaban el campo en 0 con 1 copia en el plan, y no
     había techo —el proceso principal recortaba a 999 en silencio—
     (imprimir-22, ux-29). */
  V.syncCopias = bindStepper($('op-copias-stepper'));
  $('op-copias')?.addEventListener('change', (e) => confirmarCopias(e.target));

  $('op-rango')?.addEventListener('click', (e) => {
    const p = plan();
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

  $('op-modo')?.addEventListener('click', (e) => {
    const b = e.target.closest('.qr-modo');
    if (!b || b.classList.contains('is-active')) return;
    const modo = b.dataset.value;
    const parche = { modo };
    /* Un folleto sin dúplex son dos pilas sueltas que hay que intercalar a
       mano. Si la impresora puede, se prende solo. */
    if (modo === 'folleto' && plan().duplex === 'simplex' && impresoraActual()?.soportaDuplex) {
      parche.duplex = 'largo';
    }
    cambiar(parche);
  });

  $('op-escala')?.addEventListener('click', (e) => {
    /* plan() y no un `p` capturado al cablear: el slider escribe el valor sin
       volver a cablear, y elegir otra escala guardaba el valor viejo
       (Personalizada → 150 → Ajustar → Personalizada volvía en 100,
       imprimir-21). */
    Menu.show(e.currentTarget, ESCALAS.map((x) => ({
      label: x.label, selected: plan().escala.tipo === x.id,
      onSelect: () => cambiar({ escala: { ...plan().escala, tipo: x.id } }),
    })), { align: 'start' });
  });

  deslizador('op-escala-valor', 'op-escala-eco', (v) => `${v}%`, 10, 390,
    (v) => cambiar({ escala: { ...plan().escala, valor: v } }, { rehacer: false }));

  $('op-margen')?.addEventListener('click', (e) => {
    cambiar({ respetarNoImprimible: conmutar(e.currentTarget) });
  });

  /* El bloque del modo se releva entero al cambiar de modo: lo de adentro se
     escucha desde el bloque, que es siempre el mismo nodo. */
  const bloque = $('op-modo-bloque');
  bloque.__modo = plan().modo;
  bloque.addEventListener('click', (e) => {
    const grilla = e.target.closest('.qr-grilla');
    if (grilla && !grilla.classList.contains('is-active')) {
      cambiar({ nup: { ...plan().nup, filas: +grilla.dataset.filas, columnas: +grilla.dataset.columnas } });
      return;
    }
    const sw = e.target.closest('.ox-switch');
    if (sw?.id === 'op-nup-borde') cambiar({ nup: { ...plan().nup, borde: conmutar(sw) } });
    if (sw?.id === 'op-poster-marcas') cambiar({ poster: { ...plan().poster, marcas: conmutar(sw) } });

    const sel = e.target.closest('.ox-select');
    if (sel?.id === 'op-nup-orden') {
      Menu.show(sel, Object.entries(ORDENES).map(([id, l]) => ({
        label: l, selected: plan().nup.orden === id,
        onSelect: () => cambiar({ nup: { ...plan().nup, orden: id } }),
      })), { align: 'start' });
    }
    if (sel?.id === 'op-folleto-cuadernillo') {
      Menu.show(sel, [0, 1, 2, 4, 8].map((n) => ({
        label: n ? plural(n, 'hoja', 'hojas') : 'Uno solo',
        selected: plan().folleto.porCuadernillo === n,
        onSelect: () => cambiar({ folleto: { ...plan().folleto, porCuadernillo: n } }),
      })), { align: 'start' });
    }
  });
  cablearBloque();
}

/* Lo que no se puede escuchar desde el bloque: la cápsula del segmentado y
   los sliders, que son del contenido de cada modo. */
function cablearBloque() {
  segmentado('op-folleto-lado', (v) => cambiar({ folleto: { ...plan().folleto, encuadernacion: v } }));
  deslizador('op-poster-escala', 'op-poster-eco', (v) => `${v}%`, 100, 900,
    (v) => cambiar({ poster: { ...plan().poster, escala: v } }, { rehacer: false }));
  deslizador('op-poster-solape', 'op-poster-solape-eco', (v) => `${v} mm`, 0, 30,
    (v) => cambiar({ poster: { ...plan().poster, solape: v } }, { rehacer: false }));
}

function confirmarCopias(input) {
  if (!input) return;
  const max = impresoraActual()?.maxCopias || 999;
  const n = Math.min(max, Math.max(1, parseInt(input.value, 10) || 1));
  if (input.value !== String(n)) {
    input.value = String(n);
    tick(input);
  }
  V.syncCopias?.();
  cambiar({ copias: n }, { rehacer: false });
}

/**
 * Un slider que actualiza su eco en cada movimiento pero solo re-impone al
 * soltarlo: imponer en cada píxel del arrastre haría que se trabe. El eco va
 * con valor(): cambia muy seguido, siempre en el lugar.
 */
function deslizador(idInput, idEco, formato, min, rango, alCambiarValor) {
  const input = $(idInput);
  const eco = $(idEco);
  if (!input) return;
  input.addEventListener('input', () => {
    const v = +input.value;
    input.style.setProperty('--ox-pct', pct(v, min, rango));
    valor(eco, formato(v));
    alCambiarValor(v);
  });
  input.addEventListener('change', () => { ponerAlDia(); if (V.plano) programarImposicion(); });
}

/* El rango a mano. El foco va al campo (lo pone Modal: el primer campo del
   cuerpo, ya seleccionado) y Enter aplica (también de Modal). Lo propio de
   acá es validarlo EN VIVO: un renglón dice cuántas páginas entran y Aplicar
   se apaga si no entra ninguna. Antes el foco caía en Aplicar, Enter no
   hacía nada y un rango vacío cerraba el modal para recién ahí fallar en el
   preview (imprimir-16, ux-06). */
async function pedirRango() {
  const total = S.doc.paginas;
  const cuerpo = document.createElement('div');
  cuerpo.className = 'ox-field';
  cuerpo.innerHTML = `
    <label class="ox-field__label" for="op-rango-campo">Páginas</label>
    <input class="ox-input ox-input--mono" id="op-rango-campo" spellcheck="false" placeholder="1-7, 12, 20-">
    <span class="ox-field__hint">Tramos y sueltas separadas por coma. Un tramo al revés
      (<span class="ox-mono">9-5</span>) sale al revés. Sobre ${plural(total, 'página', 'páginas')}.</span>
    <span class="ox-field__hint qr-rango__cuenta" id="op-rango-cuenta"></span>`;
  const input = cuerpo.querySelector('input');
  const cuenta = cuerpo.querySelector('#op-rango-cuenta');
  input.value = plan().rango === 'todo' ? '' : plan().rango;

  const promesa = Modal.show({
    title: 'Rango de páginas',
    body: cuerpo,
    width: 440,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Aplicar', value: true, variant: 'primary' }],
  });
  // Modal arma el DOM en el acto: el botón ya existe.
  const aplicar = cuerpo.closest('.ox-modal')?.querySelector('.ox-modal__foot .ox-btn--primary');
  const validar = () => {
    const texto = input.value.trim();
    const n = paginasDelPlan({ ...plan(), rango: texto || 'todo' }, total).length;
    cuenta.classList.toggle('is-vacio', n === 0);
    frase(cuenta, n ? `Entran ${plural(n, 'página', 'páginas')}.` : 'Ninguna página en ese rango.');
    if (aplicar) aplicar.disabled = n === 0;
  };
  input.addEventListener('input', validar);
  validar();

  const ok = await promesa;
  if (!ok) return;
  cambiar({ rango: input.value.trim() || 'todo' });
}

/* ── Imprimir de verdad ──────────────────────────────────────────────────── */

/* El rótulo del botón dice dónde está el trabajo, con un relevo en su lugar:
   cambiaba de golpe, y en el dúplex asistido decía «Armando el pliego…»
   durante las dos pasadas y el modal del medio (imprimir-23). */
const PASOS = {
  listo: ['printer', 'Imprimir'],
  armando: [null, 'Armando el pliego…'],
  mandando: [null, 'Mandando a la impresora…'],
  frentes: [null, 'Imprimiendo los frentes…'],
  fajo: ['printer', 'Esperando el fajo'],
  dorsos: [null, 'Imprimiendo los dorsos…'],
};

function paso(nombre) {
  const [icono, texto] = PASOS[nombre];
  const el = $('qr-imprimir-rotulo');
  if (!el) return;
  swap(el, `<span class="qr-pie__paso">${icono ? Icons.svg(icono) : Icons.spinner()}<span>${texto}</span></span>`,
    { relevo: true });
}

async function imprimirAhora() {
  // Sin plano no hay nada que imprimir: el botón ya está apagado.
  if (V.imprimiendo || !S.doc || !V.plano) return;
  if (!S.impresoras.length) return Toast.error('No hay impresoras', SIN_IMPRESORAS);
  if (!S.impresora) return Toast.error('No hay impresora elegida', 'Elegí una arriba de todo, en Impresora.');

  V.imprimiendo = true;
  const boton = $('qr-imprimir');
  boton?.setAttribute('disabled', '');
  paso('armando');

  try {
    // Se impone COMPLETO: el preview mostraba solo una ventana de hojas.
    const p = plan();
    const { bytes, calculo } = await imponer(await bytesParaImprimir(), p, S.geometrias);
    const copias = Math.max(1, p.copias || 1);
    /* La hoja del CÁLCULO, no la del plan: `p.papel` es el nominal y siempre
       está vertical, mientras que un folleto o un N-up apaisado salen
       acostados. Declarar el nominal era mandarle al driver un tamaño que no
       era el de las páginas del archivo.

       Del par que devuelve papelParaElDriver solo viaja el nombre: la
       orientación la saca el ayudante de las páginas del PDF, y el intercalado
       de copias lo decide el driver — no hay por dónde pedirlo. */
    const hoja = papelParaElDriver(calculo.papel);
    const comun = { deviceName: S.impresora, copies: copias, pageSize: hoja.pageSize };
    const sinNombre = !(await sePuedePedir(hoja.pageSize));

    const asistido = p.duplex !== 'simplex' && S.settings?.duplexAsistido;
    if (asistido && calculo.hojas.length > 1) {
      await imprimirDuplexAsistido(bytes, calculo, comun, p, sinNombre);
    } else {
      paso('mandando');
      const r = await api.print.imprimir(bytes, {
        ...comun,
        duplexMode: p.duplex === 'simplex' ? 'simplex' : p.duplex === 'corto' ? 'shortEdge' : 'longEdge',
        etiqueta: p.modo,
        /* Para el tiempo que se le deja al ayudante (main-06): las páginas
           que va a mandar al spooler, que con copias son varias vueltas. */
        paginas: calculo.hojas.length * copias,
      });
      if (r?.cancelado) return;
      Toast.show({
        title: 'Mandado a imprimir',
        text: `${plural(calculo.resumen.hojasFisicas * copias, 'hoja', 'hojas')} · ${S.impresora}`
          + (sinNombre ? ' · sale en el papel que tenga puesto la impresora' : ''),
        icon: 'printer',
      });
    }
  } catch (err) {
    console.error('[imprimir]', err);
    Toast.error('No se pudo imprimir', err.message);
  } finally {
    V.imprimiendo = false;
    paso('listo');
    if (boton) boton.disabled = !V.plano;
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
 *
 * Las hojas del cartel y del aviso final van multiplicadas por las copias:
 * con 2 copias de 3 hojas el cartel decía 3 y salían 6 (imprimir-23).
 */
async function imprimirDuplexAsistido(bytes, calculo, comun, p, sinNombre) {
  const { frentes, dorsos, hojasDePapel } = partirDuplex(calculo.hojas.length);
  const copias = comun.copies;
  const hojas = hojasDePapel * copias;

  paso('frentes');
  const pdfFrentes = await extraerCaras(bytes, frentes);
  const r1 = await api.print.imprimir(pdfFrentes, {
    ...comun, duplexMode: 'simplex', etiqueta: 'frentes', paginas: frentes.length * copias,
  });
  if (r1?.cancelado) return;

  paso('fajo');
  const seguir = await Modal.show({
    title: 'Ahora volvé a cargar el fajo',
    sub: `Salieron ${plural(hojas, 'hoja', 'hojas')}. Sacalas de la bandeja de salida SIN cambiarles el orden.`,
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

  paso('dorsos');
  const pdfDorsos = await extraerCaras(bytes, dorsos);
  const r2 = await api.print.imprimir(pdfDorsos, {
    ...comun, duplexMode: 'simplex', etiqueta: 'dorsos', paginas: dorsos.length * copias,
  });
  if (r2?.cancelado) return;

  Toast.show({
    title: 'Listo',
    text: `${plural(hojas, 'hoja impresa', 'hojas impresas')} de los dos lados.`
      + (sinNombre ? ' Salió en el papel que tenga puesto la impresora.' : ''),
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

/* Atajos de la vista. Las flechas y RePág/AvPág pasan de hoja (imprimir-11);
   Inicio y Fin van a la primera y a la última. Ctrl+Enter imprime: así lo
   decidió Fran (imprimir-31, ux-31), y no Ctrl+P, porque un segundo Ctrl+P
   por reflejo sacaría papel; Ctrl+P sigue trayendo a esta vista. Funciona
   también desde el campo de copias, que primero confirma lo escrito: el
   'change' de un input recién llega al salir de él. */
function alTeclado(e) {
  if (Router.name !== 'imprimir' || Modal.isOpen || Menu.isOpen) return;
  if (e.ctrlKey && e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (e.repeat) return;
    if (document.activeElement?.id === 'op-copias') confirmarCopias(document.activeElement);
    // El atajo hace lo mismo que el botón: apagado (el preview en error, un
    // trabajo saliendo), no imprime. Antes probaba igual y terminaba en un
    // toast «No se pudo imprimir» (revisión del 2C).
    if ($('qr-imprimir')?.disabled || !V.plano) return;
    imprimirAhora();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable) return;
  const total = V.plano?.hojas.length || 0;
  const destino = {
    ArrowLeft: V.hoja - 1, PageUp: V.hoja - 1, ArrowRight: V.hoja + 1, PageDown: V.hoja + 1,
    Home: 1, End: total,
  }[e.key];
  if (destino == null || !total) return;
  e.preventDefault();
  irAHoja(destino);
}

export function viewImprimir() {
  // Antes del early return: la pantalla vacía tiene que reaccionar cuando
  // aparece un documento (ver la nota en lector.js).
  Router.onLeave(alCambiar((que) => {
    if (que === 'documento') Router.refresh();
    else if (que === 'impresoras' && S.doc) alCambiarImpresoras();
  }));

  if (!S.doc) {
    paint(head({ title: 'Imprimir' }) + empty({
      icon: 'printer',
      title: 'No hay ningún documento abierto',
      text: 'Abrí un PDF y volvé acá. Vas a poder armar folletos, poner varias páginas por hoja, partir una página en varias hojas, y ver exactamente qué va a salir en el papel.',
      actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
    }));
    return;
  }

  /* Un montaje nuevo invalida lo que siga en vuelo de una visita anterior:
     sin subir la generación, una imposición que arrancó antes de salir y
     terminaba después de volver se aceptaba como propia. Y el documento de
     pdf.js que hubiera quedado se destruye antes de soltarlo. */
  V.generacion += 1;
  V.render?.cancelar();
  V.reescala?.cancelar();
  V.doc?.destruir();
  Object.assign(V, {
    doc: null, calculo: null, impuesto: null, desde: 0, generadas: 0, plano: null, alDia: false,
    hoja: 1, pliego: null, entrante: null, otraVez: false, segmentos: new Map(), montada: true,
  });
  const p = plan();

  /* head() ya escapa el subtítulo: escaparlo acá también mostraba «&amp;» en
     un nombre con & (herr-19, ux-05). */
  paint(head({
    title: 'Imprimir',
    sub: S.doc.nombre,
    crumbs: [{ label: 'Documento', view: 'lector' }, { label: 'Imprimir' }],
  }) + `
    <div class="ox-viewbody">
      <div class="ox-viewbody__main ox-viewbody__main--bleed">
        <div class="qr-preview" id="qr-preview">
          <div class="qr-preview__cuerpo" id="qr-preview-cuerpo">
            <div class="qr-preview__aviso" id="qr-preview-aviso"></div>
          </div>
          <div class="qr-preview__nav" id="qr-preview-nav">
            <button class="ox-iconbtn ox-iconbtn--sm" id="qr-hoja-prev" disabled
                    data-tip="Hoja anterior" data-tip-key="RePág"><i data-icon="chevronLeft"></i></button>
            <span class="qr-preview__cuenta">
              <span class="ox-num" id="qr-nav-actual"></span>
              <span class="ox-dim" id="qr-nav-total"></span>
            </span>
            <button class="ox-iconbtn ox-iconbtn--sm" id="qr-hoja-next" disabled
                    data-tip="Hoja siguiente" data-tip-key="AvPág"><i data-icon="chevronRight"></i></button>
            <span class="ox-chip ox-plegable--ancho" id="qr-nav-chip" hidden><span id="qr-nav-chip-texto"></span></span>
          </div>
        </div>
      </div>

      <aside class="ox-inspector qr-inspector">
        <div class="ox-inspector__body" id="qr-opciones">${panelHTML(p)}</div>
        <div class="ox-inspector__foot qr-pie">
          <div class="qr-resumen" id="qr-resumen">
            <div class="qr-resumen__total">
              <div class="qr-resumen__cifra" id="qr-res-cifra"><span class="ox-stat__value ox-num" id="qr-res-hojas"></span></div>
              <span class="ox-meta ox-plegable" id="qr-res-detalle" hidden><span id="qr-res-detalle-texto"></span></span>
            </div>
            <div class="ox-kv qr-resumen__kv">
              <span class="ox-kv__k">Páginas</span><span class="ox-kv__v ox-num" id="qr-res-paginas"></span>
              <span class="ox-kv__k">Caras</span><span class="ox-kv__v ox-num" id="qr-res-caras"></span>
              <span class="ox-kv__k">Papel</span><span class="ox-kv__v" id="qr-res-papel"></span>
              <span class="ox-kv__k ox-plegable qr-resumen__tinta" hidden>Tinta</span><span class="ox-kv__v ox-plegable qr-resumen__tinta" hidden><span id="qr-res-tinta"></span></span>
            </div>
            <div class="qr-aviso ox-plegable" id="qr-res-aviso" hidden>
              ${Icons.svg('alert', 'ox-icon--sm')}<span id="qr-res-aviso-texto"></span>
            </div>
          </div>
          <button class="ox-btn ox-btn--primary ox-flashable qr-pie__boton" id="qr-imprimir"
                  data-tip="Mandar a la impresora" data-tip-key="Ctrl Enter">
            <span class="qr-pie__rotulo" id="qr-imprimir-rotulo"><span class="qr-pie__paso"><i data-icon="printer"></i><span>Imprimir</span></span></span>
          </button>
        </div>
      </aside>
    </div>`);

  cablearOpciones();
  sincronizarOpciones();
  $('qr-imprimir')?.addEventListener('click', imprimirAhora);
  $('qr-hoja-prev')?.addEventListener('click', () => irAHoja(V.hoja - 1));
  $('qr-hoja-next')?.addEventListener('click', () => irAHoja(V.hoja + 1));
  document.addEventListener('keydown', alTeclado);

  /* En el mismo tick que paint(): el pliego en blanco con su tamaño final, la
     cuenta y el resumen, que salen del cálculo. Antes todo nacía vacío y la
     imposición arrancaba en raf2: el calco del router se esfumaba sobre un
     preview gris y la hoja llegaba de golpe al rato (imprimir-12). Lo único
     que llega tarde es el contenido del canvas, con su fundido. */
  ponerAlDia();
  const m = V.plano && medidas(V.plano);
  if (m) V.pliego = nuevoPliego(m, { relevo: false, p, calculo: V.plano });
  const gen = V.generacion;
  raf2(() => { if (gen === V.generacion && V.plano) rehacerImposicion(); });

  /* El preview se re-encaja cuando cambia el tamaño disponible. Al frame
     siguiente y no adentro del callback, por lo mismo que en el lector:
     pintar la hoja cambia el tamaño de lo que se observa, y Chromium reporta
     ese rebote como un error de consola. */
  let reencaje = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(reencaje);
    reencaje = requestAnimationFrame(() => {
      if (V.doc && V.calculo) reescalar();
      else if (V.pliego && V.plano) {
        // Todavía sin imponer: el pliego en blanco acompaña igual.
        const m2 = medidas(V.plano);
        if (m2) { V.pliego.style.width = `${m2.ancho}px`; V.pliego.style.height = `${m2.alto}px`; }
      }
    });
  });
  const cuerpo = $('qr-preview-cuerpo');
  if (cuerpo) ro.observe(cuerpo);

  Router.onLeave(() => {
    document.removeEventListener('keydown', alTeclado);
    ro.disconnect();
    cancelAnimationFrame(reencaje);
    clearTimeout(V.pendiente);
    clearTimeout(V.timerReescala);
    V.render?.cancelar();
    V.reescala?.cancelar();
    V.generacion++;              // invalida cualquier imposición en vuelo
    V.otraVez = false;           // y la que esperaba su turno no se larga
    V.montada = false;
    generacionPintado++;
    V.doc?.destruir();
    V.doc = null;
    // El original parseado se suelta con la vista (ver motor.js).
    limpiarCacheOrigen();
  });
}

/* La impresora cambió (desde el menú de acá, desde Ajustes o porque
   llegaron las capacidades): el plan vuelve a pedir su papel y su área, el
   panel se pone al día y, si eso cambió el pliego, se re-impone. */
function alCambiarImpresoras() {
  const antes = S.plan ? JSON.stringify([S.plan.papel, S.plan.imprimible]) : null;
  const p = plan();
  sincronizarOpciones();
  const mono = esMono();
  for (const el of document.querySelectorAll('#qr-preview-cuerpo .qr-pliego--preview')) el.classList.toggle('is-mono', mono);
  if (JSON.stringify([p.papel, p.imprimible]) !== antes) {
    ponerAlDia();
    if (V.plano) programarImposicion();
  }
}

export { imprimirAhora };
