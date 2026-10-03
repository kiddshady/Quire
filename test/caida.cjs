'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Si el renderer se cae (main-12).

   Levanta la app DE VERDAD, como cerrar.cjs: lo que se prueba vive en el main
   ('render-process-gone', la recarga, el diálogo de la segunda caída). La
   caída se provoca con forcefullyCrashRenderer(), que para el main es lo
   mismo que un renderer que se quedó sin memoria con un PDF enorme.

   Lo que importa:

   · La primera caída se recarga sola y la sesión vuelve: un tropezón no te
     cierra las pestañas.
   · La segunda en menos de un minuto NO se recarga sola, y el diálogo ofrece
     una salida que de verdad existe. Antes ofrecía «Volver a cargar», que
     reabría la sesión —con el documento que la tiraba adentro— y se caía otra
     vez; y decía «abrila de nuevo sin ese documento», que tampoco se podía:
     al abrir Quire, la sesión lo reabría igual. Ahora «Volver a cargar sin los
     documentos» vacía la sesión antes de recargar.
   · Y con el renderer caído, cerrar pasa derecho, sin los 3 s de espera.

   El diálogo nativo se reemplaza por uno de mentira ANTES de cargar main.cjs:
   anota lo que se le pidió y contesta lo que elige el test, por el texto del
   botón (no por el índice, que es justo lo que puede cambiar).

   Con QUIRE_FUERA=1 la ventana nace y se queda fuera de pantalla.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RAIZ = path.join(__dirname, '..');
const PDF = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* Datos propios y `--dev` antes de requerir nada: store.cjs resuelve su raíz
   al cargarse, y main.cjs lee DEV y QUIRE_FUERA al cargarse también. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-caida-'));
process.env.QUIRE_DATA = path.join(TMP, 'datos');
process.env.QUIRE_FUERA = '1';
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });
if (!process.argv.includes('--dev')) process.argv.push('--dev');
const SETTINGS = path.join(process.env.QUIRE_DATA, 'settings.json');

const { app, BrowserWindow, dialog } = require('electron');

/* El diálogo de mentira. `elegir` recibe los botones y devuelve el índice. */
const dialogos = [];
let elegir = () => 0;
dialog.showMessageBox = async (_ventana, opciones) => {
  dialogos.push(opciones);
  return { response: elegir(opciones.buttons || []), checkboxChecked: false };
};

require(path.join(RAIZ, 'main.cjs'));           // la app de verdad

const problemas = [];
let pass = 0;
let dejarSalir = false;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(que); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

app.on('before-quit', (e) => { if (!dejarSalir) e.preventDefault(); });

const abandono = setTimeout(() => {
  console.log('\n  FALLA el test no terminó en 60 s: se abandona');
  terminar(1);
}, 60000);

(async () => {
  await app.whenReady();

  const win = await hasta(() => BrowserWindow.getAllWindows()[0], 10000, 'la ventana no apareció');
  if (win.webContents.isLoading()) await cargada(win);
  await esperar(1800);                          // que boot() termine de arrancar

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const cuantasPestanas = () => js(`import('./js/estado.js').then((est) => est.S.pestanas.length)`);
  const sesion = () => leerJSON(SETTINGS)?.ultimosDocumentos;

  await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDF)}));
  })()`);
  await hasta(() => sesion()?.[0] === PDF, 5000, 'la sesión no anotó el documento');

  /* ── La primera caída ──────────────────────────────────────────────────── */
  console.log('\n1. La primera caída se recarga sola');

  let recarga = cargada(win);
  win.webContents.forcefullyCrashRenderer();
  await recarga;
  await esperar(1800);
  ok('se recargó sin preguntar', dialogos.length === 0, `${dialogos.length} diálogos`);
  ok('y la sesión volvió', (await cuantasPestanas()) === 1);

  /* ── La segunda, enseguida ─────────────────────────────────────────────── */
  console.log('\n2. La segunda en menos de un minuto pregunta');

  elegir = (botones) => {
    const i = botones.findIndex((b) => /sin los documentos/i.test(b));
    /* Sin ese botón, lo que el diálogo de antes tenía primero: recargar. */
    return i >= 0 ? i : 0;
  };
  recarga = cargada(win);
  win.webContents.forcefullyCrashRenderer();
  await hasta(() => dialogos.length === 1, 5000, 'el diálogo no apareció');
  const d = dialogos[0];
  ok('ofrece volver a cargar sin los documentos', (d.buttons || []).some((b) => /sin los documentos/i.test(b)),
    JSON.stringify(d.buttons));
  ok('y no aconseja lo que no se puede hacer', !/abrila de nuevo sin ese documento/i.test(d.detail || ''), d.detail);

  await recarga;
  await esperar(1800);
  ok('la sesión quedó vacía', Array.isArray(sesion()) && sesion().length === 0, JSON.stringify(sesion()));
  ok('y la ventana volvió sin el documento que la tiraba', (await cuantasPestanas()) === 0);

  /* ── Cerrar con el renderer caído ──────────────────────────────────────── */
  console.log('\n3. Con el renderer caído, cerrar no espera');

  elegir = (botones) => botones.findIndex((b) => /cerrar/i.test(b));
  const cerrada = new Promise((r) => win.once('closed', r));
  win.webContents.forcefullyCrashRenderer();
  await hasta(() => dialogos.length === 2, 5000, 'el tercer diálogo no apareció');
  const arranque = Date.now();
  await cerrada;
  /* Muy por debajo de los 3 s del reloj de cierre: sin renderer no hay a quién
     esperar. */
  ok('«Cerrar Quire» cierra en el acto', Date.now() - arranque < 1500, `${Date.now() - arranque} ms`);

  terminar(problemas.length ? 1 : 0);
})().catch((err) => {
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  terminar(1);
});

function terminar(codigo) {
  clearTimeout(abandono);
  console.log(`\n═══ ${pass} ok · ${problemas.length} fallas ═══`);
  for (const p of problemas) console.log('  ! ' + p);
  dejarSalir = true;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ya no está */ }
  app.exit(codigo || (problemas.length ? 1 : 0));
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const leerJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cargada = (win) => new Promise((r) => win.webContents.once('did-finish-load', r));

/** Espera a que algo deje de ser falsy, o se rinde. */
async function hasta(fn, ms, mensaje) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const v = fn();
    if (v) return v;
    await esperar(120);
  }
  throw new Error(mensaje);
}
