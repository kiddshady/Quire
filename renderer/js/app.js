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
import Router from './router.js';
import {
  initClickFlash, initScrollFades, raf2, swap, frase, contador, ocupar, deslizarAncho, bindSwitcher, exit,
} from './motion.js';
import { paint, head, empty, esc, attempt, copy, colorToken } from './ui.js';
import { fmtBytes, fmtDec, plural, relTime } from './format.js';
import { designHTML, wireDesign } from './design-view.js';
import * as Actualizar from './actualizar.js';
import {
  S, abrir, cerrar, activar, activarRelativa, mover, rutasAbiertas, posicionActiva,
  guardarTodo, cargarImpresoras, emitir, alCambiar, impresoraActual, MAX_PESTANAS,
  estaAbierto, hayLugar, cambiosDePaginas, papelesDisponibles,
} from './estado.js';
import * as Pestanas from './pestanas.js';
import { viewLector, atajosLector } from './views/lector.js';
import { viewImprimir, SIN_IMPRESORAS } from './views/imprimir.js';
import { viewPaginas, describirCambios, PREGUNTA_CAMBIOS } from './views/paginas.js';
import { viewHerramientas, encolarCombinar, seccionActual } from './views/herramientas.js';
import { viewConvertir, encolar as encolarConvertibles, pendientes as convertiblesPendientes } from './views/convertir.js';

const api = window.onyx;

/* ══ Abrir documentos ════════════════════════════════════════════════════════ */

const LLENO = `Ya hay ${MAX_PESTANAS} documentos abiertos. Cerrá uno para abrir otro.`;

async function abrirConDialogo() {
  /* Con las cuatro pestañas ocupadas el diálogo no se abre: dejaba buscar y
     elegir un archivo, lo leía entero y recién ahí decía que no había lugar
     (shell-40, ux-24). Reabrir uno que ya está sigue siendo posible: por el
     arrastre o el doble click, que pasan por abrirVarias. */
  if (!hayLugar()) { Toast.error('No entra otro documento', LLENO); return; }
  /* Varios a la vez, con Ctrl o Shift en el diálogo: con pestañas para cuatro,
     elegir de a uno era la única forma (ux-12). Vuelven las rutas, y cada una
     se lee recién cuando le toca. */
  const rutas = await attempt(() => api.docs.elegir({ varios: true }), { errorTitle: 'No se pudo abrir el archivo' });
  if (rutas?.length) await abrirVarias(rutas);
}

/* ── Las aperturas, en fila ──────────────────────────────────────────────────
   Toda apertura por ruta (el diálogo, lo que soltás, el doble click en el
   Explorador, la sesión del arranque) pasa por UNA fila: cada tanda espera a
   la anterior. Corrían en paralelo, y hayLugar() no las frenaba —cuenta lo
   que está en enCurso, que se llena recién adentro de abrir(), después de
   leer el archivo—: con dos lugares y tres PDF elegidos en el Explorador se
   leían los tres del disco, el tercero terminaba en «No se pudo abrir el
   PDF» en vez de «Uno quedó afuera», la franja salía en el orden en que
   terminaron las lecturas y cada uno pasaba por el lector al abrirse
   (auditoría 2F).

   `enFila` cuenta las tandas encoladas o corriendo, y es lo que sostiene el
   «Abriendo…» (ver seguirCargando): sube ANTES de leer, que es lo que más
   tarda, y no baja entre dos documentos de la misma tanda ni entre dos
   tandas seguidas. */
let fila = Promise.resolve();
let enFila = 0;

function encolar(tarea) {
  enFila += 1;
  seguirCargando();
  const turno = fila.then(tarea).finally(() => { enFila -= 1; seguirCargando(); });
  fila = turno.catch(() => {});
  return turno;
}

const abrirVarias = (lista) => encolar(() => abrirTanda(lista));

/* Windows lanza un proceso por archivo al elegir varios PDF y apretar Enter, y
   a esta ventana le llega un 'docs:abrir' por cada uno, casi juntos. Los que
   llegan dentro de RAFAGA_MS desde el primero van en UNA tanda: un solo aviso
   de abiertos (o de los que quedaron afuera) y solo el primero queda a la
   vista. De a uno, cada uno se activaba al abrirse y el lector hacía un
   fundido por documento. La ventana arranca con el primero y no se estira:
   un goteo largo no posterga la tanda para siempre, y lo que llegue tarde va
   en la tanda siguiente, que igual espera su turno en la fila. */
const RAFAGA_MS = 100;
let rafaga = [];
let relojRafaga = 0;

function abrirRuta(ruta) {
  rafaga.push(ruta);
  if (relojRafaga) return;
  relojRafaga = setTimeout(() => {
    const lista = rafaga;
    rafaga = [];
    relojRafaga = 0;
    abrirVarias(lista);
  }, RAFAGA_MS);
}

/**
 * Abre una tanda de PDFs por ruta: los del diálogo, los que soltaste, los del
 * doble click en el Explorador. En orden y de a uno, como la sesión: el
 * primero queda a la vista mientras los demás siguen cargando, y la franja
 * los muestra en el orden en que llegaron. Corre siempre en su turno de la
 * fila (abrirVarias), nunca suelta.
 *
 * · Uno que ya está abierto no se vuelve a leer del disco: te lleva a su
 *   pestaña y lo dice («Ya estaba abierto»), en vez del aviso de abierto con
 *   páginas y tamaño como si fuera nuevo (shell-40).
 * · Hasta llenar las pestañas. Los que sobran no desaparecen en silencio: un
 *   aviso dice cuántos quedaron afuera y por qué (shell-28, ux-12).
 */
