'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el archivo con el que te abrieron

   Doble click en un .pdf no le "pasa" el archivo a la app: Windows ejecuta
   `Quire.exe "C:\ruta\al.pdf"` y se desentiende. Si nadie mira `argv`, la app
   abre vacía y la asociación de archivo no sirve para nada — el ícono cambia,
   el doble click "funciona", y el documento no aparece por ningún lado.

   Este módulo NO hace require('electron') a propósito: así se puede probar con
   Node pelado. Todo lo de acá es parseo de strings, y el parseo se prueba con
   una lista de strings.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('node:path');

/**
 * La ruta del PDF que venía en la línea de comandos, o null.
 *
 * @param {string[]} argv        `process.argv` tal cual, o el que llega en
 *                               'second-instance'.
 * @param {boolean} empaquetada  `app.isPackaged`.
 * @returns {string|null} ruta absoluta.
 *
 * Los dos formatos son distintos, y confundirlos es el error clásico:
 *
 *     empaquetada    [Quire.exe, C:\cosas\manual.pdf]
 *     en desarrollo  [electron.exe, ., C:\cosas\manual.pdf]
 *
 * En desarrollo hay un argumento de más —el "." del proyecto—, así que agarrar
 * `argv[1]` a ciegas terminaría tratando el directorio de la app como si fuera
 * un documento.
 */
function rutaDeArgv(argv, empaquetada) {
  if (!Array.isArray(argv)) return null;
  const args = argv.slice(empaquetada ? 1 : 2);

  /* En el mismo argv viajan los switches de Chromium y de Electron (--dev,
     --no-sandbox, --inspect=…, --user-data-dir=…). Ninguno es un archivo, y
     alguno hasta termina en .pdf si el usuario eligió mal una carpeta. */
  const candidato = args.find((a) => (
    typeof a === 'string' && !a.startsWith('-') && /\.pdf$/i.test(a.trim())
  ));

  /* Absoluta siempre: Windows la manda absoluta, pero `electron . doc.pdf`
     la manda relativa al cwd, y del otro lado se lee con fs. */
  return candidato ? path.resolve(candidato.trim()) : null;
}

module.exports = { rutaDeArgv };
