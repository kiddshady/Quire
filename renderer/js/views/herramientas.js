/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — herramientas de documento
   Combinar, dividir y exportar a imágenes. Las tres trabajan sobre copias:
   ningún archivo de entrada se modifica, todo sale a un destino que elegís.

   Combinar y dividir COPIAN páginas de un PDF a otro sin re-renderizar nada:
   el texto sigue siendo texto y las fuentes viajan enteras. Exportar sí
   rasteriza, porque una imagen es eso — y por eso el DPI es lo primero que se
   elige.

   Combinar además acepta imágenes sueltas, y ahí cada una vale por una página.
   El camino de vuelta de exportar: lo que sale como PNG puede volver a entrar.

   ── Cómo se pone al día ─────────────────────────────────────────────────────
   Cada sección se arma UNA vez y después se pone al día en el lugar: la cola
   reconcilia sus filas por clave, las frases cambian con frase(), los DPI y
   los segmentados mueven su marca, lo que depende de una opción vive siempre
   en el DOM como .ox-plegable. Hasta la auditoría de octubre de 2026 cada
   clic rehacía la sección entera con innerHTML: el panel volvía a entrar
   deslizándose (herr-02), el foco se perdía, y el listener delegado de la
   cola se sumaba en cada repintado —con dos, Subir no hacía nada y Sacar se
   llevaba dos archivos (herr-01)—. Ahora los delegados van a #herr-cuerpo
   una sola vez, en viewHerramientas, y mueren con la vista.

   Cambiar de pestaña sí es una superficie entera por otra: va con el fundido
   de swap(), lo nuevo quieto debajo de un calco opaco que se esfuma.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc, attempt } from '../ui.js';
import { fmtBytes, plural } from '../format.js';
import {
  bindSwitcher, bindStepper, swap, frase, valor, numero, reconcile, ocupar, asentarPlegables,
} from '../motion.js';
import { combinar, dividir, reorganizar, tituloClave, queFaltaClave } from '../imposicion/motor.js';
import { aplanarTinta, contarTinta } from '../tinta/aplanar.js';
import { exportarImagenes, FORMATOS, DPIS, medidaAlDPI, paginasQueNoEntran, nombrarPaginas } from '../exportar.js';
import { resolverRango, aMM } from '../imposicion/plan.js';
import { dpiDeclarado, giroDeOrientacion, medidaDePagina, medirImagen, orientacionExif } from '../imagenes.js';
import { describirTamano } from '../pdf/documento.js';

const api = window.onyx;

const V = {
  seccion: 'combinar',
  /** Documentos en la cola de combinación, con sus bytes ya leídos. */
  cola: [],
  /** El documento abierto, si lo sacaste de la cola: colaEfectiva no lo vuelve
      a poner adelante (ux-23). Es el objeto, no la ruta: si lo cerrás y lo
      volvés a abrir, es otro y vuelve a entrar. */
  abiertoFuera: null,
  corte: { tipo: 'cada', cada: 1, rangos: '1-3, 4-6' },
  exportar: { formato: 'png', dpi: 150, calidad: 0.92, rango: 'todo', conTinta: true },
  /** El id del botón cuyo trabajo está en curso, o null. Vive acá y no en el
      nodo: si la vista se repinta en el medio, el botón nuevo nace ocupado. */
  trabajando: null,
  /** Lo que lleva la exportación en curso, por la misma razón. */
  progreso: null,
  agregando: false,
  /** Para mover la marca de las pestañas cuando la sección cambia desde afuera. */
  sincronizarTabs: null,
};

const SECCIONES = [
  { id: 'combinar', label: 'Combinar', icono: 'combinar' },
  { id: 'dividir', label: 'Dividir', icono: 'dividir' },
  { id: 'exportar', label: 'Exportar', icono: 'download' },
];

/* Lo que dice cada botón que hace el trabajo, libre y ocupado. El rótulo sale
   de acá y no de una foto del innerHTML (herr-15): la foto se llevaba el
   destello del clic, que todavía estaba, y al restaurarla lo volvía a crear
   —sin nadie que lo sacara— al terminar cada combinado. */
const BOTONES = {
  'qr-comb-hacer': { icono: 'combinar', libre: 'Combinar y guardar', ocupado: 'Combinando…' },
  'qr-div-hacer': { icono: 'dividir', libre: 'Dividir y guardar', ocupado: 'Dividiendo…' },
  'qr-exp-hacer': { icono: 'download', libre: 'Exportar', ocupado: 'Exportando…' },
};

/* ── Un PDF con contraseña ───────────────────────────────────────────────────
   Combinar y Dividir copian páginas con pdf-lib, que no descifra: con un PDF
   que se abrió con contraseña salían hojas en blanco. Lo decidió Fran
   (paquete 4A): avisar y bloquear. El aviso vive siempre en el panel, plegado
   cuando no hace falta, y el botón apagado dice por qué en su tooltip.
   Exportar sigue andando: rasteriza con pdf.js, que sí sabe leerlo, y no toca
   los bytes. Lo que no se sabe de antemano (un archivo cifrado que entró
   desde el disco) lo frena el motor con su propio mensaje. */
// `cifrado`: la marca de los de solo lectura, si documento.js la pone (ver imprimir.js).
const conClave = (doc) => !!(doc?.conClave || doc?.cifrado);
const FALTA = { combinar: 'combinarlo', dividir: 'dividirlo' };

/* El que frena la cola: el primero que está abierto con contraseña (en
   cualquier pestaña: el de la memoria es el que se combinaría). */
const bloqueaCombinar = (cola) => cola.find((d) => conClave(pestanaDe(d)?.doc) || conClave(d.doc)) || null;

function avisoClave(id, nombre, accion, visible) {
  return `
      <div class="qr-clave-aviso qr-clave-aviso--fila ox-plegable" id="${id}"${visible ? '' : ' hidden'}>
        ${Icons.svg('lock')}
        <span><span class="ox-label" id="${id}-titulo">${esc(tituloClave(nombre))}</span><span class="ox-meta">${esc(queFaltaClave(accion))}</span></span>
      </div>`;
}

const tipClave = (bloqueo, accion) => `${tituloClave(bloqueo.nombre)}: Quire todavía no puede ${accion}`;

/* El botón que hace el trabajo, apagado por la contraseña: el tooltip dice
   por qué (.qr-explica le devuelve el puntero, ver quire.css). */
function explicarBoton(boton, bloqueo, accion) {
  if (!boton) return;
  boton.classList.toggle('qr-explica', !!bloqueo);
  if (bloqueo) boton.dataset.tip = tipClave(bloqueo, accion);
  else delete boton.dataset.tip;
}

/* ── Vista ───────────────────────────────────────────────────────────────── */

