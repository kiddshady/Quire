/* ═══════════════════════════════════════════════════════════════════════════
   Las cabeceras de imagen, que son las que deciden cuánto mide el papel.

   Una imagen no tiene medida física: tiene píxeles. El único dato que la
   convierte en milímetros está enterrado en la cabecera —un chunk `pHYs` en
   PNG, el segmento JFIF en JPEG— y si se lee mal, el error no se ve en
   pantalla: se ve cuando salió la hoja del tamaño equivocado.

   Los archivos de prueba se fabrican acá, byte por byte, en vez de guardar
   binarios en el repo. Así el test dice qué contiene cada caso en vez de
   confiar en que un .png de hace dos años sigue teniendo lo que decía.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import {
  DPI_POR_DEFECTO, dpiDeclarado, giroDeOrientacion, medidaDePagina, medirImagen, orientacionExif,
  pixelesDeCabecera,
} from '../renderer/js/imagenes.js';

const require = createRequire(import.meta.url);
const { formatoDe } = require('../src/firmas.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const casi = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/* ── Fabricantes ─────────────────────────────────────────────────────────── */

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Un PNG con los chunks que se le pidan. No hace falta que sea decodificable:
    lo que se prueba es el recorrido de la cadena de chunks. */
function png(chunks) {
  const partes = [Buffer.from(FIRMA_PNG)];
  for (const [tipo, datos] of chunks) {
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    // El CRC va en cero: nadie lo valida en el camino que estamos probando.
    partes.push(largo, Buffer.from(tipo, 'ascii'), datos, Buffer.alloc(4));
  }
  return new Uint8Array(Buffer.concat(partes));
}

const ihdr = (ancho, alto) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(ancho, 0); d.writeUInt32BE(alto, 4);
  d[8] = 8; d[9] = 6;
  return d;
};

/** pHYs: píxeles por unidad en X y en Y, y la unidad (1 = metro, 0 = ninguna). */
const phys = (porMetro, unidad = 1) => {
  const d = Buffer.alloc(9);
  d.writeUInt32BE(porMetro, 0); d.writeUInt32BE(porMetro, 4);
  d[8] = unidad;
  return d;
};

/** Un JPEG con los segmentos que se le pidan, terminado en SOS. Un número
    suelto en vez de un segmento es esa cantidad de bytes FF de relleno, que
    el estándar permite entre dos marcadores. */
function jpeg(segmentos) {
  const partes = [Buffer.from([0xff, 0xd8])];
  for (const seg of segmentos) {
    if (typeof seg === 'number') { partes.push(Buffer.alloc(seg, 0xff)); continue; }
    const [marca, cuerpo] = seg;
    const largo = Buffer.alloc(2);
    largo.writeUInt16BE(cuerpo.length + 2);
    partes.push(Buffer.from([0xff, marca]), largo, cuerpo);
  }
  partes.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));
  return new Uint8Array(Buffer.concat(partes));
}

/** APP0 de JFIF. `unidad`: 1 = por pulgada, 2 = por centímetro, 0 = ninguna. */
function jfif(densidad, unidad = 1) {
  const d = Buffer.alloc(14);
  d.write('JFIF\0', 0, 'latin1');
  d[5] = 1; d[6] = 2;                     // versión 1.02
  d[7] = unidad;
  d.writeUInt16BE(densidad, 8);
  d.writeUInt16BE(densidad, 10);
  return d;
}

