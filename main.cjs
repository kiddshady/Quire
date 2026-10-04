'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — proceso principal
   Acá pasa lo único de una app Electron que no se puede resolver con CSS: que
   la ventana aparezca SIN un solo frame blanco.

   ── El problema ────────────────────────────────────────────────────────────
   Hay dos destellos blancos distintos y se arreglan distinto:

   A) Flash de contenido (FOUC). Antes de que el renderer pinte, Chromium
      muestra el fondo por defecto de la ventana. Se mata con `show:false` +
      `backgroundColor` oscuro + `paintWhenInitiallyHidden` + el splash inline
      del index.html.

   B) Flash del compositor (DWM). Cuando el HWND pasa de oculto a visible,
      el compositor de Windows pinta su backdrop POR ENCIMA del swap chain de
      Chromium. Ningún CSS lo alcanza. No se puede evitar: se puede PROVOCAR
      donde nadie lo vea. Por eso la ventana nace en x:-20000, hace su primer
      show() ahí, y recién 200 ms después se mueve a su lugar.

   Si el destello se ve en vivo pero NO en una grabación de pantalla, es el B.

   ── Los números no son arbitrarios ─────────────────────────────────────────
   · -20000  → fuera de cualquier monitor, incluso en setups multi-pantalla.
   · 200 ms  → lo que tarda DWM en asentar la superficie off-screen. Con 120
               el flash vuelve de forma intermitente. Si ves un destello "a
               veces sí, a veces no", es este número, no otra cosa.
   · Electron ≥ 40 → desde la 40, el frame fantasma de minimizar→restaurar se
               pinta con el `backgroundColor` de la ventana. En la 33 y
               anteriores es blanco hardcodeado y no hay forma de taparlo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const path = require('path');
const ipc = require('./src/ipc.cjs');
const store = require('./src/store.cjs');
const documentos = require('./src/documentos.cjs');
const actualizador = require('./src/actualizador.cjs');
const conversion = require('./src/conversion.cjs');
const presentacion = require('./src/presentacion.cjs');
const { rutaDeArgv, loteDeArgv } = require('./src/argv.cjs');

const DEV = process.argv.includes('--dev');

/* Para los tests que levantan la app de verdad (cerrar, apertura): con
   QUIRE_FUERA=1 la ventana se queda en -20000, donde nació, y se muestra sin
   tomar el foco (tests-09). Sin esto, `npm run verificar` le ponía Quire en
   el escritorio a Fran dos veces y le robaba el foco a lo que estuviera
   haciendo. Es lo mismo que PRISM_SHOTS=1 en Prism. */
const FUERA = process.env.QUIRE_FUERA === '1';

/* El mismo id que el appId de package.json (main-15). El instalador se lo pone
   a los accesos directos (WinShell::SetLnkAUMI en el installer.nsh de
   electron-builder), así que abriendo desde el anclado Windows agrupaba bien;
   pero un doble click en un PDF lanza el proceso sin id, y la ventana podía
   salir como un segundo botón al lado del anclado. Finway hace lo mismo. Va
   antes de crear cualquier ventana. */
app.setAppUserModelId('com.umbrovex.quire');

/* Color base de arranque. Tiene que coincidir con --ox-bg de tokens.css.
   Como --ox-bg es oklch y Electron solo entiende hex, el renderer se lo vuelve
   a mandar ya resuelto apenas carga (win.setBackground en app.js): si cambiás
   el matiz o la temperatura, no hace falta tocar este valor a mano. Este hex
   solo cubre los primeros milisegundos, antes de que exista el renderer. */
const BG = '#0a0b0d';

const DEFAULT_W = 1280;
const DEFAULT_H = 820;
const MIN_W = 900;
const MIN_H = 600;

/** @type {BrowserWindow | null} */
let win = null;

/* En false, el primer `close` se cancela para darle al renderer su chance de
   guardar; en true, el cierre pasa derecho. Se levanta cuando el renderer
   avisa que terminó, o cuando se le acaba el tiempo. Ver win.on('close'). */
let puedeCerrar = false;

/* Cuándo fue la última vez que se recargó solo un renderer caído. Ver
   'render-process-gone' en createWindow: más de una por minuto es un bucle. */
let ultimaRecarga = 0;
const RECARGA_MIN_MS = 60000;

/* ── Estado de la ventana ────────────────────────────────────────────────────
   Recordar tamaño y posición entre sesiones. La trampa: si el monitor donde
   estaba ya no existe, la posición guardada deja la ventana en la nada. Por
   eso se valida contra las pantallas actuales antes de usarla. */
