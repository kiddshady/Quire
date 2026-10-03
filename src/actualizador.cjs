'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — actualizaciones

   No hay servidor propio ni endpoint que mantener: `electron-builder` ya sube
   un `latest.yml` a cada release de GitHub, y `electron-updater` lo lee. La
   lista de versiones ES la lista de releases del repo.

   Nada pasa sin que el usuario diga que sí. `autoDownload = false` a propósito:
   el instalador pesa casi 100 MB y bajarlo de prepo, sin avisar, en la conexión
   de otro, no está bien. Se busca solo; se baja cuando lo pedís.

   ── Dónde NO funciona ──────────────────────────────────────────────────────
   Y hay que decirlo en pantalla, no fallar en silencio:

   · **Desde el código fuente** (`npm start`): no hay nada que reemplazar.
     electron-updater directamente tira una excepción si se lo pide.
   · **La versión portable**: es un solo .exe que el usuario dejó donde quiso;
     no hay instalación que actualizar. electron-builder marca ese caso con
     PORTABLE_EXECUTABLE_FILE en el entorno, y es la única forma de saberlo
     desde adentro.

   El módulo carga con Node pelado a propósito —los require de Electron van
   defensivos, igual que en store.cjs— para poder probar las decisiones sin
   levantar la app.
   ═══════════════════════════════════════════════════════════════════════════ */

let electronApp = null;
try { electronApp = require('electron').app; } catch { /* fuera de Electron */ }

/* electron-updater se carga tarde, adentro de iniciar(): requiere Electron y no
   tiene por qué existir cuando este archivo se abre desde un test. */
let autoUpdater = null;

const RELEASES = 'https://github.com/kiddshady/Quire/releases';

/* ── La decisión, aparte de todo lo demás ───────────────────────────────────
   Función pura: entra en qué condiciones corre la app, sale si se puede
   actualizar sola y, si no, qué contarle al usuario. */

/**
 * @param {{empaquetada:boolean, portable:boolean}} ctx
 * @returns {{ok:boolean, motivo:string}}
 */
function soporte({ empaquetada = false, portable = false } = {}) {
  if (!empaquetada) {
    return { ok: false, motivo: 'Estás corriendo Quire desde el código fuente. Acá no hay nada que actualizar: usá git.' };
  }
  if (portable) {
    return { ok: false, motivo: 'La versión portable no se actualiza sola: es un solo archivo que dejaste donde quisiste. Bajate el ejecutable nuevo y reemplazá el que tenés.' };
  }
  return { ok: true, motivo: '' };
}

/* ── Estado ─────────────────────────────────────────────────────────────────
   Uno solo, y el renderer lo recibe entero en cada cambio. Es chico y así no
   hay forma de que las dos mitades queden diciendo cosas distintas. */

const VACIO = {
  fase: 'inactivo',   // inactivo · sin-soporte · buscando · al-dia
  //                     disponible · descargando · listo · error
  actual: '',
  version: null,
  nombre: null,
  bytes: 0,
  progreso: { pct: 0, transferido: 0, total: 0, bps: 0 },
  motivo: '',
  error: '',
  url: RELEASES,
  /* Si la última búsqueda la pidió el usuario. Sin esto, un "estás al día" o un
     error de red aparecerían como cartel en cada arranque, que es exactamente
     lo que hace que la gente odie a los actualizadores. */
  manual: false,
};

let estado = { ...VACIO };
let dameVentana = null;

function fijar(parche) {
  estado = { ...estado, ...parche };
  const win = dameVentana?.();
  if (win && !win.isDestroyed()) win.webContents.send('update:cambio', estado);
  return estado;
}

/** El error de electron-updater viene con stack y URL adentro. Alcanza la primera línea. */
function mensaje(err) {
  const texto = String(err?.message || err || 'Error desconocido').split('\n')[0].trim();
  if (/ENOTFOUND|ENETUNREACH|EAI_AGAIN|getaddrinfo/i.test(texto)) return 'No se pudo llegar a GitHub. ¿Hay internet?';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/i.test(texto)) return 'GitHub no contestó a tiempo.';
  if (/404/.test(texto)) return 'La versión nueva no tiene el archivo que hace falta para actualizar.';
  return texto;
}

/** El peso del instalador, para poder decirlo ANTES de empezar a bajarlo. */
const tamanoDe = (info) => Number(info?.files?.[0]?.size) || 0;

/* ── Arranque ───────────────────────────────────────────────────────────── */