/** APP1 con un EXIF de un solo tag: la orientación. En II o en MM. */
function exifOrientacion(valor, chico = true) {
  const d = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  d.write('Exif\0\0', 0, 'latin1');
  const t = 6;                             // acá arranca el TIFF
  const dos = (i, v) => (chico ? d.writeUInt16LE(v, i) : d.writeUInt16BE(v, i));
  const cuatro = (i, v) => (chico ? d.writeUInt32LE(v, i) : d.writeUInt32BE(v, i));

  d.write(chico ? 'II' : 'MM', t, 'latin1');
  dos(t + 2, 0x2a);
  cuatro(t + 4, 8);                        // el IFD0 arranca 8 bytes después del TIFF
  dos(t + 8, 1);                           // una sola entrada
  dos(t + 10, 0x0112);                     // tag Orientation
  dos(t + 12, 3);                          // tipo SHORT
  cuatro(t + 14, 1);                       // un valor
  dos(t + 18, valor);                      // y el valor, en los dos primeros bytes
  return d;
}

/** SOF: [precisión:1][alto:2][ancho:2][componentes:1]… */
function sof(ancho, alto) {
  const d = Buffer.alloc(6);
  d[0] = 8; d.writeUInt16BE(alto, 1); d.writeUInt16BE(ancho, 3); d[5] = 3;
  return d;
}

/** Un WEBP con un solo chunk: RIFF, el largo, «WEBP» y el chunk. */
function webp(tipo, datos) {
  const cab = Buffer.alloc(20);
  cab.write('RIFF', 0, 'latin1'); cab.writeUInt32LE(12 + datos.length, 4);
  cab.write('WEBP', 8, 'latin1'); cab.write(tipo, 12, 'latin1'); cab.writeUInt32LE(datos.length, 16);
  return new Uint8Array(Buffer.concat([cab, datos, Buffer.alloc(8)]));
}

/* ── 1. La firma dice qué es ─────────────────────────────────────────────── */

console.log('\n1. Reconocer el formato por la firma');
ok('%PDF es un PDF', formatoDe(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) === 'pdf');
ok('un PNG es un PNG', formatoDe(png([['IHDR', ihdr(10, 10)]])) === 'png');
ok('un JPEG es un JPEG', formatoDe(jpeg([[0xe0, jfif(72)]])) === 'jpeg');
ok('un RIFF con WEBP adentro es un WEBP',
  formatoDe(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')])) === 'webp');
// Un RIFF a secas es un WAV, un AVI o cualquier otra cosa. No entra.
ok('un RIFF que NO es WEBP no entra',
  formatoDe(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WAVE')])) === null);
ok('un archivo cortado no revienta', formatoDe(new Uint8Array([0x89, 0x50])) === null);
ok('un archivo vacío tampoco', formatoDe(new Uint8Array(0)) === null);
// Esto es el punto de todo: la extensión no participa de la decisión.
ok('texto plano no es nada', formatoDe(new Uint8Array(Buffer.from('hola, soy un .png'))) === null);

/* ── 2. La densidad del PNG ──────────────────────────────────────────────── */

console.log('\n2. PNG: el chunk pHYs');
// 300 dpi = 11811 píxeles por metro, que es como lo escribe todo el mundo.
ok('300 dpi (11811 ppm)', casi(dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['pHYs', phys(11811)]]), 'png'), 300, 0.05),
  String(dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['pHYs', phys(11811)]]), 'png')));
ok('150 dpi (5906 ppm)', casi(dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['pHYs', phys(5906)]]), 'png'), 150, 0.05));
ok('sin pHYs no declara nada', dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['IDAT', Buffer.alloc(8)]]), 'png') === null);
/* Unidad 0 significa "solo relación de aspecto": el número está pero no es una
   medida. Tomarlo como dpi daría una página de un tamaño inventado. */
ok('unidad 0 no es una medida', dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['pHYs', phys(11811, 0)]]), 'png') === null);
// pHYs va antes de los datos: si apareció IDAT, no estaba. Y así no se recorre
// un archivo de 40 MB entero para descubrir que no hay nada.
ok('corta en IDAT en vez de recorrer todo el archivo',
  dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['IDAT', Buffer.alloc(64)], ['pHYs', phys(11811)]]), 'png') === null);
ok('un PNG cortado no revienta', dpiDeclarado(new Uint8Array(FIRMA_PNG), 'png') === null);

