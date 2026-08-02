/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — arranque
   Un lector de PDF con foco en la impresión: lo que se ve en el preview es,
   byte por byte, el archivo que se manda a la cola.

   Este archivo solo arma el shell y reparte. La lógica vive en las vistas y
   en los motores (pdf/, imposicion/).
   ═══════════════════════════════════════════════════════════════════════════ */

import './iconos.js';                    // registra los íconos del dominio
import { Icons } from './icons.js';
import { Tooltip, Toast, Menu, Modal } from './overlays.js';
import Palette from './palette.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2 } from './motion.js';
import { paint, head, empty, esc, attempt, copy, colorToken } from './ui.js';
import { fmtBytes, relTime } from './format.js';
import { designHTML, wireDesign } from './design-view.js';
import * as Actualizar from './actualizar.js';
import { S, abrir, cerrar, cargarImpresoras, emitir, alCambiar, impresoraActual } from './estado.js';
import { viewLector, atajosLector } from './views/lector.js';
import { viewImprimir } from './views/imprimir.js';
import { viewPaginas } from './views/paginas.js';
import { viewHerramientas } from './views/herramientas.js';

const api = window.onyx;

/* ══ Abrir documentos ════════════════════════════════════════════════════════ */

async function abrirConDialogo() {
  const archivo = await attempt(() => api.docs.elegir(), { errorTitle: 'No se pudo abrir el archivo' });
  if (!archivo) return;                  // el usuario canceló
  await cargar(archivo);
}

async function abrirRuta(ruta) {
  const archivo = await attempt(() => api.docs.leer(ruta), { errorTitle: 'No se pudo abrir el archivo' });
  if (archivo) await cargar(archivo);
}

async function cargar(archivo) {
  await attempt(async () => {
    await abrir(archivo);
    await api.settings.save({ ultimoDocumento: archivo.ruta });
    Toast.show({
      title: archivo.nombre,
      text: `${S.doc.paginas} ${S.doc.paginas === 1 ? 'página' : 'páginas'} · ${fmtBytes(archivo.tamano)}`,
      icon: 'quire',
    });
    registrarComandos();
    Router.go('lector');
  }, { errorTitle: 'No se pudo leer el PDF' });
}

/* Arrastrar un PDF a la ventana. Chromium abriría el archivo REEMPLAZANDO la
   app si no se cancelan los dos eventos — con prevenir el drop no alcanza. */
function cablearArrastre() {
  const capa = document.querySelector('.ox-app');
  let dentro = 0;

  const marcar = (on) => document.body.classList.toggle('qr-soltando', on);

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes('Files')) { dentro++; marcar(true); }
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dentro <= 0) { dentro = 0; marcar(false); }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dentro = 0; marcar(false);

    const archivos = [...(e.dataTransfer?.files || [])];
    const pdf = archivos.find((f) => /\.pdf$/i.test(f.name));
    if (!pdf) {
      if (archivos.length) Toast.error('Eso no es un PDF', archivos[0].name);
      return;
    }
    const ruta = api.docs.rutaDe(pdf);
    if (ruta) await abrirRuta(ruta);
    else Toast.error('No se pudo ubicar el archivo', 'Probá abrirlo desde el botón Abrir.');
  });

  return capa;
}

/* ══ Piezas ══════════════════════════════════════════════════════════════════ */

function viewPiezas() {
  paint(head({
    title: 'Piezas',
    sub: 'Todos los primitivos del sistema, vivos',
    actions: '<button class="ox-btn ox-btn--ghost ox-flashable" id="replay"><i data-icon="retry"></i> Repetir entradas</button>',
  }) + designHTML());

  wireDesign(document.getElementById('view'));
  document.getElementById('replay')?.addEventListener('click', () => {
    const body = document.getElementById('design-body');
    body.style.animation = 'none';
    void body.offsetWidth;
    body.style.animation = 'ox-glide-in 420ms var(--ox-ease) both';
  });
}

/* ══ Ajustes ═════════════════════════════════════════════════════════════════ */

