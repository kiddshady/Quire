/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — convertir
   Lo que era Omnimuter, adentro del lector. Dos direcciones:

   · Crear PDF: la revisión de un cuestionario Moodle (.htm guardado con
     "página completa") sale como examen coloreado, listo para imponer e
     imprimir. Un .docx, un .pptx o un texto salen como PDF genérico.
   · Sacar el texto: un PDF (con OCR para lo escaneado y rescate de los
     guiones que pdf.js se come), un Word o un PowerPoint salen como Markdown,
     texto plano, JSON o fragmentos para RAG.

   El trabajo lo hace el motor en el proceso principal (src/motor/), que no
   sabe de esta vista: acá se arma la cola, se eligen las salidas y se mira el
   progreso. Los archivos de entrada no se tocan nunca; las salidas caen al
   lado del original, a Descargas\Quire\<día> o a una carpeta elegida, y si ya
   hay algo con ese nombre se numera en vez de pisarlo.

   ── Cómo se pone al día ─────────────────────────────────────────────────────
   La cola se reconcilia por clave (la ruta): cada archivo es la MISMA fila de
   punta a punta —en cola, convirtiendo, listo— y cambia adentro: el ícono se
   releva (y mientras convierte es el spinner), la etapa cambia con frase(),
   la barra avanza con su transición y se pliega al terminar, los chips
   aparecen. Hasta la auditoría de octubre de 2026 la lista se rehacía entera
   con innerHTML en cada cambio y volvía a entrar deslizándose (herr-06), y
   sacar dos archivos seguidos podía llevarse al vecino (herr-07). El
   inspector y el resumen se arman una vez y se ponen al día en el lugar.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast } from '../overlays.js';
import { paint, head, esc, attempt } from '../ui.js';
import { fmtBytes, plural, ellipsize } from '../format.js';
import { bindSwitcher, scrollFade, swap, frase, numero, reconcile, deslizarAncho, ocupar, asentarPlegables } from '../motion.js';

const api = window.onyx;

/* Lo mismo que declara src/store.cjs. Se funde con lo guardado al leer: un
   ajuste nuevo aparece con su valor aunque el settings.json sea viejo. */
const AJUSTES_DEFECTO = {
  salidas: { pdf: true, markdown: false, txt: false, json: false, chunks: false },
  destino: 'junto',
  carpeta: null,
  abrirAlTerminar: true,
  ocr: true,
  restaurarGuiones: true,
  quitarPies: true,
  seguirLayout: true,
  frontmatter: true,
  chunkSize: 1500,
  chunkOverlap: 200,
};

/* Los textos sin tecnicismos (ux-28): «para RAG», «Frontmatter» y «con
   tesseract» hablaban de la herramienta y no de lo que sale. */
const SALIDAS = [
  { id: 'pdf', label: 'PDF', hint: 'Examen coloreado si es Moodle; documento si no', ext: '.pdf', icono: 'quire' },
  { id: 'markdown', label: 'Markdown', hint: 'Con encabezados y tablas', ext: '.md', icono: 'markdown' },
  { id: 'txt', label: 'Texto plano', hint: 'Sin ningún formato', ext: '.txt', icono: 'file' },
  { id: 'json', label: 'JSON', hint: 'El árbol completo del documento', ext: '.json', icono: 'hash' },
  { id: 'chunks', label: 'Fragmentos', hint: 'Trozos solapados, para cargar en un asistente', ext: '.chunks.json', icono: 'layers' },
];

const TIPO_POR_EXT = {
  '.htm': 'Moodle / HTML', '.html': 'Moodle / HTML', '.pdf': 'PDF', '.docx': 'Word', '.pptx': 'PowerPoint',
  '.txt': 'Texto', '.md': 'Markdown', '.markdown': 'Markdown', '.rst': 'Texto', '.log': 'Texto', '.text': 'Texto',
};
const EXT_TEXTO = ['.md', '.markdown', '.txt', '.text', '.log', '.rst'];

const V = {
  /** Archivos en la cola, en orden. Cada uno lleva su estado de conversión. */
  cola: [],
  ajustes: null,
  /** 'convertir' o 'unir' mientras corre un lote; null si no. */
  trabajando: null,
  /** Lo que se mandó al motor en el lote actual: índice del motor → ítem. */
  lote: [],
  soltarProgreso: null,
  cancelando: false,
};

/* ══ Entrada desde afuera ════════════════════════════════════════════════════
   app.js llama a esto cuando soltás archivos convertibles en la ventana: se
   fichan (nombre, peso, si hay conversor) y entran a la cola. Si la vista
   está montada, las filas nuevas entran sin tocar las que ya estaban (con un
   lote corriendo, sus spinners y sus barras siguen donde iban); si no, quedan
   esperando a que la abras. */
export async function encolar(rutas) {
  const nuevas = (rutas || []).filter((r) => r && !V.cola.some((d) => d.ruta === r));
  if (!nuevas.length) return 0;
  const fichas = await attempt(() => api.conv.fichar(nuevas), { errorTitle: 'No se pudieron leer los archivos' });
  if (!fichas?.length) return 0;
  let sumados = 0;
  for (const f of fichas) {
    if (V.cola.some((d) => d.ruta === f.ruta)) continue;
    V.cola.push(nuevo(f));
    sumados++;
  }
  pintarCola();
  return sumados;
}

