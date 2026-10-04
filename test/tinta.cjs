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
const { vigilarConsola } = require('./consola.cjs');
const { abandono } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');
const HTML = path.join(RAIZ, 'renderer', '_tinta.html');

/* Si algo se cuelga o tira, la suite sale con código 3 diciendo por qué en
   vez de quedarse con Electron abierto (tests-07). Y la página del test se
   borra en TODAS las salidas (tests-08): también cuando explota a mitad de
   camino, que es cuando antes quedaba en renderer/ y se empaquetaba. */
const bail = abandono({ ms: 150000 });
const salirApp = app.exit.bind(app);
app.exit = (c) => { try { fs.rmSync(HTML, { force: true }); } catch { /* ya no está */ } salirApp(c); };

/* Un PDF chico con contraseña de apertura «quire» (RC4, hecho con pypdf): el
   mismo de lector.cjs. pdf-lib no cifra, así que va acá adentro. */
const CON_CLAVE_B64 = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDM3YzhmZTlmOGI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAxCi9SIDIKL0xlbmd0aCA0MAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDxjNzI4ODNjN2M5OWQzYzcwODU3NjE3NDBhNTBiYmE4YjdlOGJjYjg5NGViZTUzNGY5YzlhOTUxMDhmY2JkNWIyPgovVSA8M2FhODUyYWRiZWNhY2ZiOWJkNDdlZWFhMDliYmRjMTU2NDg4MDk5Nzc3YzUwM2Y0YWIzNGMxZTQ4ZDJhNjY4MT4KPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjYxIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzUzOTYzMzIzMDYyNjI2MTY1NjMzODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjQ3NQolJUVPRgo=';

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}` + (process.env.VERBOSO ? ' ' + x : '')); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

app.whenReady().then(async () => {
  fs.writeFileSync(HTML,
    '<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:;">\n'
    /* Lo mismo que lector.css le pone a la tinta: el canvas mide el 100 % de
       su pliego. Es lo que tinta-02 necesita para que la tinta se estire con
       la hoja. */
    + '<style>body{margin:0} .pliego{position:relative;overflow:hidden;background:#fff;isolation:isolate}'
    + ' .qr-tinta,.qr-tinta-resaltador,.qr-tinta-viva,.qr-tinta-calco{position:absolute;inset:0;width:100%;height:100%}'
    + ' .qr-tinta{touch-action:none} .qr-tinta-viva,.qr-tinta-calco{pointer-events:none}</style>\n'
    + '<body></body>\n');

  /* Fuera de pantalla pero VISIBLE: con show:false Chromium no corre los
     requestAnimationFrame, y el editor redibuja de a un cuadro. */
  const win = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 900, height: 700 });
  const errores = [];
  vigilarConsola(win, errores, { largo: 180 });
  await win.loadFile(HTML);
  win.showInactive();

  const r = await win.webContents.executeJavaScript(`(async () => {
    /* El disco de mentira. capa.js lee window.onyx al cargarse, así que va
       antes del primer import. 'ok' escribe en el acto; 'manual' deja la
       escritura colgada hasta que el test la suelta (para meter un trazo en el
       medio); 'falla' rechaza, como un disco lleno. Cada escritura se
       serializa en el momento de la llamada, igual que el preload. */
    window.__disco = { modo: 'ok', escritos: [], pendientes: [] };
    window.onyx = { col: () => ({
      save(obj) {
        const d = window.__disco;
        const foto = JSON.parse(JSON.stringify(obj));
        if (d.modo === 'falla') return Promise.reject(new Error('EACCES: sin permiso'));
        if (d.modo === 'manual') return new Promise((ok) => d.pendientes.push(() => { d.escritos.push(foto); ok({ ok: true }); }));
        d.escritos.push(foto);
        return Promise.resolve({ ok: true });
      },
      get: async () => null,
      remove: async () => {},
      list: async () => [],
    }) };

    const { CapaDeTinta, idDocumento } = await import('./js/tinta/capa.js');
    const { aplanarTinta } = await import('./js/tinta/aplanar.js');
    const { contornoDeTrazo, pathDeContorno, trazoTocado, cajaDeTrazo, recortarTrazo } = await import('./js/tinta/contorno.js');
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

    // ── La goma corta un TRAMO, en el borde exacto del círculo ────────────
    const recta = [[0, 0, 1], [100, 0, 0.5]];           // presión que baja a lo largo
    salida.recorte = {
      // por el medio, con los dos extremos afuera: dos pedazos que terminan
      // y empiezan justo en el borde, con la presión interpolada ahí
      medio: recortarTrazo(recta, 50, 0, 10),
      // mordida en una punta: un pedazo
      punta: recortarTrazo(recta, 0, 0, 10),
      // se lo come entero
      entero: recortarTrazo(recta, 50, 0, 80),
      // ni lo toca
      lejos: recortarTrazo(recta, 50, 40, 10),
      // un toque de un solo punto: se va o se queda, no se parte
      toqueDentro: recortarTrazo([[5, 5, 1]], 0, 0, 10),
      toqueFuera: recortarTrazo([[50, 50, 1]], 0, 0, 10),
      // los puntos que caen adentro se van, y el corte cae entre muestras
      muestreado: recortarTrazo([[0, 0, 1], [20, 0, 1], [40, 0, 1], [60, 0, 1], [80, 0, 1]], 40, 0, 15),
    };

    // ── Borrar por área: recorta, respeta el orden, y un gesto es UN deshacer
    /* Los pedazos que quedan en la capa, uno por uno. No es capa.cuenta: esa
       cuenta trazos como los hizo Fran, y un trazo partido sigue siendo uno
       (tinta-19). Acá lo que se mide es justamente en cuántos quedó partido. */
    const pedazosDe = (c) => [...c.paginas.values()].reduce((n, l) => n + l.length, 0);
    const bo = new CapaDeTinta({ ruta: 'C:/x/bo.pdf', nombre: 'bo.pdf', tamano: 1 });
    const abajo = bo.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [50, 0, 1]] });
    // a 30 pt de la pluma: la goma (radio 6 + medio ancho 7) no lo alcanza
    const arriba = bo.agregar(1, { herramienta: 'resaltador', color: '#ff0', ancho: 14, puntos: [[0, 30, 1], [50, 30, 1]] });
    bo.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[300, 300, 1], [350, 300, 1]] });
    // radio 6 sobre la pluma de ancho 2: alcance 7, el hueco va de 18 a 32
    const recortados = bo.borrarEn(1, 25, 0, 6);
    const tras = bo.trazos(1);
    salida.borrarEn = {
      recortados,
      quedan: pedazosDe(bo),
      pedazos: tras.filter((t) => t.herramienta === 'pluma' && t.puntos[0][1] === 0).map((t) => t.puntos),
      // el resaltador que estaba ENCIMA sigue encima de los dos pedazos
      ordenRespetado: tras.findIndex((t) => t.id === arriba.id) === 2,
      originalSeFue: !tras.some((t) => t.id === abajo.id),
      historial: bo.historial.length,
      seDeshace: (bo.deshacer(), pedazosDe(bo)),
      vuelveElOriginal: bo.trazos(1)[0].id === abajo.id,
      seRehace: (bo.rehacer(), pedazosDe(bo)),
    };

    // Un gesto: dos toques de goma que van comiendo el mismo trazo son una
    // sola entrada del historial, y deshacerla devuelve el trazo entero.
    const ge = new CapaDeTinta({ ruta: 'C:/x/ge.pdf', nombre: 'ge.pdf', tamano: 1 });
    const largoTrazo = ge.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [100, 0, 1]] });
    ge.empezarBorrado();
    ge.borrarEn(1, 25, 0, 4);
    ge.borrarEn(1, 75, 0, 4);       // muerde el pedazo de la derecha del corte anterior
    ge.terminarBorrado();
    salida.gesto = {
      pedazos: pedazosDe(ge),
      historial: ge.historial.length,
      cortes: ge.historial[1].cortes.length,
      seDeshaceDeUna: (ge.deshacer(), pedazosDe(ge)),
      entero: ge.trazos(1)[0]?.id === largoTrazo.id && ge.trazos(1)[0].puntos.length === 2,
      seRehaceDeUna: (ge.rehacer(), pedazosDe(ge)),
    };

    // ── El id del documento es estable y seguro como nombre de archivo ────
    const doc1 = { ruta: 'C:/x/a.pdf', nombre: 'a.pdf', tamano: 100 };
    salida.id = {
      estable: idDocumento(doc1) === idDocumento({ ...doc1 }),
      distintoPorTamano: idDocumento(doc1) !== idDocumento({ ...doc1, tamano: 101 }),
      formato: idDocumento(doc1),
      seguro: /^t-[0-9a-f]{8}$/.test(idDocumento(doc1)),
    };

    // ── El shim de compatibilidad de pdf.js ──────────────────────────────
    await import('./vendor/pdfjs/compat.mjs');
    const s = Math.sumPrecise;
    salida.compat = {
      existe: typeof s,
      // Kahan-Neumaier: la suma naive de esto da 1, no 2.
      precision: s([1, 1e100, 1, -1e100]),
      naive: [1, 1e100, 1, -1e100].reduce((a, b) => a + b, 0),
      simple: s([1, 2, 3]),
      vacio: Object.is(s([]), -0),
      conInfinito: s([1, Infinity]),
      conNaN: Number.isNaN(s([1, NaN])),
      // Y que ningún render escupa el warning.
      sinWarnings: true,
    };

    return salida;
  })()`, true).catch((e) => ({ error: String(e) }));

  if (r.error) { bail('la primera parte tiró', r.error); return; }

  /* ── El editor, con el puntero ─────────────────────────────────────────
     Se arma un pliego con su canvas como el del lector y se le tiran
     PointerEvents sintéticos. setPointerCapture rechaza un pointerId que no
     existe de verdad: se neutraliza acá, en el test, y no en stroke.js (vino
     de Scrawl sin cambios y así se queda). */
  const e = await win.webContents.executeJavaScript(`(async () => {
    const CON_CLAVE_B64 = ${JSON.stringify(CON_CLAVE_B64)};
    const editorMod = await import('./js/tinta/editor.js');
    const { cablearTinta } = editorMod;
    const { CapaDeTinta, HERRAMIENTAS, contarTrazos } = await import('./js/tinta/capa.js');
    const { aplanarTinta, contarTinta } = await import('./js/tinta/aplanar.js');
    const { abrirDocumento } = await import('./js/pdf/documento.js');
    const { Icons } = await import('./js/icons.js');
    await import('./js/iconos.js');
    const { PDFDocument, PDFName } = await import('./vendor/pdf-lib/pdf-lib.mjs');

    const bytes = new Uint8Array(await (await fetch('./vendor/cobayo.pdf')).arrayBuffer());
    const doc = await abrirDocumento(bytes.slice(), { nombre: 'cobayo.pdf' });
    const g = await doc.geometria(1);
    const dpr = window.devicePixelRatio || 1;
    const cuadro = () => new Promise((ok) => requestAnimationFrame(() => ok()));
    const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const salida = {};
    let n = 0;
    /* Las capas de la primera parte programaron su guardado a 900 ms. Se espera
       a que salgan: si no, alguna cae justo cuando el disco de mentira está en
       'falla' y suma un aviso que no es de esta prueba. */
    await esperar(1000);

    /* Un pliego con su canvas de tinta, del tamaño que el lector le daría a la
       escala pedida. El viewport va a escala × dpr, igual que montarTinta. */
    async function montar({ escala = 1, herramienta = 'pluma', ...extra } = {}) {
      const pliego = document.createElement('div');
      pliego.className = 'pliego';
      const canvas = document.createElement('canvas');
      canvas.className = 'qr-tinta';
      pliego.append(canvas);
      document.body.prepend(pliego);
      const viewport = await doc.viewport(1, { escala: escala * dpr });
      pliego.style.width = (viewport.width / dpr) + 'px';
      pliego.style.height = (viewport.height / dpr) + 'px';
      const capa = new CapaDeTinta({ ruta: 'C:/x/e' + (++n) + '.pdf', nombre: 'e.pdf', tamano: n });
      capa.esperaGuardado = 1e9;     // acá no se mira el disco
      const sel = { id: herramienta };
      const ed = cablearTinta(canvas, {
        pagina: 1, capa, viewport,
        herramienta: () => ({ ...HERRAMIENTAS[sel.id], id: sel.id }),
        activo: () => true,
        ...extra,
      });
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      /* Un puntero en fracciones del PLIEGO, no del canvas: Fran apunta a la
         hoja que ve, y la hoja mide lo que mide el pliego. Si la tinta no lo
         sigue (tinta-02), el puntero cae corrido respecto de ella. Por
         defecto, el lápiz con la punta apoyada; o pisa lo que haga falta. */
      const tirar = (tipo, fx, fy, o = {}) => {
        const r = pliego.getBoundingClientRect();
        const arriba = tipo === 'pointerup';
        canvas.dispatchEvent(new PointerEvent(tipo, {
          pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          pressure: arriba ? 0 : 0.5, button: tipo === 'pointermove' ? -1 : 0, buttons: arriba ? 0 : 1,
          clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
          ...o,
        }));
      };
      // De fracciones del pliego a coordenadas de página (Y hacia arriba).
      const enPagina = (fx, fy) => [fx * g.anchoPt, (1 - fy) * g.altoPt];
      return { pliego, canvas, capa, ed, sel, tirar, enPagina, viewport };
    }

    // ── tinta-02: la tinta se estira con su pliego, y el puntero sigue a la tinta
    {
      const m = await montar({ escala: 0.6 });
      const sinTamanoEnLinea = m.canvas.style.width === '' && m.canvas.style.height === '';
      // Lo que hace reescalar(): el pliego cambia de tamaño, el editor todavía no.
      const w = parseFloat(m.pliego.style.width);
      const h = parseFloat(m.pliego.style.height);
      m.pliego.style.width = (w * 2) + 'px';
      m.pliego.style.height = (h * 2) + 'px';
      await cuadro();
      const rc = m.canvas.getBoundingClientRect();
      const rp = m.pliego.getBoundingClientRect();
      // Se dibuja en ese rato, con el viewport viejo: tiene que caer donde se ve.
      m.tirar('pointerdown', 0.25, 0.5);
      for (let i = 1; i <= 5; i++) m.tirar('pointermove', 0.25 + i * 0.1, 0.5);
      m.tirar('pointerup', 0.75, 0.5);
      const t = m.capa.trazos(1)[0];
      const esperado = m.enPagina(0.25, 0.5);
      salida.estira = {
        sinTamanoEnLinea,
        dx: +Math.abs(rc.width - rp.width).toFixed(2), dy: +Math.abs(rc.height - rp.height).toFixed(2),
        primerPunto: t?.puntos[0], esperado,
        error: t ? +Math.hypot(t.puntos[0][0] - esperado[0], t.puntos[0][1] - esperado[1]).toFixed(2) : null,
      };
      // Y con el viewport nuevo: actualizar() existe y deja todo en su lugar.
      const nuevo = await doc.viewport(1, { escala: 1.2 * dpr });
      const anchoAntes = m.canvas.width;
      let tras = null;
      if (typeof m.ed.actualizar === 'function') {
        m.ed.actualizar(nuevo);
        m.tirar('pointerdown', 0.5, 0.25);
        m.tirar('pointermove', 0.6, 0.25);
        m.tirar('pointerup', 0.6, 0.25);
        const t2 = m.capa.trazos(1)[1];
        const e2 = m.enPagina(0.5, 0.25);
        tras = {
          bitmap: +(m.canvas.width / anchoAntes).toFixed(2),
          error: t2 ? +Math.hypot(t2.puntos[0][0] - e2[0], t2.puntos[0][1] - e2[1]).toFixed(2) : null,
        };
      }
      salida.estira.actualizar = tras;
      m.pliego.remove();
    }

    // ── lector-22: el bitmap de la tinta tiene tope, y el trazo cae igual donde va
    {
      const m = await montar({ escala: 10 / dpr });     // viewport de ~5950 × 8420
      m.capa.agregar(1, { herramienta: 'pluma', color: '#ff0000', ancho: 20, opacidad: 1,
        puntos: [[g.anchoPt * 0.4, g.altoPt / 2, 1], [g.anchoPt * 0.6, g.altoPt / 2, 1]] });
      m.ed.redibujar();
      // Con un trazo, para que reserve (sin trazos no reserva nada: lector-23).
      const area = m.canvas.width * m.canvas.height;
      const cx = Math.round(m.canvas.width / 2);
      const cy = Math.round(m.canvas.height / 2);
      const px = m.canvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
      salida.tope = {
        area, tope: 2 ** 25, viewport: Math.round(m.viewport.width * m.viewport.height),
        exportado: editorMod.MAX_PIXELES,
        rojoEnElCentro: px[0] > 200 && px[1] < 60 && px[3] > 200,
      };
      m.canvas.width = 0; m.canvas.height = 0;
      m.pliego.remove();
    }

    // ── tinta-04: un editor destruido no dibuja, y no pierde el trazo a medias
    {
      const m = await montar();
      m.tirar('pointerdown', 0.2, 0.3);
      for (let i = 1; i <= 4; i++) m.tirar('pointermove', 0.2 + i * 0.05, 0.3);
      m.ed.destruir();
      const trasDestruir = m.capa.trazos(1).length;
      const puntos = m.capa.trazos(1)[0]?.puntos.length ?? 0;
      m.tirar('pointermove', 0.5, 0.3);
      m.tirar('pointerup', 0.5, 0.3);
      // Y un trazo entero sobre el editor ya muerto no entra.
      m.tirar('pointerdown', 0.2, 0.6);
      m.tirar('pointermove', 0.4, 0.6);
      m.tirar('pointerup', 0.4, 0.6);
      salida.destruir = { trasDestruir, puntos, alFinal: m.capa.trazos(1).length, vivo: m.ed.vivo };
      m.pliego.remove();
    }

    // ── tinta-05: la goma del lápiz borra con el ancho del borrador
    async function pasadaDeGoma(extra) {
      const m = await montar({ herramienta: 'pluma', ...extra });
      const y = g.altoPt / 2;
      m.capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 1.8, opacidad: 1,
        puntos: [[g.anchoPt * 0.2, y, 1], [g.anchoPt * 0.8, y, 1]] });
      const goma = { pointerType: 'pen', button: 5, buttons: 32 };
      m.tirar('pointerdown', 0.5, 0.4, goma);
      for (let i = 1; i <= 10; i++) m.tirar('pointermove', 0.5, 0.4 + i * 0.02, { ...goma, button: -1 });
      m.tirar('pointerup', 0.5, 0.6, { ...goma, buttons: 0 });
      const ps = m.capa.trazos(1).map((t) => t.puntos.map((p) => p[0])).sort((a, b) => a[0] - b[0]);
      m.pliego.remove();
      return { pedazos: ps.length, hueco: ps.length === 2 ? +(ps[1][0] - ps[0].at(-1)).toFixed(2) : null };
    }
    salida.goma = {
      porDefecto: await pasadaDeGoma({}),
      conOpcion: await pasadaDeGoma({ goma: () => ({ id: 'borrador', ancho: 30 }) }),
    };

    // ── tinta-15: los otros botones no dibujan; el lateral y el del medio desplazan
    {
      const fases = [];
      const sinPan = await montar();
      const raya = (m, o) => {
        m.tirar('pointerdown', 0.2, 0.5, o);
        m.tirar('pointermove', 0.4, 0.5, { ...o, button: -1 });
        m.tirar('pointerup', 0.4, 0.5, { ...o, buttons: 0 });
      };
      raya(sinPan, { pointerType: 'mouse', button: 2, buttons: 2 });                // clic derecho
      raya(sinPan, { pointerType: 'mouse', button: 1, buttons: 4 });                // rueda
      raya(sinPan, { pointerType: 'pen', button: 2, buttons: 3 });                  // lateral del lápiz
      const conPan = await montar({ onPan: (p) => fases.push(p.fase) });
      raya(conPan, { pointerType: 'mouse', button: 2, buttons: 2 });                // derecho: ni dibuja ni desplaza
      raya(conPan, { pointerType: 'mouse', button: 1, buttons: 4 });
      raya(conPan, { pointerType: 'pen', button: 2, buttons: 3 });
      salida.botones = {
        trazosSinPan: sinPan.capa.trazos(1).length,
        trazosConPan: conPan.capa.trazos(1).length,
        fases: fases.join(' '),
      };
      sinPan.pliego.remove(); conPan.pliego.remove();
    }

    // ── tinta-22: el trazo llega hasta donde se levantó el lápiz
    {
      const m = await montar();
      m.tirar('pointerdown', 0.2, 0.5);
      for (let i = 1; i <= 10; i++) m.tirar('pointermove', 0.2 + i * 0.04, 0.5);
      m.tirar('pointerup', 0.6, 0.5);
      const ult = m.capa.trazos(1)[0]?.puntos.at(-1);
      const esperado = m.enPagina(0.6, 0.5);
      salida.remate = { ultimo: ult, esperado, falta: ult ? +Math.hypot(ult[0] - esperado[0], ult[1] - esperado[1]).toFixed(2) : null };
      m.pliego.remove();
    }

    // ── tinta-11: la goma redibuja a lo sumo una vez por cuadro y avisa al terminar
    {
      const m = await montar({ herramienta: 'borrador' });
      for (let i = 0; i < 6; i++) {
        const x = g.anchoPt * (0.2 + i * 0.1);
        m.capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1,
          puntos: [[x, g.altoPt * 0.3, 1], [x, g.altoPt * 0.7, 1]] });
      }
      const ctx = m.canvas.getContext('2d');
      let redibujos = 0;
      const clear = ctx.clearRect.bind(ctx);
      ctx.clearRect = (...a) => { redibujos++; return clear(...a); };
      let avisos = 0;
      m.capa.onCambio = () => { avisos++; };
      await cuadro();
      // Todo en la misma tarea: es un cuadro con seis puntos coalescidos.
      m.tirar('pointerdown', 0.15, 0.5);
      for (let i = 0; i < 6; i++) m.tirar('pointermove', 0.2 + i * 0.1, 0.5);
      const enLaRafaga = { redibujos, avisos };
      await cuadro(); await cuadro();
      const trasElCuadro = { redibujos, avisos };
      m.tirar('pointerup', 0.7, 0.5);
      salida.rafaga = { enLaRafaga, trasElCuadro, alSoltar: { redibujos, avisos }, quedan: m.capa.trazos(1).length };
      m.pliego.remove();
    }

    // ── tinta-23: con un lápiz visto, la palma no bloquea al lápiz
    {
      const m = await montar();
      m.tirar('pointerdown', 0.1, 0.1);                 // un toque del lápiz: ya se vio uno
      m.tirar('pointerup', 0.1, 0.1);
      const dedo = { pointerId: 9, pointerType: 'touch', pressure: 0.5 };
      m.tirar('pointerdown', 0.8, 0.8, dedo);            // la palma, apoyada
      m.tirar('pointerdown', 0.2, 0.5);                  // el lápiz, mientras tanto
      for (let i = 1; i <= 6; i++) m.tirar('pointermove', 0.2 + i * 0.05, 0.5);
      m.tirar('pointerup', 0.5, 0.5);
      m.tirar('pointerup', 0.8, 0.8, { ...dedo, buttons: 0 });
      const enLaPalma = m.enPagina(0.8, 0.8);
      const trazos = m.capa.trazos(1);
      salida.palma = {
        trazos: trazos.length,
        delLapiz: trazos.some((t) => t.puntos.length >= 5),
        enLaPalma: trazos.some((t) => Math.hypot(t.puntos[0][0] - enLaPalma[0], t.puntos[0][1] - enLaPalma[1]) < 5),
      };
      m.pliego.remove();
    }

    // ── tinta-03: un trazo que entra mientras se guarda no se pierde
    {
      const capa = new CapaDeTinta({ ruta: 'C:/x/g.pdf', nombre: 'g.pdf', tamano: 1 });
      capa.esperaGuardado = 1e9;
      window.__disco.modo = 'manual';
      window.__disco.escritos.length = 0;
      capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [10, 0, 1]] });
      const enCurso = capa.guardar();
      capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 20, 1], [10, 20, 1]] });
      window.__disco.pendientes.splice(0).forEach((soltar) => soltar());
      await enCurso;
      const suciaTras = capa.sucia;
      window.__disco.modo = 'ok';
      await capa.guardar();
      salida.guardado = {
        suciaTras,
        primero: window.__disco.escritos[0]?.paginas[1]?.length,
        segundo: window.__disco.escritos[1]?.paginas[1]?.length,
        suciaAlFinal: capa.sucia,
      };
    }

    // ── tinta-28: si el disco falla, se avisa UNA vez mientras siga fallando
    {
      const toasts = () => document.querySelectorAll('.ox-toast:not([data-state=closing])').length;
      const antes = toasts();
      const capa = new CapaDeTinta({ ruta: 'C:/x/f.pdf', nombre: 'f.pdf', tamano: 1 });
      capa.esperaGuardado = 20;
      const trazo = (y) => capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, y, 1], [10, y, 1]] });
      window.__disco.modo = 'falla';
      trazo(0); await esperar(150);
      const primerFallo = toasts() - antes;
      trazo(10); await esperar(150);
      const segundoFallo = toasts() - antes;
      window.__disco.modo = 'ok';
      trazo(20); await esperar(150);
      const sucia = capa.sucia;
      window.__disco.modo = 'falla';
      trazo(30); await esperar(150);
      salida.fallo = { primerFallo, segundoFallo, suciaTrasEscribir: sucia, vuelveAFallar: toasts() - antes };
      window.__disco.modo = 'ok';
    }

    // ── tinta-12: deshacer y rehacer dicen en qué página fue
    {
      const capa = new CapaDeTinta({ ruta: 'C:/x/d.pdf', nombre: 'd.pdf', tamano: 1 });
      capa.esperaGuardado = 1e9;
      capa.agregar(3, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [10, 0, 1]] });
      const d1 = capa.deshacer();
      const r1 = capa.rehacer();
      capa.deshacer();
      salida.deshacer = { pagina: d1?.pagina, rehacer: r1?.pagina, nada: capa.deshacer() };
    }

    // ── tinta-19: la goma no hace subir la cuenta
    {
      const capa = new CapaDeTinta({ ruta: 'C:/x/c.pdf', nombre: 'c.pdf', tamano: 1 });
      capa.esperaGuardado = 1e9;
      capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [100, 0, 1]] });
      capa.agregar(2, { herramienta: 'pluma', color: '#000', ancho: 2, puntos: [[0, 0, 1], [100, 0, 1]] });
      capa.borrarEn(1, 50, 0, 5);                 // parte el de la página 1 en dos
      capa.borrarEn(1, 25, 0, 5);                 // y un pedazo otra vez
      salida.cuenta = {
        pedazos: capa.trazos(1).length,
        cuenta: capa.cuenta,
        contarTinta: contarTinta(capa),
        soloLa1: contarTinta(capa, [1]),
        lista: typeof contarTrazos === 'function' ? contarTrazos(capa.trazos(1)) : null,
      };
    }

    // ── tinta-26: un ExtGState solo para lo que es transparente
    {
      const capa = new CapaDeTinta({ ruta: 'C:/x/x.pdf', nombre: 'x.pdf', tamano: 1 });
      capa.esperaGuardado = 1e9;
      for (let i = 0; i < 5; i++) {
        capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1, puntos: [[100, 100 + i * 20, 1], [300, 100 + i * 20, 1]] });
      }
      capa.agregar(1, { herramienta: 'resaltador', color: '#ffee00', ancho: 14, opacidad: 0.34, puntos: [[100, 400, 1], [300, 400, 1]] });
      const contarGS = async (b) => {
        const d = await PDFDocument.load(b, { ignoreEncryption: true });
        const gs = d.getPage(0).node.Resources()?.lookup(PDFName.of('ExtGState'));
        return gs ? gs.keys().length : 0;
      };
      const original = await contarGS(bytes);
      const aplanado = await contarGS(await aplanarTinta(bytes, capa));
      salida.extgstate = { original, aplanado, nuevos: aplanado - original };
    }

    /* Cuántos píxeles con tinta tiene un canvas. Se lee una COPIA (como
       PIXELES en _comun.cjs): leer dos veces el canvas del editor hace que
       Chromium avise por consola y hasta puede mudarlo a CPU. */
    const tinta = (c, test = (r, g, b, a) => a > 20) => {
      if (!c?.width) return 0;
      const k = document.createElement('canvas');
      k.width = c.width; k.height = c.height;
      const x = k.getContext('2d', { willReadFrequently: true });
      x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, k.width, k.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2], d[i + 3])) n++;
      return n;
    };
    const rojoOpaco = (r, g, b, a) => a > 120 && r > 130 && g < 90 && b < 90;
    const enElAire = { buttons: 0, pressure: 0, button: -1 };
    const capaDe = (m, clase) => m.pliego.querySelector('canvas.' + clase);

    /* Cada caso nuevo va en su propio try: corrido al revés, contra un editor
       que no arma estos canvas, el que explota no se lleva puestos a los demás. */
    const probar = async (fn) => {
      try { await fn(); } catch (err) { (salida.explotaron ||= []).push(String(err?.message || err).slice(0, 160)); }
    };

    // ── lector-23: sin trazos no se reserva nada; cada capa, cuando la necesita
    await probar(async () => {
      const m = await montar();
      const anchos = () => ({ resaltador: capaDe(m, 'qr-tinta-resaltador')?.width ?? -1, tinta: m.canvas.width, viva: capaDe(m, 'qr-tinta-viva')?.width ?? -1 });
      const vacio = anchos();
      m.capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1, puntos: [[100, 100, 1], [200, 100, 1]] });
      m.ed.redibujar();
      const conPluma = anchos();
      m.capa.agregar(1, { herramienta: 'resaltador', color: '#ffee00', ancho: 14, opacidad: 0.34, puntos: [[100, 200, 1], [200, 200, 1]] });
      m.ed.redibujar();
      const conResaltador = anchos();
      m.tirar('pointermove', 0.5, 0.5, enElAire);
      await cuadro(); await cuadro();
      const punta = anchos();
      m.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 7, pointerType: 'pen' }));
      salida.reserva = { vacio, conPluma, conResaltador, punta, seFue: anchos(), canvases: m.pliego.querySelectorAll('canvas').length };
      m.pliego.remove();
    });

    // ── tinta-10: mientras se dibuja, lo confirmado no se toca; lo vivo va arriba
    await probar(async () => {
      const m = await montar({ herramienta: 'fibra' });
      m.capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1, puntos: [[50, 50, 1], [80, 50, 1]] });
      m.ed.redibujar();
      const viva = capaDe(m, 'qr-tinta-viva');
      const ctx = m.canvas.getContext('2d');
      const vctx = viva?.getContext('2d');
      let toques = 0; let vivos = 0;
      for (const f of ['fill', 'clearRect', 'stroke']) { const o = ctx[f].bind(ctx); ctx[f] = (...a) => { toques++; return o(...a); }; }
      if (vctx) { const o = vctx.fill.bind(vctx); vctx.fill = (...a) => { vivos++; return o(...a); }; }
      m.tirar('pointerdown', 0.2, 0.5);
      for (let i = 1; i <= 8; i++) { m.tirar('pointermove', 0.2 + i * 0.05, 0.5); await cuadro(); }
      const durante = { toques, vivos, rojoVivo: tinta(viva, rojoOpaco), rojoFijo: tinta(m.canvas, rojoOpaco) };
      m.tirar('pointerup', 0.6, 0.5);
      salida.vivo = { durante, trasSoltar: { toques, rojoFijo: tinta(m.canvas, rojoOpaco), vivaConAlgo: tinta(viva) }, trazos: m.capa.trazos(1).length };
      m.pliego.remove();
    });

    // ── tinta-21: el anillo de la punta, y que se borra
    await probar(async () => {
      const m = await montar({ herramienta: 'borrador' });
      const viva = capaDe(m, 'qr-tinta-viva');
      const caja = () => {
        if (!viva?.width) return { n: 0, ancho: 0 };
        const k = document.createElement('canvas');
        k.width = viva.width; k.height = viva.height;
        const x = k.getContext('2d', { willReadFrequently: true });
        x.drawImage(viva, 0, 0);
        const d = x.getImageData(0, 0, k.width, k.height).data;
        let x0 = Infinity; let x1 = -Infinity; let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 40) continue;
          const px = (i / 4) % k.width; n++;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
        }
        return { n, ancho: n ? x1 - x0 + 1 : 0 };
      };
      m.tirar('pointermove', 0.5, 0.5, enElAire);
      await cuadro(); await cuadro();
      const anillo = { ...caja(), herramienta: viva?.dataset.herramienta };
      m.sel.id = 'pluma';
      m.tirar('pointermove', 0.52, 0.5, enElAire);
      await cuadro(); await cuadro();
      const punto = { ...caja(), herramienta: viva?.dataset.herramienta };
      m.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 7, pointerType: 'pen' }));
      salida.anillo = { anillo, punto, fuera: viva ? viva.width : -1, esperado: +(HERRAMIENTAS.borrador.ancho * m.viewport.scale).toFixed(1) };
      m.pliego.remove();
    });

    // ── tinta-13: lo que no hace el lápiz se funde
    await probar(async () => {
      const m = await montar();
      const y = g.altoPt / 2;
      const t = m.capa.agregar(1, { herramienta: 'fibra', color: '#ff0000', ancho: 12, opacidad: 1,
        puntos: [[g.anchoPt * 0.2, y, 1], [g.anchoPt * 0.8, y, 1]] });
      m.ed.redibujar();
      const entero = tinta(m.canvas, rojoOpaco);
      const muestrear = async (c) => {
        const serie = []; const t0 = performance.now();
        while (performance.now() - t0 < 360) { serie.push(c.isConnected ? +(+getComputedStyle(c).opacity).toFixed(2) : null); await esperar(20); }
        return serie;
      };
      // Deshacer el trazo: se va en un calco, la base ya no lo tiene.
      const op = m.capa.deshacer();
      const [sale] = m.ed.fundir({ salen: op.trazos });
      const sal = { baseRoja: tinta(m.canvas, rojoOpaco), calcoRojo: tinta(sale, rojoOpaco), serie: await muestrear(sale) };
      // Rehacerlo: llega en otro calco, y la base lo suma recién al final.
      const op2 = m.capa.rehacer();
      const [entra] = m.ed.fundir({ entran: op2.trazos });
      const ent = { baseRoja: tinta(m.canvas, rojoOpaco), serie: await muestrear(entra) };
      ent.baseAlFinal = tinta(m.canvas, rojoOpaco);
      ent.calcosQuedan = m.pliego.querySelectorAll('.qr-tinta-calco').length;
      // La goma: deshacerla trae solo el tramo comido, no el trazo entero encima de los pedazos.
      m.capa.empezarBorrado();
      m.capa.borrarEn(1, g.anchoPt * 0.5, y, 30);
      m.capa.terminarBorrado();
      m.ed.redibujar();
      const conHueco = tinta(m.canvas, rojoOpaco);
      const op3 = m.capa.deshacer();
      const originales = op3.cortes.map((c) => c.original);
      const pedazos = op3.cortes.flatMap((c) => c.piezas);
      const [tramo] = m.ed.fundir({ entran: originales, debajo: pedazos });
      const goma = { conHueco, baseConPedazos: tinta(m.canvas, rojoOpaco), tramo: tinta(tramo, rojoOpaco) };
      await esperar(420);
      goma.alFinal = tinta(m.canvas, rojoOpaco);
      salida.fundido = { entero, sal, ent, goma, mismoTrazo: m.capa.trazos(1)[0]?.id === t.id };
      m.pliego.remove();
    });

    // ── tinta-07: el resaltador se mezcla con multiply, en el PDF y al exportar
    await probar(async () => {
      /* Una hoja con un rectángulo negro a la izquierda: el resaltador lo cruza
         y sigue sobre el blanco. Sobre el negro tiene que seguir negro; sobre
         el blanco, el amarillo de siempre. */
      const base = await PDFDocument.create();
      base.addPage([400, 300]).drawRectangle({ x: 40, y: 100, width: 120, height: 100, color: (await import('./vendor/pdf-lib/pdf-lib.mjs')).rgb(0, 0, 0) });
      const bytesBase = await base.save();
      const capa = new CapaDeTinta({ ruta: 'C:/x/m.pdf', nombre: 'm.pdf', tamano: 7 });
      capa.esperaGuardado = 1e9;
      capa.agregar(1, { herramienta: 'resaltador', color: '#f1c40f', ancho: 40, opacidad: 0.34, puntos: [[60, 150, 1], [340, 150, 1]] });
      const aplanado = await aplanarTinta(bytesBase, capa);
      const d = await abrirDocumento(aplanado.slice(), { nombre: 'm.pdf' });
      const lienzo = await d.lienzo(1, { escala: 1, dpr: 1 });
      // Una sola lectura del lienzo: dos hacen que Chromium avise por consola.
      const todo = lienzo.getContext('2d').getImageData(0, 0, lienzo.width, lienzo.height).data;
      const px = (x, yPdf) => { const i = ((300 - yPdf) * lienzo.width + x) * 4; return [todo[i], todo[i + 1], todo[i + 2]]; };
      const pdf = { sobreNegro: px(100, 150), sobreBlanco: px(280, 150) };
      d.destruir();
      const docM = await PDFDocument.load(aplanado);
      const gs = docM.getPage(0).node.Resources()?.lookup(PDFName.of('ExtGState'));
      pdf.modos = gs ? gs.keys().map((k) => String(gs.lookup(k).get(PDFName.of('BM')))) : [];
      salida.multiply = { pdf };

      // Exportar a imagen: componerTinta sobre la página ya rasterizada.
      const { componerTinta } = await import('./js/tinta/capa.js');
      const c = document.createElement('canvas');
      c.width = 400; c.height = 300;
      const cx = c.getContext('2d', { alpha: false, willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 400, 300);
      cx.fillStyle = '#000'; cx.fillRect(40, 100, 120, 100);
      const vpM = { transform: [1, 0, 0, -1, 0, 300], scale: 1 };
      componerTinta(cx, capa.trazos(1), vpM, { dpr: 1 });
      const leer = (x, yPdf) => [...cx.getImageData(x, 300 - yPdf, 1, 1).data].slice(0, 3);
      salida.multiply.exportar = { sobreNegro: leer(100, 150), sobreBlanco: leer(280, 150) };
    });

    // ── PDF con contraseña: aplanar avisa y no escribe hojas en blanco (decisión de Fran)
    await probar(async () => {
      const capa = new CapaDeTinta({ ruta: 'C:/x/k.pdf', nombre: 'k.pdf', tamano: 9, conClave: true });
      capa.esperaGuardado = 1e9;
      capa.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1, puntos: [[10, 10, 1], [40, 40, 1]] });
      const porLaMarca = await aplanarTinta(bytes, capa).then(() => 'aplanó', (err) => ({ code: err.code, texto: err.message }));
      /* El mismo PDF chico cifrado que usa lector.cjs (RC4, contraseña «quire»),
         con una capa cuyo documento no dice nada: lo delata el /Encrypt. */
      const cifrado = Uint8Array.from(atob(CON_CLAVE_B64), (ch) => ch.charCodeAt(0));
      const capa2 = new CapaDeTinta({ ruta: 'C:/x/k2.pdf', nombre: 'k2.pdf', tamano: 10 });
      capa2.esperaGuardado = 1e9;
      capa2.agregar(1, { herramienta: 'pluma', color: '#000', ancho: 2, opacidad: 1, puntos: [[10, 10, 1], [40, 40, 1]] });
      const porLosBytes = await aplanarTinta(cifrado, capa2).then(() => 'aplanó', (err) => ({ code: err.code, texto: err.message }));
      salida.conClave = { porLaMarca, porLosBytes };
    });

    // ── tinta-24, ux-19: los colores con nombre
    await probar(async () => {
      const { COLORES } = await import('./js/tinta/capa.js');
      salida.colores = COLORES.map((c) => c?.nombre ?? String(c));
    });

    // ── tinta-14: el resaltador tiene su ícono, distinto del marcador del esquema
    salida.icono = {
      herramienta: HERRAMIENTAS.resaltador.icono,
      existe: Icons.has('resaltador'),
      distinto: Icons.has('resaltador') && Icons.svg('resaltador') !== Icons.svg('marcador'),
    };

    doc.destruir();
    return salida;
  })()`, true).catch((err) => ({ error: String(err) }));

  if (e.error) { bail('el editor tiró', e.error); return; }

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
  {
    const c = r.recorte;
    const iguales = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('por el medio parte en dos, cortando en el borde exacto',
      c.medio.length === 2 && iguales(c.medio[0], [[0, 0, 1], [40, 0, 0.8]]) && iguales(c.medio[1], [[60, 0, 0.7], [100, 0, 0.5]]),
      JSON.stringify(c.medio));
    ok('mordida en la punta deja un pedazo', c.punta.length === 1 && iguales(c.punta[0], [[10, 0, 0.95], [100, 0, 0.5]]),
      JSON.stringify(c.punta));
    ok('la goma grande se lo come entero', c.entero.length === 0, JSON.stringify(c.entero));
    ok('lejos no pasa nada', c.lejos.length === 1 && iguales(c.lejos[0], [[0, 0, 1], [100, 0, 0.5]]), JSON.stringify(c.lejos));
    ok('un toque adentro se va, uno afuera se queda', c.toqueDentro.length === 0 && c.toqueFuera.length === 1);
    ok('con puntos muestreados el corte cae ENTRE muestras',
      c.muestreado.length === 2 && iguales(c.muestreado[0], [[0, 0, 1], [20, 0, 1], [25, 0, 1]])
        && iguales(c.muestreado[1], [[55, 0, 1], [60, 0, 1], [80, 0, 1]]),
      JSON.stringify(c.muestreado));
  }
  {
    const b = r.borrarEn;
    ok('borrarEn recorta solo el trazo tocado', b.recortados === 1, JSON.stringify(b));
    ok('y lo deja en dos pedazos con el hueco del tamaño de la goma',
      b.quedan === 4 && JSON.stringify(b.pedazos) === JSON.stringify([[[0, 0, 1], [18, 0, 1]], [[32, 0, 1], [50, 0, 1]]]),
      JSON.stringify(b.pedazos));
    ok('los pedazos ocupan el lugar del original: lo de arriba sigue arriba', b.ordenRespetado && b.originalSeFue);
    ok('es UNA entrada del historial', b.historial === 4, `${b.historial}`);
    ok('deshacer devuelve el trazo entero, en su lugar', b.seDeshace === 3 && b.vuelveElOriginal);
    ok('y rehacer vuelve a partirlo', b.seRehace === 4);
  }
  {
    const g = r.gesto;
    ok('una pasada de goma con varios toques es una sola operación',
      g.pedazos === 3 && g.historial === 2 && g.cortes === 1, JSON.stringify(g));
    ok('deshacerla devuelve el trazo entero de una', g.seDeshaceDeUna === 1 && g.entero);
    ok('y rehacerla vuelve a los tres pedazos', g.seRehaceDeUna === 3);
  }

  console.log('\n5. Historial');
  ok('dos trazos', r.historial.tras2 === 2);
  ok('deshacer saca uno', r.historial.trasDeshacer === 1);
  ok('rehacer lo devuelve', r.historial.trasRehacer === 2);
  ok('una acción nueva corta la rama de rehacer', r.historial.ramaCortada === 0 && r.historial.final === 2,
    JSON.stringify(r.historial));

  console.log('\n6. El shim de compatibilidad de pdf.js');
  ok('Math.sumPrecise existe', r.compat.existe === 'function');
  ok('y suma sin perder los dígitos chicos', r.compat.precision === 2,
    `dio ${r.compat.precision} (la suma naive da ${r.compat.naive})`);
  ok('una suma normal sigue dando lo normal', r.compat.simple === 6);
  ok('la lista vacía da -0, como pide el estándar', r.compat.vacio);
  ok('con Infinity devuelve Infinity, no NaN', r.compat.conInfinito === Infinity);
  ok('con NaN devuelve NaN', r.compat.conNaN);

  console.log('\n7. Identidad del documento');
  ok('el mismo documento da el mismo id', r.id.estable);
  ok('otro tamaño da otro id', r.id.distintoPorTamano);
  ok('y es un nombre de archivo seguro', r.id.seguro, r.id.formato);

  console.log('\n8. El editor: la tinta sigue a su hoja');
  {
    const s = e.estira;
    ok('el canvas no lleva tamaño en línea: lo pone el CSS del pliego', s.sinTamanoEnLinea);
    ok('al cambiar el tamaño del pliego, la tinta lo sigue en el cuadro siguiente',
      s.dx <= 0.5 && s.dy <= 0.5, `diferencia ${s.dx} × ${s.dy} px`);
    ok('lo que se dibuja antes del render nuevo cae donde se ve, no corrido',
      s.error !== null && s.error < 1.5, `a ${s.error} pt (${JSON.stringify(s.primerPunto)} contra ${JSON.stringify(s.esperado.map((v) => +v.toFixed(1)))})`);
    ok('actualizar(viewport) rehace el bitmap y el puntero sigue cayendo en su lugar',
      s.actualizar && Math.abs(s.actualizar.bitmap - 2) < 0.05 && s.actualizar.error < 1.5, JSON.stringify(s.actualizar));
    const t = e.tope;
    ok('el bitmap de la tinta no pasa de 2^25 px a zoom extremo',
      t.area <= t.tope && t.area > t.tope * 0.97 && t.viewport > t.tope, `${t.area} px de un viewport de ${t.viewport}`);
    ok('y con el bitmap achicado el trazo se dibuja donde va', t.rojoEnElCentro && t.exportado === t.tope);
  }

  console.log('\n9. El editor: el puntero');
  {
    const d = e.destruir;
    ok('destruir con la punta apoyada guarda el trazo a medias, no lo tira',
      d.trasDestruir === 1 && d.puntos >= 4, JSON.stringify(d));
    ok('y un editor destruido ya no dibuja', d.alFinal === 1 && d.vivo === false, JSON.stringify(d));
    const g = e.goma;
    ok('la goma del lápiz, con la pluma elegida, hace un hueco del ancho del borrador',
      g.porDefecto.pedazos === 2 && Math.abs(g.porDefecto.hueco - 17.8) < 1.5, JSON.stringify(g.porDefecto));
    ok('y con la opción goma(), del ancho que diga', g.conOpcion.pedazos === 2 && Math.abs(g.conOpcion.hueco - 31.8) < 1.5,
      JSON.stringify(g.conOpcion));
    const b = e.botones;
    ok('el clic derecho, la rueda y el botón lateral no dibujan', b.trazosSinPan === 0 && b.trazosConPan === 0, JSON.stringify(b));
    ok('con onPan, la rueda y el lateral del lápiz desplazan (el derecho del mouse no)',
      /^empezar mover terminar empezar mover terminar$/.test(b.fases), b.fases);
    const r = e.remate;
    ok('el trazo llega hasta donde se levantó el lápiz', r.falta !== null && r.falta < 0.6,
      `le faltan ${r.falta} pt`);
    const p = e.palma;
    ok('con un lápiz ya visto, la palma apoyada no bloquea al lápiz ni mancha',
      p.delLapiz && !p.enLaPalma, JSON.stringify(p));
  }

  console.log('\n10. El editor: la goma, cuadro por cuadro');
  {
    const f = e.rafaga;
    ok('seis puntos de goma en un cuadro no redibujan nada en el acto', f.enLaRafaga.redibujos === 0, JSON.stringify(f));
    ok('y redibujan una sola vez en el cuadro', f.trasElCuadro.redibujos === 1, JSON.stringify(f.trasElCuadro));
    ok('la capa avisa una sola vez, al levantar la goma',
      f.enLaRafaga.avisos === 0 && f.trasElCuadro.avisos === 0 && f.alSoltar.avisos === 1, JSON.stringify(f));
    ok('y la goma borró de verdad', f.quedan > 6, `${f.quedan} pedazos`);
  }

  console.log('\n11. La capa: disco, historial y cuenta');
  {
    const gu = e.guardado;
    ok('un trazo agregado mientras se guarda deja la capa sucia', gu.suciaTras === true, JSON.stringify(gu));
    ok('y el guardado siguiente lo escribe', gu.primero === 1 && gu.segundo === 2 && gu.suciaAlFinal === false, JSON.stringify(gu));
    const fa = e.fallo;
    ok('si el disco falla, aparece un aviso', fa.primerFallo === 1, JSON.stringify(fa));
    ok('uno solo mientras siga fallando', fa.segundoFallo === 1, JSON.stringify(fa));
    ok('y después de escribir bien, un fallo nuevo vuelve a avisar', fa.suciaTrasEscribir === false && fa.vuelveAFallar === 2,
      JSON.stringify(fa));
    const de = e.deshacer;
    ok('deshacer() y rehacer() devuelven la operación, con su página', de.pagina === 3 && de.rehacer === 3 && de.nada === false,
      JSON.stringify(de));
    const c = e.cuenta;
    ok('borrarle el medio a un trazo no hace subir la cuenta', c.pedazos === 3 && c.cuenta === 2 && c.lista === 1,
      JSON.stringify(c));
    ok('y lo que se avisa al imprimir cuenta igual', c.contarTinta === 2 && c.soloLa1 === 1, JSON.stringify(c));
    const x = e.extgstate;
    ok('el PDF aplanado lleva un ExtGState solo para lo transparente', x.nuevos === 1, JSON.stringify(x));
    const i = e.icono;
    ok('el resaltador tiene su propio ícono, no el marcador del esquema', i.herramienta === 'resaltador' && i.existe && i.distinto,
      JSON.stringify(i));
  }

  if (e.explotaron) console.log('  (casos que explotaron adentro: ' + JSON.stringify(e.explotaron) + ')');
  console.log('\n12. Tres capas, y ninguna reservada de más (lector-23, tinta-10)');
  try {
    const r = e.reserva;
    ok('el editor arma sus tres canvas', r.canvases === 3, JSON.stringify(r));
    ok('sin trazos no reserva ningún bitmap', r.vacio.resaltador === 0 && r.vacio.tinta === 0 && r.vacio.viva === 0, JSON.stringify(r.vacio));
    ok('con una pluma reserva solo lo confirmado', r.conPluma.tinta > 0 && r.conPluma.resaltador === 0 && r.conPluma.viva === 0, JSON.stringify(r.conPluma));
    ok('con un resaltador, también su capa', r.conResaltador.resaltador > 0, JSON.stringify(r.conResaltador));
    ok('la punta en el aire reserva el canvas vivo, y al irse lo suelta', r.punta.viva > 0 && r.seFue.viva === 0, JSON.stringify(r));
    const v = e.vivo;
    ok('mientras se dibuja, lo confirmado no se toca ni una vez', v.durante.toques === 0, JSON.stringify(v));
    ok('el trazo en curso se ve, en el canvas vivo', v.durante.vivos >= 4 && v.durante.rojoVivo > 50 && v.durante.rojoFijo === 0, JSON.stringify(v.durante));
    ok('al soltar pasa a lo confirmado y lo vivo queda limpio', v.trasSoltar.rojoFijo > 50 && v.trasSoltar.vivaConAlgo === 0 && v.trazos === 2, JSON.stringify(v));
  } catch (err) { ok('el caso explotó', false, String(err?.message || err).slice(0, 200)); }

  console.log('\n13. El anillo de la punta (tinta-21)');
  try {
    const a = e.anillo;
    ok('el borrador muestra un anillo del tamaño de la goma', a.anillo.n > 20 && a.anillo.herramienta === 'borrador'
      && a.anillo.ancho >= a.esperado - 2 && a.anillo.ancho <= a.esperado + 8, JSON.stringify(a));
    ok('las demás herramientas, un punto', a.punto.n > 0 && a.punto.herramienta === 'pluma' && a.punto.ancho < a.anillo.ancho, JSON.stringify(a.punto));
    ok('y al irse la punta se borra', a.fuera === 0, JSON.stringify(a));
  } catch (err) { ok('el caso explotó', false, String(err?.message || err).slice(0, 200)); }

  console.log('\n14. Lo que no hace el lápiz se funde (tinta-13)');
  try {
    const f = e.fundido;
    const baja = (s) => s.filter((x) => x !== null);
    const sal = baja(f.sal.serie);
    ok('deshacer: la base ya no tiene el trazo y el calco sí', f.sal.baseRoja === 0 && f.sal.calcoRojo > f.entero * 0.9, JSON.stringify({ ...f.sal, serie: undefined, entero: f.entero }));
    ok('y el calco se esfuma de a poco, sin saltos, hasta irse', sal.some((x) => x > 0.1 && x < 0.9) && sal.every((x, i) => i === 0 || x <= sal[i - 1] + 0.01)
      && f.sal.serie.at(-1) === null && sal.every((x, i) => i === 0 || sal[i - 1] - x < 0.5), JSON.stringify(f.sal.serie));
    const ent = baja(f.ent.serie);
    ok('rehacer: el que llega entra fundiéndose y la base lo suma al final', f.ent.baseRoja === 0 && ent.some((x) => x > 0.1 && x < 0.9)
      && f.ent.baseAlFinal > f.entero * 0.9 && f.ent.calcosQuedan === 0, JSON.stringify({ ...f.ent, entero: f.entero }));
    const g = f.goma;
    ok('deshacer la goma funde solo el tramo comido, con los pedazos quietos debajo',
      g.baseConPedazos === g.conHueco && g.tramo > 0 && g.tramo < f.entero * 0.5 && Math.abs(g.alFinal - f.entero) < f.entero * 0.03, JSON.stringify({ ...g, entero: f.entero }));
  } catch (err) { ok('el caso explotó', false, String(err?.message || err).slice(0, 200)); }

  console.log('\n15. El resaltador con multiply (tinta-07) y el PDF con contraseña');
  try {
    const m = e.multiply;
    const luz = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
    const amarillo = ([r, g, b]) => r > 230 && g > 200 && b < 215;
    ok('en el PDF, la letra negra sigue negra debajo del amarillo', luz(m.pdf.sobreNegro) < 30, JSON.stringify(m.pdf));
    ok('y sobre el blanco, el amarillo de siempre', amarillo(m.pdf.sobreBlanco), JSON.stringify(m.pdf.sobreBlanco));
    ok('con /BM /Multiply en el ExtGState', m.pdf.modos.includes('/Multiply'), JSON.stringify(m.pdf.modos));
    ok('al exportar a imagen, lo mismo', !!m.exportar && luz(m.exportar.sobreNegro) < 30 && amarillo(m.exportar.sobreBlanco), JSON.stringify(m.exportar));
  } catch (err) { ok('el caso explotó', false, String(err?.message || err).slice(0, 200)); }
  try {
    const k = e.conClave;
    /* El código es el del motor de imposición (CLAVE, paquete 4A), así la vista que lo ataja ataja los dos. */
    ok('un PDF con contraseña no se aplana: avisa (por la marca del documento)', k.porLaMarca?.code === 'quire-clave' && /tiene contraseña/.test(k.porLaMarca.texto), JSON.stringify(k));
    ok('ni aunque la capa no lo diga: lo delata el /Encrypt', k.porLosBytes?.code === 'quire-clave', JSON.stringify(k));
    /* Uno que se abrió sin pedir contraseña (la de propietario sola, típica del
       material de cátedra) no dice «tiene contraseña»: nadie tipeó una. */
    ok('y sin contraseña de apertura, el aviso no dice que la tiene', /protegido/.test(k.porLosBytes?.texto || '') && !/contraseña/.test(k.porLosBytes?.texto || ''), JSON.stringify(k));
    ok('los colores tienen nombre, no un hexadecimal (tinta-24, ux-19)',
      JSON.stringify(e.colores) === JSON.stringify(['Negro', 'Rojo', 'Azul', 'Verde', 'Violeta', 'Amarillo']), JSON.stringify(e.colores));
  } catch (err) { ok('el caso explotó', false, String(err?.message || err).slice(0, 200)); }

  /* El aviso de tinta-28 también va a la consola, una vez por racha de
     fallos: los dos de la prueba son esperados, y cualquier otro cuenta. */
  const esperados = errores.filter((x) => x.includes('[tinta] no se pudo guardar'));
  ok('el fallo del disco queda en la consola, una vez por racha', esperados.length === 2, `${esperados.length}`);
  errores.splice(0, errores.length, ...errores.filter((x) => !x.includes('[tinta] no se pudo guardar')));

  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores) console.log('  ! ' + e);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  win.destroy();
  app.exit(fail || errores.length ? 1 : 0);
}).catch((e) => bail('excepción', e));
