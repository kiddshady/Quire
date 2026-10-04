/* ═══════════════════════════════════════════════════════════════════════════
   Prueba de humo: monta Quire de verdad, abre un PDF y mira qué pasa.

   No alcanza con «¿existe el elemento?»: mide DÓNDE cae cada cosa y si el
   canvas tiene tinta. Y lo que mide lo AFIRMA. Hasta octubre de 2026 unas
   diecisiete mediciones solo se imprimían (tests-01): el pestañeo al plegar
   el panel, abrir un PDF parado en «no hay documento», la rueda muerta con la
   tinta prendida, el folleto encimado, la tinta que no llegaba al preview…
   todo eso podía volver con `npm run verificar` en verde. Ahora cada bloque
   termina con sus umbrales, y lo único que decide el código de salida es
   `problemas`.

   Tres reglas de lectura, que salen de la misma auditoría:

   · Se espera la SEÑAL, no un número de ms (tests-18): las hojas pintadas,
     el preview con su bitmap, las miniaturas con su canvas. Con la máquina
     cargada (otros tests corriendo a la vez) una espera fija llega antes.
   · El texto se lee con `vivo()` y las filas se cuentan sin las que se van
     (`sinSalir()`): con swap() y reconcile() lo viejo sigue en el DOM un rato,
     y un textContent pelado pega las dos frases (tests-13, lector-39).
   · Este archivo no lo toca ningún paquete de la etapa 2 (plan, §3): por eso
     cada lectura ya está escrita para el día en que la zona pase a relevos.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  abandono, hasta, hastaQuieto, vivo, sinSalir, muestrear, esperar, vigilarConsola, leerHoja, faltaContenido, PIXELES,
} = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('humo');
/* Las tarjetas se miden en Piezas, que en la app instalada no está en el rail
   (ux-39: solo en modo desarrollo, por app:info). Acá se pide el modo
   desarrollo para que la vitrina exista, con o sin ese cambio. */
process.env.QUIRE_DEV = '1';

const PDF = process.argv.find((a) => a.endsWith('.pdf'))
  || path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* El fondo con el que main.cjs crea la ventana. Se lee del archivo y no se
   copia acá: si retint.mjs lo cambia, el test sigue la fuente. */
const BG = (fs.readFileSync(path.join(RAIZ, 'main.cjs'), 'utf8').match(/const BG = '(#[0-9a-f]{6})'/i) || [])[1];

const problemas = [];
const notas = [];
const capturas = [];

/** Si `condicion` no se cumple, `clave: detalle` va a problemas (y el humo sale con 1). */
const exigir = (clave, condicion, detalle) => { if (!condicion) problemas.push(`${clave}: ${detalle}`); };
/** La última nota, la que se acaba de medir. */
const ultima = () => notas.at(-1)[1];