const nuevo = (f) => ({ ...f, estado: 'cola', progreso: 0, etapa: '', salidas: [], error: null });

/** Cuántos hay esperando: el rail lo muestra como contador. */
export const pendientes = () => V.cola.filter((d) => d.estado === 'cola' && d.convertible).length;

/* El contador del rail vive en app.js y no mira esta cola: se le avisa cada
   vez que cambia lo que hay por convertir. */
const avisarCola = () => window.dispatchEvent(new CustomEvent('quire:convertir-cola'));

/* ══ Vista ═══════════════════════════════════════════════════════════════════ */

export function viewConvertir() {
  V.ajustes = { ...AJUSTES_DEFECTO, ...(S.settings?.conversion || {}) };
  V.ajustes.salidas = { ...AJUSTES_DEFECTO.salidas, ...(V.ajustes.salidas || {}) };
  const r = resumen();

  paint(head({
    title: 'Convertir',
    sub: 'Moodle a PDF · PDF, Word, PowerPoint y texto a Markdown, texto, JSON o fragmentos',
    actions: `
      <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="cv-agregar">
        <i data-icon="plus"></i> Agregar archivos
      </button>`,
  }) + `
    <div class="ox-viewbody qr-conv">
      <div class="ox-viewbody__main ox-viewbody__main--bleed">
        <div class="qr-conv__cola ox-scroll" id="cv-cola" data-modo="${V.cola.length ? 'lista' : 'vacio'}">${V.cola.length ? LISTA : vacioHTML()}</div>
      </div>

      <aside class="ox-inspector qr-inspector">
        <div class="ox-inspector__body" id="cv-opciones">${opcionesHTML()}</div>
        <div class="ox-inspector__foot qr-pie">
          <div class="qr-resumen" id="cv-resumen">
            <div class="qr-resumen__cifra">
              <span class="qr-resumen__n ox-num" id="cv-resumen-n">${r.n}</span>
              <span class="ox-meta" id="cv-resumen-rotulo">${r.rotulo}</span>
            </div>
            <span class="ox-meta" id="cv-resumen-aviso">${r.aviso}</span>
          </div>
          <button class="ox-btn ox-btn--primary ox-flashable qr-pie__boton" id="cv-convertir"
                  data-ocupado="${V.trabajando === 'convertir' ? 1 : 0}"${r.puede ? '' : ' disabled'}>${rotuloConvertir()}</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm qr-pie__boton ox-plegable" id="cv-cancelar"${V.trabajando ? '' : ' hidden'}
                  data-cancelando="${V.cancelando ? 1 : 0}"${V.cancelando ? ' disabled' : ''}>${rotuloCancelar()}</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm qr-pie__boton ox-plegable" id="cv-unir"${r.unir ? '' : ' hidden'}
                  data-ocupado="${V.trabajando === 'unir' ? 1 : 0}"${V.trabajando ? ' disabled' : ''}>${rotuloUnir(r.textos)}</button>
        </div>
      </aside>
    </div>`);

  document.getElementById('cv-agregar')?.addEventListener('click', agregarConDialogo);
  document.getElementById('cv-convertir')?.addEventListener('click', convertirAhora);
  document.getElementById('cv-cancelar')?.addEventListener('click', cancelar);
  document.getElementById('cv-unir')?.addEventListener('click', unirTextos);

  cablearOpciones();
  pintarCola({ montando: true });
  /* Al navegar nadie asienta los plegables que nacen abiertos (los chips de
     una fila lista, el botón de la carpeta, Cancelar con un lote corriendo,
     Unir, Fragmentos, los medidores): crecían desde 0 por @starting-style
     debajo del calco del router y las filas de abajo se veían bajar, lo
     mismo que herr-25 por otro camino. Igual que en Herramientas; al
     repintar lo hace repintar() solo. */
  asentarPlegables(document.querySelector('.qr-conv'));

  /* Un solo listener delegado para la cola, enganchado al nodo que muere con
     el pintado: sobre #view se acumularía una copia por visita. El progreso,
     en cambio, se sigue escuchando aunque te vayas de la vista: el lote corre
     en el main y al volver la cola tiene que estar al día. */
  document.getElementById('cv-cola')?.addEventListener('click', clickEnCola);
}

/* ══ Cola ════════════════════════════════════════════════════════════════════ */

const LISTA = '<div class="ox-list qr-conv__lista" id="cv-lista"></div>';

function vacioHTML() {
  return `
    <div class="ox-empty qr-conv__vacio">${Icons.svg('convertir')}
      <div class="ox-empty__title">Todavía no hay nada que convertir</div>
      <div class="ox-empty__text">
        Arrastrá acá la revisión de un cuestionario Moodle, un PDF, un Word, un PowerPoint
        o un texto. También podés elegirlos con el botón de arriba.
      </div>
      <button class="ox-btn ox-btn--primary ox-flashable qr-conv__agregar-vacio" data-accion="agregar">${Icons.svg('plus')} Agregar archivos</button>
    </div>`;
}

/**
 * Pone la cola al día. Se puede llamar en cada cambio: las filas que no
 * cambiaron no se tocan, y con la vista desmontada solo avisa al rail.
 */