export function viewHerramientas() {
  paint(head({
    title: 'Herramientas',
    // head() ya escapa: con esc() acá, «Farmaco & Toxico.pdf» se leía «&amp;» (herr-19).
    sub: S.doc ? S.doc.nombre : 'Combinar, dividir y exportar',
  }) + `
    <div class="qr-herr ox-bleed">
      <div class="ox-tabs qr-herr__tabs" id="herr-tabs">
        ${SECCIONES.map((s) => `
          <button class="ox-tab${V.seccion === s.id ? ' is-active' : ''}" data-value="${s.id}">
            <i data-icon="${s.icono}"></i> ${s.label}
          </button>`).join('')}
      </div>
      <div class="qr-herr__cuerpo" id="herr-cuerpo">${htmlSeccion()}</div>
    </div>`);

  V.sincronizarTabs = bindSwitcher(document.getElementById('herr-tabs'), (v) => cambiarSeccion(v));

  // Una vez, sobre el nodo que muere con la vista (herr-01).
  const cuerpo = document.getElementById('herr-cuerpo');
  cuerpo.addEventListener('click', clickEnCuerpo);
  cuerpo.addEventListener('input', inputEnCuerpo);
  cuerpo.addEventListener('change', changeEnCuerpo);

  montarSeccion({ montando: true });
  /* Al navegar nadie asienta los plegables que nacen abiertos (Calidad con
     JPEG, la barra de una exportación en curso): crecerían desde 0 debajo
     del calco del router. Al repintar lo hace repintar() solo. */
  asentarPlegables(cuerpo);

  const off = alCambiar((que) => { if (que === 'documento') Router.refresh(); });
  Router.onLeave(off);
}

function htmlSeccion() {
  return { combinar: htmlCombinar, dividir: htmlDividir, exportar: htmlExportar }[V.seccion]();
}

/* Una sección por otra es una superficie entera: fundido. Lo nuevo queda
   entero y quieto debajo de un calco opaco que se esfuma; antes el panel
   nuevo entraba con su propio glide de 10 px (herr-02, css-04). */
function cambiarSeccion(v) {
  V.seccion = v;
  const cuerpo = document.getElementById('herr-cuerpo');
  if (!cuerpo) return;
  const st = cuerpo.scrollTop;
  // El ancho de la barra de scroll, antes de que lo nuevo la saque o la ponga.
  const barra = cuerpo.offsetWidth - cuerpo.clientWidth;
  const antes = new Set(cuerpo.querySelectorAll(':scope > .ox-swap-out'));
  swap(cuerpo, htmlSeccion(), { fundido: true });
  recortarCalco(cuerpo, [...cuerpo.querySelectorAll(':scope > .ox-swap-out--fundido')].find((c) => !antes.has(c)), st, barra);
  montarSeccion({ montando: true });
  asentarPlegables(cuerpo);
}

/* #herr-cuerpo es el que scrollea, y el calco de swap() es absoluto en el top
   del CONTENIDO, con el alto de la vista: con la cola de Combinar bajada, lo
   viejo quedaba arriba de la vista, el scroll caía al alto de lo nuevo y lo
   viejo se corría; al irse el calco, el scroll volvía a 0 y el panel nuevo
   saltaba de un cuadro al otro (medido: 285 px, con 14 archivos y la cola
   bajada a 309). Ahora la sección nueva arranca arriba, como cualquier
   superficie nueva, y el calco es una ventana del alto de la vista que
   muestra lo viejo exactamente donde estaba: recortado, y con su propio
   scroll en el que tenía el cuerpo. */
function recortarCalco(cuerpo, calco, st, barra) {
  cuerpo.scrollTop = 0;
  if (!calco) return;
  calco.style.overflow = 'hidden';
  // Sin la barra del cuerpo adentro: lo viejo se acomoda en el ancho que tenía.
  if (barra > 0) calco.style.width = `${parseFloat(calco.style.width) - barra}px`;
  calco.scrollTop = st;
}

/** Cablea lo que es propio de los nodos de la sección recién puesta. */
function montarSeccion({ montando = false } = {}) {
  const cuerpo = document.getElementById('herr-cuerpo');
  if (!cuerpo) return;
  Icons.mount(cuerpo);
  if (V.seccion === 'combinar') {
    actualizarCombinar({ montando });
  } else if (V.seccion === 'dividir' && S.doc) {
    // bindSwitcher: la cápsula medía 0 y no se veía (herr-03, fw-05).
    bindSwitcher(document.getElementById('qr-div-tipo'), (v) => { V.corte.tipo = v; actualizarDividir(); });
    bindStepper(document.getElementById('qr-div-cada-stepper'));
    actualizarDividir({ montando });
  } else if (V.seccion === 'exportar' && S.doc) {
    bindSwitcher(document.getElementById('qr-exp-formato'), (v) => { V.exportar.formato = v; actualizarExportar(); });
    actualizarExportar({ montando });
  }
}

function actualizarSeccion() {
  if (!document.getElementById('herr-cuerpo')) return;
  if (V.seccion === 'combinar') actualizarCombinar();
  else if (V.seccion === 'dividir') actualizarDividir();
  else actualizarExportar();
}

/* ── Los delegados ─────────────────────────────────────────────────────────
   Todo lo de las tres secciones pasa por acá. Lo que se está yendo en un
   calco es inerte y no tiene ids, así que nunca contesta un clic viejo. */

function clickEnCuerpo(e) {
  const t = e.target;
  const boton = t.closest('button');
  if (boton?.disabled) return;
  if (t.closest('#qr-comb-agregar')) { agregarArchivos(); return; }
  if (t.closest('#qr-comb-hacer')) { hacerCombinar(); return; }
  if (t.closest('#qr-div-hacer')) { hacerDividir(); return; }
  if (t.closest('#qr-exp-hacer')) { hacerExportar(); return; }

  const enCola = t.closest('[data-cola]');
  if (enCola) { moverEnCola(enCola); return; }

  const dpi = t.closest('.qr-dpi');
  if (dpi) {
    V.exportar.dpi = +dpi.dataset.value;
    actualizarExportar();
    return;
  }

  const sw = t.closest('#qr-exp-tinta');
  if (sw) {
    V.exportar.conTinta = !sw.classList.contains('is-on');
    sw.classList.toggle('is-on', V.exportar.conTinta);
  }
}

/* Lo que se escribe a mano espera un respiro antes de recalcular, como
   buscar: con cada tecla, «1-3, 4» pasaba por «1-3, » y el aviso de lo que
   no se entiende titilaba. Las flechas del stepper no esperan. */
const RESPIRO = 180;
let respiro = null;
const despues = (fn) => { clearTimeout(respiro); respiro = setTimeout(fn, RESPIRO); };

function inputEnCuerpo(e) {
  const t = e.target;
  if (t.id === 'qr-div-cada') {
    V.corte.cada = Math.max(1, parseInt(t.value, 10) || 1);
    actualizarDividir();
  } else if (t.id === 'qr-div-rangos') {
    // Antes solo se escuchaba 'change': la cuenta no seguía lo que se escribía (ux-36).
    despues(() => { V.corte.rangos = t.value; actualizarDividir(); });
  } else if (t.id === 'qr-exp-rango') {
    despues(() => { V.exportar.rango = t.value.trim() || 'todo'; actualizarExportar(); });
  } else if (t.id === 'qr-exp-calidad') {
    V.exportar.calidad = +t.value / 100;
    t.style.setProperty('--ox-pct', `${((+t.value - 40) / 60 * 100).toFixed(1)}%`);
    // Es el eco del arrastre: en el lugar y sin relevo. Su ancho fijo (4ch)
    // evita que el slider se achique bajo el puntero al llegar a 100 (herr-31).
    const eco = document.getElementById('qr-exp-calidad-eco');
    if (eco) eco.textContent = `${t.value}%`;
  }
}

