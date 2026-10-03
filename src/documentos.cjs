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
const { BYTES_CABECERA, EXT_IMAGEN, formatoDe } = require('./firmas.cjs');

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

/* El primer KB, para mirar la firma ANTES de cargar el archivo entero. Sin
   esto, algo que no es un PDF y pesa 400 MB se leía completo solo para
   rechazarlo (main-17). */
async function leerCabecera(ruta) {
  const fh = await fs.open(ruta, 'r');
  try {
    const buf = Buffer.alloc(BYTES_CABECERA);
    const { bytesRead } = await fh.read(buf, 0, BYTES_CABECERA, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/* Los bytes para el IPC, sin copiarlos si no hace falta. El Buffer de un
   readFile ya ocupa su ArrayBuffer entero (medido: byteOffset 0 y el mismo
   largo), así que el `buf.buffer.slice()` de antes era un memcpy sincrónico
   del archivo completo en el main, y el IPC lo vuelve a clonar igual. Se copia
   solo si el Buffer es una vista parcial, como los chicos que salen del pool. */
function arrayBufferDe(buf) {
  return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf.buffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Lee un archivo del disco y lo deja listo para mandar por IPC.
 *
 * `imagenes` es la puerta para PNG/JPEG/WEBP, y solo la abre Combinar. El
 * lector sigue aceptando PDF y nada más: abrir una imagen "como documento"
 * sería otra función y no es esta.
 *
 * `reciente: false` no lo anota en Recientes. Lo usa Combinar: los PDFs que se
 * suman a un combinado son piezas, no algo a lo que uno quiera volver.
 */
async function leer(ruta, opciones) {
  const { imagenes = false, reciente = true } = opciones || {};
  if (typeof ruta !== 'string' || !ruta) throw new Error('Ruta inválida');

  const stat = await fs.stat(ruta);
  if (!stat.isFile()) throw new Error('No es un archivo');
  if (stat.size > MAX_BYTES) {
    throw new Error(`El archivo pesa ${(stat.size / 1048576).toFixed(0)} MB; el límite es ${MAX_BYTES / 1048576} MB`);
  }

  const formato = formatoDe(await leerCabecera(ruta));

  if (!imagenes && formato !== 'pdf') {
    throw new Error('El archivo no tiene el encabezado %PDF — no es un PDF válido');
  }
  if (!formato) {
    throw new Error('No se reconoce el archivo: no es un PDF ni una imagen PNG, JPEG o WEBP');
  }

  const buf = await fs.readFile(ruta);

  /* Los recientes son documentos, no piezas sueltas. Una imagen que se sumó a
     un combinado no es algo a lo que uno quiera "volver".
     Sin await: anotarlo es una escritura atómica con fsync, y el documento no
     tiene por qué esperarla para abrirse (main-17). Si falla, Recientes queda
     como estaba; la apertura no se entera. */
  if (formato === 'pdf' && reciente) anotarReciente(ruta, stat).catch(() => {});

  return {
    ruta,
    nombre: path.basename(ruta),
    carpeta: path.dirname(ruta),
    bytes: arrayBufferDe(buf),
    tamano: stat.size,
    modificado: stat.mtimeMs,
    formato,
    tipo: formato === 'pdf' ? 'pdf' : 'imagen',
  };
}

/**
 * El diálogo de Abrir.
 *
 * Sin opciones devuelve UN documento ya leído, o null si se canceló: es lo que
 * espera el renderer de siempre. Con `{ varios: true }` deja marcar varios con
 * Ctrl y devuelve las RUTAS, no los documentos (ux-12): el renderer los abre
 * de a uno con docs.leer, igual que restaurarSesion y que soltar archivos, y
 * corta cuando se llenan las pestañas. Leerlos todos acá mandaría por IPC, de
 * una sola vez, documentos que capaz ni entran.
 */
async function elegir(opciones) {
  const varios = !!opciones?.varios;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: varios ? 'Abrir PDFs' : 'Abrir PDF',
    filters: FILTROS,
    properties: varios ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (varios) return r.canceled ? [] : [...r.filePaths];
  if (r.canceled || !r.filePaths.length) return null;
  return leer(r.filePaths[0]);
}

/**
 * Lee una tanda de archivos sin que uno malo tire a los demás (main-08).
 *
 * Con Promise.all, bastaba un archivo de más de 512 MB, un .gif elegido con
 * «Todos los archivos» o uno bloqueado para que no entrara ninguno. Acá cada
 * uno corre su suerte, y los que fallaron vuelven con su motivo.
 */
async function leerVarios(rutas, opciones) {
  const intentos = await Promise.allSettled(rutas.map((p) => leer(p, opciones)));
  const leidos = [];
  const fallidos = [];
  intentos.forEach((x, i) => {
    if (x.status === 'fulfilled') leidos.push(x.value);
    else fallidos.push({ ruta: rutas[i], nombre: path.basename(rutas[i]), error: x.reason?.message || String(x.reason) });
  });
  return { leidos, fallidos };
}

/**
 * Varios de una: para combinar. Acá sí entran imágenes, y nada entra a
 * Recientes (son piezas del combinado).
 *
 * Con `{ conFallidos: true }` devuelve `{ leidos, fallidos }`, para que el
 * renderer pueda avisar cuáles no entraron. Sin la opción devuelve la lista
 * sola, que es lo que espera el renderer de hoy: los buenos entran igual, y
 * solo si fallaron TODOS se tira el error, como antes.
 */
async function elegirVarios(opciones) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir PDFs o imágenes',
    filters: FILTROS_CON_IMAGENES,
    properties: ['openFile', 'multiSelections'],
  });
  const rutas = r.canceled ? [] : r.filePaths;
  const { leidos, fallidos } = await leerVarios(rutas, { imagenes: true, reciente: false });
  if (opciones?.conFallidos) return { leidos, fallidos };
  if (!leidos.length && fallidos.length) throw new Error(`${fallidos[0].nombre}: ${fallidos[0].error}`);
  return leidos;
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

/* Un tope para el bucle de abajo: ninguna carpeta real tiene diez mil copias
   del mismo nombre, y si las tiene, algo anda mal y conviene decirlo. */
const MAX_NUMERADOS = 10000;

/**
 * Escribe sin pisar: si el nombre está tomado, prueba «nombre (2).ext»,
 * «nombre (3).ext»… Es la misma numeración que usa el motor de Convertir
 * (uniquePath en src/motor/pipeline.cjs), así las dos vistas nombran igual.
 *
 * No pregunta si existe y después escribe: entre las dos cosas otra escritura
 * podría tomar el mismo nombre. Abre con 'wx', que falla si el archivo ya está,
 * y en ese caso pasa al número siguiente.
 */
async function escribirSinPisar(destino, datos) {
  const { dir, name, ext } = path.parse(destino);
  for (let n = 1; n <= MAX_NUMERADOS; n++) {
    const candidato = n === 1 ? destino : path.join(dir, `${name} (${n})${ext}`);
    try {
      await fs.writeFile(candidato, datos, { flag: 'wx' });
      return candidato;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Ya hay demasiados archivos llamados ${name}${ext} en esa carpeta`);
}

/**
 * Escribe directo, sin diálogo. Para exportar en lote a una carpeta ya elegida.
 * Devuelve la ruta donde quedó.
 *
 * `{ noPisar: true }` numera en vez de reemplazar lo que ya estaba (herr-18):
 * exportar dos veces a la misma carpeta, o dividir con otro corte, borraba en
 * silencio lo de la vez anterior. Sin la opción pisa, como siempre, que es lo
 * que espera el renderer de hoy.
 */
async function escribir(carpeta, nombre, bytes, opciones) {
  // El nombre lo arma el renderer; sin esto, un "../" escribiría fuera de la
  // carpeta que el usuario eligió.
  const limpio = path.basename(String(nombre));
  if (!limpio || limpio === '.' || limpio === '..') throw new Error('Nombre de archivo inválido');
  const destino = path.join(carpeta, limpio);
  if (path.dirname(path.resolve(destino)) !== path.resolve(carpeta)) {
    throw new Error('El destino se sale de la carpeta elegida');
  }
  if (opciones?.noPisar) return escribirSinPisar(destino, Buffer.from(bytes));
  await fs.writeFile(destino, Buffer.from(bytes));
  return destino;
}

/* ── Recientes ──────────────────────────────────────────────────────────────
   Se guarda la ruta, no el contenido. Al abrir se revalida: un reciente que
   ya no existe se muestra apagado en vez de reventar al hacer click. */

const MAX_RECIENTES = 12;

/* Anotar es leer, modificar y escribir. La cola de writeJSON ordena solo la
   escritura: dos aperturas casi juntas leían la MISMA lista vieja y ganaba la
   última, así que de cuatro PDFs abiertos de una quedaba uno (main-08). Esta
   cadena hace que cada anotación lea lo que dejó la anterior. */
let colaRecientes = Promise.resolve();

function anotarReciente(ruta, stat) {
  const turno = colaRecientes.then(async () => {
    const actual = await recientes.read().catch(() => ({ lista: [] }));
    const lista = [
      { ruta, nombre: path.basename(ruta), tamano: stat.size, abierto: Date.now() },
      ...(actual?.lista || []).filter((r) => r.ruta !== ruta),
    ].slice(0, MAX_RECIENTES);
    await recientes.write({ lista }).catch(() => {});
  });
  colaRecientes = turno.catch(() => {});
  return turno;
}

async function listarRecientes() {
  const { lista = [] } = await recientes.read().catch(() => ({ lista: [] }));
  return Promise.all(lista.map(async (r) => ({
    ...r,
    existe: await fs.access(r.ruta).then(() => true).catch(() => false),
  })));
}

/* Por la misma cola: si no, una anotación que ya había leído la lista vieja la
   volvía a escribir entera después de olvidarla. */
async function olvidarRecientes() {
  const turno = colaRecientes.then(() => recientes.write({ lista: [] }));
  colaRecientes = turno.catch(() => {});
  await turno;
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
   se encola.

   Es una LISTA y no un casillero (main-02). Al marcar varios PDFs en el
   Explorador y apretar Enter, Windows lanza un proceso por archivo: el primero
   toma el candado y los demás llegan por 'second-instance' antes de que el
   renderer reclame. Con un solo casillero cada uno pisaba al anterior, y Quire
   arrancaba con una pestaña sola, la de la última ruta que llegó. */

const pendientes = [];
let reclamado = false;

function encolar(ruta) {
  if (ruta && !pendientes.includes(ruta)) pendientes.push(ruta);
}

/** Todas, en el orden en que llegaron. Se entregan UNA sola vez: un F5 del
    renderer no reabre lo de hace media hora. */
function tomarPendientes() {
  reclamado = true;
  return pendientes.splice(0);
}

/** Lo que pide el renderer de antes, que abre una sola: la primera que llegó.
    Las demás se pierden, como pasaba antes con el casillero (ahí ganaba la
    última). El renderer nuevo pide la lista entera por 'docs:pendientes'. */
function tomarPendiente() {
  return tomarPendientes()[0] ?? null;
}

/* Un renderer que recarga —un Ctrl+R, o el reload de main.cjs cuando se cae—
   deja de escuchar hasta que vuelve a arrancar. Sin esto, `reclamado` quedaba
   en true para siempre y una ruta que llegaba durante la carga se mandaba por
   evento a nadie. Con esto se encola, y el renderer la reclama al arrancar. */
function soltarReclamo() { reclamado = false; }

const yaReclamo = () => reclamado;

module.exports = {
  leer,
  leerVarios,
  elegir,
  elegirVarios,
  guardarComo,
  elegirCarpeta,
  escribir,
  listarRecientes,
  olvidarRecientes,
  encolar,
  tomarPendiente,
  tomarPendientes,
  soltarReclamo,
  yaReclamo,
  MAX_BYTES,
};
