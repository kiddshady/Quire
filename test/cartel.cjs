/* ═══════════════════════════════════════════════════════════════════════════
   El cartel de actualizaciones: cómo se RELEVAN sus pasos.

   El cartel es un solo overlay que muta entre estados (buscando → al día,
   disponible → descargando → lista). Lo que se rompe acá no es qué dice cada
   paso —eso lo mira humo.cjs— sino el cruce: dos textos encimados, un paso
   idéntico que se rehace, uno que entra antes de que el otro se vaya.

   Se le mandan los estados por el mismo canal que usa el proceso principal
   ('update:cambio') y en el mismo orden en que los manda de verdad: al pedir
   una búsqueda, actualizador.cjs primero fija `manual` (con la fase de ANTES)
   y en el mismo tick autoUpdater avisa 'buscando'. Después se muestrea cada
   pocos ms cuántos pasos hay en pantalla y con qué opacidad.

   Lo que exige, que es la regla del relevo de la skill de movimiento:
   · nunca dos pasos legibles a la vez (la suma de opacidades no pasa de ~1,15:
     mientras uno baja el otro sube, pero no se pisan enteros);
   · el que llega espera a que el que se va esté casi borrado;
   · un estado que no cambia lo que se lee no rehace el paso.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const { vigilarConsola } = require('./consola.cjs');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 60s'), 60000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: 1200, height: 800,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  vigilarConsola(win, errores);
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  // Visible (aunque fuera de pantalla): oculta, Chromium congela las animaciones.
  win.showInactive();
  await sleep(2000);

  const js = (c) => win.webContents.executeJavaScript(c);
  const base = { actual: '0.9.1', version: null, manual: false, error: '', progreso: null };
  const mandar = (parche) => { Object.assign(base, parche); win.webContents.send('update:cambio', { ...base }); };

  // El muestreador vive en la página: toma una fila por cuadro mientras dure.
  await js(`window.__muestrear = (ms) => new Promise((ok) => {
    const filas = []; const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      const pasos = [...document.querySelectorAll('.qr-act__paso')].map((p) => ({
        fase: p.dataset.fase,
        op: Math.round(+getComputedStyle(p).opacity * 100),
        sale: p.dataset.state === 'closing',
      }));
      filas.push({ t: Math.round(t), pasos });
      if (t < ms) requestAnimationFrame(tick); else ok(filas);
    };
    requestAnimationFrame(tick);
  }); true`);

  const resumen = (filas) => filas.map((f) => `${String(f.t).padStart(4)} ms  ` +
    (f.pasos.map((p) => `${p.fase}${p.sale ? '↓' : ''}:${p.op}`).join('  ') || '—')).join('\n      ');
  const pico = (filas) => Math.max(...filas.map((f) => f.pasos.reduce((s, p) => s + p.op, 0)));
  // Cuadros con dos pasos legibles a la vez (los dos por encima del 50 %).
  const encimados = (filas) => filas.filter((f) => f.pasos.filter((p) => p.op > 50).length > 1).length;

  /* ── 1. Abrir el cartel en reposo ─────────────────────────────────────── */
  console.log('\n1. Abrir el cartel');
  mandar({ fase: 'inactivo' });
  await sleep(200);
  await js(`import('./js/actualizar.js').then((A) => A.abrir())`);
  await sleep(700);
  ok('el cartel está abierto con un solo paso', (await js(`document.querySelectorAll('.qr-act__paso').length`)) === 1);

  /* ── 2. Buscar a mano: manual (misma fase) + buscando, en el mismo tick ── */
  console.log('\n2. Buscar: el estado repite la fase y enseguida pasa a buscando');
  const pBuscar = js(`__muestrear(600)`);
  mandar({ manual: true });            // fijar({ manual }) — la fase sigue igual
  mandar({ fase: 'buscando' });        // checking-for-update
  const buscar = await pBuscar;
  const fasesVistas = new Set(buscar.flatMap((f) => f.pasos.map((p) => p.fase)));
  const maxPasos = Math.max(...buscar.map((f) => f.pasos.length));
  console.log('      ' + resumen(buscar.filter((_, i) => i % 3 === 0)));
  ok('repetir la fase no rehace el paso (a lo sumo dos a la vez)', maxPasos <= 2, `hubo ${maxPasos}`);
  ok('nunca dos pasos legibles a la vez', encimados(buscar) === 0, `${encimados(buscar)} cuadros`);
  ok('la suma de opacidades no se pasa de un paso', pico(buscar) <= 115, `pico ${pico(buscar)}`);
  ok('termina en buscando', fasesVistas.has('buscando'));

  /* ── 3. La respuesta llega rápido: buscando → al día ──────────────────── */
  console.log('\n3. Buscando → al día (la red contesta enseguida)');
  const pDia = js(`__muestrear(600)`);
  mandar({ fase: 'al-dia' });
  const dia = await pDia;
  console.log('      ' + resumen(dia.filter((_, i) => i % 3 === 0)));
  ok('nunca dos pasos legibles a la vez', encimados(dia) === 0, `${encimados(dia)} cuadros`);
  ok('la suma de opacidades no se pasa de un paso', pico(dia) <= 115, `pico ${pico(dia)}`);
  const primerNuevo = dia.find((f) => f.pasos.some((p) => p.fase === 'al-dia' && p.op > 0));
  const viejoEnEse = primerNuevo?.pasos.find((p) => p.fase === 'buscando');
  ok('el nuevo asoma cuando el viejo ya va por menos de la mitad', !viejoEnEse || viejoEnEse.op <= 50,
    `viejo en ${viejoEnEse?.op}% cuando asoma el nuevo`);
  ok('y al final queda solo el nuevo, entero',
    dia.at(-1).pasos.length === 1 && dia.at(-1).pasos[0].fase === 'al-dia' && dia.at(-1).pasos[0].op === 100,
    JSON.stringify(dia.at(-1).pasos));

  /* ── 4. Dos cambios casi juntos: buscando y al día a 60 ms ────────────── */
  console.log('\n4. Buscar de nuevo y que conteste en 60 ms');
  const pRapido = js(`__muestrear(700)`);
  mandar({ manual: true });
  mandar({ fase: 'buscando' });
  await sleep(60);
  mandar({ fase: 'al-dia' });
  const rapido = await pRapido;
  console.log('      ' + resumen(rapido.filter((_, i) => i % 3 === 0)));
  ok('nunca dos pasos legibles a la vez', encimados(rapido) === 0, `${encimados(rapido)} cuadros`);
  ok('la suma de opacidades no se pasa de un paso', pico(rapido) <= 115, `pico ${pico(rapido)}`);
  ok('y termina solo en al día', rapido.at(-1).pasos.length === 1 && rapido.at(-1).pasos[0].fase === 'al-dia',
    JSON.stringify(rapido.at(-1).pasos));

  /* ── 4-bis. Irse a mitad de la entrada: desde donde está, sin saltar ──── */
  console.log('\n4-bis. Un paso que se va a mitad de su entrada no salta a 100 %');
  mandar({ fase: 'error', error: 'Sin conexión', manual: true });
  await sleep(160);                    // pasó la espera: está entrando, a medias
  const pMedio = js(`__muestrear(400)`);
  mandar({ fase: 'buscando', manual: true });
  const medio = await pMedio;
  console.log('      ' + resumen(medio.filter((_, i) => i % 3 === 0)));
  const serieError = medio.map((f) => f.pasos.find((p) => p.fase === 'error')?.op).filter((x) => x != null);
  const subidas = serieError.slice(1).filter((v, i) => v > serieError[i] + 2).length;
  ok('el que se va nunca sube de opacidad', subidas === 0, serieError.join(' → '));
  ok('nunca dos pasos legibles a la vez', encimados(medio) === 0, `${encimados(medio)} cuadros`);

  /* ── 5. La descarga no rehace el paso con cada avance ─────────────────── */
  console.log('\n5. La descarga avanza sin rehacer el paso');
  mandar({ fase: 'disponible', version: '0.9.2', bytes: 98e6, manual: false });
  await sleep(700);
  mandar({ fase: 'descargando', progreso: { pct: 0.1, transferido: 9.8e6, total: 98e6, bps: 2e6 } });
  await sleep(700);
  const pBaja = js(`__muestrear(400)`);
  for (let i = 2; i <= 6; i++) {
    mandar({ progreso: { pct: i / 10, transferido: i * 9.8e6, total: 98e6, bps: 2e6 } });
    await sleep(50);
  }
  const baja = await pBaja;
  ok('siempre un solo paso mientras baja', baja.every((f) => f.pasos.length === 1), resumen(baja.slice(0, 4)));

  /* ── 6. El aviso de la statusbar: cambia de aviso sin saltar ──────────── */
  console.log('\n6. El aviso de la statusbar se releva, no salta');
  await js(`import('./js/actualizar.js').then((A) => A.cerrar())`);
  await sleep(400);
  await js(`window.__stat = (ms) => new Promise((ok) => {
    const el = document.getElementById('stat-update'); const filas = []; const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      filas.push({ t: Math.round(t), oculto: el.hidden, op: Math.round(+getComputedStyle(el).opacity * 100),
        txt: el.textContent.trim().replace(/\\d+%/, 'N%') });
      if (t < ms) requestAnimationFrame(tick); else ok(filas);
    };
    requestAnimationFrame(tick);
  }); true`);
  const pStat = js(`__stat(1600)`);
  mandar({ fase: 'listo', version: '0.9.2', progreso: null });
  await sleep(500);
  mandar({ fase: 'descargando', progreso: { pct: 0.3, transferido: 3e7, total: 98e6, bps: 2e6 } });
  await sleep(500);
  mandar({ fase: 'al-dia', version: null, progreso: null });
  const stat = await pStat;
  const saltos = [];
  for (let i = 1; i < stat.length; i++) {
    const a = stat[i - 1]; const b = stat[i];
    const cambia = a.txt !== b.txt || a.oculto !== b.oculto;
    // Al cambiar de texto (o esconderse), el de antes ya casi no se veía, y
    // el de después arranca casi invisible. Aparecer desde oculto cuenta igual.
    const antesVisible = a.oculto ? 0 : a.op;
    const despuesVisible = b.oculto ? 0 : b.op;
    if (cambia && (antesVisible > 20 || despuesVisible > 40)) saltos.push(`${a.t}ms «${a.txt}»:${antesVisible} → «${b.txt}»:${despuesVisible}`);
  }
  console.log('      ' + stat.filter((_, i) => i % 6 === 0).map((f) => `${f.t}ms ${f.oculto ? 'oculto' : `«${f.txt}»:${f.op}`}`).join('\n      '));
  ok('cada cambio de aviso pasa por casi invisible', saltos.length === 0, '\n      ' + saltos.join('\n      '));
  ok('y al final queda escondido', stat.at(-1).oculto);

  // Una foto del cartel en reposo, para mirarla si algo falla.
  await js(`import('./js/actualizar.js').then((A) => A.abrir())`);
  await sleep(500);
  const r = await js(`(() => { const r = document.querySelector('.qr-act').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
  fs.writeFileSync(path.join(__dirname, 'cartel.png'), img.toPNG());

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
