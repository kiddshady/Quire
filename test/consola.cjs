/* ═══════════════════════════════════════════════════════════════════════════
   Qué mensajes de consola del renderer cuentan como problema.

   Los smokes se enganchan a 'console-message' para que una excepción en el
   renderer haga fallar el test aunque el DOM se vea bien. Y durante mucho
   tiempo no lo hizo: comparaban `e.level >= 2`, y el evento cambió de forma.
   En los Electron viejos el nivel era un número en los argumentos
   posicionales (0 verbose, 1 info, 2 warning, 3 error); desde que el evento
   es un objeto —el `e` que reciben los tests— `e.level` es TEXTO: 'debug',
   'info', 'warning' o 'error'. Con un string, `'error' >= 2` es false,
   siempre. Ningún error de consola quedó anotado nunca y los tests daban
   verde con el renderer tirando excepciones. Verificado en Electron 40.10.2:
   un console.warn deliberado en el lector no apareció en la lista.

   Por eso el criterio vive acá, en UN lugar, y no repetido en cada smoke: la
   próxima vez que Electron cambie el evento se arregla una vez.
   ═══════════════════════════════════════════════════════════════════════════ */

const GRAVES = new Set(['warning', 'error']);

/** Warning o error, venga el nivel como texto (Electron actual) o como número (los viejos). */
function esGrave(nivel) {
  if (typeof nivel === 'number') return nivel >= 2;
  return GRAVES.has(nivel);
}

/**
 * Anota en `lista` cada warning o error que el renderer de `win` escriba en
 * la consola, recortado para que un stack no tape el resto del reporte.
 */
function vigilarConsola(win, lista, { largo = 200 } = {}) {
  win.webContents.on('console-message', (e) => {
    if (esGrave(e.level)) lista.push(`consola[${e.level}] ${e.message.slice(0, largo)}`);
  });
}

module.exports = { vigilarConsola, esGrave };
