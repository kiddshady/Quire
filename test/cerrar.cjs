'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Cerrar sin perder el último trazo.

   Este test levanta la app DE VERDAD —requiere main.cjs, no una ventana de
   juguete— porque lo que se prueba vive justamente en el main: el `close` que
   se cancela, el pedido al renderer y el aviso de vuelta.

   Prueba dos cosas, y la segunda importa más que la primera:

   · Que la tinta recién dibujada llegue al disco. La capa guarda con 900 ms de
     retardo, así que se dibuja y se cierra ENSEGUIDA: sin el guardado al
     cerrar, la ventana se va antes de que el temporizador dispare y el trazo
     no existe en ningún lado.

   · Que la app SIGA CERRÁNDOSE. Atajar el `close` para guardar es meterse en
     el único camino que tiene el usuario para irse: un error acá deja una
     ventana que no se puede cerrar más que por el administrador de tareas.
     Peor todavía, es un bug que ninguna otra suite ve — todas matan el proceso
     a la fuerza al terminar. Por eso se mide el tiempo: cerrar por el timeout
     de 3 s del main también "cierra", pero significa que el renderer no
     contestó y eso es una falla, no un éxito.

   Ojo: la ventana de la app aparece en pantalla un segundo. Es la app real.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RAIZ = path.join(__dirname, '..');
const PDF = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* Datos propios, antes de requerir nada de src/: store.cjs resuelve su raíz al
   cargarse. Y `--dev` antes de main.cjs, que lee DEV al cargarse también: sin
   eso el lock de instancia única mata este proceso si tenés Quire abierta. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-cerrar-'));
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });
if (!process.argv.includes('--dev')) process.argv.push('--dev');

const { app, BrowserWindow } = require('electron');
require(path.join(RAIZ, 'main.cjs'));           // la app de verdad

const problemas = [];
let pass = 0;
let dejarSalir = false;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(que); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

/* main.cjs cierra la app cuando se va su última ventana, y eso mataría este
   proceso antes de poder contar nada. Se ataja hasta que terminamos. */
app.on('before-quit', (e) => { if (!dejarSalir) e.preventDefault(); });

/* Red de seguridad del test entero: si la ventana no cierra nunca —que es
   exactamente el bug que buscamos— sin esto el test se cuelga en vez de
   fallar, y un test colgado traba la suite sin decir qué pasó. */
const abandono = setTimeout(() => {
  console.log('\n  FALLA la app no cerró en 15 s: se abandona');
  terminar(1);
}, 15000);

(async () => {
  await app.whenReady();

  const win = await hasta(() => BrowserWindow.getAllWindows()[0], 10000, 'la ventana no apareció');
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await esperar(1800);                          // que boot() termine de arrancar

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

  /* ── Dibujar y cerrar en el acto ───────────────────────────────────────── */
  console.log('\n1. Un trazo recién hecho, sin tiempo de guardarse');

  const estado = await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDF)}));
    est.S.tinta.agregar(1, {
      herramienta: 'pluma', color: '#111111', ancho: 2, opacidad: 1,
      puntos: [{ x: 40, y: 40 }, { x: 120, y: 90 }],
    });
    return { id: est.S.tinta.id, sucia: est.S.tinta.sucia, trazos: est.S.tinta.cuenta };
  })()`);

  const archivo = path.join(process.env.QUIRE_DATA, 'tinta', `${estado.id}.json`);
  ok('el trazo existe en memoria', estado.trazos === 1, `${estado.trazos}`);
  ok('y todavía NO está en disco', estado.sucia && !fs.existsSync(archivo),
    `sucia=${estado.sucia} existe=${fs.existsSync(archivo)}`);

  /* ── Cerrar ────────────────────────────────────────────────────────────── */
  console.log('\n2. Cerrar la ventana');

  const arranque = Date.now();
  const cerrada = new Promise((r) => win.once('closed', r));
  win.close();
  await cerrada;
  const tardo = Date.now() - arranque;

  ok('la ventana se cierra', true);
  /* Menos que el timeout del main con margen. Si tardó 3 s, cerró por
     abandono: el renderer no contestó y el guardado no está garantizado. */
  ok('y cierra porque el renderer contestó, no por el timeout', tardo < 2500, `${tardo} ms`);

  /* ── Lo que quedó escrito ──────────────────────────────────────────────── */
  console.log('\n3. El trazo sobrevivió');

  let guardado = null;
  try { guardado = JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch (e) { guardado = `no se pudo leer: ${e.code || e.message}`; }

  const trazos = guardado?.paginas ? Object.values(guardado.paginas).flat().length : guardado;
  ok('la tinta se escribió al cerrar', trazos === 1, String(trazos));

  const sesion = leerJSON(path.join(process.env.QUIRE_DATA, 'settings.json'));
  ok('y la sesión quedó anotada', Array.isArray(sesion?.ultimosDocumentos) && sesion.ultimosDocumentos.length === 1,
    JSON.stringify(sesion?.ultimosDocumentos));

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
