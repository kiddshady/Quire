/* ═══════════════════════════════════════════════════════════════════════════
   El puck de navegación: zoom y desplazamiento sin soltar el lápiz.

   Monta Quire de verdad, abre un PDF, prende la tinta y aprieta la barra
   espaciadora con eventos de ENTRADA del sistema (sendInputEvent), no con
   KeyboardEvent sintéticos: un keydown despachado a mano no le cambia el foco
   a nadie ni dispara los repeat de Windows, que son justo lo que hay que
   sobrevivir. Lo mismo con el mouse: la captura del puntero rechaza un
   pointerId inventado.

   Lo que existe para cazar:

   · Que Espacio siga siendo "página siguiente" SIN tinta, y sea el puck CON
     tinta. Son dos significados de la misma tecla y el reparto es una
     condición en atajosLector: si alguien la reordena, una de las dos se va.

   · Que arrastrar el anillo mueva el scroll lo mismo que la mano, y que
     arrastrar el núcleo termine en un zoom real —S.zoom cambiado, la pista sin
     transform— con el mismo punto del papel bajo el disco. Ese anclaje es
     aritmética de rectángulos y se rompe sin que se note nada en el código.

   · Que soltar la barra desarme todo: el disco se va, el visor deja de
     navegar y la tinta recupera el puntero.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vigilarConsola } = require('./consola.cjs');

const RAIZ = path.join(__dirname, '..');
const PDF = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* Datos propios, y ANTES de requerir nada de src/. El porqué está en
   pestanas.cjs: abrir escribe la sesión, y la sesión real restaura pestañas. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-puck-'));
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });

const problemas = [];
let pass = 0;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(`${que}${detalle ? ` — ${detalle}` : ''}`); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

app.whenReady().then(correr).catch((err) => {
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  limpiar();
  app.exit(1);
});

async function correr() {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();

  const win = new BrowserWindow({
    show: false,
    x: -20000,
    y: -20000,
    width: 1400,
    height: 900,
    backgroundColor: '#0a0b0d',
    webPreferences: {
      preload: path.join(RAIZ, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  vigilarConsola(win, problemas);

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const tecla = (type, keyCode) => win.webContents.sendInputEvent({ type, keyCode });
  const raton = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });

  await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDF)}));
  })()`);
  await esperar(1200);

  /* Lo que se pregunta una y otra vez: el estado del visor y del disco. */
  const estado = () => js(`(async () => {
    const { S } = await import('./js/estado.js');
    const visor = document.getElementById('qr-visor');
    const puck = document.querySelector('.qr-puck');
    const pista = document.querySelector('.qr-pista');
    const tinta = visor.querySelector('.qr-tinta');
    const r = visor.getBoundingClientRect();
    return {
      pagina: S.pagina, zoom: S.zoom, modoZoom: S.modoZoom,
      scrollTop: visor.scrollTop, scrollLeft: visor.scrollLeft,
      navegando: visor.classList.contains('is-navegando'),
      anotando: visor.classList.contains('is-anotando'),
      puck: !!puck && puck.classList.contains('is-visible'),
      puckXY: puck ? [parseFloat(puck.style.left), parseFloat(puck.style.top)] : null,
      activo: puck?.dataset.activo || '',
      transform: pista.style.transform,
      tintaRecibe: tinta ? getComputedStyle(tinta).pointerEvents : 'sin canvas',
      etiqueta: document.getElementById('qr-zoom-valor').textContent,
      visor: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`);

  /* Qué punto del papel hay bajo un punto del visor: página y fracción. Es la
     misma cuenta que hace asentarZoom(), hecha aparte para poder comparar. */
  const bajo = (x, y) => js(`(() => {
    const visor = document.getElementById('qr-visor');
    const vr = visor.getBoundingClientRect();
    let hit = null;
    for (const el of visor.querySelectorAll('.qr-pliego')) {
      const r = el.getBoundingClientRect();
      const top = r.top - vr.top;
      if (${y} < top) break;
      hit = { pagina: Number(el.dataset.pagina), fx: (${x} - (r.left - vr.left)) / r.width, fy: (${y} - top) / r.height };
    }
    return hit;
  })()`);

  /* ── 1. Sin tinta, Espacio pasa de página ───────────────────────────────── */
  console.log('\n1. Sin tinta');
  {
    const antes = await estado();
    tecla('keyDown', 'Space'); tecla('keyUp', 'Space');
    await esperar(600);
    const despues = await estado();
    ok('Espacio pasa a la página siguiente', despues.pagina === antes.pagina + 1, `${antes.pagina} → ${despues.pagina}`);
    ok('y no aparece ningún disco', !despues.puck && !despues.navegando);
  }

  /* ── 2. Con tinta, Espacio mantenido es el puck ─────────────────────────── */
  console.log('\n2. La barra, anotando');
  await js(`document.getElementById('qr-tinta-toggle').click()`);
  // que la barra de tinta termine de abrirse: el visor se mide DESPUÉS
  await esperar(600);

  const v = (await estado()).visor;
  const centro = { x: v.x + Math.round(v.w / 2), y: v.y + Math.round(v.h / 2) };
  // el puntero tiene que estar sobre el visor: ahí es donde aparece el disco
  raton('mouseMove', centro.x, centro.y);
  await esperar(60);

  tecla('keyDown', 'Space');
  // Windows repite el keydown mientras se mantiene: no puede desarmar nada.
  await esperar(80);
  tecla('keyDown', 'Space');
  await esperar(250);

  let n = await estado();
  ok('la tinta quedó prendida', n.anotando);
  ok('aparece el disco', n.puck);
  ok('bajo el puntero', n.puckXY && Math.abs(n.puckXY[0] - v.w / 2) <= 2 && Math.abs(n.puckXY[1] - v.h / 2) <= 2,
    JSON.stringify(n.puckXY));
  ok('el visor entra en modo navegación', n.navegando);
  ok('y la tinta suelta el puntero', n.tintaRecibe === 'none', n.tintaRecibe);
  const paginaConDisco = n.pagina;

  /* ── 3. Arrastrar el anillo desplaza ────────────────────────────────────── */
  console.log('\n3. El anillo');
  {
    const antes = await estado();
    // a 40 px del centro cae en el anillo (24 < 40 < 54)
    const de = { x: centro.x, y: centro.y + 40 };
    raton('mouseDown', de.x, de.y);
    for (let i = 1; i <= 10; i++) { raton('mouseMove', de.x, de.y - 15 * i); await esperar(16); }
    const enVuelo = await estado();
    raton('mouseUp', de.x, de.y - 150);
    await esperar(200);
    const despues = await estado();

    ok('mientras se arrastra, el anillo está activo', enVuelo.activo === 'anillo', enVuelo.activo);
    ok('el scroll sigue a la mano, píxel por píxel', despues.scrollTop - antes.scrollTop === 150,
      `${antes.scrollTop} → ${despues.scrollTop}`);
    ok('sin tocar el zoom', despues.zoom === antes.zoom && despues.modoZoom === antes.modoZoom);
    ok('y al soltar se apaga la zona', despues.activo === '', despues.activo);
    ok('con el disco todavía puesto', despues.puck && despues.navegando);
  }

  /* ── 4. Arrastrar el núcleo hace zoom ───────────────────────────────────── */
  console.log('\n4. El núcleo');
  {
    const antes = await estado();
    /* El punto se mide donde el disco está DE VERDAD, no donde se lo pidió:
       es el centro del disco lo que asentarZoom() promete dejar quieto. */
    const [px, py] = antes.puckXY;
    const anclaAntes = await bajo(px, py);
    const escalaAntes = parseInt(antes.etiqueta, 10);

    raton('mouseDown', centro.x, centro.y);
    // 180 px hacia arriba: exactamente el doble
    for (let i = 1; i <= 12; i++) { raton('mouseMove', centro.x, centro.y - 15 * i); await esperar(16); }
    await esperar(60);
    const enVuelo = await estado();
    raton('mouseUp', centro.x, centro.y - 180);
    await esperar(400);
    const despues = await estado();
    const anclaDespues = await bajo(px, py);

    ok('mientras se arrastra, el núcleo está activo', enVuelo.activo === 'nucleo', enVuelo.activo);
    ok('la pista se escala en vivo', /scale\(1\.9|scale\(2/.test(enVuelo.transform), enVuelo.transform);
    ok('y la etiqueta ya dice el doble', Math.abs(parseInt(enVuelo.etiqueta, 10) - escalaAntes * 2) <= 2,
      `${antes.etiqueta} → ${enVuelo.etiqueta}`);

    ok('al soltar, el transform se va', despues.transform === '', despues.transform);
    ok('y el zoom es de verdad: fijo y al doble', despues.modoZoom === 'fijo'
      && Math.abs(despues.zoom - escalaAntes / 100 * 2) < 0.03, `${despues.zoom} (antes ${antes.etiqueta})`);
    ok('la etiqueta queda en el valor real', Math.abs(parseInt(despues.etiqueta, 10) - escalaAntes * 2) <= 2, despues.etiqueta);
    ok('el mismo punto del papel sigue bajo el disco',
      anclaAntes && anclaDespues && anclaAntes.pagina === anclaDespues.pagina
        && Math.abs(anclaAntes.fx - anclaDespues.fx) < 0.01 && Math.abs(anclaAntes.fy - anclaDespues.fy) < 0.01,
      `${JSON.stringify(anclaAntes)} → ${JSON.stringify(anclaDespues)}`);
  }

  /* ── 5. Soltar la barra desarma todo ────────────────────────────────────── */
  console.log('\n5. Soltar la barra');
  {
    tecla('keyUp', 'Space');
    await esperar(300);
    const n2 = await estado();
    ok('el disco se va', !n2.puck);
    ok('el visor deja de navegar', !n2.navegando);
    ok('y la tinta recupera el puntero', n2.tintaRecibe === 'auto', n2.tintaRecibe);
    ok('la tinta sigue prendida', n2.anotando);
    /* Espacio con tinta no pasa de página: el zoom y el paneo pueden haber
       movido la actual, pero nunca por la tecla. Se compara con la página que
       había al aparecer el disco, antes de cualquier arrastre, por arriba. */
    ok('Espacio no pasó de página por su cuenta', n2.pagina <= paginaConDisco + 1, `${paginaConDisco} → ${n2.pagina}`);
  }

  /* ── 6. Apagar la tinta con el disco puesto ─────────────────────────────── */
  console.log('\n6. Apagar la tinta con la barra apretada');
  {
    tecla('keyDown', 'Space');
    await esperar(200);
    const con = await estado();
    await js(`document.getElementById('qr-tinta-toggle').click()`);
    await esperar(300);
    const sin = await estado();
    tecla('keyUp', 'Space');
    await esperar(100);
    ok('el disco había aparecido', con.puck);
    ok('apagar la tinta se lo lleva', !sin.puck && !sin.navegando && !sin.anotando);
  }

  console.log(`\n═══ ${pass} ok · ${problemas.length} fallas ═══`);
  for (const p of problemas) console.log('  ! ' + p);

  win.destroy();
  limpiar();
  app.exit(problemas.length ? 1 : 0);
}

function limpiar() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ya no está */ }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
