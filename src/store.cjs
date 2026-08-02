'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — almacenamiento
   JSON atómico sobre el disco. Nada de base de datos: los datos son archivos
   legibles que se pueden abrir con un editor, versionar en git y arreglar a
   mano cuando algo sale mal.

   Viven en el directorio del proyecto (`data/`), no en AppData: así se ven, no
   dependen de dónde quedó instalada la app, y no te los virtualiza nadie.
   `ONYX_DATA` lo puede mover.

   ── Por qué este archivo es más largo de lo que parece que debería ──────────
   Escribir JSON "bien" tiene tres trampas que solo aparecen con uso real, y
   las tres cuestan datos perdidos. Este módulo existe para que no te pasen:

     1. Escritura no atómica → un corte a mitad deja el archivo truncado.
        Se escribe un `.tmp`, se fuerza el flush a disco, y recién ahí se
        renombra encima. El rename es atómico a nivel de sistema de archivos.

     2. `.tmp` de nombre fijo → dos guardados solapados usan el MISMO temporal;
        el primero en renombrar se lo lleva y el segundo muere con ENOENT.
        Esa escritura se pierde en silencio. Se resuelve con nombre único
        + una cola por archivo.

     3. Windows: el rename falla con EPERM/EBUSY si el destino está tomado en
        ese instante (antivirus, otro proceso leyendo, otra instancia). Son
        bloqueos de milisegundos: se reintenta con backoff.
   ═══════════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const path = require('path');

/* Electron solo existe cuando la app corre de verdad; los tests cargan este
   módulo con Node pelado. El require va defensivo por eso. */
let electronApp = null;
try { electronApp = require('electron').app; } catch { /* fuera de Electron */ }

/**
 * Dónde viven los datos.
 *
 * En desarrollo, `data/` al lado del proyecto: se ven, se abren con un editor
 * y se versionan si querés. Esa es la gracia del diseño de Onyx.
 *
 * EMPAQUETADA no puede ser ahí. Con asar, __dirname apunta adentro del
 * `app.asar`, que es de SOLO LECTURA: la app arrancaría y no podría guardar ni
 * un ajuste, fallando en cada escritura. Ahí van a userData, que es el lugar
 * que el sistema le da a cada app para eso.
 *
 * `QUIRE_DATA` gana siempre, y es lo que usan los tests.
 */
const ROOT = process.env.QUIRE_DATA
  || (electronApp?.isPackaged
    ? path.join(electronApp.getPath('userData'), 'data')
    : path.join(__dirname, '..', 'data'));

const SETTINGS_FILE = path.join(ROOT, 'settings.json');

/* ── Ajustes de tu app ───────────────────────────────────────────────────────
   Editá esto: es el único lugar donde se declara qué guarda tu app. Lo que
   agregues acá aparece solo en instalaciones viejas gracias a withDefaults. */
const SCHEMA = 1;

const DEFAULT_SETTINGS = {
  schema: SCHEMA,

  /* Lectura */
  modoZoomInicial: 'ancho',       // 'ancho' | 'pagina' | 'fijo'
  reabrirUltimo: true,

  /* Actualizaciones. Buscar no baja nada: la descarga la pide el usuario. */
  avisarActualizaciones: true,

  /* Impresión */
  impresora: null,                // nombre exacto de la última usada
  papelDefecto: 'A4',
  /* Dibujar el borde que el tóner no alcanza. Es el dato que ningún visor
     muestra y la razón de la mitad de los recortes al imprimir. */
  mostrarNoImprimible: true,
  /* Manejar nosotros las dos pasadas del dúplex en vez de delegarlo al driver:
     más predecible, y permite mostrar de qué lado va el fajo al darlo vuelta. */
  duplexAsistido: true,

  ultimoDocumento: null,
};

/** Migraciones: cada función lleva el archivo de la versión N a la N+1.
    Se ejecutan en cadena, así que un archivo de v0 llega a la actual solo. */
const MIGRATIONS = {
  // 0: (data) => ({ ...data, campoNuevo: valorDerivado(data), schema: 1 }),
};

/* ── Primitivas ──────────────────────────────────────────────────────────── */

async function ensureDirs(...extra) {
  await fsp.mkdir(ROOT, { recursive: true });
  for (const d of extra) await fsp.mkdir(path.join(ROOT, d), { recursive: true });
}

async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Un JSON corrupto no puede hacer desaparecer los datos en silencio: se
    // aparta con marca de tiempo (queda para recuperar a mano) y se sigue.
    if (err instanceof SyntaxError) {
      const dead = `${file}.corrupto-${Date.now()}`;
      await fsp.rename(file, dead).catch(() => {});
      console.error(`[store] ${path.basename(file)} ilegible → ${path.basename(dead)}`);
      return fallback;
    }
    throw err;
  }
}

