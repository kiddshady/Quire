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
   ═══════════════════════════════════════════════════════════════════════════ */

import { S } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast } from '../overlays.js';
import Router from '../router.js';
import { paint, head, esc, attempt } from '../ui.js';
import { fmtBytes, plural, ellipsize } from '../format.js';
import { bindSwitcher, scrollFade, exit } from '../motion.js';

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

const SALIDAS = [
  { id: 'pdf', label: 'PDF', hint: 'Examen coloreado si es Moodle; documento si no', ext: '.pdf', icono: 'quire' },
  { id: 'markdown', label: 'Markdown', hint: 'Con encabezados y tablas', ext: '.md', icono: 'markdown' },
  { id: 'txt', label: 'Texto plano', hint: 'Sin ningún formato', ext: '.txt', icono: 'file' },
  { id: 'json', label: 'JSON', hint: 'El árbol completo del documento', ext: '.json', icono: 'hash' },
  { id: 'chunks', label: 'Fragmentos', hint: 'Trozos solapados, para RAG', ext: '.chunks.json', icono: 'layers' },
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
  trabajando: false,
  /** Lo que se mandó al motor en el lote actual: índice del motor → ítem. */
  lote: [],
  soltarProgreso: null,
};

/* ══ Entrada desde afuera ════════════════════════════════════════════════════
   app.js llama a esto cuando soltás archivos convertibles en la ventana: se
   fichan (nombre, peso, si hay conversor) y entran a la cola. Si la vista
   está montada se repinta; si no, quedan esperando a que la abras. */
export async function encolar(rutas) {
  const nuevas = (rutas || []).filter((r) => r && !V.cola.some((d) => d.ruta === r));
  if (!nuevas.length) return 0;
  const fichas = await attempt(() => api.conv.fichar(nuevas), { errorTitle: 'No se pudieron leer los archivos' });
  if (!fichas?.length) return 0;
  for (const f of fichas) V.cola.push({ ...f, estado: 'cola', progreso: 0, etapa: '', salidas: [], error: null });
  if (Router.name === 'convertir') pintarCola();
  else avisarCola();
  return fichas.length;
}

/** Cuántos hay esperando: el rail lo muestra como contador. */
export const pendientes = () => V.cola.filter((d) => d.estado === 'cola' && d.convertible).length;

/* El contador del rail vive en app.js y no mira esta cola: se le avisa cada
   vez que cambia lo que hay por convertir. */
const avisarCola = () => window.dispatchEvent(new CustomEvent('quire:convertir-cola'));

/* ══ Vista ═══════════════════════════════════════════════════════════════════ */

export function viewConvertir() {
  V.ajustes = { ...AJUSTES_DEFECTO, ...(S.settings?.conversion || {}) };
  V.ajustes.salidas = { ...AJUSTES_DEFECTO.salidas, ...(V.ajustes.salidas || {}) };

  paint(head({
    title: 'Convertir',
    sub: 'Moodle a PDF · PDF, Word, PowerPoint y texto a Markdown, texto, JSON o fragmentos',
    actions: `
      <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="cv-agregar">
        <i data-icon="plus"></i> Agregar archivos
      </button>`,
  }) + `
    <div class="ox-viewbody qr-conv">
      <div class="ox-viewbody__main">
        <div class="qr-conv__cola ox-scroll" id="cv-cola"></div>
      </div>

      <aside class="ox-inspector qr-inspector">
        <div class="ox-inspector__body" id="cv-opciones"></div>
        <div class="ox-inspector__foot qr-pie">
          <div class="qr-resumen" id="cv-resumen"></div>
          <button class="ox-btn ox-btn--primary ox-flashable qr-pie__boton" id="cv-convertir">
            <i data-icon="convertir"></i> Convertir
          </button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm qr-pie__boton" id="cv-unir" hidden>
            <i data-icon="combinar"></i> Unir los textos en un .md
          </button>
        </div>
      </aside>
    </div>`);

  document.getElementById('cv-agregar')?.addEventListener('click', agregarConDialogo);
  document.getElementById('cv-convertir')?.addEventListener('click', convertirAhora);
  document.getElementById('cv-unir')?.addEventListener('click', unirTextos);

  pintarCola();
  pintarOpciones();

  /* Un solo listener delegado para la cola, enganchado al nodo que muere con
     el pintado: sobre #view se acumularía una copia por visita. El progreso,
     en cambio, se sigue escuchando aunque te vayas de la vista: el lote corre
     en el main y al volver la cola tiene que estar al día. */
  document.getElementById('cv-cola')?.addEventListener('click', clickEnCola);
}

