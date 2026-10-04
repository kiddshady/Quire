/* ═══════════════════════════════════════════════════════════════════════════
   El chrome: lo que vive fuera de la vista (titlebar, rail, statusbar, el
   botón Abrir), Ajustes, los atajos del shell y el cierre de la app.

   Lo que se rompe acá casi nunca es "falta un nodo": es un cambio de golpe
   sobre algo que ya se ve (un innerHTML en cada aviso, un textContent que
   salta, un pseudo que se apaga en un cuadro) o un atajo que hace de más. Por
   eso cada cosa se mide: los nodos antes y después, la opacidad por cuadro,
   la cápsula en píxeles, cuántas pestañas cerró una tecla sostenida.

   Dos partes:

   · La de siempre, con una ventana propia fuera de pantalla y los módulos de
     la app (como pestanas.cjs). Sin --dev: la vitrina de Piezas no se ve.
     Los canales que tocarían el sistema (el diálogo de abrir, imprimir, la
     lista de impresoras, guardar ajustes cuando hay que hacerlo fallar) se
     reemplazan en el proceso principal: un test no le abre diálogos a Fran
     ni le manda hojas a su impresora.

   · El cierre de la app con cambios sin guardar en Páginas (ux-03), y el
     arranque que reabre la sesión (shell-04). Viven en el main y en boot(),
     así que se prueban con la app DE VERDAD (main.cjs, como cerrar.cjs), en
     un proceso aparte por caso: cerrar es irreversible, y la sesión se lee
     una sola vez al arrancar. Este mismo archivo, con --cierre, --colgado o
     --sesion, es ese proceso.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const ORIGEN = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');
const MODO = ['cierre', 'colgado', 'guardado', 'sesion'].find((m) => process.argv.includes(`--${m}`)) || 'chrome';

/* Datos propios antes de requerir nada de src/ (store.cjs lee QUIRE_DATA al
   cargarse). En los modos del cierre, `--dev` antes de main.cjs: sin eso el
   candado de instancia única mata este proceso si Fran tiene Quire abierta. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `quire-chrome-${MODO}-`));
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });
if (MODO !== 'chrome') {
  process.env.QUIRE_FUERA = '1';
  if (!process.argv.includes('--dev')) process.argv.push('--dev');
}

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { vigilarConsola } = require('./consola.cjs');

const PDFS = ['uno', 'dos', 'tres', 'cuatro', 'cinco'].map((n) => {
  const destino = path.join(TMP, `${n}.pdf`);
  fs.copyFileSync(ORIGEN, destino);
  return destino;
});

/* La sesión que se reabre en --sesion: la activa (tres) primero, como la
   guarda rutasAbiertas(), y en el lugar 1 de la franja. La franja final tiene
   que quedar uno · tres · dos. */
if (MODO === 'sesion') {
  fs.writeFileSync(path.join(process.env.QUIRE_DATA, 'settings.json'), JSON.stringify({
    reabrirUltimo: true, ultimosDocumentos: [PDFS[2], PDFS[0], PDFS[1]], posicionActiva: 1,
  }));
}

