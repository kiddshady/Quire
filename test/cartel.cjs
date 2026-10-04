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

   Y lo que se pone al día sin relevar (tests-16, shell-30, shell-22):
   · el porcentaje de la descarga CORRE desde lo que se ve, en el mismo nodo;
   · el alto del cartel se desliza cuando el paso nuevo es más alto o más bajo,
     y el que se va queda clavado en su lugar mientras tanto;
   · el aviso de la statusbar se releva adentro y se pliega al irse. Lo que
     pasa por un relevo se lee con lo vivo (`:scope > :not(.ox-swap-out)`):
     el textContent a secas junta lo que se va con lo que llega.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const { vigilarConsola } = require('./consola.cjs');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('cartel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
/* La red de _comun.cjs (tests-07): la misma que esta suite tenía escrita a
   mano, con su timeout de 60 s, ahora en un solo lugar para todas. */
const { abandono } = require('./_comun.cjs');
abandono({ ms: 60000 });

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

  /* ── 5-bis. El porcentaje corre desde lo que se ve (tests-16) ─────────── */
  console.log('\n5-bis. El porcentaje corre, no salta');
  mandar({ progreso: { pct: 0.1, transferido: 9.8e6, total: 98e6, bps: 2e6 } });
  await sleep(700);
  const pPct = js(`(() => {
    const v = document.querySelector('#stat-update > .ox-statusbar__value');
    const sub = document.querySelector('.qr-act__paso:not([data-state="closing"]) .qr-act__sub');
    const fill = document.querySelector('.qr-act__paso:not([data-state="closing"]) .qr-prog__fill');
    window.__pctNodo = v;
    const t0 = performance.now(); const filas = [];
    return new Promise((ok) => {
      const paso = () => {
        filas.push({ stat: parseInt(v.textContent, 10), sub: parseInt(sub.textContent, 10), relleno: fill?.getAnimations().length || 0 });
        if (performance.now() - t0 < 480) setTimeout(paso, 30); else ok(filas);
      };
      paso();
    });
  })()`);
  await sleep(40);
  mandar({ progreso: { pct: 0.6, transferido: 58.8e6, total: 98e6, bps: 2e6 } });
  const pct = await pPct;
  const extras = await js(`(() => ({
    mismo: document.querySelector('#stat-update > .ox-statusbar__value') === window.__pctNodo,
  }))()`);
  extras.relleno = Math.max(...pct.map((f) => f.relleno));
  const statVals = pct.map((f) => f.stat);
  const subVals = pct.map((f) => f.sub);
  console.log('      statusbar ' + statVals.join(' ') + '\n      cartel    ' + subVals.join(' '));
  ok('el % de la statusbar pasa por valores entre 10 y 60', statVals.some((v) => v > 10 && v < 60), statVals.join(' '));
  ok('y termina en 60', statVals.at(-1) === 60, String(statVals.at(-1)));
  ok('en el mismo nodo, sin rehacerlo', extras.mismo);
  ok('el % del cartel también corre', subVals.some((v) => v > 10 && v < 60) && subVals.at(-1) === 60, subVals.join(' '));
  ok('y la barra viaja con su transición', extras.relleno > 0, `${extras.relleno} animaciones`);

  /* ── 5-ter. El alto del cartel se desliza (shell-30) ─────────────────────
     Un error con un mensaje largo es más alto que el mínimo de la caja: antes
     la caja crecía en un cuadro y el modal se recentraba de golpe. Y el paso
     que se va no se corre: queda clavado en su lugar de la caja. */
  console.log('\n5-ter. El alto se desliza y el que se va no se corre');
  /* La foto de ANTES se saca aparte, antes de mandar el estado: si no, el
     primer cuadro muestreado ya puede tener el paso nuevo adentro, y un salto
     que pasó entre ese cuadro y el anterior no se vería. */
  /* Dónde cae el TÍTULO del paso adentro de la caja, sin el transform de su
     salida (sube 6 px a propósito): la caja del paso llena la celda entera,
     así que lo que se correría al crecer la caja es lo de adentro, centrado. */
  await js(`window.__dondeCae = (paso, cuerpo) => {
    const t = paso.querySelector('.qr-act__titulo');
    const cs = getComputedStyle(paso).transform;
    const f = cs === 'none' ? 0 : new DOMMatrixReadOnly(cs).f;
    return Math.round((t.getBoundingClientRect().top - f - cuerpo.getBoundingClientRect().top) * 10) / 10;
  };
  window.__alto0 = () => {
    const cuerpo = document.querySelector('.qr-act__cuerpo');
    const vivo = cuerpo.querySelector('.qr-act__paso:not([data-state="closing"])');
    return { h: Math.round(cuerpo.getBoundingClientRect().height * 10) / 10, top: vivo ? __dondeCae(vivo, cuerpo) : null };
  }; true`);
  await js(`window.__alto = (ms) => new Promise((ok) => {
    const cuerpo = document.querySelector('.qr-act__cuerpo'); const filas = []; const t0 = performance.now();
    const paso = () => {
      const c = cuerpo.getBoundingClientRect();
      const viejo = cuerpo.querySelector('.qr-act__paso[data-state="closing"]');
      filas.push({ t: Math.round(performance.now() - t0), h: Math.round(c.height * 10) / 10,
        viejoTop: viejo ? __dondeCae(viejo, cuerpo) : null });
      if (performance.now() - t0 < ms) requestAnimationFrame(paso); else ok(filas);
    };
    requestAnimationFrame(paso);
  }); true`);
  const largo = 'No se pudo comprobar porque la conexión se cortó a mitad de camino. Revisá que la red ande, '
    + 'que ningún antivirus o proxy esté frenando a Quire, y probá de nuevo en un rato: la búsqueda no cambia nada.';
  const foto0 = await js('__alto0()');
  const pCrece = js(`__alto(500)`);
  mandar({ fase: 'error', error: largo, manual: true, progreso: null });
  const crece = await pCrece;
  const hs = [foto0.h, ...crece.map((f) => f.h)];
  const h0 = hs[0]; const h1 = hs.at(-1);
  const intermedias = hs.filter((h) => h > Math.min(h0, h1) + 1 && h < Math.max(h0, h1) - 1).length;
  // Contra dónde estaba ANTES del cambio, cuando todavía era el paso vivo.
  const tops = [foto0.top, ...crece.map((f) => f.viejoTop).filter((v) => v != null)];
  const corrimiento = Math.max(...tops) - Math.min(...tops);
  console.log(`      alto ${hs.filter((_, i) => i % 2 === 0).join(' ')}\n      el que se va (top en la caja) ${tops.join(' ')}`);
  ok('el error largo es más alto que la caja de antes (si no, no hay nada que medir)', h1 > h0 + 8, `${h0} → ${h1}`);
  ok('el alto viaja: hay medidas intermedias', intermedias >= 2, hs.join(' '));
  ok('el paso que se va no se corre mientras crece la caja', tops.length > 1 && corrimiento <= 1, `${corrimiento} px: ${tops.join(' ')}`);
  await sleep(300);
  const foto1 = await js('__alto0()');
  const pAchica = js(`__alto(500)`);
  mandar({ fase: 'al-dia', error: '', manual: true });
  const achica = await pAchica;
  const hs2 = [foto1.h, ...achica.map((f) => f.h)];
  const intermedias2 = hs2.filter((h) => h > Math.min(hs2[0], hs2.at(-1)) + 1 && h < Math.max(hs2[0], hs2.at(-1)) - 1).length;
  console.log(`      al achicarse ${hs2.filter((_, i) => i % 2 === 0).join(' ')}`);
  ok('y al achicarse también viaja', hs2.at(-1) < hs2[0] - 8 && intermedias2 >= 2, hs2.join(' '));
  mandar({ fase: 'descargando', version: '0.9.2', manual: false, progreso: { pct: 0.6, transferido: 58.8e6, total: 98e6, bps: 2e6 } });
  await sleep(500);

  /* ── 6. El aviso de la statusbar: cambia de aviso sin saltar ──────────── */
  console.log('\n6. El aviso de la statusbar se releva, no salta');
  await js(`import('./js/actualizar.js').then((A) => A.cerrar())`);
  mandar({ fase: 'al-dia', version: null, progreso: null });
  await sleep(600);
  /* Lo VIVO y lo que se va, por separado: durante un relevo el textContent
     del ítem junta las dos frases. La opacidad que se ve es la del ítem (que
     se funde al aparecer y al irse) por la de cada parte. */
  await js(`window.__stat = (ms) => new Promise((ok) => {
    const el = document.getElementById('stat-update'); const filas = []; const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      const opEl = el.hidden ? 0 : +getComputedStyle(el).opacity;
      const vivo = el.querySelector(':scope > .ox-statusbar__value');
      const calco = el.querySelector(':scope > .ox-swap-out');
      // El ancho se mide aunque ya tenga hidden: el plegable sigue plegándose
      // a la vista hasta llegar a 0 (allow-discrete).
      filas.push({ t: Math.round(t), oculto: el.hidden, ancho: Math.round(el.getBoundingClientRect().width * 10) / 10,
        txt: vivo ? vivo.textContent.trim().replace(/\\d+%/, 'N%') : '',
        op: vivo ? Math.round(opEl * +getComputedStyle(vivo).opacity * 100) : 0,
        sale: calco ? calco.textContent.trim().replace(/\\d+%/, 'N%') : '',
        opSale: calco ? Math.round(opEl * +getComputedStyle(calco).opacity * 100) : 0 });
      if (t < ms) requestAnimationFrame(tick); else ok(filas);
    };
    requestAnimationFrame(tick);
  }); true`);
  const pStat = js(`__stat(1700)`);
  mandar({ fase: 'listo', version: '0.9.2', progreso: null });
  await sleep(550);
  mandar({ fase: 'descargando', progreso: { pct: 0.3, transferido: 3e7, total: 98e6, bps: 2e6 } });
  await sleep(550);
  mandar({ fase: 'al-dia', version: null, progreso: null });
  const stat = await pStat;
  console.log('      ' + stat.filter((_, i) => i % 6 === 0).map((f) => `${f.t}ms ${f.oculto ? 'oculto' : `«${f.txt}»:${f.op}${f.sale ? ` «${f.sale}»:${f.opSale}` : ''} ${f.ancho}px`}`).join('\n      '));
  const encimadosStat = stat.filter((f) => f.op > 50 && f.opSale > 50).length;
  ok('nunca dos avisos legibles a la vez', encimadosStat === 0, `${encimadosStat} cuadros`);
  // Cada vez que aparece un texto vivo nuevo, arranca casi invisible.
  const saltos = [];
  for (let k = 1; k < stat.length; k++) {
    const a = stat[k - 1]; const b = stat[k];
    if (b.txt && b.txt !== a.txt && b.op > 40) saltos.push(`${b.t}ms «${a.txt}» → «${b.txt}»:${b.op}`);
    if (!b.txt && a.txt && a.op > 40 && !b.oculto) saltos.push(`${b.t}ms «${a.txt}»:${a.op} → nada`);
  }
  ok('cada aviso nuevo arranca casi invisible', saltos.length === 0, '\n      ' + saltos.join('\n      '));
  const primerNuevoStat = stat.find((f) => f.txt === 'N%' && f.op > 5);
  ok('el nuevo asoma cuando el viejo ya va por menos de la mitad', !primerNuevoStat || primerNuevoStat.opSale <= 50,
    primerNuevoStat ? `viejo en ${primerNuevoStat.opSale}%` : 'no asomó');
  // Al cambiar de aviso, el ancho del ítem viaja (deslizarAncho).
  const tramo = stat.filter((f) => f.t > 560 && f.t < 1000 && !f.oculto).map((f) => f.ancho);
  const wa = tramo[0]; const wb = tramo.at(-1);
  const anchosMedios = tramo.filter((w) => w > Math.min(wa, wb) + 1 && w < Math.max(wa, wb) - 1).length;
  ok('al cambiar de aviso el ancho viaja', Math.abs(wa - wb) < 2 || anchosMedios >= 2, `${wa} → ${wb}: ${tramo.join(' ')}`);
  // Al irse se pliega: el ancho pasa por valores intermedios hasta 0.
  const yendo = stat.filter((f) => f.t > 1080).map((f) => f.ancho);
  ok('al irse se pliega de a poco', yendo.filter((w) => w > 1 && w < Math.max(...yendo) - 1).length >= 2, yendo.join(' '));
  ok('y al final queda escondido', stat.at(-1).oculto);

  /* ── 6-bis. Lo que reaparece dice lo de ahora ─────────────────────────── */
  console.log('\n6-bis. El aviso que reaparece no trae lo de antes');
  {
    /* swap() recuerda el html con el % de cuando se puso, y correr() escribe
       el span por su cuenta. Bajando al 10 %, corre a 60, falla, y se
       reintenta desde 10: swap veía el mismo html y no hacía nada, y el ítem
       se desplegaba diciendo «60%» (auditoría 2F). */
    const pct = () => js(`(() => { const el = document.getElementById('stat-update');
      return { oculto: el.hidden, pct: el.querySelector(':scope > .qr-stat-pct')?.textContent.trim() || '' }; })()`);
    mandar({ fase: 'descargando', version: '0.9.2', manual: false, error: '', progreso: { pct: 0.1, transferido: 9.8e6, total: 98e6, bps: 2e6 } });
    await sleep(500);
    mandar({ progreso: { pct: 0.6, transferido: 58.8e6, total: 98e6, bps: 2e6 } });
    await sleep(700);
    const antesDelError = await pct();
    mandar({ fase: 'error', error: 'Sin conexión', progreso: null });
    await sleep(600);
    mandar({ fase: 'descargando', error: '', progreso: { pct: 0.1, transferido: 9.8e6, total: 98e6, bps: 2e6 } });
    await sleep(80);
    const reaparece = await pct();
    ok('bajando, el número llegó a 60 (si no, no hay nada que medir)', antesDelError.pct === '60%', JSON.stringify(antesDelError));
    ok('al reintentar desde 10 %, el ítem reaparece diciendo 10 %, no lo de antes', !reaparece.oculto && reaparece.pct === '10%', JSON.stringify(reaparece));
    await sleep(500);

    /* Y un aviso que llega mientras el ítem todavía se está plegando no se
       escribe en el lugar a la vista: vuelve a desplegarse con un relevo. */
    mandar({ fase: 'listo', progreso: null });
    await sleep(700);
    mandar({ fase: 'al-dia', version: '0.9.2' });
    await sleep(60);
    mandar({ fase: 'disponible', version: '0.9.3' });
    await sleep(30);
    const enElMedio = await js(`(() => { const el = document.getElementById('stat-update');
      return { oculto: el.hidden, calco: !!el.querySelector(':scope > .ox-swap-out'),
               vivo: el.querySelector(':scope > .ox-statusbar__value')?.textContent.trim() || '' }; })()`);
    ok('un aviso que llega mientras se pliega hace un relevo, no un cambio en el lugar', !enElMedio.oculto && enElMedio.calco && enElMedio.vivo === '0.9.3',
      JSON.stringify(enElMedio));
    await sleep(500);
    await js(`import('./js/actualizar.js').then((A) => A.cerrar())`);   // la versión nueva abrió el cartel
    mandar({ fase: 'al-dia', version: null });
    await sleep(500);
  }

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
