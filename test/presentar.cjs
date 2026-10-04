/* ═══════════════════════════════════════════════════════════════════════════
   Presentar, de punta a punta.

   Monta Quire de verdad con seis diapositivas 16:9 de colores distintos (el
   color del centro de la lámina dice cuál se ve) y recorre las dos formas:

   · UNA PANTALLA: F5, avanzar y volver con cada tecla de los presentadores,
     ir a una por número, la tarjeta del final, la pantalla en negro, el
     láser, la tinta de paso, la grilla, el clic y la rueda, y que al
     terminar el lector quede en la diapositiva donde se terminó.
   · CON SALA: con QUIRE_SALA=fuera, src/presentacion.cjs hace de cuenta que
     hay un segundo monitor (fuera de pantalla). La sala muestra lo mismo que
     la actual del orador, la siguiente va un paso adelante, el láser y la
     tinta del orador se ven en la sala, y si la sala se cierra sola la
     presentación sigue en una pantalla.

   El teclado va con eventos de ENTRADA (sendInputEvent), igual que el mouse:
   es el camino de verdad, con el foco y el orden de pointerdown → click.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abandono, hasta, esperar, vigilarConsola, esGrave } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');
require('./datos-propios.cjs')('presentar');

let pass = 0; let fail = 0;
const fallas = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); return; }
  fail++; fallas.push(n); console.log(`  FALLA ${n} ${x}`);
};
const SOLO = process.env.SOLO ? new RegExp(process.env.SOLO) : null;
async function bloque(nombre, fn) {
  if (SOLO && !SOLO.test(nombre)) return;
  try { await fn(); } catch (err) { ok(`${nombre}: el caso explotó`, false, String(err?.message || err).slice(0, 200)); }
}
abandono({ ms: 180000 });

/* Seis colores bien separados: el de cada diapositiva. */
const COLORES = [[220, 40, 40], [40, 160, 60], [40, 80, 220], [230, 180, 30], [150, 60, 200], [30, 180, 190]];