let pass = 0;
const problemas = [];
function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(`${que}${detalle ? ` — ${detalle}` : ''}`); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function limpiar() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ya no está */ } }
const bail = (que, e) => { console.log(`ABORTADO ${que}`, e?.stack || e || ''); limpiar(); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 150 s'), 150000);

/* Sin esto, destruir la ventana de la primera parte cierra la app entera
   mientras todavía se esperan los procesos del cierre. */
if (MODO === 'chrome') app.on('window-all-closed', () => {});
if (MODO === 'chrome') app.whenReady().then(chrome);
else if (MODO === 'sesion') sesion();
else cierre();

/* ══ La parte de siempre ═════════════════════════════════════════════════════ */

async function chrome() {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const documentos = require(path.join(RAIZ, 'src', 'documentos.cjs'));

  /* Lo que el test cambia del proceso principal. Cada canal se reemplaza con
     removeHandler + handle: dos handle sobre el mismo canal tiran. */
  const reemplazar = (canal, fn) => {
    ipcMain.removeHandler(canal);
    ipcMain.handle(canal, async (_e, ...args) => {
      try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
    });
  };
  const IMPRESORA = {
    nombre: 'Impresora de prueba', etiqueta: 'Impresora de prueba', predeterminada: true,
    soportaDuplex: false, soloMonocromo: true, maxCopias: 99,
    tamanos: [
      { nombre: 'ISOA4', ancho: 210, alto: 297, imprimible: null },
      { nombre: 'NorthAmericaLetter', ancho: 215.9, alto: 279.4, imprimible: null },
    ],
  };
  const impresos = [];
  const leidas = [];
  const dialogos = [];
  let elegirDevuelve = [];
  let demoraListar = 0;
  let demoraLeer = 0;
  let listadas = 0;
  const instalaciones = [];
  reemplazar('print:listar', async () => { listadas++; await esperar(demoraListar); return [IMPRESORA]; });
  reemplazar('print:imprimir', (_bytes, opciones) => { impresos.push(opciones); return {}; });
  reemplazar('docs:leer', async (ruta, opciones) => { leidas.push(ruta); await esperar(demoraLeer); return documentos.leer(ruta, opciones); });
  reemplazar('docs:elegir', (opciones) => { dialogos.push(opciones); return elegirDevuelve; });
  // «Reiniciar e instalar» de verdad cerraría todo: acá solo se anota.
  reemplazar('update:instalar', () => { instalaciones.push(Date.now()); return true; });

  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 900, backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  const consola = [];
  vigilarConsola(win, consola);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  // Visible aunque fuera de pantalla: oculta, Chromium congela las animaciones.
  win.showInactive();
  await esperar(1600);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  await js(`window.__cuadros = (fn, ms) => new Promise((ok) => {
    const filas = []; const t0 = performance.now();
    const paso = () => { const t = performance.now() - t0; filas.push({ t: Math.round(t), ...fn() }); if (t < ms) requestAnimationFrame(paso); else ok(filas); };
    requestAnimationFrame(paso);
  });
  window.__abrir = (ruta) => window.dispatchEvent(new CustomEvent('quire:abrir-ruta', { detail: { ruta } }));
  window.__toasts = () => [...document.querySelectorAll('.ox-toast:not([data-state="closing"])')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim());
  window.__CONTADORES = '#stat-doc-name, #stat-pagina-value, #stat-medida-value, #stat-impresora-value, #nav-paginas-count, #nav-convertir-count';
  true`);
  const tecla = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers.filter((m) => m !== 'isAutoRepeat') });
  };
  const pestanas = () => js(`(async () => (await import('./js/estado.js')).S.pestanas.length)()`);

  /* ── 1. El arranque ─────────────────────────────────────────────────────── */
  console.log('\n1. El arranque');
  {
    const html = fs.readFileSync(path.join(RAIZ, 'renderer', 'index.html'), 'utf8');
    /* Un valor de relleno («—») haría que el primer dato real cuente como un
       cambio y destelle en acento (shell-39, css-27, tests-15). */
    const conRelleno = ['stat-pagina-value', 'stat-medida-value', 'stat-impresora-value', 'nav-paginas-count', 'nav-convertir-count']
      .filter((id) => !new RegExp(`id="${id}"></span>`).test(html));
    ok('los valores del chrome nacen vacíos en el HTML', conRelleno.length === 0, conRelleno.join(', '));
    const n = await js(`(() => ({
      ticked: [...document.querySelectorAll(__CONTADORES)].filter((e) => e.classList.contains('ox-ticked')).map((e) => e.id),
      piezas: (() => { const b = document.getElementById('nav-piezas'); return { hidden: b?.hidden, display: b && getComputedStyle(b).display }; })(),
      marcaTip: document.getElementById('brand')?.dataset.tip ?? null,
      abrir: { tip: document.getElementById('btn-abrir')?.dataset.tip, tecla: document.getElementById('btn-abrir')?.dataset.tipKey },
    }))()`);
    ok('ningún contador del chrome destella al arrancar', n.ticked.length === 0, n.ticked.join(', '));
    /* ux-39: la vitrina del framework no es una función de Quire. */
    ok('Piezas no está en el rail fuera del modo desarrollo', n.piezas.hidden === true && n.piezas.display === 'none', JSON.stringify(n.piezas));
    ok('la marca del titlebar no tiene un tooltip que repite el nombre', n.marcaTip === null, String(n.marcaTip));
    ok('Abrir dice su atajo en el tooltip', n.abrir.tip && n.abrir.tecla === 'Ctrl O', JSON.stringify(n.abrir));
  }

  /* ── 2. El primer documento ─────────────────────────────────────────────── */
  console.log('\n2. El primer documento');
  await js(`__abrir(${JSON.stringify(PDFS[0])})`);
  await esperar(1400);
  {
    const n = await js(`(() => {
      const ctx = document.getElementById('titlebar-context');
      return {
        ticked: [...document.querySelectorAll(__CONTADORES)].filter((e) => e.classList.contains('ox-ticked')).map((e) => e.id),
        ctx: ctx.textContent.trim(),
        nombre: document.querySelector('#stat-doc-name > :not(.ox-swap-out)')?.textContent.trim() || document.getElementById('stat-doc-name').textContent.trim(),
        cuenta: document.getElementById('nav-paginas-count').textContent.trim(),
        impresora: document.getElementById('stat-impresora-value').textContent.trim(),
      };
    })()`);
    ok('ningún contador destella al abrir el primer documento', n.ticked.length === 0, n.ticked.join(', '));
    ok('el titlebar dice el nombre', n.ctx === 'uno.pdf', n.ctx);
    ok('la statusbar también', n.nombre === 'uno.pdf', n.nombre);
    ok('y el rail cuenta las páginas', n.cuenta === '4', n.cuenta);
    ok('la impresora de la statusbar es la elegida', n.impresora === IMPRESORA.nombre, n.impresora);

    /* Un aviso que no cambia lo que se lee (un trazo de tinta) no reemplaza
       nodos: el contexto era un innerHTML en cada aviso (shell-26, fw-09). */
    const mismo = await js(`(async () => {
      const est = await import('./js/estado.js');
      const ctx = document.getElementById('titlebar-context');
      const antes = [...ctx.childNodes];
      const cuenta = [...document.getElementById('nav-paginas-count').childNodes];
      est.emitir('tinta'); est.emitir('todo');
      await new Promise((r) => setTimeout(r, 50));
      const ahora = [...ctx.childNodes];
      const cuentaAhora = [...document.getElementById('nav-paginas-count').childNodes];
      return {
        ctx: antes.length > 0 && antes.length === ahora.length && antes.every((n, i) => n === ahora[i]),
        cuenta: cuenta.length === cuentaAhora.length && cuenta.every((n, i) => n === cuentaAhora[i]),
      };
    })()`);
    ok('un aviso de tinta no reemplaza los nodos del contexto del titlebar', mismo.ctx);
    ok('ni los del contador del rail', mismo.cuenta);
  }

  /* ── 3. «Abriendo…» ─────────────────────────────────────────────────────── */
  console.log('\n3. Mientras se abre un documento');
  {
    // Se fabrica el estado: un documento abriéndose, con el contador de estado.js.
    const n = await js(`(async () => {
      const est = await import('./js/estado.js');
      const btn = document.getElementById('btn-abrir');
      // Lo vivo, con los textos sueltos: el botón nace con un nodo de texto (« Abrir»).
      const vivo = () => [...btn.childNodes].filter((c) => !(c.nodeType === 1 && c.classList.contains('ox-swap-out'))).map((c) => c.textContent.trim()).join('').trim();
      est.S.cargando += 1; est.emitir('cargando');
      await new Promise((r) => setTimeout(r, 60));
      const temprano = vivo();
      const serie = await __cuadros(() => ({ calco: !!btn.querySelector(':scope > .ox-swap-out'), txt: vivo() }), 400);
      const ocupado = { txt: vivo(), spinMas: !!document.querySelector('#qr-tab-mas > svg circle + circle'), busy: btn.getAttribute('aria-busy') };
      est.S.cargando -= 1; est.emitir('cargando');
      await new Promise((r) => setTimeout(r, 450));
      return { temprano, serie, ocupado, despues: vivo() };
    })()`);
    ok('un instante no alcanza para cambiar el botón (sin parpadeo en aperturas rápidas)', /Abrir/.test(n.temprano) && !/Abriendo/.test(n.temprano), n.temprano);
    ok('abriendo, el botón dice «Abriendo…»', /Abriendo/.test(n.ocupado.txt), n.ocupado.txt);
    ok('con un relevo, no un corte (hubo un calco yéndose)', n.serie.some((f) => f.calco));
    ok('y el «+» de la franja muestra el spinner', n.ocupado.spinMas);
    ok('al terminar vuelve a «Abrir»', /Abrir/.test(n.despues) && !/Abriendo/.test(n.despues), n.despues);

    /* Lo de verdad, sin fabricar nada: una tanda de dos con 450 ms de lectura
       cada uno. La lectura (traer el archivo por IPC) es lo que más tarda y
       pasa ANTES de abrir(), donde sube S.cargando: el botón tiene que decir
       «Abriendo…» mientras se lee, y no volver a «Abrir» entre un documento y
       el otro (auditoría 2F). */
    demoraLeer = 450;
    elegirDevuelve = [PDFS[1], PDFS[2]];
    const real = await js(`(async () => {
      const est = await import('./js/estado.js');
      const btn = document.getElementById('btn-abrir');
      const vivo = () => [...btn.childNodes].filter((c) => !(c.nodeType === 1 && c.classList.contains('ox-swap-out'))).map((c) => c.textContent.trim()).join('').trim();
      btn.click();
      return __cuadros(() => ({ ocupado: /Abriendo/.test(vivo()), cargando: est.S.cargando, n: est.S.pestanas.length }), 3200);
    })()`);
    demoraLeer = 0;
    const cambios = real.filter((f, i) => i > 0 && f.ocupado !== real[i - 1].ocupado);
    ok('mientras se LEE el archivo, el botón ya dice «Abriendo…»', real.some((f) => f.ocupado && f.cargando === 0 && f.n === 1),
      real.filter((_, i) => i % 8 === 0).map((f) => `${f.t}:${f.ocupado ? 'A…' : 'A'}/${f.cargando}/${f.n}`).join(' '));
    ok('y en toda la tanda hay un relevo de ida y uno de vuelta, no uno por documento',
      cambios.length === 2 && cambios[0].ocupado && !cambios[1].ocupado,
      cambios.map((f) => `${f.t}ms ${f.ocupado ? '→ Abriendo' : '→ Abrir'}`).join(' · '));
    ok('se abrieron los dos', real.at(-1).n === 3, String(real.at(-1).n));
  }

  /* ── 4. Cambiar de pestaña fuera del lector ─────────────────────────────── */
  console.log('\n4. La statusbar fuera del lector');
  await js(`__abrir(${JSON.stringify(PDFS[1])})`);
  await esperar(1200);
  {
    const n = await js(`(async () => {
      const est = await import('./js/estado.js');
      const router = (await import('./js/router.js')).default;
      est.S.pagina = 3;                              // en la activa (dos.pdf)
      router.go('ajustes');
      await new Promise((r) => setTimeout(r, 500));
      const leer = () => document.getElementById('stat-pagina-value').textContent.trim();
      const enDos = leer();
      est.activar(est.S.pestanas[0].id);              // uno.pdf, en su página 1
      await new Promise((r) => setTimeout(r, 400));
      const enUno = leer();
      est.activar(est.S.pestanas[1].id);
      await new Promise((r) => setTimeout(r, 400));
      return { enDos, enUno, deVuelta: leer(), nombre: document.querySelector('#stat-doc-name > :not(.ox-swap-out)')?.textContent.trim() };
    })()`);
    ok('en Ajustes la statusbar dice la página del documento activo', n.enDos === '3 / 4', n.enDos);
    ok('cambiar de pestaña fuera del lector la pone al día', n.enUno === '1 / 4', n.enUno);
    ok('y volver la devuelve', n.deVuelta === '3 / 4' && n.nombre === 'dos.pdf', `${n.deVuelta} · ${n.nombre}`);
  }

  /* ── 5. Ajustes ─────────────────────────────────────────────────────────── */
  console.log('\n5. Ajustes');
  {
    const n = await js(`(() => {
      const seg = document.getElementById('set-zoom');
      const activa = seg.querySelector('.ox-segmented__opt.is-active');
      const s = getComputedStyle(seg, '::before');
      const r = seg.getBoundingClientRect(); const a = activa.getBoundingClientRect();
      const x = parseFloat(seg.style.getPropertyValue('--seg-x')) || 0;
      return { ancho: parseFloat(s.width), anchoOpcion: a.width, centro: r.left + x + parseFloat(s.width) / 2 - (parseFloat(getComputedStyle(seg).borderLeftWidth) || 0),
               centroOpcion: a.left + a.width / 2 };
    })()`);
    /* shell-16, fw-05: cableado a mano, la cápsula medía 0 y no se veía. */
    ok('la cápsula del segmentado de Ajustes tiene ancho', n.ancho > 0, `${n.ancho} px`);
    ok('y cae sobre la opción elegida', Math.abs(n.ancho - n.anchoOpcion) <= 1 && Math.abs(n.centro - n.centroOpcion) <= 1.5,
      `cápsula ${n.ancho} px en ${n.centro.toFixed(1)}, opción ${n.anchoOpcion} px en ${n.centroOpcion.toFixed(1)}`);

    /* shell-19, ux-35: si guardar falla, el switch vuelve atrás. */
    reemplazar('settings:save', () => { throw new Error('settings.json tomado por otro proceso'); });
    const sw = await js(`(async () => {
      const b = document.getElementById('set-duplex');
      const antes = b.classList.contains('is-on');
      b.click();
      const enSeguida = b.classList.contains('is-on');
      await new Promise((r) => setTimeout(r, 500));
      return { antes, enSeguida, despues: b.classList.contains('is-on') };
    })()`);
    ipcMain.removeHandler('settings:save');
    const store = require(path.join(RAIZ, 'src', 'store.cjs'));
    reemplazar('settings:save', (patch) => store.saveSettings(patch));
    ok('el switch se mueve en el acto', sw.enSeguida !== sw.antes);
    ok('y si no se pudo guardar, vuelve atrás', sw.despues === sw.antes, JSON.stringify(sw));

    /* ux-38: el papel por defecto se elige en Ajustes y queda guardado. */
    await js(`document.getElementById('set-papel')?.click(); true`);
    await esperar(350);
    const papel = await js(`(async () => {
      const item = [...document.querySelectorAll('.ox-menuitem')].find((b) => b.textContent.includes('Carta'));
      item?.click();
      await new Promise((r) => setTimeout(r, 600));
      return { habia: !!item, guardado: (await window.onyx.settings.get()).papelDefecto,
               rotulo: document.querySelector('#set-papel-valor > :not(.ox-swap-out)')?.textContent.trim() || document.getElementById('set-papel-valor')?.textContent.trim() };
    })()`);
    ok('Ajustes deja elegir el papel por defecto', papel.habia && papel.guardado === 'Carta', JSON.stringify(papel));
    ok('y el selector lo dice', papel.rotulo === 'Carta', papel.rotulo);

    /* shell-21: «Releer impresoras» queda ocupado mientras lee, y dos clics
       no lanzan dos lecturas. */
    demoraListar = 700;
    const antesListar = listadas;
    const releer = await js(`(async () => {
      const b = document.getElementById('set-refrescar');
      const vivo = (x) => [...x.childNodes].filter((c) => !(c.nodeType === 1 && c.classList.contains('ox-swap-out'))).map((c) => c.textContent.trim()).join(' ').trim();
      b.click(); b.click();
      await new Promise((r) => setTimeout(r, 150));
      const ocupado = { deshabilitado: b.disabled, txt: vivo(b) };
      await new Promise((r) => setTimeout(r, 1500));
      const nuevo = document.getElementById('set-refrescar');
      return { ocupado, despues: { deshabilitado: nuevo.disabled, txt: vivo(nuevo) } };
    })()`);
    demoraListar = 0;
    ok('mientras lee, «Releer impresoras» queda ocupado', releer.ocupado.deshabilitado && /Leyendo/.test(releer.ocupado.txt), JSON.stringify(releer.ocupado));
    ok('dos clics lanzan una sola lectura', listadas - antesListar === 1, `${listadas - antesListar} lecturas`);
    ok('y al terminar vuelve a estar disponible', !releer.despues.deshabilitado && /Releer/.test(releer.despues.txt), JSON.stringify(releer.despues));

    /* shell-18: la línea del actualizador se releva por fase, y bajando solo
       cambia el número, en su lugar y sin destello. */
    const base = { actual: '0.10.0', version: null, manual: false, error: '', progreso: null };
    const mandar = (parche) => win.webContents.send('update:cambio', { ...base, ...parche });
    mandar({ fase: 'buscando' });
    await esperar(60);
    const relevo = await js(`(() => { const el = document.getElementById('set-update-estado'); return { calco: !!el.querySelector(':scope > .ox-swap-out'), txt: el.textContent }; })()`);
    await esperar(400);
    mandar({ fase: 'descargando', version: '9.9.9', progreso: { pct: 0.1, transferido: 1, total: 10, bps: 0 } });
    await esperar(450);
    await js(`window.__pctAjustes = document.querySelector('#set-update-estado > .qr-pct'); true`);
    mandar({ fase: 'descargando', version: '9.9.9', progreso: { pct: 0.4, transferido: 4, total: 10, bps: 0 } });
    await esperar(120);
    const bajando = await js(`(() => { const el = document.getElementById('set-update-estado'); const n = el.querySelector(':scope > .qr-pct');
      return { mismo: !!n && n === window.__pctAjustes, txt: n?.textContent, destello: el.classList.contains('ox-ticked') }; })()`);
    mandar({ fase: 'al-dia' });
    await esperar(400);
    ok('la línea del actualizador cambia de fase con un relevo', relevo.calco, JSON.stringify(relevo));
    ok('bajando, el porcentaje cambia en el mismo nodo', bajando.mismo && bajando.txt === '40%', JSON.stringify(bajando));
    ok('y sin destellar', !bajando.destello);
  }

  /* ── 6. Soltar un archivo ───────────────────────────────────────────────── */
  console.log('\n6. El realce de soltar se apaga de a poco');
  {
    const n = await js(`(async () => {
      const app = document.querySelector('.ox-app');
      document.body.classList.add('qr-soltando');
      await new Promise((r) => setTimeout(r, 350));
      const prendido = +getComputedStyle(app, '::after').opacity;
      document.body.classList.remove('qr-soltando');
      const serie = await __cuadros(() => {
        const cs = getComputedStyle(app, '::after');
        return { op: Math.round(+cs.opacity * 100), existe: cs.content !== 'none' };
      }, 300);
      return { prendido, serie };
    })()`);
    const medias = n.serie.filter((f) => f.existe && f.op > 3 && f.op < 97).length;
    ok('soltando, el velo está prendido', n.prendido > 0.95, String(n.prendido));
    ok('al soltar se apaga pasando por opacidades intermedias', medias >= 2, n.serie.map((f) => (f.existe ? f.op : 'x')).join(' '));
    ok('y termina apagado', n.serie.at(-1).op === 0 || !n.serie.at(-1).existe);
  }

  /* ── 6-bis. El rail, el ícono de maximizar y la vitrina ─────────────────── */
  console.log('\n6-bis. Detalles del shell');
  {
    /* css-25c: con el nav del rail en el fondo, el esfumado de abajo se apaga. */
    const rail = await js(`(() => { const n = document.querySelector('.ox-rail__nav');
      return { fondo: n.classList.contains('is-bottom'), fade: getComputedStyle(n).getPropertyValue('--ox-fade-bottom').trim() }; })()`);
    ok('el rail en el fondo no esfuma abajo', !rail.fondo || rail.fade === '0px', JSON.stringify(rail));

    /* shell-41: el ícono de maximizar se releva. */
    win.webContents.send('win:maximized', true);
    await esperar(40);
    const max = await js(`(() => { const b = document.getElementById('win-max');
      return { calco: !!b.querySelector(':scope > .ox-swap-out'), label: b.getAttribute('aria-label') }; })()`);
    win.webContents.send('win:maximized', false);
    await esperar(400);
    ok('el ícono de maximizar cambia con un relevo', max.calco && max.label === 'Restaurar', JSON.stringify(max));

    /* shell-35: «Repetir entradas» anima con la API y no deja nada en línea. */
    const piezas = await js(`(async () => {
      (await import('./js/router.js')).default.go('piezas');
      await new Promise((r) => setTimeout(r, 700));
      const body = document.getElementById('design-body');
      document.getElementById('replay').click();
      const durante = { anims: body.getAnimations().length, enLinea: body.style.animation };
      await new Promise((r) => setTimeout(r, 700));
      const cs = getComputedStyle(body);
      return { durante, despues: { enLinea: body.style.animation, transform: cs.transform, opacidad: cs.opacity } };
    })()`);
    ok('«Repetir entradas» anima', piezas.durante.anims > 0, JSON.stringify(piezas.durante));
    ok('sin dejar una animación en línea retenida', !piezas.durante.enLinea && !piezas.despues.enLinea
      && piezas.despues.transform === 'none' && piezas.despues.opacidad === '1', JSON.stringify(piezas.despues));
  }

  /* ── 6-ter. Soltar fuera de Combinar, y «no hay impresoras» ─────────────── */
  console.log('\n6-ter. Soltar imágenes en otra vista (ux-13) y el aviso sin impresoras (ux-20)');
  {
    /* ux-13: soltar imágenes en el lector daba «Acá se abren PDFs» y mandaba
       a buscar Combinar a mano. Ahora llevan a Herramientas, sección
       Combinar, con las imágenes ya en la lista (como un .docx lleva a
       Convertir). Un PDF soltado en el lector se sigue abriendo: no va a la
       lista. Por soltarArchivos de app.js, lo que llama el 'drop' de la
       ventana: un File fabricado en la página no tiene ruta en disco. */
    const png = nativeImage.createFromBitmap(Buffer.alloc(8 * 6 * 4, 0xc8), { width: 8, height: 6 }).toPNG();
    const fotos = ['lamina-1.png', 'lamina-2.png'].map((n) => { const r = path.join(TMP, n); fs.writeFileSync(r, png); return r; });
    const r = await js(`(async () => {
      const { soltarArchivos } = await import('./js/app.js');
      const { seccionActual } = await import('./js/views/herramientas.js');
      const est = await import('./js/estado.js');
      const router = (await import('./js/router.js')).default;
      const nombres = () => [...document.querySelectorAll('#qr-cola > .ox-listitem:not([data-state=closing]) .ox-listitem__title')].map((t) => t.textContent.trim());
      document.querySelectorAll('.ox-toast').forEach((t) => t.remove());
      router.go('lector');
      await new Promise((r) => setTimeout(r, 600));
      const pestanas = est.S.pestanas.length;
      await soltarArchivos(${JSON.stringify(fotos.map((ruta) => ({ nombre: path.basename(ruta), ruta })))});
      await new Promise((r) => setTimeout(r, 1200));
      const imagenes = { vista: router.name, seccion: seccionActual(), nombres: nombres(), toasts: __toasts(), pestanas: est.S.pestanas.length - pestanas };

      document.querySelectorAll('.ox-toast').forEach((t) => t.remove());
      router.go('lector');
      await new Promise((r) => setTimeout(r, 600));
      await soltarArchivos([{ nombre: 'uno.pdf', ruta: ${JSON.stringify(PDFS[0])} }]);
      await new Promise((r) => setTimeout(r, 700));
      const pdf = { vista: router.name, activa: est.S.doc?.nombre, toasts: __toasts(), pestanas: est.S.pestanas.length - pestanas };
      return { imagenes, pdf };
    })()`);
    const i = r.imagenes;
    ok('imágenes soltadas en el lector llevan a Herramientas, sección Combinar', i.vista === 'herramientas' && i.seccion === 'combinar', JSON.stringify(i));
    ok('con las imágenes ya en la lista', ['lamina-1.png', 'lamina-2.png'].every((n) => i.nombres.includes(n)), JSON.stringify(i.nombres));
    ok('sin el «Acá se abren PDFs» que mandaba a buscar Combinar', !i.toasts.some((t) => /Acá se abren PDFs|Eso no es un PDF/.test(t)) && i.pestanas === 0, i.toasts.join(' | '));
    ok('un PDF soltado en el lector se sigue abriendo como documento, no va a la lista', r.pdf.vista === 'lector' && r.pdf.activa === 'uno.pdf' && r.pdf.toasts.some((t) => /Ya estaba abierto/.test(t)),
      JSON.stringify(r.pdf));

    /* ux-20: Ajustes e Imprimir dicen lo mismo cuando no hay impresoras, y
       sale de la misma constante (SIN_IMPRESORAS, imprimir.js): eran dos
       copias y ya decían distinto. */
    const textos = await js(`(async () => {
      const est = await import('./js/estado.js');
      const router = (await import('./js/router.js')).default;
      const guardadas = est.S.impresoras;
      const aviso = async (ir, boton) => {
        document.querySelectorAll('.ox-toast').forEach((t) => t.remove());
        router.go(ir);
        await new Promise((r) => setTimeout(r, 700));
        document.getElementById(boton).click();
        await new Promise((r) => setTimeout(r, 300));
        const t = document.querySelector('.ox-toast:not([data-state="closing"])');
        return t ? { titulo: t.querySelector('.ox-toast__title')?.textContent.trim(), texto: t.querySelector('.ox-toast__text, .ox-toast__body, .ox-toast__msg')?.textContent.trim() || t.textContent.trim() } : null;
      };
      try {
        est.S.impresoras = [];
        return { ajustes: await aviso('ajustes', 'set-impresora'), imprimir: await aviso('imprimir', 'op-impresora') };
      } finally {
        est.S.impresoras = guardadas;
        document.querySelectorAll('.ox-toast').forEach((t) => t.remove());
        router.go('lector');
        await new Promise((r) => setTimeout(r, 500));
      }
    })()`);
    ok('sin impresoras, Ajustes e Imprimir dicen lo mismo (ux-20)', textos.ajustes && textos.imprimir
      && textos.ajustes.titulo === textos.imprimir.titulo && textos.ajustes.texto === textos.imprimir.texto && /Releer impresoras/.test(textos.ajustes.texto || ''),
      JSON.stringify(textos));
  }

  /* ── 7. Abrir lo que ya está, y abrir varios ────────────────────────────── */
  console.log('\n7. Abrir lo que ya está abierto, y varios de una vez');
  {
    leidas.length = 0;
    await js(`__abrir(${JSON.stringify(PDFS[0])})`);
    await esperar(600);
    const n = await js(`(async () => ({ toasts: __toasts(), activa: (await import('./js/estado.js')).S.doc.nombre }))()`);
    /* shell-40: no se vuelve a leer del disco, y se dice que ya estaba. */
    ok('reabrir uno abierto no lo vuelve a leer del disco', leidas.length === 0, leidas.join(', '));
    ok('te lleva a su pestaña', n.activa === 'uno.pdf', n.activa);
    ok('y avisa que ya estaba abierto', n.toasts.some((t) => /Ya estaba abierto/.test(t)), n.toasts.join(' | '));

    /* Tres PDF elegidos en el Explorador con Quire abierta: llegan tres
       'docs:abrir' casi juntos, y hay lugar para dos. Corrían en paralelo y
       hayLugar() no los frenaba: se leían los tres, el tercero terminaba en
       «No se pudo abrir el PDF», la franja salía en el orden en que
       terminaron las lecturas y cada uno pasaba por el lector (auditoría 2F).
       La lectura demorada abre la ventana de la carrera. */
    const sinToasts = 'document.querySelectorAll(".ox-toast").forEach((t) => t.remove()); true';
    await js(`(async () => {
      const est = await import('./js/estado.js');
      await est.cerrarPestana(est.S.pestanas.find((p) => p.doc.nombre === 'tres.pdf').id);
      ${sinToasts};
    })()`);
    await esperar(500);
    leidas.length = 0;
    demoraLeer = 200;
    for (const ruta of PDFS.slice(2, 5)) win.webContents.send('docs:abrir', ruta);
    await esperar(2600);
    demoraLeer = 0;
    const r = await js(`(async () => {
      const est = await import('./js/estado.js');
      return { toasts: __toasts(), orden: est.S.pestanas.map((p) => p.doc.nombre), activa: est.S.doc.nombre };
    })()`);
    const nombres = (rs) => rs.map((x) => path.basename(x));
    ok('tres «docs:abrir» juntos con lugar para dos: se leen dos', leidas.length === 2, nombres(leidas).join(', '));
    ok('en el orden en que llegaron', nombres(leidas).join() === 'tres.pdf,cuatro.pdf' && r.orden.join() === 'uno.pdf,dos.pdf,tres.pdf,cuatro.pdf',
      `${nombres(leidas).join(', ')} · franja ${r.orden.join(' · ')}`);
    ok('el que sobra queda afuera con su aviso, no con un error', r.toasts.some((t) => /quedó afuera/.test(t)) && !r.toasts.some((t) => /No se pudo/.test(t)),
      r.toasts.join(' | '));
    ok('y queda a la vista el primero de la tanda', r.activa === 'tres.pdf', r.activa);

    // El diálogo con tres elegidos y lugar para dos: entran dos y se avisa del tercero.
    await js(`(async () => {
      const est = await import('./js/estado.js');
      for (const n of ['tres.pdf', 'cuatro.pdf']) await est.cerrarPestana(est.S.pestanas.find((p) => p.doc.nombre === n).id);
      ${sinToasts};
    })()`);
    await esperar(500);
    dialogos.length = 0;
    elegirDevuelve = PDFS.slice(2, 5);
    await js(`document.getElementById('btn-abrir').click()`);
    await esperar(2200);
    const m = await js(`(async () => ({ toasts: __toasts(), n: (await import('./js/estado.js')).S.pestanas.length }))()`);
    ok('el diálogo se pide para elegir varios', dialogos.length === 1 && dialogos[0]?.varios === true, JSON.stringify(dialogos));
    ok('se abren hasta llenar las pestañas', m.n === 4, String(m.n));
    ok('y un aviso dice cuántos quedaron afuera', m.toasts.some((t) => /quedó afuera/.test(t)), m.toasts.join(' | '));

    /* shell-40, ux-24: con las cuatro ocupadas ni se abre el diálogo. */
    await esperar(300);
    await js(`document.getElementById('btn-abrir').click()`);
    await esperar(500);
    const lleno = await js('__toasts()');
    ok('con cuatro abiertos, Abrir no abre el diálogo', dialogos.length === 1, `${dialogos.length} diálogos`);
    ok('y dice por qué', lleno.some((t) => /Cerrá uno para abrir otro/.test(t)), lleno.join(' | '));
  }

  /* ── 7-bis. Instalar la actualización con cambios en Páginas ────────────── */
  console.log('\n7-bis. «Reiniciar e instalar» con cambios sin guardar en Páginas');
  {
    /* quitAndInstall lanza el instalador ANTES de pedir el cierre: si la
       pregunta llegara recién con el cierre, Cancelar dejaría el instalador
       corriendo. Se pregunta antes de llamar a instalar (auditoría 2F). */
    const modal = () => js(`(() => { const m = document.querySelector('.ox-modal__anim:not([data-state="closing"]) .ox-modal');
      return m ? { sub: m.querySelector('.ox-modal__sub')?.textContent.trim() || '', botones: [...m.querySelectorAll('.ox-modal__foot .ox-btn')].map((b) => b.textContent.trim()) } : null; })()`);
    const boton = (texto) => js(`(() => { const b = [...document.querySelectorAll('.ox-modal__anim:not([data-state="closing"]) .ox-btn')].find((x) => x.textContent.trim() === ${JSON.stringify(texto)}); b?.click(); return !!b; })()`);
    const instalar = () => js(`(async () => {
      const A = await import('./js/actualizar.js');
      A.abrir();
      await new Promise((r) => setTimeout(r, 450));
      const b = document.querySelector('.qr-act [data-accion="instalar"]');
      b?.click();
      return !!b;
    })()`);
    win.webContents.send('update:cambio', { actual: '0.10.0', fase: 'listo', version: '9.9.9', manual: false, error: '', progreso: null });
    await esperar(500);
    await js(`(async () => { (await import('./js/actualizar.js')).cerrar(); const est = await import('./js/estado.js');
      est.S.pestana.organizar = { orden: [2, 3, 4], rotaciones: {} }; return true; })()`);
    await esperar(400);
    const hayBoton = await instalar();
    await esperar(500);
    const m1 = await modal();
    ok('con cambios en Páginas, «Reiniciar e instalar» pregunta antes', hayBoton && m1 && /instalar la actualización/.test(m1.sub), JSON.stringify(m1));
    ok('y todavía no lanzó el instalador', instalaciones.length === 0, `${instalaciones.length}`);
    await boton('Cancelar');
    await esperar(500);
    ok('con Cancelar no se instala nada', instalaciones.length === 0, `${instalaciones.length}`);
    await instalar();
    await esperar(500);
    const m2 = await modal();
    const confirmo = await boton('Instalar sin guardar');
    await esperar(500);
    ok('confirmando, recién ahí se instala', m2 && confirmo && instalaciones.length === 1, `${JSON.stringify(m2)} · ${instalaciones.length}`);
    await js(`(async () => { (await import('./js/estado.js')).S.pestana.organizar = null;
      document.querySelectorAll('.ox-toast').forEach((t) => t.remove()); return true; })()`);
    win.webContents.send('update:cambio', { actual: '0.10.0', fase: 'al-dia', version: null, manual: false, error: '', progreso: null });
    await esperar(400);
  }

  /* ── 8. Ctrl+W sostenido ────────────────────────────────────────────────── */
  console.log('\n8. Ctrl+W sostenido cierra una sola');
  /* Si una versión rota cierra TODAS, el Ctrl+W que sobra (ya sin documento)
     le llega al menú por defecto de Electron y cierra la ventana: eso también
     es una falla, no una excepción que tire el test. */
  const sostenerCtrlW = async (repeticiones) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
    for (let i = 0; i < repeticiones; i++) {
      await esperar(70);       // el ritmo de repetición del teclado
      if (win.isDestroyed()) return;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control', 'isAutoRepeat'] });
    }
    if (!win.isDestroyed()) win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] });
  };
  try {
    win.focus();
    win.webContents.focus();
    await esperar(200);
    const antes = await pestanas();
    await sostenerCtrlW(5);
    await esperar(700);
    const despues = await pestanas();
    ok('mantener Ctrl+W cierra UNA pestaña', despues === antes - 1, `${antes} → ${despues}`);
  } catch (err) {
    ok('mantener Ctrl+W cierra UNA pestaña', false, `la ventana no sobrevivió: ${err.message}`);
  }
  if (win.isDestroyed()) { ok('la ventana sigue viva para lo que falta', false); return terminarChrome(); }

  /* ── 9. Imprimir con el teclado ─────────────────────────────────────────── */
  console.log('\n9. En Imprimir, Ctrl+Enter imprime');
  /* El atajo lo atiende la vista Imprimir (imprimir.js, paquete 2C), que
     confirma antes lo tipeado en Copias; acá ya no hay un segundo oyente que
     imprima con el valor viejo (auditoría 2F). Lo que se prueba es el
     resultado, esté donde esté el oyente. Mientras 2C no esté integrado no
     hay atajo: se reconoce por el tooltip del botón, que pone 2C. */
  {
    await js(`(async () => (await import('./js/router.js')).default.go('imprimir'))()`);
    await esperar(1800);
    const conAtajo = await js(`!!document.querySelector('#qr-imprimir[data-tip-key="Ctrl Enter"]')`);
    impresos.length = 0;
    tecla('P', ['control']);                       // Ctrl+P no imprime: es el que te trae acá
    await esperar(800);
    const conCtrlP = impresos.length;
    ok('estando en Imprimir, Ctrl+P no manda nada', conCtrlP === 0, `${conCtrlP}`);
    if (!conAtajo) {
      console.log('  (salteado: Ctrl+Enter vive en imprimir.js, del paquete 2C, todavía sin integrar)');
    } else {
      tecla('Return', ['control']);
      for (let i = 0; i < 60 && !impresos.length; i++) await esperar(150);
      const conCtrlEnter = impresos.length;
      await esperar(600);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control', 'isAutoRepeat'] });
      await esperar(1500);
      ok('Ctrl+Enter manda a imprimir', conCtrlEnter === 1, `${conCtrlEnter}`);
      ok('a la impresora elegida', impresos[0]?.deviceName === IMPRESORA.nombre, impresos[0]?.deviceName);
      ok('y la tecla sostenida no tira otro trabajo', impresos.length === 1, `${impresos.length}`);
    }
  }

  /* ── 10. De dos pestañas a una con el foco en la franja ─────────────────── */
  console.log('\n10. Cerrar desde la franja hasta quedar una');
  {
    /* La franja con un solo documento se pliega y queda inerte. Si el foco
       estaba en ella, caía al body (ux-18 por otro camino). */
    await js(`(async () => {
      const est = await import('./js/estado.js');
      while (est.S.pestanas.length > 2) await est.cerrarPestana(est.S.pestanas.at(-1).id);
      (await import('./js/router.js')).default.go('lector');
      return true;
    })()`);
    await esperar(900);
    await js(`document.querySelector('#qr-tabs .qr-tab.is-active')?.focus(); true`);
    await esperar(100);
    const enLaFranja = await js(`!!document.activeElement?.closest('#qr-tabs')`);
    tecla('W', ['control']);
    await esperar(700);
    const foco = await js(`(async () => ({ n: (await import('./js/estado.js')).S.pestanas.length,
      tag: document.activeElement?.tagName, id: document.activeElement?.id || '', clase: String(document.activeElement?.className || ''),
      enFranja: !!document.activeElement?.closest('#qr-tabs') }))()`);
    ok('Ctrl+W con el foco en la franja cierra la activa', enLaFranja && foco.n === 1, `${enLaFranja} · ${foco.n}`);
    ok('y el foco no cae al body ni se queda en la franja inerte', foco.tag !== 'BODY' && !foco.enFranja, JSON.stringify(foco));
  }

  /* ── 11. Ctrl+W sostenido sobre el ÚLTIMO documento ─────────────────────── */
  console.log('\n11. Ctrl+W sostenido con un solo documento');
  {
    /* La primera pulsación cierra la pestaña; las repeticiones llegan ya sin
       documento, y sin preventDefault el Ctrl+W del menú por defecto de
       Electron cerraba la VENTANA entera (auditoría 2F). */
    let vivas = null;
    try {
      await sostenerCtrlW(4);
      await esperar(900);
      vivas = await pestanas();
    } catch { /* la ventana se fue */ }
    ok('mantener Ctrl+W sobre el último documento lo cierra y la ventana sigue viva', !win.isDestroyed() && vivas === 0,
      win.isDestroyed() ? 'la ventana se cerró' : `${vivas} pestañas`);
    if (win.isDestroyed()) return terminarChrome();
  }

  return terminarChrome(win, consola);
}