function changeEnCuerpo(e) {
  const t = e.target;
  if (t.id === 'qr-div-cada') {
    /* Vaciar el campo mientras se escribe está bien; dejarlo vacío no. Al salir
       vuelve a mostrar el número que de verdad se va a usar. */
    t.value = String(V.corte.cada);
  } else if (t.id === 'qr-div-rangos') {
    clearTimeout(respiro);
    V.corte.rangos = t.value;
    actualizarDividir();
  } else if (t.id === 'qr-exp-rango') {
    clearTimeout(respiro);
    V.exportar.rango = t.value.trim() || 'todo';
    actualizarExportar();
  }
}

/** Sin documento abierto, dividir y exportar no tienen sobre qué trabajar. */
function necesitaDocumento(texto) {
  return empty({
    icon: 'quire',
    title: 'No hay ningún documento abierto',
    text: texto,
    actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
  });
}

/* ══ Combinar ════════════════════════════════════════════════════════════════ */

const LISTA_COLA = '<div class="ox-list qr-cola" id="qr-cola"></div>';

function htmlCombinar() {
  const cola = colaEfectiva();
  const bloqueo = bloqueaCombinar(cola);
  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Los archivos se unen en el orden de la lista. Las páginas de un PDF se
        copian tal cual: el texto sigue siendo texto, no se rasteriza nada. Una
        imagen entra como una página del tamaño que le da su resolución.
      </p>
${avisoClave('qr-comb-clave', bloqueo?.nombre, FALTA.combinar, !!bloqueo)}

      <div class="qr-comb__lista" id="qr-comb-lista" data-modo="${cola.length ? 'lista' : 'vacio'}">${cola.length ? LISTA_COLA : vacioCombinar()}</div>

      <div class="qr-herr__acciones">
        <button class="ox-btn ox-btn--secondary ox-flashable" id="qr-comb-agregar">
          <i data-icon="plus"></i> Agregar archivos
        </button>
        <div class="ox-spacer"></div>
        <span class="ox-meta" id="qr-comb-resumen">${resumenCombinar(cola)}</span>
        ${botonHacer('qr-comb-hacer', sePuedeCombinar(cola) && !bloqueo, bloqueo, FALTA.combinar)}
      </div>
    </div>`;
}

function vacioCombinar() {
  return `
    <div class="ox-empty qr-herr__vacio">${Icons.svg('combinar')}
      <div class="ox-empty__title">Todavía no hay nada que unir</div>
      <div class="ox-empty__text">Agregá PDFs, imágenes o las dos cosas. Si tenés un PDF abierto, va primero en la lista.</div>
    </div>`;
}

/* Las páginas, solo si se saben de todos: un PDF agregado desde el diálogo
   no trae su cuenta, y «3 archivos · 4 páginas» con tres PDF de 4 mentía. */
const resumenCombinar = (cola) => {
  if (cola.length < 2) return '';
  const archivos = plural(cola.length, 'archivo', 'archivos');
  if (!cola.every((d) => d.paginas)) return archivos;
  const paginas = cola.reduce((n, d) => n + d.paginas, 0);
  return `${archivos} · ${plural(paginas, 'página', 'páginas')}`;
};

/* Con dos archivos siempre hay algo que unir. Con uno solo, únicamente si es
   una imagen: ahí "combinar" no es unir nada, es convertirla en PDF — que es
   una cosa que uno quiere hacer y que si no está acá no está en ningún lado. */
const sePuedeCombinar = (cola) => cola.length > 1 || cola.some((d) => d.tipo === 'imagen');

/* La clave de una fila es SIEMPRE su ruta (§1.7 del plan): con «abierto» para
   el documento abierto, la clave cambiaba al materializarse la cola y la fila
   salía y volvía a entrar. Uno que no tiene ruta lleva una clave por
   documento: con «abierto» para todos, el que ya se había materializado en
   la cola y el abierto nuevo de otra pestaña sin ruta compartían clave
   (una sola fila para dos archivos, y Subir o Sacar siempre tocaban el
   primero). Va por el documento y no por el ítem, así la clave no cambia al
   materializarse. */
const sinRuta = new WeakMap();
let ultimoSinRuta = 0;
function claveDe(d) {
  if (d.ruta) return d.ruta;
  const dueño = d.doc || d;
  if (!sinRuta.has(dueño)) sinRuta.set(dueño, ++ultimoSinRuta);
  return `abierto:${sinRuta.get(dueño)}`;
}

/** ¿Es el documento que está abierto ahora? */
const esElAbierto = (d) => !!S.doc && (d.doc === S.doc || (!!d.ruta && d.ruta === S.doc.ruta));

/** El documento abierto va primero, salvo que ya lo hayas agregado a mano o lo hayas sacado. */
function colaEfectiva() {
  if (!S.doc) return V.cola;
  if (V.cola.some(esElAbierto)) return V.cola;
  if (V.abiertoFuera === S.doc) return V.cola;
  return [{
    nombre: S.doc.nombre, ruta: S.doc.ruta, tamano: S.doc.tamano,
    paginas: S.doc.paginas, tipo: 'pdf', formato: 'pdf', esActual: true, doc: S.doc,
  }, ...V.cola];
}

/** La línea de abajo del ítem: qué es, cuánto mide y cuánto pesa. */
function subtitulo(d) {
  const partes = [];

  if (d.tipo === 'imagen') {
    partes.push(`${String(d.formato).toUpperCase()} · 1 página`);
    /* Los píxeles solos no dicen nada —¿1240 de ancho es una postal o un
       afiche?—, así que va también el papel que va a ocupar. Es el número que
       decide si esto entra en una A4 o hay que reducirlo al imprimir. */
    if (d.px) partes.push(`${d.px.ancho} × ${d.px.alto} px`);
    if (d.pagina) partes.push(describirTamano(aMM(d.pagina.ancho), aMM(d.pagina.alto)));
    if (d.dpi) partes.push(`${d.dpi} dpi`);
  } else if (d.paginas) {
    partes.push(plural(d.paginas, 'página', 'páginas'));
  }

  partes.push(fmtBytes(d.tamano || 0));
  if (esElAbierto(d)) partes.push('el que está abierto');
  return partes.map(esc).join(' · ');
}

/* Una fila: un solo nodo raíz, que es lo que reconcile() necesita. La cruz
   está también en el abierto (ux-23): antes no había cómo sacarlo. */
function filaHTML(d, i, n) {
  return `
    <div class="ox-listitem qr-cola__item">
      <span class="qr-cola__orden ox-num">${i + 1}</span>
      <div class="ox-listitem__main">
        <span class="ox-listitem__title">${esc(d.nombre)}</span>
        <span class="ox-listitem__sub">${subtitulo(d)}</span>
      </div>
      <div class="ox-rowactions">
        <button class="ox-iconbtn ox-iconbtn--sm" data-cola="sube"${i === 0 ? ' disabled' : ''}
                data-tip="Subir">${Icons.svg('chevronUp')}</button>
        <button class="ox-iconbtn ox-iconbtn--sm" data-cola="baja"${i === n - 1 ? ' disabled' : ''}
                data-tip="Bajar">${Icons.svg('chevronDown')}</button>
        <button class="ox-iconbtn ox-iconbtn--sm" data-cola="saca"
                data-tip="Sacar de la lista">${Icons.svg('close')}</button>
      </div>
    </div>`;
}

/**
 * Pone la cola al día por clave (herr-21): la fila que sube es el MISMO nodo
 * y viaja a su lugar, la que se saca se esfuma fuera del flujo, lo agregado
 * entra, y el número de orden cambia en su lugar. Antes era innerHTML: la
 * fila aparecía en su lugar nuevo de un cuadro al otro y lo sacado se borraba
 * en seco.
 */
function actualizarCombinar({ montando = false } = {}) {
  const host = document.getElementById('qr-comb-lista');
  if (!host) return;
  const cola = colaEfectiva();

  // Vacío ↔ lista es un estado por otro: relevo.
  const modo = cola.length ? 'lista' : 'vacio';
  if (host.dataset.modo !== modo) {
    host.dataset.modo = modo;
    swap(host, modo === 'lista' ? LISTA_COLA : vacioCombinar(), { relevo: true });
  }

  const lista = document.getElementById('qr-cola');
  if (lista && cola.length) {
    const foco = document.activeElement;
    reconcile(lista, cola.map((d, i) => ({ key: claveDe(d), html: filaHTML(d, i, cola.length), i, n: cola.length })), {
      update: (el, it) => {
        numero(el.querySelector('.qr-cola__orden'), it.i + 1);
        el.querySelector('[data-cola="sube"]').disabled = it.i === 0;
        el.querySelector('[data-cola="baja"]').disabled = it.i === it.n - 1;
      },
      // Al montar, las filas ya estaban: debajo del calco no entra nada.
      enter: !montando,
    });
    devolverFoco(foco);
  }

  frase(document.getElementById('qr-comb-resumen'), resumenCombinar(cola));
  const bloqueo = bloqueaCombinar(cola);
  const aviso = document.getElementById('qr-comb-clave');
  if (aviso) {
    /* Plegado no se ve: el nombre se repone en el lugar, sin relevo, y
       recién después se despliega (lo mismo que el rótulo de Cancelar en
       convertir.js). Con frase() siempre, sacar un A cifrado y sumar un B
       desplegaba el aviso con «A» esfumándose encima de «B» (revisión del
       4A). __frase se anota igual: es contra lo que compara el próximo
       frase(), y sin eso releva desde el nombre de antes. */
    const titulo = document.getElementById('qr-comb-clave-titulo');
    if (bloqueo && titulo) {
      const html = esc(tituloClave(bloqueo.nombre));
      if (aviso.hidden) { swap(titulo, html); titulo.__frase = html; } else frase(titulo, html);
    }
    aviso.hidden = !bloqueo;
  }
  const hacer = document.getElementById('qr-comb-hacer');
  if (hacer) hacer.disabled = !!V.trabajando || !sePuedeCombinar(cola) || !!bloqueo;
  explicarBoton(hacer, bloqueo, FALTA.combinar);
}

/* Mover un nodo (insertBefore) le saca el foco, aunque sea la misma fila: se
   le devuelve, así se puede apretar Subir varias veces seguidas con el
   teclado. Si el botón llegó a su tope y se apagó, el foco pasa al otro de la
   fila en vez de caer al body. */
function devolverFoco(foco) {
  if (!foco || foco === document.body || !foco.isConnected || document.activeElement === foco) return;
  if (foco.disabled) {
    foco.closest('.ox-rowactions')?.querySelector('[data-cola]:not(:disabled)')?.focus({ preventScroll: true });
    return;
  }
  foco.focus({ preventScroll: true });
}

/* Por identidad, no por índice: se busca la fila por su clave en la cola de
   AHORA. Los índices son de la cola efectiva (con el documento abierto
   adelante); al mover algo esa lista virtual se materializa, y desde ahí el
   orden es explícito. */
function moverEnCola(boton) {
  const fila = boton.closest('[data-key]');
  // Con un combinado en curso también se puede: ese trabajo ya se llevó su lista.
  if (!fila) return;
  const cola = colaEfectiva();
  const i = cola.findIndex((d) => claveDe(d) === fila.dataset.key);
  if (i < 0) return;

  const que = boton.dataset.cola;
  const focoEnLaFila = fila.contains(document.activeElement);
  if (que === 'saca') {
    const [d] = cola.splice(i, 1);
    if (esElAbierto(d)) V.abiertoFuera = S.doc;
  } else {
    const j = que === 'sube' ? i - 1 : i + 1;
    if (j < 0 || j >= cola.length) return;
    [cola[i], cola[j]] = [cola[j], cola[i]];
  }
  V.cola = cola.map(({ esActual, ...d }) => d);
  actualizarCombinar();
  if (que === 'saca' && focoEnLaFila) focoTrasSacar(i);
}

/* Sacar con el teclado no pierde el foco: la fila que se va queda inerte y
   fuera del flujo, y el foco caía al body cuando reconcile la quitaba —no se
   podían sacar varios seguidos—. Pasa al Sacar de la que quedó en ese lugar
   (o de la anterior, si era la última), y a Agregar si la lista se vació. */
function focoTrasSacar(i) {
  const cola = colaEfectiva();
  const d = cola[Math.min(i, cola.length - 1)];
  const destino = d
    ? document.querySelector(`#qr-cola > [data-key="${CSS.escape(claveDe(d))}"]:not([data-state=closing]) [data-cola="saca"]`)
    : document.getElementById('qr-comb-agregar');
  destino?.focus({ preventScroll: true });
}

