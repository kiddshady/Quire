/* ═══════════════════════════════════════════════════════════════════════════
   El lector, de punta a punta: lo que arregló el paquete 2A de la auditoría
   de octubre de 2026.

   Monta Quire de verdad con un PDF armado acá al lado (cuarenta hojas A4 con
   renglones de texto, para tener capa de texto y algo que buscar) y mide: el
   teclado (con eventos de ENTRADA, sendInputEvent, y no KeyboardEvent
   sintéticos: un keydown despachado a mano no le mueve el foco a nadie), el
   scroll antes y después de cada gesto, y el movimiento cuadro por cuadro con
   un muestreador que corre EN la página (sin la latencia del IPC).

   Cada bloque dice qué hallazgo cuida. La suite se corrió al revés contra la
   0.10.0 (lector.js, documento.js, buscador.js y lector.css de antes, con
   estos mismos tests): fallaron 54 casos. Los que pasaron igual son de
   contexto («el caso existe», «hay una marca para medir») o cuidan lo que ya
   andaba: Ctrl+Z con la tinta prendida, la hoja que llena su pliego (lo
   arregló 1A), el orden de los marcadores (la versión en serie ya lo
   respetaba). El del giro de un escaneo se corrió al revés aparte,
   deshaciendo solo su arreglo, porque el corte que cuida lo trajo lector-35:
   la 0.10.0 no lo tenía.

   Lo que agregó la revisión del paquete se corrió al revés deshaciendo cada
   arreglo por separado: el teclado después de un clic de verdad (con
   :focus-visible fallaban 6), el final del documento con AvPág y Fin (2),
   las últimas hojas a 25 % (3), el aviso de deshacer (2), girar y salir (2)
   y la marca del PDF con contraseña (1).

   Lo que pasa por un relevo se lee con lo vivo (`:scope > :not(.ox-swap-out)`)
   y las filas se cuentan sin las que salen (`:not([data-state=closing])`).
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vigilarConsola } = require('./consola.cjs');
const { auditarAnillos } = require('./anillos.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('lector');

let pass = 0; let fail = 0;
const fallas = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); return; }
  fail++; fallas.push(n); console.log(`  FALLA ${n} ${x}`);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Cada caso va en su bloque: si explota (corrido al revés, contra el código
   viejo, un nodo que no existía), cuenta como falla y sigue el siguiente.
   Con SOLO (una expresión regular sobre el nombre del bloque) corren solo los
   que coinciden: es para correr un caso al revés sin esperar la suite entera.
   Ojo que algunos bloques dejan el estado que usa el siguiente. */
const SOLO = process.env.SOLO ? new RegExp(process.env.SOLO) : null;
async function bloque(nombre, fn) {
  if (SOLO && !SOLO.test(nombre)) return;
  try { await fn(); } catch (err) { ok(`${nombre}: el caso explotó`, false, String(err?.message || err).slice(0, 160)); }
}

const morir = (por, err) => {
  console.log(`\n!!! ${por}: ${err?.stack || err}`);
  console.log(`\n═══ ${pass} ok · ${fail + 1} fallas ═══`);
  app.exit(1);
};
process.on('unhandledRejection', (e) => morir('promesa sin atrapar', e));
const reloj = setTimeout(() => morir('se colgó', new Error('pasaron 240 s')), 240_000);

/* Un PDF chico con contraseña de apertura «quire» (RC4, hecho con pypdf). Va
   acá adentro porque pdf-lib no cifra, y para probar el cartel alcanza con
   una hoja en blanco. */
const CON_CLAVE = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDM3YzhmZTlmOGI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAxCi9SIDIKL0xlbmd0aCA0MAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDxjNzI4ODNjN2M5OWQzYzcwODU3NjE3NDBhNTBiYmE4YjdlOGJjYjg5NGViZTUzNGY5YzlhOTUxMDhmY2JkNWIyPgovVSA8M2FhODUyYWRiZWNhY2ZiOWJkNDdlZWFhMDliYmRjMTU2NDg4MDk5Nzc3YzUwM2Y0YWIzNGMxZTQ4ZDJhNjY4MT4KPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjYxIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzUzOTYzMzIzMDYyNjI2MTY1NjMzODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjQ3NQolJUVPRgo=';

/* ── Los cobayos ──────────────────────────────────────────────────────────────
   El grande: cuarenta A4 con veinte renglones cada una, y la palabra
   «palabra» tres veces por hoja (para las marcas de la búsqueda). El chico:
   tres hojas, para tener una segunda pestaña. */