function viewAjustes() {
  const st = S.settings;
  const imp = impresoraActual();

  paint(head({
    title: 'Ajustes',
    sub: 'Se guardan en settings.json, con escritura atómica',
    actions: '<button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="set-refrescar"><i data-icon="retry"></i> Releer impresoras</button>',
  }) + `
    <div class="ox-scroll ox-grow" style="padding-left:24px;padding-right:24px">
      <div style="max-width:640px">

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Impresora</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col" style="gap:18px">
            <div class="ox-field">
              <label class="ox-field__label">Predeterminada</label>
              <button class="ox-select" id="set-impresora">
                <span>${esc(S.impresora || 'Ninguna')}</span><i data-icon="chevronDown"></i>
              </button>
            </div>
            ${imp ? `
            <div class="ox-kv">
              <span class="ox-kv__k">Ambas caras</span>
              <span class="ox-kv__v">${imp.soportaDuplex ? 'Sí, el driver lo declara' : 'No'}</span>
              <span class="ox-kv__k">Color</span>
              <span class="ox-kv__v">${imp.soloMonocromo ? 'Solo blanco y negro' : 'Color'}</span>
              <span class="ox-kv__k">Tamaños</span>
              <span class="ox-kv__v ox-num">${imp.tamanos?.length || 0}</span>
              <span class="ox-kv__k">Copias máx.</span>
              <span class="ox-kv__v ox-num">${imp.maxCopias ?? '—'}</span>
            </div>
            ${areaImprimibleHTML(imp)}` : '<span class="ox-meta">Todavía no se leyeron las capacidades.</span>'}
            <label class="ox-row" style="gap:12px">
              <button class="ox-switch${st.duplexAsistido ? ' is-on' : ''}" id="set-duplex"></button>
              <span class="ox-col" style="gap:2px">
                <span class="ox-label">Dúplex asistido</span>
                <span class="ox-meta">Quire maneja las dos pasadas y te muestra cómo va el fajo de vuelta a la bandeja, en vez de dejárselo al driver.</span>
              </span>
            </label>
            <label class="ox-row" style="gap:12px">
              <button class="ox-switch${st.mostrarNoImprimible ? ' is-on' : ''}" id="set-margen"></button>
              <span class="ox-col" style="gap:2px">
                <span class="ox-label">Marcar el área no imprimible</span>
                <span class="ox-meta">Dibuja en el preview el borde que el tóner no alcanza.</span>
              </span>
            </label>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Lectura</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col" style="gap:18px">
            <div class="ox-field">
              <label class="ox-field__label">Al abrir un documento</label>
              <div class="ox-segmented" id="set-zoom" style="max-width:320px">
                ${[['ancho', 'Ajustar al ancho'], ['pagina', 'Página entera'], ['fijo', '100%']]
    .map(([id, label]) => `<button class="ox-segmented__opt${st.modoZoomInicial === id ? ' is-active' : ''}" data-value="${id}">${label}</button>`).join('')}
              </div>
            </div>
            <label class="ox-row" style="gap:12px">
              <button class="ox-switch${st.reabrirUltimo ? ' is-on' : ''}" id="set-reabrir"></button>
              <span class="ox-col" style="gap:2px">
                <span class="ox-label">Reabrir el último documento</span>
                <span class="ox-meta">Al arrancar, vuelve a cargar el PDF que estabas leyendo.</span>
              </span>
            </label>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Actualizaciones</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col" style="gap:18px">
            <div class="ox-row" style="gap:12px">
              <button class="ox-btn ox-btn--secondary ox-flashable" id="set-buscar-update">
                <i data-icon="download"></i> Buscar ahora
              </button>
              <span class="ox-meta ox-grow" id="set-update-estado">${esc(resumenActualizacion())}</span>
            </div>
            <label class="ox-row" style="gap:12px">
              <button class="ox-switch${st.avisarActualizaciones !== false ? ' is-on' : ''}" id="set-avisar"></button>
              <span class="ox-col" style="gap:2px">
                <span class="ox-label">Avisarme cuando haya una versión nueva</span>
                <span class="ox-meta">Busca al arrancar y te muestra un cartel solo si hay algo. Nunca baja nada sin que se lo pidas.</span>
              </span>
            </label>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Acerca de</span></div>
          <div class="ox-card"><div class="ox-card__body">
            <div class="ox-kv">
              <span class="ox-kv__k">App</span><span class="ox-kv__v">${esc(S.info?.name || '—')} ${esc(S.info?.version || '')}</span>
              <span class="ox-kv__k">Electron</span><span class="ox-kv__v ox-mono">${esc(S.info?.electron || '—')}</span>
              <span class="ox-kv__k">Datos</span>
              <span class="ox-kv__v ox-mono ox-copyable" data-copy="${esc(S.info?.dataDir || '')}">${esc(S.info?.dataDir || '—')}</span>
            </div>
          </div></div>
        </div>

      </div>
      <div style="height:32px"></div>
    </div>`);

  cablearAjustes();
}