async function agregarArchivos() {
  if (V.agregando) return;
  V.agregando = true;
  try {
    const r = await attempt(() => api.docs.elegirVarios({ conFallidos: true }), { errorTitle: 'No se pudieron abrir' });
    if (!r) return;
    avisarFallidos(r.fallidos);
    if (await sumarACola(r.leidos)) actualizarCombinar();
  } finally {
    V.agregando = false;
  }
}

/** Los que no se pudieron leer no frenan a los demás, pero se dicen. */
function avisarFallidos(fallidos) {
  if (!fallidos?.length) return;
  const [f] = fallidos;
  Toast.error(
    fallidos.length === 1 ? `No entró ${f.nombre}` : `No entraron ${fallidos.length} archivos`,
    fallidos.length === 1 ? enPalabras(f.error) : fallidos.map((x) => x.nombre).join(', '),
  );
}

/* El error de Node, en palabras (ux-28): el aviso decía «ENOENT: no such
   file or directory, stat 'C:\…'». El del límite de tamaño ya viene escrito
   para la gente y pasa tal cual, igual que cualquier otro que no se conozca. */
function enPalabras(error) {
  const e = String(error || '');
  if (/\bENOENT\b/.test(e)) return 'Ya no está en esa carpeta.';
  if (/\b(EACCES|EPERM)\b/.test(e)) return 'No se puede leer: no hay permiso para abrirlo.';
  if (/\bEBUSY\b/.test(e)) return 'No se puede leer: lo tiene abierto otro programa.';
  return e;
}