/* ── 3. La densidad del JPEG ─────────────────────────────────────────────── */

console.log('\n3. JPEG: el segmento JFIF');
ok('300 por pulgada', dpiDeclarado(jpeg([[0xe0, jfif(300, 1)]]), 'jpeg') === 300);
ok('118 por centímetro son ~300 dpi', casi(dpiDeclarado(jpeg([[0xe0, jfif(118, 2)]]), 'jpeg'), 299.72, 0.01),
  String(dpiDeclarado(jpeg([[0xe0, jfif(118, 2)]]), 'jpeg')));
ok('unidad 0 no es una medida', dpiDeclarado(jpeg([[0xe0, jfif(72, 0)]]), 'jpeg') === null);
ok('sin JFIF no declara nada', dpiDeclarado(jpeg([[0xdb, Buffer.alloc(10)]]), 'jpeg') === null);
/* Una foto de teléfono arranca con el APP1 del EXIF y mete el JFIF después: si
   se asumiera que APP0 es el primer segmento, no se encontraría nunca. */
ok('encuentra el JFIF aunque el EXIF vaya primero',
  dpiDeclarado(jpeg([[0xe1, exifOrientacion(1)], [0xe0, jfif(200, 1)]]), 'jpeg') === 200);
ok('no se cuelga con un largo de segmento imposible',
  dpiDeclarado(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), 'jpeg') === null);

