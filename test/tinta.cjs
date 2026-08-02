/* ═══════════════════════════════════════════════════════════════════════════
   La capa de tinta, de punta a punta.

   Lo que de verdad se juega acá es el VUELCO DE LA Y: los trazos se guardan en
   coordenadas de página (Y hacia arriba) y el PDF los recibe por drawSvgPath,
   que piensa en SVG (Y hacia abajo). Si el vuelco está mal, todo funciona,
   todo se ve bien en pantalla, y lo impreso sale espejado verticalmente.

   Por eso el test dibuja un trazo ARRIBA y después rasteriza el PDF resultante
   para preguntar en qué mitad del papel quedó la tinta.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..');
const HTML = path.join(RAIZ, 'renderer', '_tinta.html');

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
    const { CapaDeTinta, idDocumento } = await import('./js/tinta/capa.js');
    const { aplanarTinta } = await import('./js/tinta/aplanar.js');
    const { contornoDeTrazo, pathDeContorno, trazoTocado, cajaDeTrazo } = await import('./js/tinta/contorno.js');
    const { abrirDocumento } = await import('./js/pdf/documento.js');

    const bytes = new Uint8Array(await (await fetch('./vendor/cobayo.pdf')).arrayBuffer());
    const salida = {};

    /* Rasteriza una página y devuelve dónde quedó la tinta de un color dado.
       Se mide en FRANJAS horizontales: es lo único que distingue arriba de
       abajo, que es exactamente lo que el vuelco de la Y puede romper.

       Solo cuentan las filas con al menos umbralFila píxeles del color. Sin
       ese piso la medición es basura: pdf.js rasteriza el texto con
       antialiasing subpíxel, que deja píxeles rojizos y azulados sueltos en el
       borde de cada glifo. Alcanzan para estirar el rango de un extremo a otro
       de la hoja y hacer que un trazo de 10 pt "mida" 85. */
    async function dondeCayo(bytesPdf, pagina, test, umbralFila = 8) {
      const d = await abrirDocumento(bytesPdf.slice(), { nombre: 'x.pdf' });
      const canvas = await d.lienzo(pagina, { escala: 1, dpr: 1 });
      const g = await d.geometria(pagina);
      const ctx = canvas.getContext('2d');
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      const porFila = new Array(canvas.height).fill(0);
      let minX = Infinity, maxX = -Infinity, sueltos = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (!test(px[i], px[i + 1], px[i + 2])) continue;
        const idx = i / 4;
        porFila[Math.floor(idx / canvas.width)]++;
        sueltos++;
        const x = idx % canvas.width;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
      }

      const densas = [];
      let n = 0;
      for (let y = 0; y < porFila.length; y++) {
        if (porFila[y] >= umbralFila) { densas.push(y); n += porFila[y]; }
      }
      d.destruir();
      if (!densas.length) return { pixeles: 0, sueltos };

      const minY = densas[0];
      const maxY = densas[densas.length - 1];
      return {
        pixeles: n, sueltos, minY, maxY, minX, maxX,
        alto: canvas.height, ancho: canvas.width, altoPt: Math.round(g.altoPt),
        // Fracción desde ARRIBA del papel donde está el centro de la tinta.
        centroDesdeArriba: ((minY + maxY) / 2) / canvas.height,
        grosorPx: maxY - minY + 1,
      };
    }

    // Rojo saturado de verdad, no un borde de glifo teñido por el subpíxel.
    const rojo = (r, g, b) => r > 200 && g < 70 && b < 70;
    /* El resaltador va con 34% de opacidad sobre blanco: el amarillo puro
       (255,238,0) termina en ~(255,249,168). Se distingue del papel por el
       azul, que es lo único que baja. */
    const amarillo = (r, g, b) => r > 230 && g > 200 && b < 215;

    // ── Una capa con un trazo ARRIBA de la página ────────────────────────
    const capa = new CapaDeTinta({ ruta: 'C:/x/cobayo.pdf', nombre: 'cobayo.pdf', tamano: 1369 });
    // Página A4 de 842 pt de alto: y=800 está muy cerca del borde superior.
    capa.agregar(1, {
      herramienta: 'pluma', color: '#ff0000', ancho: 10, opacidad: 1,
      puntos: [[100, 800, 1], [250, 800, 1], [400, 800, 1]],
    });

    const conTinta = await aplanarTinta(bytes, capa);
    salida.arriba = await dondeCayo(conTinta, 1, rojo);
    salida.crecio = conTinta.length > bytes.length;

    // ── El mismo trazo, pero ABAJO ───────────────────────────────────────
    const capaB = new CapaDeTinta({ ruta: 'C:/x/b.pdf', nombre: 'b.pdf', tamano: 1 });
    capaB.agregar(1, {
      herramienta: 'pluma', color: '#ff0000', ancho: 10, opacidad: 1,
      puntos: [[100, 42, 1], [400, 42, 1]],
    });
    salida.abajo = await dondeCayo(await aplanarTinta(bytes, capaB), 1, rojo);

    // ── Sin tinta: no se toca el archivo ─────────────────────────────────
    const vacia = new CapaDeTinta({ ruta: 'C:/x/v.pdf', nombre: 'v.pdf', tamano: 1 });
    salida.sinTinta = { mismoObjeto: (await aplanarTinta(bytes, vacia)) === bytes };

    // ── Tinta en otra página, no en la primera ───────────────────────────
    const capaP3 = new CapaDeTinta({ ruta: 'C:/x/p3.pdf', nombre: 'p3.pdf', tamano: 1 });
    capaP3.agregar(3, {
      herramienta: 'pluma', color: '#ff0000', ancho: 12, opacidad: 1,
      puntos: [[200, 400, 1], [400, 400, 1]],
    });
    const b3 = await aplanarTinta(bytes, capaP3);
    salida.pagina3 = {
      enLa3: (await dondeCayo(b3, 3, rojo)).pixeles,
      enLa1: (await dondeCayo(b3, 1, rojo)).pixeles,
    };

    // ── El resaltador va DEBAJO de la pluma ──────────────────────────────
    const capaOrden = new CapaDeTinta({ ruta: 'C:/x/o.pdf', nombre: 'o.pdf', tamano: 1 });
    // Se agrega la pluma PRIMERO: si el orden no se corrigiera al escribir,
    // el amarillo taparía el rojo.
    capaOrden.agregar(1, {
      herramienta: 'pluma', color: '#ff0000', ancho: 8, opacidad: 1,
      puntos: [[150, 600, 1], [450, 600, 1]],
    });
    capaOrden.agregar(1, {
      herramienta: 'resaltador', color: '#ffee00', ancho: 30, opacidad: .34,
      puntos: [[150, 600, 1], [450, 600, 1]],
    });
    const bOrden = await aplanarTinta(bytes, capaOrden);
    salida.orden = {
      rojoVisible: (await dondeCayo(bOrden, 1, rojo)).pixeles,
      amarilloVisible: (await dondeCayo(bOrden, 1, amarillo)).pixeles,
    };

    // ── Ancho: un trazo de 10 pt tiene que medir ~10 pt ──────────────────
    salida.ancho = { grosorPx: salida.arriba.grosorPx, largoPx: salida.arriba.maxX - salida.arriba.minX + 1 };

    // ── Presión: más presión, más ancho ──────────────────────────────────
    const finito = contornoDeTrazo([[0, 0, .1], [100, 0, .1]], { ancho: 20 });
    const gordo = contornoDeTrazo([[0, 0, 1], [100, 0, 1]], { ancho: 20 });
    const altura = (c) => Math.max(...c.map((p) => p[1])) - Math.min(...c.map((p) => p[1]));
    salida.presion = { finito: +altura(finito).toFixed(2), gordo: +altura(gordo).toFixed(2) };
    const sinSensibilidad = contornoDeTrazo([[0, 0, .1], [100, 0, .1]], { ancho: 20, sensible: false });
    salida.presion.ignorada = +altura(sinSensibilidad).toFixed(2);

    // ── Un solo punto es un círculo, no un trazo vacío ───────────────────
    const toque = contornoDeTrazo([[50, 50, 1]], { ancho: 8 });
    salida.toque = { vertices: toque.length, alto: +altura(toque).toFixed(2) };

    // ── El borrador mide contra los SEGMENTOS, no los vértices ───────────
    const largo = { id: 'x', ancho: 2, puntos: [[0, 0, 1], [200, 0, 1]] };
    salida.borrador = {
      enElMedio: trazoTocado(largo, 100, 0, 5),      // lejos de todo vértice
      cerca: trazoTocado(largo, 100, 3, 5),
      lejos: trazoTocado(largo, 100, 60, 5),
      antesDelInicio: trazoTocado(largo, -40, 0, 5),
    };

    // ── Deshacer / rehacer ───────────────────────────────────────────────
    const h = new CapaDeTinta({ ruta: 'C:/x/h.pdf', nombre: 'h.pdf', tamano: 1 });
    h.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [10, 10, 1]] });
    h.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[20, 20, 1], [30, 30, 1]] });
    const tras2 = h.cuenta;
    h.deshacer();
    const trasDeshacer = h.cuenta;
    h.rehacer();
    const trasRehacer = h.cuenta;
    h.deshacer();
    h.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[40, 40, 1]] });
    salida.historial = { tras2, trasDeshacer, trasRehacer, ramaCortada: h.deshechos.length, final: h.cuenta };

    // ── Borrar por área ──────────────────────────────────────────────────
    const bo = new CapaDeTinta({ ruta: 'C:/x/bo.pdf', nombre: 'bo.pdf', tamano: 1 });
    bo.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [50, 0, 1]] });
    bo.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[300, 300, 1], [350, 300, 1]] });
    const borrados = bo.borrarEn(1, 25, 0, 6);
    salida.borrarEn = { borrados, quedan: bo.cuenta, seDeshace: (bo.deshacer(), bo.cuenta) };

    // ── El id del documento es estable y seguro como nombre de archivo ────
    const doc1 = { ruta: 'C:/x/a.pdf', nombre: 'a.pdf', tamano: 100 };
    salida.id = {
      estable: idDocumento(doc1) === idDocumento({ ...doc1 }),
      distintoPorTamano: idDocumento(doc1) !== idDocumento({ ...doc1, tamano: 101 }),
      formato: idDocumento(doc1),
      seguro: /^t-[0-9a-f]{8}$/.test(idDocumento(doc1)),
    };

    return salida;
  })()`, true).catch((e) => ({ error: String(e) }));

  if (r.error) { console.log('EXPLOTÓ: ' + r.error); app.exit(1); return; }

  console.log('\n1. El vuelco de la Y — lo que decide si sale espejado');
  ok('un trazo en y=800 (de 842) cae ARRIBA del papel',
    r.arriba.pixeles > 500 && r.arriba.centroDesdeArriba < 0.12,
    `${r.arriba.pixeles} px, centro a ${(r.arriba.centroDesdeArriba * 100).toFixed(1)}% desde arriba`);
  ok('un trazo en y=42 cae ABAJO del papel',
    r.abajo.pixeles > 300 && r.abajo.centroDesdeArriba > 0.88,
    `centro a ${(r.abajo.centroDesdeArriba * 100).toFixed(1)}% desde arriba`);
  ok('el PDF creció al recibir la tinta', r.crecio);

  console.log('\n2. Fidelidad del trazo');
  ok('un trazo de 10 pt mide ~10 px a escala 1',
    Math.abs(r.ancho.grosorPx - 10) <= 2, `${r.ancho.grosorPx} px`);
  ok('y va de x=100 a x=400 (~300 px de largo)',
    Math.abs(r.ancho.largoPx - 310) <= 12, `${r.ancho.largoPx} px`);
  ok('más presión, más ancho', r.presion.gordo > r.presion.finito * 2,
    `${r.presion.finito} vs ${r.presion.gordo}`);
  ok('sin sensibilidad, la presión no cambia nada', Math.abs(r.presion.ignorada - 20) < 0.5,
    String(r.presion.ignorada));
  ok('un toque suelto es un círculo', r.toque.vertices >= 8 && Math.abs(r.toque.alto - 8) < 1.5,
    JSON.stringify(r.toque));

  console.log('\n3. Dónde va cada cosa');
  ok('la tinta va SOLO en su página', r.pagina3.enLa3 > 100 && r.pagina3.enLa1 === 0,
    JSON.stringify(r.pagina3));
  ok('sin trazos, devuelve los bytes originales sin reescribir', r.sinTinta.mismoObjeto);
  ok('el resaltador queda DEBAJO: se ve el rojo de la pluma encima',
    r.orden.rojoVisible > 100 && r.orden.amarilloVisible > 100, JSON.stringify(r.orden));

  console.log('\n4. Borrador');
  ok('borra tocando el MEDIO de un segmento, lejos de todo vértice', r.borrador.enElMedio);
  ok('y cerquita también', r.borrador.cerca);
  ok('pero no si está lejos', !r.borrador.lejos);
  ok('ni antes de donde empieza', !r.borrador.antesDelInicio);
  ok('borrarEn saca solo el trazo tocado', r.borrarEn.borrados === 1 && r.borrarEn.quedan === 1,
    JSON.stringify(r.borrarEn));
  ok('y se puede deshacer', r.borrarEn.seDeshace === 2);

  console.log('\n5. Historial');
  ok('dos trazos', r.historial.tras2 === 2);
  ok('deshacer saca uno', r.historial.trasDeshacer === 1);
  ok('rehacer lo devuelve', r.historial.trasRehacer === 2);
  ok('una acción nueva corta la rama de rehacer', r.historial.ramaCortada === 0 && r.historial.final === 2,
    JSON.stringify(r.historial));

  console.log('\n6. Identidad del documento');
  ok('el mismo documento da el mismo id', r.id.estable);
  ok('otro tamaño da otro id', r.id.distintoPorTamano);
  ok('y es un nombre de archivo seguro', r.id.seguro, r.id.formato);

  fs.unlinkSync(HTML);
  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores) console.log('  ! ' + e);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  win.destroy();
  app.exit(fail || errores.length ? 1 : 0);
});