async function terminarChrome(win, consola = []) {
  // La consola, sin lo que el propio test provocó (el guardado que falla a propósito).
  const esperados = /No se pudieron guardar los ajustes|settings\.json tomado/;
  const sobrantes = consola.filter((c) => !esperados.test(c));
  ok('la consola del renderer quedó limpia', sobrantes.length === 0, sobrantes.join(' | '));
  if (win && !win.isDestroyed()) win.destroy();

  /* ── 12. Cerrar la app con cambios sin guardar en Páginas ───────────────── */
  console.log('\n12. Cerrar la app con cambios de Páginas pendientes (la app de verdad)');
  for (const modo of ['cierre', 'colgado', 'guardado', 'sesion']) {
    const r = await correrHijo(modo);
    if (!r) { ok(`el caso «${modo}» terminó y devolvió su resultado`, false, 'sin resultado'); continue; }
    for (const [que, bien, detalle] of r.checks) {
      ok(que, bien, detalle);
      if (bien && /ms$/.test(detalle)) console.log(`         (${detalle})`);   // los tiempos medidos, también cuando pasan
    }
  }

  console.log(`\n═══ ${pass} ok · ${problemas.length} fallas ═══`);
  for (const p of problemas) console.log('  ! ' + p);
  limpiar();
  app.exit(problemas.length ? 1 : 0);
}