function pintarCola({ montando = false } = {}) {
  avisarCola();
  const cont = document.getElementById('cv-cola');
  if (!cont) return;

  // Vacío ↔ lista es un estado por otro: relevo.
  const modo = V.cola.length ? 'lista' : 'vacio';
  if (cont.dataset.modo !== modo) {
    cont.dataset.modo = modo;
    swap(cont, modo === 'lista' ? LISTA : vacioHTML(), { relevo: true });
  }
  scrollFade(cont);

  const lista = document.getElementById('cv-lista');
  if (lista && V.cola.length) {
    reconcile(lista, V.cola.map((d) => ({ key: d.ruta, html: itemHTML(d), d })), {
      update: (el, it) => ponerFila(el, it.d),
      created: (el, it) => sembrarFila(el, it.d),
      // Al montar, las filas ya estaban: debajo del calco del router no entra nada.
      enter: !montando,
    });
  }
  pintarResumen();
}

/* Una fila: un solo nodo raíz, que es lo que reconcile() necesita. */
function itemHTML(d) {
  const salidas = chipsHTML(d);
  return `
    <div class="${clasesDe(d)}">
      <span class="qr-conv__icono">${iconoHTML(d)}</span>
      <div class="ox-listitem__main">
        <span class="ox-listitem__title">${esc(d.nombre)}</span>
        <span class="ox-listitem__sub">${subtituloDe(d)}</span>
        <div class="ox-meter qr-conv__meter ox-plegable"${d.estado === 'convirtiendo' ? '' : ' hidden'}>
          <div class="ox-meter__fill" style="--ox-pct:${(d.progreso * 100).toFixed(1)}%"></div>
        </div>
        <div class="qr-conv__salidas ox-plegable"${salidas ? '' : ' hidden'}>${salidas}</div>
      </div>
      <div class="ox-rowactions">${accionesHTML(d)}</div>
    </div>`;
}

function clasesDe(d) {
  const clases = ['ox-listitem', 'qr-conv__item', `is-${d.estado}`];
  if (!d.convertible) clases.push('is-inerte');
  return clases.join(' ');
}

/* Mientras convierte, el ícono ES el spinner (herr-09): vivía en las acciones
   de la fila, que están en opacidad 0 salvo con el mouse encima, y ninguna
   fila mostraba que estaba trabajando. */
const claveIcono = (d) => (d.estado === 'convirtiendo' ? 'spinner' : iconoDe(d));
const iconoHTML = (d) => (d.estado === 'convirtiendo' ? Icons.spinner('qr-girando') : Icons.svg(iconoDe(d)));

function iconoDe(d) {
  if (d.estado === 'error') return 'alert';
  if (d.estado === 'listo') return 'check';
  if (!d.convertible) return 'eyeOff';
  return { '.pdf': 'quire', '.htm': 'globe', '.html': 'globe', '.docx': 'file', '.pptx': 'grid' }[d.ext] || 'file';
}

const accionesHTML = (d) => (d.estado === 'convirtiendo' ? '' : `
  <button class="ox-iconbtn ox-iconbtn--sm" data-saca data-tip="Sacar de la lista">${Icons.svg('close')}</button>`);

function chipsHTML(d) {
  if (d.estado !== 'listo' || !d.salidas.length) return '';
  return d.salidas.map((s) => `
    <button class="ox-chip ox-chip--mono qr-conv__salida" data-mostrar="${esc(s.path)}"
            ${s.name === 'pdf' ? `data-abrir="${esc(s.path)}"` : ''}
            data-tip="${s.name === 'pdf' ? 'Abrir en Quire' : 'Mostrar en la carpeta'}">
      ${Icons.svg(s.name === 'pdf' ? 'quire' : 'folder')} ${esc(nombreCorto(s.path))}
    </button>`).join('');
}

const tipoDe = (d) => TIPO_POR_EXT[d.ext] || String(d.ext || '').replace('.', '').toUpperCase();

/** La segunda línea del ítem cambia con el estado: ficha, etapa o resultado. */
function subtituloDe(d) {
  const tipo = tipoDe(d);
  const base = [tipo, fmtBytes(d.tamano || 0)];
  if (!d.convertible) return esc(`${base.join(' · ')} · sin conversor para ${d.ext || 'este archivo'}`);
  // La etapa en su propio span (herr-10): cambia sola, con frase().
  if (d.estado === 'convirtiendo') return `${esc(tipo)} · <span class="qr-conv__etapa">${esc(d.etapa || 'preparando…')}</span>`;
  // Seleccionable (ux-34): el motivo de una falla se busca o se pasa.
  if (d.estado === 'error') return `<span class="ox-danger ox-copyable">${esc(d.error || 'Falló')}</span>`;
  if (d.estado === 'listo') {
    const m = d.meta || {};
    const partes = [plural(d.salidas.length, 'salida', 'salidas')];
    if (m.questions) partes.push(`${m.questions} preguntas${m.correct != null ? `, ${m.correct} correctas` : ''}`);
    else if (m.pages) partes.push(plural(m.pages, 'página', 'páginas'));
    else if (m.slides) partes.push(plural(m.slides, 'diapositiva', 'diapositivas'));
    if (m.ocrPages) partes.push(`OCR en ${plural(m.ocrPages, 'página', 'páginas')}`);
    if (m.hyphensRestored) partes.push(`${m.hyphensRestored} guiones rescatados`);
    if (m.ocrError) partes.push(`OCR no disponible: ${m.ocrError}`);
    return esc(partes.join(' · '));
  }
  return esc(base.join(' · '));
}