async function abrirTanda(lista) {
  const rutas = [...new Set((lista || []).filter(Boolean))];
  const abiertos = [];
  const sobran = [];
  let primera = null;          // la pestaña que queda a la vista
  let yaEstaba = null;

  for (const ruta of rutas) {
    if (estaAbierto(ruta)) {
      let p = S.pestanas.find((x) => x.doc?.ruta === ruta);
      /* Abriéndose por otro lado (todavía en enCurso, sin pestaña): se espera a
         que entre. Se salteaba sin decir nada, porque estaAbierto() daba que
         sí y en la franja todavía no estaba. abrir() con una ruta en curso no
         lee nada: espera esa misma apertura. */
      if (!p) {
        const doc = await abrir({ ruta }, { activar: false }).catch(() => null);
        p = doc ? S.pestanas.find((x) => x.doc === doc) : null;
      }
      if (p && !primera) {
        primera = p;
        yaEstaba = p;
        activar(p.id);
        Router.go('lector');
      }
      continue;
    }
    if (!hayLugar()) { sobran.push(ruta); continue; }

    const archivo = await attempt(() => api.docs.leer(ruta), { errorTitle: 'No se pudo abrir el archivo' });
    if (!archivo) continue;
    // Leer tarda: lo que se abrió por fuera de la fila mientras tanto también cuenta.
    if (!hayLugar()) { sobran.push(ruta); continue; }
    const doc = await attempt(() => abrir(archivo, { activar: !primera }), { errorTitle: 'No se pudo abrir el PDF' });
    if (!doc) continue;
    abiertos.push({ doc, tamano: archivo.tamano });
    if (!primera) {
      primera = S.pestanas.find((x) => x.doc === doc) || null;
      Router.go('lector');
    }
  }

  if (abiertos.length === 1) {
    const { doc, tamano } = abiertos[0];
    Toast.show({ title: doc.nombre, text: `${plural(doc.paginas, 'página', 'páginas')} · ${fmtBytes(tamano)}`, icon: 'quire' });
  } else if (abiertos.length > 1) {
    Toast.show({ title: `${abiertos.length} documentos abiertos`, text: abiertos.map((a) => a.doc.nombre).join(' · '), icon: 'quire' });
  } else if (yaEstaba) {
    Toast.show({ title: yaEstaba.doc.nombre, text: 'Ya estaba abierto: es la pestaña que tenés adelante.', icon: 'quire' });
  }
  if (sobran.length) {
    Toast.show({
      title: sobran.length === 1 ? 'Uno quedó afuera' : `${sobran.length} quedaron afuera`,
      text: `Entran ${MAX_PESTANAS} documentos a la vez. Cerrá alguno para abrir el resto.`,
      icon: 'info',
      duration: 7000,
    });
  }
}

/* Qué documentos quedan abiertos, para rearmar la sesión al arrancar. Se
   escribe desde UN solo lado —la suscripción a 'pestanas', en boot()— y no
   desde cada sitio que abre o cierra: la franja también cierra pestañas por su
   cuenta, y con dos caminos uno de los dos se olvida. */
const recordarSesion = () =>
  api.settings.save({ ultimosDocumentos: rutasAbiertas(), posicionActiva: posicionActiva() }).catch(() => {});

/**
 * Vuelve a abrir las pestañas de la sesión anterior.
 *
 * En orden y de a una, no todas juntas: la primera de la lista es la que
 * estabas mirando, y abrirla sola primero te la deja en pantalla mientras las
 * otras siguen cargando. En paralelo llegarían desordenadas y la franja
 * quedaría barajada respecto de cómo la dejaste.
 *
 * Las demás entran SIN activarse y directo en su lugar de la franja. Antes
 * cada una quedaba activa al abrirse: el lector hacía un fundido a cada
 * documento y al final volvía al primero, y la franja se reordenaba a la
 * vista con el mover() del final (shell-04, lector-20).
 *
 * Un archivo que ya no está se saltea sin decir nada: que Quire arranque con
 * un cartel de error porque moviste un PDF la semana pasada es peor que
 * arrancar con una pestaña menos. Al terminar, lo que se pudo abrir se vuelve
 * a guardar, así la lista se limpia sola.
 *
 * Corre en la fila de aperturas (encolar), como abrirVarias: un PDF que llega
 * por doble click mientras se rearma la sesión espera a que termine, en vez
 * de meterse en el medio de la franja.
 */
async function restaurarSesion() {
  const rutas = [...new Set(S.settings.ultimosDocumentos || [])].slice(0, MAX_PESTANAS);
  if (!rutas.length) return;

  /* El orden final de la franja: las demás en su orden, y la que estabas
     leyendo en el lugar donde la habías dejado. Se abrió primera para verla
     enseguida, no porque fuera la primera. */
  const final = rutas.slice(1);
  final.splice(Math.max(0, Math.min(final.length, S.settings.posicionActiva || 0)), 0, rutas[0]);

  // Cada una entra delante de las ya abiertas que en la franja final van
  // después que ella: cuenta solo las que se pudieron abrir.
  const lugares = [];
  for (const ruta of rutas) {
    const lugar = final.indexOf(ruta);
    try {
      await abrir(await api.docs.leer(ruta), {
        activar: ruta === rutas[0],
        posicion: lugares.filter((l) => l < lugar).length,
      });
      lugares.push(lugar);
    } catch (err) {
      console.warn('[sesión] no se pudo reabrir', ruta, err.message);
    }
  }
}

/* Lo que el motor de conversión sabe leer. Es el mismo criterio que
   src/conversion.cjs, repetido acá para decidir sin ida y vuelta al main a
   dónde va lo que soltaste. */
const ES_CONVERTIBLE = /\.(htm|html|pdf|docx|pptx|txt|text|md|markdown|rst|log)$/i;
/* Lo que Combinar sabe unir: PDFs e imágenes (los mismos formatos que lee
   docs.leer con `imagenes`). */
const ES_IMAGEN = /\.(png|jpe?g|webp)$/i;
const PARA_COMBINAR = /\.(pdf|png|jpe?g|webp)$/i;
const nombreDeRuta = (ruta) => String(ruta || '').split(/[\\/]/).pop();

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
    await soltarArchivos(archivos.map((f) => ({ nombre: f.name, ruta: api.docs.rutaDe(f) || null })));
  });

  return capa;
}

/**
 * A dónde va lo que se soltó en la ventana. `lista` es [{ nombre, ruta }]:
 * la ruta la da webUtils (preload, rutaDe) y puede faltar.
 *
 * Separado del evento para que chrome.cjs y herramientas.cjs lo prueben con
 * archivos de verdad: un File fabricado en la página no tiene ruta en disco
 * (webUtils devuelve ''), así que un drop sintético no llega más allá del
 * «No se pudo ubicar el archivo».
 */
