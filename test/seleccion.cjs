/* ═══════════════════════════════════════════════════════════════════════════
   La selección de texto, de punta a punta.

   Lo que de verdad se juega acá es la CALZADA: la capa de texto son spans
   transparentes que tienen que caer EXACTAMENTE encima de las letras que pintó
   el canvas. Si están corridos, todo se ve perfecto —son invisibles— y la
   selección agarra la palabra de al lado. Un bug que no se ve nunca hasta que
   se pega el texto en otro lado y está todo mal.

   Por eso el test no pregunta "¿existe el span?": rasteriza la página, busca
   dónde están los píxeles NEGROS de las letras, y compara contra el rectángulo
   del span. Las dos mediciones tienen que dar lo mismo.

   El PDF cobayo tiene "PAGINA UNO" en Helvetica 42 pt puesto en (60, 720) de
   una hoja de 595 × 842. Eso hace que las posiciones esperadas se puedan
   calcular a mano en vez de confiar en lo que devuelva la librería.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PDF = process.argv.find((a) => a.endsWith('.pdf'))
  || path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Sin esto, cualquier `js()` que rechace deja la cadena colgada y Electron se
   queda abierto para siempre, sin imprimir una línea. */
const morir = (por, err) => {
  console.log(`\n!!! ${por}: ${err?.stack || err}`);
  console.log(`\n═══ ${pass} ok · ${fail + 1} fallas ═══`);
  app.exit(1);
};
process.on('unhandledRejection', (e) => morir('promesa sin atrapar', e));
const reloj = setTimeout(() => morir('se colgó', new Error('pasaron 90 s')), 90_000);