/* Lo que la fila ya muestra al nacer, para que la primera puesta al día no
   releve algo que no cambió: swap() no sabe qué había antes de él. */
function sembrarFila(el, d) {
  el.__icono = claveIcono(d);
  el.__chips = chipsHTML(d);
  el.__acciones = accionesHTML(d);
  el.querySelector('.ox-listitem__sub').__modo = d.estado;
}

/**
 * Pone una fila al día con el estado de su archivo. La usa reconcile() y la
 * usa el progreso, que llega varias veces por segundo y toca solo su fila.
 * Cada parte cambia solo si cambió.
 */
function ponerFila(el, d) {
  const clases = clasesDe(d);
  // Las clases nuevas corren con sus transiciones (el ícono que se tiñe al terminar).
  if (el.className !== clases) {
    for (const c of [...el.classList]) if (c.startsWith('is-') && !clases.includes(c)) el.classList.remove(c);
    for (const c of clases.split(' ')) el.classList.add(c);
  }

  const icono = claveIcono(d);
  if (el.__icono !== icono) {
    el.__icono = icono;
    swap(el.querySelector('.qr-conv__icono'), iconoHTML(d), { relevo: true });
  }

  ponerSubtitulo(el.querySelector('.ox-listitem__sub'), d);
  ponerMedidor(el.querySelector('.qr-conv__meter'), d);

  const chips = chipsHTML(d);
  if (el.__chips !== chips) {
    el.__chips = chips;
    const caja = el.querySelector('.qr-conv__salidas');
    // Los chips aparecen (swap) mientras la caja se despliega; al irse, se pliegan con ella.
    if (chips) swap(caja, chips);
    caja.hidden = !chips;
  }

  const acciones = accionesHTML(d);
  if (el.__acciones !== acciones) {
    el.__acciones = acciones;
    swap(el.querySelector('.ox-rowactions'), acciones);
  }
}

/* Mientras convierte, lo que cambia es la etapa: «leyendo…», «página 3/40»,
   «OCR 2/12 (página 7)», «escribiendo .md…». Si cambian solo las cifras se
   reescribe en el lugar; si cambia la etapa, relevo (frase()). Cuando cambia
   el estado, la línea entera. */
function ponerSubtitulo(sub, d) {
  if (!sub) return;
  if (d.estado === 'convirtiendo' && sub.__modo === 'convirtiendo') {
    const etapa = sub.querySelector(':scope > .qr-conv__etapa');
    if (etapa) { frase(etapa, esc(d.etapa || 'preparando…')); return; }
  }
  sub.__modo = d.estado;
  frase(sub, subtituloDe(d));
}

/* La barra: avanza con su transición, se completa y se pliega al terminar.
   Si vuelve a arrancar (un archivo que falló y se reintenta), toma su valor
   SIN transición antes de desplegarse: si no, se desenrollaría desde 100. */
function ponerMedidor(meter, d) {
  if (!meter) return;
  const relleno = meter.querySelector('.ox-meter__fill');
  const pct = `${(d.progreso * 100).toFixed(1)}%`;
  const visible = d.estado === 'convirtiendo';
  if (visible && meter.hidden) {
    meter.classList.add('is-reiniciando');
    relleno.style.setProperty('--ox-pct', pct);
    void getComputedStyle(relleno).width;
    meter.classList.remove('is-reiniciando');
    meter.hidden = false;
    return;
  }
  relleno.style.setProperty('--ox-pct', pct);
  if (!visible) meter.hidden = true;
}

const nombreCorto = (ruta) => ellipsize(String(ruta).split(/[\\/]/).pop(), 34);

/** La fila de un archivo, por su ruta (que trae barras y a veces comillas). */
const filaDe = (d) => document.getElementById('cv-lista')?.querySelector(`:scope > [data-key="${CSS.escape(d.ruta)}"]`);

function clickEnCola(e) {
  if (e.target.closest('[data-accion="agregar"]')) { agregarConDialogo(); return; }
  const saca = e.target.closest('[data-saca]');
  if (saca) {
    /* Por identidad y en el acto (herr-07, ux-14). Antes se guardaba el índice
       del clic y el splice iba 400 ms después, al terminar una salida que no
       tenía animación: sacar dos seguidos se llevaba al vecino del segundo.
       La salida la hace reconcile(), fuera del flujo, y las de abajo suben. */
    const fila = saca.closest('[data-key]');
    const d = V.cola.find((x) => x.ruta === fila?.dataset.key);
    if (!d || d.estado === 'convirtiendo') return;
    V.cola = V.cola.filter((x) => x !== d);
    pintarCola();
    return;
  }
  const abrir = e.target.closest('[data-abrir]');
  if (abrir) { abrirEnQuire(abrir.dataset.abrir); return; }
  const mostrar = e.target.closest('[data-mostrar]');
  if (mostrar) api.conv.mostrar(mostrar.dataset.mostrar).catch(() => {});
}

