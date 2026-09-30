/* ═══════════════════════════════════════════════════════════════════════════
   Datos propios para una prueba que arranca la app.

   Sin esto, la prueba usa el `data/` del repo: abrir un documento escribe la
   sesión (ultimosDocumentos) y los recientes, y los PDFs de prueba viven en
   carpetas temporales que se borran al terminar. La siguiente prueba —o la
   app— arrancaba intentando reabrir un archivo que ya no existe, y esa
   advertencia de consola hacía fallar a cartel o convertir según el orden en
   que corrieran. Y al revés: una sesión real guardada hacía que la prueba
   arrancara con pestañas que no abrió ella.

   Se llama ANTES de requerir nada de src/: store.cjs lee QUIRE_DATA una sola
   vez, al cargarse.

     require('./datos-propios.cjs')('humo');

   La carpeta se borra al salir. Va envolviendo app.exit porque Electron sale
   por ahí sin disparar el 'exit' de Node (medido: con app.exit(0), (1) y (3)
   un process.on('exit') no corre), y cada prueba tiene varias salidas —el
   final, abortar, el timeout—, todas por app.exit.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = function datosPropios(nombre) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `quire-${nombre}-datos-`));
  process.env.QUIRE_DATA = dir;

  const salir = app.exit.bind(app);
  app.exit = (codigo) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ya no está */ }
    salir(codigo);
  };
  return dir;
};