function iniciar(getWin) {
  dameVentana = getWin;
  estado = { ...VACIO, actual: electronApp?.getVersion() || '' };

  const s = soporte({
    empaquetada: !!electronApp?.isPackaged,
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  });
  if (!s.ok) { fijar({ fase: 'sin-soporte', motivo: s.motivo }); return; }

  /* Si electron-updater no carga (una instalación rota), Quire tiene que
     arrancar igual (main-11): el actualizador queda en error y sin
     autoUpdater, y buscar/descargar/instalar no hacen nada, como sin iniciar. */
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    autoUpdater = null;
    fijar({ fase: 'error', error: `No se pudo cargar el actualizador: ${mensaje(err)}` });
    return;
  }
  autoUpdater.autoDownload = false;
  /* Si nunca hacés click en "reiniciar", la actualización entra igual la próxima
     vez que cerrás Quire. Es la parte que hace que esto sirva de verdad. */
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => fijar({ fase: 'buscando', error: '' }));

  autoUpdater.on('update-available', (info) => fijar({
    fase: 'disponible',
    version: info?.version || null,
    nombre: String(info?.releaseName || '').trim() || `Quire ${info?.version || ''}`.trim(),
    bytes: tamanoDe(info),
    url: info?.version ? `${RELEASES}/tag/v${info.version}` : RELEASES,
  }));

  autoUpdater.on('update-not-available', () => fijar({ fase: 'al-dia', version: null }));

  autoUpdater.on('download-progress', (p) => fijar({
    fase: 'descargando',
    progreso: {
      pct: Math.max(0, Math.min(1, Number(p?.percent || 0) / 100)),
      transferido: Number(p?.transferred) || 0,
      total: Number(p?.total) || 0,
      bps: Number(p?.bytesPerSecond) || 0,
    },
  }));

  autoUpdater.on('update-downloaded', (info) => fijar({
    fase: 'listo',
    version: info?.version || estado.version,
    progreso: { ...estado.progreso, pct: 1 },
  }));

  /* Con la actualización ya bajada, un error posterior (buscar sin internet,
     por ejemplo) no la puede esconder: instalar() se niega fuera de 'listo', y
     el cartel se quedaba sin «Reiniciar» hasta cerrar la app (main-13). Lo que
     ya está en disco sigue sirviendo. */
  autoUpdater.on('error', (err) => {
    if (estado.fase === 'listo') return;
    fijar({ fase: 'error', error: mensaje(err) });
  });
}

/* ── Lo que puede pedir el renderer ─────────────────────────────────────── */

const leer = () => estado;

async function buscar({ manual = false } = {}) {
  if (!autoUpdater || estado.fase === 'sin-soporte') return estado;
  // Una búsqueda ya en curso, o una descarga andando, no se pisan.
  if (estado.fase === 'buscando' || estado.fase === 'descargando') return estado;
  /* Ya bajada, no hay nada que buscar (main-13). checkForUpdates vuelve a
     emitir update-available aunque esté descargada (electron-updater 6.8,
     AppUpdater.js), y con autoDownload en false la fase volvía a
     'disponible': el cartel dejaba de ofrecer «Reiniciar» y pedía «Descargar»
     otra vez.
     Pero callarse tampoco: el renderer solo se entera por 'update:cambio'
     (app.js no mira lo que devuelve esto), y con el cartel de «lista» ya
     anunciado y cerrado, el botón de Ajustes no hacía nada. Se avisa sin
     buscar, con `manual`, y el cartel se abre con «Reiniciar». */
  if (estado.fase === 'listo') return fijar({ manual });

  fijar({ manual });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (estado.fase !== 'listo') fijar({ fase: 'error', error: mensaje(err) });
  }
  return estado;
}

async function descargar() {
  if (!autoUpdater || estado.fase !== 'disponible') return estado;
  fijar({ fase: 'descargando', progreso: { ...VACIO.progreso, total: estado.bytes } });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    fijar({ fase: 'error', error: mensaje(err) });
  }
  return estado;
}

function instalar() {
  if (!autoUpdater || estado.fase !== 'listo') return false;
  /* quitAndInstall cierra la app. Llamarlo adentro del handler de IPC deja al
     renderer esperando una respuesta que ya no va a llegar nunca: primero se
     contesta, después se cierra. */
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

module.exports = { soporte, iniciar, leer, buscar, descargar, instalar, mensaje, RELEASES };
