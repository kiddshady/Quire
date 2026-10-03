'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — conversión (lado Electron)
   Lo que el motor de src/motor/ no puede hacer solo y necesita del proceso
   principal: el diálogo para elegir archivos, el Chromium que vuelve HTML un
   PDF, las rutas de los modelos de OCR y el canal de progreso hacia la
   ventana. El motor no sabe que existe Electron; este archivo es su chofer.

   Una conversión a la vez. Es un lote secuencial y pesado (un libro escaneado
   puede llevar minutos): dos en paralelo se pisarían el progreso y la
   máquina. El renderer también lo impide, pero el candado de verdad está acá.
   Y por eso mismo se puede cancelar: `cancelar()` corta el lote en marcha
   entre archivo y archivo o entre página y página (ver src/motor/corte.cjs).
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, dialog, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const motor = require('./motor/index.cjs');

/* Lo que se puede arrastrar o elegir. Sale del registro del motor, así que
   sumar un conversor allá lo habilita acá sin tocar nada. */
const EXTENSIONES = [...new Set(motor.listConverters().flatMap((c) => c.extensions))]
  .map((e) => e.replace(/^\./, ''));

const FILTROS = [
  { name: 'Convertibles', extensions: EXTENSIONES },
  { name: 'Cuestionarios Moodle', extensions: ['htm', 'html'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Word y PowerPoint', extensions: ['docx', 'pptx'] },
  { name: 'Texto y Markdown', extensions: ['txt', 'md', 'markdown', 'rst', 'log'] },
  { name: 'Todos los archivos', extensions: ['*'] },
];

/** Devuelve la ventana a la que se le manda el progreso. La pone main.cjs. */
let ventana = () => null;
let ocupado = false;
/** El AbortController del lote en marcha; null si no hay ninguno. */
let control = null;

function iniciar(getWin) { ventana = getWin; }

function emitir(evento) {
  const win = ventana();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('conv:progreso', evento);
  }
}

/* ── Rutas del OCR ───────────────────────────────────────────────────────────
   Los modelos (spa+eng) viajan en extraResources, FUERA del asar: tesseract
   los lee por ruta y un archivo adentro del asar no se puede leer así. El
   caché descomprimido va a userData, que es el único lugar escribible — y la
   carpeta se crea acá, porque si no existe tesseract no avisa: escribe los
   .traineddata en el directorio de trabajo, que empaquetado es cualquiera. */
function rutasOcr() {
  const ocrCachePath = path.join(app.getPath('userData'), 'tessdata-cache');
  try { mkdirSync(ocrCachePath, { recursive: true }); } catch { /* sin caché se descomprime cada vez */ }
  return {
    tessdataPath: app.isPackaged
      ? path.join(process.resourcesPath, 'tessdata')
      : path.join(__dirname, '..', 'vendor', 'tessdata'),
    ocrCachePath,
  };
}

/* ── HTML → PDF con el Chromium de Electron ──────────────────────────────────
   Una ventana oculta y sin JavaScript carga el template y lo imprime a PDF.
   Es lo que reemplazó a fpdf2 en Omnimuter: Unicode completo, CSS de verdad,
   y las imágenes del cuestionario inlineadas como data URLs.

   Esa ventana no sale a la red ni navega (main-10). Imprime HTML que salió
   de un archivo que no escribió Fran, y `javascript: false` no alcanzaba: una
   <img> remota se pedía igual y un <meta http-equiv="refresh"> navega sin
   JavaScript. Va con una partición propia, en memoria, que solo deja pasar
   el .html temporal de cada impresión y data: (las imágenes inlineadas), y
   con la navegación y las ventanas nuevas cerradas.

   De file: pasa ese .html y nada más, comparado por ruta. Primero dejaba
   pasar cualquier file:, y la revisión de 0B2 marcó que eso incluye las UNC
   con host (file://servidor/recurso/x.png): Chromium las resuelve por SMB, y
   eso puede entregar el hash NTLM del usuario. Hoy el sanitizador saca todo
   src que no sea data:, pero esta guarda está justo para cuando él se
   equivoca, como pasó con el alt de main-10. Medido en Electron 40: las
   file: pasan por onBeforeRequest (data: no), una UNC llega como
   file://host/… (también la de cuatro barras), y la URL del .html vuelve
   exacta a su ruta con fileURLToPath aunque lleve eñes, tildes, # o el
   FRANCI~1 de una carpeta temporal corta. */
const PARTICION_IMPRIMIR = 'quire-imprimir';   // sin «persist:»: no deja nada en disco
let sesionImprimir = null;
/** Los .html que se están imprimiendo ahora: lo único de file: que pasa. */
const enImpresion = new Set();
const claveDeRuta = (ruta) => (process.platform === 'win32' ? path.resolve(ruta).toLowerCase() : path.resolve(ruta));

/** ¿La partición de imprimir deja pasar este pedido? */
function pasaEnImprimir(url) {
  if (/^data:/i.test(url)) return true;
  if (!/^file:/i.test(url)) return false;
  try {
    return enImpresion.has(claveDeRuta(fileURLToPath(url)));
  } catch {
    return false;   // una file: que no se puede volver ruta: no pasa
  }
}

function sesionDeImprimir() {
  if (!sesionImprimir) {
    sesionImprimir = session.fromPartition(PARTICION_IMPRIMIR);
    sesionImprimir.webRequest.onBeforeRequest((det, responder) => {
      responder({ cancel: !pasaEnImprimir(det.url) });
    });
  }
  return sesionImprimir;
}

async function htmlToPdf(html) {
  const tmp = path.join(
    app.getPath('temp'),
    `quire-imprimir-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  await fs.writeFile(tmp, html, 'utf8');
  enImpresion.add(claveDeRuta(tmp));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, session: sesionDeImprimir() },
  });
  // loadURL no dispara will-navigate: esto solo frena lo que pida la página.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadURL(pathToFileURL(tmp).href);
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#8a9aa8;font-family:Arial,sans-serif;">'
        + '<span class="pageNumber"></span></div>',
      margins: { top: 0.55, bottom: 0.6, left: 0.55, right: 0.55 },
    });
  } finally {
    win.destroy();
    enImpresion.delete(claveDeRuta(tmp));
    fs.unlink(tmp).catch(() => {});
  }
}

/* ── Catálogo y archivos ─────────────────────────────────────────────────── */

function catalogo() {
  return {
    conversores: motor.listConverters(),
    salidas: motor.listOutputs(),
    extensiones: EXTENSIONES,
    textos: motor.pipeline.TEXT_EXTS,
  };
}

/** La ficha de un archivo para la cola: nombre, peso y si hay conversor. */
async function fichar(rutas) {
  const fichas = [];
  for (const ruta of rutas || []) {
    if (typeof ruta !== 'string' || !ruta) continue;
    try {
      const st = await fs.stat(ruta);
      if (!st.isFile()) continue;
      const ext = path.extname(ruta).toLowerCase();
      fichas.push({
        ruta,
        nombre: path.basename(ruta),
        carpeta: path.dirname(ruta),
        tamano: st.size,
        ext,
        convertible: EXTENSIONES.includes(ext.replace(/^\./, '')),
      });
    } catch { /* desapareció entre que lo soltaste y lo miramos: se saltea */ }
  }
  return fichas;
}

async function elegir() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir archivos para convertir',
    filters: FILTROS,
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return fichar(r.filePaths);
}

/* ── Convertir y unir ────────────────────────────────────────────────────── */

/* «Descargas» es la carpeta conocida de Windows, no %USERPROFILE%\Downloads
   (main-14): se puede mover a otro disco desde sus propiedades, y el motor,
   que no sabe de Electron, caía siempre a os.homedir(). */
function conDescargas(destino) {
  if (!destino || destino.modo !== 'descargas') return destino;
  return { ...destino, outRoot: app.getPath('downloads') };
}

/** Corta el lote en marcha. Devuelve si había algo que cortar. */
function cancelar() {
  if (!control || control.signal.aborted) return false;
  control.abort();
  return true;
}

function validarLote(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('No hay archivos para convertir.');
  if (files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) throw new Error('Ruta inválida en el lote.');
  if (ocupado) throw new Error('Ya hay una conversión en marcha. Esperá a que termine.');
}

async function convertir({ files, outputs, options } = {}) {
  validarLote(files);
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('Elegí al menos una salida.');
  ocupado = true;
  control = new AbortController();
  try {
    return await motor.pipeline.convertBatch({
      files,
      outputs,
      options: { ...(options || {}), ...rutasOcr(), destino: conDescargas(options?.destino) },
      htmlToPdf,
      onProgress: emitir,
      signal: control.signal,
    });
  } finally {
    ocupado = false;
    control = null;
  }
}

async function unir({ files, options } = {}) {
  validarLote(files);
  ocupado = true;
  control = new AbortController();
  try {
    return await motor.pipeline.mergeFiles({
      files,
      options: { ...(options || {}), destino: conDescargas(options?.destino) },
      onProgress: emitir,
      signal: control.signal,
    });
  } finally {
    ocupado = false;
    control = null;
  }
}

/** Abre el Explorador con el archivo seleccionado. */
function mostrar(ruta) {
  if (typeof ruta === 'string' && ruta) shell.showItemInFolder(ruta);
  return true;
}

module.exports = { iniciar, catalogo, fichar, elegir, convertir, unir, cancelar, mostrar, htmlToPdf, EXTENSIONES };
