/* ═══════════════════════════════════════════════════════════════════════════
   El motor de imposición, de punta a punta.

   plan.test.mjs afirma la aritmética; esto afirma que el PDF que sale tiene el
   contenido donde corresponde. Impone el PDF cobayo (4 páginas que dicen
   "PAGINA UNO".."PAGINA CUATRO") y después LO VUELVE A LEER con pdf.js para
   preguntar qué texto quedó en cada mitad de cada hoja.

   Es la única forma de saber que un folleto está bien impuesto sin doblarlo:
   si la 4 no cayó a la izquierda de la primera cara, está mal.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..');
const HTML = path.join(RAIZ, 'renderer', '_imposicion.html');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

app.whenReady().then(async () => {
  fs.writeFileSync(HTML,
    '<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:;">\n'
    + '<body></body>\n');

  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(e.message.slice(0, 180)); });
  await win.loadFile(HTML);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const { imponer, partirDuplex, combinar, dividir } = await import('./js/imposicion/motor.js');
    const { planCon } = await import('./js/imposicion/plan.js');
    const { abrirDocumento } = await import('./js/pdf/documento.js');

    const bytes = new Uint8Array(await (await fetch('./vendor/cobayo.pdf')).arrayBuffer());
    const doc = await abrirDocumento(bytes, { nombre: 'cobayo.pdf' });
    const geo = await doc.geometrias();

    /* Lee un PDF impuesto y, por cada hoja, dice qué texto cayó en cada mitad.
       El x del item viene en transform[4], en puntos de la página. */
    async function leer(bytesSalida) {
      const d = await abrirDocumento(bytesSalida.slice(), { nombre: 'salida.pdf' });
      const hojas = [];
      for (let n = 1; n <= d.paginas; n++) {
        const g = await d.geometria(n);
        const { items } = await d.texto(n);
        const mitad = g.anchoPt / 2;
        const izq = [], der = [], todo = [];
        for (const it of items) {
          const t = (it.str || '').trim();
          if (!t) continue;
          todo.push(t);
          (it.transform[4] < mitad ? izq : der).push(t);
        }
        hojas.push({
          anchoPt: Math.round(g.anchoPt), altoPt: Math.round(g.altoPt),
          apaisada: g.anchoPt > g.altoPt,
          izquierda: izq.join(' '), derecha: der.join(' '), texto: todo.join(' '),
        });
      }
      d.destruir();
      return hojas;
    }

    const salida = {};
    const A4 = { nombre: 'A4', ancho: 210, alto: 297 };
    const HP = { x: 3.97, y: 3.97, ancho: 203.2, alto: 289 };

    // 1. Simple, respetando el área imprimible de la HP
    {
      const { bytes: b, calculo } = await imponer(bytes, planCon({ papel: A4, imprimible: HP }), geo);
      salida.simple = { hojas: await leer(b), resumen: calculo.resumen, bytes: b.length };
    }

    // 2. Folleto (con dúplex: un cuadernillo se imprime de los dos lados)
    {
      const { bytes: b, calculo } = await imponer(bytes, planCon({
        modo: 'folleto', papel: A4, imprimible: HP, duplex: 'largo',
      }), geo);
      salida.folleto = { hojas: await leer(b), resumen: calculo.resumen };
    }

    // 3. Múltiple 2×2 con borde
    {
      const { bytes: b } = await imponer(bytes, planCon({
        modo: 'nup', papel: A4, nup: { filas: 2, columnas: 2, orden: 'horizontal', borde: true, separacion: 0 },
      }), geo);
      salida.nup = { hojas: await leer(b) };
    }

    /* 4. Póster. Dos casos, porque la diferencia entre los dos es justo lo que
       Quire muestra y otros visores esconden. */
    {
      // (a) Ideal: sin margen muerto y sin solape, el 200% entra justo en 2×2.
      const { bytes: b, calculo } = await imponer(bytes, planCon({
        modo: 'poster', papel: A4, respetarNoImprimible: false, rango: '1',
        poster: { escala: 200, solape: 0, marcas: true },
      }), geo);
      salida.posterIdeal = { hojas: (await leer(b)).length, mosaico: calculo.hojas[0]?.mosaico };

      // (b) Real: con el borde muerto de la HP y 10 mm de solape hacen falta 3×3,
      //     porque dos áreas imprimibles miden MENOS que dos A4.
      const { calculo: c2 } = await imponer(bytes, planCon({
        modo: 'poster', papel: A4, imprimible: HP, rango: '1',
        poster: { escala: 200, solape: 10, marcas: true },
      }), geo);
      salida.posterReal = { hojas: c2.hojas.length, mosaico: c2.hojas[0]?.mosaico };
    }

    // 5. Escala real: el contenido no entra y hay que avisarlo
    {
      const { calculo } = await imponer(bytes, planCon({
        papel: { nombre: 'A5', ancho: 148, alto: 210 }, escala: { tipo: 'real' },
      }), geo);
      salida.a5real = { desborde: calculo.resumen.desborde };
    }

    // 6. A5: cuatro páginas A4 reducidas a A5
    {
      const { bytes: b } = await imponer(bytes, planCon({
        papel: { nombre: 'A5', ancho: 148, alto: 210 }, escala: { tipo: 'ajustar' },
      }), geo);
      const h = await leer(b);
      salida.a5 = { hojas: h.length, anchoPt: h[0]?.anchoPt, texto: h[0]?.texto };
    }

    // 7. Reparto del dúplex
    salida.duplex = partirDuplex(4);

    // 8. Combinar y dividir
    {
      const { bytes: b, indice } = await combinar([
        { bytes, nombre: 'a.pdf' }, { bytes, nombre: 'b.pdf' },
      ]);
      const partes = await dividir(b, { tipo: 'cada', cada: 3 }, 'parte');
      salida.combinar = { indice, paginas: (await leer(b)).length };
      salida.dividir = partes.map((p) => ({ nombre: p.nombre, paginas: p.paginas, desde: p.desde, hasta: p.hasta }));
    }

    /* ── 8-bis. Imágenes como páginas ──────────────────────────────────────
       Las imágenes se fabrican acá con un canvas, así son archivos DE VERDAD
       —PNG, JPEG y WEBP que el navegador encodeó— y no maquetas. Lo que se
       mide es el tamaño de la página que sale de cada una, que es lo único
       que la imagen no trae escrito en ningún lado. */
    {
      async function imagen(ancho, alto, tipo) {
        const c = document.createElement('canvas');
        c.width = ancho; c.height = alto;
        const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, ancho, alto);
        cx.fillStyle = '#111'; cx.fillRect(3, 3, ancho - 6, alto - 6);
        const blob = await new Promise((res) => c.toBlob(res, tipo, 0.9));
        return new Uint8Array(await blob.arrayBuffer());
      }

      const crc32 = (b) => {
        let c = 0xffffffff;
        for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
        return (c ^ 0xffffffff) >>> 0;
      };

      /* Un PNG de canvas no declara densidad: se le mete un pHYs a mano para
         probar el caso que importa —el escaneo a 300 dpi que tiene que volver
         a medir A4—. Va justo después del IHDR, que es donde corresponde. */
      function conPHYs(png, dpi) {
        const ppm = Math.round(dpi / 0.0254);
        const chunk = new Uint8Array(21);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, 9);
        chunk.set([0x70, 0x48, 0x59, 0x73], 4);          // 'pHYs'
        dv.setUint32(8, ppm); dv.setUint32(12, ppm);
        chunk[16] = 1;                                    // unidad: el metro
        dv.setUint32(17, crc32(chunk.subarray(4, 17)));
        const corte = 8 + 12 + 13;                        // firma + chunk IHDR
        const out = new Uint8Array(png.length + chunk.length);
        out.set(png.subarray(0, corte), 0);
        out.set(chunk, corte);
        out.set(png.subarray(corte), corte + chunk.length);
        return out;
      }

      /* Y a un JPEG se le mete el APP1 del EXIF con la orientación 6, que es
         la foto sacada con el teléfono de costado. */
      function conExif(jpg, orientacion) {
        const cuerpo = new Uint8Array(30);
        const dv = new DataView(cuerpo.buffer);
        cuerpo.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);   // 'Exif\\0\\0'
        cuerpo.set([0x4d, 0x4d], 6);                      // 'MM': big endian
        dv.setUint16(8, 0x2a); dv.setUint32(10, 8);
        dv.setUint16(14, 1);                              // una entrada
        dv.setUint16(16, 0x0112); dv.setUint16(18, 3); dv.setUint32(20, 1);
        dv.setUint16(24, orientacion);
        const seg = new Uint8Array(4 + cuerpo.length);
        seg.set([0xff, 0xe1], 0);
        new DataView(seg.buffer).setUint16(2, cuerpo.length + 2);
        seg.set(cuerpo, 4);
        const out = new Uint8Array(jpg.length + seg.length);
        out.set(jpg.subarray(0, 2), 0);                   // SOI
        out.set(seg, 2);
        out.set(jpg.subarray(2), 2 + seg.length);
        return out;
      }

      const pantalla = await imagen(192, 96, 'image/png');
      const escaneo = conPHYs(await imagen(2480, 3508, 'image/png'), 300);
      const webp = await imagen(96, 48, 'image/webp');
      const foto = conExif(await imagen(200, 100, 'image/jpeg'), 6);

      const { bytes: b, indice } = await combinar([
        { bytes, nombre: 'doc.pdf', tipo: 'pdf', formato: 'pdf' },
        { bytes: pantalla, nombre: 'captura.png', tipo: 'imagen', formato: 'png' },
        { bytes: escaneo, nombre: 'escaneo.png', tipo: 'imagen', formato: 'png' },
        { bytes: webp, nombre: 'foto.webp', tipo: 'imagen', formato: 'webp' },
        { bytes: foto, nombre: 'telefono.jpg', tipo: 'imagen', formato: 'jpeg' },
      ]);

      const h = await leer(b);
      salida.imagenes = {
        indice,
        paginas: h.length,
        // Sin densidad: 192 px a 96 dpi son 2 pulgadas = 144 pt.
        pantalla: { ancho: h[4]?.anchoPt, alto: h[4]?.altoPt },
        // Con 300 dpi declarados, una A4 escaneada vuelve a medir una A4.
        escaneo: { ancho: h[5]?.anchoPt, alto: h[5]?.altoPt },
        // El WEBP pasó por el canvas y salió PNG: si no, no habría página.
        webp: { ancho: h[6]?.anchoPt, alto: h[6]?.altoPt },
        // La foto de costado: 200 × 100 px se ven como una página parada.
        foto: { ancho: h[7]?.anchoPt, alto: h[7]?.altoPt, apaisada: h[7]?.apaisada },
        // Y el PDF de adelante sigue siendo texto: nada se rasterizó.
        textoDelPdf: h[0]?.texto,
      };

      /* pdf-lib tira strings pelados, sin propiedad message: el mensaje que
         llega al usuario tiene que sobrevivir a eso y, sobre todo, nombrar el
         archivo que falló. */
      const rotas = {};
      for (const [k, item] of Object.entries({
        png: { bytes: new Uint8Array([1, 2, 3, 4]), nombre: 'rota.png', tipo: 'imagen', formato: 'png' },
        jpeg: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), nombre: 'rota.jpg', tipo: 'imagen', formato: 'jpeg' },
        webp: { bytes: new Uint8Array([1, 2, 3, 4]), nombre: 'rota.webp', tipo: 'imagen', formato: 'webp' },
      })) {
        try { await combinar([item]); rotas[k] = null; } catch (e) { rotas[k] = String(e && e.message); }
      }
      salida.imagenRota = rotas;
    }

    // 9. Reorganizar: reordenar, rotar y borrar en una sola operación
    {
      const { reorganizar } = await import('./js/imposicion/motor.js');
      // Se queda con 4,1,3 (borra la 2), y gira la primera 90°.
      const b = await reorganizar(bytes, { orden: [4, 1, 3], rotaciones: { 4: 90 } });
      const h = await leer(b);
      salida.reorganizar = {
        paginas: h.length,
        textos: h.map((x) => x.texto.trim()),
        primeraApaisada: h[0]?.apaisada,
        restoVertical: h.slice(1).every((x) => !x.apaisada),
      };

      // Rotar sobre una página que YA venía rotada tiene que sumar, no pisar.
      const doble = await reorganizar(b, { orden: [1, 2, 3], rotaciones: { 1: 90 } });
      const hd = await leer(doble);
      salida.rotacionAcumula = { vuelveAVertical: !hd[0].apaisada };

      let vacio = null;
      try { await reorganizar(bytes, { orden: [] }); } catch (e) { vacio = e.message; }
      salida.reorganizarVacio = vacio;
    }

    // 10. Exportar a imágenes
    {
      const { exportarImagenes, medidaAlDPI, FORMATOS } = await import('./js/exportar.js');

      const png = await exportarImagenes(doc, { paginas: [1, 2], formato: 'png', dpi: 150 });
      const jpg = await exportarImagenes(doc, { paginas: [1], formato: 'jpeg', dpi: 72, calidad: 0.8 });

      // La firma del archivo, no su extensión: que diga .png no lo hace un PNG.
      const firma = (buf, n) => [...new Uint8Array(buf).slice(0, n)];

      salida.exportar = {
        cuantas: png.length,
        nombres: png.map((i) => i.nombre),
        medida: { ancho: png[0].ancho, alto: png[0].alto },
        // A4 a 150 dpi: 210mm = 8,27" × 150 = 1240 px
        esperado150: medidaAlDPI(geo[0], 150),
        firmaPNG: firma(png[0].bytes, 4),
        firmaJPEG: firma(jpg[0].bytes, 3),
        jpegMasChico: jpg[0].bytes.byteLength < png[0].bytes.byteLength,
        formatos: Object.keys(FORMATOS),
      };

      let limite = null;
      try { await exportarImagenes(doc, { paginas: [1], dpi: 4000 }); } catch (e) { limite = e.message; }
      salida.exportarLimite = limite;
    }

    doc.destruir();
    return salida;
  })()`, true).catch((e) => ({ error: String(e) }));

  if (r.error) { console.log('EXPLOTÓ: ' + r.error); app.exit(1); return; }

  console.log('\n1. Simple sobre A4, respetando el área imprimible');
  ok('una hoja por página', r.simple.hojas.length === 4, String(r.simple.hojas.length));
  ok('papel A4 vertical', r.simple.hojas[0].anchoPt === 595 && r.simple.hojas[0].altoPt === 842,
    `${r.simple.hojas[0].anchoPt}×${r.simple.hojas[0].altoPt}`);
  ok('el texto sobrevive (no se rasterizó)', /PAGINA UNO/.test(r.simple.hojas[0].texto), r.simple.hojas[0].texto);
  ok('y la cuarta hoja tiene la cuarta página', /PAGINA CUATRO/.test(r.simple.hojas[3].texto));
  ok('sin desborde: al ajustar entra', !r.simple.resumen.desborde);

  console.log('\n2. Folleto');
  ok('4 páginas → 2 caras', r.folleto.hojas.length === 2, String(r.folleto.hojas.length));
  ok('papel apaisado', r.folleto.hojas[0].apaisada, `${r.folleto.hojas[0].anchoPt}×${r.folleto.hojas[0].altoPt}`);
  ok('cara 1 izquierda = página 4', /CUATRO/.test(r.folleto.hojas[0].izquierda), r.folleto.hojas[0].izquierda);
  ok('cara 1 derecha = página 1', /UNO/.test(r.folleto.hojas[0].derecha), r.folleto.hojas[0].derecha);
  ok('cara 2 izquierda = página 2', /DOS/.test(r.folleto.hojas[1].izquierda), r.folleto.hojas[1].izquierda);
  ok('cara 2 derecha = página 3', /TRES/.test(r.folleto.hojas[1].derecha), r.folleto.hojas[1].derecha);
  ok('1 hoja física con dúplex', r.folleto.resumen.hojasFisicas === 1);

  console.log('\n3. Múltiple 2×2');
  ok('las 4 páginas en una hoja', r.nup.hojas.length === 1, String(r.nup.hojas.length));
  ok('están las cuatro', ['UNO', 'DOS', 'TRES', 'CUATRO'].every((t) => r.nup.hojas[0].texto.includes(t)),
    r.nup.hojas[0].texto);
  ok('1 y 3 quedaron a la izquierda', /UNO/.test(r.nup.hojas[0].izquierda) && /TRES/.test(r.nup.hojas[0].izquierda),
    r.nup.hojas[0].izquierda);
  ok('2 y 4 a la derecha', /DOS/.test(r.nup.hojas[0].derecha) && /CUATRO/.test(r.nup.hojas[0].derecha),
    r.nup.hojas[0].derecha);

  console.log('\n4. Póster al 200%');
  ok('sin margen ni solape, entra JUSTO en 2×2 (sin baldosa fantasma)',
    r.posterIdeal.hojas === 4 && r.posterIdeal.mosaico?.filas === 2 && r.posterIdeal.mosaico?.columnas === 2,
    `${r.posterIdeal.hojas} hojas, ${JSON.stringify(r.posterIdeal.mosaico)}`);
  ok('con el borde muerto real de la HP y 10 mm de solape, hacen falta 3×3',
    r.posterReal.hojas === 9 && r.posterReal.mosaico?.filas === 3,
    `${r.posterReal.hojas} hojas, ${JSON.stringify(r.posterReal.mosaico)}`);

  console.log('\n5. Escalas');
  ok('A4 a tamaño real sobre A5 desborda, y se avisa', r.a5real.desborde);
  ok('A5 ajustado entra', r.a5.hojas === 4 && r.a5.anchoPt === 420, `${r.a5.anchoPt}pt`);
  ok('y conserva el texto', /PAGINA UNO/.test(r.a5.texto));

  console.log('\n6. Dúplex');
  ok('4 caras → 2 frentes y 2 dorsos', r.duplex.frentes.length === 2 && r.duplex.dorsos.length === 2);
  ok('los frentes son las pares 0 y 2', r.duplex.frentes.join() === '0,2', r.duplex.frentes.join());
  /* La pila NO se da vuelta (ver diagramaVuelta). Los dorsos van invertidos por
     otra razón: la salida apila boca abajo y la entrada toma de arriba, así que
     la primera hoja de la segunda pasada es la última de la primera. */
  ok('los dorsos van INVERTIDOS (3,1): la salida apila al revés', r.duplex.dorsos.join() === '3,1', r.duplex.dorsos.join());

  console.log('\n7. Combinar y dividir');
  ok('dos de 4 páginas dan 8', r.combinar.paginas === 8, String(r.combinar.paginas));
  ok('el índice ubica cada documento', r.combinar.indice[1]?.desde === 5 && r.combinar.indice[1]?.hasta === 8,
    JSON.stringify(r.combinar.indice));
  ok('dividir cada 3 sobre 8 da 3 partes', r.dividir.length === 3, String(r.dividir.length));
  ok('la última parte lleva las 2 que sobran', r.dividir[2]?.paginas === 2, JSON.stringify(r.dividir[2]));
  ok('los nombres van numerados', r.dividir[0]?.nombre === 'parte-1.pdf', r.dividir[0]?.nombre);

  console.log('\n7-bis. Imágenes como páginas');
  const im = r.imagenes;
  ok('4 páginas de PDF + 4 imágenes dan 8', im.paginas === 8, String(im.paginas));
  ok('cada imagen aporta una sola página',
    im.indice.slice(1).every((x) => x.hasta - x.desde === 0), JSON.stringify(im.indice));
  ok('el PDF de adelante sigue siendo texto', /PAGINA UNO/.test(im.textoDelPdf || ''), im.textoDelPdf);
  // 192 px a 96 dpi son 2 pulgadas: 144 × 72 pt. Sin margen, sin hoja alrededor.
  ok('sin densidad declarada, 192 × 96 px dan 144 × 72 pt',
    im.pantalla.ancho === 144 && im.pantalla.alto === 72, `${im.pantalla.ancho} × ${im.pantalla.alto}`);
  // Lo que hace que esto valga la pena: un escaneo vuelve a medir lo que medía.
  ok('un escaneo a 300 dpi vuelve a medir A4',
    Math.abs(im.escaneo.ancho - 595) <= 1 && Math.abs(im.escaneo.alto - 842) <= 1,
    `${im.escaneo.ancho} × ${im.escaneo.alto}`);
  ok('el WEBP llegó a ser página (pasó por el canvas)',
    im.webp.ancho === 72 && im.webp.alto === 36, `${im.webp.ancho} × ${im.webp.alto}`);
  /* La foto entra de 200 × 100 px y tiene que SALIR parada: el EXIF decía que
     estaba de costado. Sin leerlo, la página saldría apaisada y el error
     recién se vería en el papel. */
  ok('la foto con EXIF 6 sale parada, no acostada',
    !im.foto.apaisada && im.foto.alto > im.foto.ancho, JSON.stringify(im.foto));
  /* Una imagen dañada tiene que avisar, y el aviso tiene que decir CUÁL es:
     combinando doce archivos, "Offset is outside the bounds of the DataView"
     no le sirve a nadie. */
  ok('los tres formatos avisan cuando el archivo está dañado',
    ['png', 'jpeg', 'webp'].every((k) => /no se pudo leer/i.test(r.imagenRota[k] || '')),
    JSON.stringify(r.imagenRota));
  ok('y el aviso nombra el archivo que falló',
    ['rota.png', 'rota.jpg', 'rota.webp'].every((n) => JSON.stringify(r.imagenRota).includes(n)),
    JSON.stringify(r.imagenRota));

  console.log('\n8. Reorganizar');
  ok('borra la que no está en el orden', r.reorganizar.paginas === 3, String(r.reorganizar.paginas));
  ok('y respeta el orden pedido (4, 1, 3)',
    /CUATRO/.test(r.reorganizar.textos[0]) && /UNO/.test(r.reorganizar.textos[1]) && /TRES/.test(r.reorganizar.textos[2]),
    JSON.stringify(r.reorganizar.textos));
  ok('rota solo la que se pidió', r.reorganizar.primeraApaisada && r.reorganizar.restoVertical);
  ok('rotar dos veces 90° suma en vez de pisar', r.rotacionAcumula.vuelveAVertical);
  ok('sin páginas, avisa en vez de escribir un PDF vacío', /ninguna página/i.test(r.reorganizarVacio || ''),
    r.reorganizarVacio);

  console.log('\n9. Exportar imágenes');
  ok('una imagen por página', r.exportar.cuantas === 2, String(r.exportar.cuantas));
  ok('numeradas', r.exportar.nombres[0].endsWith('-1.png'), r.exportar.nombres.join(', '));
  ok('A4 a 150 dpi da ~1240 × 1754 px',
    Math.abs(r.exportar.medida.ancho - 1240) <= 4 && Math.abs(r.exportar.medida.alto - 1754) <= 6,
    `${r.exportar.medida.ancho} × ${r.exportar.medida.alto}`);
  ok('el cálculo previo coincide con lo que sale',
    r.exportar.esperado150.ancho === r.exportar.medida.ancho);
  // 89 50 4E 47 = \x89PNG · FF D8 FF = SOI de JPEG
  ok('el PNG es un PNG de verdad', r.exportar.firmaPNG.join() === '137,80,78,71', r.exportar.firmaPNG.join());
  ok('y el JPEG un JPEG', r.exportar.firmaJPEG.join() === '255,216,255', r.exportar.firmaJPEG.join());
  ok('el JPEG pesa menos que el PNG', r.exportar.jpegMasChico);
  ok('tres formatos', r.exportar.formatos.join() === 'png,jpeg,webp');
  ok('un DPI imposible avisa en vez de dar un lienzo en blanco',
    /máximo|bajá el DPI/i.test(r.exportarLimite || ''), r.exportarLimite);

  fs.unlinkSync(HTML);
  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores) console.log('  ! ' + e);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);

  win.destroy();
  app.exit(fail || errores.length ? 1 : 0);
});
