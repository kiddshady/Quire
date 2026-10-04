/* ═══════════════════════════════════════════════════════════════════════════
   Páginas: organizar sin rehacer la grilla, y sin perder lo pendiente.

   Monta Quire de verdad, abre PDFs por el mismo camino que la app y recorre
   la vista con gestos reales (sendInputEvent) donde importa el camino del
   puntero. Lo que este test existe para cazar:

   · Que lo pendiente sea DE LA PESTAÑA. Era un objeto de la vista, uno solo
     para toda la app: cambiar de pestaña, o cerrar otra (fw-01), lo tiraba.
   · Que la grilla se ponga al día por clave: seleccionar todas, girar o
     quitar no rehacen los nodos ni los canvas (shell-08), lo que se quita
     sale fuera del flujo y lo demás viaja.
   · Que los movimientos se MIDAN: el giro pasa por ángulos intermedios con
     el mismo canvas, la miniatura se funde al llegar, el arrastre aterriza
     sin volver un cuadro a su lugar viejo (corrección 6 del plan).
   · Que Descartar no repinte la vista (la grilla no es .ox-scroll: un
     repintado le perdía el scroll) y se pueda deshacer.
   · Que cerrar una pestaña con cambios pregunte, y que un «no» la deje.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { PDFDocument } = require('pdf-lib');
const { vigilarConsola } = require('./consola.cjs');

const RAIZ = path.join(__dirname, '..');
const ORIGEN = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-paginas-'));
/* Datos propios, y ANTES de requerir nada de src/: store.cjs resuelve su ROOT
   al cargarse. Sin esto, abrir pestañas le escribiría la sesión al `data/` de
   verdad, apuntando a PDFs de temp que se borran al terminar. */
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });

/* El largo tiene un «&» en el nombre: head() ya escapa, y si la vista le
   pasaba el nombre escapado se veía «&amp;» (ux-05). Y tiene 40 páginas para
   que la grilla scrollee: Descartar con la grilla bajada es el caso. */
const LARGO = path.join(TMP, 'Física & Química.pdf');
const CORTO = path.join(TMP, 'corto.pdf');
const TRESCIENTAS = path.join(TMP, 'trescientas.pdf');
const SALIDA = path.join(TMP, 'salida');
fs.mkdirSync(SALIDA);
fs.copyFileSync(ORIGEN, CORTO);

const problemas = [];
const notas = [];
let pass = 0;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(`${que}${detalle ? ` — ${detalle}` : ''}`); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

/* Un modal que nadie contesta (una guardia de cierre nueva, una pregunta que
   se colgó) no puede dejar la suite colgada para siempre: es una falla. */
setTimeout(() => {
  console.log(`\n  FALLA la suite no terminó en 150 s (¿un modal sin contestar?)`);
  for (const p of problemas) console.log('  ! ' + p);
  limpiar();
  app.exit(1);
}, 150000).unref?.();

app.whenReady().then(correr).catch((err) => {
  // Un executeJavaScript que rechaza no puede dejar la ventana abierta para siempre.
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  limpiar();
  app.exit(1);
});

async function armarLargo() {
  const base = await PDFDocument.load(fs.readFileSync(ORIGEN));
  const doc = await PDFDocument.create();
  const indices = base.getPageIndices();
  while (doc.getPageCount() < 40) {
    for (const p of await doc.copyPages(base, indices)) if (doc.getPageCount() < 40) doc.addPage(p);
  }
  fs.writeFileSync(LARGO, await doc.save());
}