/* ══ Cola ════════════════════════════════════════════════════════════════════ */

function pintarCola() {
  const cont = document.getElementById('cv-cola');
  if (!cont) return;

  if (!V.cola.length) {
    cont.innerHTML = `
      <div class="ox-empty qr-conv__vacio">${Icons.svg('convertir')}
        <div class="ox-empty__title">Todavía no hay nada que convertir</div>
        <div class="ox-empty__text">
          Arrastrá acá la revisión de un cuestionario Moodle, un PDF, un Word, un PowerPoint
          o un texto. También podés elegirlos con el botón de arriba.
        </div>
        <button class="ox-btn ox-btn--primary ox-flashable" id="cv-agregar-vacio" style="margin-top:var(--ox-2)"><i data-icon="plus"></i> Agregar archivos</button>
      </div>`;
    Icons.mount(cont);
    document.getElementById('cv-agregar-vacio')?.addEventListener('click', agregarConDialogo);
    pintarResumen();
    avisarCola();
    return;
  }

  cont.innerHTML = `<div class="ox-list qr-conv__lista">${V.cola.map(itemHTML).join('')}</div>`;
  Icons.mount(cont);
  scrollFade(cont);
  pintarResumen();
  avisarCola();
}

function itemHTML(d, i) {
  const tipo = TIPO_POR_EXT[d.ext] || d.ext.replace('.', '').toUpperCase();
  const clases = ['ox-listitem', 'qr-conv__item', `is-${d.estado}`];
  if (!d.convertible) clases.push('is-inerte');

  return `
    <div class="${clases.join(' ')}" data-indice="${i}">
      <span class="qr-conv__icono">${Icons.svg(iconoDe(d))}</span>
      <div class="ox-listitem__main">
        <span class="ox-listitem__title">${esc(d.nombre)}</span>
        <span class="ox-listitem__sub">${subtituloDe(d, tipo)}</span>
        <div class="ox-meter qr-conv__meter"${d.estado === 'convirtiendo' ? '' : ' hidden'}>
          <div class="ox-meter__fill" style="--ox-pct:${(d.progreso * 100).toFixed(1)}%"></div>
        </div>
        ${d.estado === 'listo' && d.salidas.length ? `
          <div class="qr-conv__salidas">
            ${d.salidas.map((s) => `
              <button class="ox-chip ox-chip--mono qr-conv__salida" data-mostrar="${esc(s.path)}"
                      ${s.name === 'pdf' ? `data-abrir="${esc(s.path)}"` : ''}
                      data-tip="${s.name === 'pdf' ? 'Abrir en Quire' : 'Mostrar en la carpeta'}">
                ${Icons.svg(s.name === 'pdf' ? 'quire' : 'folder')} ${esc(nombreCorto(s.path))}
              </button>`).join('')}
          </div>` : ''}
      </div>
      <div class="ox-rowactions">
        ${d.estado === 'convirtiendo' ? Icons.spinner() : `
          <button class="ox-iconbtn ox-iconbtn--sm" data-saca="${i}" data-tip="Sacar de la lista"><i data-icon="close"></i></button>`}
      </div>
    </div>`;
}