const winState = store.doc('window', null);

function visibleOn(x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // Con que se vea una esquina razonable alcanza para poder agarrarla.
    return x + w > a.x + 40 && x < a.x + a.width - 40
        && y + h > a.y && y < a.y + a.height - 40;
  });
}

function centered(w, h) {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2) };
}

async function loadWindowState() {
  const s = await winState.read().catch(() => null);
  const w = Math.max(MIN_W, Number(s?.width) || DEFAULT_W);
  const h = Math.max(MIN_H, Number(s?.height) || DEFAULT_H);
  const hasPos = Number.isFinite(s?.x) && Number.isFinite(s?.y) && visibleOn(s.x, s.y, w, h);
  return { width: w, height: h, maximized: !!s?.maximized, ...(hasPos ? { x: s.x, y: s.y } : centered(w, h)) };
}

let saveTimer = null;
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  // Debounce: arrastrar una ventana emite decenas de eventos por segundo.
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // Guardar el bounds NORMAL: si guardás el maximizado, al desmaximizar la
    // próxima vez la ventana queda del tamaño de la pantalla y sin poder volver.
    const b = win.getNormalBounds();
    winState.write({ x: b.x, y: b.y, width: b.width, height: b.height, maximized })
      .catch((err) => console.error('[window] no se pudo guardar el estado:', err.message));
  }, 400);
}