export async function soltarArchivos(lista) {
  const rutas = lista.map((a) => a.ruta).filter(Boolean);

  /* En Convertir, todo lo que soltás entra a la cola, PDFs incluidos: ahí un
     PDF es materia prima, no algo para leer. En cualquier otra vista, un
     archivo convertible que no es PDF —el .htm de un cuestionario, un
     .docx— te lleva a Convertir con el archivo ya en la lista. */
  const convertibles = rutas.filter((r) => ES_CONVERTIBLE.test(r));
  if (Router.name === 'convertir' && convertibles.length) {
    await encolarConvertibles(convertibles);
    return;
  }

  /* Lo mismo en Combinar (ux-13): parado en Herramientas, sección Combinar,
     los PDFs y las imágenes que soltás se suman a la lista. Antes un PDF se
     abría en una pestaña y una imagen daba un error que mandaba… a
     Herramientas, sección Combinar, donde ya estabas. */
  const paraCombinar = rutas.filter((r) => PARA_COMBINAR.test(r));
  if (Router.name === 'herramientas' && seccionActual() === 'combinar' && paraCombinar.length) {
    await encolarCombinar(paraCombinar);
    /* Lo que vino junto y no se combina pero sí se convierte (un .docx, el
       .htm de un cuestionario) se descartaba sin decir nada; fuera de
       Combinar ese mismo archivo llevaba a Convertir (revisión del 4A). Va a
       esa cola sin sacarte de acá, y el aviso lo dice con un atajo. */
    const aConvertir = convertibles.filter((r) => !PARA_COMBINAR.test(r));
    if (aConvertir.length) {
      const n = await encolarConvertibles(aConvertir);
      if (n) {
        Toast.show({
          title: n === 1 ? '1 archivo fue a Convertir' : `${n} archivos fueron a Convertir`,
          text: 'Combinar suma PDFs e imágenes: lo demás espera en la lista de Convertir.',
          icon: 'convertir',
          action: { label: 'Ver', run: () => Router.go('convertir') },
        });
      }
    }
    return;
  }

  const pdfs = lista.filter((a) => /\.pdf$/i.test(a.ruta || a.nombre));
  if (!pdfs.length) {
    const otros = convertibles.filter((r) => !/\.pdf$/i.test(r));
    if (otros.length) {
      const n = await encolarConvertibles(otros);
      if (n) Router.go('convertir');
      return;
    }
    /* Soltar acá abre un documento, y una imagen no es un documento. Pero la
       app SÍ sabe qué hacer con una imagen: van a Combinar, ya cargadas, como
       los .docx van a Convertir (ux-13). encolarCombinar deja elegida la
       sección; el «Acá se abren PDFs» que mandaba a buscarla ya no hace falta.
       Si no entró ninguna (fallaron todas), su aviso ya dijo por qué. */
    const imagenes = rutas.filter((r) => ES_IMAGEN.test(r));
    if (imagenes.length) {
      const n = await encolarCombinar(imagenes);
      if (n) Router.go('herramientas');
      return;
    }
    if (lista.some((a) => ES_IMAGEN.test(a.nombre))) {
      Toast.error('No se pudo ubicar el archivo', 'Probá sumarlo desde Herramientas, sección Combinar, con Agregar archivos.');
    } else if (lista.length) {
      Toast.error('Eso no es un PDF', lista[0].nombre || nombreDeRuta(lista[0].ruta));
    }
    return;
  }
  /* Todos los PDF que soltaste, en orden, hasta llenar las pestañas: se
     abría solo el primero y los demás se ignoraban sin aviso (shell-28). */
  const rutasPdf = pdfs.map((a) => a.ruta).filter(Boolean);
  if (rutasPdf.length) await abrirVarias(rutasPdf);
  else Toast.error('No se pudo ubicar el archivo', 'Probá abrirlo desde el botón Abrir.');
}

/* ══ Piezas ══════════════════════════════════════════════════════════════════ */

function viewPiezas() {
  paint(head({
    title: 'Piezas',
    sub: 'Todos los primitivos del sistema, vivos',
    actions: '<button class="ox-btn ox-btn--ghost ox-flashable" id="replay"><i data-icon="retry"></i> Repetir entradas</button>',
  }) + designHTML());

  wireDesign(document.getElementById('view'));
  /* Con la API y sin `fill`: el style.animation con `both` de antes retenía
     el último cuadro para siempre (transform y opacidad en línea), y eso
     volvía al cuerpo de la vitrina bloque contenedor y frontera de backdrop
     (shell-35). Duración y curva, de los tokens. */
  document.getElementById('replay')?.addEventListener('click', () => {
    const body = document.getElementById('design-body');
    const raiz = getComputedStyle(document.documentElement);
    body?.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], {
      duration: parseFloat(raiz.getPropertyValue('--ox-t-4')) || 420,
      easing: raiz.getPropertyValue('--ox-ease').trim() || 'ease-out',
    });
  });
}

/* ══ Ajustes ═════════════════════════════════════════════════════════════════ */

