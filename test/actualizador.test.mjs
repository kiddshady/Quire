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

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
process.exit(fail ? 1 : 0);
