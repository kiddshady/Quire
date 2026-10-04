/* ═══════════════════════════════════════════════════════════════════════════
   Anotar en el lector: la tinta montada en las hojas de verdad, con el zoom,
   la precarga, los fundidos y el chrome alrededor. Es lo que arregló el
   paquete 3A de la auditoría de octubre de 2026 (tinta-04, tinta-05, tinta-07,
   tinta-10, tinta-12, tinta-13, lector-33, tinta-15, tinta-20, tinta-21,
   tinta-24, ux-19, lector-23, css-23), y lo que encontró su revisión: la
   tinta que no volvía después de un giro de ida y vuelta, los fundidos que se
   cortaban con Ctrl+Z seguidos, el resaltador en curso encima de la pluma.

   test/tinta.cjs prueba el motor suelto (el editor sobre un pliego armado a
   mano, la capa, el aplanado). Acá se prueba lo que solo existe con el lector
   alrededor: que el editor sobreviva al zoom, que el resaltador se mezcle con
   la hoja en pantalla, que un deshacer redibuje solo su hoja, que borrar se
   funda, que la tinta entre con la hoja, cuánta memoria cuestan los canvas.

   Lo que se mueve se mide: opacidades muestreadas EN la página (sin la
   latencia del IPC), píxeles de capturePage para lo que mezcla el compositor.
   Cada bloque se corrió al revés contra el código de antes (ver «al revés» en
   el informe del paquete). Con SOLO (una expresión regular) corren solo los
   bloques que coinciden; con VERBOSO=1 también se ven los números de lo que
   pasa.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vigilarConsola, abandono, esperar, hasta } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('anotar');

let pass = 0; let fail = 0;
const fallas = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${process.env.VERBOSO ? ` ${x}` : ''}`); return; }
  fail++; fallas.push(n); console.log(`  FALLA ${n} ${x}`);
};

let dir = null;
const bail = abandono({
  ms: 180000,
  salir: (c) => { if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ya no está */ } app.exit(c); },
});

const SOLO = process.env.SOLO ? new RegExp(process.env.SOLO) : null;
async function bloque(nombre, fn) {
  if (SOLO && !SOLO.test(nombre)) return;
  try { await fn(); } catch (err) { ok(`${nombre}: el caso explotó`, false, String(err?.message || err).slice(0, 200)); }
}

/* El cobayo: treinta A4 con renglones de texto negro (para tener letras que
   resaltar) en las mismas coordenadas en todas las hojas. */
async function armarCobayo() {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-anotar-'));
  const pdf = await PDFDocument.create();
  const fuente = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let p = 1; p <= 30; p++) {
    const hoja = pdf.addPage([595, 842]);
    for (let r = 0; r < 18; r++) {
      hoja.drawText(`RENGLON ${r + 1} DE LA HOJA ${p} MMMMMMMM`, { x: 60, y: 780 - r * 40, size: 18, font: fuente, color: rgb(0, 0, 0) });
    }
  }
  const ruta = path.join(dir, 'cobayo-anotar.pdf');
  fs.writeFileSync(ruta, await pdf.save());
  return ruta;
}