/** En qué anda el actualizador, en una línea. */
function resumenActualizacion() {
  const e = Actualizar.leer();
  switch (e.fase) {
    case 'buscando': return 'Buscando…';
    case 'al-dia': return 'Estás en la última versión.';
    case 'disponible': return `Hay una versión nueva: ${e.version}.`;
    case 'descargando': return `Bajando ${e.version}… ${Math.round((e.progreso?.pct || 0) * 100)}%`;
    case 'listo': return `${e.version} lista: reiniciá para instalarla.`;
    case 'error': return e.error || 'La última búsqueda falló.';
    case 'sin-soporte': return e.motivo || 'Esta copia no se actualiza sola.';
    default: return 'Todavía no se buscó.';
  }
}

/** El borde muerto de la impresora, en los dos tamaños que más se usan. */
function areaImprimibleHTML(imp) {
  const buscar = (sufijo) => imp.tamanos?.find((t) => t.nombre.toLowerCase().endsWith(sufijo));
  const filas = [['A4', buscar('a4')], ['A5', buscar('a5')]]
    .filter(([, t]) => t?.imprimible)
    .map(([etiqueta, t]) => {
      const m = t.imprimible;
      const der = Math.round((t.ancho - m.ancho - m.x) * 10) / 10;
      const inf = Math.round((t.alto - m.alto - m.y) * 10) / 10;
      const n = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
      return `<span class="ox-kv__k">${etiqueta}</span>
              <span class="ox-kv__v ox-num">${n(m.ancho)} × ${n(m.alto)} mm
                <span class="ox-dim">· margen ${n(m.x)}/${n(der)}/${n(m.y)}/${n(inf)}</span></span>`;
    });

  if (!filas.length) return '';
  return `<div class="ox-col" style="gap:6px">
      <span class="ox-eyebrow">Área imprimible real</span>
      <div class="ox-kv">${filas.join('')}</div>
      <span class="ox-meta">Lo que queda afuera de ese rectángulo no lo alcanza el tóner, por más que el PDF lo tenga.</span>
    </div>`;
}

function cablearAjustes() {
  const $ = (id) => document.getElementById(id);

  const toggle = (id, clave) => $(id)?.addEventListener('click', async (e) => {
    const on = !e.currentTarget.classList.contains('is-on');
    e.currentTarget.classList.toggle('is-on', on);
    await guardar({ [clave]: on });
  });

  toggle('set-duplex', 'duplexAsistido');
  toggle('set-margen', 'mostrarNoImprimible');
  toggle('set-reabrir', 'reabrirUltimo');
  toggle('set-avisar', 'avisarActualizaciones');

  /* Buscar a mano abre el cartel pase lo que pase, incluso para decirte que
     estás al día: si lo pediste vos, callarse es peor que molestar. */
  $('set-buscar-update')?.addEventListener('click', () => {
    api.update.buscar({ manual: true }).catch((err) => Toast.error('No se pudo buscar', err.message));
  });
  /* La baja va por onLeave: sin eso, cada visita a Ajustes deja un oyente más
     apuntando a un nodo que ya no está en el DOM. */
  Router.onLeave(Actualizar.alCambiar(() => {
    const el = $('set-update-estado');
    if (el) el.textContent = resumenActualizacion();
  }));

  $('set-zoom')?.querySelectorAll('.ox-segmented__opt').forEach((b) => {
    b.addEventListener('click', async () => {
      $('set-zoom').querySelectorAll('.ox-segmented__opt').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      await guardar({ modoZoomInicial: b.dataset.value });
    });
  });

  $('set-impresora')?.addEventListener('click', (e) => {
    if (!S.impresoras.length) return Toast.error('No hay impresoras', 'Windows no reporta ninguna cola de impresión.');
    Menu.show(e.currentTarget, S.impresoras.map((p) => ({
      label: p.etiqueta,
      icon: 'printer',
      selected: p.nombre === S.impresora,
      hint: p.predeterminada ? 'del sistema' : '',
      onSelect: async () => {
        S.impresora = p.nombre;
        await guardar({ impresora: p.nombre });
        emitir('impresoras');
        Router.refresh();
      },
    })), { align: 'start' });
  });

  $('set-refrescar')?.addEventListener('click', async () => {
    await attempt(async () => {
      await cargarImpresoras({ refrescar: true });
      Toast.show({ title: 'Impresoras releídas', text: `${S.impresoras.length} encontradas`, icon: 'printer' });
      Router.refresh();
    }, { errorTitle: 'No se pudieron leer las impresoras' });
  });
}