function viewAjustes() {
  const st = S.settings;
  const imp = impresoraActual();

  paint(head({
    title: 'Ajustes',
    sub: 'Se guardan solos',
    actions: '<button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="set-refrescar"><i data-icon="retry"></i> Releer impresoras</button>',
  }) + `
    <div class="ox-scroll ox-grow" id="set-scroll">
      <div class="qr-ajustes">

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Impresora</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col qr-col-ancha">
            <div class="ox-field">
              <label class="ox-field__label">Predeterminada</label>
              <button class="ox-select" id="set-impresora">
                <span>${esc(S.impresora || 'Ninguna')}</span><i data-icon="chevronDown"></i>
              </button>
            </div>
            <div class="ox-field">
              <label class="ox-field__label">Papel por defecto</label>
              <button class="ox-select" id="set-papel">
                <span class="ox-select__value" id="set-papel-valor">${esc(papelPorDefecto())}</span><i data-icon="chevronDown"></i>
              </button>
              <span class="ox-field__hint">El que arranca elegido en Imprimir con cada documento nuevo.</span>
            </div>
            ${imp ? `
            <div class="ox-kv">
              <span class="ox-kv__k">Ambas caras</span>
              <span class="ox-kv__v">${imp.soportaDuplex ? 'Sí, la impresora lo informa' : 'No'}</span>
              <span class="ox-kv__k">Color</span>
              <span class="ox-kv__v">${imp.soloMonocromo ? 'Solo blanco y negro' : 'Color'}</span>
              <span class="ox-kv__k">Tamaños</span>
              <span class="ox-kv__v ox-num">${imp.tamanos?.length || 0}</span>
              <span class="ox-kv__k">Copias máx.</span>
              <span class="ox-kv__v ox-num">${imp.maxCopias ?? '—'}</span>
            </div>
            ${areaImprimibleHTML(imp)}` : '<span class="ox-meta">Todavía no se leyeron las capacidades.</span>'}
            <label class="ox-row qr-fila">
              <button class="ox-switch${st.duplexAsistido ? ' is-on' : ''}" id="set-duplex"></button>
              <span class="ox-col qr-apilado">
                <span class="ox-label">Dúplex asistido</span>
                <span class="ox-meta">Quire maneja las dos pasadas y te muestra cómo va el fajo de vuelta a la bandeja, en vez de dejárselo al driver.</span>
              </span>
            </label>
            <label class="ox-row qr-fila">
              <button class="ox-switch${st.mostrarNoImprimible ? ' is-on' : ''}" id="set-margen"></button>
              <span class="ox-col qr-apilado">
                <span class="ox-label">Marcar el área no imprimible</span>
                <span class="ox-meta">Dibuja en el preview el borde que el tóner no alcanza.</span>
              </span>
            </label>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Lectura</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col qr-col-ancha">
            <div class="ox-field">
              <label class="ox-field__label">Al abrir un documento</label>
              <div class="ox-segmented qr-angosto" id="set-zoom">
                ${[['ancho', 'Ajustar al ancho'], ['pagina', 'Página entera'], ['fijo', '100%']]
    .map(([id, label]) => `<button class="ox-segmented__opt${(st.modoZoomInicial || 'ancho') === id ? ' is-active' : ''}" data-value="${id}">${label}</button>`).join('')}
              </div>
            </div>
            <label class="ox-row qr-fila">
              <button class="ox-switch${st.reabrirUltimo ? ' is-on' : ''}" id="set-reabrir"></button>
              <span class="ox-col qr-apilado">
                <span class="ox-label">Reabrir los documentos que dejaste abiertos</span>
                <span class="ox-meta">Al arrancar, vuelven las pestañas como las dejaste, con la que estabas leyendo al frente.</span>
              </span>
            </label>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Actualizaciones</span></div>
          <div class="ox-card"><div class="ox-card__body ox-col qr-col-ancha">
            <div class="ox-row qr-fila">
              <button class="ox-btn ox-btn--secondary ox-flashable" id="set-buscar-update">
                <i data-icon="download"></i> Buscar ahora
              </button>
              <span class="ox-meta ox-grow" id="set-update-estado" data-fase="${esc(Actualizar.leer().fase || '')}">${resumenActualizacion()}</span>
            </div>
            <label class="ox-row qr-fila">
              <button class="ox-switch${st.avisarActualizaciones !== false ? ' is-on' : ''}" id="set-avisar"></button>
              <span class="ox-col qr-apilado">
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
      <div class="qr-remate"></div>
    </div>`);

  cablearAjustes();
}

/** En qué anda el actualizador, en una línea (HTML ya escapado). Bajando, el
    porcentaje va en un span propio: cambia veinte veces por segundo y se
    escribe en el lugar, sin relevar la frase (ver cablearAjustes). */
function resumenActualizacion() {
  const e = Actualizar.leer();
  switch (e.fase) {
    case 'buscando': return 'Buscando…';
    case 'al-dia': return 'Estás en la última versión.';
    case 'disponible': return `Hay una versión nueva: ${esc(e.version)}.`;
    case 'descargando': return `Bajando ${esc(e.version)}… <span class="ox-num qr-pct">${pctActualizacion(e)}%</span>`;
    case 'listo': return `${esc(e.version)} lista: reiniciá para instalarla.`;
    case 'error': return esc(e.error || 'La última búsqueda falló.');
    case 'sin-soporte': return esc(e.motivo || 'Esta copia no se actualiza sola.');
    default: return 'Todavía no se buscó.';
  }
}

const pctActualizacion = (e) => Math.round((e.progreso?.pct || 0) * 100);

/** El papel que arranca elegido en Imprimir, como lo nombra la lista. Es el
    que Imprimir va a usar DE VERDAD (planInicial: el guardado si la impresora
    lo tiene, si no el primero de su lista), no el nombre guardado a secas: con
    una impresora que no tiene ese tamaño el rótulo decía uno y se imprimía en
    otro (auditoría 2F). */
function papelPorDefecto() {
  const pedido = S.settings?.papelDefecto || 'A4';
  const papeles = papelesDisponibles();
  return (papeles.find((p) => p.nombre === pedido) || papeles[0])?.nombre || pedido;
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
  return `<div class="ox-col qr-col-chica">
      <span class="ox-eyebrow">Área imprimible real</span>
      <div class="ox-kv">${filas.join('')}</div>
      <span class="ox-meta">Lo que queda afuera de ese rectángulo no lo alcanza el tóner, por más que el PDF lo tenga.</span>
    </div>`;
}