/** Luminancia mínima y píxeles amarillos de una NativeImage (BGRA). */
function medirFoto(img) {
  const buf = img.toBitmap();
  let min = 255; let amarillos = 0; let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i]; const g = buf[i + 1]; const r = buf[i + 2];
    const luz = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luz < min) min = luz;
    // El 34 % de amarillo sobre blanco da ~(250, 235, 173): lo delata el azul que baja.
    if (r > 200 && g > 170 && r - b > 50) amarillos++;
    n++;
  }
  return { min: Math.round(min), amarillos, n };
}

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const ruta = await armarCobayo();

  /* Fuera de pantalla pero VISIBLE: Chromium congela las animaciones de una
     ventana con show:false, y acá se mide lo que se funde. */
  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1300, height: 1000,
    backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  const errores = [];
  vigilarConsola(win, errores);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

  await js(`(() => {
    window.T = {
      async mod(n) { return import('./js/' + n + '.js'); },
      cuadro: () => new Promise((r) => requestAnimationFrame(() => r())),
      espera: (ms) => new Promise((r) => setTimeout(r, ms)),
      visor: () => document.getElementById('qr-visor'),
      pliego: (n) => document.querySelector('#view .qr-pliego[data-pagina="' + n + '"]'),
      capa: (n, clase = 'qr-tinta') => window.T.pliego(n)?.querySelector('canvas.' + clase),
      async irA(n) { (await window.T.mod('views/lector')).irA(n, { suave: false }); },
      /* setPointerCapture rechaza un pointerId que no existe de verdad: se
         neutraliza en el test, no en stroke.js (vino de Scrawl y así se queda). */
      tirar(c, tipo, fx, fy, o = {}) {
        c.setPointerCapture = () => {}; c.releasePointerCapture = () => {};
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new PointerEvent(tipo, {
          pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          pressure: tipo === 'pointerup' ? 0 : 0.5, button: tipo === 'pointermove' ? -1 : 0, buttons: tipo === 'pointerup' ? 0 : 1,
          clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, ...o,
        }));
      },
      raya(n, x0, y0, x1, y1, pasos = 8) {
        const c = window.T.capa(n);
        window.T.tirar(c, 'pointerdown', x0, y0);
        for (let i = 1; i <= pasos; i++) window.T.tirar(c, 'pointermove', x0 + (x1 - x0) * i / pasos, y0 + (y1 - y0) * i / pasos);
        window.T.tirar(c, 'pointerup', x1, y1);
      },
      async herramienta(id) {
        document.querySelector('[data-tinta-tool="' + id + '"]')?.click();
        await window.T.espera(60);
      },
      async prender(si = true) {
        const b = document.getElementById('qr-tinta-toggle');
        if (b.classList.contains('is-on') !== si) b.click();
        await window.T.espera(450);
      },
      /* Lo que pesan los bitmaps de tinta y de hoja de las hojas montadas, en MB. */
      bitmaps() {
        const mb = (sel) => [...document.querySelectorAll('#view .qr-pliego ' + sel)].reduce((s, c) => s + c.width * c.height * 4, 0) / 1048576;
        return {
          hojas: +mb('canvas.qr-hoja').toFixed(2),
          tinta: +mb('canvas.qr-tinta').toFixed(2),
          resaltador: +mb('canvas.qr-tinta-resaltador').toFixed(2),
          viva: +mb('canvas.qr-tinta-viva').toFixed(2),
          pintadas: document.querySelectorAll('#view .qr-pliego.is-pintada').length,
        };
      },
    };
    return true;
  })()`);

  await js(`(async () => {
    const est = await T.mod('estado');
    for (const p of [...est.S.pestanas]) await est.cerrarPestana(p.id);
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(ruta)}));
    (await T.mod('router')).default.go('lector');
  })()`);
  await hasta(() => js(`document.querySelectorAll('#view .qr-pliego.is-pintada').length >= 1`), 8000, 'el cobayo no se pintó');
  await esperar(500);
  ok('el cobayo abrió en el lector', await js(`document.querySelectorAll('#view .qr-pliego').length === 30`));

  /* ── 1 · El editor sobrevive al zoom (tinta-04) ──────────────────────────── */
  console.log('\n1. El editor sobrevive al zoom');

  await bloque('tinta-04', async () => {
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.irA(1); await T.espera(700);
      await T.prender(); await T.herramienta('fibra');
      const c0 = T.capa(1);
      T.raya(1, 0.2, 0.25, 0.5, 0.25);
      const antes = S.tinta.trazos(1).length;
      document.getElementById('qr-zoom-mas').click();
      await T.cuadro();
      /* En el cuadro siguiente al «+»: la tinta mide lo del pliego nuevo, y un
         trazo dibujado YA cae donde se ve, aunque la hoja todavía no se haya
         vuelto a pintar a la escala nueva. */
      const rp = T.pliego(1).getBoundingClientRect(); const rt = T.capa(1).getBoundingClientRect();
      const c1 = T.capa(1);
      T.raya(1, 0.3, 0.6, 0.6, 0.6);
      const t = S.tinta.trazos(1).at(-1);
      const enseguida = { trazos: S.tinta.trazos(1).length - antes, primer: t?.puntos[0], esperado: [0.3 * 595, 0.4 * 842] };
      /* Un trazo que empieza antes de un zoom y termina después de que la hoja
         se volvió a pintar: antes el editor se rehacía sobre un clon y el
         pointerup caía en otro canvas. */
      T.tirar(T.capa(1), 'pointerdown', 0.2, 0.8);
      for (let i = 1; i <= 4; i++) T.tirar(T.capa(1), 'pointermove', 0.2 + i * 0.03, 0.8);
      document.getElementById('qr-zoom-mas').click();
      await T.espera(1400);
      for (let i = 1; i <= 6; i++) T.tirar(T.capa(1), 'pointermove', 0.34 + i * 0.06, 0.8);
      T.tirar(T.capa(1), 'pointerup', 0.7, 0.8);
      const largo = S.tinta.trazos(1).at(-1);
      const r = {
        caja: { dx: +Math.abs(rp.width - rt.width).toFixed(2), dy: +Math.abs(rp.height - rt.height).toFixed(2), dl: +Math.abs(rp.left - rt.left).toFixed(2) },
        mismoCanvas: c0 === c1 && c1 === T.capa(1),
        enseguida,
        largo: { ultimo: largo?.puntos.at(-1), esperado: [0.7 * 595, 0.2 * 842], puntos: largo?.puntos.length },
        total: S.tinta.cuenta,
      };
      document.getElementById('qr-fit-ancho').click();
      await T.espera(900);
      return r;
    })()`);
    const d = (a, b) => (a && b ? +Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(1) : null);
    ok('en el cuadro siguiente al «+», la tinta mide lo que su pliego', r.caja.dx <= 0.5 && r.caja.dy <= 0.5 && r.caja.dl <= 0.5, JSON.stringify(r.caja));
    ok('el canvas de tinta es el mismo antes y después del zoom (no se recablea)', r.mismoCanvas, JSON.stringify(r));
    ok('un trazo dibujado enseguida entra y cae donde va', r.enseguida.trazos === 1 && d(r.enseguida.primer, r.enseguida.esperado) < 2,
      `${JSON.stringify(r.enseguida)} → a ${d(r.enseguida.primer, r.enseguida.esperado)} pt`);
    ok('un trazo que cruza el render nuevo llega entero hasta donde se levantó el lápiz', d(r.largo.ultimo, r.largo.esperado) < 3,
      `${JSON.stringify(r.largo)} → a ${d(r.largo.ultimo, r.largo.esperado)} pt`);
    ok('y nada se guardó dos veces', r.total === 3, `cuenta ${r.total}`);
  });

  /* ── 2 · El resaltador se mezcla con la hoja (tinta-07) ──────────────────── */
  console.log('\n2. El resaltador con multiply, en pantalla');

  await bloque('tinta-07', async () => {
    // El renglón 1 de la hoja 2: x de 60 a ~500 pt, y de 780 a ~793 (mayúsculas de 18).
    const zona = await js(`(async () => {
      // La barra de tinta corre el visor: se prende ANTES de medir la zona.
      await T.prender(); await T.herramienta('resaltador');
      await T.irA(2); await T.espera(800);
      const p = T.pliego(2).getBoundingClientRect();
      const k = p.width / 595;
      return { x: Math.round(p.left + 90 * k), y: Math.round(p.top + (842 - 795) * k), width: Math.round(300 * k), height: Math.round(14 * k), k };
    })()`);
    const rect = { x: zona.x, y: zona.y, width: zona.width, height: zona.height };
    const antes = medirFoto(await win.webContents.capturePage(rect));
    const r = await js(`(async () => {
      // Un trazo por el medio del renglón, más ancho que las letras (14 pt de alto contra 18 del texto: va de 2 en 2 pasadas).
      for (const fy of [1 - 789 / 842, 1 - 783 / 842]) T.raya(2, 0.1, fy, 0.9, fy, 16);
      await T.espera(300);
      const res = T.capa(2, 'qr-tinta-resaltador');
      return { modo: res ? getComputedStyle(res).mixBlendMode : 'sin capa de resaltador', ancho: res?.width ?? 0 };
    })()`);
    const despues = medirFoto(await win.webContents.capturePage(rect));
    ok('el resaltador va en su capa, con multiply', r.modo === 'multiply' && r.ancho > 0, JSON.stringify(r));
    ok('sobre la letra negra, la letra sigue negra', antes.min < 40 && despues.min < 40, `antes ${JSON.stringify(antes)} · después ${JSON.stringify(despues)}`);
    /* «Antes» ya tiene algunos «amarillos»: el canvas de la hoja es opaco y
       Chromium le pone suavizado de subpíxel al texto, con bordes de color. */
    ok('y el papel de alrededor queda amarillo', despues.amarillos > despues.n * 0.25 && despues.amarillos > antes.amarillos * 4, `antes ${JSON.stringify(antes)} · después ${JSON.stringify(despues)}`);
  });

  /* ── 3 · Deshacer redibuja solo su hoja (tinta-12) ───────────────────────── */
  console.log('\n3. Deshacer y rehacer: solo la hoja de la operación');

  await bloque('tinta-12', async () => {
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.irA(2); await T.espera(600);
      await T.prender(); await T.herramienta('fibra');
      // Tinta en la 2 y en la 3 (las dos montadas), la última en la 2.
      T.raya(3, 0.2, 0.1, 0.6, 0.1);
      T.raya(2, 0.2, 0.5, 0.6, 0.5);
      await T.espera(200);
      const c3 = T.capa(3);
      const ctx = c3.getContext('2d');
      let toques = 0;
      for (const f of ['clearRect', 'fill']) { const o = ctx[f].bind(ctx); ctx[f] = (...a) => { toques++; return o(...a); }; }
      // Desde el visor sube hasta el keydown del documento (app.js → atajosLector).
      const ev = (k, o = {}) => T.visor().dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, ...o }));
      T.visor().focus();
      /* La 2 ya trae los resaltadores del bloque tinta-07: se cuenta contra lo
         que tenía, y el que vuelve tiene que ser EL MISMO trazo. Con «al menos
         uno» el caso pasaba aunque Ctrl+Y no hiciera nada (revisión del
         paquete 3A). */
      const n0 = S.tinta.trazos(2).length;
      const id0 = S.tinta.trazos(2).at(-1)?.id;
      ev('z');
      await T.cuadro();
      const calcos2 = T.pliego(2).querySelectorAll('.qr-tinta-calco').length;
      await T.espera(400);
      const nz = S.tinta.trazos(2).length;
      const sigue = S.tinta.trazos(2).some((t) => t.id === id0);
      ev('y');
      await T.espera(400);
      return { toques3: toques, calcos2, n0, nz, sigue, ny: S.tinta.trazos(2).length, vuelve: S.tinta.trazos(2).at(-1)?.id === id0, conBitmap3: c3.width > 0 };
    })()`);
    ok('Ctrl+Z en la 2 no toca el canvas de la 3', r.conBitmap3 && r.toques3 === 0, JSON.stringify(r));
    ok('y en la 2 lo que se va pasa por un calco', r.calcos2 === 1, JSON.stringify(r));
    ok('Ctrl+Z saca justo ese trazo', r.nz === r.n0 - 1 && !r.sigue, JSON.stringify(r));
    ok('Ctrl+Y lo devuelve: el mismo trazo, y nada más', r.ny === r.n0 && r.vuelve, JSON.stringify(r));
  });

  /* ── 4 · Borrar se funde (tinta-13, lector-33) ───────────────────────────── */
  console.log('\n4. Borrar la tinta se funde');

  await bloque('lector-33', async () => {
    const pagina = await js(`(async () => {
      await T.irA(2); await T.espera(600);
      await T.prender();
      document.getElementById('qr-tinta-menu').click();
      await T.espera(300);
      const item = [...document.querySelectorAll('.ox-menu__item, .ox-menu [role=menuitem], .ox-menu button')].find((b) => /Borrar la tinta de la página 2/.test(b.textContent));
      if (!item) return { error: 'no está el ítem del menú' };
      const out = []; const t0 = performance.now();
      item.click();
      for (;;) {
        const t = Math.round(performance.now() - t0);
        const c = T.pliego(2).querySelector('.qr-tinta-calco');
        out.push(c ? +(+getComputedStyle(c).opacity).toFixed(2) : null);
        if (t > 380) break;
        await T.espera(16);
      }
      return { serie: out, base: T.capa(2).width };
    })()`);
    const vivos = (pagina.serie || []).filter((x) => x !== null);
    ok('borrar la página: un calco que se esfuma de a poco', vivos.length >= 4 && vivos.some((x) => x > 0.15 && x < 0.85)
      && vivos.every((x, i) => i === 0 || x <= vivos[i - 1] + 0.01) && pagina.serie.at(-1) === null, JSON.stringify(pagina));
    ok('y la hoja ya no tiene bitmap de tinta (no queda nada que pintar)', pagina.base === 0, JSON.stringify(pagina));

    const todo = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.irA(1); await T.espera(600);
      await T.herramienta('fibra');
      T.raya(1, 0.2, 0.4, 0.6, 0.4);
      await T.espera(200);
      document.getElementById('qr-tinta-limpiar').click();
      await T.espera(450);
      const boton = [...document.querySelectorAll('.ox-modal .ox-btn')].find((b) => /Borrar todo/.test(b.textContent));
      if (!boton) return { error: 'no apareció el cartel' };
      boton.click();
      const out = []; const t0 = performance.now();
      for (;;) {
        const t = Math.round(performance.now() - t0);
        const c = document.querySelector('#view .qr-tinta-calco');
        out.push(c ? +(+getComputedStyle(c).opacity).toFixed(2) : null);
        if (t > 500) break;
        await T.espera(16);
      }
      return { serie: out, quedan: S.tinta.cuenta };
    })()`);
    const v2 = (todo.serie || []).filter((x) => x !== null);
    ok('«Borrar toda la tinta»: lo que se ve se esfuma de a poco, no de golpe', v2.some((x) => x > 0.15 && x < 0.85) && todo.serie.at(-1) === null && todo.quedan === 0,
      JSON.stringify(todo));
  });

  /* ── 5 · El botón lateral desplaza (tinta-15) ────────────────────────────── */
  console.log('\n5. El botón lateral del lápiz y la rueda del mouse desplazan');

  await bloque('tinta-15', async () => {
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.irA(4); await T.espera(600);
      await T.prender();
      const visor = T.visor();
      /* Se apoya en el medio del visor y se arrastra «dy» px hacia arriba, en
         px de la ventana (la hoja se corre debajo mientras tanto, como con la
         mano de verdad): el scroll tiene que bajar lo mismo. */
      const mover = (o, dy) => {
        const c = T.capa(4);
        const st0 = visor.scrollTop; const n0 = S.tinta.cuenta;
        const v = visor.getBoundingClientRect();
        const y0 = v.top + v.height / 2;
        T.tirar(c, 'pointerdown', 0.5, 0.5, { ...o, clientY: y0 });
        for (let i = 1; i <= 6; i++) T.tirar(c, 'pointermove', 0.5, 0.5, { ...o, button: -1, clientY: y0 - (dy * i) / 6 });
        T.tirar(c, 'pointerup', 0.5, 0.5, { ...o, buttons: 0, clientY: y0 - dy });
        return { delta: Math.round(visor.scrollTop - st0), trazos: S.tinta.cuenta - n0 };
      };
      return {
        lateral: mover({ pointerType: 'pen', button: 2, buttons: 3 }, 120),
        rueda: mover({ pointerType: 'mouse', button: 1, buttons: 4 }, 90),
      };
    })()`);
    ok('el botón lateral del lápiz mueve la hoja lo que se arrastró, sin dibujar', Math.abs(r.lateral.delta - 120) <= 3 && r.lateral.trazos === 0, JSON.stringify(r));
    ok('la rueda apretada del mouse, lo mismo', Math.abs(r.rueda.delta - 90) <= 3 && r.rueda.trazos === 0, JSON.stringify(r));
  });

  /* ── 6 · La tinta entra con la hoja (tinta-20) ───────────────────────────── */
  console.log('\n6. La tinta entra con su hoja');

  await bloque('tinta-20', async () => {
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      S.tinta.agregar(20, { herramienta: 'fibra', color: '#c0392b', ancho: 6, opacidad: 1, puntos: [[100, 400, 1], [400, 420, 1]] });
      const pliego = T.pliego(20);
      if (pliego.classList.contains('is-pintada')) return { error: 'la 20 ya estaba pintada' };
      const out = []; const t0 = performance.now();
      await T.irA(20);
      for (;;) {
        const t = Math.round(performance.now() - t0);
        const c = T.capa(20);
        out.push({ t, tinta: +(+getComputedStyle(c).opacity).toFixed(2), hoja: +(+getComputedStyle(pliego.querySelector('.qr-hoja')).opacity).toFixed(2), bitmap: c.width > 0 });
        if (t > 1500 || (out.length > 3 && out.at(-1).tinta === 1 && out.at(-1).bitmap && out.at(-4).tinta === 1)) break;
        await T.cuadro();
      }
      return { serie: out };
    })()`);
    const s = r.serie || [];
    const conBitmap = s.filter((x) => x.bitmap);
    ok('la tinta se funde junto con la hoja: pasa por valores intermedios', s.some((x) => x.tinta > 0.05 && x.tinta < 0.95), JSON.stringify(s.map((x) => [x.t, x.tinta, x.hoja])));
    ok('y nunca se ve entera sobre la hoja todavía en blanco', conBitmap.every((x) => x.tinta <= x.hoja + 0.2), JSON.stringify(s.map((x) => [x.t, x.tinta, x.hoja, x.bitmap])));
  });

  /* ── 7 · La memoria de los tres canvas (lector-23, riesgo del plan) ──────── */
  console.log('\n7. Cuánto pesan los canvas de tinta');

  await bloque('lector-23', async () => {
    const metricas = () => app.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'GPU')
      .reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024;
    const leer = async (titulo, codigo) => {
      const b = await js(`(async () => { ${codigo}; await T.espera(900); return T.bitmaps(); })()`);
      return { titulo, ...b, procesoMB: Math.round(metricas()) };
    };
    const filas = [];
    filas.push(await leer('leyendo, sin tinta en las hojas a la vista', `await T.prender(false); await T.irA(12)`));
    filas.push(await leer('anotando, sin trazos, punta en el aire', `await T.prender(true); T.tirar(T.capa(12), 'pointermove', 0.5, 0.5, { buttons: 0, pressure: 0, button: -1 })`));
    filas.push(await leer('anotando, pluma en la 12', `await T.herramienta('fibra'); T.raya(12, 0.2, 0.3, 0.6, 0.3)`));
    filas.push(await leer('pluma y resaltador en la 12, punta en el aire (los tres)', `await T.herramienta('resaltador'); T.raya(12, 0.2, 0.5, 0.6, 0.5); T.tirar(T.capa(12), 'pointermove', 0.5, 0.6, { buttons: 0, pressure: 0, button: -1 })`));
    filas.push(await leer('la punta se fue', `T.capa(12).dispatchEvent(new PointerEvent('pointerleave', { pointerId: 7, pointerType: 'pen' }))`));
    filas.push(await leer('tinta apagada', `await T.prender(false)`));
    for (const f of filas) console.log(`     ${f.titulo}: hojas ${f.hojas} MB · tinta ${f.tinta} · resaltador ${f.resaltador} · viva ${f.viva} (${f.pintadas} pintadas; renderer+GPU ${f.procesoMB} MB)`);
    const [lee, aire, pluma, tres, fuera, apagada] = filas;
    const porHoja = lee.pintadas ? lee.hojas / lee.pintadas : 0;
    ok('leyendo, las hojas sin tinta no reservan ni un bitmap de tinta', lee.tinta + lee.resaltador + lee.viva === 0, JSON.stringify(lee));
    ok('la punta en el aire reserva solo el canvas vivo de una hoja', aire.tinta === 0 && aire.resaltador === 0 && Math.abs(aire.viva - porHoja) < porHoja * 0.1, JSON.stringify(aire));
    const unaHoja = (mb) => Math.abs(mb - porHoja) < porHoja * 0.1;
    ok('con los tres canvas de una hoja, la tinta pesa tres hojas y no tres por cada hoja montada',
      unaHoja(tres.tinta) && unaHoja(tres.resaltador) && unaHoja(tres.viva) && tres.pintadas > 1, JSON.stringify({ tres, porHoja }));
    ok('al irse la punta, el vivo se suelta', fuera.viva === 0 && pluma.tinta > 0, JSON.stringify({ pluma, fuera }));
    ok('y con la tinta apagada queda solo lo que tiene trazos', apagada.viva === 0 && apagada.tinta > 0, JSON.stringify(apagada));
  });

  /* ── 8 · Colores, anillo y el amarillo de la hoja (tinta-24, ux-19, css-23) */
  console.log('\n8. Las pastillas de color y el amarillo');

  await bloque('tinta-24/css-23', async () => {
    const r = await js(`(async () => {
      await T.prender(); await T.herramienta('fibra');
      // El anillo del elegido viaja con su transición: se lee asentado.
      await T.espera(450);
      const { HERRAMIENTAS, COLORES } = await T.mod('tinta/capa');
      const barra = document.getElementById('qr-tintabarra');
      const pastillas = [...barra.querySelectorAll('.qr-color')];
      const on = barra.querySelector('.qr-color.is-on');
      const pinta = (color) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).join(','); };
      const sombra = getComputedStyle(on).boxShadow;
      // El hueco del anillo: el segundo color de la sombra (después del hairline).
      const colores = sombra.match(/(rgba?|oklch)\\([^)]*\\)/g) || [];
      const raiz = getComputedStyle(document.documentElement).getPropertyValue('--qr-resaltador-rgb').trim();
      return {
        tips: pastillas.map((b) => b.dataset.tip),
        cursor: getComputedStyle(pastillas[0]).cursor,
        hueco: colores[1] ? pinta(colores[1]) : null,
        barra: pinta(getComputedStyle(barra).backgroundColor),
        raiz, resaltador: HERRAMIENTAS.resaltador.color, pastillaAmarilla: COLORES.at(-1)?.hex,
        /* Las marcas de la búsqueda siguen a la variable: con otro amarillo en
           una capa, su color cambia. Escrito a mano (241 196 15) no seguía. */
        marca: (() => {
          const capa = document.querySelector('#view .qr-marcas');
          capa.style.setProperty('--qr-resaltador-rgb', '1 2 3');
          const v = getComputedStyle(capa).getPropertyValue('--qr-marca').trim();
          capa.style.removeProperty('--qr-resaltador-rgb');
          return v;
        })(),
      };
    })()`);
    const hex = (r.raiz || '').split(/\s+/).map(Number).map((n) => n.toString(16).padStart(2, '0')).join('');
    ok('las pastillas dicen el nombre del color, no el hexadecimal (ux-19)', JSON.stringify(r.tips) === JSON.stringify(['Negro', 'Rojo', 'Azul', 'Verde', 'Violeta', 'Amarillo']), JSON.stringify(r.tips));
    ok('con el cursor de la casa (tinta-24)', r.cursor === 'default', r.cursor);
    ok('el hueco del anillo es del color de la barra, no un halo negro (tinta-24)', r.hueco && r.hueco === r.barra, JSON.stringify(r));
    ok('el amarillo del resaltador sale de --qr-resaltador-rgb (css-23)', r.resaltador === `#${hex}` && r.pastillaAmarilla === `#${hex}` && /^rgb\(1 2 3 \/ \.?0?\.4/.test(r.marca), JSON.stringify(r));
  });

  /* ── 10 · Deshacer y rehacer seguidos se funden (tinta-13, revisión) ──────── */
  console.log('\n10. Ctrl+Z y Ctrl+Y seguidos: nada aparece de golpe');

  await bloque('tinta-13/seguidos', async () => {
    /* Cuánto se ve cada trazo, cuadro a cuadro: 1 si ya está en la base, y si
       no, la opacidad del calco que lo trae (si el calco tiene tinta en ese
       punto). Se lee con un canvas aparte para no pedirle readback al del
       editor en cada cuadro. Con la tecla sostenida, Windows repite cada
       ~30 ms: cada fundir() nuevo cortaba en seco lo que estaba entrando, y
       la base lo dibujaba entero en ese cuadro. */
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.irA(8); await T.espera(700);
      await T.prender(); await T.herramienta('fibra');
      const filas = [0.2, 0.3, 0.4];
      for (const fy of filas) T.raya(8, 0.2, fy, 0.6, fy);
      await T.espera(250);
      const lupa = document.createElement('canvas'); lupa.width = 1; lupa.height = 1;
      const lx = lupa.getContext('2d', { willReadFrequently: true });
      const hay = (c, fy) => {
        if (!c.width) return false;
        lx.clearRect(0, 0, 1, 1);
        lx.drawImage(c, Math.round(c.width * 0.4), Math.round(c.height * fy), 1, 1, 0, 0, 1, 1);
        return lx.getImageData(0, 0, 1, 1).data[3] > 100;
      };
      const cuanto = (fy) => {
        if (hay(T.capa(8), fy)) return 1;
        let v = 0;
        for (const c of T.pliego(8).querySelectorAll('.qr-tinta-calco')) if (hay(c, fy)) v = Math.max(v, +getComputedStyle(c).opacity);
        return +v.toFixed(3);
      };
      const ev = (k) => T.visor().dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
      T.visor().focus();
      const muestrear = async (teclas) => {
        const serie = []; const t0 = performance.now(); let i = 0;
        while (performance.now() - t0 < 520) {
          const t = performance.now() - t0;
          while (i < teclas.length && t >= teclas[i][1]) ev(teclas[i++][0]);
          serie.push(filas.map(cuanto));
          await T.cuadro();
        }
        return serie;
      };
      // Los tres se van, de a uno cada 30 ms, y vuelven igual.
      const fuera = await muestrear([['z', 0], ['z', 30], ['z', 60]]);
      const quedan = S.tinta.trazos(8).length;
      const vuelta = await muestrear([['y', 0], ['y', 30], ['y', 60]]);
      // Uno que se iba y vuelve a mitad de camino: se da vuelta desde donde estaba.
      const ida = await muestrear([['z', 0], ['y', 70]]);
      return { fuera, quedan, vuelta, ida, final: S.tinta.trazos(8).length, calcos: T.pliego(8).querySelectorAll('.qr-tinta-calco').length };
    })()`);
    // El salto más grande de un cuadro al siguiente, trazo por trazo.
    const salto = (serie) => Math.max(...[0, 1, 2].map((j) => serie.reduce((m, f, i) => (i ? Math.max(m, Math.abs(f[j] - serie[i - 1][j])) : m), 0)));
    const ver = (s) => JSON.stringify(s.map((f) => f.join('/')));
    ok('tres Ctrl+Z seguidos: cada trazo se esfuma, ninguno se corta en seco', r.quedan === 0 && salto(r.fuera) <= 0.4 && r.fuera.at(-1).every((x) => x === 0),
      `salto ${salto(r.fuera).toFixed(2)} · ${ver(r.fuera)}`);
    ok('tres Ctrl+Y seguidos: cada trazo vuelve fundiéndose, ninguno aparece entero de golpe', salto(r.vuelta) <= 0.4 && r.vuelta.at(-1).every((x) => x === 1),
      `salto ${salto(r.vuelta).toFixed(2)} · ${ver(r.vuelta)}`);
    ok('Ctrl+Z y Ctrl+Y a mitad del fundido: el trazo se da vuelta sin saltar', salto(r.ida) <= 0.4 && r.ida.some((f) => f[2] > 0.05 && f[2] < 0.95) && r.ida.at(-1)[2] === 1
      && r.final === 3 && r.calcos === 0, `salto ${salto(r.ida).toFixed(2)} · ${ver(r.ida)} · final ${r.final} · calcos ${r.calcos}`);

    /* Con prefers-reduced-motion (emulado por DevTools) no hay calcos: el
       deshacer redibuja en seco, como lo demás que mira reducido(). */
    let emulado = false;
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      emulado = true;
    } catch (e) { console.log(`  (no se pudo emular prefers-reduced-motion: ${e.message})`); }
    if (emulado) {
      const q = await js(`(async () => {
        const { S } = await T.mod('estado');
        const ev = (k) => T.visor().dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        ev('z');
        const calcos = T.pliego(8).querySelectorAll('.qr-tinta-calco').length;
        const quedan = S.tinta.trazos(8).length;
        ev('y');
        await T.cuadro();
        return { reduce, calcos, quedan, final: S.tinta.trazos(8).length, despues: T.pliego(8).querySelectorAll('.qr-tinta-calco').length };
      })()`);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
      ok('con prefers-reduced-motion, deshacer y rehacer van en seco: sin calcos', q.reduce && q.calcos === 0 && q.despues === 0 && q.quedan === 2 && q.final === 3, JSON.stringify(q));
    }
  });

  /* ── 11 · El resaltador en curso, debajo de la pluma (tinta-07, revisión) ── */
  console.log('\n11. El resaltador en curso se ve como va a quedar');

  await bloque('tinta-07/vivo', async () => {
    /* Un trazo rojo de fibra y un resaltador que lo cruza. Se fotografía el
       cruce con la punta todavía apoyada y después de levantarla: tiene que
       ser el mismo color. Con el vivo arriba de todo, el amarillo se
       multiplicaba ENCIMA del rojo (el azul del rojo caía casi a cero) y al
       confirmar quedaba el rojo puro: medido, (188, 52, 29) contra (192, 57, 43),
       14 de diferencia en el azul. */
    const zona = await js(`(async () => {
      await T.irA(10); await T.espera(700);
      await T.prender(); await T.herramienta('fibra');
      document.querySelector('.qr-color[data-tip="Rojo"]')?.click();
      await T.espera(80);
      // En el margen derecho, lejos de las letras del cobayo.
      T.raya(10, 0.8, 0.5, 0.96, 0.5);
      await T.herramienta('resaltador');
      const c = T.capa(10);
      T.tirar(c, 'pointerdown', 0.88, 0.42);
      for (let i = 1; i <= 8; i++) T.tirar(c, 'pointermove', 0.88, 0.42 + i * 0.02);
      await T.espera(250);
      const p = T.pliego(10).getBoundingClientRect();
      return { x: Math.round(p.left + p.width * 0.88) - 6, y: Math.round(p.top + p.height * 0.5) - 6, vivo: T.capa(10, 'qr-tinta-viva').dataset.herramienta };
    })()`);
    /* El trazo de fibra mide pocos píxeles: se compara el píxel más rojo de
       la foto de después (el centro del trazo) con ese mismo en la de antes. */
    const rect = { x: zona.x, y: zona.y, width: 12, height: 12 };
    const fotoA = (await win.webContents.capturePage(rect)).toBitmap();
    await js(`(async () => { T.tirar(T.capa(10), 'pointerup', 0.88, 0.58); await T.espera(300); return true; })()`);
    const fotoB = (await win.webContents.capturePage(rect)).toBitmap();
    let k = 0;
    for (let i = 0; i < fotoB.length; i += 4) if (fotoB[i + 2] - fotoB[i + 1] > fotoB[k + 2] - fotoB[k + 1]) k = i;
    const durante = [fotoA[k + 2], fotoA[k + 1], fotoA[k]];
    const despues = [fotoB[k + 2], fotoB[k + 1], fotoB[k]];
    const dif = Math.max(...durante.map((v, i) => Math.abs(v - despues[i])));
    ok('en el cruce con la pluma roja, el color no cambia al levantar el lápiz', zona.vivo === 'resaltador' && despues[0] > 150 && despues[1] < 120 && dif <= 4,
      `durante ${JSON.stringify(durante)} · después ${JSON.stringify(despues)} · dif ${dif} · vivo ${zona.vivo}`);
  });

  /* ── 9 · La tinta vuelve después de girar (tinta-04, revisión) ───────────── */
  console.log('\n9. Girar y volver: la tinta sigue ahí');

  await bloque('tinta-04/giro', async () => {
    /* Un giro que termina en la misma rotación (izquierda y derecha dentro de
       los 200 ms del giro, o cuatro veces del mismo lado) le deja al editor el
       mismo viewport: si terminarGiro vaciaba los bitmaps a mano, nadie los
       rehacía y la tinta no volvía hasta el próximo trazo en esa hoja. */
    const r = await js(`(async () => {
      const { S } = await T.mod('estado');
      await T.prender(false);
      S.tinta.agregar(6, { herramienta: 'fibra', color: '#d01010', ancho: 8, opacidad: 1, puntos: [[100, 500, 1], [450, 520, 1]] });
      await T.irA(6); await T.espera(900);
      const rojos = () => {
        const c = T.capa(6);
        if (!c || !c.width) return { ancho: c?.width ?? -1, rojos: 0 };
        // Se lee una copia: leer varias veces el contexto del editor le gana un aviso de Chromium.
        const copia = document.createElement('canvas');
        copia.width = c.width; copia.height = c.height;
        const cx = copia.getContext('2d', { willReadFrequently: true });
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] > 150 && d[i + 1] < 90) n++;
        return { ancho: c.width, rojos: n };
      };
      const clic = (lado) => document.getElementById('qr-rotar-' + lado).click();
      const asentar = async () => { await T.espera(1300); return { ...rojos(), rotacion: S.rotacion, opacidad: +getComputedStyle(T.capa(6)).opacity }; };
      const antes = rojos();
      clic('izq'); clic('der');
      const idaYVuelta = await asentar();
      for (let i = 0; i < 4; i++) { clic('der'); await T.espera(40); }
      const cuatro = await asentar();
      /* En un giro de verdad, cada cuadro en que la tinta se ve (opacidad > 0)
         su bitmap tiene la forma del pliego: nunca un bitmap viejo estirado
         a la forma girada (lector-07), ahora que terminarGiro no lo vacía. */
      clic('der');
      const deformes = []; const t0 = performance.now();
      while (performance.now() - t0 < 1200) {
        const c = T.capa(6); const p = T.pliego(6).getBoundingClientRect();
        const op = +getComputedStyle(c).opacity;
        if (op > 0 && c.width) {
          const dif = Math.abs(c.width / c.height - p.width / p.height);
          if (dif > 0.02) deformes.push({ t: Math.round(performance.now() - t0), op: +op.toFixed(2), bitmap: c.width + 'x' + c.height, caja: Math.round(p.width) + 'x' + Math.round(p.height) });
        }
        await T.cuadro();
      }
      const girada = { ...(await asentar()), deformes };
      clic('izq');
      const vuelta = await asentar();
      return { antes, idaYVuelta, cuatro, girada, vuelta };
    })()`);
    const hay = (x) => x.ancho > 0 && x.rojos > r.antes.rojos * 0.5;
    ok('antes de girar, la hoja 6 tiene su tinta', r.antes.rojos > 200, JSON.stringify(r.antes));
    ok('izquierda y derecha seguidas: la tinta vuelve con la hoja', hay(r.idaYVuelta) && r.idaYVuelta.rotacion === 0 && r.idaYVuelta.opacidad === 1, JSON.stringify(r.idaYVuelta));
    ok('cuatro giros del mismo lado, lo mismo', hay(r.cuatro) && r.cuatro.rotacion === 0, JSON.stringify(r.cuatro));
    ok('un giro de verdad la rehace girada, sin un cuadro deformado, y la vuelta también', r.girada.ancho > 0 && r.girada.rojos > 200 && r.girada.rotacion === 90 && r.girada.deformes.length === 0 && hay(r.vuelta) && r.vuelta.rotacion === 0,
      JSON.stringify({ girada: r.girada, vuelta: r.vuelta }));
  });

  /* ── Cierre ──────────────────────────────────────────────────────────────── */
  await js(`(async () => {
    const est = await T.mod('estado');
    for (const p of [...est.S.pestanas]) { if (p.tinta) p.tinta.sucia = false; await est.cerrarPestana(p.id); }
  })()`).catch(() => {});
  await esperar(300);

  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores.slice(0, 8)) console.log('   ', e);
  ok('sin errores en la consola', errores.length === 0);

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  if (fail) for (const f of fallas) console.log(`  ! ${f}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Electron todavía lo tiene abierto */ }
  app.exit(fail ? 1 : 0);
}).catch((e) => bail('el arranque', e));
