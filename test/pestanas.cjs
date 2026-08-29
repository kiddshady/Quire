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

   · Que esconder la franja no le coma el alto al cuerpo. Se pliega a 0 y NUNCA
     con `hidden`: un `display:none` la sacaría de ser ítem del grid y el
     cuerpo caería en la fila de alto automático que era de ella. El síntoma
     sería la app entera aplastada, así que se mide el alto del cuerpo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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

  win.webContents.on('console-message', (e) => {
    if (e.level >= 2) problemas.push(`consola[${e.level}] ${e.message.slice(0, 200)}`);
  });

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

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
      tabs: document.querySelectorAll('.qr-tab').length,
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
  }

  /* ── 2. El segundo documento abre la franja ─────────────────────────────── */
  console.log('\n2. Dos documentos');
  await abrir(PDFS[1]);
  await esperar(1200);

  notas.push(['dos-pestañas', await js(`(() => {
    const f = document.getElementById('qr-tabs');
    const r = f.getBoundingClientRect();
    const tabs = [...document.querySelectorAll('.qr-tab')];
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
      contextoTitlebar: document.getElementById('titlebar-context').textContent.trim(),
      hayMas: !!document.getElementById('qr-tab-mas'),
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

  /* ── 3-bis. Cambiar de pestaña ANIMA la vista ───────────────────────────── */
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

    const anims = vista.getAnimations();
    return {
      antes,
      nombre: getComputedStyle(vista).animationName,
      corriendo: anims.filter((a) => a.playState === 'running').length,
      /* El reloj de la animación. Es lo que separa "arrancó de nuevo" de
         "quedó una vieja dando vueltas": una recién nacida está cerca de 0, y
         la anterior ya iba por los 420 ms cuando la medimos quieta. */
      reloj: Math.round(anims[0]?.currentTime || 0),
      cambio: otra.doc.nombre,
      vista: router.name,
    };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    // Sin esto, una animación vieja todavía corriendo daría un falso verde.
    ok('la vista está quieta antes de cambiar', n.antes === 0, `${n.antes}`);
    ok('cambiar de pestaña dispara la animación de vista', n.corriendo === 1, `${n.corriendo}`);
    ok('y es la de entrada del sistema', n.nombre === 'ox-glide-in', n.nombre);
    ok('arrancó de cero, no es una vieja colgada', n.reloj < 120, `${n.reloj} ms`);
    ok('sin salirse de Páginas', n.vista === 'paginas', n.vista);
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
    for (const ruta of ${JSON.stringify(PDFS.slice(2, 4))}) {
      await est.abrir(await window.onyx.docs.leer(ruta));
    }
    const llenas = est.S.pestanas.length;

    let error = null;
    try {
      await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDFS[4])}));
    } catch (e) { error = e.message; }

    return { max: est.MAX_PESTANAS, llenas, error, tras: est.S.pestanas.length,
             hayMas: !!document.getElementById('qr-tab-mas') };
  })()`)]);

  {
    const n = notas.at(-1)[1];
    ok('entran cuatro', n.llenas === n.max, `${n.llenas} de ${n.max}`);
    ok('la quinta se rechaza con un mensaje que dice qué hacer',
      !!n.error && /cerr/i.test(n.error), n.error || 'no tiró error');
    ok('y no queda una pestaña a medias', n.tras === n.max, `${n.tras}`);
    ok('el botón de abrir otro desaparece en el tope', !n.hayMas);
  }

  /* ── 6. Cerrar: a dónde salta, y el worker sigue vivo ───────────────────── */
  console.log('\n6. Cerrar una pestaña');
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
      const r = await S.doc.render(1, { canvas, escala: 0.5 }).promesa;
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