console.log('\n4. WEBP no tiene dónde declarar densidad');
ok('siempre null', dpiDeclarado(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')]), 'webp') === null);

/* ── 5. La orientación ───────────────────────────────────────────────────── */

console.log('\n5. La orientación del EXIF');
ok('sin EXIF está derecha', orientacionExif(jpeg([[0xe0, jfif(72)]]), 'jpeg') === 1);
ok('lee la 6 (girada 90°)', orientacionExif(jpeg([[0xe1, exifOrientacion(6)]]), 'jpeg') === 6);
ok('lee la 8 (girada 270°)', orientacionExif(jpeg([[0xe1, exifOrientacion(8)]]), 'jpeg') === 8);
// El orden de bytes lo declara el propio TIFF: hay cámaras de las dos escuelas.
ok('la lee igual en MM (big endian)', orientacionExif(jpeg([[0xe1, exifOrientacion(6, false)]]), 'jpeg') === 6);
ok('un valor fuera de rango se toma como derecha', orientacionExif(jpeg([[0xe1, exifOrientacion(99)]]), 'jpeg') === 1);
ok('un PNG está siempre derecho', orientacionExif(png([['IHDR', ihdr(4, 4)]]), 'png') === 1);

console.log('\n6. De orientación a giro de página');
ok('1 no gira', giroDeOrientacion(1) === 0);
ok('3 gira media vuelta', giroDeOrientacion(3) === 180);
ok('6 gira un cuarto', giroDeOrientacion(6) === 90);
ok('8 gira tres cuartos', giroDeOrientacion(8) === 270);
/* Los espejados no se pueden expresar con un /Rotate: se los trata como su
   giro equivalente. Dejar la foto acostada por culpa del espejo sería arreglar
   el caso raro rompiendo el común. */
ok('los espejados caen en su giro equivalente',
  giroDeOrientacion(2) === 0 && giroDeOrientacion(4) === 180
  && giroDeOrientacion(5) === 90 && giroDeOrientacion(7) === 270);
ok('un valor que no existe no gira', giroDeOrientacion(0) === 0 && giroDeOrientacion(undefined) === 0);

/* ── 7. De píxeles a papel ───────────────────────────────────────────────── */

console.log('\n7. El tamaño de la página');
// Una A4 escaneada a 300 dpi: 2480 × 3508 px tienen que volver a ser 595 × 842 pt.
{
  const p = medidaDePagina({ ancho: 2480, alto: 3508 }, 300);
  ok('A4 a 300 dpi vuelve a medir A4', casi(p.ancho, 595.2, 0.1) && casi(p.alto, 841.92, 0.1),
    `${p.ancho} × ${p.alto} pt`);
}
{
  // Sin densidad declarada, píxeles de pantalla: 96 px son una pulgada = 72 pt.
  const p = medidaDePagina({ ancho: 960, alto: 480 }, null);
  ok(`sin densidad usa ${DPI_POR_DEFECTO} dpi`, p.ancho === 720 && p.alto === 360, `${p.ancho} × ${p.alto} pt`);
}
{
  const p = medidaDePagina({ ancho: 960, alto: 480 }, 96, 90);
  ok('con la hoja de costado, la medida se da vuelta', p.ancho === 360 && p.alto === 720,
    `${p.ancho} × ${p.alto} pt`);
}
{
  const p = medidaDePagina({ ancho: 960, alto: 480 }, 96, 180);
  ok('media vuelta NO la da vuelta', p.ancho === 720 && p.alto === 360, `${p.ancho} × ${p.alto} pt`);
}
{
  // El redondeo existe para esto: 11811 ppm dan 299,9994 dpi, y sin redondear
  // una A4 escaneada salía de 297,0006 mm y dejaba de llamarse "A4".
  const dpi = dpiDeclarado(png([['IHDR', ihdr(2480, 3508)], ['pHYs', phys(11811)]]), 'png');
  const p = medidaDePagina({ ancho: 2480, alto: 3508 }, dpi);
  const altoMM = p.alto / 72 * 25.4;
  ok('el redondeo del dpi deja la A4 dentro de la tolerancia de 1,5 mm',
    Math.abs(altoMM - 297) < 1.5, `${altoMM.toFixed(3)} mm`);
}

/* ── 8. Los rellenos entre segmentos (herr-28) ───────────────────────────── */

console.log('\n8. JPEG: bytes FF de relleno entre segmentos');
/* Se salteaban de a dos bytes: con un relleno impar el recorrido caía sobre el
   código del marcador y se cortaba ahí. Pares andaban de casualidad. */
for (const n of [1, 2, 3]) {
  ok(`con ${n} de relleno lee los 300 dpi`, dpiDeclarado(jpeg([n, [0xe0, jfif(300, 1)]]), 'jpeg') === 300,
    String(dpiDeclarado(jpeg([n, [0xe0, jfif(300, 1)]]), 'jpeg')));
  ok(`con ${n} de relleno lee la orientación 6`, orientacionExif(jpeg([n, [0xe1, exifOrientacion(6)]]), 'jpeg') === 6,
    String(orientacionExif(jpeg([n, [0xe1, exifOrientacion(6)]]), 'jpeg')));
}
ok('relleno entre el EXIF y el JFIF', dpiDeclarado(jpeg([[0xe1, exifOrientacion(1)], 1, [0xe0, jfif(200, 1)]]), 'jpeg') === 200);
ok('un archivo que es todo relleno no se cuelga', dpiDeclarado(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff]), 'jpeg') === null);

/* ── 9. Densidades absurdas (herr-29) ────────────────────────────────────── */

