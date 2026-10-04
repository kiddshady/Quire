/* ═══════════════════════════════════════════════════════════════════════════
   El puck de navegación: zoom y desplazamiento sin soltar el lápiz.

   Monta Quire de verdad, abre un PDF, prende la tinta y aprieta la barra
   espaciadora con eventos de ENTRADA del sistema (sendInputEvent), no con
   KeyboardEvent sintéticos: un keydown despachado a mano no le cambia el foco
   a nadie ni dispara los repeat de Windows, que son justo lo que hay que
   sobrevivir. Lo mismo con el mouse: la captura del puntero rechaza un
   pointerId inventado.

   Lo que existe para cazar:

   · Que Espacio siga siendo "página siguiente" SIN tinta, y sea el puck CON
     tinta. Son dos significados de la misma tecla y el reparto es una
     condición en atajosLector: si alguien la reordena, una de las dos se va.

   · Que arrastrar el anillo mueva el scroll lo mismo que la mano, y que
     arrastrar el núcleo termine en un zoom real —S.zoom cambiado, la pista sin
     transform— con el mismo punto del papel bajo el disco. Ese anclaje es
     aritmética de rectángulos y se rompe sin que se note nada en el código.

   · Que soltar la barra desarme todo: el disco se va, el visor deja de
     navegar y la tinta recupera el puntero.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vigilarConsola } = require('./consola.cjs');
const { abandono, vivo } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');
const PDF = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

/* Datos propios, y ANTES de requerir nada de src/. El porqué está en
   pestanas.cjs: abrir escribe la sesión, y la sesión real restaura pestañas. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-puck-'));
process.env.QUIRE_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.QUIRE_DATA, { recursive: true });

/* Un rechazo sin atajar o pasarse de tiempo terminan la suite diciendo por
   qué, en vez de dejar Electron colgado (tests-07); la carpeta de datos se
   borra igual. */
abandono({ salir: (c) => { limpiar(); app.exit(c); } });

const problemas = [];
let pass = 0;

function ok(que, condicion, detalle = '') {
  if (condicion) { pass++; console.log(`  ok   ${que}`); }
  else { problemas.push(`${que}${detalle ? ` — ${detalle}` : ''}`); console.log(`  FALLA ${que}${detalle ? ` — ${detalle}` : ''}`); }
}

app.whenReady().then(correr).catch((err) => {
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  limpiar();
  app.exit(1);
});

