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

/**
 * Un lote de conversión pedido desde la línea de comandos, o null.
 *
 *     Quire.exe --convertir examen.htm apuntes.pdf --a pdf,md
 *
 * Sin ventana: convierte, deja las salidas al lado de cada original y sale
 * con 0 si todo salió, 1 si algo falló. Es la forma de convertir desde un
 * script o de probar el motor en la app empaquetada. `--a` (o `--a=`) elige
 * las salidas, separadas por coma; sin `--a` sale un PDF.
 *
 * @returns {{ files: string[], outputs: string[] } | null}
 */
function loteDeArgv(argv, empaquetada) {
  if (!Array.isArray(argv)) return null;
  const args = argv.slice(empaquetada ? 1 : 2).filter((a) => typeof a === 'string');
  const en = args.indexOf('--convertir');
  if (en === -1) return null;

  const files = [];
  let outputs = ['pdf'];
  for (let i = en + 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--a') { outputs = partirSalidas(args[++i]); continue; }
    if (a.startsWith('--a=')) { outputs = partirSalidas(a.slice(4)); continue; }
    if (a.startsWith('-')) continue;           // switches de Chromium/Electron
    if (a.trim()) files.push(path.resolve(a.trim()));
  }
  return { files, outputs };
}

/* Los nombres cortos que uno escribe → los del registro del motor. */
const ALIAS_SALIDA = { md: 'markdown', markdown: 'markdown', txt: 'txt', texto: 'txt', json: 'json', chunks: 'chunks', pdf: 'pdf' };

function partirSalidas(texto) {
  const lista = String(texto || '').split(',').map((s) => ALIAS_SALIDA[s.trim().toLowerCase()]).filter(Boolean);
  return lista.length ? [...new Set(lista)] : ['pdf'];
}

module.exports = { rutaDeArgv, loteDeArgv };
