'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — puente IPC
   El renderer no tiene fs, ni require, ni red: `contextIsolation` está activo.
   Todo lo que necesite del sistema pasa por acá, y acá se decide qué se puede
   pedir. Es la superficie de ataque de la app: todo lo que agregues es una
   puerta más.

   Convención: cada handler devuelve {ok:true, data} o {ok:false, error}. El
   preload la desenvuelve y convierte el error en una excepción real, así el
   renderer escribe try/catch normal en vez de chequear banderas.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app } = require('electron');
const store = require('./store.cjs');
const documentos = require('./documentos.cjs');
const impresion = require('./impresion.cjs');

/* Las colecciones que el renderer puede tocar. Es una lista blanca a
   propósito: sin ella, cualquier bug en el renderer puede crear carpetas
   sueltas en tu directorio de datos. Agregá las tuyas acá.

   `tinta` guarda un archivo por documento anotado: los trazos del lápiz, en
   coordenadas de página. El PDF original nunca se toca. */
const COLLECTIONS = ['tinta', 'perfiles'];

function coll(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`colección no permitida: ${name}`);
  return store.collection(name);
}

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function register() {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    electron: process.versions.electron,
  }));

  handle('settings:get', () => store.loadSettings());
  handle('settings:save', (patch) => store.saveSettings(patch));

  handle('doc:read', (name, fallback = null) => store.doc(name, fallback).read());
  handle('doc:write', (name, data) => store.doc(name).write(data).then(() => true));

  handle('col:list', (name) => coll(name).list());
  handle('col:get', (name, id) => coll(name).get(id));
  handle('col:save', (name, item) => coll(name).save(item));
  handle('col:remove', (name, id) => coll(name).remove(id).then(() => true));
  handle('col:next-id', (name, prefix) => coll(name).nextId(prefix));

  /* ── Documentos ─────────────────────────────────────────────────────────
     Los bytes de los PDFs viajan por acá en los dos sentidos. Son buffers
     grandes: el structured clone de Electron los pasa sin serializarlos a
     texto, pero igual conviene no pedirlos dos veces por gusto. */
  handle('docs:elegir', () => documentos.elegir());
  handle('docs:elegir-varios', () => documentos.elegirVarios());
  handle('docs:leer', (ruta) => documentos.leer(ruta));
  handle('docs:guardar-como', (bytes, nombre, filtros) => documentos.guardarComo(bytes, nombre, filtros));
  handle('docs:elegir-carpeta', () => documentos.elegirCarpeta());
  handle('docs:escribir', (carpeta, nombre, bytes) => documentos.escribir(carpeta, nombre, bytes));
  handle('docs:recientes', () => documentos.listarRecientes());
  handle('docs:olvidar-recientes', () => documentos.olvidarRecientes());

  /* ── Impresión ──────────────────────────────────────────────────────────
     El PDF que entra por 'print:imprimir' ya viene impuesto: este puente no
     lo transforma. Ver el encabezado de impresion.cjs. */
  handle('print:listar', () => impresion.listar());
  handle('print:capacidades', (opts) => impresion.capacidades(opts));
  handle('print:imprimir', (bytes, opciones) => impresion.imprimir(bytes, opciones));
}

module.exports = { register, COLLECTIONS };