function createWindow(state) {
  // Una ventana nueva vuelve a deberle a su renderer la chance de guardar.
  puedeCerrar = false;
  win = new BrowserWindow({
    // Nace fuera de pantalla: el flash del compositor ocurre donde nadie lo ve.
    x: -20000,
    y: -20000,
    width: state.width,
    height: state.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: BG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    /* Fuera de pantalla pero VISIBLE, como las ventanas de humo: oculta,
       Chromium congela las animaciones y el renderer no se comporta como el
       de verdad. */
    if (FUERA) { win.showInactive(); return; }
    win.show();
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setPosition(state.x, state.y);
      if (state.maximized) win.maximize();
    }, 200);
  });

  // En dev, la consola del renderer sale por la terminal: si un módulo no carga
  // o una vista revienta, se ve acá sin tener que abrir devtools.
  if (DEV) {
    win.webContents.on('console-message', (e) => {
      const level = ['debug', 'info', 'warn', 'error'][e.level] ?? e.level;
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] no cargó (${code} ${desc}) → ${url}`);
    });
  }

  const pushMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', () => { pushMaximized(); saveWindowState(); });
  win.on('unmaximize', () => { pushMaximized(); saveWindowState(); });
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);

  /* Nada de navegación fuera de la app; los links externos van al navegador.
     La única ventana que se abre es la sala de una presentación (ver
     src/presentacion.cjs). */
  win.webContents.setWindowOpenHandler((detalles) => {
    const sala = presentacion.abrirVentana(win, detalles);
    if (sala) return sala;
    if (/^https?:\/\//i.test(detalles.url)) shell.openExternal(detalles.url);
    return { action: 'deny' };
  });
  presentacion.vigilar(win);
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  /* ── Cerrar sin perder el último trazo ────────────────────────────────────
     La capa de tinta guarda con 900 ms de retardo, así que dibujar y cerrar
     enseguida perdía lo último. Y `beforeunload` en el renderer no sirve para
     esto: es síncrono, y ahí hay que escribir varios archivos por IPC.

     Así que el cierre se ataja acá: se le pide al renderer que vacíe lo
     pendiente y se espera su aviso. El primer close se cancela; el que llega
     después de 'app:guardado' pasa derecho.

     El timeout NO es opcional. Sin él, un renderer colgado —o que murió y no
     va a contestar nunca— deja una ventana que no se puede cerrar, y la única
     salida es el administrador de tareas. Ante la duda se cierra: perder el
     último trazo es malo, no poder cerrar la app es peor.

     El renderer también puede VETAR el cierre (ux-03, decisión de Fran): con
     cambios sin guardar en Páginas pregunta antes. Para eso contesta enseguida
     'app:cierre-preguntando' —está vivo, hay un diálogo a la vista— y el reloj
     se para: el usuario puede tardar lo que quiera en decidir. Después llega
     'app:cierre-cancelado' (la ventana sigue) o 'app:cierre-decidido' (se
     cierra: el renderer guarda y contesta 'app:guardado' sin volver a
     preguntar). Con la decisión tomada el reloj vuelve a correr: si guardar
     se cuelga, la ventana se cierra sola a los 3 s, como cuando no se
     pregunta nada, y otra cruz en el medio no vuelve a preguntar.
     Si se aprieta la cruz otra vez con la pregunta abierta, se le vuelve a
     pedir y el reloj vuelve a correr: un renderer vivo contesta que sigue
     preguntando; uno que se colgó después de preguntar no contesta, y a los
     3 s se cierra igual, como siempre. */
  let guardando = false;
  /* El renderer avisó que está preguntando: el reloj no corre. */
  let preguntando = false;
  let reloj = null;
  /* Mientras no hay renderer —se cayó y todavía no terminó de recargar— no
     hay nadie que guarde ni que conteste: el cierre pasa derecho, sin esperar
     los 3 s (main-12). */
  let sinRenderer = false;
  /* Si se estaba esperando el aviso para cerrar y el renderer se cae, el aviso
     no va a llegar: esto suelta la espera en el acto. */
  let soltarCierre = null;

  /* Todos los caminos —el aviso del renderer, el timeout, la cancelación—
     pasan por acá, y todos SUELTAN los listeners. Dejarlos colgados si
     cerramos por timeout significa que la próxima ventana arranca con un
     oyente de la anterior esperando un mensaje que ya no es para él. */
  const soltarEspera = () => {
    clearTimeout(reloj);
    reloj = null;
    ipcMain.off('app:guardado', listo);
    ipcMain.off('app:cierre-preguntando', alPreguntar);
    ipcMain.off('app:cierre-cancelado', alCancelar);
    ipcMain.off('app:cierre-decidido', alDecidir);
    soltarCierre = null;
    guardando = false;
    preguntando = false;
  };
  function listo() {
    soltarEspera();
    if (puedeCerrar) return;
    puedeCerrar = true;
    if (win && !win.isDestroyed()) win.close();
  }
  function alPreguntar() {
    preguntando = true;
    clearTimeout(reloj);
    reloj = null;
  }
  function alCancelar() { soltarEspera(); }
  function alDecidir() {
    preguntando = false;
    armarReloj();
  }
  function armarReloj() {
    clearTimeout(reloj);
    reloj = setTimeout(() => {
      console.error('[cerrar] el renderer no contestó en 3 s: se cierra igual');
      listo();
    }, 3000);
  }

  win.on('close', (e) => {
    if (puedeCerrar || sinRenderer || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    e.preventDefault();
    if (guardando && !preguntando) return;     // ya se lo pedimos; que termine

    if (!guardando) {
      guardando = true;
      soltarCierre = listo;
      ipcMain.on('app:guardado', listo);
      ipcMain.on('app:cierre-preguntando', alPreguntar);
      ipcMain.on('app:cierre-cancelado', alCancelar);
      ipcMain.on('app:cierre-decidido', alDecidir);
    }
    // Primera vez, o la cruz de nuevo con la pregunta abierta: el reloj corre
    // hasta que conteste.
    preguntando = false;
    armarReloj();
    win.webContents.send('app:antes-de-cerrar');
  });

  /* ── Si el renderer se cae ────────────────────────────────────────────────
     El lector carga PDFs de hasta 512 MB y se puede quedar sin memoria. Sin
     esto, la ventana quedaba en el color de fondo, sin nada adentro y sin
     botones (frame:false: la titlebar es del renderer), y cerrarla esperaba
     los 3 s de un renderer que ya no iba a contestar (main-12).

     Se recarga sola, y al arrancar el renderer reabre la sesión. Lo pendiente
     del doble click ya se entregó y no vuelve (tomarPendientes lo vacía), así
     que nada se abre dos veces. Una vez por minuto como mucho: si se vuelve a
     caer enseguida, recargar en automático sería un bucle —un PDF que no entra
     en memoria, reabierto por la sesión, la tiraría cada vez—, y ahí se
     pregunta qué hacer.

     La pregunta tiene que traer una salida que exista. La primera versión
     ofrecía «Volver a cargar» y aconsejaba «abrila de nuevo sin ese
     documento», y ninguna de las dos servía: el documento que la tiraba está
     en ultimosDocumentos desde que se abrió su pestaña, así que la recarga lo
     reabría, y abrir Quire de nuevo también (proceso nuevo: se recarga sola,
     se cae, diálogo otra vez). Por eso el botón principal vacía la sesión
     ANTES de recargar (lo mide test/caida.cjs). Cerrar no la toca: hoy Quire
     no muestra Recientes en ningún lado, y borrarla sin que lo pidas es
     perder las pestañas para siempre. */
  win.webContents.on('render-process-gone', (_e, detalles) => {
    if (!win || win.isDestroyed()) return;
    sinRenderer = true;
    documentos.soltarReclamo();
    /* Lo que sigue va en la vuelta siguiente, no adentro del evento: un
       reload() llamado mientras Chromium todavía avisa la caída tiró el
       proceso principal entero (medido: «Observers can only be added once!»,
       un NOTREACHED de Chromium). */
    setTimeout(() => recuperar(detalles?.reason), 0);
  });

  const recuperar = (motivo) => {
    if (!win || win.isDestroyed()) return;
    soltarCierre?.();
    if (puedeCerrar || motivo === 'clean-exit') return;

    const ahora = Date.now();
    if (ahora - ultimaRecarga >= RECARGA_MIN_MS) {
      ultimaRecarga = ahora;
      console.error(`[renderer] se cayó (${motivo}): se recarga`);
      win.reload();
      return;
    }

    console.error(`[renderer] se volvió a caer (${motivo}) en menos de un minuto: no se recarga solo`);
    const SIN_DOCUMENTOS = 0; const CERRAR = 2;  // el 1 es «Volver a cargar», con todo
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Quire',
      message: 'La ventana de Quire se cerró de golpe dos veces seguidas.',
      detail: 'Puede ser uno de los documentos abiertos, demasiado pesado para la memoria que queda: '
        + 'si Quire los vuelve a abrir al cargar, se cae otra vez. «Volver a cargar sin los '
        + 'documentos» arranca con las pestañas vacías, y los abrís de nuevo de a uno. Cerrar no '
        + 'los olvida: la próxima vez se reabren como siempre.',
      buttons: ['Volver a cargar sin los documentos', 'Volver a cargar', 'Cerrar Quire'],
      defaultId: SIN_DOCUMENTOS,
      cancelId: CERRAR,
      noLink: true,
    }).then(async ({ response }) => {
      if (!win || win.isDestroyed()) return;
      if (response === CERRAR) { win.close(); return; }
      if (response === SIN_DOCUMENTOS) {
        /* Antes de recargar, no después: el renderer nuevo lee la sesión al
           arrancar (restaurarSesion). Si el disco falla se recarga igual; en
           el peor caso se cae de nuevo y vuelve esta pregunta. */
        await store.saveSettings({ ultimosDocumentos: [], posicionActiva: 0 })
          .catch((err) => console.error('[renderer] no se pudo vaciar la sesión:', err.message));
        if (!win || win.isDestroyed()) return;
      }
      ultimaRecarga = Date.now();
      win.reload();
    }).catch(() => {});
  };

  /* Un documento nuevo en la ventana (el de arranque, o el de una recarga) es
     un renderer que todavía no escucha 'docs:abrir': lo que llegue mientras
     arranca se encola y lo reclama él (main-02, ver soltarReclamo). Va en
     did-navigate, que llega cuando la navegación ya se hizo, y no en
     did-start-navigation: esa salta también con la navegación que corta
     will-navigate, y entonces el renderer que sigue vivo dejaba de recibir
     rutas para siempre. */
  win.webContents.on('did-navigate', () => { documentos.soltarReclamo(); });

  /* Y cuando la página terminó de cargar, vuelve a haber quien guarde: el
     cierre lo espera otra vez. (No se puede saber desde acá cuándo se suscribe
     a onAntesDeCerrar; si cerrás antes, pasa lo mismo que en cualquier
     arranque: a los 3 s cierra igual.) */
  win.webContents.on('did-finish-load', () => { sinRenderer = false; });

  win.on('closed', () => { win = null; });
}

/* ── Controles de ventana ────────────────────────────────────────────────────
   La titlebar es nuestra (frame:false), así que minimizar/maximizar/cerrar
   los tiene que cablear la app. */
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));

// El renderer manda su --ox-bg ya resuelto a hex. Es lo que hace que el frame
// fantasma del restore siga camuflado aunque cambies el matiz en tokens.css.
ipcMain.on('win:set-bg', (_e, hex) => {
  if (win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(String(hex))) {
    win.setBackgroundColor(hex);
  }
});

/* ── Abrir con doble click ───────────────────────────────────────────────────
   Windows no le "pasa" el archivo a la app: la ejecuta con la ruta como
   argumento (ver src/argv.cjs). Acá se decide qué hacer con esa ruta según haya
   o no alguien del otro lado para recibirla. */
function entregar(ruta) {
  if (!ruta) return;
  if (documentos.yaReclamo() && win && !win.isDestroyed()) {
    win.webContents.send('docs:abrir', ruta);
  } else {
    // Todavía no hay renderer escuchando: que lo venga a buscar cuando arranque.
    documentos.encolar(ruta);
  }
}

/* ── Convertir desde la línea de comandos ────────────────────────────────────
   `Quire.exe --convertir examen.htm --a pdf,md`: sin ventana, convierte y
   sale. Las salidas caen al lado de cada original; el código de salida es 0
   si todo salió y 1 si algo falló, y el detalle va a un `quire-convertir.json`
   junto a la primera salida — porque una app de ventana en Windows no tiene
   consola a la que escribir. Existe para convertir desde un script y para
   probar el motor en la app EMPAQUETADA, donde el asar y los modelos de OCR
   viven en otro lado que en desarrollo. */
async function convertirYSalir(lote) {
  const fs = require('node:fs/promises');
  let codigo = 1;
  try {
    if (!lote.files.length) throw new Error('--convertir necesita al menos un archivo.');
    const res = await conversion.convertir({
      files: lote.files, outputs: lote.outputs, options: { destino: { modo: 'junto' } },
    });
    const informe = { version: app.getVersion(), empaquetada: app.isPackaged, ...res };
    const dir = res.outDirs[0] || path.dirname(lote.files[0]);
    await fs.writeFile(path.join(dir, 'quire-convertir.json'), JSON.stringify(informe, null, 2), 'utf8');
    console.log(JSON.stringify(informe, null, 2));
    codigo = res.results.every((r) => r.ok) ? 0 : 1;
  } catch (err) {
    console.error('[convertir]', err);
  }
  app.exit(codigo);
}

function arrancar() {
  const lote = loteDeArgv(process.argv, app.isPackaged);
  if (lote) {
    app.whenReady().then(() => convertirYSalir(lote));
    return;
  }

  entregar(rutaDeArgv(process.argv, app.isPackaged));

  app.whenReady().then(async () => {
    ipc.register();
    /* La ventana primero, y lo demás con red (main-11). Antes el actualizador
       y la conversión arrancaban ANTES de crearla, sin catch: si uno tiraba,
       quedaba un Quire sin ventana pero vivo y con el candado de instancia
       única tomado, y cada doble click posterior le entregaba su ruta a ese
       proceso invisible. Quire «no abría» hasta matarlo a mano.
       Se enganchan a la ventana por función y no por referencia: la ventana
       puede cambiar (ver 'activate'). */
    createWindow(await loadWindowState());
    try { actualizador.iniciar(() => win); }
    catch (err) { console.error('[actualizador] no arrancó:', err); }
    try { conversion.iniciar(() => win); }
    catch (err) { console.error('[conversion] no arrancó:', err); }
  }).catch((err) => {
    /* Lo que igual reviente acá es un arranque roto. Mejor decirlo y soltar el
       candado que quedarse vivo y mudo. */
    console.error('[arranque]', err);
    dialog.showErrorBox('Quire no pudo arrancar', err?.message || String(err));
    app.exit(1);
  });
}

/* Sin el lock, cada doble click levanta OTRA Quire: dos procesos, dos ventanas,
   y la segunda pisándole el estado de ventana a la primera al cerrarse. Con el
   lock, la instancia nueva le entrega su argv a la que ya está y se muere.

   En desarrollo no se pide, y no es un detalle: el lock es por `userData`, que
   es el MISMO en dev que en la app instalada. Sin esta excepción, `npm run dev`
   con Quire abierta se cerraría sola y parecería que la app está rota. */
/* El lote por línea de comandos no pide el lock: tiene que poder correr con
   Quire abierta, y no abre ventana que pisar. */
const SIN_VENTANA = !!loteDeArgv(process.argv, app.isPackaged);

if (!DEV && !SIN_VENTANA && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    entregar(rutaDeArgv(argv, app.isPackaged));
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  arrancar();
}

app.on('window-all-closed', () => {
  /* En el modo sin ventana la única que se abre y se cierra es la oculta de
     printToPDF: si eso cerrara la app, el lote moriría después del primer
     PDF, con las otras salidas sin escribir. */
  if (SIN_VENTANA) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(await loadWindowState());
});