function cablearAjustes() {
  const $ = (id) => document.getElementById(id);

  /* El switch se mueve en el acto, y si guardar falla vuelve atrás (con su
     misma transición): quedaba prendido aunque settings.json no hubiera
     cambiado, y al volver a Ajustes aparecía apagado (shell-19, ux-35). */
  const toggle = (id, clave) => $(id)?.addEventListener('click', async (e) => {
    const sw = e.currentTarget;
    const on = !sw.classList.contains('is-on');
    sw.classList.toggle('is-on', on);
    if (!(await guardar({ [clave]: on }))) sw.classList.toggle('is-on', !on);
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
  /* La línea del estado no se reescribe con textContent: cambiaba de golpe
     («Buscando…» → «Estás en la última versión.») (shell-18). Cada fase nueva
     es un relevo (frase); bajando, solo cambia el número en su span, en el
     lugar y sin destello: frase() destellaría veinte veces por segundo y la
     línea quedaría teñida de acento toda la descarga. */
  Router.onLeave(Actualizar.alCambiar((e) => {
    const el = $('set-update-estado');
    if (!el) return;
    if (e.fase === 'descargando' && el.dataset.fase === 'descargando') {
      const n = el.querySelector(':scope > .qr-pct');
      if (n) { n.textContent = `${pctActualizacion(e)}%`; return; }
    }
    el.dataset.fase = e.fase || '';
    frase(el, resumenActualizacion());
  }));

  /* Con bindSwitcher, como los demás segmentados: cableado a mano, la cápsula
     (que mide ::before con --seg-w) nunca se medía y quedaba en ancho 0, y la
     opción elegida solo se notaba por el color del texto (shell-16, fw-05). Si
     guardar falla, la elección vuelve a la de antes, como los switches. */
  const zoom = $('set-zoom');
  if (zoom) {
    let previo = S.settings.modoZoomInicial || 'ancho';
    const recolocar = bindSwitcher(zoom, async (v) => {
      if (await guardar({ modoZoomInicial: v })) { previo = v; return; }
      zoom.querySelectorAll('.ox-segmented__opt').forEach((o) => o.classList.toggle('is-active', o.dataset.value === previo));
      recolocar();
    });
  }

  /* Papel por defecto (ux-38): store.cjs lo declaraba y Imprimir lo usaba para
     arrancar cada plan, pero no había dónde cambiarlo. Los papeles son los de
     la impresora elegida, con la lista estándar si no contestó. */
  $('set-papel')?.addEventListener('click', (e) => {
    const actual = papelPorDefecto();
    Menu.show(e.currentTarget, papelesDisponibles().map((p) => ({
      label: p.nombre,
      icon: 'file',
      selected: p.nombre === actual,
      hint: `${fmtDec(p.ancho)} × ${fmtDec(p.alto)} mm`,
      onSelect: async () => {
        if (await guardar({ papelDefecto: p.nombre })) frase($('set-papel-valor'), esc(p.nombre));
      },
    })), { align: 'start' });
  });

  $('set-impresora')?.addEventListener('click', (e) => {
    /* El MISMO texto que Imprimir (ux-20), de la misma constante: qué hacer,
       no solo qué falta. Eran dos copias y ya decían distinto («… en
       Ajustes» de un lado y no del otro); acá también es cierto: el botón
       está arriba, a la derecha. */
    if (!S.impresoras.length) return Toast.error('No hay impresoras', SIN_IMPRESORAS);
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

  /* Releer tarda más de un segundo (las capacidades las pide el subsistema de
     Windows) y el botón no daba ninguna señal: se apretaba de nuevo, y cada
     click lanzaba otra lectura (shell-21). Mientras lee queda ocupado, con un
     relevo a «Leyendo…»; al terminar, la vista se repinta con lo leído (el
     botón vuelve nuevo) o, si falló, vuelve a lo de antes. */
  /* El html de reposo se toma UNA vez, al cablear. Tomado en cada click, si
     la lectura anterior había fallado enseguida y su relevo de vuelta todavía
     tenía el calco adentro, se llevaba el .ox-swap-out con él, y al volver
     swap lo reinsertaba como un nodo nuevo que ningún exit() iba a sacar
     (auditoría 2F). */
  const reposo = $('set-refrescar')?.innerHTML || '';
  $('set-refrescar')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    ocupar(b, true, `${Icons.spinner()}<span>Leyendo…</span>`);
    const leidas = await attempt(() => cargarImpresoras({ refrescar: true }), { errorTitle: 'No se pudieron leer las impresoras' });
    if (leidas) {
      Toast.show({
        title: 'Impresoras releídas',
        text: plural(leidas.length, 'impresora encontrada', 'impresoras encontradas'),
        icon: 'printer',
      });
    }
    // Si mientras leía te fuiste a otra vista, no se repinta la que estés mirando.
    if (leidas && Router.name === 'ajustes') { Router.refresh(); return; }
    if (b.isConnected) { b.disabled = false; ocupar(b, false, reposo); }
  });
}

/** Guarda un parche de ajustes. Devuelve lo guardado, o null si falló: quien
    llamó vuelve atrás lo que ya había movido en pantalla. */
async function guardar(patch) {
  const saved = await attempt(() => api.settings.save(patch), { errorTitle: 'No se pudieron guardar los ajustes' });
  if (saved) S.settings = saved;
  return saved;
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

Router.define({
  lector: { view: viewLector },
  paginas: { view: viewPaginas },
  imprimir: { view: viewImprimir },
  herramientas: { view: viewHerramientas },
  convertir: { view: viewConvertir },
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
  // El ícono se releva: con innerHTML pasaba de un cuadrado a dos de golpe (shell-41).
  w?.onMaximized((isMax) => {
    swap(maxBtn, Icons.svg(isMax ? 'winRestore' : 'winMax'), { relevo: true });
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.addEventListener('click', () => Router.go(b.dataset.view)));

  document.getElementById('btn-abrir')?.addEventListener('click', abrirConDialogo);

  /* La vista Convertir produce PDFs y quiere abrirlos, y los recientes del
     lector (abrirReciente) también, pero ninguno maneja pestañas: lo piden por
     acá y el shell lo abre como si lo hubieras elegido vos. */
  window.addEventListener('quire:abrir-ruta', (e) => {
    const ruta = e.detail?.ruta;
    if (ruta) abrirRuta(ruta);
  });
  /* El contador del rail sigue a la cola de conversión, que cambia sola. */
  window.addEventListener('quire:convertir-cola', () => actualizarChrome());

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
    /* Con un diálogo a la vista los atajos del shell no andan detrás del velo
       (auditoría 2F). Ctrl+W cerraba en silencio la pestaña cuyos cambios la
       pregunta de cierre estaba diciendo que se pierden, y Ctrl+O, Ctrl+Tab o
       Ctrl+1..4 cambiaban lo de atrás. Y el cierre de una pestaña con
       cambios abre su propio Modal, que pisaba la pregunta de cierre (ver
       confirmarCierreConCambios). Los del lector se cuidan solos (miran
       Modal.isOpen). */
    const velo = Modal.isOpen;

    /* Ctrl+W cierra UNA, la que estabas mirando (shell-02). La tecla sostenida
       manda repeticiones, y ninguna hace nada; pero se comen igual
       (preventDefault): cerrada la última pestaña, la repetición que sigue ya
       no tiene documento, y sin preventDefault le llegaba al Ctrl+W del menú
       por defecto de Electron (main.cjs no define menú), que cierra la
       VENTANA. Con un diálogo abierto, lo mismo. Un Ctrl+W suelto sin ningún
       documento sigue cerrando la ventana, como en cualquier navegador. */
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'w') {
      if (e.repeat || velo) { e.preventDefault(); return; }
      if (S.doc) { e.preventDefault(); cerrarDocumento(); }
      return;
    }

    /* Las pestañas van ANTES que atajosLector: Ctrl+Tab tiene que cambiar de
       documento aunque el foco esté en el visor. */
    if (!velo && atajosPestanas(e)) return;
    if (atajosLector(e)) return;
    if (velo) return;
    const enCampo = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.ctrlKey && e.key.toLowerCase() === 'o' && !enCampo) { e.preventDefault(); abrirConDialogo(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'p' && !enCampo && S.doc) { e.preventDefault(); Router.go('imprimir'); }
    /* Ctrl+Enter (imprimir estando en Imprimir, decisión de Fran: ux-31 e
       imprimir-31) NO va acá: lo atiende la vista Imprimir (imprimir.js),
       que primero confirma lo tipeado en Copias —el 'change' de un campo
       llega recién al salir— y mira Menu y Modal. Con los dos oyentes, este
       corría primero (se registra en el arranque) e imprimía con las copias
       viejas. */
  });

  Pestanas.cablear({ alAbrir: abrirConDialogo });

  /* La ventana ya canceló su cierre y está esperando. Se guarda la tinta de
     todas las pestañas y la sesión, y recién ahí se contesta.

     Antes, si Páginas tiene cambios sin guardar en alguna pestaña, se
     pregunta (ux-03, decisión de Fran): cerrar la app los tiraba sin avisar.
     Mientras se pregunta, el main no corre su reloj de 3 s (se lo dice
     preguntandoAntesDeCerrar); si se arrepiente, cancelarCierre() y la
     ventana sigue; si confirma, cierreDecidido() —el main vuelve a armar sus
     3 s: si guardar se cuelga, la ventana se cierra igual, como cuando no se
     pregunta nada— y se guarda y se cierra sin volver a preguntar.
     Si el usuario vuelve a apretar la cruz con la pregunta abierta, el main
     pregunta otra vez: se le contesta que seguimos preguntando, y la pregunta
     que ya está a la vista sigue siendo la única. Con la decisión tomada y
     guardando (cerrandoApp), otro aviso no hace nada: el guardado en curso
     contesta por los dos. Sin eso, la cruz apretada durante el guardado veía
     los mismos cambios y volvía a mostrar la pregunta encima de un cierre que
     terminaba enseguida.

     El `finally` es lo importante: si guardar explota, hay que contestar
     IGUAL. Callarse dejaría la ventana esperando hasta el timeout del main —
     tres segundos de app trabada al cerrar, por un error que ya está perdido. */
  let preguntandoCierre = false;
  let cerrandoApp = false;
  api?.win?.onAntesDeCerrar(async () => {
    if (cerrandoApp) return;
    if (preguntandoCierre) { api.win.preguntandoAntesDeCerrar?.(); return; }
    const pendientes = cambiosPendientes();
    // Ya se preguntó al pedir instalar la actualización (ver abajo).
    const yaDecidido = Date.now() < instalarDecididoHasta;
    if (pendientes.length && !yaDecidido && api.win.preguntandoAntesDeCerrar) {
      api.win.preguntandoAntesDeCerrar();
      preguntandoCierre = true;
      let seguir = false;
      try {
        seguir = await confirmarCierreConCambios(pendientes);
      } catch (err) {
        console.error('[cerrar] no se pudo preguntar:', err);
        seguir = true;               // ante la duda se cierra: no poder irse es peor
      } finally {
        preguntandoCierre = false;
      }
      if (!seguir) { api.win.cancelarCierre(); return; }
      api.win.cierreDecidido?.();
    }
    cerrandoApp = true;
    try {
      await Promise.all([guardarTodo(), recordarSesion()]);
    } catch (err) {
      console.error('[cerrar] no se pudo guardar todo:', err);
    } finally {
      api.win.listoParaCerrar();
      cerrandoApp = false;
    }
  });

  /* «Reiniciar e instalar» también cierra la app, y por un camino que el
     veto de arriba no frena bien: quitAndInstall (electron-updater) lanza el
     instalador ANTES de pedir el cierre, así que contestar Cancelar al cierre
     dejaba el instalador corriendo con Quire abierta, o la actualización
     colgada para el próximo cierre sin que nadie lo dijera (auditoría 2F).
     Por eso se pregunta acá, antes de llamar a instalar: si te arrepentís, no
     se lanza nada. Si confirmás, el cierre que llega enseguida no vuelve a
     preguntar. La decisión vence sola: si por algo la app no se cerró, el
     próximo cierre pregunta de nuevo. */
  let instalarDecididoHasta = 0;
  Actualizar.antesDeInstalar(async () => {
    const pendientes = cambiosPendientes();
    if (!pendientes.length) return true;
    const seguir = await confirmarCierreConCambios(pendientes, { instalar: true });
    if (seguir) instalarDecididoHasta = Date.now() + 15000;
    return seguir;
  });

  cablearArrastre();
}

/* describirCambios y las palabras de la pregunta vienen de paginas.js: la
   guardia de cerrar una pestaña y la de cerrar la app dicen lo mismo con las
   mismas palabras (había dos copias que ya decían distinto, paquete 4A). */

/** Las pestañas con cambios de Páginas sin guardar, con lo que tiene cada una. */
const cambiosPendientes = () => S.pestanas.map((p) => ({ p, c: cambiosDePaginas(p) })).filter((x) => x.c);

/**
 * Pregunta antes de cerrar la app con cambios de Páginas sin guardar: en qué
 * documento y cuántas páginas se quitaron o giraron. El foco arranca en
 * Cancelar, como en toda confirmación destructiva: un Enter por reflejo no
 * tira el trabajo. Resuelve true si hay que cerrar igual. Con `instalar`, lo
 * que cierra es «Reiniciar e instalar», y la pregunta lo dice.
 *
 * Si otro Modal ocupa el lugar mientras se pregunta (un Modal.show que llega
 * por su cuenta: el «volvé a cargar el fajo» del dúplex asistido, la guardia
 * de una pestaña), cuenta como Cancelar: Modal.show pisa al que está abierto
 * y le contesta null. Antes no le contestaba, y esta promesa no resolvía
 * nunca: preguntandoCierre quedaba prendido y cada cruz contestaba «sigo
 * preguntando», una ventana que no se podía cerrar (auditoría 2F). Acá se
 * vigilaba la capa de overlays hasta que Onyx lo resolvió (auditoría 4B).
 * Un diálogo que ya estaba abierto (un rango a medio escribir) se pisa igual:
 * cerrar la app es lo que se pidió, y el velo pasa de uno al otro sin
 * oscurecerse (con un Modal.close antes se apilaban dos velos).
 */
async function confirmarCierreConCambios(lista, { instalar = false } = {}) {
  const nombre = (p) => p.doc?.nombre || 'documento.pdf';
  const uno = lista.length === 1;
  const porQue = instalar ? 'Para instalar la actualización Quire se cierra, y' : 'Si cerrás Quire,';
  const r = await Modal.show({
    title: PREGUNTA_CAMBIOS.titulo,
    sub: uno
      ? PREGUNTA_CAMBIOS.frase(nombre(lista[0].p), lista[0].c, porQue)
      : `${porQue} se pierden los de estos documentos:`,
    body: uno ? '' : `<ul class="qr-cierre-lista">${lista.map(({ p, c }) => `
      <li><span class="ox-label">${esc(nombre(p))}</span><span class="ox-meta">${esc(describirCambios(c))}</span></li>`).join('')}
    </ul>`,
    actions: [
      { label: 'Cancelar', value: false, autofocus: true },
      { label: instalar ? 'Instalar sin guardar' : PREGUNTA_CAMBIOS.boton, value: true, variant: 'danger-solid' },
    ],
  });
  return r === true;
}

/**
 * Ctrl+Tab para pasar al de al lado, Ctrl+1..4 para ir a uno derecho.
 * Devuelve true si se comió la tecla.
 *
 * Ctrl+Tab no se puede dejar pasar ni cuando hay un solo documento: el default
 * de Chromium mueve el foco por la página, y en una app de escritorio eso se
 * ve como que el anillo del teclado salta a cualquier lado sin razón.
 */
function atajosPestanas(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;

  if (e.key === 'Tab') {
    e.preventDefault();
    activarRelativa(e.shiftKey ? -1 : 1);
    return true;
  }

  /* Ctrl+Shift+RePág / AvPág corre la activa un lugar, como en cualquier
     navegador: es el mismo reordenar que arrastrar una pestaña, para quien
     no suelta el teclado. */
  if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault();
    const p = S.pestana;
    if (p) mover(p.id, S.pestanas.indexOf(p) + (e.key === 'PageUp' ? -1 : 1));
    return true;
  }

  /* Los dígitos van por `e.code` y no por `e.key`: en un teclado latino el
     pavé numérico y la fila de arriba mandan el mismo carácter, pero con Ctrl
     apretado algunos layouts cambian `key` por el símbolo de la tecla. */
  const digito = /^(Digit|Numpad)([1-9])$/.exec(e.code);
  if (digito) {
    const n = Number(digito[2]);
    if (n > MAX_PESTANAS) return false;
    e.preventDefault();
    const p = S.pestanas[n - 1];
    if (p) activar(p.id);
    return true;
  }

  return false;
}

async function cerrarDocumento() {
  await cerrar();
  /* Al lector solo si no quedó ninguno: cerrar una pestaña estando en Imprimir
     te deja en Imprimir, con el documento que pasó a estar activo. Sacarte de
     la vista que elegiste sería tratar el cierre como si fuera un cambio de
     tarea, y no lo es. */
  if (!S.doc) Router.go('lector');
}

/* Una frase de la statusbar que cambia (el nombre del documento, la
   impresora): relevo adentro (frase) y el ancho del ítem viajando, así lo que
   tiene a la derecha no salta (shell-23). Si el ítem está escondido no se ve:
   se escribe en el lugar y el plegable lo despliega ya con lo nuevo. Con la
   misma frase no hace nada, ni mide. */
function fraseEnFila(item, el, html) {
  if (!el || el.__frase === html) return;
  if (item && !item.hidden) deslizarAncho(item, () => frase(el, html));
  else frase(el, html);
}

/** Todo lo que vive fuera de la vista: statusbar, contadores del rail, contexto. */
function actualizarChrome() {
  const $ = (id) => document.getElementById(id);

  fraseEnFila($('stat-doc'), $('stat-doc-name'), esc(S.doc ? S.doc.nombre : 'Ningún documento'));

  /* La ruta completa se veía al pasar por el pie del rail, que ya no dice nada.
     Se muda acá, que es donde quedó el nombre del documento. */
  const statDoc = $('stat-doc');
  if (statDoc) statDoc.dataset.tip = S.doc ? (S.doc.ruta || S.doc.nombre) : 'Documento abierto';

  contador($('nav-paginas-count'), S.doc ? S.doc.paginas : 0);
  contador($('nav-convertir-count'), convertiblesPendientes());

  /* La página y la medida las escribe el lector mientras scrolleás. Fuera del
     lector nadie las ponía al día: con Ctrl+Tab en Imprimir la statusbar
     seguía diciendo la página y el tamaño del otro documento (shell-24). Se
     escriben desde S, que es por pestaña, con las mismas piezas que el
     lector: la página en el lugar y sin destello (cambia en cada hoja), la
     medida con frase(). Es lo mismo que escribe él, así que dos escrituras no
     hacen nada. Adentro del lector es SUYA: escribir acá también desfasaría
     la memoria de frase() mientras él escribe por su cuenta. */
  if (S.doc && Router.name !== 'lector') {
    swap($('stat-pagina-value'), `${S.pagina} / ${S.doc.paginas}`);
    const g = S.geometrias[S.pagina - 1];
    if (g) fraseEnFila($('stat-medida'), $('stat-medida-value'), esc(g.etiqueta));
  }
  for (const id of ['stat-pagina', 'stat-medida']) {
    const el = $(id);
    if (el) el.hidden = !S.doc;
  }

  /* Sin impresora el ítem se esconde y no se escribe nada: un «—» como valor
     de relleno haría que el primer nombre real cuente como un cambio
     (shell-39, css-27). */
  const imp = $('stat-impresora');
  if (imp) {
    if (S.impresora) fraseEnFila(imp, $('stat-impresora-value'), esc(S.impresora));
    imp.hidden = !S.impresora;
  }

  /* El pie del rail queda vacío A PROPÓSITO: decía el nombre del documento, que
     es exactamente lo que dice la statusbar tres píxeles más abajo. Dos filas
     apiladas con el mismo dato se leen como un error de maquetado, no como dos
     datos. Sin texto y sin la línea de arriba (ver quire.css), el rail baja
     entero de un color solo. El div sigue existiendo porque le marca el piso al
     rail y porque alinea con la barra del preview — ver --qr-pie. */

  /* El nombre del documento en el titlebar solo mientras NO haya franja. Con
     las pestañas a la vista lo estaría diciendo tres veces en veinte píxeles
     —pestaña, titlebar, statusbar— y eso ya no se lee como tres datos sino
     como un error de maquetado. Es la misma razón por la que el pie del rail
     quedó vacío.

     Con swap() y relevo (shell-26, fw-09): aparece, se va (al abrir el
     segundo, mientras la franja se despliega) o cambia de nombre fundiéndose.
     Era un innerHTML en cada aviso —también en cada trazo de tinta— que
     reemplazaba los nodos aunque dijeran lo mismo; con el mismo html, swap()
     no toca nada. */
  swap($('titlebar-context'), S.doc && S.pestanas.length < 2
    ? `${Icons.svg('quire', 'ox-icon--sm')}<span>${esc(S.doc.nombre)}</span>`
    : '', { relevo: true });
}

/* ── «Abriendo…» ─────────────────────────────────────────────────────────────
   Abrir un PDF pesado (leerlo, geometrías, esquema, tinta) puede tardar
   segundos, y nada lo decía: el botón no cambiaba y la app parecía no haber
   hecho nada (shell-05, ux-10). Mientras haya algo abriéndose, el botón Abrir
   y el «+» de la franja hacen un relevo a un spinner. Recién pasados 150 ms:
   un PDF chico abre en menos y el botón parpadearía «Abriendo…» por nada.

   «Abriéndose» es la suma de dos cosas: S.cargando (estado.js, lo que va de
   abrir() para adentro) y enFila (las tandas de acá, que cuentan desde ANTES
   de leer el archivo). Solo con S.cargando, la lectura —traer el archivo
   entero por IPC, que suele ser lo más lento— no contaba: una tanda de tres
   con 450 ms de lectura cada uno decía «Abrir» todo el tiempo; y si lo que
   tardaba era parsear, el botón iba y venía entre un documento y el otro.
   Con enFila hay un relevo de ida y uno de vuelta por tanda.

   El reloj de los 150 ms no se reinicia con cada aviso: en una tanda de PDF
   chicos los avisos llegan más seguido que eso y el botón no cambiaría
   nunca, por más que la tanda entera tarde segundos. */
const ESPERA_OCUPADO = 150;
let ocupado = false;
let relojOcupado = 0;
let abrirNormal = '';
let masNormal = '';

const abriendose = () => S.cargando > 0 || enFila > 0;

function seguirCargando() {
  if (abriendose()) {
    if (!ocupado && !relojOcupado) {
      relojOcupado = setTimeout(() => { relojOcupado = 0; ponerOcupado(true); }, ESPERA_OCUPADO);
    }
    return;
  }
  clearTimeout(relojOcupado);
  relojOcupado = 0;
  if (ocupado) ponerOcupado(false);
}

function ponerOcupado(on) {
  if (on && !abriendose()) return;
  ocupado = on;
  const btn = document.getElementById('btn-abrir');
  const mas = document.getElementById('qr-tab-mas');
  if (btn) {
    swap(btn, on ? `${Icons.spinner()}<span>Abriendo…</span>` : abrirNormal, { relevo: true });
    btn.setAttribute('aria-busy', String(on));
  }
  if (mas) swap(mas, on ? Icons.spinner() : masNormal, { relevo: true });
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
  initClickFlash();
  initScrollFades();
  cablearShell();
  sincronizarColorVentana();

  try {
    const [info, settings] = await Promise.all([api.info(), api.settings.get()]);
    S.info = info;
    S.settings = settings;
    /* Acá NO va `S.modoZoom = …`: S.modoZoom es de la pestaña activa y todavía
       no hay ninguna, así que escribirlo no haría nada. El zoom de arranque lo
       lee cada pestaña al nacer, de S.settings — ver nuevaPestana(). */
  } catch (err) {
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  /* Piezas es la vitrina del framework, no una función de Quire: en el rail
     solo con --dev o QUIRE_DEV (ux-39, decisión de Fran). La ruta sigue
     existiendo. Se decide antes de que se vaya el splash: no hay un cuadro
     con el ítem y otro sin él. */
  const piezas = document.getElementById('nav-piezas');
  if (piezas) piezas.hidden = !S.info?.dev;

  /* Cómo están los botones de abrir cuando no están ocupados, para volver. */
  abrirNormal = document.getElementById('btn-abrir')?.innerHTML || '';
  masNormal = Icons.svg('plus');

  actualizarChrome();
  alCambiar(actualizarChrome);
  alCambiar((que) => { if (que === 'cargando') seguirCargando(); });
  Router.onChange(actualizarChrome);

  /* Todo lo que depende de QUÉ hay abierto cuelga de un solo aviso, y por eso
     da igual quién abrió o cerró: el diálogo, un arrastre, la cruz de una
     pestaña o el doble click en el explorador pasan todos por acá. */
  alCambiar((que) => {
    if (que !== 'pestanas') return;
    recordarSesion();
  });

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

  /* Qué documentos se cargan al arrancar. Los del doble click GANAN: si
     abriste PDFs desde el explorador querés esos, no los de ayer — y encima
     los de ayer tardarían lo mismo en cargar para después quedar de fondo.
     Son TODOS, en orden: con varios elegidos y Enter, Windows lanza un
     proceso por archivo y se abría solo el último que llegaba (main-02). */
  const pedidos = await api.docs.pendientes().catch(() => []);

  if (pedidos?.length) abrirVarias(pedidos);
  else if (S.settings.reabrirUltimo) encolar(restaurarSesion);   // en la fila: un doble click que llegue mientras tanto espera su turno

  /* Con Quire ya abierta, otro doble click no levanta una segunda ventana: el
     proceso nuevo le pasa la ruta a este y se muere (ver main.cjs). */
  api.docs.onAbrir((ruta) => { abrirRuta(ruta); });

  Actualizar.iniciar({ avisar: S.settings.avisarActualizaciones !== false })
    .catch((err) => console.error('[actualizar]', err.message));
}

boot();