async function guardar(patch) {
  const saved = await attempt(() => api.settings.save(patch), { errorTitle: 'No se pudieron guardar los ajustes' });
  if (saved) S.settings = saved;
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

Router.define({
  lector: { view: viewLector },
  paginas: { view: viewPaginas },
  imprimir: { view: viewImprimir },
  herramientas: { view: viewHerramientas },
  piezas: { view: viewPiezas },
  ajustes: { view: viewAjustes },
}, document.getElementById('view'));

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function cablearShell() {
  const w = api?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.addEventListener('click', () => Router.go(b.dataset.view)));

  document.getElementById('btn-palette')?.addEventListener('click', () => Palette.toggle());
  document.getElementById('btn-abrir')?.addEventListener('click', abrirConDialogo);

  /* Delegación global: las vistas se repintan enteras, así que enganchar los
     handlers en cada repintado sería recablear todo cada vez. */
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) Router.go(goto.dataset.goto, goto.dataset.param || null);

    const cp = e.target.closest('[data-copy]');
    if (cp) copy(cp.dataset.copy);

    const act = e.target.closest('[data-action]');
    if (act?.dataset.action === 'abrir') abrirConDialogo();
    if (act?.dataset.action === 'cerrar') cerrarDocumento();
  });

  document.addEventListener('keydown', (e) => {
    if (atajosLector(e)) return;
    const enCampo = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.ctrlKey && e.key.toLowerCase() === 'o' && !enCampo) { e.preventDefault(); abrirConDialogo(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'p' && !enCampo && S.doc) { e.preventDefault(); Router.go('imprimir'); }
    if (e.ctrlKey && e.key.toLowerCase() === 'w' && S.doc) { e.preventDefault(); cerrarDocumento(); }
  });

  cablearArrastre();
}

async function cerrarDocumento() {
  await cerrar();
  await api.settings.save({ ultimoDocumento: null }).catch(() => {});
  registrarComandos();
  Router.go('lector');
}

/** Todo lo que vive fuera de la vista: statusbar, contadores del rail, contexto. */
function actualizarChrome() {
  const nombre = document.getElementById('stat-doc-name');
  if (nombre) nombre.textContent = S.doc ? S.doc.nombre : 'Ningún documento';

  const cuenta = document.getElementById('nav-paginas-count');
  if (cuenta) cuenta.textContent = S.doc ? S.doc.paginas : '';

  for (const id of ['stat-pagina', 'stat-medida']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !S.doc;
  }

  const imp = document.getElementById('stat-impresora');
  const impVal = document.getElementById('stat-impresora-value');
  if (imp && impVal) {
    imp.hidden = !S.impresora;
    impVal.textContent = S.impresora || '—';
  }

  document.getElementById('stat-version').innerHTML =
    `<span>${esc(S.info?.name || 'Quire')} ${esc(S.info?.version || '')}</span>`;

  document.getElementById('rail-foot').innerHTML = S.doc
    ? `<span class="ox-meta ox-truncate" data-tip="${esc(S.doc.ruta || '')}">${esc(S.doc.nombre)}</span>`
    : `<span class="ox-meta ox-truncate">Sin documento</span>`;

  const ctx = document.getElementById('titlebar-context');
  if (ctx) {
    ctx.innerHTML = S.doc
      ? `${Icons.svg('quire', 'ox-icon--sm')}<span>${esc(S.doc.nombre)}</span>`
      : '';
  }
}