/** Corre este mismo archivo en un proceso de Electron aparte, en `modo`. */
function correrHijo(modo) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.QUIRE_DATA;
    const hijo = spawn(process.execPath, [__filename, `--${modo}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    const corte = setTimeout(() => { try { hijo.kill(); } catch { /* ya no está */ } }, 60000);
    hijo.on('exit', () => {
      clearTimeout(corte);
      const linea = salida.split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
      if (!linea) console.log(salida.split(/\r?\n/).slice(-15).map((l) => '      | ' + l).join('\n'));
      resolve(linea ? JSON.parse(linea.slice('RESULTADO '.length)) : null);
    });
  });
}

/* ══ El cierre de la app (en su propio proceso) ══════════════════════════════
   --cierre: con cambios sin guardar en Páginas, cerrar pregunta; la ventana
   espera lo que decidas (más que los 3 s del reloj del main); Cancelar la deja
   abierta; confirmar cierra en el acto, sin volver a preguntar, y guarda la
   sesión. --colgado: el renderer preguntó y después dejó de contestar (se
   simula tragando el aviso del main); apretar la cruz otra vez cierra a los
   3 s igual: no puede quedar una ventana que no se cierra. --guardado: se
   confirma y el guardado se cuelga; la ventana se cierra igual a los 3 s.
   Devuelve sus resultados en una línea RESULTADO para el proceso de arriba. */
async function cierre() {
  require(path.join(RAIZ, 'main.cjs'));          // la app de verdad
  const checks = [];
  const chk = (que, bien, detalle = '') => checks.push([que, !!bien, String(detalle)]);
  let dejarSalir = false;
  // main.cjs cierra la app cuando se va su última ventana: se ataja hasta terminar.
  app.on('before-quit', (e) => { if (!dejarSalir) e.preventDefault(); });
  const fin = () => {
    console.log('RESULTADO ' + JSON.stringify({ checks }));
    dejarSalir = true;
    limpiar();
    app.exit(0);
  };

  try {
    await app.whenReady();
    let win = null;
    for (let i = 0; i < 80 && !(win = BrowserWindow.getAllWindows()[0]); i++) await esperar(120);
    if (!win) throw new Error('la ventana no apareció');
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await esperar(1800);

    const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
    let cerrada = false;
    const alCerrar = new Promise((r) => win.once('closed', () => { cerrada = true; r(); }));
    const modal = () => js(`(() => {
      const m = document.querySelector('.ox-modal__anim:not([data-state="closing"]) .ox-modal');
      if (!m) return null;
      return { titulo: m.querySelector('.ox-modal__title')?.textContent.trim(), sub: m.querySelector('.ox-modal__sub')?.textContent.trim(),
               foco: document.activeElement?.textContent.trim() };
    })()`);
    const boton = (texto) => js(`(() => {
      const b = [...document.querySelectorAll('.ox-modal__anim:not([data-state="closing"]) .ox-btn')].find((x) => x.textContent.trim() === ${JSON.stringify(texto)});
      b?.click(); return !!b;
    })()`);

    if (MODO === 'cierre') {
      chk('en modo desarrollo (--dev) Piezas sí está en el rail', await js(`!document.getElementById('nav-piezas').hidden`));
    }

    await js(`(async () => {
      const est = await import('./js/estado.js');
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[0])}));
      // Lo que Páginas deja pendiente: la primera quitada y la segunda girada.
      est.S.pestana.organizar = { orden: [2, 3, 4], rotaciones: { 2: 90 } };
      return est.cambiosDePaginas();
    })()`);
    await esperar(800);

    win.close();
    await esperar(600);
    const m1 = await modal();
    chk(`[${MODO}] cerrar con cambios en Páginas pregunta antes`, m1 && /cambios sin guardar en Páginas/.test(m1.titulo || ''), JSON.stringify(m1));

    if (MODO === 'cierre') {
      chk('la pregunta dice en qué documento y qué se pierde', m1 && /uno\.pdf/.test(m1.sub) && /1 página quitada y 1 girada/.test(m1.sub), m1?.sub);
      chk('el foco arranca en Cancelar', m1?.foco === 'Cancelar', m1?.foco);

      /* Con la pregunta abierta, los atajos del shell no andan detrás del
         velo: Ctrl+W cerraba en silencio la pestaña cuyos cambios la pregunta
         decía que se pierden (auditoría 2F). */
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] });
      await esperar(600);
      const tras = await js(`(async () => ({ n: (await import('./js/estado.js')).S.pestanas.length,
        modales: document.querySelectorAll('.ox-modal__anim:not([data-state="closing"])').length }))()`);
      chk('con la pregunta abierta, Ctrl+W no cierra la pestaña de atrás', tras.n === 1 && tras.modales === 1, JSON.stringify(tras));

      await esperar(2700);
      chk('la ventana espera lo que decidas, más que los 3 s del reloj', !cerrada);

      // La cruz otra vez, con la pregunta abierta: sigue siendo una sola, y la ventana no se cierra.
      win.close();
      await esperar(3400);
      const otraCruz = await js(`document.querySelectorAll('.ox-modal__anim:not([data-state="closing"])').length`);
      chk('otra cruz con la pregunta abierta no la duplica ni cierra la ventana', !cerrada && otraCruz === 1, `${cerrada ? 'cerró · ' : ''}${otraCruz} modales`);

      /* Otro Modal llega por su cuenta (el «volvé a cargar el fajo» del dúplex
         asistido, la guardia de una pestaña): Modal.show pisa al que está
         abierto sin contestarle. La pregunta tiene que contar como Cancelar y
         llevarse su velo; si no, la próxima cruz no tiene salida. */
      // La pregunta de ahora queda marcada: la que vuelva después tiene que ser OTRA, no esta huérfana.
      await js(`document.querySelector('.ox-modal__anim:not([data-state="closing"])').dataset.prueba = 'primera'; true`);
      js(`import('./js/overlays.js').then(({ Modal }) => Modal.show({ title: 'Otro aviso', actions: [{ label: 'Entendido', value: true, variant: 'primary' }] }))`).catch(() => {});
      await esperar(700);
      const pisada = await js(`(() => ({
        titulos: [...document.querySelectorAll('.ox-modal__anim:not([data-state="closing"]) .ox-modal__title')].map((t) => t.textContent.trim()),
        velos: document.querySelectorAll('#ox-layer > .ox-scrim:not([data-state="closing"])').length }))()`);
      chk('si otro diálogo pisa la pregunta, la pregunta se va con su velo', pisada.titulos.join() === 'Otro aviso' && pisada.velos === 1, JSON.stringify(pisada));
      await boton('Entendido');
      await esperar(600);
      const huerfanos = await js(`document.querySelectorAll('#ox-layer > .ox-scrim:not([data-state="closing"])').length`);
      chk('y no queda ningún velo huérfano tapando la app', huerfanos === 0, `${huerfanos} velos`);
      win.close();
      await esperar(600);
      const deNuevo = await js(`(() => {
        const vivos = [...document.querySelectorAll('.ox-modal__anim:not([data-state="closing"])')];
        return { titulos: vivos.map((v) => v.querySelector('.ox-modal__title')?.textContent.trim()), viejas: vivos.filter((v) => v.dataset.prueba).length };
      })()`);
      chk('después, la cruz vuelve a preguntar (una pregunta nueva): la ventana no quedó sin salida',
        !cerrada && deNuevo.titulos.length === 1 && /cambios sin guardar/.test(deNuevo.titulos[0] || '') && deNuevo.viejas === 0, JSON.stringify(deNuevo));

      chk('Cancelar existe y se aprieta', await boton('Cancelar'));
      await esperar(3400);
      chk('con Cancelar la ventana sigue abierta (y no queda un reloj suelto)', !cerrada && !(await modal()));

      /* Confirmar, con un guardado que tarda 1,5 s, y la cruz apretada otra vez
         en el medio: no vuelve a preguntar encima de un cierre que ya está en
         camino (auditoría 2F). */
      await js(`(async () => { const est = await import('./js/estado.js');
        est.S.pestana.tinta.guardar = () => new Promise((r) => setTimeout(r, 1500)); return true; })()`);
      win.close();
      await esperar(600);
      chk('cerrar de nuevo vuelve a preguntar', !!(await modal()));
      const t0 = Date.now();
      chk('«Cerrar sin guardar» existe y se aprieta', await boton('Cerrar sin guardar'));
      await esperar(300);
      win.close();
      await esperar(400);
      const durante = cerrada ? null : await js(`document.querySelectorAll('.ox-modal__anim:not([data-state="closing"])').length`).catch(() => null);
      chk('la cruz otra vez mientras guarda no vuelve a preguntar', durante === 0 || durante === null, `${durante} modales`);
      await Promise.race([alCerrar, esperar(5000)]);
      const tardo = Date.now() - t0;
      chk('confirmar cierra en cuanto termina de guardar, sin volver a preguntar', cerrada && tardo < 2500, `${tardo} ms`);
      let sesion = null;
      try { sesion = JSON.parse(fs.readFileSync(path.join(process.env.QUIRE_DATA, 'settings.json'), 'utf8')); } catch { /* sin archivo */ }
      chk('y antes de cerrar guardó la sesión', Array.isArray(sesion?.ultimosDocumentos) && sesion.ultimosDocumentos.length === 1,
        JSON.stringify(sesion?.ultimosDocumentos));
    } else if (MODO === 'guardado') {
      /* Confirmado el cierre, el guardado se cuelga: la decisión vuelve a
         armar el reloj del main y la ventana se cierra sola a los 3 s, como
         cuando no se pregunta nada (auditoría 2F). Antes el main seguía en
         «preguntando», sin reloj, y la ventana quedaba abierta para siempre. */
      await js(`(async () => { const est = await import('./js/estado.js');
        est.S.pestana.tinta.guardar = () => new Promise(() => {}); return true; })()`);
      const t0 = Date.now();
      chk('«Cerrar sin guardar» existe y se aprieta', await boton('Cerrar sin guardar'));
      await Promise.race([alCerrar, esperar(7000)]);
      const tardo = Date.now() - t0;
      chk('si después de confirmar el guardado se cuelga, la ventana se cierra igual a los 3 s', cerrada && tardo > 2500 && tardo < 5000, `${cerrada ? '' : 'no cerró · '}${tardo} ms`);
    } else {
      // Se cuelga: el aviso del main ya no le llega.
      const enviar = win.webContents.send.bind(win.webContents);
      win.webContents.send = (canal, ...args) => { if (canal !== 'app:antes-de-cerrar') enviar(canal, ...args); };
      const t0 = Date.now();
      win.close();
      await Promise.race([alCerrar, esperar(7000)]);
      const tardo = Date.now() - t0;
      chk('si después de preguntar el renderer no contesta, la cruz cierra igual a los 3 s', cerrada && tardo > 2500 && tardo < 5000, `${cerrada ? '' : 'no cerró · '}${tardo} ms`);
    }
  } catch (err) {
    chk(`[${MODO}] el caso corrió sin excepciones`, false, err?.stack || err);
  }
  fin();
}

/* ══ La sesión al arrancar (en su propio proceso) ════════════════════════════
   Con tres documentos guardados, el lector no pasa por los otros dos antes de
   quedarse en el que estabas leyendo (antes cada uno quedaba activo al
   abrirse y había un fundido por documento), y la franja no se reordena a la
   vista: cada pestaña entra directo en su lugar (shell-04, lector-20). Se
   espía estado.js desde el primer momento: el import devuelve la MISMA
   instancia que usa la app. */
async function sesion() {
  /* El espía se engancha al crearse la ventana, antes de que main.cjs la
     cargue: buscarla después podía llegar tarde al dom-ready. */
  let listo = null;
  const espiado = new Promise((r) => { listo = r; });
  app.on('browser-window-created', (_e, w) => {
    w.webContents.once('dom-ready', () => {
      w.webContents.executeJavaScript(`(async () => {
        window.__log = [];
        const est = await import('./js/estado.js');
        est.alCambiar((que) => {
          if (que !== 'pestanas' && que !== 'documento') return;
          window.__log.push({ que, orden: est.S.pestanas.map((p) => p.doc.nombre), activa: est.S.doc?.nombre || null });
        });
        return true;
      })()`, true).then(() => listo(w), () => listo(w));
    });
  });
  require(path.join(RAIZ, 'main.cjs'));
  const checks = [];
  const chk = (que, bien, detalle = '') => checks.push([que, !!bien, String(detalle)]);
  app.on('before-quit', () => {});
  try {
    await app.whenReady();
    const win = await Promise.race([espiado, esperar(15000).then(() => null)]);
    if (!win) throw new Error('la ventana no apareció');
    await esperar(4500);
    const r = await win.webContents.executeJavaScript(`(async () => {
      const est = await import('./js/estado.js');
      return { log: window.__log, orden: est.S.pestanas.map((p) => p.doc.nombre), activa: est.S.doc?.nombre };
    })()`, true);
    const final = ['uno.pdf', 'tres.pdf', 'dos.pdf'];
    chk('la sesión se reabre entera, en el orden en que la dejaste', r.orden.join() === final.join(), r.orden.join(' · '));
    chk('con la que estabas leyendo al frente', r.activa === 'tres.pdf', r.activa);
    const otras = r.log.filter((e) => e.activa && e.activa !== 'tres.pdf');
    chk('el lector no pasa por los otros documentos mientras se reabren', r.log.length > 0 && otras.length === 0,
      r.log.map((e) => `${e.que}:${e.activa}`).join(' '));
    // Cada foto de la franja tiene que ser un pedazo, en orden, de la final.
    const enOrden = (orden) => orden.every((n, i) => i === 0 || final.indexOf(n) > final.indexOf(orden[i - 1]));
    const barajadas = r.log.filter((e) => !enOrden(e.orden));
    chk('y la franja nunca se reordena a la vista: cada pestaña entra en su lugar', barajadas.length === 0,
      barajadas.map((e) => e.orden.join('·')).join(' | '));
  } catch (err) {
    chk('[sesion] el caso corrió sin excepciones', false, err?.stack || err);
  }
  console.log('RESULTADO ' + JSON.stringify({ checks }));
  limpiar();
  app.exit(0);
}
