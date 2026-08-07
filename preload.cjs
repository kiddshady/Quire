'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — preload
   La única puerta entre el renderer y el sistema. Todo lo que NO esté acá, el
   renderer no lo puede hacer: no tiene require, ni fs, ni acceso al proceso
   principal. Esa es la idea.

   Regla: exponé funciones, nunca objetos de Electron. `ipcRenderer` en el
   window anula por completo el aislamiento de contexto.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

contextBridge.exposeInMainWorld('onyx', {
  info: () => call('app:info'),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    /** El renderer le pasa a la ventana su color base ya resuelto (ver app.js). */
    setBackground: (hex) => ipcRenderer.send('win:set-bg', hex),
    onMaximized: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
  },

  /** Documento suelto: un borrador, un caché, el último estado de la UI. */
  doc: {
    read: (name, fallback = null) => call('doc:read', name, fallback),
    write: (name, data) => call('doc:write', name, data),
  },

  /** Colección: una carpeta con un archivo por ítem. */
  col: (name) => ({
    list: () => call('col:list', name),
    get: (id) => call('col:get', name, id),
    save: (item) => call('col:save', name, item),
    remove: (id) => call('col:remove', name, id),
    nextId: (prefix) => call('col:next-id', name, prefix),
  }),

  /** PDFs: abrir, leer, guardar. Los bytes van y vuelven como ArrayBuffer. */
  docs: {
    elegir: () => call('docs:elegir'),
    elegirVarios: () => call('docs:elegir-varios'),
    /* `{ imagenes: true }` acepta además PNG/JPEG/WEBP. Lo pide Combinar, que
       las vuelve páginas; el lector abre PDFs y nada más. */
    leer: (ruta, opciones) => call('docs:leer', ruta, opciones),
    guardarComo: (bytes, nombre, filtros) => call('docs:guardar-como', bytes, nombre, filtros),
    elegirCarpeta: () => call('docs:elegir-carpeta'),
    escribir: (carpeta, nombre, bytes) => call('docs:escribir', carpeta, nombre, bytes),
    recientes: () => call('docs:recientes'),
    olvidarRecientes: () => call('docs:olvidar-recientes'),
    /** El PDF con el que te abrieron. null si arrancaste la app a secas. */
    pendiente: () => call('docs:pendiente'),
    /* Con Quire ya abierta, el doble click en otro PDF no levanta una segunda
       ventana: el proceso nuevo le pasa la ruta a este y se muere (main.cjs). */
    onAbrir: (cb) => {
      const handler = (_e, ruta) => cb(ruta);
      ipcRenderer.on('docs:abrir', handler);
      return () => ipcRenderer.off('docs:abrir', handler);
    },
    /* Un File soltado en la ventana no trae su ruta desde Electron 32: hay que
       pedírsela a webUtils. Sin esto no se puede saber de dónde vino el
       archivo, y "guardar sobre el original" queda sin destino. */
    rutaDe: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return null; }
    },
  },

  /** Actualizaciones. `buscar` no baja nada; `descargar` e `instalar` los pide
      el usuario. Los cambios de estado llegan por onCambio. */
  update: {
    estado: () => call('update:estado'),
    buscar: (opts) => call('update:buscar', opts),
    descargar: () => call('update:descargar'),
    instalar: () => call('update:instalar'),
    onCambio: (cb) => {
      const handler = (_e, estado) => cb(estado);
      ipcRenderer.on('update:cambio', handler);
      return () => ipcRenderer.off('update:cambio', handler);
    },
  },

  /** Impresión. Lo que se manda ya tiene que estar impuesto. */
  print: {
    listar: () => call('print:listar'),
    capacidades: (opts) => call('print:capacidades', opts),
    imprimir: (bytes, opciones) => call('print:imprimir', bytes, opciones),
  },
});