function registrarComandos() {
  Palette.clear();
  Palette.register([
    { id: 'abrir', group: 'Documento', icon: 'folder', label: 'Abrir un PDF…', hint: 'Ctrl O', run: abrirConDialogo },
    ...(S.doc ? [
      { id: 'cerrar', group: 'Documento', icon: 'close', label: 'Cerrar el documento', hint: 'Ctrl W', run: cerrarDocumento },
      { id: 'imprimir', group: 'Documento', icon: 'printer', label: 'Imprimir…', hint: 'Ctrl P', run: () => Router.go('imprimir') },
    ] : []),
    { id: 'nav-lector', group: 'Ir a', icon: 'book', label: 'Documento', run: () => Router.go('lector') },
    { id: 'nav-paginas', group: 'Ir a', icon: 'grid', label: 'Páginas', run: () => Router.go('paginas') },
    { id: 'nav-imprimir', group: 'Ir a', icon: 'printer', label: 'Imprimir', run: () => Router.go('imprimir') },
    { id: 'nav-herramientas', group: 'Ir a', icon: 'tools', label: 'Herramientas', run: () => Router.go('herramientas') },
    { id: 'nav-piezas', group: 'Ir a', icon: 'layers', label: 'Piezas', run: () => Router.go('piezas') },
    { id: 'nav-ajustes', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => Router.go('ajustes') },
  ]);
}

/* ══ Color de la ventana ═════════════════════════════════════════════════════
   --ox-bg está en oklch y Electron solo entiende hex. Se resuelve acá y se le
   manda al proceso principal, así el frame fantasma que pinta el compositor de
   Windows al restaurar sigue camuflado aunque cambie el matiz en tokens.css.

   La traducción a hex la hace colorToken() con un canvas, no un regex. El
   porqué está en ui.js y no es opcional: parseando el texto, la app le mandaba
   VERDE a su propia ventana. */
function sincronizarColorVentana() {
  const hex = colorToken('--ox-bg');
  if (hex) api?.win?.setBackground(hex);
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  Palette.init();
  initClickFlash();
  initScrollFades();
  cablearShell();
  sincronizarColorVentana();

  try {
    const [info, settings] = await Promise.all([api.info(), api.settings.get()]);
    S.info = info;
    S.settings = settings;
    S.modoZoom = settings.modoZoomInicial || 'ancho';
  } catch (err) {
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  registrarComandos();
  actualizarChrome();
  alCambiar(actualizarChrome);
  Router.onChange(actualizarChrome);
  Router.go('lector');

  // El splash se va recién cuando ya hay algo pintado debajo.
  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });

  /* Lo que no bloquea el primer pintado va después: leer las capacidades de
     las impresoras tarda ~1s porque las pide el subsistema de Windows. */
  cargarImpresoras().catch((err) => console.error('[impresoras]', err.message));

  /* Qué documento se carga al arrancar. El del doble click GANA: si abriste un
     PDF desde el explorador querés ese, no el de ayer — y encima el de ayer
     tardaría lo mismo en cargar para después ser reemplazado. */
  const pedido = await api.docs.pendiente().catch(() => null);

  if (pedido) {
    abrirRuta(pedido);
  } else if (S.settings.reabrirUltimo && S.settings.ultimoDocumento) {
    api.docs.leer(S.settings.ultimoDocumento)
      .then((archivo) => abrir(archivo).then(registrarComandos))
      .catch(() => api.settings.save({ ultimoDocumento: null }).catch(() => {}));
  }

  /* Con Quire ya abierta, otro doble click no levanta una segunda ventana: el
     proceso nuevo le pasa la ruta a este y se muere (ver main.cjs). */
  api.docs.onAbrir((ruta) => { abrirRuta(ruta); });

  Actualizar.iniciar({ avisar: S.settings.avisarActualizaciones !== false })
    .catch((err) => console.error('[actualizar]', err.message));
}

boot();
