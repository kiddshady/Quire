/* ═══════════════════════════════════════════════════════════════════════════
   Las pestañas: varios documentos abiertos a la vez.

   Monta Quire de verdad y abre PDFs por el mismo camino que la app. No alcanza
   con "¿aparecieron los nodos?": lo que se rompe acá no es la franja, es lo de
   abajo.

   Las tres cosas que este test existe para cazar:

   · Que el estado sea DE VERDAD por pestaña. `S.doc`, `S.pagina` y `S.zoom` son
     getters que delegan en la activa. Si esa delegación se rompe —o alguien
     vuelve a poner un campo suelto en S— las cuatro pestañas empiezan a
     compartir la página y no lo nota nadie hasta que estás leyendo.

   · Que el worker de pdf.js SOBREVIVA a cerrar una pestaña. Es uno solo para
     todos los documentos, y `loadingTask.destroy()` termina en
     `this._worker?.destroy()`. Hoy no lo toca porque `_worker` queda en null
     cuando el worker viene de afuera; si eso cambiara en una versión nueva de
     pdf.js, cerrar UNA pestaña dejaría a las demás sin poder pintar. Por eso
     acá se cierra una y después se renderiza otra.

   · Que reordenar sea de verdad: mover() cambia la lista sin perder la activa,
     y arrastrar con el mouse —con eventos del sistema, no sintéticos— termina
     en ese mismo mover(). Lo que se rompe acá es la aritmética de a qué lugar
     va la pestaña, y eso no se ve leyendo el código.

   · Que esconder la franja no le coma el alto al cuerpo. Se pliega a 0 y NUNCA
     con `hidden`: un `display:none` la sacaría de ser ítem del grid y el
     cuerpo caería en la fila de alto automático que era de ella. El síntoma
     sería la app entera aplastada, así que se mide el alto del cuerpo.

   · Que la franja se ponga al día y no se rehaga (shell-01, css-18, ux-18):
     activar conserva los nodos y el foco, el subrayado CRECE, la que se cierra
     sale absoluta y esfumándose, el «+» se pliega a lo ancho, el aterrizaje
     de un arrastre no salta y, en una ventana angosta, el ancho de las que
     quedan viaja. Todo medido por cuadro, no a ojo. Las pestañas se cuentan
     sin la que se está cerrando (`:not([data-state=closing])`).
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vigilarConsola } = require('./consola.cjs');
const { auditarAnillos } = require('./anillos.cjs');
const { abandono, brillo, muestrearAca, vivo } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');
const ORIGEN = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* Cinco copias con nombres distintos. Distintos DE VERDAD, en rutas separadas:
   abrir dos veces la misma ruta activa la pestaña que ya está —es lo que
   queremos para que dos capas de tinta no se pisen— así que con un solo
   archivo no se podría probar ni el tope ni el cambio de pestaña. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-pestanas-'));
const PDFS = ['uno', 'dos', 'tres', 'cuatro', 'cinco'].map((n) => {
  const destino = path.join(TMP, `${n}.pdf`);
  fs.copyFileSync(ORIGEN, destino);
  return destino;
});

/* Datos propios, y ANTES de requerir nada de src/: store.cjs resuelve su ROOT
   al cargarse, así que pisar la variable después no serviría de nada.

   Esto no es prolijidad. Abrir una pestaña dispara recordarSesion(), que
   escribe las rutas abiertas en settings.json — contra el `data/` de verdad,
   este test le dejaba al usuario una sesión apuntando a estos PDFs de temp,
   que se borran al terminar. El próximo arranque de la app real intentaba
   restaurar cuatro archivos fantasma.

   Y al revés también importa: si el `data/` real trae una sesión guardada, la
   app la restaura al bootear y el test arranca con pestañas que no abrió él.
   Con cuatro de tope, eso corría todas las cuentas de acá abajo. */
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });

/* La red (tests-07): sin timeout, un await que no vuelve —el render del
   worker compartido de §6 es justo el caso que esta suite vigila— dejaba a
   Electron colgado para siempre. Y la carpeta temporal (los PDF y los datos)
   se borra en TODAS las salidas, también al abandonar: va envolviendo
   app.exit, como datos-propios.cjs. */
abandono({ ms: 180000 });
const salirApp = app.exit.bind(app);
app.exit = (codigo) => { limpiar(); salirApp(codigo); };

const problemas = [];
const notas = [];
let pass = 0;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(`${que}${detalle ? ` — ${detalle}` : ''}`); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

app.whenReady().then(correr).catch((err) => {
  /* La red de seguridad que faltaba. Un executeJavaScript que rechaza tira
     acá, y sin este catch la promesa quedaba colgada sin llegar nunca a
     app.exit(): Electron se queda con la ventana abierta PARA SIEMPRE. Un test
     que se cuelga es peor que uno que falla — no dice nada y traba la suite. */
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  limpiar();
  app.exit(1);
});

