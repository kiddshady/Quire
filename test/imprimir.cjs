/* ═══════════════════════════════════════════════════════════════════════════
   La vista de Imprimir: cómo se PONE AL DÍA.

   humo.cjs mira que el preview exista y diga lo correcto. Esto mira lo que
   pasa entre un estado y el otro, que es donde vivían los bugs de la
   auditoría de octubre de 2026 (paquete 2C): el panel que se rehacía entero
   en cada clic, las cápsulas de los segmentados en ancho 0, la hoja que
   pasaba por un papel en blanco al cambiar una opción o al redimensionar,
   el error que dejaba andando la navegación vieja, el modal de rango.

   Todo lo que es movimiento se MIDE: se muestrea cada cuadro en la página
   (sin la latencia del IPC) y se afirma sobre la serie. Lo que pasa por un
   relevo se lee con lo vivo (`:scope > :not(.ox-swap-out)`).

   Las impresoras son de mentira: se reemplazan los handlers de print:listar
   y print:imprimir antes de cargar la ventana. Así la prueba no depende de lo
   que tenga instalado la máquina, y lo que se «imprime» queda anotado (con
   cuántas páginas tenía cada PDF) en vez de salir por una cola de verdad.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { vigilarConsola } = require('./consola.cjs');

const RAIZ = path.join(__dirname, '..');
// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('imprimir');
const PDF = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 220s'), 220000);

/* Dos impresoras: la «de siempre», con el área de la P1102w, y una solo
   blanco y negro con otra área (imprimir-09, imprimir-25). La primera trae
   además un B5 (JIS), que no tiene nombre para SumatraPDF (imprimir-19). */
const AREA_HP = { x: 3.97, y: 3.97, ancho: 203.2, alto: 289 };
const AREA_BN = { x: 10, y: 12, ancho: 190, alto: 270 };
const IMPRESORAS = [
  {
    nombre: 'Prueba Color', etiqueta: 'Prueba Color', predeterminada: true,
    soportaDuplex: true, soloMonocromo: false, maxCopias: 999,
    tamanos: [
      { nombre: 'ISOA4', ancho: 210, alto: 297, imprimible: AREA_HP },
      { nombre: 'ISOA5', ancho: 148, alto: 210, imprimible: null },
      { nombre: 'JISB5', ancho: 182, alto: 257, imprimible: null },
    ],
  },
  {
    nombre: 'Prueba BN', etiqueta: 'Prueba BN', predeterminada: false,
    soportaDuplex: false, soloMonocromo: true, maxCopias: 999,
    tamanos: [{ nombre: 'ISOA4', ancho: 210, alto: 297, imprimible: AREA_BN }],
  },
];