/** Suma a la cola lo ya leído; devuelve cuántos entraron. */
async function sumarACola(leidos) {
  let sumados = 0;
  for (const a of leidos || []) {
    if (V.cola.some((d) => d.ruta === a.ruta)) continue;
    const item = {
      nombre: a.nombre, ruta: a.ruta, tamano: a.tamano,
      /* El abierto no guarda los bytes del disco: al combinar va el de la
         memoria, con la tinta aplanada (herr-20). */
      bytes: S.doc && a.ruta === S.doc.ruta ? null : a.bytes,
      tipo: a.tipo || 'pdf', formato: a.formato || 'pdf',
    };
    if (item.tipo === 'imagen') Object.assign(item, await describirImagen(a));
    else if (S.doc && a.ruta === S.doc.ruta) item.paginas = S.doc.paginas;
    if (S.doc && a.ruta === S.doc.ruta) V.abiertoFuera = null;
    V.cola.push(item);
    sumados++;
  }
  return sumados;
}

/**
 * Para soltar archivos en Combinar (ux-13): los lee y los suma a la cola. Si
 * la vista está montada en otra sección, pasa a Combinar; si no, la deja
 * elegida para cuando la abras. El cable con el arrastre de la ventana vive
 * en app.js.
 *
 * Devuelve cuántos de los soltados quedaron en la lista: los que entraron y
 * los que ya estaban. Así `if (n) Router.go('herramientas')` lleva a la lista
 * también cuando ya estaban todos; antes daba 0 y soltarlos no respondía de
 * ninguna forma. Si no quedó ninguno (fallaron todos), no cambia de sección:
 * el aviso de lo que falló ya dice lo que pasó.
 */