async function correr() {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();

  /* Fuera de pantalla pero VISIBLE: Chromium congela las animaciones de una
     ventana con show:false, y acá se mide una franja que se abre animando su
     alto. Oculta, se mediría siempre en su primer frame. */
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

  /* Un muestreador que corre EN la página, un dato por cuadro: desde Electron
     cada lectura paga el viaje del IPC y se pierden los cuadros del medio. */
  await js(`window.__cuadros = (fn, ms) => new Promise((ok) => {
    const filas = []; const t0 = performance.now();
    const paso = () => {
      const t = performance.now() - t0;
      filas.push({ t: Math.round(t), ...fn() });
      if (t < ms) requestAnimationFrame(paso); else ok(filas);
    };
    requestAnimationFrame(paso);
  }); window.__VIVAS = '.qr-tab:not([data-state="closing"])'; true`);

  /** Abre un PDF por el mismo camino que la app: leer del disco y abrir(). */
  const abrir = (ruta) => js(`(async () => {
    const est = await import('./js/estado.js');
    const archivo = await window.onyx.docs.leer(${JSON.stringify(ruta)});
    await est.abrir(archivo);
    return est.S.pestanas.length;
  })()`);

  /* ── 0. Se arranca de cero ──────────────────────────────────────────────── */
  console.log('\n0. Punto de partida');
  {
    const arranque = await js(`(async () => (await import('./js/estado.js')).S.pestanas.length`
      + `)()`);
    /* Con QUIRE_DATA propio no hay sesión que restaurar. Si esto falla, alguien
       le sacó la variable al test: todo lo de abajo cuenta pestañas, y arrancar
       con una de regalo corre cada cuenta en uno. */
    ok('la app arranca sin ninguna pestaña', arranque === 0, `${arranque}`);
  }

  /* ── 1. Con un solo documento la franja NO está ─────────────────────────── */
  console.log('\n1. Un solo documento');
  await abrir(PDFS[0]);
  await esperar(900);

  notas.push(['una-pestaña', await js(`(() => {
    const f = document.getElementById('qr-tabs');
    const cuerpo = document.querySelector('.ox-body');
    return {
      visible: f.classList.contains('is-visible'),
      alto: f.getBoundingClientRect().height,
      display: getComputedStyle(f).display,
      altoCuerpo: cuerpo.getBoundingClientRect().height,
      tabs: document.querySelectorAll(__VIVAS).length,
      inerte: f.inert,
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('la franja está plegada', !n.visible && n.alto < 1, `alto ${n.alto}`);
    /* Plegada NO es `display:none`. Si alguien "simplifica" a hidden, el test
       de abajo (el alto del cuerpo) es el que lo delata, pero conviene decir
       las dos cosas por separado para que el mensaje señale la causa. */
    ok('y plegada por alto, no con display:none', n.display !== 'none', n.display);
    ok('el cuerpo se queda con la ventana entera', n.altoCuerpo > 700, `${n.altoCuerpo} px`);
    ok('igual hay una pestaña dibujada', n.tabs === 1, `${n.tabs}`);
    /* Plegada, la franja no recibe el Tab: la pestaña, su cruz y el «+» eran
       tres paradas invisibles del anillo (ux-18). */
    ok('y la franja plegada es inerte', n.inerte === true, String(n.inerte));
  }

  /* ── 2. El segundo documento abre la franja ─────────────────────────────── */
  console.log('\n2. Dos documentos');
  await abrir(PDFS[1]);
  await esperar(1200);

  notas.push(['dos-pestañas', await js(`(() => {
    const f = document.getElementById('qr-tabs');
    const r = f.getBoundingClientRect();
    const tabs = [...document.querySelectorAll(__VIVAS)];
    const titlebar = document.querySelector('.ox-titlebar').getBoundingClientRect();
    const cuerpo = document.querySelector('.ox-body').getBoundingClientRect();
    return {
      visible: f.classList.contains('is-visible'),
      top: Math.round(r.top), alto: Math.round(r.height),
      finTitlebar: Math.round(titlebar.bottom),
      arribaCuerpo: Math.round(cuerpo.top),
      tabs: tabs.length,
      activas: tabs.filter((t) => t.classList.contains('is-active')).length,
      activaEs: tabs.findIndex((t) => t.classList.contains('is-active')),
      nombres: tabs.map((t) => t.querySelector('.qr-tab__nombre').textContent),
      // Lo vivo: el contexto se escribe con un relevo (app.js) y el calco de
      // lo que se va suma su texto al textContent un rato (revisión del 4A).
      contextoTitlebar: ${vivo('#titlebar-context')},
      hayMas: !!document.getElementById('qr-tab-mas') && !document.getElementById('qr-tab-mas').hidden,
      inerte: f.inert,
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('la franja aparece', n.visible && n.alto > 20, `alto ${n.alto}`);
    /* Dónde CAE, no solo si existe: pegada abajo del titlebar y con el cuerpo
       arrancando justo debajo de ella. Un error de fila del grid se ve acá. */
    ok('cae justo debajo del titlebar', Math.abs(n.top - n.finTitlebar) <= 1, `${n.top} vs ${n.finTitlebar}`);
    ok('y el cuerpo arranca justo debajo de ella', Math.abs(n.arribaCuerpo - (n.top + n.alto)) <= 1,
      `${n.arribaCuerpo} vs ${n.top + n.alto}`);
    ok('hay dos pestañas', n.tabs === 2, `${n.tabs}`);
    ok('con nombres distintos', n.nombres[0] !== n.nombres[1], n.nombres.join(' / '));
    ok('y exactamente una activa', n.activas === 1, `${n.activas}`);
    ok('la activa es la recién abierta', n.activaEs === 1, `índice ${n.activaEs}`);
    ok('el titlebar deja de repetir el nombre', n.contextoTitlebar === '', n.contextoTitlebar);
    ok('está el botón de abrir otro', n.hayMas);
    ok('con dos documentos la franja ya no es inerte', n.inerte === false, String(n.inerte));
  }

  /* ── 2-ter. Activar conserva los nodos, el foco, y el subrayado crece ──────
     Con la franja rehecha en cada aviso, Enter sobre una pestaña dejaba el
     foco en el body (el nodo enfocado ya no existía) y el subrayado de la
     nueva activa nacía crecido. Se activa con una tecla de verdad, sobre la
     pestaña enfocada. */
  console.log('\n2-ter. Activar sin rehacer la franja');
  {
    win.focus();
    win.webContents.focus();
    await js(`(() => {
      window.__antes = [...document.querySelectorAll(__VIVAS)];
      const otra = window.__antes.find((t) => !t.classList.contains('is-active'));
      window.__otra = otra;
      otra.focus();
      return true;
    })()`);
    await esperar(50);
    const pCrece = js(`__cuadros(() => {
      const t = window.__otra;
      const m = new DOMMatrixReadOnly(getComputedStyle(t, '::after').transform);
      return { escala: Math.round(m.a * 100) / 100, activa: t.classList.contains('is-active') };
    }, 420)`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    const crece = await pCrece;
    const n = await js(`(() => {
      const ahora = [...document.querySelectorAll(__VIVAS)];
      return {
        mismos: ahora.length === window.__antes.length && ahora.every((t, i) => t === window.__antes[i]),
        foco: document.activeElement === window.__otra,
        activa: window.__otra.classList.contains('is-active'),
      };
    })()`);
    const intermedias = crece.filter((f) => f.activa && f.escala > 0.05 && f.escala < 0.95).length;
    ok('Enter activa la pestaña enfocada', n.activa);
    ok('activar conserva los nodos de la franja', n.mismos);
    ok('y el foco sigue en la pestaña', n.foco);
    ok('el subrayado de la nueva activa crece (escalas intermedias)', intermedias >= 2,
      crece.filter((_, i) => i % 3 === 0).map((f) => f.escala).join(' → '));
    ok('y termina entero', crece.at(-1).escala === 1, String(crece.at(-1).escala));
    notas.push(['subrayado', crece.map((f) => f.escala).join(' ')]);
  }
  // Lo que sigue espera la segunda activa, como la dejó el paso 2.
  await js(`(async () => { const est = await import('./js/estado.js'); est.activar(est.S.pestanas[1].id); })()`);
  await esperar(500);

  /* ── 2-bis. El anillo de foco de una pestaña no se corta ────────────────────
     La franja es un contenedor que recorta (scrollea en horizontal cuando no
     entran), y las pestañas son divs con tabindex: el anillo de base.css sale
     3.5px por fuera y ahí caía sobre el borde. Lo mide el mismo auditor que el
     humo de Onyx. Sin foco en la ventana :focus-visible no se aplica y todo
     mediría cero, por eso se lo pide y se lo exige. */
  console.log('\n2-bis. El anillo de foco de las pestañas');
  win.focus();
  win.webContents.focus();
  await esperar(150);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await js('document.hasFocus()'));
  {
    const cortes = await js(auditarAnillos('#qr-tabs'));
    await js(`document.getElementById('aud-notr')?.remove()`);
    ok('ningún anillo de la franja se corta ni roza un canto', cortes.length === 0, '\n      ' + cortes.join('\n      '));
  }

  /* ── 3. El estado es de cada pestaña ────────────────────────────────────── */
  console.log('\n3. Cada pestaña con lo suyo');
  notas.push(['estado-por-pestaña', await js(`(async () => {
    const est = await import('./js/estado.js');
    const { S } = est;

    // En la activa (la segunda): página 3, girada, zoom fijo.
    S.pagina = 3; S.rotacion = 90; S.modoZoom = 'fijo'; S.zoom = 2;
    const segunda = { pagina: S.pagina, rotacion: S.rotacion, zoom: S.zoom, nombre: S.doc.nombre };

    // A la primera: tiene que estar como la dejamos, virgen.
    est.activar(S.pestanas[0].id);
    const primera = { pagina: S.pagina, rotacion: S.rotacion, zoom: S.zoom, nombre: S.doc.nombre };

    // Y volver a la segunda tiene que devolver todo.
    est.activar(S.pestanas[1].id);
    const vuelta = { pagina: S.pagina, rotacion: S.rotacion, zoom: S.zoom, nombre: S.doc.nombre };

    return { segunda, primera, vuelta };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('la primera no se contagia la página', n.primera.pagina === 1, `${n.primera.pagina}`);
    ok('ni la rotación', n.primera.rotacion === 0, `${n.primera.rotacion}`);
    ok('ni el zoom', n.primera.zoom === 1, `${n.primera.zoom}`);
    ok('y son documentos distintos', n.primera.nombre !== n.segunda.nombre,
      `${n.primera.nombre} / ${n.segunda.nombre}`);
    ok('volver devuelve la página', n.vuelta.pagina === 3, `${n.vuelta.pagina}`);
    ok('volver devuelve la rotación', n.vuelta.rotacion === 90, `${n.vuelta.rotacion}`);
    ok('volver devuelve el zoom', n.vuelta.zoom === 2, `${n.vuelta.zoom}`);
  }

  /* ── 3-bis. Cambiar de pestaña FUNDE la vista ───────────────────────────── */
  console.log('\n3-bis. La transición al cambiar de documento');
  notas.push(['transicion', await js(`(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;
    const vista = document.getElementById('view');

    /* En Páginas, que es donde se notaba: la vista se repinta entera y sin
       animación las miniaturas aparecían de golpe. */
    router.go('paginas');
    // Que termine la animación de HABER NAVEGADO, o se contaría esa.
    await new Promise((r) => setTimeout(r, 700));
    const antes = vista.getAnimations().filter((a) => a.playState === 'running').length;

    /* La OTRA, no la que ya está activa: activar() sale sin hacer nada si le
       pedís la actual, y entonces no hay evento, no hay refresh y no hay
       animación que medir. */
    const otra = est.S.pestanas.find((p) => p !== est.S.pestana);
    est.activar(otra.id);

    /* Dos frames de espera, y no es opcional: recién agregada la clase, la
       animación existe pero está en 'pending' —el navegador todavía no le
       fijó el tiempo de arranque—. Leyendo en el acto dice cero corriendo
       aunque esté todo bien. */
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    /* Desde la 0.9.5 el cambio es un fundido: el documento de antes queda en
       un calco que se esfuma encima, y la vista nueva no anima nada. */
    const calco = document.querySelector('.ox-main--saliente');
    const anims = calco ? calco.getAnimations() : [];
    return {
      antes,
      hayCalco: !!calco,
      nombre: calco ? getComputedStyle(calco).animationName : 'sin calco',
      corriendo: anims.filter((a) => a.playState === 'running').length,
      vistaQuieta: vista.getAnimations().length === 0,
      /* El reloj del fundido. Es lo que separa "arrancó recién" de "quedó uno
         viejo dando vueltas": uno recién nacido está cerca de 0. */
      reloj: Math.round(anims[0]?.currentTime || 0),
      cambio: otra.doc.nombre,
      vista: router.name,
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    // Sin esto, una animación vieja todavía corriendo daría un falso verde.
    ok('la vista está quieta antes de cambiar', n.antes === 0, `${n.antes}`);
    ok('cambiar de pestaña funde el documento de antes', n.hayCalco && n.corriendo === 1, `calco=${n.hayCalco} corriendo=${n.corriendo}`);
    ok('y es el fundido del sistema', n.nombre === 'ox-desvanecer', n.nombre);
    ok('arrancó de cero, no es uno viejo colgado', n.reloj < 120, `${n.reloj} ms`);
    ok('la vista nueva queda quieta debajo', n.vistaQuieta);
    ok('sin salirse de Páginas', n.vista === 'paginas', n.vista);
  }

  /* ── 3-ter. El fundido tapa la pantalla todo el tiempo (tests-03) ──────────
     3-bis mira que haya fundido; esto mira que no destape. En el lector, con
     las hojas blancas, es donde se veía: la 0.9.4 hacía un relevo con espera
     y el brillo medio de la vista iba 207 → 36 → 50, más oscuro que las dos
     (motion-timing §2). Dos series a la vez: en la página, cada 40 ms, cuánto
     contenido se ve (el calco opaco encima, `viejo + (100 − viejo) × nuevo /
     100`), con el calco opaco y por encima; y desde Electron, fotos de la zona
     de la vista con su brillo medio, que no puede bajar de las dos puntas.
     El cambio va en la MISMA tarea que la primera muestra. */
  console.log('\n3-ter. El fundido no destapa la pantalla');
  {
    await js(`(async () => { (await import('./js/router.js')).default.go('lector'); })()`);
    await esperar(1500);
    const zona = await js(`(() => { const r = document.getElementById('view').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    const a = brillo(await win.webContents.capturePage(zona));
    const enPagina = js(`(async () => {
      const est = await import('./js/estado.js');
      const vista = document.getElementById('view');
      const alfa = (color) => { const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = color; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; };
      est.activar(est.S.pestanas.find((p) => p !== est.S.pestana).id);
      const filas = []; const t0 = performance.now();
      for (;;) {
        const t = Math.round(performance.now() - t0);
        const calco = document.querySelector('.ox-main--saliente');
        const cs = calco ? getComputedStyle(calco) : null;
        const viejo = cs ? Math.round(+cs.opacity * 100) : null;
        const nuevo = Math.round(+getComputedStyle(vista).opacity * 100);
        filas.push({ t, viejo, nuevo,
          tapado: Math.round(viejo == null ? nuevo : viejo + (100 - viejo) * nuevo / 100),
          opaco: cs ? alfa(cs.backgroundColor) === 255 : null,
          encima: cs ? (parseInt(cs.zIndex, 10) || 0) > 0 : null });
        if (t >= 400) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      return filas;
    })()`);
    const fotos = await muestrearAca(async (t) => ({ t, b: brillo(await win.webContents.capturePage(zona)) }), 0, 400);
    const filas = await enPagina;
    await esperar(400);
    const b = brillo(await win.webContents.capturePage(zona));
    const conCalco = filas.filter((f) => f.viejo != null);
    const piso = Math.min(a, b) - 8;
    notas.push(['fundido-tapado', { a, b, filas: filas.map((f) => `${f.t}:${f.viejo ?? '-'}/${f.nuevo}=${f.tapado}`).join(' '), fotos: fotos.map((f) => `${f.t}:${f.b}`).join(' ') }]);
    ok('hubo calco en la serie (si no, lo de abajo no prueba nada)', conCalco.length >= 2, `${conCalco.length} muestras con calco`);
    ok('la pantalla queda tapada ≥ 97 en toda la serie', filas.every((f) => f.tapado >= 97), filas.map((f) => f.tapado).join(' '));
    ok('el calco es opaco y va por encima de la vista nueva', conCalco.every((f) => f.opaco && f.encima), JSON.stringify(conCalco.find((f) => !f.opaco || !f.encima) || {}));
    ok('el brillo de la vista no baja de las dos puntas (sin parpadeo oscuro)', fotos.every((f) => f.b >= piso),
      `antes ${a}, después ${b}, serie ${fotos.map((f) => f.b).join(' ')}`);
  }

  /* ── 4. El mismo archivo no abre dos veces ──────────────────────────────── */
  console.log('\n4. El mismo archivo dos veces');
  notas.push(['repetido', await js(`(async () => {
    const est = await import('./js/estado.js');
    const antes = est.S.pestanas.length;
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDFS[0])});
    await est.abrir(archivo);
    return {
      antes,
      despues: est.S.pestanas.length,
      activaEs: est.S.pestanas.indexOf(est.S.pestana),
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('no agrega una pestaña', n.despues === n.antes, `${n.antes} → ${n.despues}`);
    ok('sino que activa la que ya estaba', n.activaEs === 0, `índice ${n.activaEs}`);
  }

  /* ── 5. El tope de cuatro ───────────────────────────────────────────────── */
  console.log('\n5. El tope');
  notas.push(['tope', await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[2])}));
    await new Promise((r) => setTimeout(r, 400));
    /* La cuarta llena la franja y el «+» se va: tiene que plegarse a lo
       ancho, no salir del DOM en un cuadro. */
    const mas = document.getElementById('qr-tab-mas');
    const pMas = __cuadros(() => ({ ancho: Math.round(mas.getBoundingClientRect().width * 10) / 10, vivo: mas.isConnected }), 900);
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[3])}));
    const serieMas = await pMas;
    const llenas = est.S.pestanas.length;

    let error = null;
    try {
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[4])}));
    } catch (e) { error = e.message; }

    return { max: est.MAX_PESTANAS, llenas, error, tras: est.S.pestanas.length,
             hayMas: !!document.getElementById('qr-tab-mas') && !document.getElementById('qr-tab-mas').hidden,
             masMismo: document.getElementById('qr-tab-mas') === mas,
             serieMas: serieMas.map((f) => f.ancho) };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('entran cuatro', n.llenas === n.max, `${n.llenas} de ${n.max}`);
    ok('la quinta se rechaza con un mensaje que dice qué hacer',
      !!n.error && /cerr/i.test(n.error), n.error || 'no tiró error');
    ok('y no queda una pestaña a medias', n.tras === n.max, `${n.tras}`);
    ok('el botón de abrir otro desaparece en el tope', !n.hayMas);
    const intermedios = n.serieMas.filter((w) => w > 0.5 && w < 25.5).length;
    ok('y se pliega a lo ancho, con medidas intermedias', intermedios >= 2 && n.serieMas.at(-1) === 0,
      n.serieMas.filter((_, i) => i % 3 === 0).join(' → '));
    ok('siendo el mismo botón, no uno nuevo', n.masMismo);
    notas.push(['ancho-del-mas', n.serieMas.join(' ')]);
  }

  /* ── 5-bis. Reordenar ───────────────────────────────────────────────────── */
  console.log('\n5-bis. Cambiar las pestañas de lugar');
  notas.push(['mover', await js(`(async () => {
    const est = await import('./js/estado.js');
    const { S } = est;
    const nombres = () => S.pestanas.map((p) => p.doc.nombre);
    const enDom = () => [...document.querySelectorAll(__VIVAS + ' .qr-tab__nombre')].map((n) => n.textContent);

    // La activa es la última (recién abierta). Se mueve la PRIMERA al final:
    // la activa tiene que seguir siendo la misma, corrida un lugar.
    const activaAntes = S.pestana;
    const orden = nombres();
    const movida = est.mover(S.pestanas[0].id, 3);
    const trasMover = { movida, orden: nombres(), dom: enDom(),
                        activaSigue: S.pestana === activaAntes,
                        posicion: est.posicionActiva() };

    // Pasarse del borde se recorta, no explota; y al mismo lugar no hace nada.
    const pasada = est.mover(S.pestanas[3].id, 99);
    const primeraTrasPasada = nombres()[3];
    const quieta = est.mover(S.pestanas[1].id, 1);

    return { orden, trasMover, pasada, primeraTrasPasada, quieta, final: nombres() };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    const esperado = [...n.orden.slice(1), n.orden[0]];
    ok('mover() cambia el orden', n.trasMover.movida && n.trasMover.orden.join() === esperado.join(),
      `${n.trasMover.orden.join(' / ')}`);
    ok('y la franja se repinta en ese orden', n.trasMover.dom.join() === esperado.join(),
      n.trasMover.dom.join(' / '));
    ok('la activa sigue siendo la misma pestaña', n.trasMover.activaSigue);
    ok('corrida un lugar', n.trasMover.posicion === 2, `posición ${n.trasMover.posicion}`);
    ok('pasarse del borde se recorta', !n.pasada && n.primeraTrasPasada === esperado[3], n.primeraTrasPasada);
    ok('y moverla a donde ya está no hace nada', !n.quieta);
  }

  /* El gesto de verdad, con eventos de mouse del sistema y no sintéticos:
     setPointerCapture() rechaza un pointerId inventado, así que un
     PointerEvent despachado a mano nunca llegaría a arrastrar nada. */
  console.log('\n5-ter. Arrastrar una pestaña');
  await esperar(400);          // que termine de viajar lo que movió el mover() de recién
  {
    const rects = await js(`(() => [...document.querySelectorAll(__VIVAS)].map((t) => {
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }))()`);
    const nombresAntes = await js(`(async () => (await import('./js/estado.js')).S.pestanas.map((p) => p.doc.nombre))()`);

    // De la primera a la tercera, con pasos intermedios como un mouse real, y
    // unos píxeles PASADOS del centro de la tercera: es cruzar el centro de
    // una vecina lo que te da su lugar, y quedarse clavado justo encima es
    // un empate que ninguna mano de verdad produce.
    const de = rects[0]; const a = { x: rects[2].x + 6, y: rects[2].y };
    const raton = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x, y, button: 'left', ...extra });
    raton('mouseDown', de.x, de.y, { clickCount: 1 });
    const pasos = 12;
    for (let i = 1; i <= pasos; i++) {
      raton('mouseMove', Math.round(de.x + (a.x - de.x) * i / pasos), de.y);
      await esperar(16);
    }
    // A mitad de camino: la arrastrada está levantada y las vecinas corridas.
    const enVuelo = await js(`(() => {
      const tabs = [...document.querySelectorAll(__VIVAS)];
      return {
        levantada: tabs.findIndex((t) => t.classList.contains('is-dragging')),
        corridas: tabs.filter((t) => /translateX\\(-/.test(t.style.transform)).length,
        franja: document.getElementById('qr-tabs').classList.contains('is-reordering'),
      };
    })()`);
    /* El aterrizaje, cuadro por cuadro: la arrastrada es el MISMO nodo hasta
       el final, no vuelve nunca hacia atrás (con el orden de limpieza al
       revés, reconcile la veía en su lugar viejo y la hacía volver desde
       ahí) y lo levantado se apoya de a poco (la sombra pasa por valores
       intermedios en vez de irse de un cuadro al otro). */
    await js(`window.__arrastrada = document.querySelector('.qr-tab.is-dragging'); true`);
    const pAterriza = js(`__cuadros(() => {
      const t = window.__arrastrada;
      const sombra = getComputedStyle(t).boxShadow;
      const alfas = [...sombra.matchAll(/rgba?\\([^)]*?([\\d.]+)\\)/g)].map((m) => +m[1]);
      return { x: Math.round(t.getBoundingClientRect().left), vivo: t.isConnected, alfa: alfas.length ? Math.max(...alfas) : 0 };
    }, 700)`);
    raton('mouseUp', a.x, de.y, { clickCount: 1 });
    const aterriza = await pAterriza;
    await esperar(100);

    const despues = await js(`(async () => {
      const est = await import('./js/estado.js');
      const tabs = [...document.querySelectorAll(__VIVAS)];
      return {
        orden: est.S.pestanas.map((p) => p.doc.nombre),
        activa: est.S.doc.nombre,
        sucias: tabs.filter((t) => t.style.transform || t.classList.contains('is-dragging') || t.classList.contains('is-settling')).length,
        franja: document.getElementById('qr-tabs').classList.contains('is-reordering'),
      };
    })()`);

    ok('en vuelo, la arrastrada está levantada', enVuelo.levantada === 0, `índice ${enVuelo.levantada}`);
    ok('y las dos que pasó se corrieron a la izquierda', enVuelo.corridas === 2, `${enVuelo.corridas}`);
    ok('la franja sabe que está reordenando', enVuelo.franja);
    const esperado = [nombresAntes[1], nombresAntes[2], nombresAntes[0], nombresAntes[3]];
    ok('al soltar, la primera quedó tercera', despues.orden.join() === esperado.join(), despues.orden.join(' / '));
    ok('y pasó a ser la activa', despues.activa === nombresAntes[0], despues.activa);
    ok('no queda ningún transform ni clase colgada', despues.sucias === 0 && !despues.franja, `${despues.sucias}`);

    const xs = aterriza.map((f) => f.x);
    const finalX = xs.at(-1);
    // Hacia dónde va: del primer cuadro al último. Un paso en contra de más de 2 px es un salto atrás.
    const sentido = Math.sign(finalX - xs[0]) || 1;
    const enContra = xs.slice(1).filter((x, i) => (x - xs[i]) * sentido < -2).length;
    const saltoMax = Math.max(0, ...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
    ok('la arrastrada sigue siendo el mismo nodo al aterrizar', aterriza.every((f) => f.vivo));
    ok('y nunca vuelve hacia atrás mientras aterriza', enContra === 0, xs.join(' '));
    ok('ni pega un salto de más de una pestaña', saltoMax < 120, `${saltoMax} px`);
    const sombras = aterriza.map((f) => f.alfa);
    const medias = sombras.filter((a) => a > 0.03 && a < 0.42).length;
    ok('lo levantado se apoya de a poco (sombra con valores intermedios)', medias >= 2,
      sombras.filter((_, i) => i % 3 === 0).map((v) => v.toFixed(2)).join(' → '));
    notas.push(['aterrizaje', { x: xs.join(' '), sombra: sombras.map((v) => v.toFixed(2)).join(' ') }]);
  }

  /* ── 5-quater. En una ventana angosta, el ancho de las que quedan viaja ─────
     reconcile() solo traslada. Con cuatro en una ventana de 900 las pestañas
     se reparten el lugar (menos de su techo de 240), y al cerrar una las que
     quedan crecen: ese ancho cambiaba de golpe mientras el FLIP corría. */
  console.log('\n5-quater. Cerrar una con la ventana angosta');
  {
    const ancho0 = win.getSize();
    win.setSize(900, ancho0[1]);
    await esperar(500);
    const n = await js(`(async () => {
      const est = await import('./js/estado.js');
      const tabs = [...document.querySelectorAll(__VIVAS)];
      const antes = tabs.map((t) => Math.round(t.getBoundingClientRect().width));
      // Se cierra la última; se mira la primera, que se queda y crece.
      const mirada = tabs[0];
      const ultima = est.S.pestanas.at(-1);
      const ruta = ultima.doc.ruta;
      const pSerie = __cuadros(() => {
        const r = mirada.getBoundingClientRect();
        return { w: Math.round(r.width * 10) / 10, x: Math.round(r.left) };
      }, 500);
      await est.cerrarPestana(ultima.id);
      const serie = await pSerie;
      await new Promise((r) => setTimeout(r, 300));

      /* De vuelta a cuatro, para lo que sigue, y midiendo: al abrir la cuarta
         el «+» se pliega, y los anchos finales se medían con él todavía en
         26 px. Las pestañas quedaban quietas en un final falso y saltaban al
         terminar el viaje (auditoría 2F: 205,5 → 214 en un cuadro, la x de
         la tercera +17 px). Se mira la segunda y la tercera, que se mueven. */
      const [t2, t3] = [...document.querySelectorAll(__VIVAS)].slice(1, 3);
      const pAbrir = __cuadros(() => ({
        w: Math.round(t2.getBoundingClientRect().width * 10) / 10,
        x2: Math.round(t2.getBoundingClientRect().left * 10) / 10,
        x3: Math.round(t3.getBoundingClientRect().left * 10) / 10,
      }), 1600);
      await est.abrir(await window.onyx.docs.leer(ruta), { activar: false });
      const abrir = await pAbrir;
      return { antes, serie, abrir };
    })()`);
    win.setSize(ancho0[0], ancho0[1]);
    await esperar(500);
    {
      /* El viaje arranca en el primer cuadro que cambia; de ahí a 200 ms la
         curva (expo-out) ya casi no se mueve, así que ahí no puede haber
         ningún salto: con el final falso, el salto de 8 a 17 px caía justo
         al terminar, a los 280 ms. */
      const a = n.abrir;
      const i0 = a.findIndex((f) => Math.abs(f.w - a[0].w) > 0.5 || Math.abs(f.x3 - a[0].x3) > 0.5);
      const cola = i0 < 0 ? [] : a.filter((f) => f.t > a[i0].t + 200);
      const salto = (k) => Math.max(0, ...cola.slice(1).map((f, i) => Math.abs(f[k] - cola[i][k])));
      ok('al abrir la cuarta en 900 px las pestañas se angostan', i0 >= 0 && a.at(-1).w < a[0].w - 5, `${a[0].w} → ${a.at(-1).w}`);
      ok('y al terminar el viaje no saltan: ni el ancho ni la x de las que se mueven', cola.length > 5 && salto('w') < 1.5 && salto('x2') < 1.5 && salto('x3') < 1.5,
        `cola: ancho ${salto('w')} px, x de la segunda ${salto('x2')} px, x de la tercera ${salto('x3')} px`);
      notas.push(['ancho-al-abrir-la-cuarta', a.filter((_, i) => i % 3 === 0).map((f) => `${f.t}:${f.w}/${f.x3}`).join(' ')]);
    }
    const ws = n.serie.map((f) => f.w);
    const w0 = ws[0]; const w1 = ws.at(-1);
    const intermedios = ws.filter((w) => w > Math.min(w0, w1) + 1 && w < Math.max(w0, w1) - 1).length;
    const saltoMax = Math.max(0, ...ws.slice(1).map((w, i) => Math.abs(w - ws[i])));
    ok('con cuatro en 900 px no llegan a su techo (si no, no hay nada que medir)', n.antes[0] < 235, n.antes.join(' / '));
    ok('al cerrar una, las que quedan crecen', w1 > w0 + 5, `${w0} → ${w1}`);
    ok('y el ancho viaja: hay medidas intermedias', intermedios >= 2, ws.filter((_, i) => i % 3 === 0).join(' → '));
    ok('sin un salto de ancho de un cuadro al otro', saltoMax < (w1 - w0) * 0.6, `${saltoMax} px`);
    notas.push(['ancho-al-cerrar-angosta', { w: ws.join(' '), x: n.serie.map((f) => f.x).join(' ') }]);
  }

  /* ── 6. Cerrar: a dónde salta, y el worker sigue vivo ───────────────────── */
  console.log('\n6. Cerrar una pestaña');
  /* La que se cierra no desaparece de un cuadro al otro ni deja saltar a las
     demás: sale fuera del flujo (absoluta, en su lugar) esfumándose. */
  {
    const n = await js(`(async () => {
      const est = await import('./js/estado.js');
      const { S } = est;
      const p = S.pestanas.find((x) => x !== S.pestana);
      const nodo = document.querySelector('.qr-tab[data-pestana="' + p.id + '"]');
      const ruta = p.doc.ruta;
      const pSerie = __cuadros(() => ({
        vivo: nodo.isConnected,
        pos: getComputedStyle(nodo).position,
        estado: nodo.dataset.state || '',
        op: Math.round(+getComputedStyle(nodo).opacity * 100),
      }), 450);
      await est.cerrarPestana(p.id);
      const serie = await pSerie;
      await est.abrir(await window.onyx.docs.leer(ruta), { activar: false });
      return serie;
    })()`);
    const saliendo = n.filter((f) => f.vivo && f.estado === 'closing');
    ok('la que se cierra queda absoluta mientras se va', saliendo.length > 0 && saliendo.every((f) => f.pos === 'absolute'),
      JSON.stringify(n.slice(0, 3)));
    ok('y se esfuma de a poco', saliendo.filter((f) => f.op > 5 && f.op < 95).length >= 2,
      saliendo.map((f) => f.op).join(' → '));
    ok('y al final sale del DOM', !n.at(-1).vivo);
    notas.push(['la-que-se-cierra', saliendo.map((f) => `${f.pos}:${f.op}`).join(' ')]);
  }
  await esperar(300);
  notas.push(['cerrar', await js(`(async () => {
    const est = await import('./js/estado.js');
    const { S } = est;

    // Activa la segunda de cuatro y cerrala: tiene que saltar a la de al lado.
    est.activar(S.pestanas[1].id);
    const nombreDerecha = S.pestanas[2].doc.nombre;
    await est.cerrarPestana(S.pestanas[1].id);
    const trasCerrarDelMedio = { quedan: S.pestanas.length, activa: S.doc.nombre, esperada: nombreDerecha };

    // Ahora la última: no hay derecha, tiene que caer en la de la izquierda.
    est.activar(S.pestanas[S.pestanas.length - 1].id);
    const nombreIzquierda = S.pestanas[S.pestanas.length - 2].doc.nombre;
    await est.cerrarPestana(S.pestana.id);
    const trasCerrarUltima = { quedan: S.pestanas.length, activa: S.doc.nombre, esperada: nombreIzquierda };

    /* Y lo importante: después de dos destroy(), el worker COMPARTIDO tiene que
       seguir sirviendo. Si se lo hubiera llevado puesto el primer cierre, esto
       cuelga o tira, y no hay forma de enterarse mirando el DOM. */
    const canvas = document.createElement('canvas');
    let render = null;
    try {
      /* Con tope: si el worker murió, la promesa puede no volver nunca y
         el try/catch no ataja un cuelgue (tests-07). */
      const r = await Promise.race([
        S.doc.render(1, { canvas, escala: 0.5 }).promesa,
        new Promise((_, no) => setTimeout(() => no(new Error('el worker no contestó en 5 s')), 5000)),
      ]);
      render = r && r.ancho > 0 && r.alto > 0;
    } catch (e) { render = 'error: ' + e.message; }

    // Y un documento NUEVO también, que es el otro camino al worker.
    let nuevo = null;
    try {
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[4])}));
      nuevo = S.doc.paginas;
    } catch (e) { nuevo = 'error: ' + e.message; }

    return { trasCerrarDelMedio, trasCerrarUltima, render, nuevo, quedan: S.pestanas.length };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    const a = n.trasCerrarDelMedio;
    const b = n.trasCerrarUltima;
    ok('cerrar la activa salta a la de la derecha', a.activa === a.esperada, `${a.activa} ≠ ${a.esperada}`);
    ok('cerrar la última cae en la de la izquierda', b.activa === b.esperada, `${b.activa} ≠ ${b.esperada}`);
    ok('el worker compartido sobrevive: se sigue pintando', n.render === true, String(n.render));
    ok('y todavía se pueden abrir documentos nuevos', typeof n.nuevo === 'number' && n.nuevo > 0, String(n.nuevo));
  }

  /* ── 6-bis. Guardar la tinta de TODAS las pestañas, no solo la de adelante ─
     Lo que hace el cierre de la app. La capa guarda con 900 ms de retardo, así
     que recién dibujado no hay nada en disco: si guardarTodo() mirara solo la
     pestaña activa, la otra perdería sus trazos y no se enteraría nadie. */
  console.log('\n6-bis. Guardar todo lo pendiente');
  notas.push(['guardar-todo', await js(`(async () => {
    const est = await import('./js/estado.js');
    const { S } = est;

    const trazo = { herramienta: 'pluma', color: '#111111', ancho: 2, opacidad: 1,
                    puntos: [{ x: 40, y: 40 }, { x: 120, y: 90 }] };

    // Una pestaña de fondo y la de adelante, cada una con lo suyo.
    const ids = [];
    for (const p of S.pestanas.slice(0, 2)) {
      est.activar(p.id);
      S.tinta.agregar(1, { ...trazo });
      ids.push({ id: S.tinta.id, nombre: S.doc.nombre, sucia: S.tinta.sucia });
    }
    // Volver a la primera: la SEGUNDA queda de fondo con lo suyo sin escribir.
    est.activar(S.pestanas[0].id);

    const guardadas = await est.guardarTodo();
    return { ids, guardadas, sucias: S.pestanas.filter((p) => p.tinta?.sucia).length };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('las dos estaban sin guardar antes', n.ids.length === 2 && n.ids.every((i) => i.sucia),
      JSON.stringify(n.ids));
    ok('guardarTodo() devuelve cuántas escribió', n.guardadas >= 2, `${n.guardadas}`);
    ok('y no queda ninguna sucia', n.sucias === 0, `${n.sucias}`);

    /* La prueba de verdad está en el disco, no en la bandera: `sucia` en false
       solo dice que la capa CREE que guardó. */
    const dir = path.join(process.env.QUIRE_DATA, 'tinta');
    for (const { id, nombre } of n.ids) {
      const archivo = path.join(dir, `${id}.json`);
      let trazos = -1;
      try { trazos = Object.values(JSON.parse(fs.readFileSync(archivo, 'utf8')).paginas || {}).flat().length; }
      catch (e) { trazos = `no se pudo leer: ${e.code || e.message}`; }
      ok(`la tinta de ${nombre} está en disco`, trazos === 1, String(trazos));
    }
  }

  /* ── 6-ter. Los avisos y las carreras del estado ────────────────────────────
     'documento' es el aviso de «llegó otro documento»: con él Páginas y el
     lector se rehacen. Cerrar una pestaña de fondo lo emitía igual, y Páginas
     tiraba los cambios sin guardar. Y las carreras: dos cierres de la misma
     pestaña (doble click en la cruz, Ctrl+W sostenido) se llevaban a la de al
     lado; dos aperturas del mismo PDF daban dos pestañas sobre la misma capa
     de tinta; y «cargando» lo apagaba la primera apertura que terminaba. */
  console.log('\n6-ter. Los avisos y las carreras del estado');
  notas.push(['estado', await js(`(async () => {
    const est = await import('./js/estado.js');
    const { S } = est;
    const PDFS = ${JSON.stringify(PDFS)};
    const leer = (r) => window.onyx.docs.leer(r);
    const avisos = [];
    const off = est.alCambiar((que) => avisos.push(que));
    const r = {};
    try {
      while (S.pestanas.length > 1) await est.cerrarPestana(S.pestanas[S.pestanas.length - 1].id);
      const abiertas = new Set(S.pestanas.map((p) => p.doc?.ruta));
      const libres = PDFS.filter((x) => !abiertas.has(x));
      const [a, b, c, d] = await Promise.all(libres.slice(0, 4).map(leer));

      // Dos aperturas a la vez: «cargando» cuenta las dos.
      const pa = est.abrir(a); const pb = est.abrir(b);
      r.cargandoDurante = S.cargando;
      await Promise.all([pa, pb]);
      r.cargandoDespues = S.cargando;

      // Cerrar una de fondo no cambia lo que se mira: no hay 'documento'.
      est.activar(S.pestanas[0].id);
      const mirando = S.doc;
      avisos.length = 0;
      await est.cerrarPestana(S.pestanas[2].id);
      r.fondo = { avisos: [...avisos], mismoDoc: S.doc === mirando, quedan: S.pestanas.length };

      // Con activar:false entra a la franja sin cambiar lo que se mira.
      avisos.length = 0;
      await est.abrir(c, { activar: false });
      r.sinActivar = { avisos: [...avisos], mismoDoc: S.doc === mirando, quedan: S.pestanas.length };

      // El mismo archivo dos veces a la vez: UNA pestaña.
      const antes = S.pestanas.length;
      await Promise.all([est.abrir(d), est.abrir(d)]);
      r.mismoArchivo = { antes, despues: S.pestanas.length };

      // Dos cierres de la misma pestaña, con tinta sin guardar (el await que abría la carrera).
      const victima = S.pestanas[1];
      const vecina = S.pestanas[2];
      est.activar(victima.id);
      S.tinta.agregar(1, { herramienta: 'pluma', color: '#111111', ancho: 2, opacidad: 1, puntos: [{ x: 10, y: 10 }, { x: 60, y: 40 }] });
      const n0 = S.pestanas.length;
      await Promise.all([est.cerrarPestana(victima.id), est.cerrarPestana(victima.id)]);
      r.dobleCierre = { antes: n0, despues: S.pestanas.length, vecinaViva: S.pestanas.includes(vecina), victimaViva: S.pestanas.includes(victima) };

      // Una guardia que dice que no deja la pestaña abierta.
      const soltar = est.alCerrarPestana?.(async () => false);
      const n1 = S.pestanas.length;
      r.guardia = { cerro: await est.cerrarPestana(S.pestanas[0].id), antes: n1, despues: S.pestanas.length };
      soltar?.();
    } catch (e) { r.error = e.message; }
    off();
    return r;
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('el estado no tiró ningún error', !n.error, n.error);
    ok('«cargando» cuenta las dos aperturas en curso', n.cargandoDurante === 2 && n.cargandoDespues === 0, `${n.cargandoDurante} → ${n.cargandoDespues}`);
    ok('cerrar una pestaña de fondo no avisa «documento»', n.fondo && !n.fondo.avisos.includes('documento') && n.fondo.mismoDoc, JSON.stringify(n.fondo));
    ok('abrir con activar:false no cambia lo que se mira', n.sinActivar && !n.sinActivar.avisos.includes('documento') && n.sinActivar.mismoDoc, JSON.stringify(n.sinActivar));
    ok('el mismo PDF abierto dos veces a la vez da una sola pestaña', n.mismoArchivo && n.mismoArchivo.despues === n.mismoArchivo.antes + 1, JSON.stringify(n.mismoArchivo));
    ok('dos cierres de la misma pestaña cierran solo esa', n.dobleCierre && n.dobleCierre.despues === n.dobleCierre.antes - 1 && n.dobleCierre.vecinaViva && !n.dobleCierre.victimaViva, JSON.stringify(n.dobleCierre));
    ok('una guardia que dice que no deja la pestaña abierta', n.guardia && n.guardia.cerro === false && n.guardia.despues === n.guardia.antes, JSON.stringify(n.guardia));
  }

  /* ── 7. Cerrar hasta el final vuelve a la pantalla de inicio ────────────── */
  console.log('\n7. Cerrar todo');
  notas.push(['vaciar', await js(`(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;
    while (est.S.pestanas.length) await est.cerrarPestana(est.S.pestana.id);
    router.go('lector');
    router.refresh();
    await new Promise((r) => setTimeout(r, 250));
    return {
      pestanas: est.S.pestanas.length,
      doc: est.S.doc,
      // La fachada sin pestañas tiene que devolver los vacíos, no explotar.
      pagina: est.S.pagina,
      rotacion: est.S.rotacion,
      geometrias: Array.isArray(est.S.geometrias) ? est.S.geometrias.length : 'no es array',
      franjaVisible: document.getElementById('qr-tabs').classList.contains('is-visible'),
      vacio: !!document.querySelector('.ox-empty, [class*="empty"]'),
      altoCuerpo: Math.round(document.querySelector('.ox-body').getBoundingClientRect().height),
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('no queda ninguna', n.pestanas === 0, `${n.pestanas}`);
    ok('S.doc vuelve a ser null', n.doc === null, String(n.doc));
    ok('y la fachada devuelve los vacíos sin romperse',
      n.pagina === 1 && n.rotacion === 0 && n.geometrias === 0,
      `pagina ${n.pagina} · rotacion ${n.rotacion} · geometrias ${n.geometrias}`);
    ok('la franja se pliega de nuevo', !n.franjaVisible);
    ok('se ve la pantalla de "no hay ningún PDF"', n.vacio);
    ok('y el cuerpo recupera el alto entero', n.altoCuerpo > 700, `${n.altoCuerpo} px`);
  }

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