app.whenReady().then(async () => {
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  ipc.register();

  /* Fuera de pantalla pero VISIBLE: Chromium congela las animaciones de una
     ventana con show:false y todo lo que entra animado se mide invisible.
     El porqué largo está en humo.cjs. */
  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 900,
    backgroundColor: '#0a0b0d',
    webPreferences: {
      preload: path.join(RAIZ, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(e.message.slice(0, 180)); });

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (código) => win.webContents.executeJavaScript(código, true);

  await js(`(async () => {
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    const mod = await import('./js/estado.js');
    await mod.abrir(archivo);
    const router = (await import('./js/router.js')).default;
    router.go('lector');
    router.refresh();
  })()`);
  await esperar(2200);

  /* Las funciones de medición se dejan colgadas del window una sola vez: cada
     bloque de abajo las vuelve a usar después de zoomear o de rotar. */
  await js(`(() => {
    /* Dónde están los píxeles OSCUROS de la página, en puntos PDF.
       Se mide en una franja que deja afuera el marco del cobayo (un rectángulo
       de 1 pt en 30,30 535×782): sin recortar, el marco se come la medición y
       la caja da la hoja entera. */
    window.__letras = (pliego, { desdePt, hastaPt, izqPt = 45, derPt = 550 }) => {
      const canvas = pliego.querySelector('.qr-hoja');
      const bw = canvas.width, bh = canvas.height;
      if (!bw || !bh) return null;

      // Puntos PDF → píxeles del bitmap. La página del cobayo mide 595 × 842 pt.
      const kx = bw / 595, ky = bh / 842;
      const x0 = Math.max(0, Math.floor(izqPt * kx));
      const x1 = Math.min(bw, Math.ceil(derPt * kx));
      const y0 = Math.max(0, Math.floor(desdePt * ky));
      const y1 = Math.min(bh, Math.ceil(hastaPt * ky));

      const d = canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(x0, y0, x1 - x0, y1 - y0).data;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < x1 - x0; x++) {
          const i = (y * (x1 - x0) + x) * 4;
          // Luminancia cruda: alcanza y sobra para separar tinta de papel.
          if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 128) continue;
          n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (!n) return null;
      return {
        pixeles: n,
        izq:  (x0 + minX) / kx,
        der:  (x0 + maxX) / kx,
        arriba: (y0 + minY) / ky,
        abajo:  (y0 + maxY) / ky,
      };
    };

    /* El rectángulo de un span, en los mismos puntos PDF. Se mide contra el
       pliego (no contra la ventana) para que no dependa del scroll. */
    window.__spanEnPt = (pliego, span) => {
      const p = pliego.getBoundingClientRect();
      const s = span.getBoundingClientRect();
      const kx = 595 / p.width, ky = 842 / p.height;
      return {
        izq: (s.left - p.left) * kx,
        der: (s.right - p.left) * kx,
        arriba: (s.top - p.top) * ky,
        abajo: (s.bottom - p.top) * ky,
      };
    };

    window.__pliego = (n) => document.querySelector('.qr-pliego[data-pagina="' + n + '"]');
  })()`);

  // ── 1. La capa existe y tiene tamaño ──────────────────────────────────────
  const capa = await js(`(() => {
    const pliego = window.__pliego(1);
    const div = pliego.querySelector('.qr-texto');
    const cs = getComputedStyle(div);
    const p = pliego.getBoundingClientRect();
    const d = div.getBoundingClientRect();
    return {
      existe: !!div,
      spans: div.querySelectorAll('span').length,
      texto: div.textContent.trim(),
      /* El ancho sale de round(down, var(--total-scale-factor) * 595px,
         var(--scale-round-x)). Si a esa expresión le falta una variable es
         inválida, la capa se queda sin ancho y no se selecciona nada. */
      ancho: cs.width,
      alto: cs.height,
      calzaConElPliego: Math.abs(d.width - p.width) < 1.5 && Math.abs(d.height - p.height) < 1.5,
      cola: !!div.querySelector('.qr-texto__cola'),
    };
  })()`);

  console.log('\n1. La capa de texto');
  ok('se monta sobre la página', capa.existe && capa.spans > 0, JSON.stringify(capa));
  ok('con el texto del PDF', capa.texto === 'PAGINA UNO', `dio "${capa.texto}"`);
  ok('y con tamaño resuelto (las variables de escala están)',
    capa.ancho !== 'auto' && parseFloat(capa.ancho) > 100, `ancho: ${capa.ancho}`);
  ok('que cubre el pliego exactamente', capa.calzaConElPliego,
    `capa ${capa.ancho}×${capa.alto}`);
  ok('la cola de la selección está puesta', capa.cola);

  // ── 2. La calzada: el span cae sobre las letras ───────────────────────────
  const calce = await js(`(() => {
    const pliego = window.__pliego(1);
    const span = pliego.querySelector('.qr-texto span');
    // "PAGINA UNO" en 42 pt con baseline en y=720 vive entre ~90 y ~122 pt
    // desde arriba. Se mira una franja generosa alrededor.
    const tinta = window.__letras(pliego, { desdePt: 60, hastaPt: 160 });
    const caja = window.__spanEnPt(pliego, span);
    return { tinta, caja, fuente: getComputedStyle(span).fontSize, escala: pliego.getBoundingClientRect().width / 595 };
  })()`);

  console.log('\n2. Los spans caen ENCIMA de las letras');
  if (!calce.tinta) {
    ok('se encontraron letras para medir', false, 'no hay píxeles oscuros en la franja');
  } else {
    const { tinta, caja } = calce;
    ok(`el borde izquierdo coincide (letras ${tinta.izq.toFixed(1)} pt · span ${caja.izq.toFixed(1)} pt)`,
      Math.abs(tinta.izq - caja.izq) < 6);
    ok(`el borde derecho coincide (letras ${tinta.der.toFixed(1)} pt · span ${caja.der.toFixed(1)} pt)`,
      Math.abs(tinta.der - caja.der) < 10);
    ok('el span envuelve verticalmente a las letras',
      caja.arriba <= tinta.arriba + 3 && caja.abajo >= tinta.abajo - 3,
      `span ${caja.arriba.toFixed(1)}–${caja.abajo.toFixed(1)} · letras ${tinta.arriba.toFixed(1)}–${tinta.abajo.toFixed(1)}`);
    /* Si a capaTexto() se le pasara la escala multiplicada por el dpr —como sí
       hacen render() y viewport()— el cuerpo saldría al doble y este número
       sería el primero en denunciarlo. */
    ok('el cuerpo de la letra es 42 pt a la escala de pantalla',
      Math.abs(parseFloat(calce.fuente) - 42 * calce.escala) < 2.5,
      `${calce.fuente} con escala ${calce.escala.toFixed(3)} (esperado ${(42 * calce.escala).toFixed(1)}px)`);
  }

  // ── 3. Se puede seleccionar y copiar ──────────────────────────────────────
  const sel = await js(`(() => {
    const div = window.__pliego(1).querySelector('.qr-texto');
    const span = div.querySelector('span');
    const cs = getComputedStyle(span);

    const r = document.createRange();
    r.selectNodeContents(div);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const capturado = s.toString();
    s.removeAllRanges();

    return {
      /* El body es user-select:none. Si esta regla no llegara hasta acá, no
         habría forma de arrastrar una palabra. */
      userSelect: cs.userSelect,
      cursor: cs.cursor,
      capturado,
      // Transparente, no invisible: display:none no se seleccionaría.
      transparente: cs.color === 'rgba(0, 0, 0, 0)',
      visible: cs.display !== 'none' && cs.visibility === 'visible',
    };
  })()`);

  console.log('\n3. Seleccionar y copiar');
  ok('los spans son seleccionables pese al user-select:none global', sel.userSelect === 'text', sel.userSelect);
  ok('y el cursor lo dice', sel.cursor === 'text', sel.cursor);
  ok('seleccionar la página devuelve su texto', sel.capturado.trim() === 'PAGINA UNO', `dio "${sel.capturado}"`);
  ok('las letras son transparentes, no ocultas', sel.transparente && sel.visible);

  const norm = await js(`(async () => {
    const { normalizarTexto } = await import('./js/pdf/documento.js');
    return {
      ligadura: normalizarTexto('a\\ufb01n'),        // "aﬁn" → "afin"
      nbsp: normalizarTexto('a\\u00a0b') === 'a b',
      nulos: normalizarTexto('a\\u0000b'),
      normal: normalizarTexto('hola'),
    };
  })()`);
  ok('al copiar, la ligadura ﬁ se convierte en "fi"', norm.ligadura === 'afin', norm.ligadura);
  ok('el espacio duro se vuelve un espacio normal', norm.nbsp);
  ok('los nulos se van', norm.nulos === 'ab', JSON.stringify(norm.nulos));
  ok('y un texto normal no se toca', norm.normal === 'hola');

  /* ── 3-bis. La selección no AHUECA las letras ─────────────────────────────
     Declarando solo el fondo en ::selection, Chromium le pinta al texto
     seleccionado su propio color —el del esquema oscuro del sistema, porque la
     app no declara ninguno— y los spans dejan de ser invisibles: rellenan de
     claro las letras negras del canvas y quedan de contorno. Se ve perfecto en
     cualquier assert de DOM y espantoso en pantalla, así que se mide la
     PANTALLA: con el texto seleccionado, el centro del trazo tiene que seguir
     siendo oscuro. */
  const marco = await js(`(() => {
    const b = window.__pliego(1).querySelector('.qr-texto span').getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), vw: innerWidth };
  })()`);

  /* Cuenta los píxeles OSCUROS del rectángulo del span, o sea cuánto glifo hay.
     Ese número es el que denuncia el ahuecado: relleno de claro, del trazo solo
     sobrevive el contorno y la cuenta se desploma. El píxel más oscuro no
     sirve —el contorno sigue siendo negro— ni el más claro —el relleno da 233,
     que pasa por velo—. Solo la CUENTA distingue una letra maciza de una hueca. */
  const glifo = async () => {
    const foto = await win.webContents.capturePage();
    const tam = foto.getSize();
    const bmp = foto.toBitmap();                       // BGRA
    const k = tam.width / marco.vw;                    // px de imagen por px CSS
    let oscuros = 0; let claro = 0;
    for (let y = Math.round((marco.y + 2) * k); y < (marco.y + marco.h - 2) * k; y++) {
      for (let x = Math.round((marco.x + 2) * k); x < (marco.x + marco.w - 2) * k; x++) {
        const i = (y * tam.width + x) * 4;
        const g = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
        if (g < 128) oscuros++;
        if (g > claro) claro = g;
      }
    }
    return { oscuros, claro: Math.round(claro) };
  };

  const limpio = await glifo();
  await js(`(() => {
    const span = window.__pliego(1).querySelector('.qr-texto span');
    const r = document.createRange(); r.selectNodeContents(span);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  })()`);
  await esperar(400);
  const marcado = await glifo();
  await js(`getSelection().removeAllRanges()`);

  const merma = 1 - marcado.oscuros / (limpio.oscuros || 1);

  console.log('\n3-bis. La selección no ahueca las letras');
  ok(`el glifo no pierde cuerpo al seleccionarlo (${limpio.oscuros} px oscuros → ${marcado.oscuros}, ${(merma * 100).toFixed(0)}% menos)`,
    merma < 0.2);
  ok(`y el velo se ve sobre el papel blanco (el píxel más claro pasa de ${limpio.claro} a ${marcado.claro})`,
    marcado.claro < limpio.claro - 8 && marcado.claro > 150);

  // ── 4. La selección sigue calzando después de zoomear ─────────────────────
  await js(`(async () => {
    const { reescalar } = await import('./js/views/lector.js');
    const { S } = await import('./js/estado.js');
    S.modoZoom = 'fijo'; S.zoom = 2;
    reescalar();
  })()`);
  await esperar(1800);

  const zoom = await js(`(() => {
    const pliego = window.__pliego(1);
    const span = pliego.querySelector('.qr-texto span');
    if (!span) return { sinSpan: true };
    const tinta = window.__letras(pliego, { desdePt: 60, hastaPt: 160 });
    const caja = window.__spanEnPt(pliego, span);
    return { tinta, caja, escala: pliego.getBoundingClientRect().width / 595 };
  })()`);

  console.log('\n4. Después de zoomear al 200%');
  ok('la capa se rehizo', !zoom.sinSpan && !!zoom.tinta, JSON.stringify(zoom));
  if (zoom.tinta) {
    ok(`el span sigue sobre las letras (letras ${zoom.tinta.izq.toFixed(1)} pt · span ${zoom.caja.izq.toFixed(1)} pt)`,
      Math.abs(zoom.tinta.izq - zoom.caja.izq) < 6);
    ok('a la escala nueva', zoom.escala > 1.5, `escala ${zoom.escala.toFixed(2)}`);
  }

  // ── 5. Girada, la capa sigue cubriendo la hoja ────────────────────────────
  await js(`(async () => {
    const { reescalar } = await import('./js/views/lector.js');
    const { S } = await import('./js/estado.js');
    S.modoZoom = 'pagina'; S.rotacion = 90;
    reescalar();
  })()`);
  await esperar(1800);

  const girada = await js(`(() => {
    const pliego = window.__pliego(1);
    const div = pliego.querySelector('.qr-texto');
    const p = pliego.getBoundingClientRect();
    const d = div.getBoundingClientRect();
    return {
      rotacionEnElAtributo: div.getAttribute('data-main-rotation'),
      spans: div.querySelectorAll('span').length,
      apaisado: p.width > p.height,
      // Girada 90°, la capa se arma vertical y el transform la acuesta encima.
      cubre: Math.abs(d.width - p.width) < 2 && Math.abs(d.height - p.height) < 2,
      medidas: 'capa ' + Math.round(d.width) + '×' + Math.round(d.height)
             + ' · pliego ' + Math.round(p.width) + '×' + Math.round(p.height),
    };
  })()`);

  console.log('\n5. Con la página girada 90°');
  ok('la capa se rehace', girada.spans > 0);
  ok('el pliego quedó apaisado', girada.apaisado);
  ok('pdf.js dejó el ángulo en el atributo', girada.rotacionEnElAtributo === '90', String(girada.rotacionEnElAtributo));
  ok('y la capa girada cubre la hoja', girada.cubre, girada.medidas);

  // ── 6. Anotando, el texto suelta el puntero ───────────────────────────────
  await js(`(async () => {
    const { S } = await import('./js/estado.js');
    S.rotacion = 0;
    document.getElementById('qr-tinta-toggle').click();
  })()`);
  await esperar(600);

  const anotando = await js(`(() => {
    const div = window.__pliego(1).querySelector('.qr-texto');
    const span = div.querySelector('span');
    const tinta = window.__pliego(1).querySelector('.qr-tinta');
    return {
      modo: document.getElementById('qr-visor').classList.contains('is-anotando'),
      capaPointer: getComputedStyle(div).pointerEvents,
      spanSelect: span ? getComputedStyle(span).userSelect : null,
      tintaPointer: getComputedStyle(tinta).pointerEvents,
    };
  })()`);

  console.log('\n6. Con el modo de anotación activo');
  ok('el visor entró en modo anotación', anotando.modo);
  ok('el texto suelta el puntero', anotando.capaPointer === 'none', anotando.capaPointer);
  ok('y deja de ser seleccionable', anotando.spanSelect === 'none', String(anotando.spanSelect));
  ok('la tinta lo toma', anotando.tintaPointer === 'auto', anotando.tintaPointer);

  // ── 7. La virtualización se lleva los spans ───────────────────────────────
  const virtual = await js(`(async () => {
    document.getElementById('qr-tinta-toggle').click();   // salir de anotación
    const visor = document.getElementById('qr-visor');
    const antes = window.__pliego(1).querySelectorAll('.qr-texto span').length;
    visor.scrollTop = visor.scrollHeight;                 // irse bien lejos
    await new Promise((r) => setTimeout(r, 1800));
    const despues = window.__pliego(1).querySelectorAll('.qr-texto span').length;
    const ultima = document.querySelectorAll('.qr-pliego.is-pintada .qr-texto span').length;
    return { antes, despues, ultima };
  })()`);

  console.log('\n7. Virtualización');
  ok('la página en pantalla tenía spans', virtual.antes > 0);
  ok('la que se fue los soltó', virtual.despues === 0, `quedaron ${virtual.despues}`);
  ok('y las que llegaron los tienen', virtual.ultima > 0, `${virtual.ultima} spans`);

  clearTimeout(reloj);
  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores) console.log('  ! ' + e);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  win.destroy();
  app.exit(fail || errores.length ? 1 : 0);
}).catch((e) => morir('el test se rompió', e));