async function armarDiapositivas() {
  const { PDFDocument, rgb } = require('pdf-lib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-presentar-'));
  const pdf = await PDFDocument.create();
  for (const [r, g, b] of COLORES) {
    const hoja = pdf.addPage([960, 540]);
    hoja.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(r / 255, g / 255, b / 255) });
    hoja.drawRectangle({ x: 40, y: 440, width: 60, height: 60, color: rgb(1, 1, 1) });
  }
  const ruta = path.join(dir, 'diapositivas.pdf');
  fs.writeFileSync(ruta, await pdf.save());
  return ruta;
}

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const presentacion = require(path.join(RAIZ, 'src', 'presentacion.cjs'));
  const ruta = await armarDiapositivas();

  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1280, height: 800,
    backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  // Lo mismo que main.cjs: la única ventana que se abre es la sala.
  win.webContents.setWindowOpenHandler((d) => presentacion.abrirVentana(win, d) || { action: 'deny' });
  presentacion.vigilar(win);
  const errores = [];
  vigilarConsola(win, errores);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const tecla = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await esperar(60);
  };
  const raton = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const estado = () => js('window.__quirePresentacion()');
  /* El centro de la principal: dónde cae y de qué diapositiva es el color. */
  await js(`(() => {
    const COLORES = ${JSON.stringify(COLORES)};
    window.T = {
      caja(sel, doc = document) {
        const r = doc.querySelector(sel).getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      },
      pixel(sel, fx = 0.5, fy = 0.5, doc = document) {
        const cs = [...doc.querySelectorAll(sel + ' .qr-esc__lamina')];
        const c = cs[cs.length - 1];
        if (!c) return null;
        return [...c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data].slice(0, 3);
      },
      cual(sel, doc = document) {
        const px = window.T.pixel(sel, 0.5, 0.5, doc);
        if (!px) return null;
        if (px[0] + px[1] + px[2] < 30) return 0;
        let mejor = -1; let dist = Infinity;
        COLORES.forEach((c, i) => {
          const d = Math.hypot(c[0] - px[0], c[1] - px[1], c[2] - px[2]);
          if (d < dist) { dist = d; mejor = i + 1; }
        });
        return dist < 60 ? mejor : -1;
      },
      tintaRoja(sel, doc = document) {
        const c = doc.querySelector(sel + ' .qr-esc__tinta');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
        return n;
      },
    };
    return true;
  })()`);

  await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(ruta)}));
    (await import('./js/router.js')).default.go('lector');
  })()`);
  await hasta(() => js(`document.querySelectorAll('.qr-pliego').length === 6`), 8000, 'el PDF no abrió');
  await esperar(500);

  const listo = () => hasta(async () => {
    const e = await estado();
    return e.activa && !!(await js(`document.querySelector('#qr-presentacion > .qr-pres__telon.is-abierto') !== null`));
  }, 6000, 'la presentación no arrancó');
  const enDiapositiva = (n, sel = '.qr-esc--principal', doc = 'document') =>
    hasta(() => js(`T.cual(${JSON.stringify(sel)}, ${doc})`).then((c) => c === n), 3000, `no se vio la ${n}`).then(() => true, () => false);
  const centroPrincipal = () => js(`T.caja('.qr-esc--principal')`).then((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2, b }));

  /* ── 1 · Una pantalla ─────────────────────────────────────────────────── */
  console.log('\n1. Una pantalla');

  await bloque('arrancar con F5', async () => {
    await js(`document.getElementById('qr-visor')?.focus()`);
    await tecla('F5');
    await listo();
    const e = await estado();
    ok('F5 arranca la presentación', e.activa);
    ok('con una sola pantalla no hay sala', !e.dual && !e.sala);
    ok('la capa es la de una pantalla', await js(`document.getElementById('qr-presentacion').classList.contains('qr-pres--sola')`));
    ok('arranca en la primera', await enDiapositiva(1));
    const b = await js(`({ ...T.caja('.qr-esc--principal'), vw: innerWidth, vh: innerHeight })`);
    ok('la principal ocupa la ventana', b.x === 0 && b.y === 0 && b.w === b.vw && b.h === b.vh, JSON.stringify(b));
    /* 16:9 en una ventana más cuadrada: la lámina va a lo ancho, con negro
       arriba y abajo (12 px en esta). */
    const borde = await js(`T.pixel('.qr-esc--principal', 0.5, 3 / innerHeight)`);
    ok('lo que rodea a la lámina es negro de verdad', borde && borde.every((v) => v < 4), JSON.stringify(borde));
  });

  await bloque('avanzar y volver', async () => {
    await tecla('Right');
    ok('→ avanza', await enDiapositiva(2));
    ok('la cuenta dice 2 / 6', await js(`document.querySelector('[data-cuenta]').textContent.trim() === '2 / 6'`));
    await tecla('PageDown');
    ok('AvPág avanza', await enDiapositiva(3));
    await tecla('Space');
    ok('Espacio avanza', await enDiapositiva(4));
    await tecla('PageUp');
    ok('RePág vuelve', await enDiapositiva(3));
    await tecla('Left');
    ok('← vuelve', await enDiapositiva(2));
    await tecla('End');
    ok('Fin va a la última', await enDiapositiva(6));
    await tecla('Home');
    ok('Inicio va a la primera', await enDiapositiva(1));
    await tecla('Left');
    await esperar(250);
    ok('antes de la primera no hay nada', (await estado()).n === 1);
  });

  await bloque('el fundido', async () => {
    /* Al cambiar, la vieja queda ENCIMA como calco y la nueva quieta debajo:
       a mitad de camino hay dos láminas y la de arriba es la vieja. */
    await tecla('Right');
    const durante = await js(`(() => {
      const cs = [...document.querySelectorAll('.qr-esc--principal .qr-esc__lamina')];
      return { cuantas: cs.length, arriba: cs.length ? T.cual('.qr-esc--principal') : null };
    })()`);
    ok('durante el cambio hay calco y lámina nueva', durante.cuantas === 2, JSON.stringify(durante));
    await esperar(400);
    ok('al final queda una sola lámina', await js(`document.querySelectorAll('.qr-esc--principal .qr-esc__lamina').length === 1`));
    ok('y es la nueva', await enDiapositiva(2));
  });

  await bloque('el final', async () => {
    await tecla('End');
    await enDiapositiva(6);
    await tecla('Right');
    await esperar(400);
    const e = await estado();
    ok('después de la última viene la tarjeta del final', e.n === 7 && await js(`document.querySelector('.qr-esc--principal').classList.contains('is-fin')`));
    ok('la tarjeta es negra', (await js(`T.cual('.qr-esc--principal')`)) === 0);
    await tecla('Right');
    await esperar(200);
    ok('del final no se pasa', (await estado()).n === 7);
    await tecla('Left');
    ok('y se vuelve a la última', await enDiapositiva(6));
  });

  await bloque('ir por número', async () => {
    await tecla('3');
    ok('el número que se teclea se ve', await js(`document.querySelector('[data-salto]').classList.contains('is-visible')`));
    await tecla('Return');
    ok('3 y Enter va a la 3', await enDiapositiva(3));
  });

  await bloque('pantalla en negro', async () => {
    await tecla('B');
    await esperar(350);
    ok('B pone la pantalla en negro', (await estado()).negro && await js(`document.querySelector('.qr-esc--principal').classList.contains('is-negro')`));
    await tecla('Right');
    await esperar(350);
    const e = await estado();
    ok('la siguiente tecla la prende sin avanzar', !e.negro && e.n === 3, JSON.stringify(e));
    await tecla('.');
    ok('el punto también apaga', (await estado()).negro);
    await tecla('.');
  });

  await bloque('el láser', async () => {
    const c = await centroPrincipal();
    await tecla('L');
    raton('mouseMove', c.x + 100, c.y + 50);
    await esperar(200);
    ok('L prende el láser y sigue al mouse', await js(`document.querySelector('.qr-esc--principal .qr-esc__laser').classList.contains('is-on')`));
    const t = await js(`document.querySelector('.qr-esc--principal .qr-esc__laser').style.transform`);
    const m = /translate\(([\d.]+)px, ([\d.]+)px\)/.exec(t);
    ok('el punto está donde está el mouse', m && Math.abs(+m[1] - (c.b.w / 2 + 100)) < 2 && Math.abs(+m[2] - (c.b.h / 2 + 50)) < 2, t);
    raton('mouseDown', c.x + 100, c.y + 50);
    raton('mouseUp', c.x + 100, c.y + 50);
    await esperar(200);
    ok('con el láser, el clic no avanza', (await estado()).n === 3);
    await tecla('L');
    await esperar(200);
    ok('L lo apaga', !(await js(`document.querySelector('.qr-esc--principal .qr-esc__laser').classList.contains('is-on')`)));
  });

  await bloque('la tinta de paso', async () => {
    const c = await centroPrincipal();
    await tecla('D');
    raton('mouseMove', c.x - 200, c.y);
    raton('mouseDown', c.x - 200, c.y);
    for (let i = 1; i <= 10; i++) raton('mouseMove', c.x - 200 + i * 30, c.y + i * 8, { button: 'left' });
    raton('mouseUp', c.x + 100, c.y + 80);
    await esperar(150);
    ok('D y arrastrar deja un trazo', (await estado()).trazos === 1);
    ok('el trazo se ve rojo', (await js(`T.tintaRoja('.qr-esc--principal')`)) > 200);
    ok('dibujando, el clic no avanza', (await estado()).n === 3);
    await tecla('E');
    await esperar(350);
    ok('E borra lo dibujado', (await estado()).trazos === 0 && (await js(`T.tintaRoja('.qr-esc--principal')`)) === 0);
    raton('mouseDown', c.x, c.y);
    for (let i = 1; i <= 6; i++) raton('mouseMove', c.x + i * 20, c.y, { button: 'left' });
    raton('mouseUp', c.x + 120, c.y);
    await esperar(100);
    await tecla('Right');
    await esperar(400);
    const e = await estado();
    ok('cambiar de diapositiva se lleva la tinta', e.trazos === 0 && e.n === 4 && (await js(`T.tintaRoja('.qr-esc--principal')`)) === 0);
    await tecla('Escape');
    ok('Escape suelta el lápiz antes de terminar', (await estado()).modo === null && (await estado()).activa);
  });

  await bloque('la grilla', async () => {
    await tecla('G');
    await esperar(300);
    ok('G abre la grilla', (await estado()).grilla && await js(`document.querySelectorAll('.qr-diapos__item').length === 6`));
    ok('la actual está marcada', await js(`document.querySelector('.qr-diapos__item.is-actual')?.dataset.ir === '4'`));
    await hasta(() => js(`document.querySelectorAll('.qr-diapos img.is-lista').length === 6`), 5000, 'las miniaturas no cargaron').catch(() => {});
    ok('las miniaturas cargan', await js(`document.querySelectorAll('.qr-diapos img.is-lista').length === 6`));
    await tecla('Right');
    await tecla('Return');
    ok('→ y Enter en la grilla van a la 5', await enDiapositiva(5));
    await esperar(300);
    ok('y la grilla se cierra', !(await estado()).grilla && await js(`!document.querySelector('.qr-diapos')`));
  });

  await bloque('clic y rueda', async () => {
    const c = await centroPrincipal();
    raton('mouseDown', c.x, c.y);
    raton('mouseUp', c.x, c.y);
    ok('un clic avanza', await enDiapositiva(6));
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(c.x), y: Math.round(c.y), deltaX: 0, deltaY: 120 });
    await esperar(400);
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(c.x), y: Math.round(c.y), deltaX: 0, deltaY: 120 });
    await esperar(400);
    ok('la rueda vuelve de a una', await enDiapositiva(4));
  });

  await bloque('el teclado es de la presentación', async () => {
    await tecla('W', ['control']);
    await esperar(300);
    ok('Ctrl+W no cierra el documento de atrás', await js(`(async () => !!(await import('./js/estado.js')).S.doc)()`));
  });

  await bloque('terminar', async () => {
    await tecla('Escape');
    await hasta(() => js(`!document.getElementById('qr-presentacion')`), 3000, 'la capa no se fue');
    ok('Escape termina', !(await estado()).activa);
    await esperar(300);
    ok('el lector queda en la diapositiva donde se terminó', await js(`(async () => (await import('./js/estado.js')).S.pagina === 4)()`));
    ok('el foco vuelve al lector', await js(`document.activeElement !== document.body`));
  });

  await bloque('Mayús+F5 desde la actual', async () => {
    await tecla('F5', ['shift']);
    await listo();
    ok('Mayús+F5 arranca en la que se estaba mirando', await enDiapositiva(4));
    await tecla('Escape');
    await hasta(() => js(`!document.getElementById('qr-presentacion')`), 3000, 'la capa no se fue');
  });

  await bloque('el botón de la barra', async () => {
    await js(`document.getElementById('qr-presentar').click()`);
    await listo();
    ok('el botón arranca desde el principio', await enDiapositiva(1));
    await tecla('Escape');
    await hasta(() => js(`!document.getElementById('qr-presentacion')`), 3000, 'la capa no se fue');
  });

  /* ── 2 · Con sala ─────────────────────────────────────────────────────── */
  console.log('\n2. Con sala');
  process.env.QUIRE_SALA = 'fuera';
  const SALA = 'window.__quireSala()';

  await bloque('arrancar con sala', async () => {
    await tecla('F5');
    await listo();
    const e = await estado();
    ok('con otra pantalla se abre la sala', e.dual && e.sala);
    ok('acá queda la vista del orador', await js(`document.getElementById('qr-presentacion').classList.contains('qr-pres--orador')`));
    ok('hay dos ventanas', BrowserWindow.getAllWindows().length === 2);
    ok('la sala muestra la primera', await enDiapositiva(1, '.qr-esc--sala', SALA));
    ok('la actual del orador también', await enDiapositiva(1));
    ok('la siguiente va un paso adelante', await enDiapositiva(2, '.qr-esc--siguiente'));
    await hasta(() => js(`!!${SALA}.querySelector('.qr-pres__telon.is-abierto')`), 3000, 'el telón de la sala no se levantó').catch(() => {});
    ok('el telón de la sala se levanta', await js(`!!${SALA}.querySelector('.qr-pres__telon.is-abierto')`));
    const b = await js(`T.caja('.qr-esc--sala', ${SALA})`);
    ok('la sala ocupa su pantalla', b.w === 1280 && b.h === 720, JSON.stringify(b));
    ok('el reloj corre', /^\d+:\d\d$/.test(await js(`document.querySelector('[data-reloj]').textContent`)));
    ok('la hora se ve', /^\d\d:\d\d$/.test(await js(`document.querySelector('[data-hora]').textContent`)));
  });

  await bloque('la sala acompaña', async () => {
    await tecla('Right');
    ok('al avanzar, la sala muestra la 2', await enDiapositiva(2, '.qr-esc--sala', SALA));
    ok('y la siguiente, la 3', await enDiapositiva(3, '.qr-esc--siguiente'));
    await tecla('B');
    await esperar(350);
    ok('B pone la sala en negro', await js(`${SALA}.querySelector('.qr-esc--sala').classList.contains('is-negro')`));
    ok('y el orador lo ve a medias', await js(`document.querySelector('.qr-esc--orador').classList.contains('is-negro') && document.querySelector('.qr-esc--siguiente').classList.contains('is-negro') === false`));
    await tecla('B');
  });

  await bloque('el láser y la tinta van a la sala', async () => {
    const c = await centroPrincipal();
    await tecla('L');
    raton('mouseMove', c.x + c.b.w / 4, c.y);
    await esperar(200);
    const punto = await js(`(() => {
      const l = ${SALA}.querySelector('.qr-esc--sala .qr-esc__laser');
      const m = /translate\\(([\\d.]+)px, ([\\d.]+)px\\)/.exec(l.style.transform) || [];
      return { on: l.classList.contains('is-on'), x: +m[1], y: +m[2] };
    })()`);
    ok('el láser del orador se ve en la sala', punto.on, JSON.stringify(punto));
    // Tres cuartos del ancho, a media altura: en la sala de 1280×720 es (960, 360).
    ok('en el mismo lugar de la diapositiva', Math.abs(punto.x - 960) < 6 && Math.abs(punto.y - 360) < 6, JSON.stringify(punto));
    await tecla('L');
    await tecla('D');
    raton('mouseDown', c.x - 100, c.y);
    for (let i = 1; i <= 8; i++) raton('mouseMove', c.x - 100 + i * 25, c.y + i * 5, { button: 'left' });
    raton('mouseUp', c.x + 100, c.y + 40);
    await esperar(150);
    ok('lo que se dibuja en el orador se ve en la sala', (await js(`T.tintaRoja('.qr-esc--sala', ${SALA})`)) > 200);
    await tecla('E');
    await tecla('D');
  });

  await bloque('el cronómetro', async () => {
    await js(`document.querySelector('.qr-orador__reloj [data-act="pausar"]').click()`);
    const a = await js(`document.querySelector('[data-reloj]').textContent`);
    await esperar(1300);
    const b = await js(`document.querySelector('[data-reloj]').textContent`);
    ok('pausado, el reloj no avanza', (await estado()).pausado && a === b, `${a} → ${b}`);
    await js(`document.querySelector('[data-act="reiniciar"]').click()`);
    await esperar(300);
    ok('volver a cero', (await js(`document.querySelector('[data-reloj]').textContent`)) === '0:00');
    await tecla('T');
    ok('T lo vuelve a poner en marcha', !(await estado()).pausado);
  });

  await bloque('si la sala se cierra sola', async () => {
    const sala = BrowserWindow.getAllWindows().find((w) => w !== win);
    sala.close();
    await hasta(async () => !(await estado()).dual, 3000, 'no volvió a una pantalla');
    const e = await estado();
    ok('la presentación sigue en una pantalla', e.activa && !e.dual && !e.sala);
    ok('con la capa de una pantalla', await js(`document.getElementById('qr-presentacion').classList.contains('qr-pres--sola')`));
    ok('en la misma diapositiva', await enDiapositiva(2));
    await tecla('Escape');
    await hasta(() => js(`!document.getElementById('qr-presentacion')`), 3000, 'la capa no se fue');
  });

  await bloque('terminar con sala', async () => {
    await tecla('F5');
    await listo();
    await tecla('Right');
    await tecla('Escape');
    await hasta(() => js(`!document.getElementById('qr-presentacion')`), 3000, 'la capa no se fue');
    await esperar(300);
    ok('al terminar se cierra la sala', BrowserWindow.getAllWindows().length === 1);
    ok('y el lector queda en la 2', await js(`(async () => (await import('./js/estado.js')).S.pagina === 2)()`));
  });

  const graves = errores.filter(esGrave);
  ok('la consola quedó limpia', graves.length === 0, graves.slice(0, 3).join(' | '));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  if (fallas.length) console.log('Fallaron:\n  ' + fallas.join('\n  '));
  app.exit(fail ? 1 : 0);
});