export async function encolarCombinar(rutas) {
  const pedidas = (rutas || []).filter(Boolean);
  const yaEstaban = pedidas.filter((r) => V.cola.some((d) => d.ruta === r)).length;
  const nuevas = pedidas.filter((r) => !V.cola.some((d) => d.ruta === r));
  if (!nuevas.length && !yaEstaban) return 0;
  const intentos = await Promise.allSettled(nuevas.map((r) => api.docs.leer(r, { imagenes: true, reciente: false })));
  const leidos = [];
  const fallidos = [];
  intentos.forEach((x, i) => {
    if (x.status === 'fulfilled') leidos.push(x.value);
    else fallidos.push({ nombre: String(nuevas[i]).split(/[\\/]/).pop(), error: x.reason?.message || String(x.reason) });
  });
  avisarFallidos(fallidos);
  const n = await sumarACola(leidos);
  if (!n && !yaEstaban) return 0;
  if (!n) {
    Toast.show({
      title: yaEstaban === 1 ? 'Ya estaba en la lista' : 'Ya estaban en la lista',
      text: 'El mismo archivo no se suma dos veces.',
      icon: 'combinar',
    });
  }

  const montada = Router.name === 'herramientas' && document.getElementById('herr-cuerpo');
  if (V.seccion !== 'combinar') {
    if (montada) {
      document.querySelectorAll('#herr-tabs .ox-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.value === 'combinar'));
      V.sincronizarTabs?.();
      cambiarSeccion('combinar');
    } else {
      V.seccion = 'combinar';
    }
  } else if (montada && n) {
    actualizarCombinar();
  }
  return n;
}

/** En qué sección está Herramientas (la que se ve, o la que se va a ver). */
export const seccionActual = () => V.seccion;

/**
 * Lo que la lista necesita saber de una imagen: cuántos píxeles tiene, qué
 * densidad declara y de qué tamaño va a salir la página.
 *
 * Se mide UNA vez, al agregarla, y no en cada repintado. Los píxeles salen de
 * la cabecera (herr-27): ya no se decodifica la foto entera para preguntarle
 * el tamaño.
 *
 * Si falla, se agrega igual sin la ficha. Que una imagen no se pueda medir no
 * quiere decir que no se pueda embeber, y aunque tampoco se pueda, el error de
 * verdad va a salir al combinar, que es cuando importa.
 */
async function describirImagen(a) {
  try {
    const px = await medirImagen(a.bytes, a.formato);
    const dpi = dpiDeclarado(a.bytes, a.formato);
    const giro = giroDeOrientacion(orientacionExif(a.bytes, a.formato));
    return { paginas: 1, px, dpi, pagina: medidaDePagina(px, dpi, giro) };
  } catch (err) {
    console.warn('[combinar] no se pudo medir', a.nombre, err);
    return { paginas: 1 };
  }
}

/* La pestaña que tiene abierto ese documento, sea la de adelante o no. Con
   varias pestañas, el abierto que se materializó en la cola (al subir, bajar
   o sacar a otro) dejaba de ser «el abierto» apenas cambiabas a otra: tenía
   ruta y no bytes, y se releía del disco, sin la tinta (herr-20). Mientras
   siga abierto en alguna pestaña, va el de la memoria, con lo anotado. */
function pestanaDe(d) {
  if (d.tipo === 'imagen') return null;
  return S.pestanas.find((p) => p.doc && (p.doc === d.doc || (!!d.ruta && p.doc.ruta === d.ruta))) || null;
}

/**
 * Los bytes de cada ítem, en orden, listos para combinar.
 *
 * El abierto va PRIMERO en la pregunta (herr-20): si lo elegiste también en
 * el diálogo, esa copia traía los bytes del disco, el `if (d.bytes)` le
 * ganaba, y el combinado salía con las páginas limpias, sin lo anotado.
 */
export async function bytesParaCombinar(cola) {
  const docs = [];
  for (const d of cola) {
    const ficha = { nombre: d.nombre, tipo: d.tipo || 'pdf', formato: d.formato || 'pdf' };
    const pestana = pestanaDe(d);
    if (pestana) {
      // Con la tinta aplanada: lo anotado tiene que viajar al combinado.
      docs.push({ ...ficha, bytes: await aplanarTinta(pestana.doc.bytes, pestana.tinta) });
    } else if (d.bytes) {
      docs.push({ ...ficha, bytes: d.bytes });
    } else if (!d.ruta && d.doc?.bytes) {
      docs.push({ ...ficha, bytes: d.doc.bytes });
    } else {
      const leido = await api.docs.leer(d.ruta, { imagenes: true, reciente: false });
      docs.push({ ...ficha, bytes: leido.bytes });
    }
  }
  return docs;
}

async function hacerCombinar() {
  const cola = colaEfectiva();
  if (!sePuedeCombinar(cola) || bloqueaCombinar(cola)) return;

  await conTrabajo('qr-comb-hacer', async () => {
    const { bytes, indice } = await combinar(await bytesParaCombinar(cola));
    const guardado = await api.docs.guardarComo(bytes, sugerirNombre('combinado', cola[0]?.nombre));
    if (!guardado) return;

    Toast.show({
      title: 'Combinado',
      // En palabras: la flecha «→» era un glifo de la fuente (herr-26).
      text: `${plural(indice.length, 'archivo', 'archivos')} · ${plural(indice[indice.length - 1].hasta, 'página', 'páginas')}, guardado como ${guardado.nombre}`,
      icon: 'combinar',
    });
  });
}

/* ══ Dividir ═════════════════════════════════════════════════════════════════ */

const VACIO_PARTES = '<span class="ox-meta">Ese corte no deja ninguna página.</span>';

function htmlDividir() {
  if (!S.doc) return necesitaDocumento('Abrí el PDF que querés partir en varios.');

  const c = V.corte;
  const { partes, malos } = calcularPartes();
  // «Este PDF», como el aviso: es el que está abierto, no hace falta nombrarlo.
  const bloqueo = conClave(S.doc) ? { nombre: '' } : null;

  /* Los dos campos viven siempre: el que no va está plegado. Cambiar de tipo
     pliega uno y despliega el otro, en vez de rehacer el panel. */
  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Cada parte sale como un PDF independiente, con las páginas copiadas sin
        re-renderizar. El original no se toca.
      </p>
${bloqueo ? avisoClave('qr-div-clave', '', FALTA.dividir, true) : ''}

      <div class="ox-segmented qr-angosto" id="qr-div-tipo">
        <button class="ox-segmented__opt${c.tipo === 'cada' ? ' is-active' : ''}" data-value="cada">Cada N páginas</button>
        <button class="ox-segmented__opt${c.tipo === 'rangos' ? ' is-active' : ''}" data-value="rangos">Por rangos</button>
      </div>

      <div class="ox-field qr-herr__campo-corto ox-plegable" id="qr-div-campo-cada"${c.tipo === 'cada' ? '' : ' hidden'}>
        <label class="ox-field__label">Páginas por archivo</label>
        <div class="ox-stepper" id="qr-div-cada-stepper">
          <input class="ox-input ox-num" id="qr-div-cada" type="number" min="1" max="${S.doc.paginas}" value="${c.cada}">
          <div class="ox-stepper__btns">
            <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
            <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
          </div>
        </div>
      </div>

      <div class="ox-field ox-plegable" id="qr-div-campo-rangos"${c.tipo === 'rangos' ? '' : ' hidden'}>
        <label class="ox-field__label">Rangos, uno por archivo</label>
        <input class="ox-input ox-input--mono" id="qr-div-rangos" spellcheck="false"
               value="${esc(c.rangos)}" placeholder="1-3, 4-6, 7-">
        <span class="ox-field__hint" id="qr-div-hint">${hintRangos(malos)}</span>
      </div>

      <div class="qr-partes" id="qr-div-partes" data-modo="${partes.length ? 'lista' : 'vacio'}">${partes.length ? estructuraPartes(partes) : VACIO_PARTES}</div>

      <div class="qr-herr__acciones">
        <div class="ox-spacer"></div>
        ${botonHacer('qr-div-hacer', partes.length > 0 && !bloqueo, bloqueo, FALTA.dividir)}
      </div>
    </div>`;
}

const textoPartes = (partes) => `Van a salir ${plural(partes.length, 'archivo', 'archivos')}`;

/* El eyebrow y la caja de los chips; los chips los pone reconcile(). */
const estructuraPartes = (partes) => `
  <span class="ox-eyebrow" id="qr-div-eyebrow">${textoPartes(partes)}</span>
  <div class="qr-partes__lista" id="qr-div-lista"></div>`;

/* Lo que no se entendió se dice (ux-36): antes un tramo mal escrito se
   descartaba callado y salía un archivo menos. Y «1 páginas» no (ux-26). */
function hintRangos(malos) {
  const base = `Separados por coma. Cada tramo es un archivo. Sobre ${plural(S.doc?.paginas || 0, 'página', 'páginas')}.`;
  if (!malos.length) return base;
  const cuales = malos.slice(0, 3).map((m) => `«${esc(m)}»`).join(', ');
  return `${base} <span class="ox-danger">${malos.length === 1 ? `${cuales} no es un rango que se entienda.` : `No se entienden ${cuales}.`}</span>`;
}

function chipsDe(partes) {
  const items = partes.slice(0, 12).map((p, i) => {
    const texto = `${i + 1}. ${p.length === 1 ? `pág. ${p[0]}` : `${p[0]}–${p[p.length - 1]}`}`;
    return { key: String(i), texto, html: `<span class="ox-chip ox-chip--mono">${texto}</span>` };
  });
  if (partes.length > 12) {
    const texto = `y ${partes.length - 12} más`;
    items.push({ key: 'mas', texto, html: `<span class="ox-chip">${texto}</span>` });
  }
  return items;
}

/* Lo único que cambia cuando cambia el corte (herr-22). Con la flecha del
   stepper apretada esto corre cada 45 ms: los chips son los mismos nodos y
   cambian su texto en el lugar, los que sobran se esfuman y los que faltan
   entran; el eyebrow va con valor() porque cambia muy seguido. Antes era un
   innerHTML por paso y la fila de chips cambiaba en seco. */
function actualizarDividir({ montando = false } = {}) {
  const c = V.corte;
  const cada = document.getElementById('qr-div-campo-cada');
  const rangos = document.getElementById('qr-div-campo-rangos');
  if (cada) cada.hidden = c.tipo !== 'cada';
  if (rangos) rangos.hidden = c.tipo !== 'rangos';

  const { partes, malos } = calcularPartes();
  const cont = document.getElementById('qr-div-partes');
  if (cont) {
    const modo = partes.length ? 'lista' : 'vacio';
    if (cont.dataset.modo !== modo) {
      cont.dataset.modo = modo;
      swap(cont, modo === 'lista' ? estructuraPartes(partes) : VACIO_PARTES, { relevo: true });
    }
    if (partes.length) {
      valor(document.getElementById('qr-div-eyebrow'), textoPartes(partes));
      const lista = document.getElementById('qr-div-lista');
      if (lista) {
        reconcile(lista, chipsDe(partes), {
          update: (el, it) => { el.textContent = it.texto; },
          enter: !montando,
        });
      }
    }
  }
  frase(document.getElementById('qr-div-hint'), hintRangos(malos));
  const hacer = document.getElementById('qr-div-hacer');
  if (hacer) hacer.disabled = !!V.trabajando || !partes.length || conClave(S.doc);
}

/** Un tramo de Dividir: «5», «2-7» o «7-» (de la 7 al final). */
const TRAMO = /^\d+$|^\d+\s*[-–]\s*\d*$/;

function calcularPartes() {
  if (!S.doc) return { partes: [], malos: [] };
  const total = S.doc.paginas;
  const c = V.corte;
  if (c.tipo === 'rangos') {
    const partes = [];
    const malos = [];
    for (const t of String(c.rangos).split(',').map((s) => s.trim())) {
      /* Un tramo vacío —la coma de más de «1-3, 4-6,»— no es un tramo:
         resolverRango('') devuelve el documento ENTERO, y salía un archivo de
         más con todas las páginas. */
      if (!t) continue;
      /* La gramática se mira antes: resolverRango termina en un parseInt
         permisivo, y «1-3 4-6» (sin la coma) daba un archivo con la página 1,
         «4-x» la 4 y «2.5» la 2, sin que el aviso dijera nada (ux-36). */
      const r = TRAMO.test(t) ? resolverRango(t, total) : [];
      if (r.length) partes.push(r);
      else malos.push(t);
    }
    return { partes, malos };
  }
  const cada = Math.max(1, c.cada || 1);
  const partes = [];
  for (let i = 0; i < total; i += cada) {
    partes.push(Array.from({ length: Math.min(cada, total - i) }, (_, k) => i + k + 1));
  }
  return { partes, malos: [] };
}

async function hacerDividir() {
  const { partes } = calcularPartes();
  if (!partes.length || V.trabajando || conClave(S.doc)) return;

  const carpeta = await attempt(() => api.docs.elegirCarpeta());
  if (!carpeta) return;

  await conTrabajo('qr-div-hacer', async () => {
    const base = S.doc.nombre.replace(/\.pdf$/i, '');
    const bytes = await aplanarTinta(S.doc.bytes, S.tinta);
    const salida = await dividir(bytes, { tipo: 'rangos', rangos: partes }, base);

    // Numera en vez de pisar lo de una vez anterior (herr-18).
    let numerados = 0;
    for (const p of salida) {
      const ruta = await api.docs.escribir(carpeta, p.nombre, p.bytes, { noPisar: true });
      if (nombreDe(ruta) !== p.nombre) numerados++;
    }

    Toast.show({
      title: `${plural(salida.length, 'archivo', 'archivos')}`,
      text: carpeta + avisoNumerados(numerados),
      icon: 'dividir',
    });
  });
}

/* ══ Exportar imágenes ═══════════════════════════════════════════════════════ */

function htmlExportar() {
  if (!S.doc) return necesitaDocumento('Abrí el PDF cuyas páginas querés exportar como imágenes.');

  const e = V.exportar;
  const fmt = FORMATOS[e.formato];
  const est = estadoExportar();
  const tinta = contarTinta(S.tinta);
  const p = V.trabajando === 'qr-exp-hacer' ? V.progreso : null;

  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Cada página sale como un archivo de imagen. Acá sí se rasteriza —una
        imagen es eso—, así que la resolución es lo que decide la calidad.
      </p>

      <div class="qr-herr__grid">
        <div class="ox-field">
          <label class="ox-field__label">Formato</label>
          <div class="ox-segmented" id="qr-exp-formato">
            ${Object.entries(FORMATOS).map(([id, f]) => `
              <button class="ox-segmented__opt${e.formato === id ? ' is-active' : ''}" data-value="${id}">${f.etiqueta}</button>`).join('')}
          </div>
        </div>

        <div class="ox-field">
          <label class="ox-field__label">Páginas</label>
          <input class="ox-input ox-input--mono" id="qr-exp-rango" spellcheck="false"
                 value="${e.rango === 'todo' ? '' : esc(e.rango)}" placeholder="todas">
        </div>
      </div>

      <div class="ox-field">
        <label class="ox-field__label">Resolución</label>
        <div class="qr-dpis" id="qr-exp-dpi">
          ${DPIS.map((d) => `
            <button class="qr-dpi${e.dpi === d ? ' is-active' : ''}" data-value="${d}">
              <span class="qr-dpi__n ox-num">${d}</span><span class="ox-meta">dpi</span>
            </button>`).join('')}
        </div>
        <span class="ox-field__hint" id="qr-exp-hint">${hintExportar(est)}</span>
      </div>

      <div class="ox-field qr-herr__campo-medio ox-plegable" id="qr-exp-campo-calidad"${fmt.calidad ? '' : ' hidden'}>
        <label class="ox-field__label">Calidad</label>
        <div class="ox-row qr-deslizador">
          <input class="ox-slider ox-grow" id="qr-exp-calidad" type="range" min="40" max="100" step="1"
                 value="${Math.round(e.calidad * 100)}" style="--ox-pct:${((e.calidad * 100 - 40) / 60 * 100).toFixed(1)}%">
          <span class="ox-chip ox-chip--mono qr-eco" id="qr-exp-calidad-eco">${Math.round(e.calidad * 100)}%</span>
        </div>
      </div>

      ${tinta ? `
        <label class="ox-row qr-fila">
          <button class="ox-switch${e.conTinta ? ' is-on' : ''}" id="qr-exp-tinta"></button>
          <span class="ox-col qr-apilado">
            <span class="ox-label">Incluir lo anotado</span>
            <span class="ox-meta">${plural(tinta, 'trazo', 'trazos')} en el documento.</span>
          </span>
        </label>` : ''}

      <div class="qr-herr__acciones">
        <div class="qr-progreso ox-plegable" id="qr-exp-progreso"${p ? '' : ' hidden'}>
          <div class="ox-meter"><div class="ox-meter__fill" style="--ox-pct:${p ? (p.hechas / p.total * 100).toFixed(1) : 0}%"></div></div>
          <span class="ox-meta"><span class="ox-num" id="qr-exp-hechas">${p ? p.hechas : ''}</span> de <span class="ox-num" id="qr-exp-total">${p ? p.total : ''}</span></span>
        </div>
        <div class="ox-spacer"></div>
        <span class="ox-meta" id="qr-exp-cuenta">${plural(est.paginas.length, 'imagen', 'imágenes')}</span>
        ${botonHacer('qr-exp-hacer', est.puede)}
      </div>
    </div>`;
}

/** Lo que se va a exportar con las opciones de ahora. */
function estadoExportar() {
  const e = V.exportar;
  const paginas = resolverRango(e.rango, S.doc.paginas);
  const primera = paginas[0] || 1;
  const geo = S.geometrias[primera - 1];
  let medida = geo ? medidaAlDPI(geo, e.dpi) : null;
  /* Con el lector girado un cuarto de vuelta, lo que sale es alto × ancho: el
     render aplica el mismo giro (herr-23). Anunciar otro número es lo que
     medidaAlDPI existe para no hacer. */
  const giro = (((S.rotacion || 0) % 360) + 360) % 360;
  if (medida && giro % 180 === 90) medida = { ...medida, ancho: medida.alto, alto: medida.ancho };
  // Todas las del rango, no solo la primera (imprimir-28).
  const grandes = paginasQueNoEntran(S.geometrias, paginas, e.dpi);
  return { paginas, primera, medida, grandes, puede: paginas.length > 0 && !grandes.length };
}

function hintExportar(est) {
  if (!est.medida) return '';
  let h = `La página ${est.primera} sale de <b class="ox-num">${est.medida.ancho} × ${est.medida.alto} px</b>.`;
  if (V.exportar.dpi >= 300) h += ' A esta resolución se puede volver a imprimir sin que se note.';
  if (est.grandes.length) {
    const varias = est.grandes.length > 1;
    h += ` <span class="ox-danger">${nombrarPaginas(est.grandes)} ${varias ? 'quedan demasiado grandes' : 'queda demasiado grande'}: bajá el DPI.</span>`;
  }
  return h;
}

/* Las opciones se ponen al día en el lugar: el DPI mueve su marca (con la
   transición de color que ya tenía), la cápsula del formato viaja, la Calidad
   se pliega o despliega, y las frases cambian con frase(). El panel es el
   mismo nodo de punta a punta (herr-02). */
function actualizarExportar() {
  if (!S.doc) return;
  const est = estadoExportar();
  const fmt = FORMATOS[V.exportar.formato];
  const calidad = document.getElementById('qr-exp-campo-calidad');
  if (calidad) calidad.hidden = !fmt.calidad;
  document.getElementById('qr-exp-dpi')?.querySelectorAll('.qr-dpi')
    .forEach((b) => b.classList.toggle('is-active', +b.dataset.value === V.exportar.dpi));
  frase(document.getElementById('qr-exp-hint'), hintExportar(est));
  frase(document.getElementById('qr-exp-cuenta'), plural(est.paginas.length, 'imagen', 'imágenes'));
  const hacer = document.getElementById('qr-exp-hacer');
  if (hacer) hacer.disabled = !!V.trabajando || !est.puede;
}

/* La barra arranca de 0 SIN transición y con su texto nuevo, todavía
   plegada, y recién ahí se despliega (herr-16). Quedaba en 100 % con el
   «10 de 10» de la vez anterior y se vaciaba hacia la izquierda. */
function mostrarProgreso(total) {
  const barra = document.getElementById('qr-exp-progreso');
  if (!barra) return;
  const relleno = barra.querySelector('.ox-meter__fill');
  barra.classList.add('is-reiniciando');
  relleno?.style.setProperty('--ox-pct', '0%');
  if (relleno) void getComputedStyle(relleno).width;
  barra.classList.remove('is-reiniciando');
  // Plegada no se ve: el texto se escribe en seco y numero() sigue desde ahí.
  const hechas = document.getElementById('qr-exp-hechas');
  const de = document.getElementById('qr-exp-total');
  if (hechas) hechas.textContent = '0';
  if (de) de.textContent = String(total);
  barra.hidden = false;
}

function pintarProgreso() {
  const p = V.progreso;
  const barra = document.getElementById('qr-exp-progreso');
  if (!p || !barra) return;
  barra.querySelector('.ox-meter__fill')?.style.setProperty('--ox-pct', `${(p.hechas / p.total * 100).toFixed(1)}%`);
  numero(document.getElementById('qr-exp-hechas'), p.hechas);
  numero(document.getElementById('qr-exp-total'), p.total);
}

async function hacerExportar() {
  const e = V.exportar;
  const est = estadoExportar();
  if (!est.puede || V.trabajando) return;

  const carpeta = await attempt(() => api.docs.elegirCarpeta());
  if (!carpeta) return;

  await conTrabajo('qr-exp-hacer', async () => {
    V.progreso = { hechas: 0, total: est.paginas.length };
    mostrarProgreso(est.paginas.length);
    let numerados = 0;
    try {
      const imagenes = await exportarImagenes(S.doc, {
        paginas: est.paginas,
        formato: e.formato,
        dpi: e.dpi,
        calidad: e.calidad,
        capa: e.conTinta ? S.tinta : null,
        rotacion: S.rotacion,
        /* Cada imagen se escribe apenas se codifica (herr-17), y numerada si
           el nombre ya estaba (herr-18). La barra cuenta las escritas. */
        onImagen: async (img) => {
          const ruta = await api.docs.escribir(carpeta, img.nombre, img.bytes, { noPisar: true });
          if (nombreDe(ruta) !== img.nombre) numerados++;
        },
        onProgreso: (hechas, total) => { V.progreso = { hechas, total }; pintarProgreso(); },
      });

      const primera = imagenes[0];
      Toast.show({
        title: `${plural(imagenes.length, 'imagen exportada', 'imágenes exportadas')}`,
        text: `${primera.ancho} × ${primera.alto} px · ${carpeta}${avisoNumerados(numerados)}`,
        icon: 'download',
      });
    } finally {
      // Llega a 100 y se pliega así: un medidor que vuelve a 0 al terminar se desenrolla.
      V.progreso = null;
      const barra = document.getElementById('qr-exp-progreso');
      if (barra) barra.hidden = true;
    }
  });
}

/* ── Común ───────────────────────────────────────────────────────────────── */

/* Sin documento abierto —una lista de puras imágenes— el que le da el nombre
   al resultado es el primero de la lista: "escaneo-01-combinado.pdf" dice de
   dónde salió el archivo; "documento-combinado.pdf" no dice nada. */
function sugerirNombre(sufijo, base = S.doc?.nombre) {
  const limpio = (base || 'documento').replace(/\.(pdf|png|jpe?g|webp)$/i, '');
  return `${limpio}-${sufijo}.pdf`;
}

const nombreDe = (ruta) => String(ruta || '').split(/[\\/]/).pop();

const avisoNumerados = (n) => (n
  ? ` · ${n === 1 ? 'uno salió numerado' : `${n} salieron numerados`} para no pisar lo que ya estaba`
  : '');

const rotulo = (id) => {
  const b = BOTONES[id];
  return V.trabajando === id ? `${Icons.spinner('qr-girando')} ${b.ocupado}` : `${Icons.svg(b.icono)} ${b.libre}`;
};

/** El botón que hace el trabajo, ya ocupado si su trabajo está en curso.
    Con `bloqueo` (un PDF con contraseña) nace apagado y diciendo por qué. */
function botonHacer(id, puede, bloqueo = null, accion = '') {
  const ocupado = V.trabajando === id;
  const clase = bloqueo ? ' qr-explica' : '';
  const tip = bloqueo ? ` data-tip="${esc(tipClave(bloqueo, accion))}"` : '';
  return `<button class="ox-btn ox-btn--primary ox-flashable${clase}" id="${id}"${tip} data-ocupado="${ocupado ? 1 : 0}"${puede && !V.trabajando ? '' : ' disabled'}>${rotulo(id)}</button>`;
}

/* Libre ↔ ocupado es un estado por otro: relevo en el lugar, y el ancho del
   botón viaja en vez de saltar (herr-14). Se busca por id cada vez: si la
   vista se repintó en el medio, el nodo es otro. */
function ponerOcupado(id) {
  ocupar(document.getElementById(id), V.trabajando === id, rotulo(id));
}

/** Ocupa el botón mientras dura la operación y muestra el error si falla. */
async function conTrabajo(id, fn) {
  if (V.trabajando) return;
  V.trabajando = id;
  ponerOcupado(id);
  actualizarSeccion();
  try {
    await fn();
  } catch (err) {
    console.error('[herramientas]', err);
    Toast.error('No se pudo completar', err.message);
  } finally {
    V.trabajando = null;
    ponerOcupado(id);
    actualizarSeccion();
  }
}

export { reorganizar };
