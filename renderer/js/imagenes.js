/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — imágenes que se vuelven páginas
   Lo que hace falta para que un PNG entre a un PDF como una hoja más.

   El problema entero es una pregunta: ¿de qué TAMAÑO sale esa hoja? Una imagen
   no tiene medida física; tiene píxeles. La única manera de pasar de píxeles a
   milímetros es que el archivo declare cuántos entran en una pulgada, y eso
   está enterrado en la cabecera: en un chunk `pHYs` si es PNG, en el segmento
   JFIF si es JPEG. Un escaneo a 300 dpi lo dice y la página sale del tamaño
   del papel original; un screenshot no lo dice y hay que suponer.

   Por eso todo esto es parseo de cabeceras a mano y no una librería: son tres
   campos, están en un lugar fijo, y el dato que sale de acá es el que decide
   cuánto mide el papel. Vale leerlo uno mismo y poder testearlo con Node pelado.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Un PDF mide en puntos: 72 por pulgada. */
export const PT_POR_PULGADA = 72;

/* Cuando el archivo no declara densidad, sus píxeles se toman como píxeles de
   pantalla. 96 dpi no es una adivinanza optimista: es lo que un píxel significa
   en la web y en Windows, así que es la medida real de un screenshot. Con esto
   una captura de 1920 de ancho sale de 508 mm — grande, pero cierta. Bajarlo a
   72 la haría más grande todavía; subirlo sería inventar una resolución que la
   imagen no tiene. */
export const DPI_POR_DEFECTO = 96;

export const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Los que pdf-lib embebe tal cual, sin pasar por un canvas. */
export const SE_EMBEBEN_CRUDOS = ['png', 'jpeg'];

const bytesDe = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const texto = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/* Las densidades reales son números redondos (72, 96, 150, 300, 600) pero
   viajan convertidas a píxeles por metro, así que vuelven con decimales:
   300 dpi se guarda como 11811 ppm y al deshacer la cuenta da 299,9994. Sin
   redondear, una A4 escaneada saldría de 297,0006 mm y la app la mostraría
   como un tamaño desconocido en vez de "A4". */
const redondearDPI = (v) => (v > 0 && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * La densidad que el archivo declara, en dpi, o null si no dice nada.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {'png'|'jpeg'|'webp'} formato
 */
export function dpiDeclarado(bytes, formato) {
  const b = bytesDe(bytes);
  if (formato === 'png') return dpiPNG(b);
  if (formato === 'jpeg') return dpiJPEG(b);
  return null;   // WEBP no tiene dónde declararlo.
}

/* PNG: después de la firma de 8 bytes vienen los chunks, cada uno
   [largo:4][tipo:4][datos:largo][crc:4]. El de densidad es `pHYs` y son nueve
   bytes: píxeles por unidad en X, en Y, y qué unidad — 1 es el metro y 0 es
   "sin unidad", que solo declara una relación de aspecto y no sirve para medir. */
function dpiPNG(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const largo = u32(b, i);
    const tipo = texto(b, i + 4, 4);

    if (tipo === 'pHYs' && largo >= 9 && i + 8 + 9 <= b.length) {
      return b[i + 16] === 1 ? redondearDPI(u32(b, i + 8) * 0.0254) : null;
    }
    // IDAT es el primer chunk de datos: si llegamos acá, pHYs no estaba.
    if (tipo === 'IDAT' || tipo === 'IEND') return null;

    i += 12 + largo;
  }
  return null;
}

/* JPEG: el segmento APP0 de JFIF, que trae casi todo JPEG que existe. Después
   del identificador y la versión vienen [unidad:1][Xdensidad:2][Ydensidad:2],
   con unidad 1 = por pulgada, 2 = por centímetro y 0 = ninguna.

   Se recorre la cadena de marcadores en vez de asumir que APP0 es el primero,
   porque no siempre lo es: una foto de teléfono suele arrancar con el APP1 del
   EXIF y meter el JFIF después. */
function dpiJPEG(b) {
  let i = 2;                                   // saltea el SOI (FF D8)
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marca = b[i + 1];
    // Marcadores sin cuerpo: relleno, reinicios y el SOI repetido.
    if (marca === 0xff || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd9)) { i += 2; continue; }
    if (marca === 0xda) return null;           // arrancó el scan: la cabecera terminó
    const largo = u16(b, i + 2);
    if (largo < 2) return null;

    if (marca === 0xe0 && i + 16 <= b.length && texto(b, i + 4, 4) === 'JFIF') {
      const unidad = b[i + 11];
      const x = u16(b, i + 12);
      if (!x) return null;
      if (unidad === 1) return redondearDPI(x);
      if (unidad === 2) return redondearDPI(x * 2.54);
      return null;
    }
    i += 2 + largo;
  }
  return null;
}

/* ── La orientación del EXIF ────────────────────────────────────────────────
   Una foto sacada con el teléfono de costado guarda los píxeles como salieron
   del sensor y aparte anota "esto va girado". Si nadie lee esa anota, la foto
   entra acostada al PDF y no se descubre hasta que sale el papel. PNG y WEBP
   no tienen dónde declararla, así que siempre están derechos. */

