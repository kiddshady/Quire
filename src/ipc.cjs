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
const actualizador = require('./actualizador.cjs');
const conversion = require('./conversion.cjs');
const presentacion = require('./presentacion.cjs');

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

/** Envuelve un handler para que un throw viaje como error y no como crash.
    Con `conEvento`, el handler recibe primero el evento (para saber de qué
    ventana vino el pedido). */
function handle(channel, fn, conEvento = false) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(...(conEvento ? [e, ...args] : args)) };
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
    /* Modo desarrollo: `npm run dev` (--dev) o QUIRE_DEV en el entorno. Lo
       pide el renderer para mostrar lo que es del framework y no de Quire,
       como la vitrina de Piezas en el rail (ux-39). */
    dev: process.argv.includes('--dev') || !!process.env.QUIRE_DEV,
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
  handle('docs:elegir', (opciones) => documentos.elegir(opciones));
  handle('docs:elegir-varios', (opciones) => documentos.elegirVarios(opciones));
  handle('docs:leer', (ruta, opciones) => documentos.leer(ruta, opciones));
  handle('docs:guardar-como', (bytes, nombre, filtros) => documentos.guardarComo(bytes, nombre, filtros));
  handle('docs:elegir-carpeta', () => documentos.elegirCarpeta());
  handle('docs:escribir', (carpeta, nombre, bytes, opciones) => documentos.escribir(carpeta, nombre, bytes, opciones));
  handle('docs:recientes', () => documentos.listarRecientes());
  handle('docs:olvidar-recientes', () => documentos.olvidarRecientes());
  /* Los PDFs con los que te abrieron por doble click. El renderer los reclama
     al terminar de arrancar. 'docs:pendientes' devuelve la lista entera, en
     orden (main-02); 'docs:pendiente' queda para el renderer que abre uno
     solo, y devuelve el primero o null si arrancaste la app a secas. */
  handle('docs:pendientes', () => documentos.tomarPendientes());
  handle('docs:pendiente', () => documentos.tomarPendiente());

  /* ── Impresión ──────────────────────────────────────────────────────────
     El PDF que entra por 'print:imprimir' ya viene impuesto: este puente no
     lo transforma. Ver el encabezado de impresion.cjs. */
  handle('print:listar', (opts) => impresion.listar(opts));
  handle('print:capacidades', (opts) => impresion.capacidades(opts));
  handle('print:imprimir', (bytes, opciones) => impresion.imprimir(bytes, opciones));
  handle('print:papeles-con-nombre', () => impresion.papelesConNombre());

  /* ── Actualizaciones ────────────────────────────────────────────────────
     Nada de esto arranca solo una descarga ni cierra la app: `descargar` e
     `instalar` los tiene que pedir el usuario desde el modal. Los cambios de
     estado van al revés, por 'update:cambio' (ver actualizador.cjs). */
  handle('update:estado', () => actualizador.leer());
  handle('update:buscar', (opts) => actualizador.buscar(opts));
  handle('update:descargar', () => actualizador.descargar());
  handle('update:instalar', () => actualizador.instalar());

  /* ── Conversión ─────────────────────────────────────────────────────────
     El motor de Omnimuter, manejado desde src/conversion.cjs. Las rutas que
     entran son las que el usuario eligió o soltó; el progreso vuelve por
     'conv:progreso' mientras dura el lote. */
  handle('conv:catalogo', () => conversion.catalogo());
  handle('conv:elegir', () => conversion.elegir());
  handle('conv:fichar', (rutas) => conversion.fichar(rutas));
  handle('conv:convertir', (lote) => conversion.convertir(lote));
  handle('conv:unir', (lote) => conversion.unir(lote));
  handle('conv:mostrar', (ruta) => conversion.mostrar(ruta));
  /* Cortar el lote en curso (main-20). Lo implementa conversion.cancelar(),
     que llega con el motor en su propio proceso; hasta entonces el canal
     existe y contesta false, «no había nada que cortar», en vez de romper. */
  handle('conv:cancelar', () => (typeof conversion.cancelar === 'function' ? conversion.cancelar() : false));

  /* ── Presentar ──────────────────────────────────────────────────────────
     Las pantallas, la pantalla completa y la ventana de la sala. Ver el
     encabezado de presentacion.cjs. */
  presentacion.registrar(handle);
}

module.exports = { register, COLLECTIONS };
