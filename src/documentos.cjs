'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — documentos
   Abrir, leer y guardar PDFs. Vive en el main porque el renderer no tiene fs.

   Los bytes viajan por IPC en vez de que el renderer cargue el archivo por
   file:// a mano, y eso es a propósito: la página del renderer es un origen
   file:// distinto al del PDF, así que Chromium le bloquearía el fetch. Además
   así cada archivo que entra pasa por un solo lugar donde se lo puede validar.
   ═══════════════════════════════════════════════════════════════════════════ */

const { dialog, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const store = require('./store.cjs');
const { EXT_IMAGEN, formatoDe } = require('./firmas.cjs');

/* Un PDF arriba de esto casi seguro no es lo que el usuario cree que es, y
   mandarlo por IPC congelaría la app mientras se clona. */
const MAX_BYTES = 512 * 1024 * 1024;

const FILTROS = [
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Todos los archivos', extensions: ['*'] },
];

/* Para combinar, donde una imagen vale por una página. El primer filtro es el
   que arranca elegido, así que va el que sirve para las dos cosas a la vez. */
const FILTROS_CON_IMAGENES = [
  { name: 'PDF e imágenes', extensions: ['pdf', ...EXT_IMAGEN] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Imágenes', extensions: EXT_IMAGEN },
  { name: 'Todos los archivos', extensions: ['*'] },
];

const recientes = store.doc('recientes', { lista: [] });

/**
 * Lee un archivo del disco y lo deja listo para mandar por IPC.
 *
 * `imagenes` es la puerta para PNG/JPEG/WEBP, y solo la abre Combinar. El
 * lector sigue aceptando PDF y nada más: abrir una imagen "como documento"
 * sería otra función y no es esta.
 */
async function leer(ruta, { imagenes = false } = {}) {
  if (typeof ruta !== 'string' || !ruta) throw new Error('Ruta inválida');

  const stat = await fs.stat(ruta);
  if (!stat.isFile()) throw new Error('No es un archivo');
  if (stat.size > MAX_BYTES) {
    throw new Error(`El archivo pesa ${(stat.size / 1048576).toFixed(0)} MB; el límite es ${MAX_BYTES / 1048576} MB`);
  }

  const buf = await fs.readFile(ruta);
  const formato = formatoDe(buf);

  if (!imagenes && formato !== 'pdf') {
    throw new Error('El archivo no empieza con %PDF — no es un PDF válido');
  }
  if (!formato) {
    throw new Error('No se reconoce el archivo: no es un PDF ni una imagen PNG, JPEG o WEBP');
  }

  /* Los recientes son documentos, no piezas sueltas. Una imagen que se sumó a
     un combinado no es algo a lo que uno quiera "volver". */
  if (formato === 'pdf') await anotarReciente(ruta, stat);

  return {
    ruta,
    nombre: path.basename(ruta),
    carpeta: path.dirname(ruta),
    bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    tamano: stat.size,
    modificado: stat.mtimeMs,
    formato,
    tipo: formato === 'pdf' ? 'pdf' : 'imagen',
  };
}

async function elegir() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir PDF',
    filters: FILTROS,
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return leer(r.filePaths[0]);
}

/** Varios de una: para combinar. Acá sí entran imágenes. */
async function elegirVarios() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir PDFs o imágenes',
    filters: FILTROS_CON_IMAGENES,
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map((p) => leer(p, { imagenes: true })));
}

/**
 * Guardar bytes con diálogo. `defecto` es el nombre sugerido, no una ruta:
 * la carpeta la decide el diálogo, que recuerda la última que usó el usuario.
 */
async function guardarComo(bytes, defecto, filtros = FILTROS) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar como',
    defaultPath: defecto,
    filters: filtros,
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(bytes));
  return { ruta: r.filePath, nombre: path.basename(r.filePath) };
}

/** Carpeta de destino, para exportar muchos archivos de una. */
async function elegirCarpeta() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir carpeta de destino',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}

/** Escribe directo, sin diálogo. Para exportar en lote a una carpeta ya elegida. */
async function escribir(carpeta, nombre, bytes) {
  // El nombre lo arma el renderer; sin esto, un "../" escribiría fuera de la
  // carpeta que el usuario eligió.
  const limpio = path.basename(String(nombre));
  if (!limpio || limpio === '.' || limpio === '..') throw new Error('Nombre de archivo inválido');
  const destino = path.join(carpeta, limpio);
  if (path.dirname(path.resolve(destino)) !== path.resolve(carpeta)) {
    throw new Error('El destino se sale de la carpeta elegida');
  }
  await fs.writeFile(destino, Buffer.from(bytes));
  return destino;
}

/* ── Recientes ──────────────────────────────────────────────────────────────
   Se guarda la ruta, no el contenido. Al abrir se revalida: un reciente que
   ya no existe se muestra apagado en vez de reventar al hacer click. */

const MAX_RECIENTES = 12;

async function anotarReciente(ruta, stat) {
  const actual = await recientes.read().catch(() => ({ lista: [] }));
  const lista = [
    { ruta, nombre: path.basename(ruta), tamano: stat.size, abierto: Date.now() },
    ...(actual.lista || []).filter((r) => r.ruta !== ruta),
  ].slice(0, MAX_RECIENTES);
  await recientes.write({ lista }).catch(() => {});
}

async function listarRecientes() {
  const { lista = [] } = await recientes.read().catch(() => ({ lista: [] }));
  return Promise.all(lista.map(async (r) => ({
    ...r,
    existe: await fs.access(r.ruta).then(() => true).catch(() => false),
  })));
}

async function olvidarRecientes() {
  await recientes.write({ lista: [] });
  return true;
}

/* ── El documento con el que te abrieron ────────────────────────────────────
   Viene de la línea de comandos (ver argv.cjs) y hay que hacérselo llegar al
   renderer. El arranque en frío se resuelve al revés de lo que parece: no se
   le manda la ruta al renderer —que todavía no existe, o existe pero no
   terminó de montar sus vistas— sino que se la deja acá y él la viene a buscar
   cuando está listo. Empujar es una carrera; que lo vengan a buscar, no.

   Con la app ya abierta no hay carrera y main.cjs la manda por evento. Por eso
   hace falta saber si el renderer ya pasó a reclamar: hasta que no pasó, todo
   se encola. */

let pendiente = null;
let reclamado = false;

function encolar(ruta) { pendiente = ruta || null; }

/** Se entrega UNA sola vez: un F5 del renderer no reabre lo de hace media hora. */
function tomarPendiente() {
  reclamado = true;
  const r = pendiente;
  pendiente = null;
  return r;
}

const yaReclamo = () => reclamado;

module.exports = {
  leer,
  elegir,
  elegirVarios,
  guardarComo,
  elegirCarpeta,
  escribir,
  listarRecientes,
  olvidarRecientes,
  encolar,
  tomarPendiente,
  yaReclamo,
  MAX_BYTES,
};
