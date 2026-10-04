'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — presentar, del lado del proceso principal

   Lo que el renderer no puede hacer solo: saber cuántas pantallas hay, poner
   la ventana en pantalla completa y abrir la ventana de la SALA (la que va al
   proyector) en el monitor que corresponde.

   La sala se abre desde el renderer con window.open('', 'qr-sala'): así es
   del mismo origen que la ventana principal y el renderer le maneja el DOM
   directamente (le dibuja las láminas, la tinta y el láser con el mismo
   código que usa para la vista del orador). Acá solo se decide DÓNDE nace y
   cómo aparece, con el método de siempre contra el destello del compositor
   (ver main.cjs): nace en -20000, se muestra ahí, y 200 ms después se muda a
   su monitor.

   Con QUIRE_SALA=fuera (los tests) se hace de cuenta que hay un segundo
   monitor fuera de pantalla, y la sala se queda en -20000 sin pantalla
   completa. Una ventana principal fuera de pantalla tampoco se pone en
   pantalla completa: se iría al monitor de alguien.
   ═══════════════════════════════════════════════════════════════════════════ */

const { BrowserWindow, ipcMain, screen } = require('electron');

const NOMBRE_SALA = 'qr-sala';
const SALA_FICTICIA = { id: -1, bounds: { x: -20000, y: -20000, width: 1280, height: 720 }, scaleFactor: 1 };
const ficticia = () => process.env.QUIRE_SALA === 'fuera';

/* Por cada ventana principal (su webContents.id): a qué pantalla va la sala
   y la sala misma, cuando existe. */
const salas = new Map();

const fueraDePantalla = (win) => win.getBounds().x < -10000;

function pantallaDe(win) {
  return screen.getDisplayMatching(win.getBounds());
}

/** La pantalla para la sala: la primera que no es la de la ventana. */
function pantallaParaSala(win) {
  if (ficticia()) return SALA_FICTICIA;
  const propia = pantallaDe(win);
  return screen.getAllDisplays().find((d) => d.id !== propia.id) || null;
}

/* Espera a que la ventana termine de entrar o salir de pantalla completa. En
   Windows el evento llega cuando el tamaño ya cambió; el tope es por si no
   llega (ya estaba así, o la ventana está minimizada). */
function ponerPantallaCompleta(win, on) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  if (fueraDePantalla(win) || win.isFullScreen() === on) return Promise.resolve(true);
  return new Promise((resolve) => {
    const evento = on ? 'enter-full-screen' : 'leave-full-screen';
    const listo = () => { clearTimeout(tope); win.off(evento, listo); resolve(true); };
    const tope = setTimeout(listo, 900);
    win.once(evento, listo);
    win.setFullScreen(on);
  });
}

/* La sala ocupa su monitor entero: se muda a él y recién ahí pasa a pantalla
   completa (al revés, Windows la agranda en el monitor donde estaba). */
function mudarSala(sala, pantalla) {
  if (!sala || sala.isDestroyed()) return Promise.resolve();
  if (pantalla.id === SALA_FICTICIA.id) { sala.setBounds(pantalla.bounds); return Promise.resolve(); }
  return ponerPantallaCompleta(sala, false).then(() => {
    if (sala.isDestroyed()) return;
    sala.setBounds(pantalla.bounds);
    return ponerPantallaCompleta(sala, true);
  });
}

/**
 * Lo que va en el setWindowOpenHandler de la ventana principal: la sala se
 * abre con estas opciones; cualquier otra cosa devuelve null y decide main.cjs.
 */
function abrirVentana(win, { frameName, url }) {
  if (frameName !== NOMBRE_SALA || (url && url !== 'about:blank')) return null;
  const destino = salas.get(win.webContents.id)?.pantalla;
  if (!destino) return { action: 'deny' };
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      x: -20000,
      y: -20000,
      width: destino.bounds.width,
      height: destino.bounds.height,
      frame: false,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#000000',
      skipTaskbar: true,
      autoHideMenuBar: true,
      title: 'Quire — presentación',
    },
  };
}