async function correr() {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();

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
  const tecla = (type, keyCode) => win.webContents.sendInputEvent({ type, keyCode });
  const raton = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });

  await js(`(async () => {
    const est = await import('./js/estado.js');
    await est.abrir(await window.onyx.docs.leer(${JSON.stringify(PDF)}));
  })()`);
  await esperar(1200);

  /* Lo que se pregunta una y otra vez: el estado del visor y del disco. */
  const estado = () => js(`(async () => {
    const { S } = await import('./js/estado.js');
    const visor = document.getElementById('qr-visor');
    const puck = document.querySelector('.qr-puck');
    const pista = document.querySelector('.qr-pista');
    const tinta = visor.querySelector('.qr-tinta');
    const r = visor.getBoundingClientRect();
    return {
      pagina: S.pagina, zoom: S.zoom, modoZoom: S.modoZoom,
      scrollTop: visor.scrollTop, scrollLeft: visor.scrollLeft,
      navegando: visor.classList.contains('is-navegando'),
      anotando: visor.classList.contains('is-anotando'),
      puck: !!puck && puck.classList.contains('is-visible'),
      puckXY: puck ? [parseFloat(puck.style.left), parseFloat(puck.style.top)] : null,
      activo: puck?.dataset.activo || '',
      transform: pista.style.transform,
      tintaRecibe: tinta ? getComputedStyle(tinta).pointerEvents : 'sin canvas',
      /* El % pasa por valor(), que releva: se lee lo vivo y no el calco que
         se va (tests-13). */
      etiqueta: ${vivo('#qr-zoom-valor')},
      visor: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`);

  /* Qué punto del papel hay bajo un punto del visor: página y fracción. Es la
     misma cuenta que hace asentarZoom(), hecha aparte para poder comparar. */
  const bajo = (x, y) => js(`(() => {
    const visor = document.getElementById('qr-visor');
    const vr = visor.getBoundingClientRect();
    let hit = null;
    for (const el of visor.querySelectorAll('.qr-pliego')) {
      const r = el.getBoundingClientRect();
      const top = r.top - vr.top;
      if (${y} < top) break;
      hit = { pagina: Number(el.dataset.pagina), fx: (${x} - (r.left - vr.left)) / r.width, fy: (${y} - top) / r.height };
    }
    return hit;
  })()`);

  /* El cursor que se ve en un punto de la ventana: el del elemento que está
     ahí. Es lo que importa y no el del visor —si la capa de texto le ganara a
     la mano, sobre las letras se vería la I de texto—. */
  const cursorEn = (x, y) => js(`getComputedStyle(document.elementFromPoint(${x}, ${y})).cursor`);

  /* ── 1. Sin tinta, Espacio pasa de página ───────────────────────────────── */
  console.log('\n1. Sin tinta');
  {
    /* Espacio baja UNA PANTALLA antes de pasar de hoja (lector-18, decisión
       de Fran): en «Ajustar al ancho» la hoja mide más que el visor, y pasar
       derecho a la siguiente se comía su mitad de abajo. */
    const antes = await estado();
    // Una pantalla menos 48 px de respiro, sin pasarse del final de la hoja.
    const { alto, fondo } = await js(`(async () => {
      const { S } = await import('./js/estado.js');
      const v = document.getElementById('qr-visor');
      const hoja = document.querySelector('.qr-pliego[data-pagina="' + S.pagina + '"]');
      return { alto: v.clientHeight, fondo: hoja.getBoundingClientRect().bottom - v.getBoundingClientRect().top };
    })()`);
    const paso = Math.min(alto - 48, fondo - alto + 24);
    tecla('keyDown', 'Space'); tecla('keyUp', 'Space');
    await esperar(700);
    const despues = await estado();
    ok('Espacio baja una pantalla', paso > 48 && Math.abs((despues.scrollTop - antes.scrollTop) - paso) <= 2,
      `${antes.scrollTop} → ${despues.scrollTop} (visor ${alto}, esperado ${paso})`);
    ok('sin pasar de hoja todavía', despues.pagina === antes.pagina, `${antes.pagina} → ${despues.pagina}`);
    ok('y no aparece ningún disco', !despues.puck && !despues.navegando);
  }

  /* ── 2. Con tinta, Espacio mantenido es el puck ─────────────────────────── */
  console.log('\n2. La barra, anotando');
  /* Con un clic DE VERDAD, que deja el foco en el lapicito: es lo que pasa
     en el uso real, y es justo donde Espacio se confundía. Con .click() por
     JS el foco no se mueve, y el bug de :focus-visible (Espacio apretaba el
     lapicito y apagaba la tinta) pasaba en verde. */
  {
    /* Con el foco de la ventana: sin él Chromium no aplica la regla de
       :focus-visible que confundía al código de antes, y esto pasaba igual. */
    win.focus(); win.webContents.focus();
    await esperar(80);
    ok('la ventana tiene el foco', await js('document.hasFocus()'));
    const r = await js(`(() => { const b = document.getElementById('qr-tinta-toggle').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    raton('mouseDown', r.x, r.y); raton('mouseUp', r.x, r.y);
  }
  // que la barra de tinta termine de abrirse: el visor se mide DESPUÉS
  await esperar(600);
  ok('el clic dejó el foco en el lapicito', await js(`document.activeElement?.id === 'qr-tinta-toggle'`));

  const v = (await estado()).visor;
  const centro = { x: v.x + Math.round(v.w / 2), y: v.y + Math.round(v.h / 2) };
  // el puntero tiene que estar sobre el visor: ahí es donde aparece el disco
  raton('mouseMove', centro.x, centro.y);
  await esperar(60);

  tecla('keyDown', 'Space');
  // Windows repite el keydown mientras se mantiene: no puede desarmar nada.
  await esperar(80);
  tecla('keyDown', 'Space');
  await esperar(250);

  let n = await estado();
  ok('la tinta quedó prendida', n.anotando);
  ok('aparece el disco', n.puck);
  ok('bajo el puntero', n.puckXY && Math.abs(n.puckXY[0] - v.w / 2) <= 2 && Math.abs(n.puckXY[1] - v.h / 2) <= 2,
    JSON.stringify(n.puckXY));
  ok('el visor entra en modo navegación', n.navegando);
  ok('y la tinta suelta el puntero', n.tintaRecibe === 'none', n.tintaRecibe);
  // Como en Scrawl: sobre el núcleo el cursor se va, el disco ya dice dónde estás.
  ok('sobre el núcleo no hay cursor', (await cursorEn(centro.x, centro.y)) === 'none', await cursorEn(centro.x, centro.y));
  const paginaConDisco = n.pagina;

  /* ── 3. Arrastrar el anillo desplaza ────────────────────────────────────── */
  console.log('\n3. El anillo');
  {
    const antes = await estado();
    // a 40 px del centro cae en el anillo (24 < 40 < 54)
    const de = { x: centro.x, y: centro.y + 40 };
    raton('mouseMove', de.x, de.y);
    await esperar(60);
    const cursorAnillo = await cursorEn(de.x, de.y);
    raton('mouseDown', de.x, de.y);
    for (let i = 1; i <= 10; i++) { raton('mouseMove', de.x, de.y - 15 * i); await esperar(16); }
    const enVuelo = await estado();
    const cursorArrastre = await cursorEn(de.x, de.y - 150);
    raton('mouseUp', de.x, de.y - 150);
    await esperar(200);
    const despues = await estado();
    const cursorSuelto = await cursorEn(de.x, de.y - 150);

    ok('sobre el anillo, la mano abierta', cursorAnillo === 'grab', cursorAnillo);
    ok('arrastrando, la mano cerrada', cursorArrastre === 'grabbing', cursorArrastre);
    ok('al soltar, la mano se vuelve a abrir', cursorSuelto === 'grab', cursorSuelto);

    ok('mientras se arrastra, el anillo está activo', enVuelo.activo === 'anillo', enVuelo.activo);
    ok('el scroll sigue a la mano, píxel por píxel', despues.scrollTop - antes.scrollTop === 150,
      `${antes.scrollTop} → ${despues.scrollTop}`);
    ok('sin tocar el zoom', despues.zoom === antes.zoom && despues.modoZoom === antes.modoZoom);
    ok('y al soltar se apaga la zona', despues.activo === '', despues.activo);
    ok('con el disco todavía puesto', despues.puck && despues.navegando);
  }

  /* ── 4. Arrastrar el núcleo hace zoom ───────────────────────────────────── */
  console.log('\n4. El núcleo');
  {
    const antes = await estado();
    /* El punto se mide donde el disco está DE VERDAD, no donde se lo pidió:
       es el centro del disco lo que asentarZoom() promete dejar quieto. */
    const [px, py] = antes.puckXY;
    const anclaAntes = await bajo(px, py);
    const escalaAntes = parseInt(antes.etiqueta, 10);

    raton('mouseMove', centro.x, centro.y);
    await esperar(60);
    raton('mouseDown', centro.x, centro.y);
    // 180 px hacia arriba: exactamente el doble
    for (let i = 1; i <= 12; i++) { raton('mouseMove', centro.x, centro.y - 15 * i); await esperar(16); }
    await esperar(60);
    const enVuelo = await estado();
    /* Ya fuera del núcleo —la mano subió 165 px—, pero el gesto es zoom: el
       cursor sigue sin verse hasta soltar. */
    const cursorZoom = await cursorEn(centro.x, centro.y - 165);
    ok('haciendo zoom no hay cursor, aunque la mano salga del núcleo', cursorZoom === 'none', cursorZoom);
    raton('mouseUp', centro.x, centro.y - 180);
    await esperar(400);
    const despues = await estado();
    const anclaDespues = await bajo(px, py);

    ok('mientras se arrastra, el núcleo está activo', enVuelo.activo === 'nucleo', enVuelo.activo);
    ok('la pista se escala en vivo', /scale\(1\.9|scale\(2/.test(enVuelo.transform), enVuelo.transform);
    ok('y la etiqueta ya dice el doble', Math.abs(parseInt(enVuelo.etiqueta, 10) - escalaAntes * 2) <= 2,
      `${antes.etiqueta} → ${enVuelo.etiqueta}`);

    ok('al soltar, el transform se va', despues.transform === '', despues.transform);
    ok('y el zoom es de verdad: fijo y al doble', despues.modoZoom === 'fijo'
      && Math.abs(despues.zoom - escalaAntes / 100 * 2) < 0.03, `${despues.zoom} (antes ${antes.etiqueta})`);
    ok('la etiqueta queda en el valor real', Math.abs(parseInt(despues.etiqueta, 10) - escalaAntes * 2) <= 2, despues.etiqueta);
    ok('el mismo punto del papel sigue bajo el disco',
      anclaAntes && anclaDespues && anclaAntes.pagina === anclaDespues.pagina
        && Math.abs(anclaAntes.fx - anclaDespues.fx) < 0.01 && Math.abs(anclaAntes.fy - anclaDespues.fy) < 0.01,
      `${JSON.stringify(anclaAntes)} → ${JSON.stringify(anclaDespues)}`);
  }

  /* ── 5. Soltar la barra desarma todo ────────────────────────────────────── */
  console.log('\n5. Soltar la barra');
  {
    tecla('keyUp', 'Space');
    await esperar(300);
    const n2 = await estado();
    ok('el disco se va', !n2.puck);
    ok('el visor deja de navegar', !n2.navegando);
    ok('y la tinta recupera el puntero', n2.tintaRecibe === 'auto', n2.tintaRecibe);
    const cursorTinta = await cursorEn(centro.x, centro.y);
    ok('y el cursor vuelve a ser el de anotar', cursorTinta === 'crosshair', cursorTinta);
    ok('la tinta sigue prendida', n2.anotando);
    /* Espacio con tinta no pasa de página: el zoom y el paneo pueden haber
       movido la actual, pero nunca por la tecla. Se compara con la página que
       había al aparecer el disco, antes de cualquier arrastre, por arriba. */
    ok('Espacio no pasó de página por su cuenta', n2.pagina <= paginaConDisco + 1, `${paginaConDisco} → ${n2.pagina}`);
  }

  /* ── 6. Apagar la tinta con el disco puesto ─────────────────────────────── */
  console.log('\n6. Apagar la tinta con la barra apretada');
  {
    tecla('keyDown', 'Space');
    await esperar(200);
    const con = await estado();
    await js(`document.getElementById('qr-tinta-toggle').click()`);
    await esperar(300);
    const sin = await estado();
    tecla('keyUp', 'Space');
    await esperar(100);
    ok('el disco había aparecido', con.puck);
    ok('apagar la tinta se lo lleva', !sin.puck && !sin.navegando && !sin.anotando);
  }

  /* ── 7. El vidrio desenfoca también mientras entra y sale ──────────────────
     La opacidad animada iba en el contenedor del disco, y un ancestro con
     opacidad menor que 1 le corta al vidrio de adentro lo que hay detrás:
     mientras aparecía, el disco era vidrio transparente con las letras nítidas
     a través, y al llegar a 1 el desenfoque se prendía de un cuadro al otro
     (al irse, al revés). Medido congelando la transición: con y sin
     backdrop-filter las fotos salían idénticas a 30, 70 y 120 ms, y distintas
     solo en reposo. Se monta un disco aparte sobre un rayado propio —así no
     depende de qué parte del PDF quedó debajo— y en cada instante se compara
     la foto con vidrio contra la foto sin él: si el vidrio anda, difieren. */
  console.log('\n7. El vidrio, mientras entra y sale');
  {
    await js(`(async () => {
      const { montarPuck } = await import('./js/puck.js');
      const ancla = document.getElementById('qr-puck-ancla');
      ancla.style.left = document.getElementById('qr-visor').offsetLeft + 'px';
      const rayas = document.createElement('div');
      rayas.id = 'prueba-rayas';
      rayas.style.cssText = 'position:absolute;left:100px;top:100px;width:200px;height:200px;' +
        'background:repeating-linear-gradient(90deg,#fff 0 3px,#000 3px 6px)';
      ancla.append(rayas);
      window.__disco = montarPuck(ancla);
      window.__discoEl = [...ancla.querySelectorAll('.qr-puck')].pop();
    })()`);
    const foto = async (instante, conVidrio) => {
      const r = await js(`(async () => {
        document.getElementById('prueba-sin-vidrio')?.remove();
        if (!${conVidrio}) {
          const s = document.createElement('style'); s.id = 'prueba-sin-vidrio';
          s.textContent = '.qr-puck__vidrio { backdrop-filter: none !important; }';
          document.head.append(s);
        }
        const d = window.__disco; const el = window.__discoEl;
        const congelar = (ms) => { for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms; } };
        const soltar = () => el.getAnimations({ subtree: true }).forEach((a) => a.finish());
        const dos = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        d.ocultar(); soltar(); await dos();
        const { at, ms } = ${JSON.stringify(instante)};
        d.mostrar(200, 200);
        if (at === 'entrando') { await new Promise((ok) => requestAnimationFrame(ok)); congelar(ms); }
        else { await new Promise((ok) => setTimeout(ok, 400)); soltar(); }
        if (at === 'saliendo') { d.ocultar(); await new Promise((ok) => requestAnimationFrame(ok)); congelar(ms); }
        await dos();
        const b = el.getBoundingClientRect();
        // El centro del disco, adentro del núcleo: vidrio y rayas debajo.
        return { x: Math.round(b.left + b.width / 2 - 16), y: Math.round(b.top + b.height / 2 - 16), width: 32, height: 32 };
      })()`);
      return (await win.webContents.capturePage(r)).toBitmap();
    };
    const diferencia = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return s / (a.length / 4) / 3;
    };
    const instantes = [
      { at: 'entrando', ms: 30 }, { at: 'entrando', ms: 70 }, { at: 'entrando', ms: 120 },
      { at: 'reposo' }, { at: 'saliendo', ms: 40 },
    ];
    for (const i of instantes) {
      const d = diferencia(await foto(i, true), await foto(i, false));
      const nombre = i.ms ? `${i.at} a los ${i.ms} ms` : i.at;
      ok(`${nombre}: el vidrio desenfoca lo de abajo`, d > 8, `diferencia media ${d.toFixed(1)} (con y sin vidrio)`);
    }
    await js(`document.getElementById('prueba-sin-vidrio')?.remove();
      document.getElementById('prueba-rayas')?.remove(); window.__discoEl.remove();`);
  }

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
