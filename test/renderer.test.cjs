/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron, por eso no está en el
   `npm test`, que es node pelado).

   Lo que busca es lo que un test de unidad NO ve: overlays que aterrizan fuera
   de pantalla, vistas que no montan, animaciones que se quedan quietas donde no
   se las ve, glifos unicode que se colaron. La regla que lo guía: **medí dónde
   CAE una cosa, no solo si existe**. El bug más caro de este sistema fue un
   modal que renderizaba en top:-281px — presente en el DOM, correcto en el
   HTML, e inalcanzable con el mouse.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const { vigilarConsola } = require('./consola.cjs');
const { auditarAnillos } = require('./anillos.cjs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('smoke');
const W = 1440; const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 120s'), 120000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  vigilarConsola(win, errores);
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  // Clickear sin explotar si el selector no existe: un elemento faltante tiene
  // que reportarse como falla del test, no como excepción que aborta todo.
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  // Un click real es pointerdown → pointerup → click, y varios overlays se
  // cierran en pointerdown. Con `el.click()` solo, el orden nunca se prueba.
  const tap = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.click(); return true; })()`);

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);
  /* Los ítems de la statusbar son flex, y una regla de clase le ganaba al
     `hidden` del navegador: sin documento, la barra mostraba «— — [impresora]
     —» en vez de solo «Ningún documento». */
  const statsVisibles = await js(`[...document.querySelectorAll('.ox-statusbar__item[hidden]')]
    .filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id)`);
  ok('sin documento, la statusbar no muestra datos vacíos', statsVisibles.length === 0, statsVisibles.join(', '));

  /* Acá venían dos secciones que probaban la app demo de Onyx: crear un ítem
     por el modal (`#btn-new`, `#f-name`, la colección `items`) y abrir su
     detalle con el router. Quire reemplazó todo eso por el lector de PDF, así
     que no existe ninguno de esos nodos y el test cortaba en el primer paso.

     Lo que SÍ vale de este archivo es lo que mide primitivos del framework
     sobre Piezas —dónde caen los overlays, la fuente empaquetada, el re-tintado
     y las reglas de oro—, y eso se conserva entero. Los flujos propios de Quire
     los cubre humo.cjs, que es además el que corre en `npm run verificar`. */

  console.log('\n2. Todas las vistas montan');
  for (const v of ['lector', 'paginas', 'imprimir', 'herramientas', 'piezas', 'ajustes']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

  console.log('\n3. Overlays: dónde caen, no solo si existen');
  // Los anclas de overlay viven en Piezas: el menú de la app demo (`[data-menu
  // ="item"]`) ya no existe, pero la vitrina tiene el suyo y sirve igual —
  // lo que se mide es dónde ATERRIZA el menú, no de qué botón cuelga.
  await click('[data-view="piezas"]');
  await sleep(900);

  await click('#demo-menu');
  await sleep(400);
  const menu = await js(`(() => { const m=document.querySelector('.ox-menu'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),rt:Math.round(r.right)}; })()`);
  ok('el menú abre dentro de la ventana',
    menu && menu.t >= 0 && menu.l >= 0 && menu.b <= H && menu.rt <= W, JSON.stringify(menu));
  await js(`document.body.click(); true`); await sleep(300);

  ok('no queda el botón de comandos', !(await js(`document.querySelector('#btn-palette')`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
  await sleep(200);
  ok('Ctrl+K no abre una paleta', !(await js(`document.querySelector('.ox-palette')`)));

  await click('#demo-modal');
  await sleep(600);
  const modal = await js(`(() => { const m=document.querySelector('.ox-modal'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),t:Math.round(r.top)}; })()`);
  ok('el modal queda CENTRADO en la ventana',
    modal && Math.abs(modal.cx - W / 2) < 4 && Math.abs(modal.cy - H / 2) < 4 && modal.t > 0, JSON.stringify(modal));
  await click('[data-dismiss]'); await sleep(400);

  // El toggle del menú. Volver a tocar el botón que lo abrió TIENE que cerrarlo.
  // Si no, se ve como un rebote: el manejador de click-afuera deja pasar al
  // ancla, el handler del botón vuelve a llamar a show(), y cierra+reabre en el
  // mismo gesto. Por eso acá va `tap` y no `click`: reproduce el orden real.
  const abierto = () => js(`!!document.querySelector('.ox-menu')`);
  await tap('#demo-select');
  await sleep(400);
  ok('el select abre su menú', await abierto());
  await tap('#demo-select');
  await sleep(500);
  ok('volver a tocarlo lo CIERRA (no rebota)', !(await abierto()));
  ok('y el ancla suelta el estado abierto', !(await js(`!!document.querySelector('#demo-select.is-open')`)));

  await tap('#demo-select');
  await sleep(400);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(500);
  ok('y un click afuera también lo cierra', !(await abierto()));

  console.log('\n4. El medidor indeterminado nunca se va de la pista');
  // Una barra que se sale de su pista se lee como un componente roto, no como
  // "esperando". Se muestrea el recorrido entero en vez de mirar un instante.
  //
  // Pero el barrido sale por la derecha y vuelve a entrar por la izquierda, y
  // en esa vuelta la pista queda vacía un instante: medido, ~3 ms por borde
  // (un cuadro en dos ciclos, con 0,4 px asomando). Antes se exigía cero
  // muestras vacías, cada 60 ms: el ciclo dura 1500, exactamente 25 muestras,
  // así que quedaban en fase con él y según cómo arrancara una caía siempre en
  // la vuelta —la muestra 21, en cinco de ocho corridas—. Ahora se mira cada
  // cuadro durante dos ciclos: la vuelta puede dejar un cuadro vacío por
  // ciclo, nunca dos seguidos; una barra que se sale de verdad deja muchos.
  const fuera = await js(`(async () => {
    const m = document.querySelector('.ox-meter--indeterminate');
    const f = m && m.querySelector('.ox-meter__fill');
    if (!f) return 'no existe';
    const vacios = []; let cuadros = 0; let seguidos = 0; let peorRacha = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      const p = m.getBoundingClientRect(); const r = f.getBoundingClientRect();
      const visible = Math.min(r.right, p.right) - Math.max(r.left, p.left);
      cuadros++;
      if (visible < 1) { vacios.push(Math.round(performance.now() - t0)); seguidos++; peorRacha = Math.max(peorRacha, seguidos); }
      else seguidos = 0;
      await new Promise((res) => requestAnimationFrame(res));
    }
    return { cuadros, vacios, peorRacha };
  })()`);
  ok('siempre hay barra sobre la pista (salvo la vuelta del barrido)',
    typeof fuera === 'object' && fuera.cuadros > 60 && fuera.vacios.length <= 2 && fuera.peorRacha <= 1, JSON.stringify(fuera));

  console.log('\n5. La fuente empaquetada carga de verdad');
  /* Éste es el chequeo que evita el fracaso silencioso: con CSP estricta y
     protocolo file://, un @font-face con la ruta mal puesta no tira error —
     el navegador cae a la de respaldo y todo "se ve bien". Por eso no alcanza
     con preguntar por --ox-mono: hay que confirmar que la familia cargó Y que
     realmente cambia el ancho del texto. */
  const fuente = await js(`(async () => {
    await document.fonts.ready;
    const cargadas = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ':' + f.weight);
    const medir = (fam) => { const s = document.createElement('span');
      s.style.cssText = 'position:fixed;left:-9999px;font-size:64px;white-space:pre;font-family:' + fam;
      s.textContent = 'MMMiiilll0O1'; document.body.appendChild(s);
      const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    return {
      cargadas,
      declarada: getComputedStyle(document.documentElement).getPropertyValue('--ox-mono').trim(),
      roboto: medir("'Roboto Mono'"), serif: medir('serif'),
      disponible: document.fonts.check('400 13px "Roboto Mono"'),
    };
  })()`);
  ok('el @font-face resolvió a archivos reales', fuente.cargadas.length > 0, JSON.stringify(fuente.cargadas));
  ok('Roboto Mono está disponible para pintar', fuente.disponible, JSON.stringify(fuente));
  ok('y NO está cayendo a la de respaldo', fuente.roboto !== fuente.serif, `roboto=${fuente.roboto} serif=${fuente.serif}`);
  // Ojo: getComputedStyle RESUELVE el var(), así que acá se ve la familia final
  // y no la indirección. Que --ox-mono apunte a un token se verifica sobre el
  // texto del CSS, en tokens.test.mjs.
  ok('la familia efectiva es la empaquetada', fuente.declarada.includes('Roboto Mono'), fuente.declarada);

  const monos = await js(`document.querySelectorAll('#knob-mono [data-mono]').length`);
  ok('la vitrina descubrió las monos declaradas', monos >= 2, `${monos}`);
  const antesMono = await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`);
  await click('#knob-mono [data-mono="sistema"]');
  await sleep(300);
  ok('cambiar la mono cambia lo que se pinta',
    (await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`)) !== antesMono);

  console.log('\n6. Las perillas re-tintan de verdad');
  const antes = await js(`getComputedStyle(document.body).backgroundColor`);
  await js(`(() => { const h=document.getElementById('knob-hue'); h.value=30; h.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  ok('cambiar el matiz cambia el fondo', (await js(`getComputedStyle(document.body).backgroundColor`)) !== antes);
  await click('#knob-reset');
  await sleep(300);
  ok('el reset vuelve al original', (await js(`getComputedStyle(document.body).backgroundColor`)) === antes);

  console.log('\n7. Las reglas de oro');
  const glifos = await js(`(() => {
    const malo = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (malo.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 40));
    return out;
  })()`);
  ok('cero emojis y glifos unicode en la UI', glifos.length === 0, JSON.stringify(glifos));
  ok('cero title= nativo', (await js(`document.querySelectorAll('[title]').length`)) === 0);
  const reglas = await js(`(() => { const r = [...document.styleSheets].flatMap(ss => { try { return [...ss.cssRules] } catch { return [] } })
      .map(x => x.selectorText).filter(Boolean).join(' ');
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);

  /* ── 8. Un ícono dentro de un dato chico va en el renglón ──────────────────
     `.ox-meta` y `.ox-label` son texto en línea y todo svg es display:block:
     el ícono se iba solo a un renglón de arriba (salió de Pharos, arreglado en
     Onyx). Se arman los dos casos y se mide que ícono y texto compartan
     renglón. Sin la regla de base.css da 13.5px de desfase y 27px de alto. */
  console.log('\n8. Un ícono dentro de un dato chico va en el renglón');
  const renglon = await js(`(async () => {
    const { Icons } = await import('./js/icons.js');
    const caja = document.createElement('div');
    caja.innerHTML = '<span class="ox-meta">' + Icons.svg('clock', 'ox-icon--sm') + ' hace 2 h</span>'
      + '<div><span class="ox-label">' + Icons.svg('settings', 'ox-icon--sm') + ' Ajustes</span></div>';
    document.getElementById('view').prepend(caja);
    const medir = (el) => {
      const i = el.querySelector('svg').getBoundingClientRect();
      const r = document.createRange(); r.selectNodeContents(el.lastChild);
      const t = r.getBoundingClientRect();
      return { dy: +Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2).toFixed(1), alto: Math.round(el.getBoundingClientRect().height) };
    };
    const out = { meta: medir(caja.querySelector('.ox-meta')), label: medir(caja.querySelector('.ox-label')) };
    caja.remove();
    return out;
  })()`);
  ok('en .ox-meta el ícono va al lado del texto', renglon.meta.dy <= 2 && renglon.meta.alto < 20, JSON.stringify(renglon));
  ok('y en .ox-label también', renglon.label.dy <= 2 && renglon.label.alto < 22, JSON.stringify(renglon));

  /* ── 9. Ningún anillo de foco se corta ─────────────────────────────────────
     Traído de Onyx (9-bis de su humo). El anillo de base.css sale 3.5px por
     fuera del elemento. Si el elemento se ve entero pero esos 3.5px caen afuera
     de un contenedor que recorta (un .ox-scroll, el borde de la ventana) o
     encima del canto de una superficie (una card, el carril del segmentado),
     con Tab se ve cortado: pasó en los controles de ventana, el primer ítem del
     rail, el segmentado y las filas de una tabla de borde a borde. Cada
     elemento se enfoca como con teclado y se mide su anillo real (solo las
     sombras duras: una difusa es elevación, no anillo), así los que van hacia
     adentro cuentan cero. */
  console.log('\n9. Ningún anillo de foco se corta');
  const AUDITAR_ANILLOS = auditarAnillos();
  // Sin foco en la ventana, :focus-visible no se aplica y todo anillo mide
  // cero: la auditoría pasaría sin haber medido nada.
  win.focus();
  win.webContents.focus();
  await sleep(150);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await js('document.hasFocus()'));
  for (const v of ['lector', 'paginas', 'imprimir', 'herramientas', 'convertir', 'piezas', 'ajustes']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    await js(`document.querySelectorAll('#view tbody tr').forEach((tr) => tr.tabIndex = 0)`);
    const cortes = await js(AUDITAR_ANILLOS);
    ok(`${v}: ningún anillo de foco se corta ni roza un canto`, cortes.length === 0, '\n      ' + cortes.join('\n      '));
  }
  await js(`document.getElementById('aud-notr')?.remove()`);

  /* ── 9-ter. El relevo de vistas ────────────────────────────────────────────
     Primero la vista vieja se iba de un cuadro al otro y la nueva arrancaba
     desde transparente: un cuadro vacío en cada navegación (sep 2026). El
     arreglo la pasó a un calco que se esfumaba encima, pero la nueva seguía
     esperando 90 ms invisible y entraba corrida 10 px: la pantalla bajaba
     hasta un tercio de tapada (medido 100 → 29/5 → 100) y volvía, y con las
     hojas blancas de un PDF eso se ve como un parpadeo, más el temblor de
     todo lo que las dos vistas tienen en el mismo lugar (títulos, barras).
     Ahora es un fundido: la nueva ya está entera y quieta DEBAJO del calco,
     que es opaco, y lo único que se mueve es la opacidad del calco. La
     pantalla está tapada en todo momento. Lo mismo al cambiar de documento,
     que es un refresh({ animar: true }). Se muestrea cada 40 ms y se mide la
     curva, no se mira. */
  console.log('\n9-ter. El relevo de vistas');
  const MEDIR_RELEVO = (disparar) => `(async () => {
    const view = document.getElementById('view');
    const rv = view.getBoundingClientRect();
    ${disparar};
    const op = (el) => el?.isConnected ? Math.round(+getComputedStyle(el).opacity * 100) : null;
    const calco = document.querySelector('.ox-main--saliente');
    const cc = calco && getComputedStyle(calco);
    // El fondo sale de un token OKLCH: se mide el alfa pintándolo, no parseándolo.
    const alfa = (color) => { const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = color; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; };
    const opaco = !!cc && alfa(cc.backgroundColor) === 255;
    const encima = !!calco && +cc.zIndex > 0 && view.compareDocumentPosition(calco) === Node.DOCUMENT_POSITION_FOLLOWING;
    const filas = [];
    for (let t = 0; t <= 400; t += 40) {
      const rc = calco?.getBoundingClientRect();
      const viejo = op(calco); const nuevo = op(view);
      filas.push({ t, viejo, nuevo,
        tapado: Math.round(viejo == null ? nuevo : viejo + (100 - viejo) * nuevo / 100),
        quieta: getComputedStyle(view).transform === 'none',
        mismoLugar: !rc || !calco.isConnected || (rc.left === rv.left && rc.top === rv.top && rc.width === rv.width && rc.height === rv.height),
        views: document.querySelectorAll('#view').length });
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 500));
    return { filas, hayCalco: !!calco, opaco, encima,
      animaciones: view.getAnimations().length, calcos: document.querySelectorAll('.ox-main--saliente').length };
  })()`;
  const revisarRelevo = (quien, r) => {
    const s = r.filas.map((f) => `${f.t}:${f.viejo ?? '-'}/${f.nuevo}`).join(' ');
    ok(`${quien}: lo de antes queda en un calco`, r.hayCalco, JSON.stringify(r));
    ok(`${quien}: el calco es opaco y va encima (tapa a la nueva mientras se va)`, r.opaco && r.encima, JSON.stringify(r));
    ok(`${quien}: que se esfuma de a poco (no se va de un cuadro al otro)`, r.filas.some((f) => f.viejo > 5 && f.viejo < 95), s);
    ok(`${quien}: la pantalla no se destapa en ningún momento (sin parpadeo)`, r.filas.every((f) => f.tapado >= 97), s);
    ok(`${quien}: lo nuevo no se corre mientras entra (sin temblor)`, r.filas.every((f) => f.quieta), s);
    ok(`${quien}: los dos en la misma celda, sin salto`, r.filas.every((f) => f.mismoLugar), s);
    ok(`${quien}: un solo #view en todo el relevo`, r.filas.every((f) => f.views === 1), s);
    ok(`${quien}: el calco se va del DOM al terminar`, r.calcos === 0, JSON.stringify(r));
    ok(`${quien}: la vista nueva no retiene ninguna animación`, r.animaciones === 0, JSON.stringify(r));
  };
  await click('[data-view="ajustes"]');
  await sleep(800);
  revisarRelevo('navegar', await js(MEDIR_RELEVO(`document.querySelector('.ox-navitem[data-view="piezas"]').click()`)));
  revisarRelevo('cambiar de documento', await js(MEDIR_RELEVO(`await import('./js/router.js').then((m) => m.refresh({ animar: true }))`)));
  const enElLugar = await js(`(async () => {
    const m = await import('./js/router.js');
    m.refresh();
    const hay = !!document.querySelector('.ox-main--saliente');
    await new Promise((r) => setTimeout(r, 300));
    return hay;
  })()`);
  ok('refrescar sin animar sigue siendo en el lugar: sin calco', enElLugar === false);

  /* No hay limpieza que hacer: este archivo ya no escribe nada en disco. La
     que había borraba el ítem que creaba la app demo y reponía el ajuste
     `densidad`, y ninguna de las dos cosas existe en Quire. */

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