/* Cola de escritura por archivo. Dos guardados del mismo destino no pueden
   correr a la vez (trampa 2 del encabezado). Serializar además hace
   determinista quién queda último, que es lo que uno asume sin pensarlo. */
const writeQueues = new Map();
let tmpCounter = 0;

function writeJSON(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeJSONNow(file, data));
  writeQueues.set(file, next);
  // Limpiar la cola cuando se vacía, para no acumular una entrada por archivo.
  next.catch(() => {}).finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  });
  return next;
}

async function writeJSONNow(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Temporal único: aunque algo se cuele en paralelo, nadie pisa el .tmp ajeno.
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  const text = JSON.stringify(data, null, 2);

  // El flush explícito es lo que hace la promesa atómica de verdad: sin él, el
  // rename puede llegar al disco antes que el contenido.
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renameWithRetry(tmp, file);
}

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(tmp, file, intentos = 5) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (i >= intentos - 1 || !TRANSIENT.has(err.code)) {
        await fsp.unlink(tmp).catch(() => {});   // no dejar basura si no hay vuelta
        throw err;
      }
      await new Promise((r) => setTimeout(r, 30 * 2 ** i));   // 30, 60, 120, 240 ms
    }
  }
}

/* ── Identificadores ─────────────────────────────────────────────────────────
   Un id viaja desde el renderer y termina siendo un nombre de archivo. Sin
   esta validación, un id con "../" escribe donde quiera. No la saques. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function assertId(id) {
  if (!SAFE_ID.test(String(id))) throw new Error(`id inválido: ${id}`);
  return String(id);
}

/* ── Ajustes ─────────────────────────────────────────────────────────────── */

function migrate(data) {
  let out = data;
  let v = out.schema ?? 0;
  while (v < SCHEMA) {
    const step = MIGRATIONS[v];
    if (!step) break;
    out = step(out);
    v = out.schema ?? v + 1;
  }
  return out;
}

/** Completa claves nuevas sin pisar lo que el usuario ya configuró. */
function withDefaults(cfg) {
  return { ...DEFAULT_SETTINGS, ...cfg, schema: SCHEMA };
}

async function loadSettings() {
  await ensureDirs();
  const raw = await readJSON(SETTINGS_FILE, null);
  if (!raw) {
    await writeJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
  return withDefaults(migrate(raw));
}

/** Guarda un parche: solo las claves que mandás, el resto queda como estaba. */
async function saveSettings(patch) {
  const merged = withDefaults({ ...(await loadSettings()), ...patch });
  await writeJSON(SETTINGS_FILE, merged);
  return merged;
}

/* ── Documento suelto ────────────────────────────────────────────────────────
   Para lo que es uno solo: un borrador, un caché, el último estado de la UI. */
function doc(name, fallback = null) {
  const file = path.join(ROOT, `${assertId(name)}.json`);
  return {
    file,
    read: () => readJSON(file, fallback),
    write: (data) => writeJSON(file, data),
    remove: () => fsp.unlink(file).catch(() => {}),
  };
}

/* ── Colección ───────────────────────────────────────────────────────────────
   Una carpeta con un archivo por ítem. Es el patrón que sirve para el 90% de
   lo que guarda una app de escritorio: notas, proyectos, perfiles, presets.
   Un archivo por ítem (y no un array gigante) significa que guardar uno no
   reescribe los otros, y que borrar a mano es borrar un archivo. */
function collection(name) {
  const dir = path.join(ROOT, assertId(name));
  const fileOf = (id) => path.join(dir, `${assertId(id)}.json`);

  return {
    dir,

    async list() {
      await fsp.mkdir(dir, { recursive: true });
      const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
      const out = [];
      for (const f of files) {
        const item = await readJSON(path.join(dir, f), null);
        if (item?.id) out.push(item);
      }
      return out;
    },

    get: (id) => readJSON(fileOf(id), null),

    async save(item) {
      if (!item?.id) throw new Error('El ítem no tiene id.');
      await writeJSON(fileOf(item.id), item);
      return item;
    },

    remove: (id) => fsp.unlink(fileOf(id)).catch(() => {}),

    /** Id incremental legible (n-0001), derivado de lo que ya hay en disco. */
    async nextId(prefix = 'n') {
      const items = await this.list();
      const max = items.reduce((m, it) => {
        const n = Number(String(it.id).replace(new RegExp(`^${prefix}-`), ''));
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      return `${prefix}-${String(max + 1).padStart(4, '0')}`;
    },
  };
}

module.exports = {
  ROOT, SETTINGS_FILE, SCHEMA, DEFAULT_SETTINGS,
  ensureDirs, readJSON, writeJSON, assertId,
  loadSettings, saveSettings,
  doc, collection,
};
