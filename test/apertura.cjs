'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Abrir un PDF con doble click.

   Este test existe porque el bug que arregló no lo agarraba NINGUNA prueba de
   las otras: la asociación de archivo estaba bien, el ícono cambiaba, el doble
   click levantaba Quire — y el documento no aparecía, porque nadie miraba
   `process.argv`. Todo lo observable andaba.

   Por eso acá no se prueba una función: se lanza la app DE VERDAD, con la ruta
   en la línea de comandos, y se mira si el documento se cargó. La señal es
   `ultimoDocumento` en settings.json, que solo se escribe cuando un PDF
   terminó de abrirse en la vista (ver cargar() en renderer/js/app.js).

   Corre con Node pelado, no con Electron: lo que hace es lanzar procesos.

   Dos detalles del arnés:
   · `--user-data-dir` propio → el lock de instancia única del test no choca con
     el de la Quire instalada. Sin eso, tener la app abierta rompe el test.
   · Sin `--dev`, justamente para que el lock SÍ se pida (en dev se saltea).

   Ojo: la ventana de la app aparece en pantalla unos segundos. Es la app real.
   ═══════════════════════════════════════════════════════════════════════════ */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const ELECTRON = require(path.join(RAIZ, 'node_modules', 'electron'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-apertura-'));
const DATOS = path.join(TMP, 'datos');          // QUIRE_DATA
const PERFIL = path.join(TMP, 'chromium');      // userData, para aislar el lock
const SETTINGS = path.join(DATOS, 'settings.json');

const PDF_A = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');
const PDF_B = path.join(TMP, 'segundo.pdf');
fs.copyFileSync(PDF_A, PDF_B);

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function lanzar(...args) {
  return spawn(ELECTRON, ['.', `--user-data-dir=${PERFIL}`, ...args], {
    cwd: RAIZ,
    env: { ...process.env, QUIRE_DATA: DATOS },
    stdio: 'ignore',
  });
}

function matar(proc) {
  if (!proc || proc.exitCode !== null) return;
  // En Windows, matar el proceso padre de Electron deja vivos los hijos.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGKILL');
  }
}

/** Espera a que la app diga, por disco, que abrió ESE documento. */
async function abrio(ruta, ms = 30000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    try {
      if (JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).ultimoDocumento === ruta) return true;
    } catch { /* todavía no existe o está a medio escribir */ }
    await esperar(250);
  }
  return false;
}

(async () => {
  let primera = null;
  let segunda = null;

  try {
    console.log('\n1. Doble click con Quire cerrada');
    primera = lanzar(PDF_A);
    ok('el PDF de la línea de comandos se abre solo', await abrio(PDF_A));

    console.log('\n2. Doble click con Quire ya abierta');
    segunda = lanzar(PDF_B);
    const murio = await Promise.race([
      new Promise((r) => segunda.on('exit', () => r(true))),
      esperar(20000).then(() => false),
    ]);
    ok('la instancia nueva se muere sola en vez de abrir otra ventana', murio);
    ok('y le pasa el archivo a la que ya estaba', await abrio(PDF_B));
  } catch (err) {
    fail++;
    console.log(`  FALLA excepción: ${err.message}`);
  } finally {
    matar(segunda);
    matar(primera);
    await esperar(400);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  process.exit(fail ? 1 : 0);
})();