function iconoDe(d) {
  if (d.estado === 'error') return 'alert';
  if (d.estado === 'listo') return 'check';
  if (!d.convertible) return 'eyeOff';
  return { '.pdf': 'quire', '.htm': 'globe', '.html': 'globe', '.docx': 'file', '.pptx': 'grid' }[d.ext] || 'file';
}

/** La segunda línea del ítem cambia con el estado: ficha, etapa o resultado. */
function subtituloDe(d, tipo) {
  const base = [tipo, fmtBytes(d.tamano || 0)];
  if (!d.convertible) return esc(`${base.join(' · ')} · sin conversor para ${d.ext || 'este archivo'}`);
  if (d.estado === 'convirtiendo') return esc(`${tipo} · ${d.etapa || 'preparando…'}`);
  if (d.estado === 'error') return `<span class="ox-danger">${esc(d.error || 'Falló')}</span>`;
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

const nombreCorto = (ruta) => ellipsize(String(ruta).split(/[\\/]/).pop(), 34);

function clickEnCola(e) {
  const saca = e.target.closest('[data-saca]');
  if (saca) {
    const i = Number(saca.dataset.saca);
    const item = saca.closest('.qr-conv__item');
    // Se va animado, y recién después desaparece de la lista.
    exit(item, { onDone: () => { V.cola.splice(i, 1); pintarCola(); } });
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
    V.cola.push({ ...f, estado: 'cola', progreso: 0, etapa: '', salidas: [], error: null });
    sumados++;
  }
  if (sumados) pintarCola();
}

/* ══ Opciones (inspector) ════════════════════════════════════════════════════ */

function pintarOpciones() {
  const el = document.getElementById('cv-opciones');
  if (!el) return;
  const a = V.ajustes;

  const fila = (id, on, label, meta) => `
    <label class="ox-row qr-conv__fila">
      <button class="ox-switch${on ? ' is-on' : ''}" data-ajuste="${id}"></button>
      <span class="ox-col" style="gap:2px">
        <span class="ox-label">${label}</span>
        ${meta ? `<span class="ox-meta">${meta}</span>` : ''}
      </span>
    </label>`;

  el.innerHTML = `
    <div class="qr-op">
      <span class="ox-eyebrow">Salidas</span>
      <div class="qr-conv__salidas-lista">
        ${SALIDAS.map((s) => `
          <label class="ox-row qr-conv__fila">
            <button class="ox-check${a.salidas[s.id] ? ' is-on' : ''}" data-salida="${s.id}"><i data-icon="check"></i></button>
            <span class="ox-col" style="gap:1px">
              <span class="ox-label">${s.label} <span class="ox-meta ox-num">${s.ext}</span></span>
              <span class="ox-meta">${s.hint}</span>
            </span>
          </label>`).join('')}
      </div>
      <div class="qr-op qr-op--par qr-conv__chunks"${a.salidas.chunks ? '' : ' hidden'}>
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
      <span class="ox-meta" id="cv-destino-hint">${hintDestino(a)}</span>
      ${a.destino === 'carpeta' ? `
        <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="cv-elegir-carpeta" style="align-self:flex-start">
          <i data-icon="folder"></i> ${a.carpeta ? 'Cambiar la carpeta' : 'Elegir la carpeta'}
        </button>` : ''}
      ${fila('abrirAlTerminar', a.abrirAlTerminar, 'Abrir el PDF al terminar', 'Si salió un PDF, se abre en una pestaña.')}
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Leer un PDF</span>
      ${fila('ocr', a.ocr, 'OCR en las páginas escaneadas', 'Las que casi no tienen texto se reconocen con tesseract (español e inglés, sin conexión). Es lento.')}
      ${fila('restaurarGuiones', a.restaurarGuiones, 'Rescatar los guiones', 'Algunos libros codifican todo guión como uno "blando", y sin esto "5-HT" sale "5HT". Cuesta más tiempo.')}
      ${fila('quitarPies', a.quitarPies, 'Quitar encabezados y pies repetidos', 'Las líneas que aparecen iguales en casi todas las páginas.')}
      ${fila('seguirLayout', a.seguirLayout, 'Seguir la geometría de la página', 'Corta los renglones donde el PDF los corta, no donde los dibuja.')}
    </div>

    <div class="qr-op">
      <span class="ox-eyebrow">Markdown</span>
      ${fila('frontmatter', a.frontmatter, 'Frontmatter', 'Título, origen y fecha arriba del archivo, entre "---".')}
    </div>`;

  Icons.mount(el);
  cablearOpciones();
}

function hintDestino(a) {
  if (a.destino === 'descargas') return 'Descargas\\Quire\\<fecha de hoy>, todo junto y sin subcarpetas.';
  if (a.destino === 'carpeta') return a.carpeta ? esc(a.carpeta) : 'Todavía no elegiste ninguna.';
  return 'Cada salida queda en la carpeta de su original. Si ya hay una con ese nombre, se numera.';
}

function cablearOpciones() {
  const el = document.getElementById('cv-opciones');
  if (!el) return;

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
    if (v === 'carpeta' && !V.ajustes.carpeta) {
      const carpeta = await attempt(() => api.docs.elegirCarpeta());
      if (carpeta) V.ajustes.carpeta = carpeta;
    }
    guardarAjustes();
    pintarOpciones();
    pintarResumen();
  });

  document.getElementById('cv-elegir-carpeta')?.addEventListener('click', async () => {
    const carpeta = await attempt(() => api.docs.elegirCarpeta());
    if (!carpeta) return;
    V.ajustes.carpeta = carpeta;
    guardarAjustes();
    pintarOpciones();
    pintarResumen();
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

let guardando = null;
function guardarAjustes() {
  clearTimeout(guardando);
  guardando = setTimeout(() => {
    api.settings.save({ conversion: V.ajustes })
      .then((s) => { if (s) S.settings = s; })
      .catch((err) => console.warn('[convertir] no se guardaron los ajustes', err));
  }, 250);
}

/* ══ Resumen y botón ═════════════════════════════════════════════════════════ */

const salidasElegidas = () => SALIDAS.filter((s) => V.ajustes.salidas[s.id]).map((s) => s.id);
const enCola = () => V.cola.filter((d) => d.convertible && (d.estado === 'cola' || d.estado === 'error'));
const textosEnCola = () => V.cola.filter((d) => d.convertible && EXT_TEXTO.includes(d.ext));

function pintarResumen() {
  const res = document.getElementById('cv-resumen');
  const boton = document.getElementById('cv-convertir');
  const unir = document.getElementById('cv-unir');
  if (!res || !boton) return;

  const n = enCola().length;
  const salidas = salidasElegidas();
  const faltaCarpeta = V.ajustes.destino === 'carpeta' && !V.ajustes.carpeta;

  let aviso = '';
  if (!V.cola.length) aviso = 'Agregá archivos para empezar.';
  else if (!n) aviso = V.cola.some((d) => d.estado === 'listo') ? 'Todo convertido.' : 'Ninguno de la lista se puede convertir.';
  else if (!salidas.length) aviso = 'Elegí al menos una salida.';
  else if (faltaCarpeta) aviso = 'Elegí la carpeta de destino.';

  res.innerHTML = `
    <div class="qr-resumen__cifra">
      <span class="qr-resumen__n ox-num">${n}</span>
      <span class="ox-meta">${n === 1 ? 'archivo por convertir' : 'archivos por convertir'}</span>
    </div>
    <span class="ox-meta">${aviso || `${salidas.map((id) => SALIDAS.find((s) => s.id === id).ext).join(' · ')}`}</span>`;

  boton.disabled = V.trabajando || !n || !salidas.length || faltaCarpeta;

  if (unir) {
    const textos = textosEnCola();
    const mostrar = textos.length >= 2 && !V.trabajando;
    unir.hidden = !mostrar;
    if (mostrar) unir.innerHTML = `${Icons.svg('combinar')} Unir los ${textos.length} textos en un .md`;
  }
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

async function convertirAhora() {
  if (V.trabajando) return;
  const lote = enCola();
  const salidas = salidasElegidas();
  if (!lote.length || !salidas.length) return;

  V.trabajando = true;
  V.lote = lote;
  for (const d of lote) Object.assign(d, { estado: 'convirtiendo', progreso: 0, etapa: 'en cola', salidas: [], error: null });
  pintarCola();
  pintarResumen();
  ponerBotonOcupado(true);

  V.soltarProgreso?.();
  V.soltarProgreso = api.conv.onProgreso(alProgresar);

  try {
    const res = await api.conv.convertir({
      files: lote.map((d) => d.ruta),
      outputs: salidas,
      options: opcionesDelMotor(),
    });
    // El resultado es la verdad final; el progreso solo fue el camino.
    res.results.forEach((r, i) => {
      const d = lote[i];
      if (!d) return;
      d.estado = r.ok ? 'listo' : 'error';
      d.progreso = 1;
      d.salidas = r.outputs || [];
      d.error = r.error;
      d.meta = r.meta;
    });
    anunciar(res);
  } catch (err) {
    console.error('[convertir]', err);
    for (const d of lote) if (d.estado === 'convirtiendo') { d.estado = 'error'; d.error = err.message; }
    Toast.error('No se pudo convertir', err.message);
  } finally {
    V.soltarProgreso?.();
    V.soltarProgreso = null;
    V.trabajando = false;
    V.lote = [];
    ponerBotonOcupado(false);
    pintarCola();
    pintarResumen();
  }
}

/** Traduce los eventos del motor al ítem de la cola y actualiza solo ese ítem. */
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
    d.progreso = 1;
    d.etapa = evt.ok ? 'listo' : 'falló';
  }

  const el = document.querySelector(`.qr-conv__item[data-indice="${V.cola.indexOf(d)}"]`);
  if (!el) return;
  const sub = el.querySelector('.ox-listitem__sub');
  if (sub) sub.textContent = `${TIPO_POR_EXT[d.ext] || ''} · ${d.etapa}`;
  el.querySelector('.ox-meter__fill')?.style.setProperty('--ox-pct', `${(d.progreso * 100).toFixed(1)}%`);
}

function anunciar(res) {
  const ok = res.results.filter((r) => r.ok);
  const mal = res.results.length - ok.length;
  const pdfs = ok.flatMap((r) => r.outputs.filter((o) => o.name === 'pdf'));

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

function ponerBotonOcupado(ocupado) {
  const boton = document.getElementById('cv-convertir');
  if (!boton) return;
  boton.innerHTML = ocupado ? `${Icons.spinner()} Convirtiendo…` : `${Icons.svg('convertir')} Convertir`;
  boton.disabled = ocupado;
}

/* ══ Unir textos ═════════════════════════════════════════════════════════════ */

async function unirTextos() {
  if (V.trabajando) return;
  const textos = textosEnCola();
  if (textos.length < 2) return;

  V.trabajando = true;
  pintarResumen();
  try {
    const res = await api.conv.unir({
      files: textos.map((d) => d.ruta),
      options: { destino: opcionesDelMotor().destino },
    });
    Toast.show({
      title: 'Textos unidos',
      text: `${plural(res.files, 'archivo', 'archivos')} → ${nombreCorto(res.path)}`,
      icon: 'combinar',
    });
    api.conv.mostrar(res.path).catch(() => {});
  } catch (err) {
    Toast.error('No se pudieron unir', err.message);
  } finally {
    V.trabajando = false;
    pintarResumen();
  }
}