/** Le pide a app.js que abra ese PDF en una pestaña: la vista no maneja pestañas. */
function abrirEnQuire(ruta) {
  window.dispatchEvent(new CustomEvent('quire:abrir-ruta', { detail: { ruta } }));
}

async function agregarConDialogo() {
  const fichas = await attempt(() => api.conv.elegir(), { errorTitle: 'No se pudieron elegir los archivos' });
  if (!fichas?.length) return;
  let sumados = 0;
  for (const f of fichas) {
    if (V.cola.some((d) => d.ruta === f.ruta)) continue;
    V.cola.push(nuevo(f));
    sumados++;
  }
  if (sumados) pintarCola();
}

/* ══ Opciones (inspector) ════════════════════════════════════════════════════
   Se arman una vez. Cambiar el destino no rehace el inspector (herr-04): la
   cápsula viaja, la explicación cambia con frase() y el botón de la carpeta
   vive siempre en el DOM, plegado si no hace falta. Antes la cápsula renacía
   de ancho 0 y la caja de Fragmentos se volvía a desplegar en cada clic. */

function opcionesHTML() {
  const a = V.ajustes;

  const fila = (id, on, label, meta) => `
    <label class="ox-row qr-fila qr-fila--arriba qr-conv__fila">
      <button class="ox-switch${on ? ' is-on' : ''}" data-ajuste="${id}"></button>
      <span class="ox-col qr-apilado">
        <span class="ox-label">${label}</span>
        ${meta ? `<span class="ox-meta">${meta}</span>` : ''}
      </span>
    </label>`;

  return `
    <div class="qr-op">
      <span class="ox-eyebrow">Salidas</span>
      <div class="qr-conv__salidas-lista">
        ${SALIDAS.map((s) => `
          <label class="ox-row qr-fila qr-fila--arriba qr-conv__fila">
            <button class="ox-check${a.salidas[s.id] ? ' is-on' : ''}" data-salida="${s.id}"><i data-icon="check"></i></button>
            <span class="ox-col qr-apilado">
              <span class="ox-label">${s.label} <span class="ox-meta ox-num">${s.ext}</span></span>
              <span class="ox-meta">${s.hint}</span>
            </span>
          </label>`).join('')}
      </div>
      <div class="qr-op qr-op--par qr-conv__chunks ox-plegable"${a.salidas.chunks ? '' : ' hidden'}>
        <div class="ox-field">
          <label class="ox-field__label">Tamaño</label>
          <input class="ox-input ox-num" id="cv-chunk-size" type="number" min="100" step="100" value="${a.chunkSize}">
        </div>
        <div class="ox-field">
          <label class="ox-field__label">Solape</label>
          <input class="ox-input ox-num" id="cv-chunk-overlap" type="number" min="0" step="50" value="${a.chunkOverlap}">
        </div>
      </div>
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Destino</span>
      <div class="ox-segmented" id="cv-destino">
        <button class="ox-segmented__opt${a.destino === 'junto' ? ' is-active' : ''}" data-value="junto">Junto al original</button>
        <button class="ox-segmented__opt${a.destino === 'descargas' ? ' is-active' : ''}" data-value="descargas">Descargas</button>
        <button class="ox-segmented__opt${a.destino === 'carpeta' ? ' is-active' : ''}" data-value="carpeta">Carpeta…</button>
      </div>
      <span class="ox-meta qr-conv__destino-hint" id="cv-destino-hint">${hintDestino(a)}</span>
      <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable ox-plegable qr-conv__carpeta" id="cv-elegir-carpeta"${a.destino === 'carpeta' ? '' : ' hidden'}>${rotuloCarpeta(a)}</button>
      ${fila('abrirAlTerminar', a.abrirAlTerminar, 'Abrir el PDF al terminar', 'Si salió un PDF, se abre en una pestaña.')}
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Leer un PDF</span>
      ${fila('ocr', a.ocr, 'OCR en las páginas escaneadas', 'Las que casi no tienen texto se reconocen sin conexión (español e inglés). Es lento.')}
      ${fila('restaurarGuiones', a.restaurarGuiones, 'Rescatar los guiones', 'Algunos libros codifican todo guión como uno "blando", y sin esto "5-HT" sale "5HT". Cuesta más tiempo.')}
      ${fila('quitarPies', a.quitarPies, 'Quitar encabezados y pies repetidos', 'Las líneas que aparecen iguales en casi todas las páginas.')}
      ${fila('seguirLayout', a.seguirLayout, 'Seguir la geometría de la página', 'Corta los renglones donde el PDF los corta, no donde los dibuja.')}
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Markdown</span>
      ${fila('frontmatter', a.frontmatter, 'Encabezado con título y fecha', 'Título, origen y fecha arriba del archivo, entre "---".')}
    </div>`;
}

const rotuloCarpeta = (a) => `${Icons.svg('folder')} ${a.carpeta ? 'Cambiar la carpeta' : 'Elegir la carpeta'}`;

function hintDestino(a) {
  if (a.destino === 'descargas') return 'Descargas\\Quire\\&lt;fecha de hoy&gt;, todo junto y sin subcarpetas.';
  if (a.destino === 'carpeta') return a.carpeta ? esc(a.carpeta) : 'Todavía no elegiste ninguna.';
  return 'Cada salida queda en la carpeta de su original. Si ya hay una con ese nombre, se numera.';
}