const impresos = [];

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const { PDFDocument } = require('pdf-lib');
  ipcMain.removeHandler('print:listar');
  ipcMain.handle('print:listar', async () => ({ ok: true, data: IMPRESORAS }));
  ipcMain.removeHandler('print:imprimir');
  ipcMain.handle('print:imprimir', async (_e, bytes, opciones) => {
    const doc = await PDFDocument.load(bytes);
    const paginas = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { ancho: Math.round(width), alto: Math.round(height), contenido: p.node.Contents() ? 1 : 0 };
    });
    impresos.push({ opciones, paginasPDF: doc.getPageCount(), paginas });
    return { ok: true, data: { ok: true } };
  });

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: 1400, height: 900,
    show: false, paintWhenInitiallyHidden: true, backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  vigilarConsola(win, errores);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  // Visible (aunque fuera de pantalla): oculta, Chromium congela las animaciones.
  win.showInactive();
  await sleep(1500);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  /* Las teclas, por el sistema de entrada (motion-timing, Verificar §5): un
     KeyboardEvent sintético no pasa por donde pasa una tecla de verdad. */
  const tecla = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };
  /* Lo que dice el preview durante un error (sección 9), para leerlo dos veces. */
  const LEER_ERROR = `() => ({
    error: /No se pudo armar/.test(__vivo(document.getElementById('qr-preview-aviso')) || ''),
    pliegos: document.querySelectorAll('#qr-preview-cuerpo .qr-pliego--preview:not(.qr-pliego--saliente)').length,
    prev: document.getElementById('qr-hoja-prev').disabled, next: document.getElementById('qr-hoja-next').disabled,
    boton: document.getElementById('qr-imprimir').disabled,
    actual: __vivo(document.getElementById('qr-nav-actual')), total: __vivo(document.getElementById('qr-nav-total')),
    papel: __vivo(document.getElementById('qr-res-papel')),
  })`;

  /* ── Las herramientas de la página ──────────────────────────────────────── */
  await js(`(() => {
    const est = import('./js/estado.js');
    const router = import('./js/router.js').then((m) => m.default);
    window.__est = est; window.__router = router;
    window.__dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__cuadro = () => new Promise((r) => requestAnimationFrame(() => r()));
    // Lo vivo de un relevo: sin lo que se está yendo.
    window.__vivo = (el) => el ? [...el.childNodes]
      .filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out')))
      .map((n) => n.textContent).join('').replace(/\\s+/g, ' ').trim() : null;
    // ¿Tiene contenido el canvas? Se achica a 48 px y se cuentan los oscuros.
    const chico = document.createElement('canvas'); chico.width = 48; chico.height = 48;
    const cx = chico.getContext('2d', { willReadFrequently: true });
    window.__tinta = (cv) => {
      if (!cv || cv.width < 2) return 0;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 48, 48);
      cx.drawImage(cv, 0, 0, 48, 48);
      const d = cx.getImageData(0, 0, 48, 48).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) n++;
      return n;
    };
    const op = (el) => +getComputedStyle(el).opacity;
    /* Cuánto contenido se ve en la celda del preview, de 0 a 1: el pliego que
       se va está ENCIMA de los otros. Cada pliego aporta su opacidad por la de
       su canvas, y si el canvas está vacío no aporta contenido. */
    window.__tapado = () => {
      const pls = [...document.querySelectorAll('#qr-preview-cuerpo .qr-pliego--preview')];
      const arriba = pls.filter((p) => p.classList.contains('qr-pliego--saliente'));
      const abajo = pls.filter((p) => !p.classList.contains('qr-pliego--saliente'));
      const aporte = (p) => { const cv = p.querySelector('canvas'); return op(p) * op(cv) * (__tinta(cv) > 5 ? 1 : 0); };
      const deAbajo = Math.max(0, ...abajo.map(aporte));
      return arriba.reduce((t, p) => { const a = aporte(p); return a + (1 - op(p)) * t; }, deAbajo);
    };
    window.__vista = () => document.querySelector('#qr-preview-cuerpo .qr-pliego--preview:not(.qr-pliego--saliente)');
    window.__menu = async (anclaSel, texto) => {
      document.querySelector(anclaSel).click();
      await __dormir(60);
      const it = [...document.querySelectorAll('#ox-layer .ox-menuitem')].find((b) => b.textContent.trim().startsWith(texto));
      if (!it) return false;
      it.click();
      return true;
    };
    window.__pintada = async (ms = 4000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const v = __vista();
        if (v?.classList.contains('is-pintada') && !document.getElementById('qr-preview').classList.contains('is-trabajando')
          && __tinta(v.querySelector('canvas')) > 5) return true;
        await __dormir(30);
      }
      return false;
    };
    return true;
  })()`);

  /* ── 0. Abrir el documento ──────────────────────────────────────────────── */
  await js(`(async () => {
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    await (await __est).abrir(archivo);
    const S = (await __est).S;
    const t0 = performance.now();
    while (S.impresoras.length < 2 && performance.now() - t0 < 4000) await __dormir(50);
  })()`);
  await sleep(600);

  try {
    /* ── 1. Montaje ─────────────────────────────────────────────────────────
       imprimir-12: el pliego en blanco con su tamaño final, la cuenta y el
       resumen salen del cálculo en el MISMO tick en que se monta la vista. */
    console.log('\n1. Montaje');
    const montaje = await js(`(async () => {
      (await __router).go('imprimir');
      const v = __vista();
      const r = v?.getBoundingClientRect();
      const mismoTick = {
        pliego: !!v, ancho: r ? Math.round(r.width) : 0, alto: r ? Math.round(r.height) : 0,
        cifra: __vivo(document.getElementById('qr-res-hojas')),
        total: __vivo(document.getElementById('qr-nav-total')),
      };
      /* El contenido entra con un fundido (imprimir-06): la opacidad del canvas
         pasa por valores intermedios en vez de saltar. Por cuadro. */
      const opacidades = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        const cv = v?.querySelector('canvas');
        if (cv) opacidades.push(Math.round(+getComputedStyle(cv).opacity * 100));
        if (opacidades.at(-1) === 100 && v.classList.contains('is-pintada')) break;
        await __cuadro();
      }
      const pintada = await __pintada();
      await __dormir(300);
      return {
        mismoTick, pintada, opacidades,
        ticked: document.querySelectorAll('#view .ox-ticked').length,
        tipKey: document.getElementById('qr-imprimir')?.dataset.tipKey,
      };
    })()`);
    ok('el pliego en blanco existe en el mismo tick, con su tamaño', montaje.mismoTick.pliego && montaje.mismoTick.ancho > 100 && montaje.mismoTick.alto > 100,
      JSON.stringify(montaje.mismoTick));
    ok('y el resumen y la cuenta ya dicen algo', /4 hojas de papel/.test(montaje.mismoTick.cifra || '') && montaje.mismoTick.total === 'de 4',
      JSON.stringify(montaje.mismoTick));
    ok('la hoja termina pintada, con contenido', montaje.pintada);
    ok('el contenido entra con un fundido, no de golpe', montaje.opacidades.some((o) => o > 5 && o < 95),
      montaje.opacidades.join(' '));
    ok('ningún .ox-ticked al montar', montaje.ticked === 0, `${montaje.ticked}`);
    ok('el botón documenta Ctrl Enter', montaje.tipKey === 'Ctrl Enter', String(montaje.tipKey));
  } catch (e) { ok('la sección 1 no explota', false, e.message); }

  try {
    /* ── 2. Cápsulas de los segmentados ─────────────────────────────────────
       fw-05, imprimir-05, tests-06: con bindSwitcher la cápsula mide la opción
       activa y viaja; a mano medía 0 para siempre. */
    console.log('\n2. Cápsulas');
    const capsulas = await js(`(async () => {
      const medir = (seg) => {
        const cs = getComputedStyle(seg, '::before');
        const w = parseFloat(cs.width) || 0;
        const x = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform).m41 : 0;
        const act = seg.querySelector('.ox-segmented__opt.is-active');
        const rs = seg.getBoundingClientRect(); const ra = act.getBoundingClientRect();
        // El centro de la cápsula (left del ::before + translate) contra el de la opción.
        const left = parseFloat(cs.left) || 0;
        return { w, centro: rs.left + left + x + w / 2, opcion: ra.left + ra.width / 2 };
      };
      const segs = [...document.querySelectorAll('#qr-opciones .ox-segmented[id]')];
      const reposo = segs.map((s) => ({ id: s.id, ...medir(s) }));
      const sub = document.getElementById('op-subconjunto');
      sub.querySelector('[data-value="impares"]').click();
      const serie = [];
      for (let i = 0; i < 8; i++) { await __cuadro(); serie.push(medir(sub)); }
      await __dormir(400);
      const final = medir(sub);
      sub.querySelector('[data-value="todas"]').click();
      await __pintada();
      return { reposo, serie, final };
    })()`);
    for (const c of capsulas.reposo) {
      ok(`${c.id}: la cápsula tiene ancho y cae sobre la opción activa`, c.w > 0 && Math.abs(c.centro - c.opcion) <= 1,
        `ancho ${c.w}, centro ${c.centro.toFixed(1)} contra ${c.opcion.toFixed(1)}`);
    }
    ok('después de un clic, la cápsula nunca mide 0 en los 8 cuadros', capsulas.serie.every((m) => m.w > 0),
      capsulas.serie.map((m) => Math.round(m.w)).join(' '));
    ok('y viaja: pasa por posiciones intermedias', capsulas.serie.some((m) => Math.abs(m.centro - m.opcion) > 1.5),
      capsulas.serie.map((m) => Math.round(m.centro - m.opcion)).join(' '));
    ok('y termina sobre la opción nueva', Math.abs(capsulas.final.centro - capsulas.final.opcion) <= 1,
      `${capsulas.final.centro.toFixed(1)} contra ${capsulas.final.opcion.toFixed(1)}`);
  } catch (e) { ok('la sección 2 no explota', false, e.message); }

  try {
    /* ── 3. El panel no se rehace ────────────────────────────────────────────
       imprimir-04, tests-06: después de cambiar una opción el panel es el MISMO
       nodo y la perilla del switch viaja (tiene una transición corriendo). */
    console.log('\n3. Panel armado una vez');
    const panel = await js(`(async () => {
      const root = document.querySelector('#qr-opciones .qr-op');
      const sw = document.getElementById('op-margen');
      const stepper = document.getElementById('op-copias-stepper');
      sw.click();
      await __cuadro();
      const perilla = document.getAnimations().filter((a) => a.effect?.target === sw && a.effect?.pseudoElement === '::after');
      const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
      const arriba = stepper.querySelector('[data-step="up"]');
      arriba.dispatchEvent(new PointerEvent('pointerdown', o));
      arriba.dispatchEvent(new PointerEvent('pointerup', o));
      await __dormir(80);
      const r = {
        mismoPanel: document.querySelector('#qr-opciones .qr-op') === root,
        mismoSwitch: document.getElementById('op-margen') === sw,
        mismoStepper: document.getElementById('op-copias-stepper') === stepper,
        perillaViaja: perilla.length > 0,
        copias: document.getElementById('op-copias').value,
      };
      // Dejarlo como estaba.
      sw.click();
      const abajo = stepper.querySelector('[data-step="down"]');
      abajo.dispatchEvent(new PointerEvent('pointerdown', o));
      abajo.dispatchEvent(new PointerEvent('pointerup', o));
      await __pintada();
      return r;
    })()`);
    ok('el panel sigue siendo el mismo nodo después de cambiar una opción (root2 === root)', panel.mismoPanel && panel.mismoSwitch);
    ok('el stepper de copias también', panel.mismoStepper && panel.copias === '2', `copias ${panel.copias}`);
    ok('la perilla del switch tiene una transición corriendo', panel.perillaViaja);
  } catch (e) { ok('la sección 3 no explota', false, e.message); }

  try {
    /* ── 4. La hoja no pasa por blanco al cambiar una opción ────────────────
       imprimir-03, css-02, css-03: la hoja nueva se pinta debajo y la vieja se
       esfuma encima. Se muestrea en cada cuadro cuánto contenido se ve: nunca
       puede quedar el papel en blanco. Y la vuelta de is-trabajando es suave. */
    console.log('\n4. Cambiar una opción: el fundido de la hoja');
    const MEDIR_CAMBIO = (disparar) => `(async () => {
      const cuerpo = document.getElementById('qr-preview-cuerpo');
      const filas = [];
      let corre = true;
      (async () => {
        while (corre) {
          filas.push({ t: Math.round(performance.now()), tapado: __tapado(), cuerpo: +getComputedStyle(cuerpo).opacity,
            trabajando: document.getElementById('qr-preview').classList.contains('is-trabajando'),
            pliegos: cuerpo.querySelectorAll('.qr-pliego--preview').length });
          await __cuadro();
        }
      })();
      const antes = __vista();
      ${disparar};
      const pintada = await __pintada(5000);
      await __dormir(500);
      corre = false;
      await __cuadro();
      const t0 = filas[0]?.t || 0;
      // La vuelta del atenuado: desde que se saca is-trabajando.
      const i = filas.findIndex((f, k) => k > 0 && filas[k - 1].trabajando && !f.trabajando);
      const vuelta = i < 0 ? [] : filas.slice(i, i + 14).map((f) => Math.round(f.cuerpo * 100));
      return {
        pintada, otroNodo: __vista() !== antes,
        minimo: Math.min(...filas.map((f) => f.tapado)),
        serie: filas.filter((_, k) => k % 3 === 0).map((f) => (f.t - t0) + ':' + Math.round(f.tapado * 100)).join(' '),
        vuelta,
        maxPliegos: Math.max(...filas.map((f) => f.pliegos)),
        finalPliegos: cuerpo.querySelectorAll('.qr-pliego--preview').length,
      };
    })()`;
    const mismaHoja = await js(MEDIR_CAMBIO(`document.querySelector('#op-subconjunto [data-value="pares"]').click()`));
    console.log('      tapado: ' + mismaHoja.serie);
    console.log('      vuelta del atenuado: ' + mismaHoja.vuelta.join(' '));
    ok('Pares (mismo tamaño): la hoja nueva es otro pliego y termina pintada', mismaHoja.pintada && mismaHoja.otroNodo);
    ok('en ningún cuadro se queda sin contenido (tapado ≥ 0,95)', mismaHoja.minimo >= 0.95, `mínimo ${mismaHoja.minimo.toFixed(3)}`);
    ok('durante el fundido hay dos pliegos, y al final uno', mismaHoja.maxPliegos >= 2 && mismaHoja.finalPliegos === 1,
      `máximo ${mismaHoja.maxPliegos}, final ${mismaHoja.finalPliegos}`);
    ok('el atenuado vuelve a pleno con valores intermedios, no de golpe',
      mismaHoja.vuelta.length > 2 && mismaHoja.vuelta.some((v) => v > 50 && v < 95), mismaHoja.vuelta.join(' '));

    const otraHoja = await js(MEDIR_CAMBIO(`document.querySelector('.qr-modo[data-value="folleto"]').click()`));
    console.log('      tapado: ' + otraHoja.serie);
    ok('Folleto (cambia el tamaño): tampoco pasa por blanco', otraHoja.pintada && otraHoja.minimo >= 0.95,
      `mínimo ${otraHoja.minimo.toFixed(3)}`);
    /* El folleto prendió solo el dúplex (la impresora de prueba lo soporta):
       se vuelve a Simple y a Una cara, como estaba. */
    const prendioDuplex = await js(`document.querySelector('#op-duplex .is-active')?.dataset.value`);
    ok('el folleto prende el dúplex solo (y la cápsula lo sigue)', prendioDuplex === 'largo', String(prendioDuplex));
    await js(MEDIR_CAMBIO(`document.querySelector('.qr-modo[data-value="simple"]').click();
      document.querySelector('#op-duplex [data-value="simplex"]').click();
      document.querySelector('#op-subconjunto [data-value="todas"]').click()`));

    /* El bloque del modo se releva con el alto deslizándose (deslizarAlto). */
    const bloque = await js(`(async () => {
      const b = document.getElementById('op-modo-bloque');
      const h0 = b.getBoundingClientRect().height;
      document.querySelector('.qr-modo[data-value="nup"]').click();
      const altos = [];
      for (let i = 0; i < 16; i++) { await __cuadro(); altos.push(Math.round(b.getBoundingClientRect().height)); }
      await __pintada();
      await __dormir(300);
      document.querySelector('.qr-modo[data-value="simple"]').click();
      /* Al achicarse, primero se va lo de adentro y después se pliega la caja
         (motion-timing §10). Por cuadro: la opacidad del calco de la grilla y
         cuánto de él recorta la caja. Lo que importa es el contenido que se
         VE cortado: la fracción recortada por la opacidad con que se ve. */
      const vuelta = [];
      const recortes = [];
      for (let i = 0; i < 26; i++) {
        await __cuadro();
        const caja = b.getBoundingClientRect().height;
        vuelta.push(Math.round(caja));
        const calco = b.querySelector(':scope > .ox-swap-out');
        if (!calco) continue;
        const alto = calco.getBoundingClientRect().height;
        const op = +getComputedStyle(calco).opacity;
        const cortado = alto > 0 ? Math.max(0, alto - caja) / alto : 0;
        recortes.push({ op: Math.round(op * 100), caja: Math.round(caja), visible: op * cortado });
      }
      await __pintada();
      return { h0, altos, vuelta, recortes, fin: b.getBoundingClientRect().height };
    })()`);
    const intermedios = (s, a, b) => s.filter((h) => h > Math.min(a, b) + 2 && h < Math.max(a, b) - 2).length;
    const altoNup = Math.max(...bloque.altos);
    ok('el bloque del N-up se despliega con el alto viajando', intermedios(bloque.altos, bloque.h0, altoNup) >= 2,
      bloque.altos.join(' '));
    ok('y al volver a Simple se pliega igual, hasta 0', intermedios(bloque.vuelta, altoNup, 0) >= 2 && bloque.fin < 1,
      `${bloque.vuelta.join(' ')} → ${bloque.fin}`);
    const peor = Math.max(0, ...bloque.recortes.map((r) => r.visible));
    console.log('      calco % / caja px: ' + bloque.recortes.map((r) => `${r.op}/${r.caja}`).join(' '));
    ok('al plegarse, la caja no corta la grilla mientras se ve (≤ 3 %)', bloque.recortes.length > 2 && peor <= 0.03,
      `peor ${(peor * 100).toFixed(1)} %`);
  } catch (e) { ok('la sección 4 no explota', false, e.message); }

  try {
    /* ── 5. Redimensionar ───────────────────────────────────────────────────
       imprimir-14: el pliego cambia de tamaño en el acto y el bitmap se estira;
       se repinta a escala después, sobre el mismo canvas. Nunca en blanco. */
    console.log('\n5. Redimensionar');
    await js(`window.__redim = { filas: [], corre: true, antes: __vista() };
      (async () => { while (__redim.corre) { __redim.filas.push({ tapado: __tapado(), mismo: __vista() === __redim.antes }); await __cuadro(); } })(); true`);
    for (const w of [1340, 1280, 1220, 1160, 1220, 1300]) { win.setSize(w, 860); await sleep(40); }
    await sleep(700);
    const redim = await js(`(async () => {
      __redim.corre = false; await __cuadro();
      const v = __vista(); const cv = v.querySelector('canvas');
      const r = v.getBoundingClientRect();
      return { minimo: Math.min(...__redim.filas.map((f) => f.tapado)), siempreElMismo: __redim.filas.every((f) => f.mismo),
        cuadros: __redim.filas.length, bitmap: cv.width, pantalla: Math.round(r.width * devicePixelRatio) };
    })()`);
    win.setSize(1400, 900);
    await sleep(600);
    ok('mientras se redimensiona la hoja nunca queda en blanco', redim.minimo >= 0.95, `mínimo ${redim.minimo.toFixed(3)} en ${redim.cuadros} cuadros`);
    ok('y es siempre el mismo pliego (no se rehace)', redim.siempreElMismo);
    ok('al soltar se repinta a la escala nueva', Math.abs(redim.bitmap - redim.pantalla) <= 3, `bitmap ${redim.bitmap} contra ${redim.pantalla}`);
  } catch (e) { ok('la sección 5 no explota', false, e.message); }

  try {
    /* ── 6. El marco no imprimible ──────────────────────────────────────────
       imprimir-17: el tooltip sale solo sobre la banda. El clip-path recorta
       también el puntero. */
    console.log('\n6. El marco no imprimible');
    const marco = await js(`(async () => {
      await __pintada();
      const v = __vista(); const r = v.getBoundingClientRect();
      const centro = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const banda = document.elementFromPoint(r.left + 2, r.top + r.height / 2);
      return { hay: !!v.querySelector('.qr-noimprimible'),
        centro: centro?.className || '', banda: banda?.className || '' };
    })()`);
    ok('el pliego tiene su marco', marco.hay);
    ok('en el medio de la hoja el puntero no cae en el marco', !/qr-noimprimible/.test(marco.centro), marco.centro);
    ok('sobre la banda sí', /qr-noimprimible/.test(marco.banda), marco.banda);
  } catch (e) { ok('la sección 6 no explota', false, e.message); }

  try {
    /* ── 7. Otra impresora ──────────────────────────────────────────────────
       imprimir-09: el área imprimible es de la impresora y se vuelve a pedir
       al cambiar (acá desde afuera de la vista, como Ajustes). imprimir-25: con
       una solo blanco y negro, el preview va en grises. */
    console.log('\n7. Cambiar de impresora desde afuera');
    const otra = await js(`(async () => {
      const { S, emitir } = await __est;
      const antes = JSON.stringify(S.plan.imprimible);
      S.impresora = 'Prueba BN';
      emitir('impresoras');
      await __dormir(80);
      const pintada = await __pintada(5000);
      const v = __vista();
      const r = { antes, despues: JSON.stringify(S.plan.imprimible), pintada,
        mono: v.classList.contains('is-mono'), filtro: getComputedStyle(v.querySelector('canvas')).filter,
        aviso: !document.getElementById('op-mono').hidden,
        nombre: __vivo(document.getElementById('op-impresora-nombre')) };
      S.impresora = 'Prueba Color';
      emitir('impresoras');
      await __dormir(80);
      await __pintada(5000);
      r.vuelve = !__vista().classList.contains('is-mono');

      /* «Releer impresoras» con la MISMA impresora y capacidades nuevas: no
         cambia el nombre, cambia el área (app.js:384). El plan se quedaba con
         la vieja porque solo miraba el nombre (revisión del 2C). */
      const originales = S.impresoras;
      const otraArea = { x: 15, y: 15, ancho: 180, alto: 267 };
      S.impresoras = originales.map((x) => x.nombre !== 'Prueba Color' ? x : {
        ...x, tamanos: x.tamanos.map((t) => t.nombre === 'ISOA4' ? { ...t, imprimible: otraArea } : t),
      });
      emitir('impresoras');
      await __dormir(80);
      await __pintada(5000);
      r.mismaOtraArea = JSON.stringify(S.plan.imprimible);
      r.esperada = JSON.stringify(otraArea);
      r.nota = __vivo(document.getElementById('op-margen-nota'));
      S.impresoras = originales;
      emitir('impresoras');
      await __dormir(80);
      await __pintada(5000);
      r.vuelveArea = JSON.stringify(S.plan.imprimible);
      return r;
    })()`);
    ok('el plan toma el área de la impresora nueva', otra.despues === JSON.stringify(AREA_BN),
      `${otra.antes} → ${otra.despues}`);
    ok('el selector dice la impresora nueva', otra.nombre === 'Prueba BN', otra.nombre);
    ok('solo blanco y negro: el preview va en grises', otra.mono && /grayscale/.test(otra.filtro), otra.filtro);
    ok('y el aviso de monocromo se despliega', otra.aviso);
    ok('al volver a la de color, deja de estar en grises', otra.vuelve);
    ok('la misma impresora con otra área: el plan toma la nueva', otra.mismaOtraArea === otra.esperada,
      `${otra.mismaOtraArea} (esperaba ${otra.esperada})`);
    ok('y la nota del margen dice la medida nueva', /180 × 267 mm/.test(otra.nota || ''), otra.nota);
    ok('y al volver la de siempre, vuelve su área', otra.vuelveArea === JSON.stringify(AREA_HP), otra.vuelveArea);
  } catch (e) { ok('la sección 7 no explota', false, e.message); }

  try {
    /* ── 8. El rango a mano ─────────────────────────────────────────────────
       imprimir-16, ux-06: el foco va al campo, se valida en vivo, Aplicar se
       apaga si no entra ninguna página y Enter aplica. */
    console.log('\n8. Rango de páginas');
    const rango = await js(`(async () => {
      await __menu('#op-rango', 'Escribir un rango');
      await __dormir(200);
      const input = document.getElementById('op-rango-campo');
      const aplicar = document.querySelector('#ox-layer .ox-modal__foot .ox-btn--primary');
      const foco = document.activeElement === input;
      const escribir = (v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); };
      escribir('50');
      await __dormir(250);
      const vacio = { apagado: aplicar.disabled, cuenta: __vivo(document.getElementById('op-rango-cuenta')) };
      escribir('2-3');
      await __dormir(250);
      const lleno = { apagado: aplicar.disabled, cuenta: __vivo(document.getElementById('op-rango-cuenta')) };
      return { foco, vacio, lleno };
    })()`);
    await tecla('Enter');
    Object.assign(rango, await js(`(async () => {
      await __dormir(400);
      const { S } = await __est;
      const r = { cerrado: !document.querySelector('#ox-layer .ox-modal:not([data-state="closing"])'),
        rango: S.plan.rango, rotulo: __vivo(document.getElementById('op-rango-texto')) };
      await __pintada();
      r.cifra = __vivo(document.getElementById('qr-res-hojas'));
      await __menu('#op-rango', 'Todas las páginas');
      await __pintada();
      return r;
    })()`));
    ok('el modal abre con el foco en el campo', rango.foco);
    ok('un rango sin páginas apaga Aplicar y lo dice', rango.vacio.apagado && /Ninguna/.test(rango.vacio.cuenta || ''), JSON.stringify(rango.vacio));
    ok('uno válido lo prende y cuenta las páginas', !rango.lleno.apagado && /2 páginas/.test(rango.lleno.cuenta || ''), JSON.stringify(rango.lleno));
    ok('Enter aplica y cierra', rango.cerrado && rango.rango === '2-3' && rango.rotulo === '2-3', JSON.stringify(rango));
  } catch (e) { ok('la sección 8 no explota', false, e.message); }

  try {
    /* ── 9. El error invalida el preview ────────────────────────────────────
       imprimir-15: un plan sin páginas no deja la hoja vieja ni la navegación
       andando; una flecha o un resize no la traen de vuelta. */
    console.log('\n9. Error');
    impresos.length = 0;
    /* Un folleto (2 hojas, A4 apaisado) y después «Solo la página 99» sobre
       4: ninguna. La cuenta y la fila Papel no se pueden quedar con lo del
       cálculo anterior (revisión del 2C: decían «1 de 2» y «A4 apaisado»). */
    const error = await js(`(async () => {
      const { S } = await __est;
      document.querySelector('.qr-modo[data-value="folleto"]').click();
      await __pintada(5000);
      await __dormir(300);
      const antes = { papel: __vivo(document.getElementById('qr-res-papel')), total: __vivo(document.getElementById('qr-nav-total')) };
      S.pagina = 99;
      await __menu('#op-rango', 'Solo la página 99');
      await __dormir(500);
      document.activeElement?.blur?.();
      return { antes, recien: (${LEER_ERROR})() };
    })()`);
    // Las teclas y el resize, de verdad: por el sistema de entrada y la ventana.
    await tecla('Right');
    win.setSize(1300, 860); await sleep(250); win.setSize(1400, 900);
    await sleep(600);
    await tecla('Enter', ['control']);
    await sleep(800);
    const error2 = await js(`(async () => {
      const r = { despues: (${LEER_ERROR})(),
        toast: [...document.querySelectorAll('.ox-toast__title')].map((t) => t.textContent).join(' | ') };
      const { S } = await __est;
      S.pagina = 1;
      await __menu('#op-rango', 'Todas las páginas');
      r.vuelve = await __pintada(5000);
      await __dormir(400);
      r.sinError = !__vivo(document.getElementById('qr-preview-aviso'));
      r.cuenta = __vivo(document.getElementById('qr-nav-actual')) + ' ' + __vivo(document.getElementById('qr-nav-total'));
      document.querySelector('.qr-modo[data-value="simple"]').click();
      document.querySelector('#op-duplex [data-value="simplex"]').click();
      await __pintada(5000);
      await __dormir(300);
      return r;
    })()`);
    ok('aparece el error y la hoja se va', error.recien.error && error.recien.pliegos === 0, JSON.stringify(error.recien));
    ok('la navegación y el botón se apagan', error.recien.prev && error.recien.next && error.recien.boton, JSON.stringify(error.recien));
    ok('la cuenta se vacía en vez de seguir diciendo la de antes', error.antes.total === 'de 2' && error.recien.actual === '' && error.recien.total === '',
      JSON.stringify({ antes: error.antes, recien: error.recien }));
    ok('la fila Papel dice el papel del plan, sin la orientación del cálculo viejo',
      error.antes.papel === 'A4 apaisado' && error.recien.papel === 'A4', `${error.antes.papel} → ${error.recien.papel}`);
    ok('una flecha o un resize no traen de vuelta la hoja vieja', error2.despues.pliegos === 0 && error2.despues.error, JSON.stringify(error2.despues));
    ok('Ctrl+Enter con el botón apagado no hace nada (ni imprime ni avisa un error)',
      impresos.length === 0 && !/No se pudo imprimir/.test(error2.toast), `${impresos.length} trabajos, toasts: ${error2.toast}`);
    ok('con un plan válido vuelve la hoja, la cuenta y se va el error', error2.vuelve && error2.sinError && error2.cuenta === '1 de 2',
      JSON.stringify(error2));
  } catch (e) { ok('la sección 9 no explota', false, e.message); }

  try {
    /* ── 10. Resumen ────────────────────────────────────────────────────────
       imprimir-10: la cifra destella si cambian solo sus números y se releva si
       cambian las palabras. */
    console.log('\n10. Resumen');
    const resumen = await js(`(async () => {
      const cifra = document.getElementById('qr-res-hojas');
      const input = document.getElementById('op-copias');
      input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true }));
      await __cuadro();
      const cifras = { tick: cifra.classList.contains('ox-ticked'), calco: !!cifra.querySelector('.ox-swap-out'), texto: __vivo(cifra) };
      await __dormir(300);
      input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true }));
      await __dormir(300);
      await __menu('#op-rango', 'Solo la página');
      await __cuadro();
      const palabras = { calco: !!cifra.querySelector('.ox-swap-out'), texto: __vivo(cifra) };
      await __pintada();
      await __menu('#op-rango', 'Todas las páginas');
      await __pintada();
      return { cifras, palabras };
    })()`);
    ok('4 → 8 hojas: destella en el lugar, sin relevo', resumen.cifras.tick && !resumen.cifras.calco && /8 hojas/.test(resumen.cifras.texto),
      JSON.stringify(resumen.cifras));
    ok('«hojas» → «hoja»: relevo', resumen.palabras.calco && /^1 hoja de papel/.test(resumen.palabras.texto), JSON.stringify(resumen.palabras));
  } catch (e) { ok('la sección 10 no explota', false, e.message); }

  try {
    /* ── 11. Copias ─────────────────────────────────────────────────────────
       imprimir-22, ux-29: lo escrito se acota y se escribe de vuelta. */
    console.log('\n11. Copias');
    const copias = await js(`(async () => {
      const input = document.getElementById('op-copias');
      const poner = async (v) => { input.value = v; input.dispatchEvent(new Event('change', { bubbles: true })); await __dormir(60);
        return { campo: input.value, plan: (await __est).S.plan.copias }; };
      const r = { cero: await poner('0'), mucho: await poner('5000') };
      r.destaca = document.getElementById('qr-res-cifra').classList.contains('is-mucho');
      r.desglose = !document.getElementById('qr-res-detalle').hidden;
      r.vacio = await poner('');
      r.noDestaca = !document.getElementById('qr-res-cifra').classList.contains('is-mucho');
      return r;
    })()`);
    ok('«0» queda en 1, en el campo y en el plan', copias.cero.campo === '1' && copias.cero.plan === 1, JSON.stringify(copias.cero));
    ok('«5000» queda en el máximo (999)', copias.mucho.campo === '999' && copias.mucho.plan === 999, JSON.stringify(copias.mucho));
    ok('vacío vuelve a 1', copias.vacio.campo === '1', JSON.stringify(copias.vacio));
    ok('un trabajo grande se destaca en el resumen (sin pedir confirmación)', copias.destaca && copias.noDestaca, JSON.stringify(copias));
    ok('y con copias dice cuántas hojas son por copia', copias.desglose);
  } catch (e) { ok('la sección 11 no explota', false, e.message); }

  try {
    /* ── 12. Papel sin nombre, escala personalizada, tocar lo elegido ───────
       imprimir-19, imprimir-21, imprimir-24. */
    console.log('\n12. Papel, escala y lo ya elegido');
    const varios = await js(`(async () => {
      const r = {};
      await __menu('#op-papel', 'B5');
      await __dormir(400);
      r.avisoB5 = !document.getElementById('op-papel-aviso').hidden;
      await __pintada();
      await __menu('#op-papel', 'A4');
      await __dormir(400);
      r.avisoA4 = !document.getElementById('op-papel-aviso').hidden;
      await __pintada();

      await __menu('#op-escala', 'Personalizada');
      await __dormir(300);
      const sl = document.getElementById('op-escala-valor');
      sl.value = '150'; sl.dispatchEvent(new Event('input', { bubbles: true })); sl.dispatchEvent(new Event('change', { bubbles: true }));
      await __pintada();
      await __menu('#op-escala', 'Ajustar');
      await __pintada();
      await __menu('#op-escala', 'Personalizada');
      await __dormir(300);
      r.slider = document.getElementById('op-escala-valor').value;
      r.fila = !document.getElementById('op-escala-fila').hidden;
      await __pintada();
      /* imprimir-30, ux-27: el aviso de desborde nombra el switch por su
         nombre, y SOLO si apagarlo lo arregla. Al 150 % y al 200 % el
         contenido se sale del papel mismo: apagar el margen no cambia nada y
         no se lo puede sugerir (revisión del 2C). En Tamaño real, una A4 sobre
         una A4 se sale solo del área imprimible: ahí apagarlo sí lo arregla. */
      const aviso = () => ({ visible: !document.getElementById('qr-res-aviso').hidden,
        texto: __vivo(document.getElementById('qr-res-aviso-texto')) });
      const deslizar = async (v) => {
        const s = document.getElementById('op-escala-valor');
        s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
        await __pintada(); await __dormir(300);
      };
      await __dormir(300);
      r.a150 = aviso();
      await deslizar(200);
      r.a200 = aviso();
      await __menu('#op-escala', 'Tamaño real');
      await __pintada(); await __dormir(300);
      r.realCon = aviso();
      document.getElementById('op-margen').click();
      await __pintada(); await __dormir(300);
      r.realSin = aviso();
      document.getElementById('op-margen').click();
      await __pintada();
      await __menu('#op-escala', 'Solo reducir');
      await __pintada();
      await __dormir(300);

      /* Lo ya elegido, por el camino de cambiar(): el mismo papel y la misma
         escala desde sus menús (los guardas de bindSwitcher y de .qr-modo
         son otra cosa). Se mira unos cuadros, no uno solo. */
      await __menu('#op-papel', 'A4');
      await __menu('#op-escala', 'Solo reducir');
      r.trabajando = false;
      for (let i = 0; i < 6; i++) {
        await __cuadro();
        if (document.getElementById('qr-preview').classList.contains('is-trabajando')) r.trabajando = true;
      }
      return r;
    })()`);
    ok('un papel que no se puede pedir por nombre lo avisa', varios.avisoB5 && !varios.avisoA4, JSON.stringify(varios));
    ok('volver a Personalizada conserva el valor del slider', varios.slider === '150' && varios.fila, `slider ${varios.slider}`);
    ok('elegir otra vez el mismo papel o la misma escala no re-impone', !varios.trabajando);
    ok('al 150 % y al 200 % avisa sin pedir que se apague el margen (no lo arreglaría)',
      varios.a150?.visible && varios.a200?.visible && !/Respetar/.test(varios.a150.texto + varios.a200.texto) && /Ajustar/.test(varios.a200.texto),
      JSON.stringify([varios.a150, varios.a200]));
    ok('en Tamaño real sí nombra «Respetar el área imprimible»',
      varios.realCon?.visible && /apagá Respetar el área imprimible/.test(varios.realCon.texto), JSON.stringify(varios.realCon));
    ok('y apagarlo efectivamente se lleva el aviso', varios.realSin && !varios.realSin.visible, JSON.stringify(varios.realSin));
  } catch (e) { ok('la sección 12 no explota', false, e.message); }

  try {
    /* ── 13. Navegar más allá de la ventana ─────────────────────────────────
       imprimir-13: con 28 hojas, Fin lleva a la 28 (antes la flecha se apagaba
       en la 24) y Inicio vuelve a la 1. */
    console.log('\n13. Navegar todas las hojas');
    await js(`(async () => {
      await __menu('#op-rango', 'Escribir un rango');
      await __dormir(200);
      const input = document.getElementById('op-rango-campo');
      input.value = '1-4, 1-4, 1-4, 1-4, 1-4, 1-4, 1-4';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await tecla('Enter');
    /* Lo que se ve en la hoja, no solo la cuenta: una huella de 16 × 16 del
       canvas. La hoja 28 es la página CUATRO, igual que la 4, y distinta de
       la 1 (UNO). */
    const huella = `(() => {
      const cv = __vista()?.querySelector('canvas');
      const c = document.createElement('canvas'); c.width = 16; c.height = 16;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16);
      if (cv) x.drawImage(cv, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data;
      const h = [];
      for (let i = 0; i < d.length; i += 4) h.push(d[i] + d[i + 1] + d[i + 2]);
      return h;
    })()`;
    const leerNav = `(async () => { await __dormir(100); const pintada = await __pintada(6000); await __dormir(300);
      return { actual: __vivo(document.getElementById('qr-nav-actual')), total: __vivo(document.getElementById('qr-nav-total')),
        next: document.getElementById('qr-hoja-next').disabled, pintada, huella: ${huella} }; })()`;
    const h1 = await js(`(async () => { await __dormir(300); await __pintada(6000); document.activeElement?.blur?.(); await __dormir(200);
      return ${huella}; })()`);
    await tecla('Right'); await tecla('Right'); await tecla('Right');
    const en4 = await js(leerNav);
    await tecla('End');
    const fin = await js(leerNav);
    await tecla('PageUp');
    const anterior = (await js(leerNav)).actual;
    await tecla('Home');
    const inicio = (await js(leerNav)).actual;
    await js(`(async () => { await __menu('#op-rango', 'Todas las páginas'); await __pintada(); return true; })()`);
    const distancia = (a, b) => a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0);
    const navegar = { fin, anterior, inicio, a4: distancia(fin.huella, en4.huella), a1: distancia(fin.huella, h1) };
    delete navegar.fin.huella;
    console.log(`      huella de la 28: a la 4 ${navegar.a4}, a la 1 ${navegar.a1} (la 4 decía ${en4.actual})`);
    ok('Fin llega a la hoja 28 de 28', navegar.fin.actual === '28' && navegar.fin.total === 'de 28' && navegar.fin.pintada,
      JSON.stringify(navegar.fin));
    ok('y ahí se apaga la flecha siguiente', navegar.fin.next);
    ok('y lo que se ve es la hoja 28 (la página CUATRO, como la 4 y no como la 1)',
      en4.actual === '4' && navegar.a4 * 4 < navegar.a1, `a la 4: ${navegar.a4}, a la 1: ${navegar.a1}`);
    ok('RePág vuelve una, Inicio a la primera', navegar.anterior === '27' && navegar.inicio === '1', `${navegar.anterior} ${navegar.inicio}`);
  } catch (e) { ok('la sección 13 no explota', false, e.message); }

  try {
    /* ── 14. Imprimir ───────────────────────────────────────────────────────
       imprimir-31: estando en Imprimir, Ctrl+Enter imprime (Ctrl+P no).
       imprimir-02: el dúplex asistido con cinco caras manda los dorsos con
       una hoja en blanco adelante. imprimir-23: el botón dice en qué paso está
       y las hojas del cartel van por las copias. main-06: viaja `paginas`. */
    console.log('\n14. Imprimir');
    impresos.length = 0;
    await js(`document.activeElement?.blur?.(); true`);
    await tecla('P', ['control']);
    await sleep(600);
    const conCtrlP = impresos.length;
    await js(`(async () => { await __pintada(5000); document.activeElement?.blur?.(); return true; })()`);
    await tecla('Enter', ['control']);
    for (let i = 0; i < 40 && !impresos.length; i++) await sleep(100);
    await sleep(500);
    ok('Ctrl+P en Imprimir no manda nada', conCtrlP === 0, `${conCtrlP}`);
    ok('Ctrl+Enter imprime', impresos.length === 1, `${impresos.length} trabajos`);
    ok('con las páginas del trabajo, para el tiempo del ayudante', impresos[0]?.opciones?.paginas === 4,
      JSON.stringify(impresos[0]?.opciones));

    impresos.length = 0;
    const asistido = await js(`(async () => {
      await __menu('#op-rango', 'Escribir un rango');
      await __dormir(200);
      const input = document.getElementById('op-rango-campo');
      input.value = '1-4, 1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await __dormir(300);
      document.querySelector('#op-duplex [data-value="largo"]').click();
      await __pintada(6000);
      // Cada rótulo que pasa, aunque dure menos de un cuadro (la cola es de mentira).
      const rotulos = new Set();
      const rot = document.getElementById('qr-imprimir-rotulo');
      const mo = new MutationObserver(() => rotulos.add(__vivo(rot)));
      mo.observe(rot, { childList: true });
      document.getElementById('qr-imprimir').click();
      let modal = null;
      for (let i = 0; i < 80 && !modal; i++) { await __dormir(50); modal = document.querySelector('#ox-layer .ox-modal'); }
      await __dormir(200);
      const sub = modal?.querySelector('.ox-modal__sub')?.textContent || '';
      const primaria = modal?.querySelector('.ox-modal__foot .ox-btn--primary');
      primaria?.click();
      await __dormir(1500);
      mo.disconnect();
      return { sub, rotulos: [...rotulos] };
    })()`);
    const [frentes, dorsos] = impresos;
    ok('el asistido manda dos pasadas', impresos.length === 2, `${impresos.length}`);
    ok('frentes: 3 páginas', frentes?.paginasPDF === 3 && frentes?.opciones?.etiqueta === 'frentes', JSON.stringify(frentes && { n: frentes.paginasPDF, e: frentes.opciones.etiqueta }));
    ok('dorsos: 3 páginas, la primera en blanco y del tamaño del pliego',
      dorsos?.paginasPDF === 3 && dorsos.paginas[0].contenido === 0 && dorsos.paginas[0].ancho === dorsos.paginas[1].ancho,
      JSON.stringify(dorsos?.paginas));
    ok('el cartel dice las hojas que salieron', /Salieron 3 hojas/.test(asistido.sub), asistido.sub);
    ok('el botón dijo en qué paso estaba', ['Imprimiendo los frentes…', 'Esperando el fajo', 'Imprimiendo los dorsos…'].every((t) => asistido.rotulos.includes(t)),
      JSON.stringify(asistido.rotulos));
    ok('y vuelve a «Imprimir»', (await js(`__vivo(document.getElementById('qr-imprimir-rotulo'))`)) === 'Imprimir');
  } catch (e) { ok('la sección 14 no explota', false, e.message); }

  try {
    /* ── 15. Salir de la vista ──────────────────────────────────────────────
       Lo que encontró la revisión del 2C:
       · la caché del original iba por los bytes del documento, que viven lo
         que la pestaña: salir de Imprimir no la soltaba. Ahora se reusa entre
         toques de opciones y se suelta al irse;
       · con una imposición en vuelo y otra pendiente, salir no cortaba la
         cola: la pendiente se largaba igual, imponía el documento entero y
         dejaba abierto un PDF de pdf.js sin vista.
       Se espía pdf-lib (la misma instancia de módulo que usa el motor): load
       cuenta las cargas del original, create las imposiciones, y create se
       hace lento para tener una en vuelo a propósito. */
    console.log('\n15. Salir de la vista');
    const salir = await js(`(async () => {
      const { PDFDocument } = await import('./vendor/pdf-lib/pdf-lib.mjs');
      const router = await __router;
      const cargar = PDFDocument.load; const crear = PDFDocument.create;
      let cargas = 0; let creadas = 0; let lento = false;
      PDFDocument.load = function (...a) { cargas++; return cargar.apply(this, a); };
      PDFDocument.create = async function (...a) { creadas++; if (lento) await __dormir(700); return crear.apply(this, a); };
      try {
        await __pintada(5000);
        const c0 = cargas;
        document.querySelector('#op-subconjunto [data-value="impares"]').click();
        await __pintada(5000);
        const reusa = cargas - c0;

        lento = true;
        document.querySelector('#op-subconjunto [data-value="todas"]').click();
        await __dormir(400);     // pasaron los 220 ms: esa ya está imponiendo
        document.querySelector('#op-subconjunto [data-value="pares"]').click();
        await __dormir(300);     // y esta pidió su turno
        router.go('lector');
        const alSalir = creadas;
        await __dormir(2000);
        const despues = creadas - alSalir;
        lento = false;

        const c1 = cargas;
        router.go('imprimir');
        const vuelve = await __pintada(6000);
        const recarga = cargas - c1;
        document.querySelector('#op-subconjunto [data-value="todas"]').click();
        await __pintada(5000);
        return { reusa, despues, recarga, vuelve };
      } finally {
        PDFDocument.load = cargar; PDFDocument.create = crear;
      }
    })()`);
    ok('dentro de la vista, el original parseado se reusa entre toques', salir.reusa === 0, JSON.stringify(salir));
    ok('salir con una en vuelo y otra pendiente no larga la pendiente', salir.despues === 0, `${salir.despues} imposiciones después de salir`);
    ok('al volver se vuelve a cargar el original: la caché se soltó al salir', salir.recarga === 1 && salir.vuelve, JSON.stringify(salir));
  } catch (e) { ok('la sección 15 no explota', false, e.message); }

  try {
    /* ── 16. Un PDF con contraseña ──────────────────────────────────────────
       Sus bytes están cifrados y pdf-lib no los descifra: el preview y el
       papel salían en blanco. Lo decidió Fran (paquete 4A): avisar y bloquear,
       sin rasterizar. Se fabrica el estado (conClave en el documento abierto,
       como lo deja el lector tras pedir la contraseña; el camino real lo
       cubre lector.cjs ux-11) y se espía pdf-lib en la misma instancia de
       módulo que usa el motor: ni el montaje, ni cambiar una opción, ni
       Ctrl+Enter, ni llamar a imprimirAhora pueden llegar a cargar o crear un
       PDF. El resumen sí: contar hojas es aritmética, no toca los bytes. */
    console.log('\n16. Un PDF con contraseña');
    const LEER = `() => {
      const boton = document.getElementById('qr-imprimir');
      const aviso = document.getElementById('qr-preview-aviso');
      const r = aviso.getBoundingClientRect();
      return {
        aviso: __vivo(aviso), alto: Math.round(r.height),
        pliegos: document.querySelectorAll('#qr-preview-cuerpo .qr-pliego--preview:not(.qr-pliego--saliente)').length,
        trabajando: document.getElementById('qr-preview').classList.contains('is-trabajando'),
        boton: { apagado: boton.disabled, explica: boton.classList.contains('qr-explica'), tip: boton.dataset.tip || null,
          tecla: boton.dataset.tipKey || null, puntero: getComputedStyle(boton).pointerEvents },
        flechas: [document.getElementById('qr-hoja-prev').disabled, document.getElementById('qr-hoja-next').disabled],
        cuenta: [__vivo(document.getElementById('qr-nav-actual')), __vivo(document.getElementById('qr-nav-total'))],
        chip: document.getElementById('qr-nav-chip').hidden,
        resumen: __vivo(document.getElementById('qr-res-hojas')),
        cargas: window.__cargas?.() ?? null,
      };
    }`;
    const bloqueada = await js(`(async () => {
      const est = await __est; const router = await __router;
      const { PDFDocument } = await import('./vendor/pdf-lib/pdf-lib.mjs');
      const cargar = PDFDocument.load; const crear = PDFDocument.create;
      let cargas = 0;
      PDFDocument.load = function (...a) { cargas++; return cargar.apply(this, a); };
      PDFDocument.create = function (...a) { cargas++; return crear.apply(this, a); };
      window.__cargas = () => cargas;
      window.__soltarPdfLib = () => { PDFDocument.load = cargar; PDFDocument.create = crear; window.__cargas = null; return cargas; };
      router.go('lector');
      await __dormir(500);
      est.S.doc.conClave = true;
      router.go('imprimir');
      /* Al montar, el aviso nace entero debajo del calco del router y lo
         que se funde es el calco (motion-timing §2, el fundido). Antes
         entraba con un relevo: invisible tres cuadros y entero a los
         ~250 ms, con el calco ya ido (revisión del 4A). Por cuadro, desde el
         mismo task del go(): la opacidad del aviso y la del calco. */
      const serie = []; const calco = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 400) {
        const vivo = document.querySelector('#qr-preview-aviso > :not(.ox-swap-out)');
        serie.push(vivo ? Math.round(+getComputedStyle(vivo).opacity * 100) : null);
        const c = document.querySelector('.ox-main--saliente');
        calco.push(c ? Math.round(+getComputedStyle(c).opacity * 100) : null);
        await new Promise((r) => requestAnimationFrame(r));
      }
      await __dormir(600);
      return { ...(${LEER})(), serie, calco };
    })()`);
    /* Con las flechas apagadas, las teclas tampoco mueven la hoja: antes
       ArrowRight y Fin cambiaban la cuenta a «2 de N» sin hoja que mirar. */
    await js(`document.activeElement?.blur?.(); true`);
    await tecla('Right');
    await tecla('End');
    await sleep(400);
    const conFlechas = await js(`(() => {
      // Y la tecla no se agarra: la vista no la usa para nada mientras tanto.
      const e = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return { ...(${LEER})(), comida: e.defaultPrevented };
    })()`);
    const otroModo = await js(`(async () => {
      document.querySelector('.qr-modo[data-value="nup"]').click();
      await __dormir(700);
      return (${LEER})();
    })()`);
    impresos.length = 0;
    await js(`document.activeElement?.blur?.(); true`);
    await tecla('Enter', ['control']);
    await sleep(600);
    const conTecla = impresos.length;
    const directo = await js(`(async () => {
      const m = await import('./js/views/imprimir.js');
      await m.imprimirAhora();
      await __dormir(300);
      return { cargas: __cargas(), toasts: [...document.querySelectorAll('.ox-toast:not([data-state=closing])')].map((t) => t.textContent) };
    })()`);
    /* El tooltip del botón apagado, con el puntero de verdad: un .ox-btn
       deshabilitado no recibía el puntero y nunca decía por qué. */
    const caja = await js(`(() => { const b = document.getElementById('qr-imprimir').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: caja.x, y: caja.y });
    await sleep(700);
    const tip = await js(`document.querySelector('#ox-layer .ox-tooltip:not([data-state=closing])')?.textContent || null`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 450 });
    await sleep(300);
    const vuelta = await js(`(async () => {
      const est = await __est; const router = await __router;
      est.S.doc.conClave = false;
      router.go('lector');
      await __dormir(500);
      router.go('imprimir');
      const pinto = await __pintada(6000);
      const leido = (${LEER})();
      return { pinto, ...leido, cargas: __soltarPdfLib() };
    })()`);

    const b = bloqueada;
    ok('con contraseña, el preview dice qué tiene y qué no se puede', /Este PDF tiene contraseña/.test(b.aviso || '') && /todavía no imprimirlo/.test(b.aviso || '') && b.alto > 20, `${b.aviso} (${b.alto} px)`);
    ok('sin pliego en blanco que prometa una hoja, y sin atenuar', b.pliegos === 0 && !b.trabajando, JSON.stringify({ ...b, serie: undefined }));
    ok('al montar, el aviso está entero desde el primer cuadro', b.serie.length > 5 && b.serie.every((v) => v === 100), b.serie.join(' '));
    ok('lo que se funde es el calco del router', b.calco[0] >= 97 && b.calco.some((v) => v > 3 && v < 97) && b.calco.at(-1) === null, b.calco.join(' '));
    console.log(`       opacidad del aviso por cuadro: ${b.serie.join(' ')}`);
    console.log(`       opacidad del calco por cuadro: ${b.calco.join(' ')}`);
    ok('el botón se apaga y su tooltip dice por qué, sin el atajo', b.boton.apagado && b.boton.explica && /tiene contraseña: Quire todavía no puede imprimirlo/.test(b.boton.tip || '') && !b.boton.tecla && b.boton.puntero === 'auto', JSON.stringify(b.boton));
    ok('sin hojas que mirar, las flechas se apagan', b.flechas.every(Boolean), JSON.stringify(b.flechas));
    ok('ni cuenta ni chip al lado del candado', b.cuenta.every((t) => t === '') && b.chip, JSON.stringify({ cuenta: b.cuenta, chip: b.chip }));
    ok('las teclas tampoco mueven la hoja', conFlechas.cuenta.every((t) => t === '') && conFlechas.chip && !conFlechas.comida, JSON.stringify({ cuenta: conFlechas.cuenta, chip: conFlechas.chip, comida: conFlechas.comida }));
    ok('el resumen sigue contando las hojas', /hoja/.test(b.resumen || ''), b.resumen);
    ok('cambiar el modo pone el resumen al día sin imponer nada', otroModo.cargas === 0 && otroModo.pliegos === 0 && !otroModo.trabajando && /hoja/.test(otroModo.resumen || ''), JSON.stringify(otroModo));
    ok('Ctrl+Enter no manda nada', conTecla === 0, `${conTecla} trabajos`);
    ok('ni llamando a imprimirAhora: nada llegó a pdf-lib ni a la cola', directo.cargas === 0 && impresos.length === 0 && !directo.toasts.some((t) => /No se pudo/.test(t)), JSON.stringify({ ...directo, impresos: impresos.length }));
    ok('pasando el puntero sobre el botón apagado, sale el tooltip con el porqué', /tiene contraseña/.test(tip || ''), String(tip));
    ok('sin la marca, vuelve a imponer, el botón vuelve con su atajo', vuelta.pinto && !vuelta.boton.apagado && !vuelta.boton.explica && vuelta.boton.tecla === 'Ctrl Enter' && vuelta.boton.tip === 'Mandar a la impresora' && vuelta.cargas > 0 && !vuelta.aviso, JSON.stringify(vuelta));
  } catch (e) { ok('la sección 16 no explota', false, e.message); }

  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores) console.log('  ! ' + e);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  win.destroy();
  app.exit(fail || errores.length ? 1 : 0);
});