/** 1 = derecha. Del 2 al 8 hay giros y espejados. */
export function orientacionExif(bytes, formato) {
  if (formato !== 'jpeg') return 1;
  const b = bytesDe(bytes);

  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marca = b[i + 1];
    if (marca === 0xff || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd9)) { i += 2; continue; }
    if (marca === 0xda) return 1;
    const largo = u16(b, i + 2);
    if (largo < 2) return 1;
    if (marca === 0xe1 && texto(b, i + 4, 4) === 'Exif') {
      const o = orientacionEnTIFF(b, i + 10, i + 2 + largo);
      if (o >= 1 && o <= 8) return o;
      return 1;
    }
    i += 2 + largo;
  }
  return 1;
}

/**
 * El tag 0x0112 del IFD0 de un bloque TIFF.
 *
 * Un TIFF empieza diciendo en qué orden vienen sus bytes ("II" o "MM"), que es
 * la razón por la que esto no se puede leer con u16/u32 a secas.
 */
function orientacionEnTIFF(b, base, fin) {
  if (base + 8 > fin || base + 8 > b.length) return 1;
  const orden = texto(b, base, 2);
  if (orden !== 'II' && orden !== 'MM') return 1;
  const chico = orden === 'II';
  const dos = (i) => (chico ? b[i] | (b[i + 1] << 8) : u16(b, i));
  const cuatro = (i) => (chico
    ? ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0)
    : u32(b, i));

  if (dos(base + 2) !== 0x2a) return 1;
  const ifd = base + cuatro(base + 4);
  if (ifd + 2 > fin) return 1;

  const cuantas = dos(ifd);
  for (let k = 0; k < cuantas; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > fin) break;
    // Tipo 3 (SHORT): el valor entra en el campo y va en sus dos primeros bytes.
    if (dos(e) === 0x0112 && dos(e + 2) === 3) return dos(e + 8);
  }
  return 1;
}

/* El espejado (orientaciones 2, 4, 5 y 7) no se puede expresar como un /Rotate
   de PDF: se lo trata como su giro equivalente, que es lo que hace todo el
   mundo. Una foto espejada es un accidente de cámaras raras; una girada es de
   todos los días, y dejar las dos acostadas por culpa de la primera sería
   arreglar el caso raro rompiendo el común. */
const GIRO = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/** Cuánto hay que girar la página para que la imagen se vea derecha. */
export const giroDeOrientacion = (o) => GIRO[o] ?? 0;

/* ── De píxeles a papel ──────────────────────────────────────────────────── */

/**
 * De qué tamaño sale la página, en puntos, con la orientación ya aplicada.
 *
 * @param {{ancho:number, alto:number}} px  píxeles crudos del archivo
 * @param {number|null} dpi                 el declarado, o null
 * @param {number} giro                     0, 90, 180 o 270
 */
export function medidaDePagina(px, dpi, giro = 0) {
  const escala = PT_POR_PULGADA / (dpi || DPI_POR_DEFECTO);
  const ancho = px.ancho * escala;
  const alto = px.alto * escala;
  // Con la hoja de costado, lo que se ve es la medida cambiada de lugar.
  return giro % 180 === 0 ? { ancho, alto } : { ancho: alto, alto: ancho };
}

/**
 * Los píxeles que tiene el archivo.
 *
 * `imageOrientation: 'none'` es deliberado: se quieren los píxeles CRUDOS, los
 * mismos que va a embeber pdf-lib. El navegador, librado a su criterio, aplica
 * el EXIF y devuelve el bitmap ya girado — y como acá el giro se aplica aparte,
 * como rotación de la página, terminaría aplicándose dos veces.
 */
export async function medirImagen(bytes, formato) {
  const bm = await abrirBitmap(bytes, formato);
  const medida = { ancho: bm.width, alto: bm.height };
  bm.close();
  return medida;
}

/**
 * WEBP a PNG. pdf-lib no embebe WEBP, así que se decodifica y se vuelve a
 * escribir en PNG, que es sin pérdida: los píxeles que entran son los que
 * salen. Pesa más que el original, pero es un archivo intermedio que muere
 * dentro del PDF.
 */
export async function aPNG(bytes, formato) {
  const bm = await abrirBitmap(bytes, formato);
  const lienzo = new OffscreenCanvas(bm.width, bm.height);
  lienzo.getContext('2d').drawImage(bm, 0, 0);
  bm.close();
  const blob = await lienzo.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function abrirBitmap(bytes, formato) {
  const tipo = MIME[formato];
  if (!tipo) throw new Error(`Formato de imagen desconocido: ${formato}`);
  try {
    return await createImageBitmap(new Blob([bytes], { type: tipo }), { imageOrientation: 'none' });
  } catch {
    // El navegador no dice por qué falla; casi siempre es un archivo cortado.
    throw new Error('No se pudo decodificar la imagen: puede estar dañada o incompleta');
  }
}