function cablearOpciones() {
  const el = document.getElementById('cv-opciones');
  if (!el) return;
  Icons.mount(el);

  /* Lo que el botón de la carpeta ya dice al nacer, con el MISMO string que lo
     pintó: así el primer ponerDestino() no releva un rótulo que no cambió. Se
     comparaba contra innerHTML, que nunca coincide (serializa el <path/> del
     ícono como <path></path>), y «Cambiar la carpeta» se relevaba sobre sí
     mismo mientras el botón se desplegaba. */
  const carpeta = document.getElementById('cv-elegir-carpeta');
  if (carpeta) carpeta.__rotulo = rotuloCarpeta(V.ajustes);

  el.querySelectorAll('[data-salida]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.salida;
    V.ajustes.salidas[id] = !V.ajustes.salidas[id];
    b.classList.toggle('is-on', V.ajustes.salidas[id]);
    if (id === 'chunks') {
      const caja = el.querySelector('.qr-conv__chunks');
      if (caja) caja.hidden = !V.ajustes.salidas.chunks;
    }
    guardarAjustes();
    pintarResumen();
  }));

  el.querySelectorAll('[data-ajuste]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.ajuste;
    V.ajustes[id] = !V.ajustes[id];
    b.classList.toggle('is-on', V.ajustes[id]);
    guardarAjustes();
  }));

  bindSwitcher(document.getElementById('cv-destino'), async (v) => {
    V.ajustes.destino = v;
    ponerDestino();
    if (v === 'carpeta' && !V.ajustes.carpeta) {
      const carpeta = await attempt(() => api.docs.elegirCarpeta());
      if (carpeta) V.ajustes.carpeta = carpeta;
      ponerDestino();
    }
    guardarAjustes();
  });

  document.getElementById('cv-elegir-carpeta')?.addEventListener('click', async () => {
    const carpeta = await attempt(() => api.docs.elegirCarpeta());
    if (!carpeta) return;
    V.ajustes.carpeta = carpeta;
    ponerDestino();
    guardarAjustes();
  });

  const size = document.getElementById('cv-chunk-size');
  const overlap = document.getElementById('cv-chunk-overlap');
  size?.addEventListener('change', () => {
    V.ajustes.chunkSize = Math.max(100, parseInt(size.value, 10) || 1500);
    size.value = String(V.ajustes.chunkSize);
    guardarAjustes();
  });
  overlap?.addEventListener('change', () => {
    V.ajustes.chunkOverlap = Math.max(0, parseInt(overlap.value, 10) || 0);
    overlap.value = String(V.ajustes.chunkOverlap);
    guardarAjustes();
  });
}

/** El destino, puesto al día en el lugar: explicación, botón de carpeta y resumen. */
function ponerDestino() {
  const a = V.ajustes;
  frase(document.getElementById('cv-destino-hint'), hintDestino(a));
  const boton = document.getElementById('cv-elegir-carpeta');
  if (boton) {
    const html = rotuloCarpeta(a);
    if (boton.__rotulo !== html) {
      boton.__rotulo = html;
      // Elegir ↔ Cambiar: un rótulo por otro, con el ancho viajando.
      deslizarAncho(boton, () => swap(boton, html, { relevo: true }));
    }
    boton.hidden = a.destino !== 'carpeta';
  }
  pintarResumen();
}

let guardando = null;
function guardarAjustes() {
  clearTimeout(guardando);
  guardando = setTimeout(() => {
    api.settings.save({ conversion: V.ajustes })
      .then((s) => { if (s) S.settings = s; })
      .catch((err) => console.warn('[convertir] no se guardaron los ajustes', err));
  }, 250);
}

/* ══ Resumen y botones ═══════════════════════════════════════════════════════ */

const salidasElegidas = () => SALIDAS.filter((s) => V.ajustes.salidas[s.id]).map((s) => s.id);
const enCola = () => V.cola.filter((d) => d.convertible && (d.estado === 'cola' || d.estado === 'error'));
const textosEnCola = () => V.cola.filter((d) => d.convertible && EXT_TEXTO.includes(d.ext));

/** Lo que dice el pie con la cola y los ajustes de ahora. */
function resumen() {
  const n = enCola().length;
  const salidas = salidasElegidas();
  const faltaCarpeta = V.ajustes.destino === 'carpeta' && !V.ajustes.carpeta;

  let aviso = '';
  if (!V.cola.length) aviso = 'Agregá archivos para empezar.';
  else if (!n) aviso = V.cola.some((d) => d.estado === 'listo') ? 'Todo convertido.' : 'Ninguno de la lista se puede convertir.';
  else if (!salidas.length) aviso = 'Elegí al menos una salida.';
  else if (faltaCarpeta) aviso = 'Elegí la carpeta de destino.';

  const textos = textosEnCola().length;
  return {
    n,
    rotulo: n === 1 ? 'archivo por convertir' : 'archivos por convertir',
    aviso: esc(aviso || salidas.map((id) => SALIDAS.find((s) => s.id === id).ext).join(' · ')),
    puede: !V.trabajando && n > 0 && salidas.length > 0 && !faltaCarpeta,
    textos,
    // Mientras une, sigue a la vista (deshabilitado y con su spinner): antes se
    // plegaba el mismo botón que acababas de tocar (herr-14).
    unir: textos >= 2 && (!V.trabajando || V.trabajando === 'unir'),
  };
}

