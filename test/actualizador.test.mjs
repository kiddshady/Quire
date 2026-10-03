/* ═══════════════════════════════════════════════════════════════════════════
   Las decisiones del actualizador.

   Lo que se prueba acá no es electron-updater —eso es de otros— sino las dos
   cosas que sí son nuestras y que se rompen en silencio:

     · dónde NO hay que ofrecer actualizar, para no prometer algo que va a
       fallar (desde el código fuente, y la versión portable);
     · qué se le muestra al usuario cuando algo falla, porque el error crudo de
       electron-updater viene con stack y URL adentro.

   El módulo se carga con Node pelado a propósito: si algún día alguien le pone
   un `require('electron')` arriba de todo sin la red de seguridad, este test
   deja de correr y se nota.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const upd = require('../src/actualizador.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

console.log('\n1. Dónde se puede actualizar solo');
const fuente = upd.soporte({ empaquetada: false, portable: false });
const portable = upd.soporte({ empaquetada: true, portable: true });
const instalada = upd.soporte({ empaquetada: true, portable: false });

ok('instalada: sí', instalada.ok === true);
ok('y sin motivo que mostrar', instalada.motivo === '');
ok('desde el código fuente: no', fuente.ok === false);
ok('y lo explica', /código fuente/i.test(fuente.motivo), fuente.motivo);
ok('portable: no', portable.ok === false);
ok('y dice qué hacer en su lugar', /reemplaz/i.test(portable.motivo), portable.motivo);
/* Sin argumentos tiene que dar NO. Un default permisivo acá significa ofrecer
   una actualización que después revienta. */
ok('sin datos, no', upd.soporte().ok === false);

console.log('\n2. El error que ve el usuario');
ok('sin internet', upd.mensaje(new Error('getaddrinfo ENOTFOUND github.com')) === 'No se pudo llegar a GitHub. ¿Hay internet?');
ok('sin ruta a la red', /¿Hay internet\?/.test(upd.mensaje(new Error('connect ENETUNREACH 140.82.0.1'))));
ok('timeout', /no contestó a tiempo/.test(upd.mensaje(new Error('ESOCKETTIMEDOUT'))));
ok('404: falta el archivo de la versión', /no tiene el archivo/.test(upd.mensaje(new Error('HttpError: 404 Not Found'))));
ok('se queda con la primera línea', upd.mensaje(new Error('Se rompió algo\n  at Foo (bar.js:1)')) === 'Se rompió algo');
ok('un string pelado también sirve', upd.mensaje('qué sé yo') === 'qué sé yo');
ok('sin nada, no explota', upd.mensaje(null) === 'Error desconocido');

console.log('\n3. Sin iniciar(), nada se dispara');
/* El módulo entero tiene que ser inerte hasta que la app lo prenda: si estas
   tres hicieran algo sin autoUpdater, un test o un arranque a medias saldría
   a la red o cerraría la app. */
ok('el estado arranca inactivo', upd.leer().fase === 'inactivo');
ok('buscar no explota', await upd.buscar({ manual: true }).then(() => true, () => false));
ok('descargar no explota', await upd.descargar().then(() => true, () => false));
ok('instalar dice que no', upd.instalar() === false);
ok('y el estado sigue intacto', upd.leer().fase === 'inactivo');

/* ── Con un electron-updater de mentira ─────────────────────────────────────
   Para lo que pasa DESPUÉS de iniciar() hace falta un autoUpdater. Se pone uno
   de mentira en el caché de require (y un `app` empaquetado), y se carga una
   copia nueva del módulo, que lee los dos al cargarse. La de arriba sigue
   siendo la de Node pelado. */

const claveElectron = require.resolve('electron');
const claveUpdater = require.resolve('electron-updater');
const claveModulo = require.resolve('../src/actualizador.cjs');
const enCache = (clave, exports) => { require.cache[clave] = { id: clave, filename: clave, loaded: true, exports }; };

/* Imita a electron-updater 6.8.9 en lo que importa: checkForUpdates emite
   update-available aunque la versión ya esté bajada (AppUpdater.js:400-429). */
