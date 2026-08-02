/* Prueba de humo: monta Quire de verdad, abre un PDF y mira qué pasa.
   No alcanza con "¿existe el elemento?" — mide DÓNDE cae y si pintó tinta. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..');
const PDF = process.argv.find((a) => a.endsWith('.pdf'))
  || path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

const problemas = [];
const notas = [];

app.whenReady().then(async () => {
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  ipc.register();

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

  win.webContents.on('console-message', (e) => {
    if (e.level >= 2) problemas.push(`consola[${e.level}] ${e.message.slice(0, 200)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problemas.push(`no cargó (${code} ${desc}) → ${url}`);
  });

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();          // visible para Chromium, invisible para el usuario
  await esperar(1400);

  const js = (código) => win.webContents.executeJavaScript(código, true);

  // ── 1. El shell montó ─────────────────────────────────────────────────────
  notas.push(['shell', await js(`(() => {
    const r = {};
    r.splashSeFue = !document.getElementById('boot-splash');
    r.rail = document.querySelectorAll('.ox-navitem').length;
    r.marca = !!document.querySelector('.ox-brand__mark path');
    r.vistaMontada = !!document.querySelector('#view').children.length;
    return r;
  })()`)]);

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

  // ── 3. Abrir un PDF de verdad, por el mismo camino que usa la app ─────────
  await js(`(async () => {
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    const mod = await import('./js/estado.js');
    await mod.abrir(archivo);
    const router = (await import('./js/router.js')).default;
    router.go('lector');
    router.refresh();
  })()`).catch((e) => problemas.push('abrir: ' + e.message));

  await esperar(2200);

  // ── 4. ¿Se pintaron páginas, y dónde cayeron? ─────────────────────────────
  notas.push(['lector', await js(`(() => {
    const visor = document.getElementById('qr-visor');
    const pliegos = [...document.querySelectorAll('.qr-pliego')];
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
      miniaturas: document.querySelectorAll('.qr-mini').length,
      barra: !!document.querySelector('.qr-barra'),
      statusPagina: document.getElementById('stat-pagina-value')?.textContent,
      statusMedida: document.getElementById('stat-medida-value')?.textContent,
    };
  })()`)]);

  // ── 4-bis. Las superficies de visualización van SIN esfumado ─────────────
  // Es la excepción declarada de Quire: un degradado sobre el papel se lee
  // como que la hoja está impresa más clara en el borde. Ver quire.css.
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

  // ── 5. ¿Hay tinta real en el canvas? ──────────────────────────────────────
  notas.push(['tinta', await js(`(() => {
    const c = document.querySelector('.qr-pliego canvas');
    if (!c || !c.width) return { hay: false, motivo: 'sin canvas' };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 600)).data;
    let oscuros = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) oscuros++;
    return { hay: oscuros > 50, pixelesOscuros: oscuros, lienzo: c.width + 'x' + c.height };
  })()`)]);

  // ── 6. Capacidades de la impresora, por el puente real ────────────────────
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
  notas.push(['tinta', await js(`(async () => {
    /* La tinta PERSISTE en disco: sin limpiar, cada corrida encuentra los
       trazos de la anterior y el test deja de ser determinista. Que esto haga
       falta es, de paso, la prueba de que la persistencia anda. */
    const est = await import('./js/estado.js');
    await est.S.tinta?.borrarTodo();

    // Volver arriba: el trazo va en la página 1 y así la captura la muestra.
    document.getElementById('qr-visor').scrollTop = 0;
    document.getElementById('qr-tinta-toggle').click();
    await new Promise((r) => setTimeout(r, 500));

    // Fibra: color rojo, fácil de distinguir del texto negro del documento.
    document.querySelector('[data-tinta-tool="fibra"]')?.click();
    await new Promise((r) => setTimeout(r, 200));

    const pliego = document.querySelector('.qr-pliego[data-pagina="1"]');
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

    // ¿Se ve en el canvas de tinta?
    let rojos = 0;
    const c = canvas.getContext('2d');
    if (canvas.width > 2) {
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
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
      cuenta: document.getElementById('qr-tinta-cuenta')?.textContent,
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

  /* El guardado en disco va con 900 ms de debounce y al terminar vuelve a
     avisar que la capa cambió. Se espera a que eso pase ANTES de capturar y de
     dar por buena la barra: si algo desincroniza el contador, es justo ahí. */
  await esperar(1400);
  notas.push(['tinta-asentada', await js(`(async () => {
    const { S } = await import('./js/estado.js');
    return {
      cuenta: document.getElementById('qr-tinta-cuenta')?.textContent,
      trazos: S.tinta?.cuenta,
      sucia: S.tinta?.sucia,
      guardadoEnDisco: (await window.onyx.col('tinta').list()).length,
    };
  })()`)]);

  /* La rueda tiene que seguir scrolleando el documento CON el modo de
     anotación activo. Un WheelEvent sintético no produce scroll de verdad
     —los eventos fabricados no disparan el comportamiento por defecto—, así
     que se mide lo único que decide si el navegador va a scrollear:
     `defaultPrevented`. Si algo llamó preventDefault, la rueda está muerta. */
  notas.push(['rueda', await js(`(() => {
    const canvas = document.querySelector('.qr-pliego[data-pagina="1"] .qr-tinta');
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

  fs.writeFileSync(path.join(RAIZ, 'test', 'humo-tinta.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(RAIZ, 'test', 'humo.png'), (await win.webContents.capturePage()).toPNG());

  // ── 7. La vista de imprimir: el preview y el marco no imprimible ─────────
  await js(`(async () => {
    const router = (await import('./js/router.js')).default;
    router.go('imprimir');
  })()`).catch((e) => problemas.push('ir a imprimir: ' + e.message));
  await esperar(2600);

  notas.push(['imprimir', await js(`(() => {
    const hoja = document.querySelector('.qr-pliego--preview');
    const marco = document.querySelector('.qr-noimprimible');
    /* Lo que de verdad importa: que la tinta que se dibujó en el lector esté
       en el PDF impuesto. El preview rasteriza ese PDF, así que si hay rojo
       acá es porque el trazo se escribió en el archivo que va a la impresora. */
    const cv = hoja?.querySelector('canvas');
    let tintaEnElPreview = 0;
    if (cv && cv.width > 2) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 130 && d[i + 1] < 90 && d[i + 2] < 90) tintaEnElPreview++;
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
      resumen: document.querySelector('.qr-resumen__cifra .ox-stat__value')?.textContent,
      nav: document.getElementById('qr-preview-nav')?.textContent.replace(/\\s+/g, ' ').trim(),
      tintaEnElPreview,
    };
  })()`)]);

  // Cambiar a folleto: el resumen y el papel tienen que cambiar solos.
  await js(`document.querySelector('.qr-modo[data-value="folleto"]').click()`).catch(() => {});
  await esperar(2000);

  notas.push(['folleto', await js(`(() => {
    const hoja = document.querySelector('.qr-pliego--preview');
    const c = hoja?.querySelector('canvas');
    const r = hoja?.getBoundingClientRect();

    /* Tinta de verdad, no la clase 'is-pintada': un canvas cancelado se queda
       en opacity:0 con la clase puesta y la hoja se ve EN BLANCO. Medir el
       bitmap es lo único que distingue "pintó" de "dijo que pintó".
       Además se cuenta por mitades: en un folleto tiene que haber contenido de
       los DOS lados, o la imposición puso las dos páginas encimadas. */
    let izq = 0, der = 0;
    if (c && c.width > 2) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const mitad = c.width / 2;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 140) continue;
        (((i / 4) % c.width) < mitad ? izq++ : der++);
      }
    }
    return {
      apaisada: !!(r && r.width > r.height),
      opacidadCanvas: c ? getComputedStyle(c).opacity : null,
      tintaIzquierda: izq,
      tintaDerecha: der,
      resumen: document.querySelector('.qr-resumen__cifra .ox-stat__value')?.textContent,
      duplexActivo: document.querySelector('#op-duplex .ox-segmented__opt.is-active')?.textContent,
      nav: document.getElementById('qr-preview-nav')?.textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`)]);

  fs.writeFileSync(path.join(RAIZ, 'test', 'humo-imprimir.png'), (await win.webContents.capturePage()).toPNG());

  // ── 8. Organizar páginas ─────────────────────────────────────────────────
  await js(`(async () => (await import('./js/router.js')).default.go('paginas'))()`).catch((e) => problemas.push('ir a paginas: ' + e.message));
  await esperar(1800);

  notas.push(['paginas', await js(`(() => {
    const items = [...document.querySelectorAll('.qr-org__item')];
    // Seleccionar la 2 y la 3, girar y quitar una.
    items[1]?.click();
    items[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    document.getElementById('org-rotar-der')?.click();
    const trasRotar = document.querySelectorAll('.qr-org__item .ox-chip').length;
    document.getElementById('org-borrar')?.click();
    return {
      items: items.length,
      conMiniatura: items.filter((i) => i.querySelector('canvas')).length,
      trasRotar,
      trasBorrar: document.querySelectorAll('.qr-org__item').length,
      guardarHabilitado: !document.getElementById('org-guardar')?.disabled,
      estado: document.getElementById('org-estado')?.textContent,
    };
  })()`)]);

  /* Las vistas entran con una animación de 420 ms. capturePage() devuelve el
     último frame COMPUESTO, así que capturar de inmediato saca la pantalla a
     medio entrar — o directamente vacía. Esperar no es opcional acá. */
  await esperar(700);
  fs.writeFileSync(path.join(RAIZ, 'test', 'humo-paginas.png'), (await win.webContents.capturePage()).toPNG());

  // ── 9. Herramientas ──────────────────────────────────────────────────────
  await js(`(async () => (await import('./js/router.js')).default.go('herramientas'))()`).catch((e) => problemas.push('ir a herramientas: ' + e.message));
  await esperar(900);

  notas.push(['herramientas', await js(`(() => {
    const r = { tabs: document.querySelectorAll('.ox-tab').length, secciones: {} };
    for (const id of ['combinar', 'dividir', 'exportar']) {
      document.querySelector(\`.ox-tab[data-value="\${id}"]\`)?.click();
      const panel = document.querySelector('.qr-herr__panel');
      r.secciones[id] = {
        monta: !!panel,
        botones: panel ? panel.querySelectorAll('button').length : 0,
        alto: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      };
    }
    // Queda en exportar, que es el que tiene más para mirar.
    document.querySelector('.ox-tab[data-value="exportar"]')?.click();
    return r;
  })()`)]);

  await esperar(700);

  /* Se vuelve a medir DESPUÉS de esperar, en el mismo instante que la captura.
     Una vista puede medir bien apenas montada y verse vacía un frame después
     —animaciones de entrada, repintados encadenados—, y entonces el test dice
     una cosa y la pantalla muestra otra. */
  notas.push(['herramientas-asentada', await js(`(() => {
    const panel = document.querySelector('.qr-herr__panel');
    const cs = panel ? getComputedStyle(panel) : null;
    const r = panel?.getBoundingClientRect();
    return {
      tabActiva: document.querySelector('.ox-tab.is-active')?.textContent.trim(),
      panelExiste: !!panel,
      opacity: cs?.opacity,
      alto: r ? Math.round(r.height) : 0,
      dentroDeLaVentana: !!(r && r.top > 0 && r.top < window.innerHeight && r.height > 40),
      dpis: document.querySelectorAll('.qr-dpi').length,
      dpiActivo: document.querySelector('.qr-dpi.is-active .qr-dpi__n')?.textContent,
      medida: document.querySelector('.ox-field__hint b')?.textContent,
    };
  })()`)]);

  fs.writeFileSync(path.join(RAIZ, 'test', 'humo-herramientas.png'), (await win.webContents.capturePage()).toPNG());
  /* ── 10. Abrir un PDF desde la pantalla de inicio ─────────────────────────
     El escenario del bug: parado en "no hay ningún documento", abrís uno y no
     aparece hasta cambiar de vista y volver. La causa era que la vista se
     suscribía a los cambios DESPUÉS del early return, así que en su estado
     vacío no escuchaba nada — y Router.go('lector') no repinta si ya estás
     en 'lector'. Se ejercita sin tocar la navegación en ningún momento. */
  notas.push(['desde-inicio', await js(`(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;

    router.go('lector');
    await new Promise((r) => setTimeout(r, 500));
    await est.cerrar();                       // deja la app como recién abierta
    await new Promise((r) => setTimeout(r, 500));

    const vacio = {
      pliegos: document.querySelectorAll('.qr-pliego').length,
      hayCartel: !!document.querySelector('.ox-empty'),
      vista: router.name,
    };

    // Abrir un documento SIN navegar: solo el estado cambia.
    const archivo = await window.onyx.docs.leer(${JSON.stringify(PDF)});
    await est.abrir(archivo);
    await new Promise((r) => setTimeout(r, 1600));

    const canvas = document.querySelector('.qr-pliego canvas');
    let tinta = 0;
    if (canvas && canvas.width > 2) {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.min(canvas.height, 500)).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) tinta++;
    }

    return {
      vacio,
      despues: {
        pliegos: document.querySelectorAll('.qr-pliego').length,
        hayCartel: !!document.querySelector('.ox-empty'),
        pintados: document.querySelectorAll('.qr-pliego.is-pintada').length,
        pixelesConTinta: tinta,
        vista: router.name,        // sigue siendo 'lector': no se navegó
        statusbar: document.getElementById('stat-doc-name')?.textContent,
      },
    };
  })()`)]);

  const png = Buffer.alloc(0);

  console.log('\n===== HUMO =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  console.log('\n----- problemas: ' + problemas.length + ' -----');
  for (const p of problemas) console.log('  ! ' + p);
  console.log('\ncapturas: test/humo.png · test/humo-imprimir.png');

  win.destroy();
  app.exit(problemas.length ? 1 : 0);
});

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