/** Lo medido y lo que falló: al final, y también si la suite se abandona. */
function informe() {
  console.log('\n===== HUMO =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  console.log('\n----- problemas: ' + problemas.length + ' -----');
  for (const p of problemas) console.log('  ! ' + p);
  console.log('\ncapturas: ' + capturas.join(' · '));
}

/* Sin esto, un executeJavaScript que rechaza deja Electron vivo con la ventana
   fuera de pantalla y verificar se queda trabado sin decir nada (tests-07).
   240 s y no los 120 de siempre: la corrida sana tarda unos 30, pero hay
   diez esperas de señal de 5 a 20 s, y si fallan todas suman unos 120 más.
   Con 120 de tope, un PDF que no pinta en una máquina cargada cortaba la
   suite antes de las afirmaciones. Y si igual se abandona, el informe sale
   con lo juntado hasta ahí: qué esperas fallaron y qué se midió. */
const bail = abandono({ ms: 240000, alAbandonar: informe });

app.whenReady().then(async () => {
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  ipc.register();

  /* Lo que el renderer le manda a la ventana (tests-02). El listener de
     main.cjs no existe acá —el humo no carga main.cjs—, así que este es el
     único, y lo que se anota es exactamente lo que la app mandó. Antes el humo
     rehacía la conversión con su propio canvas: si sincronizarColorVentana()
     volvía a parsear con un regex, la app arrancaba con medio segundo de
     pantalla verde y el humo seguía midiendo su copia, que estaba bien. */
  const colores = [];
  ipcMain.on('win:set-bg', (_e, hex) => colores.push(hex));

  /* Fuera de pantalla pero VISIBLE, no oculta.
     Chromium congela las animaciones CSS de una ventana con show:false: se
     quedan en su primer frame para siempre. Con un keyframe que arranca en
     `opacity: 0`, todo lo que entra animado se mide invisible y el test
     denuncia bugs que en la app real no existen. Mostrarla en x:-20000 la
     hace animar de verdad sin que aparezca en el escritorio. */
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
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problemas.push(`no cargó (${code} ${desc}) → ${url}`);
  });

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();          // visible para Chromium, invisible para el usuario

  const js = (código) => win.webContents.executeJavaScript(código, true);
  /* Esperar una condición del renderer. Si no llega, es un problema del humo
     pero no lo corta: lo que sigue se mide igual y dice qué más quedó mal. */
  const senal = (que, condicion, ms = 15000) => hasta(() => js(condicion), ms, que)
    .catch((e) => { problemas.push(`esperando ${e.message}`); return null; });
  const foto = async (nombre) => {
    fs.writeFileSync(path.join(RAIZ, 'test', nombre), (await win.webContents.capturePage()).toPNG());
    capturas.push(`test/${nombre}`);
  };

  // El arranque terminó cuando se fue el splash y la vista inicial pintó.
  await senal('el arranque', `!document.getElementById('boot-splash') && document.getElementById('view').children.length > 0`);

  /* ── 0. El color que el renderer le manda a la ventana ────────────────────
     Tiene que ser el mismo fondo que main.cjs ya puso. Si no coincide, ese
     color es lo que se ve mientras el contenido todavía no cubre la ventana:
     un parseo mal hecho de `oklch(0.149 …)` mandaba `#009500` y la app
     arrancaba con medio segundo de pantalla VERDE. */
  {
    const verde = (hex) => {
      const [r, g, b] = /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [];
      return g > 80 && r < 70 && b < 70;
    };
    notas.push(['color-ventana', { mandados: colores, bgDelMain: BG, esVerde: colores.some(verde) }]);
    exigir('color-ventana', !!BG, 'no encontré `const BG` en main.cjs');
    exigir('color-ventana', colores.length > 0, 'el renderer nunca le mandó un color a la ventana (win:set-bg)');
    /* TODOS los mandados, no el último (revisión del paquete 0C): si la app
       manda uno malo al arrancar —una carrera con tokens.css que da #000000,
       o el verde— y después lo corrige, la ventana ya se vio mal pintada, y
       mirando solo el último el test pasaba. */
    if (colores.length && BG) {
      const malos = colores.filter((c) => String(c).toLowerCase() !== BG.toLowerCase());
      exigir('color-ventana', !malos.length, `el renderer mandó ${colores.join(', ')}, y la ventana nace con ${BG}`);
    }
  }

  // ── 1. El shell montó ─────────────────────────────────────────────────────
  notas.push(['shell', await js(`(() => {
    const r = {};
    r.splashSeFue = !document.getElementById('boot-splash');
    r.rail = document.querySelectorAll('.ox-navitem').length;
    r.marca = !!document.querySelector('.ox-brand__mark path');
    r.vistaMontada = !!document.querySelector('#view').children.length;
    return r;
  })()`)]);
  {
    const n = ultima();
    exigir('shell', n.splashSeFue, 'el splash no se fue');
    // Lector, Páginas, Imprimir, Herramientas, Convertir y Ajustes, como mínimo.
    exigir('shell', n.rail >= 6, `el rail tiene ${n.rail} vistas`);
    exigir('shell', n.marca, 'la marca de la titlebar no tiene su SVG');
    exigir('shell', n.vistaMontada, 'la vista inicial no pintó nada');
  }

  /* ── 2. Cero glifos usados como ÍCONO ─────────────────────────────────────
     La regla es que todo símbolo sea un SVG propio: flechas, tildes, cruces,
     emojis. NO prohíbe la puntuación tipográfica —`·` de separador, `—` de
     inciso, `…` de continuará— ni la notación: el `×` de "210 × 297 mm" es
     un signo de multiplicación entre dos números, no un ícono.

     Lo que de verdad delata un glifo haciendo de ícono es que sea TODO el
     contenido de un botón (la cruz de cerrar, el tilde de confirmar), así que
     eso se chequea aparte y con cualquier carácter no alfanumérico. */
  notas.push(['glifos', await js(`(() => {
    const malos = [];
    const prohibido = /[\\u2190-\\u21FF\\u2300-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F000}-\\u{1FAFF}\\u2713\\u2714\\u2717\\u2022]/u;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      if (t && prohibido.test(t)) malos.push(t.slice(0, 24));
    }

    // Un botón cuyo texto es un solo símbolo: eso es un ícono mal hecho.
    const botonesConGlifo = [...document.querySelectorAll('button')]
      .map((b) => b.textContent.trim())
      .filter((t) => t.length && t.length <= 2 && !/[\\w\\dÁÉÍÓÚáéíóúÑñ]/.test(t));

    return { cantidad: malos.length, muestra: malos.slice(0, 6), botonesConGlifo };
  })()`)]);
  {
    const n = ultima();
    exigir('glifos', n.cantidad === 0, `${n.cantidad} textos con glifos: ${JSON.stringify(n.muestra)}`);
    exigir('glifos', n.botonesConGlifo.length === 0, `botones que son un glifo: ${JSON.stringify(n.botonesConGlifo)}`);
  }

  // ── 3. Abrir un PDF de verdad, por el mismo camino que usa la app ─────────
  await js(`(async () => {
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    const mod = await import('./js/estado.js');
    await mod.abrir(archivo);
    const router = (await import('./js/router.js')).default;
    router.go('lector');
    router.refresh();
  })()`).catch((e) => problemas.push('abrir: ' + e.message));

  /* Abierto es: alguna hoja pintada, y la cuenta quieta dos lecturas seguidas
     (la segunda hoja suele llegar enseguida de la primera). */
  await hastaQuieto(() => js(`document.querySelectorAll('#view .qr-pliego.is-pintada').length`), 15000, 'las hojas del lector')
    .catch((e) => problemas.push(`esperando ${e.message}`));

  // ── 4. ¿Se pintaron páginas, y dónde cayeron? ─────────────────────────────
  notas.push(['lector', await js(`(() => {
    const visor = document.getElementById('qr-visor');
    const pliegos = [...document.querySelectorAll('#view .qr-pliego')];
    const pintados = pliegos.filter((p) => p.classList.contains('is-pintada'));
    const r = visor?.getBoundingClientRect();
    const primero = pliegos[0]?.getBoundingClientRect();
    return {
      visorVisible: !!r && r.width > 200 && r.height > 200,
      pliegos: pliegos.length,
      pintados: pintados.length,
      fallidos: pliegos.filter((p) => p.classList.contains('is-fallida')).length,
      // Que el primer pliego caiga DENTRO del visor, no en el limbo.
      primerPliegoDentro: !!(primero && r && primero.top >= r.top - 400 && primero.left >= r.left - 5 && primero.width > 50),
      anchoPrimerPliego: Math.round(primero?.width || 0),
      miniaturas: document.querySelectorAll(${JSON.stringify(sinSalir('#view .qr-mini'))}).length,
      barra: !!document.querySelector('.qr-barra'),
      statusPagina: ${vivo('#stat-pagina-value')},
      statusMedida: ${vivo('#stat-medida-value')},
    };
  })()`)]);
  {
    const n = ultima();
    exigir('lector', n.visorVisible, 'el visor no se ve (o mide menos de 200 px)');
    exigir('lector', n.pintados > 0, `ninguna hoja pintada (${n.pliegos} pliegos)`);
    exigir('lector', n.fallidos === 0, `${n.fallidos} hojas fallaron al pintar`);
    exigir('lector', n.primerPliegoDentro, 'el primer pliego cae fuera del visor');
  }

  // ── 4-bis. Las superficies de visualización van SIN esfumado ─────────────
  // Es la excepción declarada de Quire: un degradado sobre el papel se lee
  // como que la hoja está impresa más clara en el borde. Ver lector.css.
  notas.push(['sin-fade', await js(`(() => {
    const mirar = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'no existe';
      const cs = getComputedStyle(el);
      return {
        mask: cs.maskImage === 'none' && cs.webkitMaskImage === 'none' ? 'limpio' : cs.maskImage,
        scrollea: el.scrollHeight > el.clientHeight + 2,
        claseOxScroll: el.classList.contains('ox-scroll'),
      };
    };
    return { visor: mirar('#qr-visor'), panel: mirar('#qr-panel-cuerpo') };
  })()`)]);
  {
    const n = ultima();
    exigir('sin-fade', n.visor?.mask === 'limpio', `el visor tiene esfumado: ${JSON.stringify(n.visor)}`);
    exigir('sin-fade', n.panel?.mask === 'limpio', `el panel de miniaturas tiene esfumado: ${JSON.stringify(n.panel)}`);
  }

  // Scrollear al medio: un fade se nota arriba solo cuando hay algo recortado.
  await js(`(() => {
    const v = document.getElementById('qr-visor');
    const p = document.getElementById('qr-panel-cuerpo');
    if (v) v.scrollTop = Math.round(v.scrollHeight * 0.28);
    if (p) p.scrollTop = Math.round(p.scrollHeight * 0.3);
  })()`);
  await esperar(900);

  /* ── 4-ter. Plegar el panel no debe remaquetar el visor en cada frame ─────
     Ese era el pestañeo: con el ancho animado, el visor cambiaba de tamaño 60
     veces por segundo, y cada cambio disparaba un repintado de las páginas.
     Se muestrea el ancho durante toda la animación: si el layout se mueve de
     una sola vez, hay como mucho DOS anchos distintos. */
  notas.push(['plegado', await js(`(async () => {
    const visor = document.getElementById('qr-visor');
    const panel = document.getElementById('qr-panel');
    const anchos = new Set();
    const transforms = new Set();

    const muestrear = () => {
      anchos.add(visor.clientWidth);
      transforms.add(getComputedStyle(panel).transform);
    };
    muestrear();

    document.getElementById('qr-toggle-panel').click();
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 25));
      muestrear();
    }
    await new Promise((r) => setTimeout(r, 400));
    muestrear();
    const anchoPlegado = visor.clientWidth;

    // Volver a abrirlo para dejar la app como estaba.
    document.getElementById('qr-toggle-panel').click();
    await new Promise((r) => setTimeout(r, 500));

    return {
      anchosDistintos: anchos.size,
      anchos: [...anchos].sort((a, b) => a - b),
      // El panel SÍ tiene que moverse: varios transform intermedios = animó.
      transformsDistintos: transforms.size,
      crecioAlPlegar: anchoPlegado > [...anchos][0],
      anchoAlVolver: visor.clientWidth,
    };
  })()`)]);
  {
    const n = ultima();
    exigir('plegado', n.anchosDistintos <= 2, `el visor pasó por ${n.anchosDistintos} anchos al plegar el panel (${n.anchos.join(', ')}): se remaqueta en cada cuadro`);
    exigir('plegado', n.transformsDistintos > 2, `el panel no se movió de a poco (${n.transformsDistintos} transforms)`);
    exigir('plegado', n.crecioAlPlegar, 'el visor no ganó el ancho del panel al plegarlo');
  }

  /* El panel a MITAD de camino, congelado: es el único frame donde se ve si
     invade el rail. Se fija el transform a mano en vez de cazar el frame
     exacto, que sería una carrera contra la animación. */
  await js(`(() => {
    const p = document.getElementById('qr-panel');
    p.style.transition = 'none';
    p.style.transform = 'translateX(-52%)';
  })()`);
  await esperar(260);
  await foto('humo-plegando.png');

  notas.push(['recorte', await js(`(() => {
    const cuerpo = document.querySelector('.qr-lector__cuerpo');
    const panel = document.getElementById('qr-panel');
    const rail = document.querySelector('.ox-rail');
    const p = panel.getBoundingClientRect();
    const c = cuerpo.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    const res = {
      // A mitad de camino el panel SÍ se sale de su área (eso es la animación)
      // y en geometría pisa el rail…
      panelSeSale: Math.round(c.left - p.left),
      pisaElRail: p.left < r.right,
      // …pero el contenedor lo recorta, así que no se pinta encima de nada.
      overflow: getComputedStyle(cuerpo).overflow,
      opacidad: getComputedStyle(panel).opacity,
    };
    panel.style.transition = '';
    panel.style.transform = '';
    return res;
  })()`)]);
  {
    const n = ultima();
    // Si se sale y pisa el rail, que el cuerpo lo recorte: si no, se pinta encima.
    exigir('recorte', !n.pisaElRail || (n.overflow !== 'visible' && n.overflow !== ''),
      `el panel a mitad de camino pisa el rail y el cuerpo no lo recorta (overflow ${n.overflow})`);
  }
  await esperar(320);

  /* ── 5. ¿Hay tinta real en el canvas? ──────────────────────────────────────
     Papel con letras, no «píxeles oscuros»: una hoja negra o transparente
     también tiene de esos (leerHoja, en _comun.cjs). Y la hoja se pide por su
     clase: el pliego tiene dos canvas, y el de la tinta es transparente. Hoy
     la hoja va primera en el template (lector.js), pero si eso cambia un
     `canvas` suelto leería la capa de tinta. */
  const HOJA_LECTOR = `document.querySelector('#view .qr-pliego canvas.qr-hoja')`;
  notas.push(['tinta', await js(leerHoja(HOJA_LECTOR, { alto: 600 }))]);
  {
    const n = ultima();
    const falta = n.motivo || faltaContenido(n.lados?.[0]);
    exigir('tinta', !falta, `la hoja del lector no es papel con letras: ${falta} (${n.lienzo})`);
  }

  /* ── 5-bis. Leer la misma hoja otra vez no ensucia la consola ─────────────
     Dos getImageData sobre el mismo canvas hacen que Chromium avise por
     consola («Canvas2D: Multiple readback operations…»), y vigilarConsola lo
     cuenta como problema: el humo se ponía rojo por una lectura del propio
     test (revisión del paquete 0C). Hoy cada canvas se lee una sola vez de
     casualidad; el día que una suite relea el preview o una hoja del lector,
     tiene que dar igual. Por eso se relee a propósito, y se exige que no
     haya aviso y que las lecturas den lo mismo (la copia no pierde nada). */
  {
    const antes = problemas.length;
    const relecturas = [];
    for (let i = 0; i < 3; i++) relecturas.push(await js(leerHoja(HOJA_LECTOR, { alto: 600 })));
    await esperar(150);   // los console-message llegan por IPC, un poco después
    const avisos = problemas.slice(antes).filter((p) => /readback|willReadFrequently/i.test(p));
    const iguales = relecturas.every((r) => JSON.stringify(r) === JSON.stringify(notas.find(([k]) => k === 'tinta')[1]));
    notas.push(['relecturas', { veces: relecturas.length, iguales, avisos: avisos.length }]);
    exigir('relecturas', !avisos.length, 'releer la misma hoja hizo que Chromium avisara por consola: el test está leyendo el canvas de la app y no una copia (PIXELES, en _comun.cjs)');
    exigir('relecturas', iguales, 'releer la misma hoja no dio lo mismo que la primera lectura');
  }

  // ── 6. Capacidades de la impresora, por el puente real ────────────────────
  // Solo se anota: depende de las impresoras de la máquina donde corre.
  notas.push(['impresoras', await js(`(async () => {
    const lista = await window.onyx.print.listar();
    const hp = lista.find((p) => /1102/.test(p.nombre));
    return {
      cuantas: lista.length,
      hp: hp ? {
        duplex: hp.soportaDuplex, mono: hp.soloMonocromo, tamanos: hp.tamanos.length,
        a4: hp.tamanos.find((t) => /A4$/i.test(t.nombre)),
      } : null,
    };
  })()`).catch((e) => ({ error: e.message }))]);

  // ── 6-bis. Anotar con el stylus ──────────────────────────────────────────
  // Se sintetizan PointerEvents de tipo 'pen' con presión: es el único camino
  // que ejercita de verdad StrokeInput, el suavizado y la conversión a
  // coordenadas de página.
  notas.push(['tinta-stylus', await js(`(async () => {
    /* Sin borrarTodo() antes: con datos-propios cada corrida arranca con una
       carpeta de datos nueva, así que no hay tinta de una corrida anterior.
       Si la capa no arranca vacía, el trazosEnTodo === 1 de abajo lo dice. */
    const est = await import('./js/estado.js');

    // Volver arriba: el trazo va en la página 1 y así la captura la muestra.
    document.getElementById('qr-visor').scrollTop = 0;
    document.getElementById('qr-tinta-toggle').click();
    await new Promise((r) => setTimeout(r, 500));

    // Fibra: color rojo, fácil de distinguir del texto negro del documento.
    document.querySelector('[data-tinta-tool="fibra"]')?.click();
    await new Promise((r) => setTimeout(r, 200));

    const pliego = document.querySelector('#view .qr-pliego[data-pagina="1"]');
    const canvas = pliego?.querySelector('.qr-tinta');
    if (!canvas) return { error: 'sin canvas de tinta' };

    /* setPointerCapture rechaza un pointerId que no existe de verdad. Se
       neutraliza acá, en el test, y no en stroke.js: ese archivo vino de
       Scrawl sin cambios y así se queda. */
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};

    const r = canvas.getBoundingClientRect();
    const disparar = (tipo, fx, fy, presion) => canvas.dispatchEvent(new PointerEvent(tipo, {
      pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      pressure: presion, buttons: tipo === 'pointerup' ? 0 : 1,
      clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
    }));

    // Una línea horizontal en la mitad baja de la hoja, lejos del texto.
    disparar('pointerdown', 0.2, 0.62, 0.5);
    for (let i = 1; i <= 12; i++) disparar('pointermove', 0.2 + i * 0.05, 0.62, 0.4 + i * 0.04);
    disparar('pointerup', 0.8, 0.62, 0);
    await new Promise((res) => setTimeout(res, 500));

    const capa = est.S.tinta;
    const trazo = capa.trazos(1)[0];

    // ¿Se ve en el canvas de tinta? Se lee una copia (PIXELES, en _comun.cjs).
    let rojos = 0;
    if (canvas.width > 2) {
      const d = ${PIXELES}(canvas);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 130 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 120) rojos++;
      }
    }

    return {
      trazosEnLa1: capa.trazos(1).length,
      /* Total del documento, no de la página: si el canvas quedara cableado
         dos veces, cada trazo se guardaría duplicado y en pantalla no se
         notaría —los dos caen exactamente encima—. El contador es lo único
         que lo delata. */
      trazosEnTodo: capa.cuenta,
      puntos: trazo?.puntos.length ?? 0,
      herramienta: trazo?.herramienta,
      color: trazo?.color,
      // Guardados en coordenadas de PÁGINA (pt), no en píxeles de pantalla.
      primerPunto: trazo?.puntos[0]?.map((v) => Math.round(v * 10) / 10),
      presionVariable: trazo ? new Set(trazo.puntos.map((p) => Math.round(p[2] * 20))).size > 1 : false,
      pixelesRojos: rojos,
      cuenta: ${vivo('#qr-tinta-cuenta')},
      // La barra: no alcanza con que exista y no esté hidden — hay que ver
      // DÓNDE cae y si de verdad se está pintando.
      barra: (() => {
        const b = document.getElementById('qr-tintabarra');
        if (!b) return 'no existe';
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        const btn = b.querySelector('.qr-tool')?.getBoundingClientRect();
        return {
          hidden: b.hidden,
          display: cs.display,
          opacity: cs.opacity,
          animation: cs.animationName,
          rect: { y: Math.round(r.top), alto: Math.round(r.height), ancho: Math.round(r.width) },
          botones: b.querySelectorAll('.qr-tool').length,
          colores: b.querySelectorAll('.qr-color').length,
          primerBoton: btn ? { y: Math.round(btn.top), alto: Math.round(btn.height) } : null,
        };
      })(),
    };
  })()`)]);
  {
    const n = ultima();
    if (n.error) problemas.push('tinta-stylus: ' + n.error);
    else {
      exigir('tinta-stylus', n.pixelesRojos > 50, `el trazo no se ve en el canvas de tinta (${n.pixelesRojos} píxeles rojos)`);
      exigir('tinta-stylus', n.trazosEnTodo === 1, `un trazo dibujado y la capa cuenta ${n.trazosEnTodo}: ¿el canvas quedó cableado dos veces?`);
    }
  }

  /* El guardado en disco va con 900 ms de debounce y al terminar vuelve a
     avisar que la capa cambió. Se espera a que eso pase ANTES de capturar y de
     dar por buena la barra: si algo desincroniza el contador, es justo ahí.
     La señal es la capa limpia; los 300 ms de después, el aviso de vuelta. */
  await senal('el guardado de la tinta', `import('./js/estado.js').then(({ S }) => S.tinta && !S.tinta.sucia)`, 6000);
  await esperar(300);
  notas.push(['tinta-asentada', await js(`(async () => {
    const { S } = await import('./js/estado.js');
    return {
      cuenta: ${vivo('#qr-tinta-cuenta')},
      trazos: S.tinta?.cuenta,
      sucia: S.tinta?.sucia,
      guardadoEnDisco: (await window.onyx.col('tinta').list()).length,
    };
  })()`)]);
  {
    const n = ultima();
    exigir('tinta-asentada', !n.sucia, 'la capa sigue sucia después del guardado');
    exigir('tinta-asentada', n.guardadoEnDisco === 1, `en disco hay ${n.guardadoEnDisco} archivos de tinta, no 1`);
  }

  /* La rueda tiene que seguir scrolleando el documento CON el modo de
     anotación activo. Un WheelEvent sintético no produce scroll de verdad
     —los eventos fabricados no disparan el comportamiento por defecto—, así
     que se mide lo único que decide si el navegador va a scrollear:
     `defaultPrevented`. Si algo llamó preventDefault, la rueda está muerta. */
  notas.push(['rueda', await js(`(() => {
    const canvas = document.querySelector('#view .qr-pliego[data-pagina="1"] .qr-tinta');
    const visor = document.getElementById('qr-visor');
    if (!canvas) return { error: 'sin canvas' };

    const tirar = (opts) => {
      const e = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true, ...opts });
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };

    // Scroll normal sobre el canvas de tinta: nadie debe cancelarlo.
    const scrollBloqueado = tirar({});
    // Ctrl+rueda: acá SÍ se cancela, porque el zoom lo maneja el visor.
    const zoomTomado = tirar({ ctrlKey: true });

    return {
      anotando: visor.classList.contains('is-anotando'),
      scrollBloqueado,
      zoomTomado,
      // Y sobre el visor pelado, sin canvas de por medio.
      sobreElVisor: (() => {
        const e = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
        visor.dispatchEvent(e);
        return e.defaultPrevented;
      })(),
    };
  })()`)]);
  {
    const n = ultima();
    if (n.error) problemas.push('rueda: ' + n.error);
    else {
      exigir('rueda', !n.scrollBloqueado, 'con la tinta prendida, la rueda sobre la hoja no scrollea (preventDefault)');
      exigir('rueda', n.zoomTomado, 'Ctrl+rueda sobre la hoja no lo toma el zoom del visor');
      exigir('rueda', !n.sobreElVisor, 'la rueda sobre el visor no scrollea (preventDefault)');
    }
  }

  /* ── 6-ter. La goma, con el mismo stylus ─────────────────────────────────
     Una pasada vertical que cruza el trazo rojo por el medio, RÁPIDA: tres
     puntos y listo. Así el hueco entre dos muestras de la goma es más grande
     que la goma misma, y lo que se mide es que el editor rellene el camino —
     sin eso, la pasada pasa entre dos círculos y no borra nada. Lo que tiene
     que quedar es el trazo partido en dos, con un solo deshacer que lo vuelva
     a juntar. */
  notas.push(['goma', await js(`(async () => {
    const est = await import('./js/estado.js');
    const capa = est.S.tinta;
    if (!capa) return { error: 'sin capa' };

    const antes = { trazos: capa.trazos(1).length, historial: capa.historial.length };
    const original = capa.trazos(1)[0];

    document.querySelector('[data-tinta-tool="borrador"]')?.click();
    await new Promise((r) => setTimeout(r, 150));

    /* El canvas se busca RECIÉN ACÁ, y tiene que estar quieto. El paso de la
       rueda de arriba manda un Ctrl+rueda que hace zoom, y el visor redibuja
       las hojas con canvas nuevos: agarrado antes, el canvas quedaba fuera del
       DOM, medía 0×0 y la pasada caía en la esquina de la hoja. Pasaba o no
       según cuánto tardara el redibujo. Se espera a que el de la página 1 siga
       siendo el mismo dos lecturas seguidas. */
    const tintaDeLa1 = () => document.querySelector('#view .qr-pliego[data-pagina="1"] .qr-tinta');
    let canvas = null;
    for (let i = 0; i < 30; i++) {
      const a = tintaDeLa1();
      await new Promise((r) => setTimeout(r, 120));
      if (a && a === tintaDeLa1() && a.isConnected && a.getBoundingClientRect().width > 0) { canvas = a; break; }
    }
    if (!canvas) return { error: 'el canvas de la página 1 nunca se quedó quieto' };

    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const r = canvas.getBoundingClientRect();
    const disparar = (tipo, fx, fy) => canvas.dispatchEvent(new PointerEvent(tipo, {
      pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      pressure: tipo === 'pointerup' ? 0 : 0.5, buttons: tipo === 'pointerup' ? 0 : 1,
      clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
    }));
    // de arriba a abajo por x = 0.5, donde el trazo va de 0.2 a 0.8
    disparar('pointerdown', 0.5, 0.55);
    disparar('pointermove', 0.5, 0.62);
    disparar('pointermove', 0.5, 0.69);
    disparar('pointerup', 0.5, 0.69);
    await new Promise((r) => setTimeout(r, 300));

    const pedazos = capa.trazos(1);
    const xs = pedazos.map((t) => [Math.round(t.puntos[0][0]), Math.round(t.puntos.at(-1)[0])]);
    const resultado = {
      antes,
      pedazos: pedazos.length,
      historial: capa.historial.length,
      // el hueco: el primer pedazo termina antes de la mitad y el segundo empieza después
      hueco: xs,
      mismaHerramienta: pedazos.every((t) => t.herramienta === original?.herramienta && t.color === original?.color),
      deshecho: (capa.deshacer(), capa.trazos(1).length),
      vuelveEntero: capa.trazos(1)[0]?.id === original?.id,
      rehecho: (capa.rehacer(), capa.trazos(1).length),
    };
    // La captura de la tinta va con el trazo partido: es lo nuevo que hay que ver.
    document.querySelector('[data-tinta-tool="fibra"]')?.click();
    return resultado;
  })()`)]);
  {
    const g = ultima();
    if (g.error) problemas.push('goma: ' + g.error);
    else {
      if (g.antes.trazos !== 1) problemas.push(`goma: arrancó con ${g.antes.trazos} trazos, no con 1`);
      if (g.pedazos !== 2) problemas.push(`goma: tenía que partir el trazo en 2 y quedaron ${g.pedazos}`);
      if (g.historial !== g.antes.historial + 1) problemas.push(`goma: la pasada tiene que ser UNA entrada del historial (${g.antes.historial} → ${g.historial})`);
      if (!g.mismaHerramienta) problemas.push('goma: los pedazos perdieron la herramienta o el color');
      if (g.deshecho !== 1 || !g.vuelveEntero) problemas.push(`goma: deshacer no devolvió el trazo entero (${g.deshecho}, entero ${g.vuelveEntero})`);
      if (g.rehecho !== 2) problemas.push(`goma: rehacer no volvió a partirlo (${g.rehecho})`);
    }
  }
  await esperar(300);

  await foto('humo-tinta.png');
  await foto('humo.png');

  // ── 7. La vista de imprimir: el preview y el marco no imprimible ─────────
  await js(`(async () => {
    const router = (await import('./js/router.js')).default;
    router.go('imprimir');
  })()`).catch((e) => problemas.push('ir a imprimir: ' + e.message));

  /* La hoja que se ve: la primera que no se está yendo. El cambio de hoja va
     a pasar a un fundido (imprimir-03: la nueva entra debajo y la vieja se
     esfuma cuando la nueva está pintada), y durante ese rato hay dos; un
     querySelector suelto podía agarrar la que se va. */
  const HOJA = `[...document.querySelectorAll('#view .qr-pliego--preview')]
    .find((h) => h.dataset.state !== 'closing' && !h.closest('.ox-swap-out') && +getComputedStyle(h).opacity > 0.99)`;
  /* El preview está cuando esa hoja tiene la clase y bitmap, y nada del
     preview se está moviendo todavía (ninguna animación finita corriendo).
     `extra` es lo que además tiene que cumplir esa hoja (apaisada, en el
     folleto). */
  const previewListo = (extra = 'true') => `(() => {
    const hoja = ${HOJA};
    const cv = hoja?.querySelector('canvas.qr-hoja');
    const r = hoja?.getBoundingClientRect();
    const moviendose = [...document.querySelectorAll('#view .qr-pliego--preview')]
      .flatMap((h) => h.getAnimations({ subtree: true }))
      .some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
    return !!hoja && !moviendose && hoja.classList.contains('is-pintada') && !!cv && cv.width > 2 && (${extra});
  })()`;
  await senal('el preview de Imprimir', previewListo(), 20000);

  notas.push(['imprimir', await js(`(() => {
    const hoja = ${HOJA};
    const marco = document.querySelector('#view .qr-noimprimible');
    /* Lo que de verdad importa: que la tinta que se dibujó en el lector esté
       en el PDF impuesto. El preview rasteriza ese PDF, así que si hay rojo
       acá es porque el trazo se escribió en el archivo que va a la impresora. */
    const cv = hoja?.querySelector('canvas.qr-hoja');
    let tintaEnElPreview = 0;
    if (cv && cv.width > 2) {
      const d = ${PIXELES}(cv);
      // Opacos, como en el canvas de tinta del lector: un rojo sin alfa no se ve.
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 130 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 120) tintaEnElPreview++;
      }
    }
    const r = hoja?.getBoundingClientRect();
    const cs = marco ? getComputedStyle(marco) : null;
    const num = (v) => Math.round(parseFloat(v) * 100) / 100;
    return {
      hojaPintada: !!hoja?.classList.contains('is-pintada'),
      hoja: r ? { ancho: Math.round(r.width), alto: Math.round(r.height) } : null,
      // La hoja tiene que caer DENTRO de la ventana, no en el limbo.
      dentroDeLaVentana: !!(r && r.top > 40 && r.left > 0 && r.bottom < window.innerHeight + 1),
      marcoPresente: !!marco,
      bordes: cs ? {
        top: num(cs.borderTopWidth), right: num(cs.borderRightWidth),
        bottom: num(cs.borderBottomWidth), left: num(cs.borderLeftWidth),
      } : null,
      // 3,97 mm sobre 210 mm de ancho de hoja: la proporción tiene que dar.
      proporcionIzquierda: cs && r ? Math.round(parseFloat(cs.borderLeftWidth) / r.width * 21000) / 100 : null,
      modos: document.querySelectorAll('.qr-modo').length,
      resumen: ${vivo('.qr-resumen__cifra .ox-stat__value')},
      nav: ${vivo('#qr-preview-nav')},
      tintaEnElPreview,
      lienzo: cv ? { ancho: cv.width, alto: cv.height } : null,

      /* El pie del rail y la barra de la vista quedan pegados uno al lado del
         otro, arriba de la statusbar, y sus bordes superiores se leen como UNA
         línea cruzando la ventana. Si no miden lo mismo se ve el escalón — eran
         11,5 px, y en el DOM no se nota: los dos elementos existen, están
         visibles y cada uno mide lo que le corresponde por su contenido. Solo
         aparece comparando los dos. */
      franjaInferior: (() => {
        const pie = document.querySelector('.ox-rail__foot');
        const barra = document.querySelector('#view .qr-preview__nav');
        if (!pie || !barra) return { error: 'falta alguna de las dos barras' };
        const a = pie.getBoundingClientRect();
        const b = barra.getBoundingClientRect();
        return {
          altoPie: Math.round(a.height), altoBarra: Math.round(b.height),
          escalonArriba: Math.round(Math.abs(a.top - b.top)),
          escalonAbajo: Math.round(Math.abs(a.bottom - b.bottom)),
        };
      })(),
    };
  })()`)]);

  {
    const n = ultima();
    exigir('imprimir', n.hojaPintada, 'la hoja del preview no se pintó');
    exigir('imprimir', n.dentroDeLaVentana, `la hoja del preview cae fuera de la ventana (${JSON.stringify(n.hoja)})`);
    /* Por cada 100 000 píxeles del canvas, y no un número absoluto (revisión
       del paquete 0C): los píxeles rojos crecen con el área del canvas, o sea
       con devicePixelRatio² y con la escala del preview, igual que el rojizo
       propio del cobayo. Un umbral fijo (era 150) se corría con otro DPR o
       si cambia el tamaño de la hoja del preview. Medido al revés (octubre
       2026, con bytesParaImprimir sin aplanar la tinta, ventana de 1400x900,
       canvas de 391x554): 56 píxeles rojos sin el trazo (26 por 100k), contra
       262 con él (121 por 100k). 60 queda a algo más de 2x de cada lado.
       Sigue dependiendo del ancho del trazo y de cuánto borra la goma en
       6-ter: si un cambio de esos lo acerca a 60, volver a medir la base. */
    const area = n.lienzo ? n.lienzo.ancho * n.lienzo.alto : 0;
    const densidad = area ? Math.round(n.tintaEnElPreview / area * 100000) : 0;
    exigir('imprimir', densidad > 60, `la tinta del lector no llegó al PDF impuesto (${n.tintaEnElPreview} píxeles rojos en un canvas de ${n.lienzo ? n.lienzo.ancho + 'x' + n.lienzo.alto : 'nada'}: ${densidad} por 100k; sin el trazo daba 26 y con él 121: si cambió el trazo o la goma, volver a medir la base)`);
    const f = n.franjaInferior;
    if (f?.error) problemas.push('franja: ' + f.error);
    else if (f) {
      if (f.escalonArriba !== 0) {
        problemas.push(`franja: el pie del rail (${f.altoPie} px) y la barra del preview (${f.altoBarra} px) no arrancan a la misma altura: ${f.escalonArriba} px de escalón`);
      }
      if (f.escalonAbajo !== 0) problemas.push(`franja: tampoco terminan igual (${f.escalonAbajo} px)`);
    }
  }

  // Cambiar a folleto: el resumen y el papel tienen que cambiar solos.
  await js(`document.querySelector('.qr-modo[data-value="folleto"]').click()`).catch(() => {});
  // La señal: la hoja nueva, apaisada y ya pintada.
  await senal('el preview del folleto', previewListo('r.width > r.height'), 20000);

  notas.push(['folleto', await js(`(() => {
    const hoja = ${HOJA};
    const c = hoja?.querySelector('canvas.qr-hoja');
    const r = hoja?.getBoundingClientRect();
    return {
      apaisada: !!(r && r.width > r.height),
      opacidadCanvas: c ? getComputedStyle(c).opacity : null,
      /* Tinta de verdad, no la clase 'is-pintada': la clase dice que el render
         terminó, no qué quedó en el bitmap. Contar píxeles es lo único que
         distingue «pintó» de «dijo que pintó».
         Además se cuenta por mitades: en un folleto tiene que haber papel con
         letras de los DOS lados, o la imposición puso las dos páginas
         encimadas. Y papel con letras, no «oscuros»: una hoja negra tiene
         oscuros de los dos lados. */
      hoja: ${leerHoja('c', { mitades: true })},
      resumen: ${vivo('.qr-resumen__cifra .ox-stat__value')},
      duplexActivo: document.querySelector('#op-duplex .ox-segmented__opt.is-active')?.textContent,
      nav: ${vivo('#qr-preview-nav')},
    };
  })()`)]);
  {
    const n = ultima();
    exigir('folleto', n.apaisada, 'la hoja del folleto no es apaisada');
    const [izq, der] = n.hoja.lados || [];
    const faltaIzq = n.hoja.motivo || faltaContenido(izq);
    const faltaDer = n.hoja.motivo || faltaContenido(der);
    exigir('folleto', !faltaIzq, `la mitad izquierda del folleto no es papel con letras: ${faltaIzq} (${n.hoja.lienzo})`);
    exigir('folleto', !faltaDer, `la mitad derecha del folleto no es papel con letras: ${faltaDer} (${n.hoja.lienzo})`);
  }

  await foto('humo-imprimir.png');

  /* ── 7-bis. El campo de copias ────────────────────────────────────────────
     Sobre el campo REAL, no sobre la demo de Piezas: lo que importa es que la
     flecha mueva el plan de impresión, no solo el valor del input. El resumen
     de la derecha ("N hojas") es la prueba de que el cambio llegó hasta el
     final de la cadena. */
  notas.push(['copias', await js(`(async () => {
    const root = document.getElementById('op-copias-stepper');
    if (!root) return { error: 'no existe el stepper de copias' };
    const input = document.getElementById('op-copias');
    const arriba = root.querySelector('[data-step="up"]');
    // Lo vivo: si el resumen pasa a relevarse, el textContent pegaría las dos cifras.
    const cifra = () => ${vivo('.qr-resumen__cifra .ox-stat__value')};

    const antesValor = input.value;
    const antesHojas = cifra();

    const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
    arriba.dispatchEvent(new PointerEvent('pointerdown', o));
    arriba.dispatchEvent(new PointerEvent('pointerup', o));
    await new Promise((r) => setTimeout(r, 260));

    /* Se vuelve a consultar el DOM. Hoy el 'change' de copias no repinta el
       panel (cambiar con repintar: false, y con imprimir-04 el panel se arma
       una sola vez), pero si algún cambio lo rehiciera, las referencias de
       arriba quedarían en nodos desprendidos: de un nodo suelto,
       getComputedStyle devuelve todo vacío y getBoundingClientRect ceros, y un
       componente sano parecería roto. */
    const root2 = document.getElementById('op-copias-stepper');
    const input2 = document.getElementById('op-copias');
    const arriba2 = root2?.querySelector('[data-step="up"]');
    if (!root2 || !input2 || !arriba2) return { error: 'el repintado se llevó el stepper' };

    const btn = arriba2.getBoundingClientRect();
    const caja = root2.getBoundingClientRect();
    return {
      antesValor, valor: input2.value,
      antesHojas, hojas: cifra(),
      // Las flechas tienen que caer DENTRO del campo, no al lado ni encima.
      flechaDentro: btn.right <= caja.right + 1 && btn.top >= caja.top - 1 && btn.width > 6 && btn.height > 6,
      apariencia: getComputedStyle(input2).appearance,
      spinnerNativo: getComputedStyle(input2, '::-webkit-inner-spin-button').appearance,
      alto: Math.round(btn.height),
    };
  })()`)]);

  {
    const c = ultima();
    if (c.error) problemas.push('copias: ' + c.error);
    else {
      if (c.valor !== '2') problemas.push(`copias: la flecha dejó el campo en ${c.valor}, no en 2`);
      if (c.hojas === c.antesHojas) problemas.push(`copias: el resumen no se movió (${c.antesHojas})`);
      if (!c.flechaDentro) problemas.push('copias: las flechas caen fuera del campo');
      if (c.apariencia !== 'textfield') problemas.push(`copias: el input sigue en appearance ${c.apariencia}`);
    }
  }

  // ── 8. Organizar páginas ─────────────────────────────────────────────────
  await js(`(async () => (await import('./js/router.js')).default.go('paginas'))()`).catch((e) => problemas.push('ir a paginas: ' + e.message));
  // La señal: todas las miniaturas con su canvas.
  await senal('las miniaturas de Páginas', `(() => {
    const items = document.querySelectorAll(${JSON.stringify(sinSalir('#view .qr-org__item'))});
    return items.length > 0 && [...items].every((i) => i.querySelector('canvas'));
  })()`);

  notas.push(['paginas', await js(`(() => {
    // Las filas que se quedan: con reconcile, las que se quitan siguen un rato en el DOM.
    const filas = () => [...document.querySelectorAll(${JSON.stringify(sinSalir('#view .qr-org__item'))})];
    const items = filas();
    // Seleccionar la 2 y la 3, girar y quitar una.
    items[1]?.click();
    items[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const exportarPNG = document.getElementById('org-exportar-png');
    const exportarPNGHabilitado = !!exportarPNG && !exportarPNG.disabled;
    document.getElementById('org-rotar-der')?.click();
    // El chip del giro vive siempre en la fila (se pliega con hidden): cuentan los prendidos.
    const trasRotar = filas().filter((i) => i.querySelector('.qr-org__giro:not([hidden])')).length;
    document.getElementById('org-borrar')?.click();
    return {
      items: items.length,
      conMiniatura: items.filter((i) => i.querySelector('canvas')).length,
      exportarPNGExiste: !!exportarPNG,
      exportarPNGHabilitado,
      trasRotar,
      trasBorrar: filas().length,
      guardarHabilitado: !document.getElementById('org-guardar')?.disabled,
      estado: ${vivo('#org-estado')},
    };
  })()`)]);

  {
    const p = ultima();
    if (!p.exportarPNGExiste) problemas.push('paginas: falta la acción Exportar como PNG');
    if (!p.exportarPNGHabilitado) problemas.push('paginas: Exportar como PNG no se habilita con la selección');
    exigir('paginas', p.trasRotar === 2, `giré 2 páginas y ${p.trasRotar} muestran el giro`);
    exigir('paginas', p.trasBorrar === p.items - 2, `quité 2 de ${p.items} y quedaron ${p.trasBorrar}`);
  }

  /* El cambio de vista funde la vieja en un calco de t-2 (180 ms) y lo que
     se quita en Páginas sale esfumándose. capturePage() devuelve el último
     cuadro COMPUESTO: capturando enseguida sale el calco a medio irse. Se
     espera a que no quede calco y a que terminen las salidas. */
  await senal('que se vaya el calco de Páginas', `!document.querySelector('.ox-main--saliente') && !document.querySelector('#view [data-state="closing"]')`, 5000);
  await esperar(120);
  await foto('humo-paginas.png');

  // ── 9. Herramientas ──────────────────────────────────────────────────────
  /* El panel se busca como hijo DIRECTO de #herr-cuerpo: si el cambio de
     pestaña pasa a un relevo, el panel que se va queda adentro del calco
     (.ox-swap-out), un nivel más abajo, y un '.qr-herr__panel' suelto podría
     agarrar ese. */
  const PANEL = JSON.stringify(sinSalir('#herr-cuerpo > .qr-herr__panel:not(.ox-swap-out)'));
  await js(`(async () => (await import('./js/router.js')).default.go('herramientas'))()`).catch((e) => problemas.push('ir a herramientas: ' + e.message));
  await senal('el panel de Herramientas', `!!document.querySelector(${PANEL})`);

  /* Click, ESPERAR al panel de esa pestaña, y recién ahí medir. Hoy el cambio
     es sincrónico (pintarSeccion() hace innerHTML en el click), pero si pasa
     a salida-y-después-entrada o a un relevo, en el instante del click no hay
     panel vivo, o el vivo todavía es el de la pestaña anterior: medir en la
     misma tarea daría rojo con la app sana. Los paneles no dicen de qué
     pestaña son; lo que los distingue es su texto de presentación, así que
     se espera a que la pestaña quede activa y la intro del panel vivo sea
     otra que la de la pestaña anterior. */
  const herramientas = { tabs: await js(`document.querySelectorAll('#view .ox-tab').length`), secciones: {} };
  let introAnterior = null;
  for (const id of ['combinar', 'dividir', 'exportar']) {
    await js(`document.querySelector('#view .ox-tab[data-value="${id}"]')?.click()`);
    const intro = await senal(`el panel de la pestaña ${id}`, `(() => {
      const tab = document.querySelector('#view .ox-tab.is-active');
      const panel = document.querySelector(${PANEL});
      const intro = panel?.querySelector('.qr-herr__intro')?.textContent.trim() || '';
      return tab?.dataset.value === ${JSON.stringify(id)} && !!panel
        && intro !== ${JSON.stringify(introAnterior)} && (intro || '(sin intro)');
    })()`, 5000);
    if (intro) introAnterior = intro;
    herramientas.secciones[id] = await js(`(() => {
      const panel = document.querySelector(${PANEL});
      return {
        monta: !!panel,
        botones: panel ? panel.querySelectorAll('button').length : 0,
        alto: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      };
    })()`);
  }
  // Queda en exportar, que es el que tiene más para mirar (fue la última del recorrido).
  notas.push(['herramientas', herramientas]);
  for (const [id, sec] of Object.entries(herramientas.secciones)) {
    exigir('herramientas', sec.monta && sec.botones > 0, `la pestaña ${id} no montó su panel (${JSON.stringify(sec)})`);
  }

  /* Se vuelve a medir DESPUÉS de que se asiente, en el mismo instante que la
     captura. Una vista puede medir bien apenas montada y verse vacía un frame
     después —animaciones de entrada, repintados encadenados—, y entonces el
     test dice una cosa y la pantalla muestra otra. Asentado es: sin calco,
     y el panel con su entrada terminada (opacidad 1). */
  await senal('que se asiente Herramientas', `(() => {
    const p = document.querySelector(${PANEL});
    return !document.querySelector('.ox-main--saliente') && !!p && getComputedStyle(p).opacity === '1';
  })()`, 5000);
  notas.push(['herramientas-asentada', await js(`(() => {
    const panel = document.querySelector(${PANEL});
    const cs = panel ? getComputedStyle(panel) : null;
    const r = panel?.getBoundingClientRect();
    return {
      tabActiva: ${vivo('#view .ox-tab.is-active')},
      panelExiste: !!panel,
      opacity: cs?.opacity,
      alto: r ? Math.round(r.height) : 0,
      dentroDeLaVentana: !!(r && r.top > 0 && r.top < window.innerHeight && r.height > 40),
      dpis: document.querySelectorAll('#view .qr-dpi').length,
      dpiActivo: document.querySelector('#view .qr-dpi.is-active .qr-dpi__n')?.textContent,
      medida: ${vivo('#view .ox-field__hint b')},
    };
  })()`)]);
  {
    const n = ultima();
    exigir('herramientas-asentada', n.panelExiste, 'no hay panel después de asentarse');
    exigir('herramientas-asentada', n.opacity === '1', `el panel quedó en opacidad ${n.opacity}`);
    exigir('herramientas-asentada', n.dentroDeLaVentana, `el panel cae fuera de la ventana (alto ${n.alto})`);
  }

  await foto('humo-herramientas.png');

  /* ── 9-bis. La puerta de las imágenes ────────────────────────────────────
     Combinar acepta PNG/JPEG/WEBP; el lector NO. Es la misma función `leer`
     con una opción de diferencia, así que lo único que separa las dos cosas es
     que esa opción esté puesta donde va y en ningún otro lado. Se ejercita por
     el IPC de verdad, con un PNG escrito en disco por la app misma. */
  notas.push(['imagenes-ipc', await js(`(async () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const cx = c.getContext('2d');
    cx.fillStyle = '#c33'; cx.fillRect(0, 0, 64, 32);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const bytes = await blob.arrayBuffer();

    const carpeta = ${JSON.stringify(path.join(RAIZ, 'test'))};
    const ruta = await window.onyx.docs.escribir(carpeta, 'humo-imagen.png', bytes);

    const comoImagen = await window.onyx.docs.leer(ruta, { imagenes: true });
    let comoDocumento = null;
    try { await window.onyx.docs.leer(ruta); } catch (e) { comoDocumento = e.message; }

    // Y el PDF de siempre tiene que seguir entrando por las dos puertas.
    const pdf = await window.onyx.docs.leer(${JSON.stringify(PDF)});

    return {
      escribio: !!ruta,
      tipo: comoImagen.tipo,
      formato: comoImagen.formato,
      trajoBytes: comoImagen.bytes?.byteLength > 0,
      // El lector la rechaza, y lo dice.
      rechazoDelLector: comoDocumento,
      pdfSigueSiendoPdf: pdf.tipo === 'pdf' && pdf.formato === 'pdf',
    };
  })()`).catch((e) => ({ error: e.message }))]);

  {
    const n = ultima();
    if (n.error) problemas.push('imagenes-ipc: ' + n.error);
    else {
      if (n.tipo !== 'imagen' || n.formato !== 'png') problemas.push(`imagenes-ipc: leyó ${n.formato}/${n.tipo}, no png/imagen`);
      if (!n.trajoBytes) problemas.push('imagenes-ipc: no llegaron los bytes');
      if (!/%PDF/.test(n.rechazoDelLector || '')) {
        problemas.push(`imagenes-ipc: el lector NO rechazó la imagen (${n.rechazoDelLector})`);
      }
      if (!n.pdfSigueSiendoPdf) problemas.push('imagenes-ipc: el PDF dejó de reconocerse como PDF');
    }
    fs.rmSync(path.join(RAIZ, 'test', 'humo-imagen.png'), { force: true });
  }

  /* ── 10. Abrir un PDF desde la pantalla de inicio ─────────────────────────
     El escenario del bug: parado en "no hay ningún documento", abrís uno y no
     aparece hasta cambiar de vista y volver. La causa era que la vista se
     suscribía a los cambios DESPUÉS del early return, así que en su estado
     vacío no escuchaba nada — y Router.go('lector') no repinta si ya estás
     en 'lector'. Se ejercita sin tocar la navegación en ningún momento.

     Ojo con el cierre: en Páginas quedaron dos páginas quitadas y dos
     giradas, sin guardar. Con la guardia de cierre de Páginas (ux-03) cerrar
     esa pestaña pregunta, y un await pelado de cerrar() esperaría para
     siempre a un modal que nadie contesta. Si aparece, se confirma, y se
     anota que preguntó y qué se apretó.
     El botón se elige por su variante, no por su lugar: Modal.confirm pone
     el de confirmar al final, pero una guardia hecha con Modal.show puede
     traer Guardar, Descartar y Cancelar en cualquier orden, y apretar el de
     la punta podía ser Cancelar (cerrar() vuelve sin cerrar y lo que falla
     después no apunta a la causa) o Guardar (escribiría el cobayo, que está
     versionado y se empaqueta, o abriría un diálogo nativo que cuelga hasta
     el timeout). Primero el de descartar, en cualquiera de las dos variantes
     de peligro: Modal.confirm usa danger-solid, pero una guardia armada con
     Modal.show puede traer «Descartar» como danger a secas y «Guardar» como
     primario (revisión del paquete 0C). El primario se aprieta solo si no
     dice guardar: es el «Cerrar» de un confirm sin peligro. Si no hay ninguno
     que sirva, no se aprieta nada y va a problemas qué modal apareció.
     Se miden solo los nodos de #view: el calco de la vista que se va es su
     hermano y todavía puede tener pliegos. */
  const BOTON_DE_CERRAR = `((foot) => {
    const primario = foot.querySelector('.ox-btn--primary');
    return foot.querySelector('.ox-btn--danger-solid, .ox-btn--danger')
      || (primario && !/guard/i.test(primario.textContent) ? primario : null);
  })`;
  /* La elección del botón, probada sola: hoy la guardia no existe, así que
     el bloque de abajo nunca ve un modal y la elección no se ejercitaría
     hasta que 2E la sume. Tres pies de modal armados a mano, con las clases
     de Onyx: el de una guardia con Modal.show, el de Modal.confirm con
     peligro y uno que solo ofrece guardar. */
  notas.push(['boton-de-cerrar', await js(`(() => {
    const pie = (botones) => {
      const foot = document.createElement('div');
      foot.innerHTML = botones.map(([v, t]) => '<button class="ox-btn ox-btn--' + v + '">' + t + '</button>').join('');
      return foot;
    };
    const elegir = (botones) => (${BOTON_DE_CERRAR})(pie(botones))?.textContent ?? null;
    return {
      show: elegir([['ghost', 'Cancelar'], ['danger', 'Descartar'], ['primary', 'Guardar']]),
      confirm: elegir([['ghost', 'Cancelar'], ['danger-solid', 'Cerrar sin guardar']]),
      soloGuardar: elegir([['ghost', 'Cancelar'], ['primary', 'Guardar cambios']]),
    };
  })()`)]);
  {
    const n = ultima();
    exigir('boton-de-cerrar', n.show === 'Descartar', `en una guardia con Guardar, Descartar y Cancelar el humo apretaría «${n.show}»`);
    exigir('boton-de-cerrar', n.confirm === 'Cerrar sin guardar', `en un Modal.confirm con peligro apretaría «${n.confirm}»`);
    exigir('boton-de-cerrar', n.soloGuardar === null, `si el modal solo ofrece guardar apretaría «${n.soloGuardar}», y eso escribe el cobayo`);
  }

  notas.push(['desde-inicio', await js(`(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;

    router.go('lector');
    await new Promise((r) => setTimeout(r, 500));

    let pregunto = false;
    let apretado = null;
    let modalRaro = null;
    let cerro = false;
    const cerrando = est.cerrar().then(() => { cerro = true; });
    for (let i = 0; i < 100 && !cerro; i++) {
      const foot = document.querySelector('#ox-layer .ox-modal:not([data-state="closing"]) .ox-modal__foot');
      if (foot && !pregunto) {
        pregunto = true;
        const confirmar = ${BOTON_DE_CERRAR}(foot);
        if (confirmar) { apretado = confirmar.textContent.trim(); confirmar.click(); }
        else {
          modalRaro = {
            titulo: foot.closest('.ox-modal')?.querySelector('.ox-modal__title, h2, h3')?.textContent.trim() || null,
            botones: [...foot.querySelectorAll('.ox-btn')].map((b) => b.className.replace(/ox-btn |ox-flashable/g, '').trim() + ': ' + b.textContent.trim()),
          };
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Si nadie cerró el modal, no se espera para siempre: lo de abajo lo dice.
    await Promise.race([cerrando, new Promise((r) => setTimeout(r, 1000))]);
    await new Promise((r) => setTimeout(r, 500));

    const vacio = {
      pliegos: document.querySelectorAll('#view .qr-pliego').length,
      hayCartel: !!document.querySelector('#view .ox-empty'),
      vista: router.name,
      cerro,
      pregunto,
      apretado,
      modalRaro,
    };

    // Abrir un documento SIN navegar: solo el estado cambia.
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    await est.abrir(archivo);
    /* La señal: una hoja pintada, y se lee ESA (revisión del paquete 0C).
       Antes se esperaba a cualquiera pintada y se leía la primera, pintada o
       no: si la 2 terminaba antes que la 1 (máquina cargada), se leía un
       canvas en blanco. Hasta 8 s; si no llega, lo de abajo lo dice. */
    const HOJA_PINTADA = '#view .qr-pliego.is-pintada canvas.qr-hoja';
    for (let i = 0; i < 80 && !document.querySelector(HOJA_PINTADA); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));

    return {
      vacio,
      despues: {
        pliegos: document.querySelectorAll('#view .qr-pliego').length,
        hayCartel: !!document.querySelector('#view .ox-empty'),
        pintados: document.querySelectorAll('#view .qr-pliego.is-pintada').length,
        // La hoja por su clase, y papel con letras (lo mismo que el bloque 5).
        hoja: ${leerHoja('document.querySelector(HOJA_PINTADA)', { alto: 500 })},
        vista: router.name,        // sigue siendo 'lector': no se navegó
        statusbar: ${vivo('#stat-doc-name')},
      },
    };
  })()`)]);
  {
    const { vacio, despues } = ultima();
    if (vacio.modalRaro) {
      problemas.push(`desde-inicio: cerrar la pestaña abrió un modal sin botón de confirmar (${JSON.stringify(vacio.modalRaro)})`);
    }
    exigir('desde-inicio', vacio.cerro, `cerrar() no terminó (preguntó: ${vacio.pregunto}, apreté: ${vacio.apretado})`);
    /* Pendiente ux-03 (la guardia la pone 2E): con dos páginas quitadas y dos
       giradas sin guardar, cerrar la pestaña TIENE que preguntar. Hoy la
       guardia no existe y `pregunto` da false. Este archivo no lo toca ningún
       paquete de la etapa 2 (plan, §3), así que 2E no puede activarla: queda
       anotada para 4A, que la activa cuando la guardia de 2E esté integrada:
         exigir('desde-inicio', vacio.pregunto, 'cerré una pestaña con cambios de Páginas y no preguntó'); */
    exigir('desde-inicio', vacio.hayCartel, `sin documento, el lector no muestra su cartel (${JSON.stringify(vacio)})`);
    exigir('desde-inicio', despues.pliegos > 0, 'abrí un PDF parado en el lector vacío y no aparecieron hojas');
    exigir('desde-inicio', !despues.hayCartel, 'con el documento abierto sigue el cartel de vacío');
    const falta = despues.hoja.motivo || faltaContenido(despues.hoja.lados?.[0]);
    exigir('desde-inicio', !falta, `la hoja recién abierta no es papel con letras: ${falta} (${despues.hoja.lienzo})`);
    exigir('desde-inicio', despues.vista === 'lector', `se navegó a ${despues.vista}`);
  }

  /* ── 11. El cartel de las actualizaciones ─────────────────────────────────
     Se pintan los SIETE estados a mano, sin red y sin electron-updater: lo que
     interesa es que cada uno diga algo, ofrezca los botones que corresponden y
     no se cuele ningún glifo unicode. La barra se mide en píxeles y no por su
     clase — una barra al 42% que pinta 0 px se ve exactamente igual de "bien"
     en el DOM que una que anda. */
  notas.push(['actualizar', await js(`(async () => {
    const A = await import('./js/actualizar.js');
    const base = {
      actual: '0.1.2', version: '0.1.3', nombre: 'Quire 0.1.3 — la de prueba',
      bytes: 98304000, url: 'https://github.com/kiddshady/Quire/releases',
      progreso: { pct: 0.42, transferido: 41287680, total: 98304000, bps: 2202009 },
      error: 'No se pudo llegar a GitHub. ¿Hay internet?',
      motivo: 'La versión portable no se actualiza sola.',
    };
    const caja = document.createElement('div');
    caja.style.cssText = 'position:fixed;left:8px;top:8px;width:440px;z-index:9999';
    caja.className = 'ox-modal qr-act';
    const cuerpo = document.createElement('div');
    cuerpo.className = 'qr-act__cuerpo';
    caja.appendChild(cuerpo);
    document.body.appendChild(caja);

    const GLIFOS = /[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{27BF}\\u{2B00}-\\u{2BFF}]/u;
    const fases = ['inactivo','buscando','al-dia','disponible','descargando','listo','error','sin-soporte'];
    const out = {};
    for (const fase of fases) {
      cuerpo.innerHTML = '';
      const el = A.paso({ ...base, fase });
      cuerpo.appendChild(el);
      await new Promise((r) => requestAnimationFrame(r));
      const t = el.querySelector('.qr-act__titulo');
      out[fase] = {
        titulo: (t?.textContent || '').slice(0, 40),
        sub: !!el.querySelector('.qr-act__sub')?.textContent.trim(),
        botones: [...el.querySelectorAll('[data-accion]')].map((b) => b.dataset.accion).join(','),
        marca: !!el.querySelector('.qr-act__marca svg'),
        glifos: GLIFOS.test(el.textContent),
      };
    }

    // La barra, en píxeles: 42% de la pista, no "existe el div".
    cuerpo.innerHTML = '';
    const bajando = A.paso({ ...base, fase: 'descargando' });
    cuerpo.appendChild(bajando);
    await new Promise((r) => setTimeout(r, 320));   // dejar correr la transición
    const pista = bajando.querySelector('.qr-prog');
    const fill = bajando.querySelector('.qr-prog__fill');
    const anchoPista = pista ? pista.getBoundingClientRect().width : 0;
    const anchoFill = fill ? fill.getBoundingClientRect().width : 0;

    const barra = {
      anchoPista: Math.round(anchoPista),
      anchoFill: Math.round(anchoFill),
      proporcion: anchoPista ? Math.round(anchoFill / anchoPista * 100) : 0,
      // Escalado, NO ancho: animar el ancho remaqueta en cada frame.
      usaTransform: fill ? getComputedStyle(fill).transform !== 'none' : false,
      subDice: bajando.querySelector('.qr-act__sub')?.textContent,
    };

    // Los pasos comparten celda de grid: por eso el cruce no salta.
    cuerpo.innerHTML = '';
    const a1 = A.paso({ ...base, fase: 'disponible' });
    const a2 = A.paso({ ...base, fase: 'listo' });
    cuerpo.append(a1, a2);
    const r1 = a1.getBoundingClientRect();
    const r2 = a2.getBoundingClientRect();
    const superpuestos = Math.abs(r1.top - r2.top) < 2 && Math.abs(r1.left - r2.left) < 2;

    caja.remove();
    return { estados: out, barra, superpuestos, statusbarExiste: !!document.getElementById('stat-update') };
  })()`)]);

  {
    const n = ultima();
    const esperados = {
      buscando: '', 'al-dia': 'cerrar', disponible: 'notas,despues,descargar',
      descargando: 'cerrar', listo: 'cerrar,instalar', error: 'cerrar,buscar',
      'sin-soporte': 'cerrar,notas', inactivo: 'buscar',
    };
    for (const [fase, botones] of Object.entries(esperados)) {
      const e = n.estados[fase];
      if (!e) { problemas.push(`actualizar: falta el estado ${fase}`); continue; }
      if (!e.titulo) problemas.push(`actualizar[${fase}]: sin título`);
      if (e.botones !== botones) problemas.push(`actualizar[${fase}]: botones ${e.botones} ≠ ${botones}`);
      if (e.glifos) problemas.push(`actualizar[${fase}]: se coló un glifo unicode`);
    }
    if (n.barra.proporcion < 38 || n.barra.proporcion > 46) {
      problemas.push(`actualizar: la barra al 42% mide ${n.barra.proporcion}%`);
    }
    if (!n.barra.usaTransform) problemas.push('actualizar: la barra no usa transform');
    if (!n.superpuestos) problemas.push('actualizar: los pasos no comparten celda — el cruce va a saltar');
    if (!n.statusbarExiste) problemas.push('actualizar: falta el item de la statusbar');
  }

  /* ── 12. Lo de adentro no vuelve a entrar en el calco ─────────────────────
     Al navegar, el contenido de la vista vieja se MUEVE a un calco que se
     esfuma, y mover un nodo le reinicia las animaciones CSS. Lo que tenía
     entrada propia volvía a arrancar de cero adentro de lo que se estaba
     yendo: medido en 0.9.5, las miniaturas del lector caían a 0 % y
     reaparecían (63 → 86 → 97 %) mientras el calco bajaba, y lo mismo los
     paneles de Herramientas. Son los dos casos reales; se muestrea cada 20 ms
     mientras el calco todavía se ve. */
  {
    const out = {};
    for (const [de, a, sel] of [['lector', 'paginas', '.qr-mini__lienzo'], ['herramientas', 'lector', '.qr-herr__panel']]) {
      await js(`(async () => (await import('./js/router.js')).default.go(${JSON.stringify(de)}))()`);
      await esperar(1500);
      /* El muestreo corre en la página (sin la latencia del IPC entre
         muestra y muestra), y el go() va en la misma tarea que la primera:
         el calco se agarra recién nacido. */
      out[de + '>' + a] = await js(muestrear(`(t) => {
        const hijos = calco ? [...calco.querySelectorAll(${JSON.stringify(sel)})] : [];
        return { t, calco: calco?.isConnected ? Math.round(+getComputedStyle(calco).opacity * 100) : null,
          hijos: hijos.length, minimo: hijos.length ? Math.min(...hijos.map((h) => Math.round(+getComputedStyle(h).opacity * 100))) : null };
      }`, 20, 120, `const router = (await import('./js/router.js')).default;
        router.go(${JSON.stringify(a)});
        const calco = document.querySelector('.ox-main--saliente')`));
      await esperar(400);
    }
    notas.push(['calco-quieto', out]);
  }

  {
    const n = ultima();
    for (const [caso, filas] of Object.entries(n)) {
      const serie = filas.map((f) => `${f.t}:${f.calco ?? '-'}/${f.minimo ?? '-'}`).join(' ');
      if (!filas[0].hijos) problemas.push(`calco-quieto[${caso}]: el calco no se llevó lo que había que mirar (${serie})`);
      // Mientras el calco se ve (>5 %), lo de adentro tiene que estar entero.
      else if (filas.some((f) => f.calco > 5 && f.minimo < 95)) {
        problemas.push(`calco-quieto[${caso}]: lo de adentro vuelve a entrar mientras el calco se va (${serie})`);
      }
    }
  }

  /* ── 13. Lo que se prende y se apaga con `hidden` se pliega ───────────────
     Con `display: none` a secas, la barra de tinta, la caja de fragmentos o un
     dato de la statusbar aparecían y se iban de un cuadro al otro, y
     empujaban de golpe a lo de al lado. Ahora el alto (o el ancho) se pliega
     mientras se desvanece. Se muestrea cada cuadro al prender y al apagar:
     tiene que haber medidas intermedias, y al apagar tiene que seguir en
     pantalla mientras se va. Y la barra de tinta, que cambia el alto del
     visor, no puede mandarte al principio de la página: reescalar en cada
     cuadro del pliegue lo hacía, y es caro. */
  notas.push(['plegables', await js(`(async () => {
    const router = (await import('./js/router.js')).default;
    const cuadros = (n) => new Promise((ok) => { const f = () => (--n ? requestAnimationFrame(f) : ok()); requestAnimationFrame(f); });
    // Medir un elemento en cada cuadro durante 320 ms después de disparar.
    const serie = async (el, disparar, eje) => {
      disparar();
      const out = []; const t0 = performance.now();
      while (performance.now() - t0 < 320) {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        out.push({ t: Math.round(performance.now() - t0), med: Math.round(eje === 'ancho' ? r.width : r.height),
          op: Math.round(+cs.opacity * 100), display: cs.display });
        await cuadros(1);
      }
      return out;
    };
    const resumen = (s) => {
      const fin = s.at(-1).med; const max = Math.max(...s.map((f) => f.med));
      return { serie: s.map((f) => f.t + ':' + f.med + '/' + f.op).join(' '),
        intermedias: s.filter((f) => f.med > 0 && f.med < max).length, max, fin,
        visibleAlIrse: s[0].display !== 'none' && s[0].op > 50 };
    };
    const out = {};

    // La barra de tinta, en el lector, con la hoja a mitad de página.
    router.go('lector');
    await new Promise((r) => setTimeout(r, 1200));
    const visor = document.getElementById('qr-visor');
    const barra = document.getElementById('qr-tintabarra');
    const toggle = document.getElementById('qr-tinta-toggle');
    if (barra && !barra.hidden) toggle.click();       // arrancar apagada
    await new Promise((r) => setTimeout(r, 400));
    visor.scrollTop = Math.round(visor.querySelector('.qr-pliego').offsetHeight * 0.4);
    await new Promise((r) => setTimeout(r, 200));
    const scrollAntes = visor.scrollTop;
    out.barraEntra = resumen(await serie(barra, () => toggle.click(), 'alto'));
    await new Promise((r) => setTimeout(r, 300));
    out.scrollTinta = { antes: scrollAntes, despues: visor.scrollTop };
    out.barraSale = resumen(await serie(barra, () => toggle.click(), 'alto'));
    await new Promise((r) => setTimeout(r, 300));

    // Un dato de la statusbar: se pliega el ancho, y los de al lado no saltan.
    const medida = document.getElementById('stat-medida');
    out.statSale = resumen(await serie(medida, () => { medida.hidden = true; }, 'ancho'));
    await new Promise((r) => setTimeout(r, 200));
    out.statEntra = resumen(await serie(medida, () => { medida.hidden = false; }, 'ancho'));

    // La caja de fragmentos de Convertir, que se prende con su interruptor.
    router.go('convertir');
    await new Promise((r) => setTimeout(r, 900));
    const chunks = document.querySelector('.qr-conv__chunks');
    const boton = document.querySelector('[data-salida="chunks"]');
    if (chunks && boton) {
      const prendida = !chunks.hidden;
      out.chunks1 = resumen(await serie(chunks, () => boton.click(), 'alto'));
      await new Promise((r) => setTimeout(r, 200));
      out.chunks2 = resumen(await serie(chunks, () => boton.click(), 'alto'));
      out.chunksArrancaba = prendida;
    } else out.chunksFalta = true;
    return out;
  })()`)]);

  {
    const n = ultima();
    const plegado = (quien, r, alIrse) => {
      if (!r) return problemas.push(`plegables: no se pudo medir ${quien}`);
      if (r.intermedias < 2) problemas.push(`plegables[${quien}]: pasa de golpe, sin medidas intermedias (${r.serie})`);
      if (alIrse && !r.visibleAlIrse) problemas.push(`plegables[${quien}]: desaparece en el primer cuadro en vez de irse (${r.serie})`);
    };
    plegado('barra de tinta, al prender', n.barraEntra);
    plegado('barra de tinta, al apagar', n.barraSale, true);
    if (n.barraSale && n.barraSale.fin !== 0) problemas.push(`plegables: la barra de tinta apagada sigue ocupando ${n.barraSale.fin} px`);
    if (Math.abs(n.scrollTinta.despues - n.scrollTinta.antes) > 2) {
      problemas.push(`plegables: prender la tinta movió la hoja (scroll ${n.scrollTinta.antes} → ${n.scrollTinta.despues})`);
    }
    plegado('dato de la statusbar, al esconder', n.statSale, true);
    plegado('dato de la statusbar, al mostrar', n.statEntra);
    if (n.chunksFalta) problemas.push('plegables: no encontré la caja de fragmentos de Convertir');
    else {
      plegado('caja de fragmentos, ida', n.chunks1, n.chunksArrancaba);
      plegado('caja de fragmentos, vuelta', n.chunks2, !n.chunksArrancaba);
      // El interruptor es un ajuste guardado: dos clicks lo dejan como estaba.
    }
  }

  /* ── Las dos formas de la tarjeta ─────────────────────────────────────────
     `.ox-card__body` llevaba `padding-top: 0` para no repetir el aire que el
     `__head` ya pone. Con encabezado quedaba perfecto; SIN encabezado el
     contenido se pegaba al borde de arriba — 0 px contra 16 abajo, que es como
     se veían las cuatro tarjetas de Ajustes.

     Se mide sobre Piezas y no sobre Ajustes a propósito: la vitrina es donde
     viven las dos formas, y esto sobrevivió justamente porque ahí se mostraba
     UNA tarjeta con padding inline, salteándose el componente. */
  await js(`(async () => (await import('./js/router.js')).default.go('piezas'))()`)
    .catch((e) => problemas.push('ir a piezas: ' + e.message));
  await senal('las tarjetas de Piezas', `!!document.querySelector('#view .ox-card__body')`, 5000);

  notas.push(['tarjetas', await js(`(() => {
    const cuerpos = [...document.querySelectorAll('#view .ox-card__body')].map((b) => {
      const s = getComputedStyle(b);
      return {
        head: b.previousElementSibling?.classList.contains('ox-card__head') || false,
        arriba: parseFloat(s.paddingTop),
        abajo: parseFloat(s.paddingBottom),
      };
    });
    return {
      total: cuerpos.length,
      sinHead: cuerpos.filter((c) => !c.head),
      conHead: cuerpos.filter((c) => c.head),
    };
  })()`)]);

  {
    const n = ultima();
    // Las dos formas tienen que estar: una variante que no está en la vitrina
    // no está verificada, y es exactamente así como esto pasó desapercibido.
    if (!n.sinHead.length) problemas.push('tarjetas: la vitrina no muestra la tarjeta SIN encabezado');
    if (!n.conHead.length) problemas.push('tarjetas: la vitrina no muestra la tarjeta CON encabezado');
    for (const c of n.sinHead) {
      if (!(c.arriba > 0)) problemas.push(`tarjetas: sin encabezado, el cuerpo no pone aire arriba (${c.arriba} px)`);
      else if (c.arriba !== c.abajo) problemas.push(`tarjetas: sin encabezado, arriba ${c.arriba} ≠ abajo ${c.abajo}`);
    }
    /* Y el arreglo NO puede romper el caso que ya estaba bien: con encabezado,
       repetir el padding separaría el cuerpo de su propio título. Un "arreglo"
       que le pusiera aire a los dos casos pasaría igual un test que solo mirara
       "mayor que cero". */
    for (const c of n.conHead) {
      if (c.arriba !== 0) problemas.push(`tarjetas: con encabezado, el cuerpo repite el aire (${c.arriba} px)`);
    }
  }

  informe();

  win.destroy();
  app.exit(problemas.length ? 1 : 0);
}).catch((e) => bail('excepción en el humo', e));