/* El pie se armó una vez: acá cambia en el lugar (herr-12). La cifra con
   numero(), el rótulo y el aviso con frase(); antes era un innerHTML entero
   y la cifra grande saltaba de un valor al otro. */
function pintarResumen() {
  const cifra = document.getElementById('cv-resumen-n');
  if (!cifra) return;
  const r = resumen();
  numero(cifra, r.n);
  frase(document.getElementById('cv-resumen-rotulo'), r.rotulo);
  frase(document.getElementById('cv-resumen-aviso'), r.aviso);

  const boton = document.getElementById('cv-convertir');
  if (boton) boton.disabled = !r.puede;

  const unir = document.getElementById('cv-unir');
  if (unir) {
    unir.hidden = !r.unir;
    unir.disabled = !!V.trabajando;
    if (V.trabajando !== 'unir' && r.textos >= 2) frase(document.getElementById('cv-unir-rotulo'), `Unir los ${r.textos} textos en un .md`);
  }
}

const rotuloConvertir = () => (V.trabajando === 'convertir'
  ? `${Icons.spinner('qr-girando')} Convirtiendo…`
  : `${Icons.svg('convertir')} Convertir`);

const rotuloUnir = (n) => (V.trabajando === 'unir'
  ? `${Icons.spinner('qr-girando')} Uniendo…`
  : `${Icons.svg('combinar')} <span id="cv-unir-rotulo">Unir los ${n} textos en un .md</span>`);

const rotuloCancelar = () => (V.cancelando ? 'Cancelando…' : `${Icons.svg('close')} Cancelar`);

/* Libre ↔ ocupado: relevo en el lugar y el ancho viajando (herr-14). Se busca
   el botón por id: si volviste a la vista con el lote corriendo, es otro nodo,
   y nació ya ocupado. */
function ponerOcupado(id, ocupado, html) {
  ocupar(document.getElementById(id), ocupado, html);
}

function ponerCancelar() {
  const b = document.getElementById('cv-cancelar');
  if (!b) return;
  // Al terminar solo se pliega: no se releva nada mientras se va.
  if (!V.trabajando) { b.hidden = true; return; }
  const v = V.cancelando ? '1' : '0';
  if (b.dataset.cancelando !== v) {
    b.dataset.cancelando = v;
    /* Plegado, el rótulo se repone en el lugar, sin relevo, y recién después
       se despliega. Después de un lote cancelado quedaba «Cancelando…»: con
       el relevo, el lote siguiente desplegaba el botón con esa frase
       esfumándose encima de «Cancelar». swap() sin opciones igual anota lo
       que puso, así el próximo relevo sabe qué había. */
    if (b.hidden) swap(b, rotuloCancelar());
    else swap(b, rotuloCancelar(), { relevo: true });
  }
  b.disabled = V.cancelando;
  b.hidden = false;
}

/* ══ Convertir ═══════════════════════════════════════════════════════════════ */

function opcionesDelMotor() {
  const a = V.ajustes;
  return {
    ocr: a.ocr,
    restoreHyphens: a.restaurarGuiones,
    removeFooters: a.quitarPies,
    layoutAware: a.seguirLayout,
    frontmatter: a.frontmatter,
    chunkSize: a.chunkSize,
    chunkOverlap: a.chunkOverlap,
    destino: a.destino === 'carpeta' ? { modo: 'carpeta', ruta: a.carpeta } : { modo: a.destino },
  };
}

/** Lo que el motor dijo de un archivo, en su ítem. Vale para el evento y para el resultado. */
function asentarResultado(d, r) {
  if (r.cancelado) {
    // Cortado o sin empezar: vuelve a la cola, listo para otra vuelta.
    Object.assign(d, { estado: 'cola', progreso: 0, etapa: '', salidas: [], error: null, meta: null });
    return;
  }
  Object.assign(d, {
    estado: r.ok ? 'listo' : 'error',
    progreso: 1,
    salidas: r.outputs || [],
    error: r.error || null,
    meta: r.meta,
  });
}

async function convertirAhora() {
  if (V.trabajando) return;
  const lote = enCola();
  const salidas = salidasElegidas();
  if (!lote.length || !salidas.length) return;

  V.trabajando = 'convertir';
  V.cancelando = false;
  V.lote = lote;
  for (const d of lote) Object.assign(d, { estado: 'convirtiendo', progreso: 0, etapa: 'en cola', salidas: [], error: null });
  ponerOcupado('cv-convertir', true, rotuloConvertir());
  ponerCancelar();
  pintarCola();

  V.soltarProgreso?.();
  V.soltarProgreso = api.conv.onProgreso(alProgresar);

  let res = null;
  try {
    res = await api.conv.convertir({
      files: lote.map((d) => d.ruta),
      outputs: salidas,
      options: opcionesDelMotor(),
    });
    // El resultado es la confirmación final; el progreso ya fue poniendo cada fila al día.
    res.results.forEach((r, i) => { if (lote[i]) asentarResultado(lote[i], r); });
  } catch (err) {
    console.error('[convertir]', err);
    for (const d of lote) if (d.estado === 'convirtiendo') { d.estado = 'error'; d.error = err.message; }
    Toast.error('No se pudo convertir', err.message);
  } finally {
    V.soltarProgreso?.();
    V.soltarProgreso = null;
    V.trabajando = null;
    V.cancelando = false;
    V.lote = [];
    ponerOcupado('cv-convertir', false, rotuloConvertir());
    ponerCancelar();
    pintarCola();
  }
  if (res) anunciar(res);
}