async function correr() {
  await armarLargo();
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();

  /* Los diálogos del sistema no se pueden contestar desde un test: se
     reemplazan sus canales por unos que devuelven una ruta de temp. Cuentan
     las llamadas, y el de guardar tarda: es lo que deja ver el «ocupado». */
  const dialogos = { guardar: 0, carpeta: 0, demora: 400 };
  ipcMain.removeHandler('docs:guardar-como');
  ipcMain.handle('docs:guardar-como', async (_e, bytes, nombre) => {
    dialogos.guardar++;
    await esperar(dialogos.demora);
    const ruta = path.join(SALIDA, nombre);
    fs.writeFileSync(ruta, Buffer.from(bytes));
    return { ok: true, data: { ruta, nombre } };
  });
  ipcMain.removeHandler('docs:elegir-carpeta');
  ipcMain.handle('docs:elegir-carpeta', async () => { dialogos.carpeta++; return { ok: true, data: SALIDA }; });

  /* Fuera de pantalla pero VISIBLE: con show:false Chromium congela las
     animaciones, y acá se miden. */
  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 900,
    backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  vigilarConsola(win, problemas);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const tecla = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await esperar(60);
  };

  /* Lo que se repite en cada lectura, puesto en la página una vez. Las
     lecturas de texto van con lo VIVO: mientras dura un relevo, lo que se va
     sigue en el DOM y textContent juntaría las dos frases. */
  await js(`(() => {
    window.__vivo = (el) => el ? [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out'))).map((n) => n.textContent).join('').trim() : null;
    window.__filas = () => [...document.querySelectorAll('#org-grilla > .qr-org__item:not([data-state=closing])')];
    window.__estado = () => __vivo(document.getElementById('org-estado'));
    window.__cuenta = () => __vivo(document.getElementById('org-cuenta'));
    window.__cuadros = (n) => new Promise((ok) => { const f = () => (--n ? requestAnimationFrame(f) : ok()); requestAnimationFrame(f); });
    /* Fotos congeladas de una caja que cambia de ancho con un relevo
       adentro: se llama en la MISMA tarea del gesto, se pausan las
       animaciones finitas que corren (no las que ya terminaron y siguen por
       su fill, ni el spinner) y se las lleva a cada instante. Por foto: el
       ancho de la caja, y de lo que se va (el calco) y lo que llega, su
       opacidad y cuántos px les tapa la caja por la derecha. Al final se
       dan por terminadas. Todo sincrónico: los timers de red de exit() no
       llegan a correr en el medio. */
    window.__congelar = (caja, tiempos = [0, 20, 40, 60, 80, 100, 120, 150, 180, 220, 280]) => {
      const anims = caja.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
      const lado = (n, r) => n ? { op: +(+getComputedStyle(n).opacity).toFixed(2), tapado: +Math.max(0, n.getBoundingClientRect().right - r.right).toFixed(1) } : null;
      const fotos = tiempos.map((t) => {
        for (const a of anims) { a.pause(); a.currentTime = t; }
        const r = caja.getBoundingClientRect();
        return { t, w: +r.width.toFixed(1), sale: lado(caja.querySelector(':scope > .ox-swap-out'), r), entra: lado(caja.querySelector(':scope > .ox-swap-in'), r) };
      });
      for (const a of anims) a.finish();
      return fotos;
    };
    /* Los cuadros en que la caja le corta algo que todavía se ve (opacidad
       mayor a 0,3 y más de 2 px tapados), a lo que se va o a lo que llega. */
    window.__cortes = (fotos) => fotos.flatMap((f) => ['sale', 'entra'].filter((k) => f[k] && f[k].op > 0.3 && f[k].tapado > 2).map((k) => f.t + ' ms: ' + k + ' ' + f[k].tapado + ' px con ' + f[k].op));
    window.__resumenFotos = (fotos) => fotos.map((f) => f.t + ':' + f.w + (f.sale ? '/s' + f.sale.op + '-' + f.sale.tapado : '') + (f.entra ? '/e' + f.entra.op + '-' + f.entra.tapado : '')).join(' ');
    /* Si aparece un calco de la vista entera mientras dura algo: es que se
       repintó, y eso no tenía que pasar. */
    window.__vigilarCalco = () => {
      const r = { visto: false };
      const host = document.getElementById('view').parentElement;
      const mo = new MutationObserver(() => { if (host.querySelector(':scope > .ox-main--saliente')) r.visto = true; });
      mo.observe(host, { childList: true });
      r.soltar = () => { mo.disconnect(); return r.visto; };
      return r;
    };
    return true;
  })()`);

  const abrir = (ruta) => js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(ruta)}));
    return est.S.pestanas.length;
  })()`);

  /* ── 1. Dos documentos, y Páginas con el largo ──────────────────────────── */
  console.log('\n1. Entrar a Páginas');
  await abrir(LARGO);
  await abrir(CORTO);
  await js(`(async () => {
    const est = await import('./js/estado.js');
    est.activar(est.S.pestanas.find((p) => p.doc.nombre.startsWith('Física')).id);
    (await import('./js/router.js')).default.go('paginas');
  })()`);
  await esperar(1500);

  {
    const r = await js(`(() => ({
      filas: __filas().length,
      sub: __vivo(document.querySelector('#view > .ox-viewhead .ox-viewhead__sub')),
      conCanvas: __filas().filter((f) => f.querySelector('canvas')).length,
      estado: __estado(),
    }))()`);
    notas.push(['entrada', r]);
    ok('la grilla tiene las 40 páginas', r.filas === 40, `${r.filas}`);
    ok('el subtítulo dice el nombre tal cual, sin escapar dos veces (ux-05)', r.sub === 'Física & Química.pdf · 40 de 40', r.sub);
    ok('las primeras miniaturas ya se pintaron', r.conCanvas > 0, `${r.conCanvas}`);
  }

  /* ── 2. Todas y Ninguna no rehacen nada ─────────────────────────────────── */
  console.log('\n2. Seleccionar todas y ninguna');
  {
    const r = await js(`(async () => {
      const filas = __filas();
      const lienzos = filas.map((f) => f.querySelector('canvas'));
      const chip = document.getElementById('org-cuenta');
      document.getElementById('org-todas').click();
      await __cuadros(2);
      const tras1 = __filas();
      const todas = { mismas: tras1.length === filas.length && tras1.every((f, i) => f === filas[i]),
        lienzos: tras1.every((f, i) => f.querySelector('canvas') === lienzos[i]),
        sel: tras1.filter((f) => f.classList.contains('is-sel')).length,
        chipRelevo: !!chip.querySelector(':scope > .ox-swap-out') };
      await new Promise((r) => setTimeout(r, 350));
      todas.cuenta = __cuenta();
      document.getElementById('org-ninguna').click();
      await __cuadros(2);
      const tras2 = __filas();
      const ninguna = { mismas: tras2.every((f, i) => f === filas[i]),
        lienzos: tras2.every((f, i) => f.querySelector('canvas') === lienzos[i]),
        sel: tras2.filter((f) => f.classList.contains('is-sel')).length };
      await new Promise((r) => setTimeout(r, 350));
      ninguna.cuenta = __cuenta();
      return { todas, ninguna, mismoChip: document.getElementById('org-cuenta') === chip, conCanvas: lienzos.filter(Boolean).length };
    })()`);
    notas.push(['todas-ninguna', r]);
    ok('Todas conserva los nodos de las filas', r.todas.mismas);
    ok('Todas conserva los canvas', r.todas.lienzos, `${r.conCanvas} con canvas`);
    ok('Todas selecciona las 40', r.todas.sel === 40, `${r.todas.sel}`);
    ok('Ninguna conserva los nodos y los canvas', r.ninguna.mismas && r.ninguna.lienzos);
    ok('Ninguna suelta todo', r.ninguna.sel === 0, `${r.ninguna.sel}`);
    ok('el chip cambia de frase con un relevo, no con textContent (shell-11)', r.todas.chipRelevo && r.mismoChip);
    ok('el chip dice lo que hay', r.todas.cuenta === '40 páginas' && r.ninguna.cuenta === 'nada seleccionado', `${r.todas.cuenta} / ${r.ninguna.cuenta}`);
  }

  /* ── 2b. El chip de la cuenta cambia de ancho con un relevo adentro ─────── */
  /* «nada seleccionado» → «1 página»: la caja se achica mientras la frase
     vieja se va en un calco con la caja vieja. La trampa (motion-timing §10):
     si la caja se pliega antes de que lo de adentro se haya ido, corta la
     frase que todavía se ve casi entera. Se congela el relevo en varios
     instantes (solo lo que corre) y se mide cuánto del calco queda tapado
     según su opacidad. Y al revés, al crecer. */
  console.log('\n2b. El chip, cuadro por cuadro');
  {
    const congelar = (accion) => js(`(async () => {
      const chip = document.getElementById('org-cuenta');
      const w0 = +chip.getBoundingClientRect().width.toFixed(1);
      ${accion};
      const fotos = __congelar(chip);
      await new Promise((r) => setTimeout(r, 350));
      return { fotos, cortes: __cortes(fotos), resumen: __resumenFotos(fotos), w0, final: __cuenta(), w: +chip.getBoundingClientRect().width.toFixed(1) };
    })()`);
    const achica = await congelar(`__filas()[1].click()`);
    const crece = await congelar(`document.getElementById('org-ninguna').click()`);
    notas.push(['chip-achica', achica.resumen]);
    notas.push(['chip-crece', crece.resumen]);
    ok('al achicarse, el chip no corta la frase que se va', achica.fotos.some((f) => f.sale) && achica.cortes.length === 0, achica.cortes.join(' · ') || achica.resumen);
    ok('y se achica de a poco hasta su ancho, con la frase nueva', achica.final === '1 página' && achica.w0 > achica.w + 5 && achica.fotos.some((f) => f.w < achica.w0 - 2 && f.w > achica.w + 2), `${achica.final} · ${achica.w0} → ${achica.w}`);
    ok('al crecer, la caja se abre de a poco y no le corta la frase que llega', crece.fotos.some((f) => f.w > achica.w + 2 && f.w < crece.w - 2) && crece.cortes.length === 0 && crece.final === 'nada seleccionado', crece.cortes.join(' · ') || crece.resumen);
  }

  /* ── 3. Quitar: la que se va sale fuera del flujo, las demás viajan ────── */
  console.log('\n3. Quitar una página');
  {
    const r = await js(`(async () => {
      const filas = __filas();
      filas[1].click();
      await __cuadros(1);
      const victima = filas[1];
      const siguiente = filas[2];
      const lienzoSiguiente = siguiente.querySelector('canvas');
      document.getElementById('org-borrar').click();
      const enSalida = {
        conectada: victima.isConnected,
        estado: victima.dataset.state,
        posicion: victima.style.position,
        siguienteViaja: siguiente.getAnimations().some((a) => a.effect?.getKeyframes?.().some((k) => k.transform && k.transform !== 'none')),
        vivas: __filas().length,
      };
      // La opacidad de la que se va, muestreada: tiene que pasar por el medio.
      const ops = [];
      for (let i = 0; i < 8; i++) { await __cuadros(1); if (victima.isConnected) ops.push(+getComputedStyle(victima).opacity); }
      await new Promise((r) => setTimeout(r, 450));
      return { enSalida, ops, despues: victima.isConnected, mismaSiguiente: __filas()[1] === siguiente && siguiente.querySelector('canvas') === lienzoSiguiente, estado: __estado() };
    })()`);
    notas.push(['quitar', r]);
    ok('la que se quita sigue en el DOM, saliendo, en posición absoluta', r.enSalida.conectada && r.enSalida.estado === 'closing' && r.enSalida.posicion === 'absolute', JSON.stringify(r.enSalida));
    ok('la de al lado viaja a su lugar nuevo (FLIP)', r.enSalida.siguienteViaja);
    ok('quedan 39 vivas en el acto', r.enSalida.vivas === 39, `${r.enSalida.vivas}`);
    ok('la que se va se esfuma de a poco', r.ops.some((o) => o > 0.1 && o < 0.9), r.ops.map((o) => o.toFixed(2)).join(' '));
    ok('y después se va del DOM', r.despues === false);
    ok('la de al lado es el mismo nodo, con su canvas', r.mismaSiguiente);
    ok('el pie lo cuenta', r.estado === '1 página quitada', r.estado);
  }

  /* ── 4. Girar: el mismo canvas, girando ─────────────────────────────────── */
  console.log('\n4. Girar una página');
  {
    const r = await js(`(async () => {
      const fila = __filas()[0];
      fila.click();
      await __cuadros(1);
      const lienzo = fila.querySelector('canvas');
      const hoja = fila.querySelector('.qr-org__hoja');
      const angulo = () => { const m = new DOMMatrixReadOnly(getComputedStyle(lienzo).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); };
      const alto0 = hoja.getBoundingClientRect().height;
      document.getElementById('org-rotar-der').click();
      const serie = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 420) { await __cuadros(1); serie.push({ a: angulo(), h: Math.round(hoja.getBoundingClientRect().height) }); }
      return { mismo: fila.querySelector('canvas') === lienzo && __filas()[0] === fila, serie, alto0: Math.round(alto0),
        transiciones: lienzo ? lienzo.getAnimations().length : -1, chip: __vivo(fila.querySelector('.qr-org__giro')), estado: __estado() };
    })()`);
    notas.push(['girar', { ...r, serie: r.serie.map((s) => `${s.a}/${s.h}`).join(' ') }]);
    const angulos = r.serie.map((s) => s.a);
    const altos = r.serie.map((s) => s.h);
    const final = r.serie.at(-1);
    ok('el canvas es el mismo nodo', r.mismo);
    ok('gira pasando por ángulos intermedios', angulos.some((a) => a > 5 && a < 85), angulos.join(' '));
    ok('termina acostado, a 90°', final && Math.abs(final.a - 90) <= 1, JSON.stringify(final));
    ok('la caja se acuesta de a poco, no de golpe', altos.some((h) => h < r.alto0 - 3 && h > final.h + 3), `${r.alto0} → ${altos.join(' ')}`);
    ok('el pie dice el giro y el estado lo cuenta', r.chip === '90°' && r.estado === '1 página quitada · 1 girada', `${r.chip} · ${r.estado}`);
  }

  /* ── 5. Cerrar OTRA pestaña y cambiar de pestaña no tira lo pendiente ──── */
  console.log('\n5. Lo pendiente es de la pestaña');
  {
    const r = await js(`(async () => {
      const est = await import('./js/estado.js');
      const corto = est.S.pestanas.find((p) => p.doc.nombre === 'corto.pdf');
      const calco = __vigilarCalco();
      await est.cerrarPestana(corto.id);
      await new Promise((r) => setTimeout(r, 400));
      return { calco: calco.soltar(), estado: __estado(), filas: __filas().length, pestanas: est.S.pestanas.length };
    })()`);
    notas.push(['cerrar-otra', r]);
    ok('cerrar la otra pestaña no repinta Páginas (fw-01)', r.calco === false);
    ok('y lo pendiente sigue ahí', r.estado === '1 página quitada · 1 girada' && r.filas === 39, `${r.estado} · ${r.filas}`);
  }
  await abrir(CORTO);           // queda activa: Páginas pasa al corto
  await esperar(700);
  {
    const corto = await js(`({ estado: __estado(), filas: __filas().length })`);
    await js(`(async () => {
      const est = await import('./js/estado.js');
      est.activar(est.S.pestanas.find((p) => p.doc.nombre.startsWith('Física')).id);
    })()`);
    await esperar(700);
    const largo = await js(`({ estado: __estado(), filas: __filas().length, giro: __vivo(__filas()[0].querySelector('.qr-org__giro')) })`);
    notas.push(['ir-y-volver', { corto, largo }]);
    ok('el otro documento se ve sin cambios', corto.estado?.startsWith('Sin cambios') && corto.filas > 0, JSON.stringify(corto));
    ok('al volver, los cambios del primero siguen (shell-07, ux-03)', largo.estado === '1 página quitada · 1 girada' && largo.filas === 39 && largo.giro === '90°', JSON.stringify(largo));
  }

  /* ── 6. Descartar con la grilla bajada ──────────────────────────────────── */
  console.log('\n6. Descartar');
  {
    const r = await js(`(async () => {
      const g = document.getElementById('org-grilla');
      /* Un cambio propio, para no depender de que los de antes hayan
         sobrevivido: si no hay nada pendiente, Descartar está apagado y lo
         de abajo pasaría sin probar nada. */
      __filas()[5].click();
      document.getElementById('org-borrar').click();
      await new Promise((r) => setTimeout(r, 400));
      g.scrollTop = 700;
      await new Promise((r) => setTimeout(r, 300));
      const habilitado = !document.getElementById('org-reiniciar').disabled;
      const antes = g.scrollTop;
      const testigo = g.querySelector('[data-key="p:20"]');
      const calco = __vigilarCalco();
      document.getElementById('org-reiniciar').click();
      await __cuadros(2);
      const enSeguida = g.scrollTop;
      await new Promise((r) => setTimeout(r, 450));
      const toast = [...document.querySelectorAll('.ox-toast:not([data-state=closing])')].find((t) => /descartados/.test(t.textContent));
      return {
        habilitado, antes, enSeguida, despues: g.scrollTop, calco: calco.soltar(),
        mismoTestigo: g.querySelector('[data-key="p:20"]') === testigo && document.getElementById('org-grilla') === g,
        filas: __filas().length, estado: __estado(),
        toast: toast ? { texto: toast.querySelector('.ox-toast__text')?.textContent, accion: toast.querySelector('.ox-toast__action')?.textContent } : null,
      };
    })()`);
    notas.push(['descartar', r]);
    ok('con algo pendiente, Descartar está prendido', r.habilitado);
    ok('el scroll de la grilla se queda donde estaba', r.antes > 100 && Math.abs(r.enSeguida - r.antes) <= 1 && Math.abs(r.despues - r.antes) <= 1, `${r.antes} → ${r.enSeguida} → ${r.despues}`);
    ok('no repinta la vista: no hay calco (shell-12, fw-20)', r.calco === false);
    ok('la grilla y sus filas son las mismas', r.mismoTestigo);
    ok('vuelven las 40 sin cambios', r.filas === 40 && r.estado?.startsWith('Sin cambios'), `${r.filas} · ${r.estado}`);
    ok('un Toast dice qué se descartó y ofrece Deshacer (ux-16)', r.toast?.accion === 'Deshacer' && /quitada/.test(r.toast?.texto || ''), JSON.stringify(r.toast));

    const d = await js(`(async () => {
      [...document.querySelectorAll('.ox-toast__action')].find((b) => b.textContent === 'Deshacer')?.click();
      await new Promise((r) => setTimeout(r, 450));
      return { estado: __estado(), filas: __filas().length };
    })()`);
    ok('el Deshacer del Toast trae los cambios de vuelta', d.estado === '2 páginas quitadas · 1 girada' && d.filas === 38, JSON.stringify(d));
  }

  /* ── 7. Supr, Ctrl+Z y Ctrl+Y, con teclas de verdad ────────────────────── */
  console.log('\n7. Teclado');
  {
    await js(`(async () => { document.getElementById('org-grilla').scrollTop = 0; __filas()[0].click(); __filas()[0].focus(); })()`);
    await esperar(300);
    const n0 = await js(`__filas().length`);
    const lienzo0 = await js(`(() => { window.__l0 = __filas()[0].querySelector('canvas'); window.__k0 = __filas()[0].dataset.key; return !!window.__l0; })()`);
    await tecla('Delete');
    await esperar(450);
    const trasSupr = await js(`({ filas: __filas().length, esta: !!document.querySelector('#org-grilla > [data-key="' + __k0 + '"]:not([data-state=closing])') })`);
    /* La que vuelve entra fundiéndose: se muestrea su opacidad desde el
       mismo cuadro en que la reconcile la pone en la grilla. */
    await js(`(() => {
      window.__vuelve = [];
      const g = document.getElementById('org-grilla');
      const mo = new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || n.dataset.key !== __k0) continue;
          mo.disconnect();
          __vuelve.push(+getComputedStyle(n).opacity);
          let i = 0;
          const f = () => { __vuelve.push(+getComputedStyle(n).opacity); if (++i < 24) requestAnimationFrame(f); };
          requestAnimationFrame(f);
          return;
        }
      });
      mo.observe(g, { childList: true });
      setTimeout(() => mo.disconnect(), 2000);
      return true;
    })()`);
    await tecla('Z', ['control']);
    await esperar(450);
    const vuelve = await js(`__vuelve`);
    const trasZ = await js(`(() => { const f = document.querySelector('#org-grilla > [data-key="' + __k0 + '"]:not([data-state=closing])'); return { filas: __filas().length, esta: !!f, mismoLienzo: !!f && f.querySelector('canvas') === __l0, primera: __filas()[0] === f }; })()`);
    await tecla('Y', ['control']);
    await esperar(450);
    const trasY = await js(`({ filas: __filas().length })`);
    await tecla('Z', ['control']);
    await esperar(450);
    notas.push(['teclado', { n0, lienzo0, trasSupr, trasZ, trasY }]);
    ok('Supr quita la seleccionada (ux-33)', trasSupr.filas === n0 - 1 && !trasSupr.esta, JSON.stringify(trasSupr));
    ok('Ctrl+Z la devuelve a su lugar', trasZ.filas === n0 && trasZ.esta && trasZ.primera, JSON.stringify(trasZ));
    ok('y vuelve con la miniatura que ya tenía, sin repintarla', !lienzo0 || trasZ.mismoLienzo);
    notas.push(['vuelve', vuelve.map((o) => o.toFixed(2)).join(' ')]);
    ok('la que vuelve entra fundiéndose desde transparente', vuelve.length > 3 && vuelve[0] < 0.2 && vuelve.some((o) => o > 0.2 && o < 0.9) && vuelve.at(-1) > 0.99, vuelve.map((o) => o.toFixed(2)).join(' '));
    ok('Ctrl+Y la vuelve a quitar', trasY.filas === n0 - 1, JSON.stringify(trasY));

    await tecla('A', ['control']);
    await esperar(400);
    const todas = await js(`__cuenta()`);
    await tecla('Escape');
    await esperar(400);
    const ninguna = await js(`__cuenta()`);
    ok('Ctrl+A selecciona todas y Escape las suelta', todas === `${n0} páginas` && ninguna === 'nada seleccionado', `${todas} / ${ninguna}`);
  }

  /* ── 8. Shift después de quitar la última clickeada (shell-14) ──────────── */
  console.log('\n8. Shift tras quitar');
  {
    const r = await js(`(async () => {
      __filas()[3].click();
      document.getElementById('org-borrar').click();
      await new Promise((r) => setTimeout(r, 400));
      __filas()[5].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      await new Promise((r) => setTimeout(r, 400));
      return { cuenta: __cuenta(), sel: __filas().filter((f) => f.classList.contains('is-sel')).length };
    })()`);
    ok('Shift con la última ya quitada es un click simple', r.cuenta === '1 página' && r.sel === 1, JSON.stringify(r));
  }

  /* ── 9. Alt y las flechas mueven la selección ───────────────────────────── */
  console.log('\n9. Alt y las flechas');
  {
    await js(`(async () => { __filas()[0].click(); })()`);
    await esperar(300);
    const k = await js(`__filas()[0].dataset.key`);
    /* El muestreador arranca antes de la tecla, en la página: el viaje de
       la fila (un transform, no cualquier animación: el destello del número
       también es una) y el «era N» que se despliega a lo ancho. */
    await js(`(() => {
      const f = document.querySelector('#org-grilla > [data-key="${k}"]');
      const era = f.querySelector('.qr-org__era');
      window.__f9 = { viaja: false, eras: [] };
      const transforma = (a) => a.effect?.getKeyframes?.().some((x) => x.transform && x.transform !== 'none');
      let n = 0;
      const paso = () => {
        if (f.getAnimations().some(transforma)) __f9.viaja = true;
        __f9.eras.push(era.hidden ? 0 : +era.getBoundingClientRect().width.toFixed(1));
        if (++n < 40) requestAnimationFrame(paso);
      };
      requestAnimationFrame(paso);
      return true;
    })()`);
    await tecla('Right', ['alt']);
    await esperar(700);
    const r = await js(`(() => {
      const f = document.querySelector('#org-grilla > [data-key="${k}"]');
      return { pos: f ? __filas().indexOf(f) : -1, viaja: __f9.viaja, eras: __f9.eras, era: __vivo(f?.querySelector('.qr-org__era')), estado: __estado() };
    })()`);
    notas.push(['alt-flechas', { ...r, eras: r.eras.join(' ') }]);
    const eras = r.eras.filter((w) => w > 0);
    ok('Alt+derecha la corre un lugar', r.pos === 1, JSON.stringify(r));
    ok('y viaja a su lugar en vez de saltar (un transform)', r.viaja);
    ok('el «era N» se despliega a lo ancho, no aparece entero', eras.length > 2 && eras[0] < eras.at(-1) * 0.6 && eras.some((w) => w > eras.at(-1) * 0.2 && w < eras.at(-1) * 0.9), r.eras.join(' '));
    ok('el pie dice que está reordenado', /reordenado/.test(r.estado || ''), r.estado);
    await tecla('Left', ['alt']);
    await esperar(400);
  }

  /* ── 10. Arrastrar: muestreado por cuadro, no salta ─────────────────────── */
  console.log('\n10. Arrastrar para reordenar');
  /* El ratón de verdad: un movimiento con el botón apretado lleva
     `leftButtonDown` (sin eso Chromium lo despacha con buttons = 0, como un
     paseo), y el gesto suelta si llega un movimiento sin botón. */
  const raton = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x, y, button: 'left', ...extra });
  const apretado = { modifiers: ['leftButtonDown'] };
  const centroDe = (sel) => js(`(() => { const r = ${sel}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left, top: r.top }; })()`);

  /* Un arrastre entero, con un muestreador por cuadro EN la página desde
     antes de apretar: la posición de la arrastrada, si está levantada, su
     sombra y el scroll de la grilla. Devuelve la serie y cómo terminó. */
  async function arrastrar(de, a, { pasos = 14, quieto = 0, enVuelo = null } = {}) {
    await js(`(() => {
      /* Un muestreador por arrastre: el del anterior todavía corría y
         empujaba en la serie nueva, y quedaban tres series mezcladas. */
      const gen = window.__gen = (window.__gen || 0) + 1;
      const serie = window.__serie = [];
      window.__soltado = null;
      const g = document.getElementById('org-grilla');
      const t0 = performance.now();
      const f = () => {
        if (window.__gen !== gen) return;
        const r = __arr.getBoundingClientRect();
        serie.push({ t: Math.round(performance.now() - t0), x: +r.left.toFixed(2), y: +r.top.toFixed(2), suelto: __soltado != null,
          levantada: __arr.classList.contains('is-dragging') || __arr.classList.contains('is-settling'), idx: __filas().indexOf(__arr),
          sombra: getComputedStyle(__arr).boxShadow, scroll: g.scrollTop });
        if (performance.now() - t0 < 4000) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
      return true;
    })()`);
    raton('mouseDown', de.x, de.y, { clickCount: 1 });
    for (let i = 1; i <= pasos; i++) {
      raton('mouseMove', Math.round(de.x + (a.x - de.x) * i / pasos), Math.round(de.y + (a.y - de.y) * i / pasos), apretado);
      await esperar(16);
    }
    if (quieto) await esperar(quieto);
    const vuelo = await js(`(() => ({
      levantada: __arr.classList.contains('is-dragging'),
      grilla: document.getElementById('org-grilla').classList.contains('is-reordering'),
      corridas: __filas().filter((f) => f !== __arr && f.style.transform).length,
      transform: __arr.style.transform,
    }))()`);
    const extra = enVuelo ? await enVuelo() : null;
    await js(`window.__soltado = performance.now(), true`);
    raton('mouseUp', a.x, a.y, { clickCount: 1 });
    await esperar(800);
    const r = await js(`(() => {
      const fin = __arr.getBoundingClientRect();
      return {
        idx: __filas().indexOf(__arr), mismo: __arr.isConnected,
        sucias: __filas().filter((f) => f.style.transform || f.classList.contains('is-dragging') || f.classList.contains('is-settling')).length,
        grilla: document.getElementById('org-grilla').classList.contains('is-reordering'),
        fin: { x: +fin.left.toFixed(2), y: +fin.top.toFixed(2) },
        serie: __serie,
        seleccion: __filas().filter((f) => f.classList.contains('is-sel')).length,
        estado: __estado(),
      };
    })()`);
    // Después de soltar, la distancia al lugar final no puede crecer: si
    // vuelve un cuadro a su lugar viejo (o reconcile la hace viajar desde
    // ahí), crece de golpe.
    const tras = r.serie.filter((s) => s.suelto);
    const dist = tras.map((s) => Math.hypot(s.x - r.fin.x, s.y - r.fin.y));
    let peorSubida = 0;
    for (let i = 1; i < dist.length; i++) peorSubida = Math.max(peorSubida, dist[i] - dist[i - 1]);
    const asentada = tras.filter((s) => !s.levantada);
    /* Y el cuadro en que deja de estar levantada (se cambia el orden de
       verdad) es el mismo cuadro que el anterior: ni la miniatura ni el
       scroll se mueven. La distancia al final no lo ve si el salto es HACIA
       el lugar final: con el scroll anchoring de Chromium la grilla se
       corría una fila entera al reordenar, y la miniatura con ella. */
    const k = tras.findIndex((s) => !s.levantada);
    const salto = k > 0 ? Math.max(Math.hypot(tras[k].x - tras[k - 1].x, tras[k].y - tras[k - 1].y), Math.abs(tras[k].scroll - tras[k - 1].scroll)) : Infinity;
    return { ...r, vuelo, extra, tras, peorSubida, asentada, salto,
      resumen: tras.map((s) => `${s.t}:${Math.round(Math.hypot(s.x - r.fin.x, s.y - r.fin.y))}${s.levantada ? 'L' : ''}#${s.idx}`).join(' ') };
  }

  /* La primera capa de sombra (`rgba(0, 0, 0, a) …`): su alfa. 0 sin sombra. */
  const alfaSombra = (s) => { const m = /rgba?\([^)]*?,\s*([\d.]+)\)/.exec(s || ''); return s && s !== 'none' ? (m ? +m[1] : 1) : 0; };

  {
    await js(`(async () => { document.getElementById('org-ninguna').click(); document.getElementById('org-grilla').scrollTop = 0; })()`);
    await esperar(400);
    await js(`(() => { window.__arr = __filas()[0]; return true; })()`);
    const de = await centroDe('__filas()[0]');
    const a = await centroDe('__filas()[2]');
    const destino = await js(`(() => { const r = __filas()[2].getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const r = await arrastrar(de, { x: a.x + 8, y: a.y });
    const sombras = r.asentada.map((s) => alfaSombra(s.sombra));
    notas.push(['arrastre', { vuelo: r.vuelo, idx: r.idx, sucias: r.sucias, peorSubida: +r.peorSubida.toFixed(2), serie: r.resumen,
      sombra: sombras.slice(0, 12).map((x) => x.toFixed(2)).join(' ') }]);
    ok('en vuelo: levantada, con la grilla reordenando y las vecinas corridas', r.vuelo.levantada && r.vuelo.grilla && r.vuelo.corridas >= 2, JSON.stringify(r.vuelo));
    ok('queda en el tercer lugar, siendo el mismo nodo', r.idx === 2 && r.mismo, `${r.idx}`);
    ok('cae justo en el lugar que se le hizo', Math.abs(r.fin.x - destino.x) < 1 && Math.abs(r.fin.y - destino.y) < 1, `${JSON.stringify(r.fin)} vs ${JSON.stringify(destino)}`);
    ok('al soltar no salta: la distancia al lugar final nunca crece', r.peorSubida < 1, `subió ${r.peorSubida.toFixed(2)} px`);
    ok('y al asentarse no se mueve nada', r.salto < 1, `${r.salto.toFixed(2)} px`);
    ok('aterriza y recién después deja de estar levantada', r.asentada.length > 0 && r.asentada.every((s) => Math.hypot(s.x - r.fin.x, s.y - r.fin.y) < 1), `${r.asentada.length} cuadros asentada`);
    /* La sombra de levantada se apaga con su transición (--tr-color), no de
       un cuadro al otro: en el primer cuadro asentada todavía se ve algo y
       pasa por el medio antes de irse. */
    ok('la sombra de levantada se funde al aterrizar, no se corta', sombras.length > 2 && sombras[0] > 0.02 && sombras.some((x) => x > 0.02 && x < 0.4) && sombras.at(-1) < 0.01, sombras.slice(0, 12).map((x) => x.toFixed(2)).join(' '));
    ok('no queda nada a medio arrastrar', r.sucias === 0 && !r.grilla, `${r.sucias}`);
    ok('el click del final no seleccionó nada', r.seleccion === 0, `${r.seleccion}`);
    ok('el pie lo cuenta como reordenado', /reordenado/.test(r.estado || ''), r.estado);
  }

  /* A la fila de abajo: en una grilla no alcanza con «cuántas quedan a la
     izquierda», como en las pestañas. */
  {
    const cols = await js(`getComputedStyle(document.getElementById('org-grilla')).gridTemplateColumns.split(' ').filter(Boolean).length`);
    await js(`(() => { window.__arr = __filas()[0]; return true; })()`);
    const de = await centroDe('__filas()[0]');
    const a = await centroDe(`__filas()[${cols}]`);
    const destino = await js(`(() => { const r = __filas()[${cols}].getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const r = await arrastrar(de, { x: a.x, y: a.y + 6 });
    notas.push(['arrastre-abajo', { cols, idx: r.idx, peorSubida: +r.peorSubida.toFixed(2), serie: r.resumen.split(' ').slice(0, 20).join(' ') }]);
    ok(`a la fila de abajo: queda en el lugar ${cols + 1}, debajo de donde estaba`, r.idx === cols && r.mismo, `${r.idx}`);
    ok('y cae en ese lugar, sin saltar', Math.abs(r.fin.x - destino.x) < 1 && Math.abs(r.fin.y - destino.y) < 1 && r.peorSubida < 1 && r.salto < 1, `${JSON.stringify(r.fin)} vs ${JSON.stringify(destino)} · subió ${r.peorSubida.toFixed(2)} · salto ${r.salto.toFixed(2)}`);
  }

  /* Contra el borde de abajo, la grilla se desplaza sola: la arrastrada
     tiene que seguir debajo del puntero (el transform vive en coordenadas
     del contenido) y caer donde se la soltó. */
  {
    await js(`(() => { document.getElementById('org-grilla').scrollTop = 0; window.__arr = __filas()[1]; return true; })()`);
    await esperar(300);
    const de = await centroDe('__filas()[1]');
    const borde = await js(`(() => { const r = document.getElementById('org-grilla').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 12) }; })()`);
    const r = await arrastrar(de, borde, { quieto: 700 });
    /* Mientras el puntero está quieto en el borde, la grilla corre y la
       arrastrada no se mueve en la pantalla. */
    const quietos = r.serie.filter((s) => !s.suelto && s.levantada).slice(-25);
    const corrio = quietos.length ? quietos.at(-1).scroll - quietos[0].scroll : 0;
    const deriva = quietos.length ? Math.max(...quietos.map((s) => Math.abs(s.y - quietos[0].y))) : Infinity;
    notas.push(['arrastre-borde', { corrio, deriva: +deriva.toFixed(2), idx: r.idx, peorSubida: +r.peorSubida.toFixed(2), scrollFinal: r.serie.at(-1)?.scroll,
      quietos: quietos.map((s) => `${s.t}:${s.scroll}`).join(' '), tras: r.tras.slice(0, 30).map((s) => `${s.t}:${s.scroll}/${Math.round(s.y)}${s.levantada ? 'L' : ''}`).join(' ') }]);
    ok('contra el borde, la grilla se desplaza sola', corrio > 100, `${corrio} px`);
    ok('y la arrastrada sigue debajo del puntero mientras tanto', deriva < 1.5, `se corrió ${deriva.toFixed(2)} px`);
    ok('cae lejos de donde salió, sin saltar', r.idx > 6 && r.mismo && r.peorSubida < 1 && r.sucias === 0, `lugar ${r.idx} · subió ${r.peorSubida.toFixed(2)}`);
    /* Lo que encontró este caso: al reordenar, la grilla se corría una fila
       (616 → 342) y la miniatura recién aterrizada se iba de la vista. */
    ok('y al asentarse, ni la grilla ni la miniatura se corren', r.salto < 1, `${r.salto.toFixed(2)} px`);
  }

  /* Ctrl+Z en el medio del gesto no hace nada: antes repintaba la grilla
     debajo de la arrastrada, que saltaba, y el orden final no era el que se
     veía al soltar. */
  {
    await js(`(() => { document.getElementById('org-grilla').scrollTop = 0; window.__arr = __filas()[0]; return true; })()`);
    await esperar(300);
    /* Lo que se espera al soltar: las dos primeras cambiadas de lugar, y el
       resto como estaba (un Ctrl+Z colado deshacía el arrastre de antes). */
    const antes = await js(`(() => { const k = __filas().map((f) => f.dataset.key); window.__esperado = [k[1], k[0], ...k.slice(2)].join(','); return { estado: __estado(), filas: k.length }; })()`);
    const de = await centroDe('__filas()[0]');
    const a = await centroDe('__filas()[1]');
    const r = await arrastrar(de, { x: a.x + 8, y: a.y }, {
      enVuelo: async () => {
        await tecla('Z', ['control']);
        await esperar(120);
        return js(`({ transform: __arr.style.transform, filas: __filas().length })`);
      },
    });
    const orden = await js(`__filas().map((f) => f.dataset.key).join(',') === __esperado`);
    notas.push(['arrastre-ctrlz', { antes, vuelo: r.vuelo.transform, trasZ: r.extra, idx: r.idx, orden, estado: r.estado }]);
    ok('Ctrl+Z con una página levantada no la mueve', r.extra.transform === r.vuelo.transform && r.extra.filas === antes.filas, `${r.vuelo.transform} → ${r.extra.transform}`);
    ok('y cae donde se la soltó, sin deshacer nada', r.idx === 1 && r.peorSubida < 1 && r.salto < 1 && orden, `${r.idx} · orden esperado: ${orden} · salto ${r.salto.toFixed(2)}`);
  }

  /* Soltar fuera de la grilla ANTES del umbral. Una miniatura cortada por
     el borde de abajo (lo normal con la grilla bajada): se aprieta en lo que
     se ve y se corre 3 px hacia el pie. El pointerup cae en el pie. Antes no
     llegaba a nadie, el gesto quedaba colgado y el próximo paseo del mouse
     levantaba la página y la reordenaba. */
  {
    const r0 = await js(`(() => {
      const g = document.getElementById('org-grilla');
      const caja = g.getBoundingClientRect();
      // Una fila cortada por el borde de abajo.
      let fila = null;
      for (let s = 0; s < 600 && !fila; s += 20) {
        g.scrollTop = s;
        fila = __filas().find((f) => { const r = f.getBoundingClientRect(); return r.top < caja.bottom - 30 && r.bottom > caja.bottom + 10; });
      }
      const r = fila.getBoundingClientRect();
      window.__orden0 = __filas().map((f) => f.dataset.key).join(',');
      return { x: Math.round(r.left + r.width / 2), y: Math.floor(caja.bottom) - 2, abajo: Math.ceil(caja.bottom) + 1,
        grilla: { left: caja.left, right: caja.right, top: caja.top, bottom: caja.bottom } };
    })()`);
    raton('mouseDown', r0.x, r0.y, { clickCount: 1 });
    raton('mouseMove', r0.x, r0.abajo, apretado);
    await esperar(30);
    raton('mouseUp', r0.x, r0.abajo, { clickCount: 1 });
    await esperar(60);
    // Un paseo por la grilla, sin ningún botón apretado.
    await js(`(() => { window.__levanto = 0; window.__mo = new MutationObserver(() => { if (document.querySelector('#org-grilla .is-dragging')) window.__levanto++; }); __mo.observe(document.getElementById('org-grilla'), { subtree: true, attributes: true, attributeFilter: ['class'] }); return true; })()`);
    const pasos = 24;
    for (let i = 1; i <= pasos; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r0.grilla.left + 40 + (r0.grilla.right - r0.grilla.left - 80) * i / pasos), y: Math.round(r0.grilla.bottom - 40 - (r0.grilla.bottom - r0.grilla.top - 80) * i / pasos) });
      await esperar(16);
    }
    const enPaseo = await js(`({ levanto: __levanto, ahora: !!document.querySelector('#org-grilla .is-dragging') })`);
    // Un click donde terminó el paseo: con el gesto colgado, ese mouseUp lo soltaba y reordenaba.
    const fin = { x: Math.round(r0.grilla.right - 40), y: Math.round(r0.grilla.top + 40) };
    raton('mouseUp', fin.x, fin.y, { clickCount: 1 });
    await esperar(500);
    const r = await js(`(() => { __mo.disconnect(); return { levanto: __levanto, orden: __filas().map((f) => f.dataset.key).join(',') === __orden0, sucias: __filas().filter((f) => f.style.transform || f.classList.contains('is-dragging') || f.classList.contains('is-settling')).length }; })()`);
    notas.push(['umbral-afuera', { r0, enPaseo, r }]);
    ok('soltar en el pie antes del umbral no deja un gesto colgado: pasear el mouse no levanta nada', enPaseo.levanto === 0 && !enPaseo.ahora && r.levanto === 0, JSON.stringify({ enPaseo, r }));
    ok('y el orden no cambia solo', r.orden && r.sucias === 0, JSON.stringify(r));

    // Y el gesto siguiente arranca normal: un click selecciona.
    await js(`(() => { document.getElementById('org-grilla').scrollTop = 0; return true; })()`);
    await esperar(200);
    const c2 = await centroDe('__filas()[0]');
    raton('mouseDown', c2.x, c2.y, { clickCount: 1 });
    raton('mouseUp', c2.x, c2.y, { clickCount: 1 });
    await esperar(300);
    const sel = await js(`__filas()[0].classList.contains('is-sel')`);
    ok('después, un click en una miniatura la selecciona', sel === true, JSON.stringify(c2));
    await js(`document.getElementById('org-ninguna').click(), true`);
    await esperar(300);
  }

  /* ── 11. Las miniaturas nuevas se funden ────────────────────────────────── */
  console.log('\n11. Miniaturas que llegan');
  {
    /* A esta altura las 40 ya se pintaron: se sale y se vuelve, y la grilla
       nueva las pide de nuevo. Se mide la opacidad del canvas mismo, que no
       depende del fundido de la vista. */
    const r = await js(`(async () => {
      const router = (await import('./js/router.js')).default;
      router.go('lector');
      await new Promise((r) => setTimeout(r, 600));
      const host = document.getElementById('view');
      const ops = [];
      const llego = new Promise((ok) => {
        const mo = new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.tagName !== 'CANVAS' || !n.classList.contains('qr-org__lienzo')) continue;
            mo.disconnect();
            (async () => { for (let i = 0; i < 24; i++) { ops.push(+getComputedStyle(n).opacity); await __cuadros(1); } ok(true); })();
            return;
          }
        });
        mo.observe(host, { childList: true, subtree: true });
        setTimeout(() => { mo.disconnect(); ok(false); }, 4000);
      });
      router.go('paginas');
      /* Los datos del pie que nacen visibles (el «era N» de las movidas) no
         se despliegan desde 0 al entrar: ya estaban. */
      await __cuadros(2);
      const eras = [...document.querySelectorAll('#view .qr-org__era:not([hidden])')];
      const plegables = { visibles: eras.length, desplegandose: eras.filter((e) => e.getAnimations().length || e.getBoundingClientRect().width < 5).length };
      const vino = await llego;
      await new Promise((r) => setTimeout(r, 400));
      return { vino, ops, plegables };
    })()`);
    ok('al volver a la vista, los «era N» ya están en su ancho', r.plegables.visibles > 0 && r.plegables.desplegandose === 0, JSON.stringify(r.plegables));
    notas.push(['miniatura-llega', { vino: r.vino, ops: r.ops.map((o) => o.toFixed(2)).join(' ') }]);
    ok('una miniatura nueva llega al bajar', r.vino);
    ok('y entra fundiéndose, no de golpe (shell-10)', r.ops.some((o) => o > 0.05 && o < 0.95) && r.ops.at(-1) > 0.99, r.ops.map((o) => o.toFixed(2)).join(' '));
  }

  /* ── 12. Exportar varias: progreso y ocupado ────────────────────────────── */
  console.log('\n12. Exportar y guardar, ocupados');
  {
    const r = await js(`(async () => {
      document.getElementById('org-grilla').scrollTop = 0;
      const filas = __filas();
      filas[0].click();
      for (const i of [1, 2]) filas[i].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await new Promise((r) => setTimeout(r, 100));
      const btn = document.getElementById('org-exportar-png');
      const caja = document.getElementById('org-progreso');
      btn.click();
      const serie = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 6000) {
        await __cuadros(1);
        const fill = caja?.querySelector('.ox-meter__fill');
        serie.push({ visible: !!caja && !caja.hidden, w: fill ? Math.round(fill.getBoundingClientRect().width) : 0, total: caja ? Math.round(caja.querySelector('.ox-meter').getBoundingClientRect().width) : 0, apagado: btn.disabled, txt: __vivo(document.getElementById('org-progreso-txt')) });
        if (serie.length > 5 && (!caja || caja.hidden) && !btn.disabled) break;
      }
      return serie;
    })()`);
    const vistos = r.filter((s) => s.visible);
    const intermedio = vistos.some((s) => s.total > 0 && s.w > 2 && s.w < s.total - 2);
    const archivos = fs.readdirSync(SALIDA).filter((f) => f.endsWith('.png'));
    notas.push(['exportar', { cuadros: r.length, visibles: vistos.length, textos: [...new Set(vistos.map((s) => s.txt))], archivos }]);
    ok('el progreso aparece mientras exporta', vistos.length > 0);
    ok('el medidor pasa por valores intermedios', intermedio, vistos.map((s) => `${s.w}/${s.total}`).join(' '));
    ok('Exportar queda apagado mientras trabaja (shell-15)', r.some((s) => s.apagado) && !r.at(-1).apagado);
    ok('y el progreso se va al terminar', r.at(-1).visible === false);
    ok('salen las tres imágenes', archivos.length === 3, archivos.join(', '));
    ok('el texto del progreso cuenta de a una', vistos.some((s) => /^\d de 3$/.test(s.txt || '')), JSON.stringify([...new Set(vistos.map((s) => s.txt))]));
  }
  {
    dialogos.guardar = 0;
    const r = await js(`(async () => {
      const btn = document.getElementById('org-guardar');
      btn.click();
      const fotos = __congelar(btn);
      btn.click();             // el doble click que abría dos diálogos
      await new Promise((r) => setTimeout(r, 200));
      return { apagado: btn.disabled, rotulo: __vivo(btn), mismo: document.getElementById('org-guardar') === btn, cortes: __cortes(fotos), resumen: __resumenFotos(fotos) };
    })()`);
    await esperar(900);
    const modal = await js(`(() => document.querySelector('.ox-modal__title')?.textContent || null)()`);
    /* Mientras se contesta si abrirlo, el archivo ya está escrito: el botón
       no puede seguir diciendo «Guardando…». */
    const conModal = await js(`({ rotulo: __vivo(document.getElementById('org-guardar')) })`);
    await js(`[...document.querySelectorAll('.ox-modal__foot .ox-btn')].find((b) => b.textContent === 'Cancelar')?.click()`);
    await esperar(600);
    const tras = await js(`({ estado: __estado(), rotulo: __vivo(document.getElementById('org-guardar')), filas: __filas().length })`);
    notas.push(['guardar', { r, dialogos: dialogos.guardar, modal, conModal, tras }]);
    ok('con la pregunta de abrir en pantalla, ya no dice «Guardando…»', conModal.rotulo === 'Guardar como…', JSON.stringify(conModal));
    ok('mientras guarda, el botón se apaga y dice «Guardando…»', r.apagado && r.rotulo === 'Guardando…' && r.mismo, JSON.stringify(r));
    ok('el doble click abre UN solo diálogo', dialogos.guardar === 1, `${dialogos.guardar}`);
    ok('«Guardar como…» → «Guardando…»: el botón cambia de ancho sin cortar ninguno de los dos rótulos', r.resumen.includes('/s') && r.cortes.length === 0, r.cortes.join(' · ') || r.resumen);
    ok('pregunta si abrir el archivo nuevo', modal === '¿Abrir el archivo nuevo?', modal);
    ok('guardado, la pestaña vuelve a ser el original y el botón a su rótulo', tras.estado?.startsWith('Sin cambios') && tras.rotulo === 'Guardar como…' && tras.filas === 40, JSON.stringify(tras));
  }

  /* ── 13. Cerrar con cambios pregunta, y un «no» la deja ─────────────────── */
  console.log('\n13. Cerrar con cambios');
  {
    await js(`(async () => { __filas()[4].click(); document.getElementById('org-borrar').click(); })()`);
    await esperar(400);
    const r = await js(`(async () => {
      const est = await import('./js/estado.js');
      const p = est.S.pestana;
      const cierre = est.cerrarPestana(p.id);
      await new Promise((r) => setTimeout(r, 300));
      const modal = { titulo: document.querySelector('.ox-modal__title')?.textContent, sub: document.querySelector('.ox-modal__sub')?.textContent };
      [...document.querySelectorAll('.ox-modal__foot .ox-btn')].find((b) => b.textContent === 'Cancelar')?.click();
      const cerro = await cierre;
      await new Promise((r) => setTimeout(r, 300));
      return { modal, cerro, sigue: est.S.pestanas.includes(p), estado: __estado() };
    })()`);
    notas.push(['guardia', r]);
    /* Con las palabras de la pregunta de cerrar la app (paginas.js,
       PREGUNTA_CAMBIOS; chrome.cjs §12 mira la otra): el mismo título, la
       misma frase con lo que se pierde y el mismo botón (paquete 4A). */
    ok('cerrar la pestaña con cambios pregunta antes, con las palabras del cierre de la app (ux-03)',
      r.modal.titulo === 'Hay cambios sin guardar en Páginas' && /^Física & Química\.pdf: 1 página quitada\. Si cerrás la pestaña, se pierden\.$/.test(r.modal.sub || ''),
      JSON.stringify(r.modal));
    ok('y si se cancela, la pestaña sigue abierta con sus cambios', r.cerro === false && r.sigue && r.estado === '1 página quitada', JSON.stringify(r));

    const s = await js(`(async () => {
      const est = await import('./js/estado.js');
      const p = est.S.pestana;
      const cierre = est.cerrarPestana(p.id);
      await new Promise((r) => setTimeout(r, 300));
      [...document.querySelectorAll('.ox-modal__foot .ox-btn')].find((b) => b.textContent === 'Cerrar sin guardar')?.click();
      const cerro = await cierre;
      const sinCambios = est.S.pestana;
      const sinModal = est.cerrarPestana(sinCambios.id);
      await new Promise((r) => setTimeout(r, 300));
      const hubo = !!document.querySelector('.ox-modal:not([data-state=closing])');
      return { cerro, cerroOtra: await sinModal, hubo, quedan: est.S.pestanas.length };
    })()`);
    ok('confirmando, se cierra', s.cerro === true, JSON.stringify(s));
    ok('una pestaña sin cambios se cierra sin preguntar', s.cerroOtra === true && !s.hubo && s.quedan === 0, JSON.stringify(s));
  }

  /* ── 14. Cerrar mientras guarda ─────────────────────────────────────────── */
  /* Con un trabajo andando la guardia también pregunta, aunque no haya nada
     pendiente; y si se cierra igual, lo que venía después (el Toast, la
     pregunta de abrir) no aparece para una pestaña que ya no está. */
  console.log('\n14. Cerrar mientras guarda');
  await abrir(CORTO);
  await js(`(async () => (await import('./js/router.js')).default.go('paginas'))()`);
  await esperar(1200);
  {
    dialogos.demora = 1500;
    const r = await js(`(async () => {
      __filas()[1].click();
      document.getElementById('org-borrar').click();
      await new Promise((r) => setTimeout(r, 300));
      const est = await import('./js/estado.js');
      const p = est.S.pestana;
      document.getElementById('org-guardar').click();
      await new Promise((r) => setTimeout(r, 300));
      const cierre = est.cerrarPestana(p.id);
      await new Promise((r) => setTimeout(r, 300));
      const modal = { titulo: document.querySelector('.ox-modal__title')?.textContent, sub: document.querySelector('.ox-modal__sub')?.textContent };
      [...document.querySelectorAll('.ox-modal__foot .ox-btn')].find((b) => b.textContent === 'Cerrar igual')?.click();
      const cerro = await cierre;
      await new Promise((r) => setTimeout(r, 2200));
      const modales = [...document.querySelectorAll('.ox-modal:not([data-state=closing]) .ox-modal__title')].map((m) => m.textContent);
      const toasts = [...document.querySelectorAll('.ox-toast:not([data-state=closing])')].map((t) => t.textContent);
      return { modal, cerro, modales, toasts, quedan: est.S.pestanas.length };
    })()`);
    dialogos.demora = 400;
    notas.push(['cerrar-guardando', r]);
    ok('cerrar mientras guarda pregunta, con su propio texto', r.modal.titulo === '¿Cerrar sin terminar?' && /se está guardando/.test(r.modal.sub || ''), JSON.stringify(r.modal));
    ok('confirmando, se cierra', r.cerro === true && r.quedan === 0, JSON.stringify(r));
    ok('y después no aparece la pregunta de abrir ni un Toast para la pestaña que ya no está', r.modales.length === 0 && !r.toasts.some((x) => /Guardado|No se pudo/.test(x)), JSON.stringify({ modales: r.modales, toasts: r.toasts }));
  }

  /* ── 15. Quitar la primera de un documento largo no traba la interfaz ──── */
  /* Quitar la primera renumera todas las de abajo. El destello del número
     forzaba un reflow por fila adentro de reconcile: con 300 páginas, 2 a
     2,4 s con la interfaz trabada (contra 50 ms al quitar la última). Ahora
     se escriben todas y se destellan juntas, y solo las que se ven. */
  console.log('\n15. Un documento de 300 páginas');
  {
    const base = await PDFDocument.load(fs.readFileSync(ORIGEN));
    const doc = await PDFDocument.create();
    const indices = base.getPageIndices();
    while (doc.getPageCount() < 300) {
      for (const p of await doc.copyPages(base, indices)) if (doc.getPageCount() < 300) doc.addPage(p);
    }
    fs.writeFileSync(TRESCIENTAS, await doc.save());
  }
  await abrir(TRESCIENTAS);
  await js(`(async () => (await import('./js/router.js')).default.go('paginas'))()`);
  await esperar(1800);
  {
    const medir = (prep) => js(`(async () => {
      ${prep};
      await new Promise((r) => setTimeout(r, 450));
      const t0 = performance.now();
      document.getElementById('org-borrar').click();
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 120));
      return ms;
    })()`);
    const ultima = await medir(`__filas().at(-1).click()`);
    const primera = await medir(`__filas()[0].click()`);
    const r = await js(`(() => {
      const g = document.getElementById('org-grilla');
      const caja = g.getBoundingClientRect();
      const filas = __filas();
      const ve = (f) => { const r = f.getBoundingClientRect(); return r.bottom > caja.top && r.top < caja.bottom; };
      return {
        filas: filas.length,
        numeros: filas.every((f, i) => f.querySelector('.qr-org__num').textContent === String(i + 1)),
        destellanVistas: filas.filter((f) => ve(f) && f.querySelector('.qr-org__num').classList.contains('ox-ticked')).length,
        vistas: filas.filter(ve).length,
        destellanOcultas: filas.filter((f) => !ve(f) && f.querySelector('.qr-org__num').classList.contains('ox-ticked')).length,
      };
    })()`);
    // Ctrl+Z la trae de vuelta: también renumera todas.
    const deshacer = await js(`(async () => {
      const t0 = performance.now();
      document.getElementById('org-deshacer').click();
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 450));
      return { ms, filas: __filas().length, primera: __filas()[0].querySelector('.qr-org__num').textContent };
    })()`);
    notas.push(['trescientas', { ultima: +ultima.toFixed(1), primera: +primera.toFixed(1), deshacer, ...r }]);
    ok('quitar la primera de 300 no traba la interfaz', primera < 400, `${primera.toFixed(0)} ms (la última: ${ultima.toFixed(0)} ms)`);
    ok('Ctrl+Z, que la trae de vuelta, tampoco', deshacer.ms < 400 && deshacer.filas === 299, `${deshacer.ms.toFixed(0)} ms · ${deshacer.filas}`);
    ok('todas quedan con su número nuevo', r.filas === 298 && r.numeros, JSON.stringify(r));
    ok('destellan las que se ven, y las de fuera de la vista no', r.destellanVistas > 0 && r.destellanOcultas === 0, JSON.stringify(r));
  }
  // Cerrar sin la guardia: no hay a quién preguntarle.
  await js(`(async () => { const est = await import('./js/estado.js'); est.S.pestana.organizar = null; await est.cerrar(); })()`);

  /* ── 16. Un PDF con contraseña: se ordena y se mira, no se escribe ─────────
     Guardar y Extraer reescriben los bytes con pdf-lib, que no descifra: con
     un PDF abierto con contraseña salían hojas en blanco. Lo decidió Fran
     (paquete 4A): avisar y bloquear. Se fabrica el estado (conClave en el
     documento abierto, como lo deja el lector tras pedir la contraseña) y se
     espía pdf-lib en la MISMA instancia de módulo que usa el motor: ninguna
     acción puede llegar a cargar ni a crear un PDF. Exportar como PNG sale de
     pdf.js y sigue andando. */
  console.log('\n16. Un PDF con contraseña');
  await abrir(CORTO);
  await js(`(async () => {
    const est = await import('./js/estado.js');
    est.S.doc.conClave = true;
    // Ya estaba en Páginas (abrir() la repintó sin la marca): se repinta con ella.
    const router = (await import('./js/router.js')).default;
    if (router.name === 'paginas') router.refresh(); else router.go('paginas');
  })()`);
  await esperar(1200);
  {
    const r = await js(`(async () => {
      const { PDFDocument } = await import('./vendor/pdf-lib/pdf-lib.mjs');
      const cargar = PDFDocument.load; const crear = PDFDocument.create;
      let cargas = 0;
      PDFDocument.load = function (...a) { cargas++; return cargar.apply(this, a); };
      PDFDocument.create = function (...a) { cargas++; return crear.apply(this, a); };
      try {
        const aviso = document.getElementById('org-clave');
        const guardar = document.getElementById('org-guardar');
        const extraer = document.getElementById('org-extraer');
        const png = document.getElementById('org-exportar-png');
        const filas = __filas();
        filas[0].click();
        document.getElementById('org-rotar-der').click();
        filas[1].click();
        document.getElementById('org-borrar').click();
        await new Promise((r) => setTimeout(r, 400));
        __filas()[0].click();
        await new Promise((r) => setTimeout(r, 100));
        const estado = __estado();
        /* .click() sobre un botón deshabilitado no despacha nada (medido en
           Electron 40): no llegaba a ningún handler y no probaba las guardias
           conClave(p) de guardar() y extraer(), solo que estaban apagados
           (revisión del 4A). Un evento despachado sí llega al listener. */
        guardar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        extraer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
        return {
          aviso: aviso ? __vivo(aviso) : null,
          avisoAlto: aviso ? Math.round(aviso.getBoundingClientRect().height) : 0,
          estado, filas: __filas().length,
          guardar: { apagado: guardar.disabled, explica: guardar.classList.contains('qr-explica'), tip: guardar.dataset.tip || null, puntero: getComputedStyle(guardar).pointerEvents },
          extraer: { apagado: extraer.disabled, tip: extraer.dataset.tip || null },
          png: { apagado: png.disabled },
          cargas,
          modales: document.querySelectorAll('.ox-modal:not([data-state=closing])').length,
        };
      } finally {
        PDFDocument.load = cargar; PDFDocument.create = crear;
      }
    })()`);
    /* El tooltip del botón apagado, con el puntero de verdad: un .ox-btn
       deshabilitado no recibía el puntero y nunca decía por qué. */
    const caja = await js(`(() => { const b = document.getElementById('org-guardar').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: caja.x, y: caja.y });
    await esperar(700);
    const tip = await js(`document.querySelector('#ox-layer .ox-tooltip:not([data-state=closing])')?.textContent || null`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 450 });
    await esperar(300);
    notas.push(['con-clave', { ...r, tip }]);
    ok('arriba de la grilla, el aviso dice qué tiene y qué no se puede', /Este PDF tiene contraseña/.test(r.aviso || '') && /todavía no guardar sus cambios ni extraer sus páginas/.test(r.aviso || '') && r.avisoAlto > 20, `${r.aviso} (${r.avisoAlto} px)`);
    ok('ordenar, girar y quitar siguen andando', /1 página quitada/.test(r.estado || '') && r.filas === 3, `${r.estado} · ${r.filas}`);
    ok('Guardar queda apagado aunque haya cambios, y su tooltip dice por qué', r.guardar.apagado && r.guardar.explica && /tiene contraseña: Quire todavía no puede guardar sus cambios/.test(r.guardar.tip || ''), JSON.stringify(r.guardar));
    ok('Extraer también, con el porqué en su tooltip', r.extraer.apagado && /tiene contraseña: Quire todavía no puede extraer sus páginas/.test(r.extraer.tip || ''), JSON.stringify(r.extraer));
    ok('Exportar como PNG sigue andando (sale de pdf.js)', !r.png.apagado, JSON.stringify(r.png));
    ok('ninguna acción llegó a pdf-lib', r.cargas === 0 && r.modales === 0, `cargas ${r.cargas} · modales ${r.modales}`);
    ok('pasando el puntero sobre «Guardar como…» apagado, sale el tooltip con el porqué', /tiene contraseña/.test(tip || ''), String(tip));
  }
  await js(`(async () => { const est = await import('./js/estado.js'); est.S.doc.conClave = false; est.S.pestana.organizar = null; await est.cerrar(); })()`);
  // Cerrar recuerda la sesión en disco: que termine antes de borrar la carpeta de datos.
  await esperar(800);

  console.log('\n===== NOTAS =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
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