class UpdaterDeMentira extends EventEmitter {
  constructor() { super(); this.sinRed = false; this.instalo = false; this.busquedas = 0; }
  async checkForUpdates() {
    this.busquedas++;
    this.emit('checking-for-update');
    if (this.sinRed) {
      const err = new Error('getaddrinfo ENOTFOUND github.com');
      this.emit('error', err);
      throw err;
    }
    this.emit('update-available', { version: '9.9.9', files: [{ size: 1000 }] });
    return {};
  }
  async downloadUpdate() {
    this.emit('download-progress', { percent: 50, transferred: 500, total: 1000 });
    this.emit('update-downloaded', { version: '9.9.9' });
  }
  quitAndInstall() { this.instalo = true; }
}

function cargarConUpdater(exportsDelUpdater) {
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  enCache(claveElectron, { app: { isPackaged: true, getVersion: () => '0.9.9' } });
  if (exportsDelUpdater) enCache(claveUpdater, exportsDelUpdater);
  delete require.cache[claveModulo];
  return require('../src/actualizador.cjs');
}

console.log('\n4. Con la actualización ya bajada (main-13)');
/* Una ventana de mentira que anota lo que se le manda. El renderer solo se
   entera por 'update:cambio' (app.js ignora lo que devuelve buscar), así que
   lo que no sale por ahí, para la interfaz, no pasó. */
const enviados = [];
const ventana = { isDestroyed: () => false, webContents: { send: (canal, e) => enviados.push({ canal, e: { ...e } }) } };
const falso = new UpdaterDeMentira();
const vivo = cargarConUpdater({ autoUpdater: falso });
vivo.iniciar(() => ventana);
await vivo.buscar();
ok('buscar encuentra la versión nueva', vivo.leer().fase === 'disponible', vivo.leer().fase);
await vivo.descargar();
ok('descargar la deja lista', vivo.leer().fase === 'listo', vivo.leer().fase);
enviados.length = 0;
const busquedasAntes = falso.busquedas;
await vivo.buscar({ manual: true });
ok('buscar otra vez no la devuelve a «disponible»', vivo.leer().fase === 'listo', vivo.leer().fase);
ok('ni sale a buscar de nuevo', falso.busquedas === busquedasAntes, `${falso.busquedas - busquedasAntes} búsquedas`);
/* El botón de Ajustes no puede quedar mudo: con el cartel de «lista» ya
   anunciado y cerrado, lo único que lo vuelve a abrir es un aviso con
   manual:true (actualizar.js, loPediste). */
ok('pero avisa, y el cartel se abre con «Reiniciar»',
  enviados.some(({ canal, e }) => canal === 'update:cambio' && e.manual === true && e.fase === 'listo'),
  JSON.stringify(enviados.map(({ canal, e }) => ({ canal, fase: e.fase, manual: e.manual }))));
falso.sinRed = true;
await vivo.buscar({ manual: true });
falso.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
ok('un error después no esconde lo que ya está bajado', vivo.leer().fase === 'listo', vivo.leer().fase);
ok('y se puede instalar', vivo.instalar() === true);
await new Promise((r) => setImmediate(r));
ok('instalar llama a quitAndInstall', falso.instalo === true);

/* Lo de siempre no cambia: sin nada bajado, un error sigue siendo un error. */
const otro = new UpdaterDeMentira();
otro.sinRed = true;
const sinBajar = cargarConUpdater({ autoUpdater: otro });
sinBajar.iniciar(() => null);
await sinBajar.buscar({ manual: true });
ok('sin nada bajado, sin internet sigue siendo un error', sinBajar.leer().fase === 'error'
  && /internet/.test(sinBajar.leer().error), JSON.stringify(sinBajar.leer()));

console.log('\n5. Si electron-updater no carga, Quire arranca igual (main-11)');
/* Un caché cuyo `exports` revienta al leerlo es un require que tira, como el
   de una instalación rota. */
require.cache[claveUpdater] = {
  id: claveUpdater, filename: claveUpdater, loaded: true,
  get exports() { throw new Error('Cannot find module \'electron-updater\''); },
};
const roto = cargarConUpdater(null);
let tiro = false;
try { roto.iniciar(() => null); } catch { tiro = true; }
ok('iniciar no tira', tiro === false);
ok('queda en error, con el motivo', roto.leer().fase === 'error' && /actualizador/.test(roto.leer().error), JSON.stringify(roto.leer()));
ok('y buscar no hace nada', await roto.buscar({ manual: true }).then((e) => e.fase === 'error', () => false));

delete require.cache[claveUpdater];
delete require.cache[claveElectron];
delete require.cache[claveModulo];

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
process.exit(fail ? 1 : 0);
