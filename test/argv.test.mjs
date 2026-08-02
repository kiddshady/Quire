/* ═══════════════════════════════════════════════════════════════════════════
   El archivo con el que te abrieron.

   Existe porque durante la 0.1.1 la asociación de archivo "funcionaba" —el
   ícono de los PDF cambiaba al de Quire y el doble click levantaba la app—
   pero el documento no aparecía nunca: nadie miraba `process.argv`. El síntoma
   es engañoso, porque todo lo visible anda.

   Es parseo puro, así que corre con Node pelado y sin Electron.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { rutaDeArgv } = require('../src/argv.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const EXE = 'C:\\Program Files\\Quire\\Quire.exe';
const ELECTRON = 'C:\\proj\\node_modules\\electron\\dist\\electron.exe';
const PDF = 'C:\\Users\\francisco\\Documentos\\manual.pdf';

console.log('\n1. Los dos formatos de argv');
ok('empaquetada: la ruta viene en argv[1]',
  rutaDeArgv([EXE, PDF], true) === PDF, rutaDeArgv([EXE, PDF], true));
ok('en desarrollo hay un "." de más antes del archivo',
  rutaDeArgv([ELECTRON, '.', PDF], false) === PDF, rutaDeArgv([ELECTRON, '.', PDF], false));

/* La bandera no es cosmética: con el slice de desarrollo, el argv de la app
   empaquetada se queda sin argumentos y el doble click no abre nada. Es
   exactamente el bug que este módulo vino a evitar. */
ok('la bandera importa: argv de empaquetada leído como dev pierde el archivo',
  rutaDeArgv([EXE, PDF], false) === null);

console.log('\n2. Arrancar sin archivo');
ok('empaquetada, a secas', rutaDeArgv([EXE], true) === null);
ok('en desarrollo, a secas', rutaDeArgv([ELECTRON, '.'], false) === null);
ok('el "." del proyecto no es un documento', rutaDeArgv([ELECTRON, '.'], true) === null);
ok('--dev no es un documento', rutaDeArgv([ELECTRON, '.', '--dev'], false) === null);

console.log('\n3. Switches de Chromium en el mismo argv');
ok('se saltean y encuentra el archivo',
  rutaDeArgv([EXE, '--no-sandbox', PDF], true) === PDF);
ok('un switch que TERMINA en .pdf no es un archivo',
  rutaDeArgv([EXE, '--user-data-dir=C:\\tmp\\cache.pdf'], true) === null);

console.log('\n4. Qué cuenta como PDF');
ok('la extensión no distingue mayúsculas',
  rutaDeArgv([EXE, 'C:\\x\\MANUAL.PDF'], true) === 'C:\\x\\MANUAL.PDF');
ok('otra extensión se ignora', rutaDeArgv([EXE, 'C:\\x\\foto.png'], true) === null);
ok('las rutas con espacios llegan enteras',
  rutaDeArgv([EXE, 'C:\\Mis Documentos\\el manual.pdf'], true) === 'C:\\Mis Documentos\\el manual.pdf');

console.log('\n5. Siempre absoluta');
/* `electron . doc.pdf` la manda relativa al cwd, y del otro lado se lee con fs
   desde el proceso principal — no desde donde la escribiste. */
ok('una ruta relativa se resuelve contra el cwd',
  rutaDeArgv([ELECTRON, '.', 'doc.pdf'], false) === path.resolve('doc.pdf'));

console.log('\n6. Entradas rotas');
ok('argv que no es lista', rutaDeArgv(null, true) === null);
ok('lista vacía', rutaDeArgv([], true) === null);
ok('elementos que no son strings', rutaDeArgv([EXE, 42, null, PDF], true) === PDF);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
process.exit(fail ? 1 : 0);