/* Cancelar (main-20): el motor corta entre archivo y archivo, entre página y
   página o antes de escribir. Lo cortado y lo que no llegó a empezar vuelve a
   la cola. */
async function cancelar() {
  if (!V.trabajando || V.cancelando) return;
  V.cancelando = true;
  ponerCancelar();
  try {
    await api.conv.cancelar();
  } catch (err) {
    V.cancelando = false;
    ponerCancelar();
    Toast.error('No se pudo cancelar', err.message);
  }
}

/**
 * Traduce los eventos del motor al ítem de la cola y pone al día solo esa
 * fila. `file-done` trae las salidas, la ficha y el motivo del error
 * (herr-11): la fila queda lista —con su tilde, sus chips y su cruz— apenas
 * termina SU archivo, no cuando termina el último del lote.
 */
function alProgresar(evt) {
  const d = V.lote[evt.index];
  if (!d) return;

  if (evt.type === 'file-start') { d.etapa = 'leyendo…'; d.progreso = 0; }
  else if (evt.type === 'stage' && evt.stage === 'extract') {
    d.etapa = evt.label || 'extrayendo…';
    if (evt.total) d.progreso = Math.min(0.85, (evt.done / evt.total) * 0.85);
  } else if (evt.type === 'stage' && evt.stage === 'render') {
    d.etapa = `escribiendo ${SALIDAS.find((s) => s.id === evt.output)?.ext || evt.output}…`;
    d.progreso = Math.max(d.progreso, 0.9);
  } else if (evt.type === 'file-done') {
    asentarResultado(d, evt);
    pintarCola();       // cambia el resumen y el rail, no solo la fila
    return;
  } else {
    return;
  }

  const el = filaDe(d);
  if (!el) return;
  ponerFila(el, d);
  // Lo que reconcile() compara la próxima vez: la fila ya muestra esto.
  el.__html = itemHTML(d);
}

function anunciar(res) {
  const ok = res.results.filter((r) => r.ok);
  const cortados = res.results.filter((r) => r.cancelado).length;
  const mal = res.results.length - ok.length - cortados;
  const pdfs = ok.flatMap((r) => r.outputs.filter((o) => o.name === 'pdf'));

  if (res.cancelado) {
    Toast.show({
      title: 'Conversión cancelada',
      text: ok.length ? `${plural(ok.length, 'archivo quedó convertido', 'archivos quedaron convertidos')}; los demás siguen en la lista.` : 'Los archivos siguen en la lista.',
      icon: 'convertir',
    });
    return;
  }

  if (!ok.length) {
    Toast.error('No salió ninguno', res.results[0]?.error || 'Revisá los errores en la lista.');
    return;
  }

  Toast.show({
    title: mal ? `${ok.length} de ${res.results.length} convertidos` : plural(ok.length, 'archivo convertido', 'archivos convertidos'),
    text: res.outDirs.length === 1 ? res.outDirs[0] : `en ${plural(res.outDirs.length, 'carpeta', 'carpetas')}`,
    icon: 'convertir',
  });

  /* Un solo PDF resultante y el ajuste prendido: se abre solo. Con varios no,
     porque cuatro pestañas de golpe no es lo que nadie quiso; están en la
     lista, cada uno con su chip. */
  if (V.ajustes.abrirAlTerminar && pdfs.length === 1) abrirEnQuire(pdfs[0].path);
}

/* ══ Unir textos ═════════════════════════════════════════════════════════════ */

async function unirTextos() {
  if (V.trabajando) return;
  const textos = textosEnCola();
  if (textos.length < 2) return;

  V.trabajando = 'unir';
  V.cancelando = false;
  ponerOcupado('cv-unir', true, rotuloUnir(textos.length));
  ponerCancelar();
  pintarResumen();
  try {
    const res = await api.conv.unir({
      files: textos.map((d) => d.ruta),
      options: { destino: opcionesDelMotor().destino },
    });
    if (res?.cancelado) {
      Toast.show({ title: 'Unión cancelada', text: 'No se escribió nada.', icon: 'combinar' });
    } else {
      Toast.show({
        title: 'Textos unidos',
        // En palabras: la flecha «→» era un glifo de la fuente (herr-26).
        text: `${plural(res.files, 'archivo', 'archivos')} en ${nombreCorto(res.path)}`,
        icon: 'combinar',
      });
      api.conv.mostrar(res.path).catch(() => {});
    }
  } catch (err) {
    Toast.error('No se pudieron unir', err.message);
  } finally {
    V.trabajando = null;
    V.cancelando = false;
    ponerOcupado('cv-unir', false, rotuloUnir(textosEnCola().length));
    ponerCancelar();
    pintarResumen();
  }
}
