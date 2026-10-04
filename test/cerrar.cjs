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

   La ventana es la de la app real, pero con QUIRE_FUERA=1 nace y se queda en
   -20000, mostrada sin tomar el foco (tests-09): esta suite y apertura, que
   levantan main.cjs, ya no le ponen Quire encima a Fran ni le roban el foco.
   Acá se afirman las dos, abajo. (Las suites que arman su propia ventana
   tienen su propio cuidado: el smoke la muestra sin activarla y emula el
   foco para los anillos; pestanas todavía la enfoca.)
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
process.env.QUIRE_FUERA = '1';

const { hasta, esperar, vigilarConsola } = require('./_comun.cjs');

const { app, BrowserWindow } = require('electron');
require(path.join(RAIZ, 'main.cjs'));           // la app de verdad

const problemas = [];
/* Lo que el renderer escriba en la consola mientras guarda y cierra
   (tests-10). Era la única suite con ventana que no la escuchaba: una
   excepción durante el guardado al cerrar, si no frenaba el cierre, pasaba
   verde. */
const consola = [];
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
  vigilarConsola(win, consola);
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await esperar(1800);                          // que boot() termine de arrancar

  /* main.cjs muestra la ventana en -20000 y a los 200 ms la lleva a su lugar.
     Con QUIRE_FUERA=1 no la mueve: si esto falla, verificar le está poniendo
     la app en el escritorio a Fran. */
  ok('la ventana se queda fuera de pantalla (QUIRE_FUERA)', win.getPosition()[0] <= -10000, JSON.stringify(win.getPosition()));
  ok('y no se llevó el foco del escritorio', !win.isFocused());

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

  /* Que cierre lo dice haber llegado acá: si no cerraba, el que avisa es el
     abandono de 15 s. Lo que se mide es CÓMO cerró. Menos que el timeout del
     main con margen: si tardó 3 s, cerró por abandono, el renderer no
     contestó y el guardado no está garantizado. */
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

  ok('y el renderer no se quejó en la consola mientras cerraba', consola.length === 0, consola.join(' | '));

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

const leerJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