/** Se engancha a la ventana principal: atiende a la sala cuando nace. */
function vigilar(win) {
  const id = win.webContents.id;
  win.webContents.on('did-create-window', (sala, { frameName }) => {
    if (frameName !== NOMBRE_SALA) return;
    const datos = salas.get(id);
    if (!datos) { sala.close(); return; }
    datos.sala = sala;
    sala.setMenu(null);
    const avisar = (canal) => { if (!win.isDestroyed()) win.webContents.send(canal); };
    let mostrada = false;
    const mostrar = () => {
      if (mostrada || sala.isDestroyed()) return;
      mostrada = true;
      // Sin robarle el foco a la ventana del orador: el teclado sigue ahí.
      sala.showInactive();
      setTimeout(() => {
        if (sala.isDestroyed()) return;
        mudarSala(sala, datos.pantalla).then(() => avisar('pres:sala-lista'));
      }, 200);
    };
    sala.once('ready-to-show', mostrar);
    setTimeout(mostrar, 600);
    sala.on('closed', () => {
      if (datos.sala === sala) datos.sala = null;
      avisar('pres:sala-cerrada');
    });
  });
  win.on('closed', () => salas.delete(id));
}

/* Si se desenchufa el proyector, Windows muda la sala al monitor que queda y
   taparía al orador: se cierra, y el renderer sigue en una sola pantalla. */
function alSacarPantalla(_e, pantalla) {
  for (const datos of salas.values()) {
    if (datos.sala && !datos.sala.isDestroyed() && datos.pantalla.id === pantalla.id) datos.sala.close();
  }
}

let registrado = false;
function registrar(handle) {
  if (registrado) return;
  registrado = true;
  /* screen se toca recién al presentar: antes de que la app esté lista no
     existe, y el test del proceso principal lo simula sin él. */
  let escuchando = false;

  const ventanaDe = (e) => BrowserWindow.fromWebContents(e.sender);

  /* Antes de abrir la sala: dónde iría. Sin otra pantalla, la presentación
     va en la misma ventana. */
  handle('pres:preparar', (e) => {
    const win = ventanaDe(e);
    if (!win) return { dual: false };
    if (!escuchando) { screen.on('display-removed', alSacarPantalla); escuchando = true; }
    const pantalla = pantallaParaSala(win);
    if (!pantalla) { salas.delete(e.sender.id); return { dual: false }; }
    salas.set(e.sender.id, { pantalla, sala: null });
    return { dual: true, ancho: pantalla.bounds.width, alto: pantalla.bounds.height };
  }, true);

  handle('pres:pantalla-completa', (e, on) => ponerPantallaCompleta(ventanaDe(e), !!on), true);

  /* Intercambiar: la sala va al monitor del orador y el orador al de la sala.
     Para cuando Windows numeró los monitores al revés de lo que uno espera. */
  handle('pres:intercambiar', async (e) => {
    const win = ventanaDe(e);
    const datos = salas.get(e.sender.id);
    if (!win || !datos?.sala || datos.sala.isDestroyed() || datos.pantalla.id === SALA_FICTICIA.id) return false;
    const propia = pantallaDe(win);
    const otra = datos.pantalla;
    await ponerPantallaCompleta(win, false);
    const b = win.getBounds();
    const a = otra.workArea;
    win.setBounds({
      x: Math.round(a.x + Math.max(0, (a.width - b.width) / 2)),
      y: Math.round(a.y + Math.max(0, (a.height - b.height) / 2)),
      width: Math.min(b.width, a.width),
      height: Math.min(b.height, a.height),
    });
    await ponerPantallaCompleta(win, true);
    datos.pantalla = propia;
    await mudarSala(datos.sala, propia);
    return true;
  }, true);

  handle('pres:cerrar-sala', (e) => {
    const datos = salas.get(e.sender.id);
    if (datos?.sala && !datos.sala.isDestroyed()) datos.sala.close();
    salas.delete(e.sender.id);
    return true;
  }, true);
}

module.exports = { registrar, vigilar, abrirVentana, NOMBRE_SALA };