console.log('\n9. Una densidad fuera de lo posible cuenta como no declarada');
// 1 píxel por metro son 0,0254 dpi: una foto de 1000 px saldría de 39 metros.
ok('1 ppm no es una densidad', dpiDeclarado(png([['IHDR', ihdr(4, 4)], ['pHYs', phys(1)]]), 'png') === null);
ok('1 dpi en el JFIF tampoco', dpiDeclarado(jpeg([[0xe0, jfif(1, 1)]]), 'jpeg') === null);
ok('19 dpi tampoco', dpiDeclarado(jpeg([[0xe0, jfif(19, 1)]]), 'jpeg') === null);
// Y del otro lado: 10 000 dpi harían una estampilla de una foto.
ok('10 000 dpi tampoco', dpiDeclarado(jpeg([[0xe0, jfif(10000, 1)]]), 'jpeg') === null);
ok('los bordes del rango sí valen', dpiDeclarado(jpeg([[0xe0, jfif(20, 1)]]), 'jpeg') === 20
  && dpiDeclarado(jpeg([[0xe0, jfif(4800, 1)]]), 'jpeg') === 4800);
{
  const p = medidaDePagina({ ancho: 1000, alto: 1000 }, dpiDeclarado(jpeg([[0xe0, jfif(1, 1)]]), 'jpeg'));
  ok('con la absurda la página sale a 96 dpi', p.ancho === 750, `${p.ancho} pt`);
}

/* ── 10. Los píxeles, de la cabecera (herr-27) ───────────────────────────── */

console.log('\n10. El tamaño en píxeles se lee de la cabecera, sin decodificar');
const medida = (m) => (m ? `${m.ancho}x${m.alto}` : String(m));
ok('PNG: del IHDR', medida(pixelesDeCabecera(png([['IHDR', ihdr(2480, 3508)]]), 'png')) === '2480x3508');
ok('JPEG: del SOF0', medida(pixelesDeCabecera(jpeg([[0xe0, jfif(72)], [0xc0, sof(4032, 3024)]]), 'jpeg')) === '4032x3024');
ok('JPEG progresivo: del SOF2', medida(pixelesDeCabecera(jpeg([[0xc2, sof(800, 600)]]), 'jpeg')) === '800x600');
// La tabla de Huffman (C4) está en el medio de los SOF y no es un frame.
ok('JPEG: la tabla de Huffman no se confunde con un frame',
  medida(pixelesDeCabecera(jpeg([[0xc4, Buffer.alloc(8, 9)], [0xc0, sof(640, 480)]]), 'jpeg')) === '640x480');
ok('JPEG: con relleno antes del SOF', medida(pixelesDeCabecera(jpeg([3, [0xc0, sof(10, 20)]]), 'jpeg')) === '10x20');
{
  const d = Buffer.alloc(10);
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a; d.writeUInt16LE(1920, 6); d.writeUInt16LE(1080, 8);
  ok('WEBP con pérdida (VP8)', medida(pixelesDeCabecera(webp('VP8 ', d), 'webp')) === '1920x1080');
}
{
  // 14 bits de ancho−1 y 14 de alto−1, pegados después de la firma 2F.
  const v = (300 - 1) | ((200 - 1) << 14);
  const d = Buffer.alloc(5);
  d[0] = 0x2f; d.writeUInt32LE(v >>> 0, 1);
  ok('WEBP sin pérdida (VP8L)', medida(pixelesDeCabecera(webp('VP8L', d), 'webp')) === '300x200');
}
{
  const d = Buffer.alloc(10);
  d.writeUIntLE(5000 - 1, 4, 3); d.writeUIntLE(3000 - 1, 7, 3);
  ok('WEBP extendido (VP8X)', medida(pixelesDeCabecera(webp('VP8X', d), 'webp')) === '5000x3000');
}
ok('una cabecera que no se entiende da null', pixelesDeCabecera(new Uint8Array([1, 2, 3]), 'png') === null
  && pixelesDeCabecera(jpeg([[0xe0, jfif(72)]]), 'jpeg') === null);
{
  /* Node no tiene createImageBitmap: si medirImagen intentara decodificar,
     acá reventaría. Que conteste es la prueba de que no decodifica. */
  let m = null; let err = null;
  try { m = await medirImagen(jpeg([[0xe1, exifOrientacion(6)], [0xc0, sof(3000, 4000)]]), 'jpeg'); } catch (e) { err = e.message; }
  ok('medirImagen contesta sin decodificar (y con los píxeles crudos, sin girar)',
    medida(m) === '3000x4000', err || medida(m));
}

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