async function armarCobayos() {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-lector-'));

  const grande = await PDFDocument.create();
  const fuente = await grande.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 40; p++) {
    const hoja = grande.addPage([595, 842]);
    for (let r = 0; r < 20; r++) {
      const texto = r % 7 === 3 ? `Renglon ${r + 1} con palabra de la hoja ${p}` : `Renglon ${r + 1} de la hoja ${p}, texto de relleno`;
      hoja.drawText(texto, { x: 60, y: 780 - r * 36, size: 14, font: fuente, color: rgb(0, 0, 0) });
    }
  }
  /* Tres marcadores (capítulos en la 1, la 15 y la 30), armados a mano: pdf-lib
     no tiene API para el esquema, pero sí para escribir los diccionarios. */
  const { PDFName, PDFHexString } = require('pdf-lib');
  const ctx = grande.context;
  const paginas = grande.getPages();
  const capitulos = [['Capítulo uno', 1], ['Capítulo dos', 15], ['Capítulo tres', 30]];
  const raiz = ctx.nextRef();
  const refs = capitulos.map(() => ctx.nextRef());
  capitulos.forEach(([titulo, pagina], i) => {
    const item = ctx.obj({ Title: PDFHexString.fromText(titulo), Parent: raiz, Dest: [paginas[pagina - 1].ref, 'XYZ', null, null, null] });
    if (i > 0) item.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) item.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], item);
  });
  ctx.assign(raiz, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  grande.catalog.set(PDFName.of('Outlines'), raiz);

  const rutaGrande = path.join(dir, 'cobayo-lector.pdf');
  fs.writeFileSync(rutaGrande, await grande.save());

  const chico = await PDFDocument.create();
  const f2 = await chico.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p++) chico.addPage([595, 842]).drawText(`Hoja ${p} del chico`, { x: 60, y: 760, size: 18, font: f2 });
  const rutaChico = path.join(dir, 'cobayo-chico.pdf');
  fs.writeFileSync(rutaChico, await chico.save());

  /* El escaneo: doce hojas APAISADAS sin una letra (un rectángulo gris, como
     una foto de la hoja). Sin capa de texto, nada más que el bitmap delata que
     la hoja se pintó; y apaisadas, al girarlas se hacen más altas y las de
     los costados quedan fuera de la precarga. */
  const escaneo = await PDFDocument.create();
  for (let p = 1; p <= 12; p++) {
    escaneo.addPage([842, 595]).drawRectangle({ x: 80, y: 80, width: 682, height: 435, color: rgb(0.8, 0.8, 0.8) });
  }
  const rutaEscaneo = path.join(dir, 'cobayo-escaneo.pdf');
  fs.writeFileSync(rutaEscaneo, await escaneo.save());

  /* El largo: trescientas hojas con un renglón cada una, para medir lo que
     depende del largo (abrir, la memoria recorriéndolo). */
  const largo = await PDFDocument.create();
  const f3 = await largo.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 300; p++) largo.addPage([595, 842]).drawText(`Hoja ${p} del largo`, { x: 60, y: 760, size: 18, font: f3 });
  const rutaLargo = path.join(dir, 'cobayo-largo.pdf');
  fs.writeFileSync(rutaLargo, await largo.save());

  return { dir, rutaGrande, rutaChico, rutaEscaneo, rutaLargo };
}

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const { dir, rutaGrande, rutaChico, rutaEscaneo, rutaLargo } = await armarCobayos();

  /* Fuera de pantalla pero VISIBLE: Chromium congela las animaciones de una
     ventana con show:false, y acá se miden cosas que se mueven. Alta, para
     que a 25 % entren varias hojas en el tercio de arriba del visor
     (lector-32). */
  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 1100,
    backgroundColor: '#0a0b0d',
    webPreferences: {
      preload: path.join(RAIZ, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errores = [];
  vigilarConsola(win, errores);

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const tecla = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  /* Un clic DE VERDAD en el centro de un elemento: mueve el foco como el
     mouse. Un .click() por JS no lo mueve, y lo que pasa con el teclado
     después de tocar un botón (el uso real) no se veía. */
  const clic = async (sel) => {
    const c = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`, true);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await esperar(80);
  };

  // Ayudas en la página: se reusan en todos los bloques.
  await js(`(() => {
    window.T = {
      async mod(n) { return import('./js/' + n + '.js'); },
      cuadro: () => new Promise((r) => requestAnimationFrame(() => r())),
      /* Muestrea fn() en cada cuadro durante ms. */
      async cuadros(fn, ms) {
        const out = []; const t0 = performance.now();
        while (performance.now() - t0 < ms) { await window.T.cuadro(); out.push(fn(Math.round(performance.now() - t0))); }
        return out;
      },
      visor: () => document.getElementById('qr-visor'),
      pliego: (n) => document.querySelector('.qr-pliego[data-pagina="' + n + '"]'),
      /* Qué punto del papel hay bajo un punto del visor: página y fracción. */
      bajo(x, y) {
        const v = window.T.visor(); const vr = v.getBoundingClientRect(); let hit = null;
        for (const el of v.querySelectorAll('.qr-pliego')) {
          const r = el.getBoundingClientRect(); const top = r.top - vr.top;
          if (hit && y < top) break;
          hit = { pagina: +el.dataset.pagina, fx: (x - (r.left - vr.left)) / r.width, fy: (y - top) / r.height, w: r.width, h: r.height };
        }
        return hit;
      },
      /* Lo vivo de un elemento que pasa por un relevo. */
      vivo: (el) => [...(el?.childNodes || [])].filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out'))).map((n) => n.textContent).join('').trim(),
      async irA(n) { (await window.T.mod('views/lector')).irA(n, { suave: false }); },
      /* Cuántos reescalados hubo y a qué escala están las hojas. Sin
         diagnostico() (el código de antes, corrido al revés) la escala se
         saca del ancho de la primera hoja y los reescalados no se saben. */
      async diag() {
        const lector = await window.T.mod('views/lector');
        if (lector.diagnostico) return lector.diagnostico();
        const { S } = await window.T.mod('estado');
        const p = window.T.pliego(1);
        return { reescalados: NaN, escalaHecha: p ? p.getBoundingClientRect().width / S.geometrias[0].anchoPt : NaN };
      },
    };
    return true;
  })()`);

  await js(`(async () => {
    const est = await T.mod('estado');
    for (const p of [...est.S.pestanas]) await est.cerrarPestana(p.id);
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(rutaGrande)}));
    const router = (await T.mod('router')).default;
    router.go('lector');
  })()`);
  await esperar(1800);

  ok('el cobayo abrió en el lector', await js(`document.querySelectorAll('.qr-pliego').length === 40`));

  /* ── 1 · Bugs ────────────────────────────────────────────────────────────── */
  console.log('\n1. Bugs');

  await bloque('lector-02', async () => {
    /* lector-02: con el panel plegado, repintar dejaba el hueco de 236 px. */
    await js(`document.getElementById('qr-toggle-panel').click()`);
    await esperar(500);
    await js(`(async () => (await T.mod('router')).default.refresh())()`);
    await esperar(700);
    const plegado = await js(`(() => {
      const v = T.visor(); const c = v.parentElement;
      return { v: v.getBoundingClientRect().left, c: c.getBoundingClientRect().left,
        plegado: document.getElementById('qr-panel').classList.contains('is-collapsed') };
    })()`);
    ok('con el panel plegado, después de repintar el visor arranca en el borde (lector-02)',
      plegado.plegado && Math.abs(plegado.v - plegado.c) < 1, JSON.stringify(plegado));
    await js(`document.getElementById('qr-toggle-panel').click()`);
    await esperar(700);
  });

  await bloque('lector-01', async () => {
    /* lector-01, tinta-06, ux-04: Ctrl+Z en un campo es del campo, y sin la
       tinta prendida no deshace tinta. Con la tinta prendida sí, y si el trazo
       es de una hoja que no se ve, avisa. */
    await js(`(async () => {
      const { S } = await T.mod('estado');
      S.tinta.agregar(30, { color: '#1a1a1a', ancho: 2, opacidad: 1, puntos: [[100, 700, .5], [300, 650, .5]] });
    })()`);
    const cuenta = () => js(`(async () => (await T.mod('estado')).S.tinta.cuenta)()`);
    await js(`document.querySelector('.qr-panel__tab[data-panel="buscar"]').click()`);
    await esperar(450);
    await js(`document.getElementById('qr-buscar-campo').focus()`);
    tecla('Z', ['control']);
    await esperar(250);
    ok('Ctrl+Z en el buscador no borra el trazo (lector-01)', await cuenta() === 1);
    await js(`T.visor().focus()`);
    tecla('Z', ['control']);
    await esperar(250);
    ok('ni en el documento con la tinta apagada (ux-04)', await cuenta() === 1);
    tecla('E', ['control']);
    await esperar(500);
    await js(`T.visor().focus()`);
    tecla('Z', ['control']);
    await esperar(400);
    const tras = await js(`(() => [...document.querySelectorAll('.ox-toast')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim()))()`);
    ok('con la tinta prendida, Ctrl+Z deshace', await cuenta() === 0);
    ok('y avisa en qué página, que no se ve', tras.some((t) => /Se deshizo un trazo/.test(t) && /página 30/.test(t)), JSON.stringify(tras));
    tecla('Y', ['control']);
    await esperar(300);
    ok('Ctrl+Y lo vuelve a poner', await cuenta() === 1);
    /* El aviso dice qué se deshizo según la operación, y rehacer lleva su
       ícono: antes era «Se deshizo un trazo» con el de deshacer para todo. */
    const avisos = () => js(`(() => [...document.querySelectorAll('.ox-toast:not([data-state=closing])')].map((t) => ({
      texto: t.textContent.replace(/\\s+/g, ' ').trim(), redo: (t.querySelector('svg')?.innerHTML || '').includes('M12.8 7.4') })))()`);
    const trasRehacer = await avisos();
    ok('rehacer avisa con su texto y su ícono', trasRehacer.some((t) => /Se rehízo un trazo/.test(t.texto) && t.redo), JSON.stringify(trasRehacer));
    await js(`(async () => {
      const { S } = await T.mod('estado');
      S.tinta.agregar(30, { color: '#1a1a1a', ancho: 2, opacidad: 1, puntos: [[100, 600, .5], [300, 550, .5]] });
      S.tinta.limpiarPagina(30);
    })()`);
    tecla('Z', ['control']);
    await esperar(400);
    const trasLimpiar = await avisos();
    ok('deshacer «borrar la tinta de la página» dice cuántos trazos volvieron', trasLimpiar.some((t) => /Volvieron 2 trazos/.test(t.texto) && /página 30/.test(t.texto)), JSON.stringify(trasLimpiar));
    tecla('E', ['control']);
    await esperar(500);
  });

  await bloque('lector-17', async () => {
    /* lector-17, ux-32: el campo de página navega solo si se escribió algo.
       Necesita el foco de la ventana: sin él, focus() y blur no disparan sus
       eventos y el test pasaría sin probar nada. Otra prueba corriendo al mismo
       tiempo se lo puede robar: se pide de nuevo antes de cada caso. */
    const enfocar = async () => { win.focus(); win.webContents.focus(); await esperar(60); return js('document.hasFocus()'); };
    ok('la ventana tiene el foco (si no, el campo no recibe sus eventos)', await enfocar());
    await js(`T.irA(5)`);
    await esperar(300);
    await js(`T.visor().scrollTop += 300`);
    await esperar(300);
    const st0 = await js(`T.visor().scrollTop`);
    await enfocar();
    await js(`document.getElementById('qr-pagina-input').focus()`);
    await esperar(80);
    /* blur() y no el foco a otro lado: enfocar el visor le corta un scroll
       suave en curso, y con el código de antes el salto no se veía. */
    await js(`document.getElementById('qr-pagina-input').blur()`);
    await esperar(700);
    ok('entrar y salir del campo de página sin escribir no mueve la vista (lector-17)',
      Math.abs(await js(`T.visor().scrollTop`) - st0) <= 1, `${st0} → ${await js(`T.visor().scrollTop`)}`);

    await enfocar();
    await js(`document.getElementById('qr-pagina-input').focus()`);
    await js(`T.visor().scrollTop = T.pliego(9).offsetTop - T.visor().offsetTop + 100`);
    await esperar(300);
    const st1 = await js(`T.visor().scrollTop`);
    await js(`document.getElementById('qr-pagina-input').blur()`);
    await esperar(700);
    ok('scrollear con el foco en el campo y salir no te devuelve a la página vieja',
      Math.abs(await js(`T.visor().scrollTop`) - st1) <= 1);

    await enfocar();
    await js(`(() => { const c = document.getElementById('qr-pagina-input'); c.focus(); c.value = 'abc'; })()`);
    await js(`T.visor().focus()`);
    await esperar(500);
    const tras2 = await js(`(async () => ({ campo: document.getElementById('qr-pagina-input').value, pagina: (await T.mod('estado')).S.pagina, st: T.visor().scrollTop }))()`);
    ok('lo que no es un número restaura el campo y no lleva a la 1 (ux-32)',
      tras2.campo === String(tras2.pagina) && tras2.pagina > 1 && Math.abs(tras2.st - st1) <= 1, JSON.stringify(tras2));

    await js(`(() => { const c = document.getElementById('qr-pagina-input'); c.focus(); c.select(); c.value = '12'; })()`);
    tecla('Return');
    await esperar(900);
    ok('Enter en el campo navega', await js(`(async () => (await T.mod('estado')).S.pagina)()`) === 12);

    await js(`(() => { const c = document.getElementById('qr-pagina-input'); c.focus(); c.value = '30'; })()`);
    tecla('Escape');
    await esperar(500);
    const esc = await js(`(async () => ({ campo: document.getElementById('qr-pagina-input').value, pagina: (await T.mod('estado')).S.pagina, foco: document.activeElement?.id }))()`);
    ok('Escape restaura y vuelve al documento', esc.campo === '12' && esc.pagina === 12 && esc.foco === 'qr-visor', JSON.stringify(esc));
  });

  await bloque('lector-31', async () => {
    /* lector-31: con un cartel abierto, el teclado no mueve el documento de atrás. */
    await js(`(async () => { const { Modal } = await T.mod('overlays'); window.__cartel = Modal.confirm({ title: 'Prueba', sub: 'Un cartel' }); })()`);
    await esperar(300);
    const st2 = await js(`T.visor().scrollTop`);
    tecla('PageDown');
    tecla('End');
    await esperar(500);
    ok('con un cartel abierto, AvPág y Fin no mueven el documento (lector-31)', Math.abs(await js(`T.visor().scrollTop`) - st2) <= 1);
    tecla('Escape');
    await esperar(500);
  });

  await bloque('teclado tras un clic', async () => {
    /* lector-31 bien hecho: Espacio se le cede a un botón SOLO si se llegó a
       él con Tab. Con :focus-visible no alcanzaba: en Chromium un botón
       enfocado con el mouse lo cumple apenas se aprieta una tecla, así que
       clic en el lapicito + Espacio le daba el clic y apagaba la tinta, «+»
       acercaba otra vez, y AvPág, RePág, Inicio y Fin no hacían nada después
       de tocar cualquier botón de la barra. */
    const leer = () => js(`(async () => {
      const { S } = await T.mod('estado');
      return { on: document.getElementById('qr-tinta-toggle').classList.contains('is-on'),
        nav: T.visor().classList.contains('is-navegando'), st: T.visor().scrollTop, pagina: S.pagina,
        zoom: document.getElementById('qr-zoom-valor').textContent.trim(), foco: document.activeElement?.id || '' };
    })()`);
    /* Con el foco de la ventana: sin él, Chromium no aplica la regla de
       :focus-visible que hacía fallar el código de antes, y el caso pasaría
       sin probar nada. Otra prueba en paralelo se lo puede robar. */
    win.focus(); win.webContents.focus();
    await esperar(80);
    ok('la ventana tiene el foco (si no, el caso no existe)', await js('document.hasFocus()'));
    await js(`T.irA(5)`);
    await esperar(400);

    await clic('#qr-tinta-toggle');
    await esperar(600);
    const a0 = await leer();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    await esperar(250);
    const a1 = await leer();
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await esperar(350);
    const a2 = await leer();
    ok('clic en el lapicito: prende la tinta y le deja el foco', a0.on && a0.foco === 'qr-tinta-toggle', JSON.stringify(a0));
    ok('y Espacio saca el puck en vez de apretarlo', a1.nav && a1.on, JSON.stringify(a1));
    ok('al soltarlo la tinta sigue prendida', a2.on && !a2.nav, JSON.stringify(a2));
    // Apagada para lo que sigue, con un clic de verdad o (si Espacio ya la apagó) sin tocarla.
    if ((await leer()).on) { await clic('#qr-tinta-toggle'); await esperar(600); }

    await clic('#qr-zoom-mas');
    await esperar(800);
    const b0 = await leer();
    tecla('Space');
    await esperar(800);
    const b1 = await leer();
    ok('Espacio después de un clic en «+» no lo vuelve a apretar: baja la vista',
      b0.foco === 'qr-zoom-mas' && b1.zoom === b0.zoom && b1.st > b0.st + 40, `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
    /* AvPág recién tocado un botón, sin Espacio en el medio (el keyup de
       un Espacio que apretó el botón dejaría un reescalado en vuelo). */
    await clic('#qr-zoom-menos');
    await esperar(900);
    const b15 = await leer();
    tecla('PageDown');
    await esperar(800);
    const b2 = await leer();
    ok('AvPág después de tocar un botón de la barra baja igual', b15.foco === 'qr-zoom-menos' && b2.st > b15.st + 40, `${JSON.stringify(b15)} → ${JSON.stringify(b2)}`);
    await clic('#qr-zoom-menos');
    await esperar(900);
    tecla('End');
    await esperar(1000);
    const b3 = await leer();
    ok('y Fin lleva a la última', b3.pagina === 40, JSON.stringify(b3));
    tecla('Home');
    await esperar(1000);
    ok('e Inicio a la primera', (await leer()).pagina === 1);

    /* Con Tab, Espacio sigue siendo del botón: ida y vuelta para llegar
       al «−» con el teclado (el «+» ya puede estar en el tope). */
    await clic('#qr-zoom-menos');
    await esperar(800);
    tecla('Tab');
    await esperar(80);
    tecla('Tab', ['shift']);
    await esperar(80);
    const c0 = await leer();
    tecla('Space');
    await esperar(800);
    const c1 = await leer();
    ok('a un botón al que se llegó con Tab, Espacio lo aprieta', c0.foco === 'qr-zoom-menos' && c1.zoom !== c0.zoom, `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
    await js(`document.getElementById('qr-fit-ancho').click()`);
    await js(`T.visor().focus()`);
    await esperar(900);
  });

  await bloque('lector-20', async () => {
    /* lector-20: un 'documento' sin cambio de documento no repinta el lector. */
    const repinto = await js(`(async () => {
      const est = await T.mod('estado');
      const visor = T.visor();
      est.emitir('documento');
      await new Promise((r) => setTimeout(r, 60));
      return { calco: !!document.querySelector('.ox-main--saliente'), mismo: T.visor() === visor };
    })()`);
    ok('un aviso de documento sin cambio no repinta el lector (lector-20)', !repinto.calco && repinto.mismo, JSON.stringify(repinto));
  });

  await bloque('lector-32', async () => {
    /* lector-32: a zoom chico, «siguiente» no saltea hojas. */
    const salto = await js(`(async () => {
      const { S } = await T.mod('estado');
      const lector = await T.mod('views/lector');
      S.modoZoom = 'fijo'; S.zoom = 0.25; lector.reescalar();
      lector.irA(2, { suave: false });
      await new Promise((r) => setTimeout(r, 300));
      const alto = T.visor().clientHeight; const hoja = T.pliego(2).offsetHeight;
      const vistas = [];
      for (let i = 0; i < 3; i++) {
        document.getElementById('qr-next').click();
        await new Promise((r) => setTimeout(r, 900));
        vistas.push(S.pagina);
      }
      return { vistas, alto, hoja, aplica: alto * 0.33 >= hoja + 40 };
    })()`);
    ok('a 25 % el visor es lo bastante alto para que el caso exista', salto.aplica, JSON.stringify(salto));
    ok('a 25 %, «siguiente» va de a una hoja (lector-32)', JSON.stringify(salto.vistas) === '[3,4,5]', JSON.stringify(salto.vistas));

    /* Las últimas hojas no pueden subir al tope: el scroll se queda en el
       máximo. irA() comparaba contra el top sin acotar y al llegar
       paginaEnPantalla() devolvía una ANTERIOR: irA(40) mostraba 40 y a los
       2 s volvía a 38, y tres «siguiente» daban [38,38,38]. */
    const ultimas = await js(`(async () => {
      const { S } = await T.mod('estado');
      const lector = await T.mod('views/lector');
      const v = T.visor();
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      const tope40 = T.pliego(40).offsetTop - v.offsetTop - 24;
      const caso = tope40 > v.scrollHeight - v.clientHeight + 1;
      lector.irA(35, { suave: false });
      await espera(300);
      const vistas = [];
      for (let i = 0; i < 5; i++) {
        document.getElementById('qr-next').click();
        await espera(900);
        vistas.push(S.pagina);
      }
      await espera(2000);
      const quieta = S.pagina;
      lector.irA(30, { suave: false });
      await espera(300);
      document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click();
      await espera(700);
      document.querySelector('#qr-panel-cuerpo .qr-mini[data-pagina="40"]').click();
      await espera(2200);
      const mini = S.pagina;
      lector.irA(35, { suave: false });
      await espera(300);
      return { caso, vistas, quieta, mini };
    })()`);
    ok('a 25 % las últimas hojas no llegan al tope (el caso existe)', ultimas.caso, JSON.stringify(ultimas));
    ok('«siguiente» llega hasta la última', JSON.stringify(ultimas.vistas) === '[36,37,38,39,40]', JSON.stringify(ultimas.vistas));
    ok('y 2 s después sigue en la última', ultimas.quieta === 40, JSON.stringify(ultimas));
    ok('la miniatura de la última lleva a la última y ahí se queda', ultimas.mini === 40, JSON.stringify(ultimas));
    await js(`T.visor().focus()`);
    for (let i = 0; i < 5; i++) { tecla('PageDown'); await esperar(800); }
    await esperar(1500);
    const avpagFin = await js(`(async () => (await T.mod('estado')).S.pagina)()`);
    ok('AvPág también llega a la última a 25 %', avpagFin === 40, avpagFin);
    await js(`document.getElementById('qr-fit-ancho').click()`);
    await esperar(900);
  });

  /* ── 2 · Rendimiento ─────────────────────────────────────────────────────── */
  console.log('\n2. Rendimiento');

  await bloque('lector-06', async () => {
    /* lector-06: la hoja que se va de pantalla suelta lo que pdf.js guardó de ella. */
    const limpias = await js(`(async () => {
      const { S } = await T.mod('estado');
      window.__limpias = [];
      for (let n = 1; n <= S.doc.paginas; n++) {
        const p = await S.doc._pagina(n);
        if (p.__espiada) continue;
        const orig = p.cleanup.bind(p);
        p.cleanup = (...a) => { window.__limpias.push(n); return orig(...a); };
        p.__espiada = true;
      }
      await T.irA(1);
      await new Promise((r) => setTimeout(r, 1200));
      await T.irA(30);
      await new Promise((r) => setTimeout(r, 1200));
      return window.__limpias;
    })()`);
    ok('la hoja que se fue de pantalla le pidió a pdf.js que suelte su memoria (lector-06)', limpias.includes(1), JSON.stringify(limpias.slice(0, 12)));

    // La memoria del renderer recorriendo el documento entero: se anota, no se afirma.
    const pid = win.webContents.getOSProcessId();
    const memoria = () => (app.getAppMetrics().find((m) => m.pid === pid)?.memory.workingSetSize || 0);
    const mem0 = memoria();
    for (let n = 1; n <= 40; n += 2) { await js(`T.irA(${n})`); await esperar(140); }
    await esperar(800);
    console.log(`       memoria del renderer: ${Math.round(mem0 / 1024)} MB → ${Math.round(memoria() / 1024)} MB recorriendo 40 hojas`);
  });

  await bloque('lector-22', async () => {
    /* lector-22: el bitmap de una hoja tiene tope de píxeles. */
    const px = await js(`(async () => {
      const { S } = await T.mod('estado');
      const canvas = document.createElement('canvas');
      await S.doc.render(3, { canvas, escala: 9, dpr: 1 }).promesa;
      const area = canvas.width * canvas.height; canvas.width = 0;
      return area;
    })()`);
    ok('a 900 % el bitmap de una hoja no pasa de 2^25 px (lector-22)', px > 0 && px <= 2 ** 25, `(${px} px)`);
  });

  await bloque('liberar tras girar', async () => {
    /* liberar() sale enseguida si no hay nada que soltar (lector-35), y
       «nada» se miraba por is-pintada y por la capa de texto. girar() les saca
       is-pintada a todas para apagarlas, y reescalar() cancela las capas de
       texto en vuelo: una hoja recién pintada cuya capa todavía no había
       llegado (o un escaneo, si pdf.js no le deja nada) quedaba sin nada que
       la delate, y si el giro la sacaba de la precarga se quedaba con su
       bitmap. Se fabrica ese estado: las capas vacías antes de girar. */
    await js(`(async () => {
      const est = await T.mod('estado');
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(rutaEscaneo)}));
    })()`);
    await esperar(1400);
    const giro = await js(`(async () => {
      const lector = await T.mod('views/lector');
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      lector.irA(6, { suave: false });
      await espera(1200);
      const conBitmap = (sel) => [...document.querySelectorAll(sel)].filter((p) => p.querySelector('.qr-hoja').width > 0).map((p) => +p.dataset.pagina);
      const antes = conBitmap('.qr-pliego');
      document.querySelectorAll('.qr-texto').forEach((t) => t.replaceChildren());
      document.getElementById('qr-rotar-der').click();
      await espera(1600);
      const pintadas = conBitmap('.qr-pliego.is-pintada');
      const sueltas = conBitmap('.qr-pliego:not(.is-pintada)');
      document.getElementById('qr-rotar-izq').click();
      await espera(1200);
      return { antes, pintadas, sueltas };
    })()`);
    ok('el caso existe: el giro deja fuera de la precarga hojas que estaban pintadas',
      giro.antes.some((n) => !giro.pintadas.includes(n)), JSON.stringify(giro));
    ok('después del giro, ninguna hoja fuera de vista se queda con su bitmap',
      giro.sueltas.length === 0, JSON.stringify(giro));
    await js(`(async () => { const est = await T.mod('estado'); await est.cerrarPestana(est.S.pestana.id); })()`);
    await esperar(1200);
  });

  await bloque('abrir y memoria', async () => {
    /* lector-24: las geometrías en lotes contra en serie, sobre el mismo PDF
       de 300 hojas (cada una en un Documento nuevo, sin caché; el primero se
       tira, es el que paga el arranque del worker). Y la memoria del renderer
       recorriéndolo entero. Se anotan, no se afirman: con otras pruebas
       corriendo a la vez los tiempos no son de fiar, y la versión vieja de
       geometrias() no existe para correrla al revés. */
    const t = await js(`(async () => {
      const { abrirDocumento } = await T.mod('pdf/documento');
      const leido = await window.onyx.docs.leer(${JSON.stringify(rutaLargo)});
      const medir = async (fn) => {
        const doc = await abrirDocumento(leido.bytes.slice());
        const t0 = performance.now(); await fn(doc); const ms = performance.now() - t0;
        doc.destruir();
        return Math.round(ms);
      };
      await medir((doc) => doc.geometrias());
      const enSerie = await medir(async (doc) => { for (let n = 1; n <= doc.paginas; n++) await doc.geometria(n); });
      const enLotes = await medir((doc) => doc.geometrias());
      return { enSerie, enLotes };
    })()`);
    console.log(`       geometrías de 300 hojas: en serie ${t.enSerie} ms, en lotes de 32 ${t.enLotes} ms`);

    await js(`(async () => {
      const est = await T.mod('estado');
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(rutaLargo)}));
    })()`);
    await esperar(1500);
    const pid = win.webContents.getOSProcessId();
    const memoria = () => Math.round((app.getAppMetrics().find((m) => m.pid === pid)?.memory.workingSetSize || 0) / 1024);
    const mem0 = memoria();
    for (let n = 1; n <= 300; n += 6) { await js(`T.irA(${n})`); await esperar(110); }
    await esperar(800);
    const mem1 = memoria();
    for (let n = 300; n >= 1; n -= 6) { await js(`T.irA(${n})`); await esperar(110); }
    await esperar(800);
    console.log(`       memoria del renderer recorriendo 300 hojas: ${mem0} MB → ${mem1} MB → ${memoria()} MB (ida y vuelta)`);
    ok('recorrer 300 hojas no deja más de 40 hojas con bitmap', await js(`[...document.querySelectorAll('.qr-pliego canvas')].filter((c) => c.width > 0).length <= 40`));
    await js(`(async () => { const est = await T.mod('estado'); await est.cerrarPestana(est.S.pestana.id); })()`);
    await esperar(1200);
  });

  await bloque('lector-11', async () => {
    /* lector-11, css-26: volver al lector trae las miniaturas de la caché, ya puestas. */
    await js(`document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click()`);
    await esperar(1500);
    const minis = await js(`(async () => {
      const router = (await T.mod('router')).default;
      router.go('imprimir');
      await new Promise((r) => setTimeout(r, 600));
      router.go('lector');
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      const imgs = [...cuerpo.querySelectorAll(':scope > .qr-mini img.qr-mini__lienzo')];
      return {
        imgs: imgs.length,
        canvas: cuerpo.querySelectorAll(':scope > .qr-mini canvas').length,
        entrando: imgs.filter((i) => i.classList.contains('is-entrando')).length,
        corriendo: imgs.flatMap((i) => i.getAnimations()).filter((a) => a.playState === 'running').length,
      };
    })()`);
    ok('la segunda visita trae las miniaturas como imágenes de la caché, en el mismo pintado (lector-11)', minis.imgs > 0 && minis.canvas === 0, JSON.stringify(minis));
    ok('y no vuelven a entrar', minis.entrando === 0 && minis.corriendo === 0, JSON.stringify(minis));
    await esperar(800);
  });

  await bloque('lector-16', async () => {
    /* lector-16: redimensionar la ventana reescala una sola vez, al final. */
    const r0 = (await js(`T.diag()`)).reescalados;
    const [w0, h0] = win.getSize();
    let estiradoEnElMedio = false;
    for (let i = 1; i <= 8; i++) {
      win.setSize(w0 - i * 20, h0);
      await esperar(30);
      if (i === 5) estiradoEnElMedio = /scale/.test(await js(`document.querySelector('.qr-pista').style.transform`));
    }
    await esperar(700);
    const tras3 = await js(`T.diag()`);
    ok('mientras se arrastra el borde, la pista solo se estira (lector-16)', estiradoEnElMedio);
    ok('y se reescala UNA vez, al terminar', tras3.reescalados - r0 === 1, `(${tras3.reescalados - r0})`);
    ok('sin quedar estirada', await js(`document.querySelector('.qr-pista').style.transform`) === '');
    win.setSize(w0, h0);
    await esperar(800);
  });

  await bloque('css-15', async () => {
    /* css-15: la franja de pestañas que se pliega reescala una vez en «Página entera». */
    await js(`(async () => {
      const est = await T.mod('estado');
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(rutaChico)}), { activar: false });
    })()`);
    await esperar(900);
    await js(`document.getElementById('qr-fit-pagina').click()`);
    await esperar(900);
    const r1 = (await js(`T.diag()`)).reescalados;
    await js(`(async () => {
      const est = await T.mod('estado');
      const otra = est.S.pestanas.find((p) => p !== est.S.pestana);
      await est.cerrarPestana(otra.id);
    })()`);
    await esperar(1200);
    ok('plegar la franja de pestañas en «Página entera» reescala una sola vez (css-15)',
      (await js(`T.diag()`)).reescalados - r1 === 1, `(${(await js(`T.diag()`)).reescalados - r1})`);
    await js(`document.getElementById('qr-fit-ancho').click()`);
    await esperar(900);
  });

  await bloque('girar y salir', async () => {
    /* Salir de la vista dentro de los 200 ms de un clic en girar (Ctrl+P,
       Ctrl+Tab) tiraba el giro: onLeave cortaba el reloj sin aplicarlo. */
    const giro = await js(`(async () => {
      const { S } = await T.mod('estado');
      const router = (await T.mod('router')).default;
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      const antes = S.rotacion;
      document.getElementById('qr-rotar-der').click();
      await espera(40);
      router.go('imprimir'); await espera(500);
      const fuera = S.rotacion;
      router.go('lector'); await espera(700);
      const ancho = T.pliego(1).getBoundingClientRect(); const apaisada = ancho.width > ancho.height;
      // Se devuelve a como estaba, para los bloques que siguen.
      document.getElementById('qr-rotar-izq').click();
      await espera(900);
      return { antes, fuera, apaisada, despues: S.rotacion };
    })()`);
    ok('girar y salir enseguida aplica el giro igual', giro.fuera === (giro.antes + 90) % 360 && giro.apaisada, JSON.stringify(giro));
    ok('(y vuelve a como estaba)', giro.despues === giro.antes, JSON.stringify(giro));
  });

  /* ── 3 · Escala ──────────────────────────────────────────────────────────── */
  console.log('\n3. Escala');

  await bloque('lector-03', async () => {
    /* lector-03, lector-19: Ctrl+rueda deja quieto el punto bajo el puntero. */
    await js(`T.irA(6)`);
    await esperar(300);
    await js(`T.visor().scrollTop += 420`);
    await esperar(500);
    const vr = await js(`(() => { const r = T.visor().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const px0 = { x: Math.round(vr.w * 0.4), y: Math.round(vr.h * 0.6) };
    const bajoAntes = await js(`T.bajo(${px0.x}, ${px0.y})`);
    const escalaAntes = (await js(`T.diag()`)).escalaHecha;
    for (let i = 0; i < 3; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(vr.x + px0.x), y: Math.round(vr.y + px0.y), deltaX: 0, deltaY: 40, wheelTicksY: 1, canScroll: true, modifiers: ['control'] });
      await esperar(25);
    }
    await esperar(700);
    const bajoDespues = await js(`T.bajo(${px0.x}, ${px0.y})`);
    const escalaDespues = (await js(`T.diag()`)).escalaHecha;
    const corrido = bajoDespues && bajoDespues.pagina === bajoAntes.pagina
      ? Math.hypot((bajoDespues.fx - bajoAntes.fx) * bajoDespues.w, (bajoDespues.fy - bajoAntes.fy) * bajoDespues.h) : Infinity;
    ok('Ctrl+rueda cambia la escala', Math.abs(escalaDespues - escalaAntes) > 0.01, `${escalaAntes} → ${escalaDespues}`);
    ok('y el punto bajo el puntero queda a ≤ 2 px (lector-03)', corrido <= 2, `(${corrido.toFixed(2)} px)`);
    ok('tres eventos chicos son un zoom continuo, no tres pasos de la lista (lector-19)',
      Math.abs(escalaDespues / escalaAntes - 1) < 0.5, `${escalaAntes.toFixed(3)} → ${escalaDespues.toFixed(3)}`);

    /* Los botones anclan en el centro. */
    const centro = { x: Math.round(vr.w / 2), y: Math.round(vr.h / 2) };
    const cAntes = await js(`T.bajo(${centro.x}, ${centro.y})`);
    await js(`document.getElementById('qr-zoom-mas').click()`);
    await esperar(500);
    const cDespues = await js(`T.bajo(${centro.x}, ${centro.y})`);
    const corridoC = cDespues && cDespues.pagina === cAntes.pagina
      ? Math.hypot((cDespues.fx - cAntes.fx) * cDespues.w, (cDespues.fy - cAntes.fy) * cDespues.h) : Infinity;
    ok('«+» deja quieto el punto del centro y no salta al tope de la página', corridoC <= 2, `(${corridoC.toFixed(2)} px)`);
  });

  await bloque('lector-04', async () => {
    /* lector-04: en el primer cuadro después de «+», la hoja llena su pliego y
       las marcas de la búsqueda se estiran con ella. */
    await js(`document.querySelector('.qr-panel__tab[data-panel="buscar"]').click()`);
    await esperar(400);
    await js(`(() => { const c = document.getElementById('qr-buscar-campo'); c.value = 'palabra'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await esperar(1500);
    const primerCuadro = await js(`(async () => {
      const v = T.visor().getBoundingClientRect();
      const marca = [...document.querySelectorAll('.qr-marca')].find((m) => { const r = m.getBoundingClientRect(); return r.top > v.top && r.bottom < v.bottom; });
      if (!marca) return null;
      const pliego = marca.closest('.qr-pliego');
      const proporcion = () => { const p = pliego.getBoundingClientRect(); const m = marca.getBoundingClientRect(); return { x: (m.left - p.left) / p.width, y: (m.top - p.top) / p.height, w: m.width / p.width }; };
      const a = proporcion();
      document.getElementById('qr-zoom-mas').click();
      await T.cuadro();
      const b = proporcion();
      const hoja = pliego.querySelector('.qr-hoja').getBoundingClientRect(); const p = pliego.getBoundingClientRect();
      return { a, b, hojaLlena: Math.abs(hoja.width - p.width) < 1 && Math.abs(hoja.height - p.height) < 1, marcaViva: marca.isConnected };
    })()`);
    ok('hay una marca a la vista para medir', !!primerCuadro);
    if (primerCuadro) {
      ok('en el primer cuadro después de «+», la hoja llena el pliego', primerCuadro.hojaLlena);
      ok('y la marca sigue en el mismo lugar de la hoja (lector-04)',
        primerCuadro.marcaViva && Math.abs(primerCuadro.a.x - primerCuadro.b.x) < 0.004 && Math.abs(primerCuadro.a.y - primerCuadro.b.y) < 0.004 && Math.abs(primerCuadro.a.w - primerCuadro.b.w) < 0.004,
        JSON.stringify(primerCuadro));
    }
    await esperar(800);
    await js(`(() => { const c = document.getElementById('qr-buscar-campo'); c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await esperar(600);
    await js(`document.getElementById('qr-fit-ancho').click()`);
    await esperar(800);
  });

  await bloque('lector-07', async () => {
    /* lector-07: al girar, ningún cuadro muestra un bitmap deformado. */
    const giro = await js(`(async () => {
      document.getElementById('qr-rotar-der').click();
      const malos = [];
      const serie = await T.cuadros(() => {
        const v = T.visor().getBoundingClientRect();
        for (const p of document.querySelectorAll('.qr-pliego')) {
          const r = p.getBoundingClientRect();
          if (r.bottom < v.top || r.top > v.bottom) continue;
          const h = p.querySelector('.qr-hoja');
          const op = +getComputedStyle(h).opacity;
          if (op < 0.02 || !h.width || !h.height) continue;
          const dif = Math.abs(h.width / h.height - r.width / r.height);
          if (dif > 0.03) malos.push({ n: p.dataset.pagina, op: +op.toFixed(2), bitmap: +(h.width / h.height).toFixed(3), caja: +(r.width / r.height).toFixed(3) });
        }
        return 1;
      }, 1400);
      const p = T.pliego(6).getBoundingClientRect();
      return { malos: malos.slice(0, 4), cuadros: serie.length, apaisado: p.width > p.height, pintada: T.pliego(6).classList.contains('is-pintada') || !!document.querySelector('.qr-pliego.is-pintada') };
    })()`);
    ok('al girar, ningún cuadro muestra la hoja deformada (lector-07)', giro.malos.length === 0, JSON.stringify(giro));
    ok('y la hoja queda girada y pintada', giro.apaisado && giro.pintada, JSON.stringify(giro));
  });

  await bloque('lector-30', async () => {
    /* lector-30: las miniaturas acompañan el giro. */
    await js(`document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click()`);
    await esperar(1200);
    const miniGirada = await js(`(() => {
      const m = document.querySelector('#qr-panel-cuerpo > .qr-mini.is-lista');
      const img = m?.querySelector('img'); const hoja = m?.querySelector('.qr-mini__hoja');
      if (!img) return null;
      const r = hoja.getBoundingClientRect(); const ri = img.getBoundingClientRect();
      return { apaisada: r.width > r.height, gira: /rotate\\(90deg\\)/.test(img.style.transform), llena: Math.abs(ri.width - r.width) < 1.5 && Math.abs(ri.height - r.height) < 1.5 };
    })()`);
    ok('las miniaturas se giran con el documento (lector-30)', miniGirada?.apaisada && miniGirada?.gira && miniGirada?.llena, JSON.stringify(miniGirada));
    await js(`document.getElementById('qr-rotar-izq').click()`);
    await esperar(1400);
  });

  await bloque('lector-15', async () => {
    /* lector-15, css-28: plegar el panel no hace saltar las hojas. */
    await js(`T.irA(8)`);
    await esperar(600);
    const pliegue = await js(`(async () => {
      const ref = () => { const v = T.visor().getBoundingClientRect(); for (const p of document.querySelectorAll('.qr-pliego')) { const r = p.getBoundingClientRect(); if (r.bottom > v.top) return r; } };
      const antes = ref(); const r0 = (await T.diag()).reescalados;
      document.getElementById('qr-toggle-panel').click();
      const serie = await T.cuadros(() => { const r = ref(); return { x: +r.left.toFixed(1), w: +r.width.toFixed(1) }; }, 600);
      await new Promise((r) => setTimeout(r, 300));
      return { antes: { x: +antes.left.toFixed(1), w: +antes.width.toFixed(1) }, serie, reescalados: (await T.diag()).reescalados - r0 };
    })()`);
    const s0 = pliegue.serie[0];
    const xs = pliegue.serie.map((p) => p.x);
    const monotona = xs.every((x, i) => i === 0 || Math.sign(x - xs[i - 1]) !== -Math.sign(xs.at(-1) - xs[0]) || Math.abs(x - xs[i - 1]) < 0.6);
    ok('plegar el panel: el primer cuadro muestra la hoja donde estaba (lector-15)',
      Math.abs(s0.x - pliegue.antes.x) <= 2 && Math.abs(s0.w - pliegue.antes.w) <= 2, `${JSON.stringify(pliegue.antes)} → ${JSON.stringify(s0)}`);
    ok('y viaja sin volver para atrás hasta su lugar nuevo', monotona && xs.length > 5, JSON.stringify(xs.slice(0, 20)));
    ok('con un solo reescalado, al terminar', pliegue.reescalados === 1, `(${pliegue.reescalados})`);
    await js(`document.getElementById('qr-toggle-panel').click()`);
    await esperar(900);
  });

  /* ── 4 · El panel ────────────────────────────────────────────────────────── */
  console.log('\n4. El panel');

  await bloque('lector-14', async () => {
    /* lector-14: cambiar de pestaña del panel es un fundido, no un corte. */
    await js(`document.getElementById('qr-panel-cuerpo').scrollTop = 600`);
    await esperar(300);
    const fundido = await js(`(async () => {
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      const scroll = cuerpo.scrollTop;
      document.querySelector('.qr-panel__tab[data-panel="esquema"]').click();
      const calco = cuerpo.firstElementChild;
      const fondo = calco ? getComputedStyle(calco).backgroundColor : '';
      const alfa = (() => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = fondo || 'transparent'; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; })();
      // El scroll del calco se lee YA: cuando termina de irse, sale del DOM.
      const scrollCalco = calco?.scrollTop;
      const serie = await T.cuadros(() => calco?.isConnected ? +getComputedStyle(calco).opacity : null, 260);
      return { esCalco: !!calco?.classList.contains('ox-swap-out--fundido'), alfa, scroll, scrollCalco, serie: serie.map((o) => o == null ? null : +o.toFixed(2)) };
    })()`);
    ok('cambiar a Marcadores pasa la lista a un calco opaco que se esfuma (lector-14)', fundido.esCalco && fundido.alfa === 255, JSON.stringify(fundido));
    ok('que se va desde donde estaba (con su scroll)', Math.abs((fundido.scrollCalco ?? -1) - fundido.scroll) <= 1, JSON.stringify(fundido));
    ok('y baja de a poco', fundido.serie.some((o) => o > 0.1 && o < 0.9), JSON.stringify(fundido.serie));
    await esperar(400);
    /* De vuelta a Miniaturas parado en la 30: lo nuevo se acomoda con la
       miniatura actual centrada (scroll del cuerpo), y el calco tiene que
       seguir tapando el panel, no irse de vista con ese scroll. */
    await js(`T.irA(30)`);
    await esperar(400);
    const vuelta = await js(`(() => {
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click();
      const calco = cuerpo.firstElementChild;
      const c = cuerpo.getBoundingClientRect(); const r = calco?.getBoundingClientRect();
      return { esCalco: !!calco?.classList.contains('ox-swap-out--fundido'), scroll: cuerpo.scrollTop,
        tapa: !!r && Math.abs(r.top - c.top) < 1 && r.height >= c.height - 1 };
    })()`);
    ok('volviendo a Miniaturas en la 30, el calco sigue tapando el panel mientras se va', vuelta.esCalco && vuelta.scroll > 0 && vuelta.tapa, JSON.stringify(vuelta));
    await esperar(800);
  });

  await bloque('lector-10', async () => {
    /* lector-10: volver al lector parado en la 25 muestra la miniatura de la 25. */
    await js(`T.irA(25)`);
    await esperar(900);
    const miniActual = await js(`(async () => {
      const router = (await T.mod('router')).default;
      router.go('imprimir');
      await new Promise((r) => setTimeout(r, 500));
      router.go('lector');
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      const m = cuerpo.querySelector(':scope > .qr-mini.is-actual');
      const r = m?.getBoundingClientRect(); const c = cuerpo.getBoundingClientRect();
      return { n: m?.dataset.pagina, visible: !!r && r.top >= c.top - 1 && r.bottom <= c.bottom + 1 };
    })()`);
    ok('al volver, la miniatura de la página actual está a la vista (lector-10)', miniActual.n === '25' && miniActual.visible, JSON.stringify(miniActual));
    await esperar(600);
  });

  await bloque('lector-38', async () => {
    /* lector-38, lector-24: Marcadores dice en qué capítulo estás, y los
       destinos resueltos en paralelo salen en el orden del árbol. */
    await js(`T.irA(20)`);
    await esperar(500);
    await js(`document.querySelector('.qr-panel__tab[data-panel="esquema"]').click()`);
    await esperar(600);
    const esquema = await js(`(() => {
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      const items = [...cuerpo.querySelectorAll(':scope > .qr-esquema > .qr-esquema__item')];
      const actual = items.find((i) => i.classList.contains('is-actual'));
      return { items: items.map((i) => [i.querySelector('.qr-esquema__titulo').textContent, +i.dataset.pagina]), actual: actual?.querySelector('.qr-esquema__titulo').textContent };
    })()`);
    ok('los marcadores salen en orden, con su página (lector-24)', JSON.stringify(esquema.items) === JSON.stringify([['Capítulo uno', 1], ['Capítulo dos', 15], ['Capítulo tres', 30]]), JSON.stringify(esquema.items));
    ok('parado en la 20, el marcador actual es el capítulo dos (lector-38)', esquema.actual === 'Capítulo dos', JSON.stringify(esquema));
    await js(`T.irA(31)`);
    await esperar(500);
    ok('y al pasar a la 31, el tres', await js(`document.querySelector('#qr-panel-cuerpo .qr-esquema__item.is-actual .qr-esquema__titulo')?.textContent`) === 'Capítulo tres');
    await js(`document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click()`);
    await esperar(700);
  });

  await bloque('lector-24 perezoso', async () => {
    /* lector-24, la otra mitad: los marcadores se leen recién al abrir la
       pestaña. Hoy estado.js todavía los espera al abrir (va en «afuera»):
       acá se deja el estado como lo va a dejar él, sin leer, y se mira que el
       lector los pida y avise mientras llegan. Y el documento los resuelve UNA
       vez: ir y volver a la pestaña mientras se leen no sale de nuevo al
       worker. */
    const perezoso = await js(`(async () => {
      const { S } = await T.mod('estado');
      const una = S.doc.esquema() === S.doc.esquema();
      S.esquema = null;
      document.querySelector('.qr-panel__tab[data-panel="esquema"]').click();
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      const leyendo = T.vivo(cuerpo).includes('Leyendo los marcadores');
      await new Promise((r) => setTimeout(r, 900));
      return { una, leyendo, items: cuerpo.querySelectorAll(':scope > .qr-esquema > .qr-esquema__item').length, arreglo: Array.isArray(S.esquema) };
    })()`);
    ok('el documento resuelve sus marcadores una sola vez', perezoso.una, JSON.stringify(perezoso));
    ok('sin marcadores leídos, la pestaña los pide, avisa mientras tanto y los muestra (lector-24)',
      perezoso.leyendo && perezoso.items === 3 && perezoso.arreglo, JSON.stringify(perezoso));
    await js(`document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click()`);
    await esperar(700);
  });

  await bloque('lector-29', async () => {
    /* lector-29: cambiar de pestaña con miniaturas pintándose no sigue con el
       documento nuevo (uno más corto llenaba la consola de TypeError). */
    const antes = errores.length;
    await js(`(async () => {
      const est = await T.mod('estado');
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(rutaChico)}), { activar: false });
      const { S } = est;
      if (S.doc._miniaturas) { for (const u of S.doc._miniaturas.values()) URL.revokeObjectURL(u); S.doc._miniaturas.clear(); }
      const cuerpo = document.getElementById('qr-panel-cuerpo');
      cuerpo.scrollTop = cuerpo.scrollHeight;
      await new Promise((r) => setTimeout(r, 30));
      const grande = S.pestana; const chico = S.pestanas.find((p) => p !== grande);
      est.activar(chico.id);
      await new Promise((r) => setTimeout(r, 1500));
      est.activar(grande.id);
      await new Promise((r) => setTimeout(r, 800));
      await est.cerrarPestana(chico.id);
    })()`);
    await esperar(800);
    const nuevos = errores.slice(antes);
    ok('cambiar de pestaña con miniaturas en vuelo no deja errores (lector-29)', nuevos.length === 0, JSON.stringify(nuevos.slice(0, 3)));
  });

  await bloque('lector-34', async () => {
    /* lector-34: un salto a un resultado que espera su capa de texto se suelta
       si el usuario se mueve con la rueda. */
    await js(`T.irA(1)`);
    await esperar(400);
    await js(`document.querySelector('.qr-panel__tab[data-panel="buscar"]').click()`);
    await esperar(400);
    await js(`(() => { const c = document.getElementById('qr-buscar-campo'); c.value = 'palabra'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await esperar(1600);
    const pendiente = await js(`(async () => {
      const fila = [...document.querySelectorAll('#qr-buscar-lista > .qr-hit')].find((f) => f.querySelector('.qr-hit__pag').textContent.trim() === '35');
      fila.click();
      const a = (await T.diag()).pendiente;
      T.visor().dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true }));
      const b = (await T.diag()).pendiente;
      return { a, b };
    })()`);
    ok('el salto quedó esperando la capa de texto de la 35', pendiente.a === 35, JSON.stringify(pendiente));
    ok('y la rueda lo suelta (lector-34)', pendiente.b === null, JSON.stringify(pendiente));
    await js(`(() => { const c = document.getElementById('qr-buscar-campo'); c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await esperar(500);
    await js(`document.querySelector('.qr-panel__tab[data-panel="miniaturas"]').click()`);
    await esperar(600);
  });

  /* ── 5 · Barra y statusbar ───────────────────────────────────────────────── */
  console.log('\n5. Barra y statusbar');

  await bloque('lector-13', async () => {
    /* lector-13, tinta-09: con la tinta prendida, la barra no vuelve a crecer al volver. */
    /* Al prenderla, la barra se despliega de alto; los colores de adentro
       nacen con su ancho (no crecen de 0 a la vez). */
    const prender = await js(`(async () => {
      document.getElementById('qr-tinta-toggle').click();
      const pliegue = document.getElementById('qr-colores-pliegue');
      const barra = document.getElementById('qr-tintabarra');
      return T.cuadros(() => [Math.round(pliegue.getBoundingClientRect().width), Math.round(barra.getBoundingClientRect().height)], 300);
    })()`);
    const anchos = prender.map((p) => p[0]); const altos = prender.map((p) => p[1]);
    ok('al prender la tinta, la barra se despliega de alto', altos.some((h) => h > 2 && h < altos.at(-1) - 2), JSON.stringify(altos));
    ok('y los colores tienen su ancho desde el primer cuadro', anchos.every((w) => w === anchos.at(-1) && w > 20), JSON.stringify(anchos));
    await esperar(400);
    const barra = await js(`(async () => {
      const router = (await T.mod('router')).default;
      router.go('imprimir');
      await new Promise((r) => setTimeout(r, 500));
      router.go('lector');
      const b = document.getElementById('qr-tintabarra');
      return T.cuadros(() => Math.round(b.getBoundingClientRect().height), 300);
    })()`);
    ok('volviendo de Imprimir, la barra de tinta tiene su alto desde el primer cuadro (lector-13)',
      barra.length > 3 && barra.every((h) => h === barra.at(-1) && h > 20), JSON.stringify(barra));
  });

  await bloque('lector-12', async () => {
    /* lector-12, tinta-08: la barra se arma una vez; elegir herramienta la pone al día. */
    const herramientas = await js(`(async () => {
      const barra = document.getElementById('qr-tintabarra');
      const pluma = barra.querySelector('[data-tinta-tool="pluma"]');
      const eco = document.getElementById('qr-tinta-ancho-eco').textContent;
      barra.querySelector('[data-tinta-tool="borrador"]').click();
      const pliegue = document.getElementById('qr-colores-pliegue');
      /* Cuánto aire hay entre el divisor de las herramientas y lo que sigue:
         abierto, el primer color; cerrado, el grosor. Tiene que ser un gap
         (12 px) en los dos casos: el pliegue no corre la fila. */
      const vr = barra.querySelector(':scope > .ox-vr').getBoundingClientRect().right;
      const aire = (el) => +(el.getBoundingClientRect().left - vr).toFixed(1);
      const abierto = aire(barra.querySelector('.qr-color'));
      /* Y lo de la derecha acompaña el cierre sin volver nunca para atrás: un
         margen que no se va con el relleno lo dejaba 4 px corrido hasta el
         final, y al pasar a display:none saltaba de vuelta. */
      const grosor = barra.querySelector('.qr-grosor');
      const serie = await T.cuadros(() => [Math.round(pliegue.getBoundingClientRect().width), +grosor.getBoundingClientRect().left.toFixed(1)], 320);
      const anchos = serie.map((p) => p[0]);
      const xs = serie.map((p) => p[1]);
      const atras = Math.max(0, ...xs.slice(1).map((x, i) => x - xs[i]));
      const cerrado = aire(grosor);
      const rotulo = T.vivo(document.getElementById('qr-tinta-rotulo'));
      barra.querySelector('[data-tinta-tool="pluma"]').click();
      await new Promise((r) => setTimeout(r, 400));
      return { mismoNodo: barra.querySelector('[data-tinta-tool="pluma"]') === pluma, eco, anchos, rotulo, abierto, cerrado, atras, xs,
        oculta: pliegue.hidden === false, onPluma: pluma.classList.contains('is-on') };
    })()`);
    ok('elegir herramienta no rehace la barra (lector-12)', herramientas.mismoNodo && herramientas.onPluma);
    const intermedios = herramientas.anchos.filter((w) => w > 2 && w < Math.max(...herramientas.anchos) - 2);
    ok('los colores se pliegan a lo ancho de a poco con el borrador', intermedios.length > 0 && herramientas.anchos.at(-1) === 0, JSON.stringify(herramientas.anchos));
    ok('el rótulo pasa a «Tamaño»', herramientas.rotulo === 'Tamaño', herramientas.rotulo);
    ok('el grosor se escribe con coma (tinta-25, ux-25)', herramientas.eco === '1,8 pt', herramientas.eco);
    ok('abierto o cerrado, el pliegue de los colores deja un gap justo antes de lo que sigue',
      Math.abs(herramientas.abierto - 12) <= 0.5 && Math.abs(herramientas.cerrado - 12) <= 0.5, JSON.stringify({ abierto: herramientas.abierto, cerrado: herramientas.cerrado }));
    ok('y el grosor acompaña el cierre sin volver para atrás', herramientas.atras <= 0.5, JSON.stringify(herramientas.xs));
    /* El pliegue recorta para poder cerrarse: el anillo del color elegido y
       el de foco tienen que caber adentro (el mismo audit del smoke). */
    win.focus(); win.webContents.focus();
    await esperar(150);
    const cortes = await js(auditarAnillos('#qr-tintabarra'));
    ok('ningún anillo de la barra de tinta se corta', cortes.length === 0, JSON.stringify(cortes));
  });

  await bloque('tinta-18 al volver a prender', async () => {
    /* La barra se arma una vez por montaje (lector-12). Apagada, el evento
       'tinta' no la toca: si la capa cambia mientras tanto, al volver a
       prenderla la cuenta y el deshacer tienen que decir lo de ahora, no lo
       de cuando se apagó. */
    const reprender = await js(`(async () => {
      const { S } = await T.mod('estado');
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      const toggle = document.getElementById('qr-tinta-toggle');
      const barra = document.getElementById('qr-tintabarra');
      toggle.click(); await espera(400);
      S.tinta.agregar(2, { color: '#1a1a1a', ancho: 2, opacidad: 1, puntos: [[100, 100, .5], [200, 150, .5]] });
      await espera(100);
      const n = S.tinta.cuenta;
      toggle.click(); await espera(500);
      const r = { n, misma: document.getElementById('qr-tintabarra') === barra, cuenta: T.vivo(document.getElementById('qr-tinta-cuenta')),
        deshacer: !document.getElementById('qr-tinta-deshacer').disabled };
      S.tinta.deshacer();
      await espera(300);
      return r;
    })()`);
    ok('al volver a prender la tinta, la cuenta dice lo de ahora (tinta-18)',
      reprender.misma && reprender.cuenta === `${reprender.n} ${reprender.n === 1 ? 'trazo' : 'trazos'}` && reprender.deshacer, JSON.stringify(reprender));
  });

  await bloque('lector-27', async () => {
    /* El primer llenado no destella; un cambio de zoom sí, en su lugar (lector-27). */
    const destellos = await js(`(async () => {
      const router = (await T.mod('router')).default;
      router.go('imprimir'); await new Promise((r) => setTimeout(r, 500));
      router.go('lector'); await new Promise((r) => setTimeout(r, 300));
      const alMontar = [...document.querySelectorAll('.qr-lector .ox-ticked, #stat-pagina .ox-ticked, #stat-pagina-value.ox-ticked, #stat-medida-value.ox-ticked')].map((e) => e.id || e.className);
      const z = document.getElementById('qr-zoom-valor');
      const antes = z.textContent;
      document.getElementById('qr-zoom-mas').click();
      return { alMontar, antes, despues: z.textContent, tick: z.classList.contains('ox-ticked'), calco: !!z.querySelector('.ox-swap-out') };
    })()`);
    ok('al montar, nada de la barra ni de la statusbar destella', destellos.alMontar.length === 0, JSON.stringify(destellos.alMontar));
    ok('un cambio de zoom se escribe en su lugar con destello (lector-27)', destellos.tick && !destellos.calco && destellos.despues !== destellos.antes, JSON.stringify(destellos));
    tecla('E', ['control']);
    await esperar(500);
    await js(`document.getElementById('qr-fit-ancho').click()`);
    await esperar(800);
  });

  /* ── 6 · El lugar ────────────────────────────────────────────────────────── */
  console.log('\n6. El lugar');

  await bloque('lector-21', async () => {
    /* lector-21: volver de Imprimir deja el mismo renglón, no el tope de la hoja. */
    await js(`T.irA(7)`);
    await esperar(300);
    await js(`T.visor().scrollTop += 555`);
    await esperar(500);
    const lugar = await js(`(async () => {
      const off = () => T.pliego(7).getBoundingClientRect().top - T.visor().getBoundingClientRect().top;
      const antes = off();
      const router = (await T.mod('router')).default;
      router.go('imprimir'); await new Promise((r) => setTimeout(r, 500));
      router.go('lector');
      return { antes, despues: off() };
    })()`);
    ok('volver de Imprimir deja la misma fracción de la hoja (lector-21)', Math.abs(lugar.antes - lugar.despues) <= 2, JSON.stringify(lugar));
    await esperar(600);
  });

  await bloque('lector-18', async () => {
    /* lector-18, ux-15: AvPág baja una pantalla dentro de la hoja; al final de la hoja, pasa. */
    await js(`T.irA(10)`);
    await esperar(400);
    /* Una pantalla menos 48 px de respiro, y nunca más allá del final de la
       hoja (que queda a 24 px del borde de abajo). */
    const avpag = await js(`(async () => {
      const v = T.visor(); const vr = v.getBoundingClientRect(); const p = T.pliego(10).getBoundingClientRect();
      return { st: v.scrollTop, alto: v.clientHeight, fondo: p.bottom - vr.top };
    })()`);
    const pasoEsperado = Math.min(avpag.alto - 48, avpag.fondo - avpag.alto + 24);
    tecla('PageDown');
    await esperar(700);
    const avpag2 = await js(`(async () => ({ st: T.visor().scrollTop, pagina: (await T.mod('estado')).S.pagina }))()`);
    ok('AvPág baja una pantalla sin pasar de hoja (lector-18)',
      pasoEsperado > 48 && Math.abs((avpag2.st - avpag.st) - pasoEsperado) <= 2 && avpag2.pagina === 10, `${JSON.stringify(avpag)} → ${JSON.stringify(avpag2)} (esperado ${pasoEsperado})`);
    tecla('PageDown');
    await esperar(700);
    tecla('PageDown');
    await esperar(900);
    ok('y cuando la hoja ya se terminó de ver, pasa a la siguiente', await js(`(async () => (await T.mod('estado')).S.pagina)()`) === 11);

    /* En la última, con su final a la vista, el toque de más no hace nada.
       Antes caía en irA() a la misma hoja y subía al tope (46136 → 45786). */
    await js(`T.irA(40)`);
    await esperar(400);
    const finVisto = () => js(`(async () => {
      const v = T.visor(); const p = T.pliego(40).getBoundingClientRect(); const vr = v.getBoundingClientRect();
      return { st: v.scrollTop, visto: p.bottom - vr.top <= v.clientHeight + 1, pagina: (await T.mod('estado')).S.pagina };
    })()`);
    let fin = await finVisto();
    for (let i = 0; i < 6 && !fin.visto; i++) { tecla('PageDown'); await esperar(700); fin = await finVisto(); }
    tecla('PageDown');
    await esperar(700);
    const fin2 = await finVisto();
    ok('en la última, con su final a la vista, AvPág no sube (lector-18)', fin.visto && fin.pagina === 40 && fin2.st >= fin.st - 1, `${JSON.stringify(fin)} → ${JSON.stringify(fin2)}`);
    tecla('Space');
    await esperar(700);
    ok('ni Espacio', (await finVisto()).st >= fin.st - 1);
    tecla('End');
    await esperar(700);
    const fin3 = await finVisto();
    ok('ni Fin', fin3.st >= fin.st - 1 && fin3.pagina === 40, `${JSON.stringify(fin)} → ${JSON.stringify(fin3)}`);
    // De vuelta en la 11, que es donde el bloque siguiente (ux-22) espera estar.
    await js(`T.irA(11)`);
    await esperar(500);
  });

  /* ── 7 · Lo demás ────────────────────────────────────────────────────────── */
  console.log('\n7. Lo demás');

  await bloque('ux-02/ux-17/ux-37', async () => {
    const barraDatos = await js(`(() => ({
      cerrar: document.querySelector('.qr-barra [data-action="cerrar"]')?.dataset.tipKey,
      teclas: Object.fromEntries(['qr-prev', 'qr-next', 'qr-zoom-valor', 'qr-zoom-menos'].map((id) => [id, document.getElementById(id)?.dataset.tipKey])),
      imprimir: document.querySelector('.qr-barra [data-goto="imprimir"]')?.dataset.tipKey,
      buscar: document.querySelector('.qr-panel__tab[data-panel="buscar"]')?.dataset.tipKey,
      pestanas: [...document.querySelectorAll('.qr-panel__tab')].map((t) => ({ texto: t.textContent.trim(), entra: t.scrollWidth <= t.clientWidth + 0.5 })),
    }))()`);
    ok('la barra tiene «Cerrar documento» con su atajo (ux-02)', barraDatos.cerrar === 'Ctrl W', JSON.stringify(barraDatos));
    ok('los atajos se dicen en los tooltips (ux-17)', barraDatos.teclas['qr-prev'] === 'RePág' && barraDatos.teclas['qr-next'] === 'AvPág'
      && barraDatos.teclas['qr-zoom-valor'] === 'Ctrl 0' && barraDatos.imprimir === 'Ctrl P' && barraDatos.buscar === 'Ctrl F', JSON.stringify(barraDatos));
    ok('el menos de Alejar es un guion ASCII (ux-08)', barraDatos.teclas['qr-zoom-menos'] === 'Ctrl -', barraDatos.teclas['qr-zoom-menos']);
    ok('la pestaña del panel se llama «Miniaturas» y las tres entran sin recortarse (ux-37)',
      barraDatos.pestanas[0].texto === 'Miniaturas' && barraDatos.pestanas.every((p) => p.entra), JSON.stringify(barraDatos.pestanas));
  });

  await bloque('ux-22', async () => {
    /* ux-22: una hoja que no se pudo dibujar lo dice y se puede reintentar. */
    const falla = await js(`(async () => {
      const { S } = await T.mod('estado');
      const lector = await T.mod('views/lector');
      const original = S.doc.render.bind(S.doc);
      S.doc.render = (n, o) => (n === 11 ? { promesa: Promise.reject(new Error('rota a propósito')), cancelar() {} } : original(n, o));
      lector.reescalar();
      await new Promise((r) => setTimeout(r, 700));
      const p = T.pliego(11);
      const aviso = p.querySelector('.qr-pliego__falla');
      const texto = aviso?.textContent.replace(/\\s+/g, ' ').trim();
      S.doc.render = original;
      aviso?.querySelector('[data-reintentar]')?.click();
      await new Promise((r) => setTimeout(r, 900));
      return { texto, pintada: p.classList.contains('is-pintada'), fallida: p.classList.contains('is-fallida'), queda: !!p.querySelector('.qr-pliego__falla') };
    })()`);
    ok('la hoja que falla dice que no se pudo dibujar (ux-22)', /No se pudo dibujar/.test(falla.texto || '') && /Reintentar/.test(falla.texto || ''), JSON.stringify(falla));
    ok('y «Reintentar» la pinta', falla.pintada && !falla.fallida && !falla.queda, JSON.stringify(falla));
  });

  await bloque('ux-11', async () => {
    /* ux-11: los errores de abrir llegan en castellano, y la contraseña se pide. */
    const roto = await js(`(async () => {
      const { abrirDocumento } = await T.mod('pdf/documento');
      try { await abrirDocumento(new TextEncoder().encode('%PDF-1.4 esto no es un pdf'), { nombre: 'roto.pdf' }); return 'abrió'; }
      catch (e) { return e.message; }
    })()`);
    ok('un PDF dañado da el error en castellano (ux-11)', /dañado/.test(roto), roto);

    await js(`(async () => {
      const est = await T.mod('estado');
      const bytes = Uint8Array.from(atob(${JSON.stringify(CON_CLAVE)}), (c) => c.charCodeAt(0));
      window.__abrirClave = est.abrir({ ruta: null, nombre: 'con-clave.pdf', bytes, tamano: bytes.length }).then(() => 'abrió', (e) => e.message);
    })()`);
    await esperar(700);
    const cartel1 = await js(`document.querySelector('.ox-modal__title')?.textContent || ''`);
    await js(`(() => { const i = document.querySelector('.qr-clave input'); i.value = 'otra'; })()`);
    await js(`[...document.querySelectorAll('.ox-modal .ox-btn')].find((b) => b.textContent === 'Abrir').click()`);
    await esperar(900);
    const cartel2 = await js(`document.querySelector('.ox-modal:not([data-state]) .ox-modal__title, .ox-modal__anim:not([data-state]) .ox-modal__title')?.textContent || ''`);
    await js(`(() => { const i = [...document.querySelectorAll('.qr-clave input')].at(-1); i.value = 'quire'; })()`);
    await js(`[...document.querySelectorAll('.ox-modal__anim:not([data-state]) .ox-btn')].find((b) => b.textContent === 'Abrir').click()`);
    const abrioClave = await js(`window.__abrirClave`);
    ok('un PDF con contraseña la pide con un cartel (ux-11)', /contraseña/.test(cartel1), cartel1);
    ok('si no es la que abre, lo dice', /incorrecta/.test(cartel2), cartel2);
    ok('y con la correcta abre', abrioClave === 'abrió', abrioClave);
    /* Sus bytes siguen cifrados y pdf-lib no los descifra: el documento lo
       dice, para que Imprimir y Exportar puedan avisar (ver «afuera»). */
    const marcas = await js(`(async () => {
      const { S } = await T.mod('estado');
      return S.pestanas.map((p) => ({ nombre: p.doc.nombre, conClave: p.doc.conClave }));
    })()`);
    ok('el documento abierto con contraseña queda marcado, y los demás no',
      marcas.find((m) => m.nombre === 'con-clave.pdf')?.conClave === true && marcas.filter((m) => m.nombre !== 'con-clave.pdf').every((m) => m.conClave === false), JSON.stringify(marcas));
    await esperar(600);
  });

  await bloque('ux-02 cerrar', async () => {
    /* ux-02: el botón de la barra cierra el documento que se mira (el que
       abrió el bloque de la contraseña). */
    const cierre = await js(`(async () => {
      const est = await T.mod('estado');
      const antes = est.S.pestanas.length; const nombre = est.S.doc?.nombre;
      document.querySelector('.qr-barra [data-action="cerrar"]').click();
      await new Promise((r) => setTimeout(r, 900));
      return { antes, despues: est.S.pestanas.length, nombre, queda: est.S.pestanas.some((p) => p.doc?.nombre === nombre) };
    })()`);
    ok('«Cerrar documento» de la barra cierra el que se mira (ux-02)', cierre.despues === cierre.antes - 1 && !cierre.queda, JSON.stringify(cierre));
  });

  await bloque('shell-05', async () => {
    /* shell-05: sin documento, mientras algo se abre, el lector dice «Abriendo…». */
    const abriendo = await js(`(async () => {
      const est = await T.mod('estado');
      for (const p of [...est.S.pestanas]) await est.cerrarPestana(p.id);
      await new Promise((r) => setTimeout(r, 500));
      est.S.cargando += 1; est.emitir('cargando');
      await new Promise((r) => setTimeout(r, 400));
      const texto = document.querySelector('#view .ox-empty__title')?.textContent;
      est.S.cargando -= 1; est.emitir('cargando');
      await new Promise((r) => setTimeout(r, 400));
      return { texto, despues: document.querySelector('#view .ox-empty__title')?.textContent };
    })()`);
    ok('sin documento y abriendo uno, el lector dice «Abriendo…» (shell-05)', abriendo.texto === 'Abriendo…', JSON.stringify(abriendo));
    ok('y si no llegó nada, vuelve al vacío', /No hay ningún PDF/.test(abriendo.despues || ''), JSON.stringify(abriendo));
  });

  /* ── Cierre ──────────────────────────────────────────────────────────────── */
  // El error de la hoja rota a propósito es esperado: no cuenta.
  // Y el aviso de pdf.js al intentar rearmar el PDF dañado del bloque 7, también.
  const reales = errores.filter((e) => !/rota a propósito|\[lector\] página 11|Indexing all PDF objects/.test(e));
  console.log(`\n----- errores de consola: ${reales.length} -----`);
  for (const e of reales.slice(0, 8)) console.log('   ', e);
  ok('sin errores en la consola', reales.length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
  clearTimeout(reloj);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  if (fail) for (const f of fallas) console.log(`  ! ${f}`);
  app.exit(fail ? 1 : 0);
}).catch((e) => morir('el arranque', e));
