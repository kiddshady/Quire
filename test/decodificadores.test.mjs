/* ═══════════════════════════════════════════════════════════════════════════
   Los decodificadores de imágenes de pdf.js.

   pdf.js 5 decodifica JBIG2 (el blanco y negro de casi todo paper escaneado),
   JPEG 2000 y el color con módulos en WebAssembly que busca en `wasmUrl`. Sin
   esa ruta no avisa nada visible: la imagen no se dibuja y la hoja queda en
   blanco, mientras Chrome la muestra bien. Pasó en octubre de 2026 con un
   paper escaneado de Química Medicinal, en el lector y en el motor de
   conversión (que además le daba hojas en blanco al OCR).

   El paper no puede entrar al repo, así que esto cuida la causa: que los dos
   pdf.js reciban la ruta, y que en esa carpeta esté cada archivo que su worker
   pide por nombre. Si se actualiza pdf.js y cambian los nombres, falla acá.

   Node pelado: lee archivos, no abre ningún PDF.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const RAIZ = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

/** Los archivos de decodificadores que un worker de pdf.js pide por nombre. */
function pedidos(worker) {
  const src = fs.readFileSync(worker, 'utf8');
  return [...new Set(src.match(/\b[a-z][a-z0-9]{2,}(?:_nowasm_fallback\.js|(?:_bg)?\.wasm)/g) || [])]
    // quickjs es el que corre el JavaScript de un PDF: va apagado (isEvalSupported: false).
    .filter((n) => !n.startsWith('quickjs'));
}

function revisar(nombre, worker, carpeta) {
  const lista = pedidos(worker);
  ok(`${nombre}: el worker pide JBIG2, JPEG 2000 y color`,
    ['jbig2.wasm', 'openjpeg.wasm'].every((n) => lista.includes(n)) && lista.some((n) => n.startsWith('qcms')),
    lista.join(', '));
  const faltan = lista.filter((n) => !fs.existsSync(path.join(carpeta, n)));
  ok(`${nombre}: están todos en ${path.relative(RAIZ, carpeta)}`, !faltan.length, `faltan ${faltan.join(', ')}`);
}

console.log('\n1. El lector (pdf.js vendorizado)');
const VENDOR = path.join(RAIZ, 'renderer', 'vendor', 'pdfjs');
revisar('lector', path.join(VENDOR, 'pdf.worker.mjs'), path.join(VENDOR, 'wasm'));
const documento = fs.readFileSync(path.join(RAIZ, 'renderer', 'js', 'pdf', 'documento.js'), 'utf8');
ok('documento.js le pasa wasmUrl a getDocument', /wasmUrl:\s*VENDOR\s*\+\s*'wasm\/'/.test(documento));

console.log('\n2. El motor de conversión (pdfjs-dist de node_modules)');
const DIST = path.dirname(require.resolve('pdfjs-dist/package.json'));
revisar('motor', path.join(DIST, 'legacy', 'build', 'pdf.worker.mjs'), path.join(DIST, 'wasm'));
const motor = fs.readFileSync(path.join(RAIZ, 'src', 'motor', 'converters', 'pdf.cjs'), 'utf8');
ok('pdf.cjs le pasa wasmUrl a getDocument', /wasmUrl:\s*WASM_URL/.test(motor));

console.log('\n3. Se empaquetan');
const files = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).build.files;
ok('build.files no excluye las carpetas wasm',
  !files.some((f) => f.startsWith('!') && /wasm|pdfjs\/\*\*|pdfjs-dist\/\*\*/.test(f)), files.join(' '));

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
