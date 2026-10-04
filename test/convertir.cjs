/* La conversión con Electron de verdad, de punta a punta:

   1. El motor imprime el cuestionario Moodle a PDF con el Chromium de la app
      (lo único que el test de Node no puede probar).
   2. La vista Convertir monta, recibe un archivo por el mismo camino que un
      arrastre, lo convierte, y el PDF resultante aparece abierto en una
      pestaña — que es la promesa entera de haber traído Omnimuter acá.

   3. La cola se pone al día sin rehacerse (auditoría de octubre de 2026,
      paquete 2D): cada archivo es la MISMA fila en cola, convirtiendo y
      listo (herr-06); mientras convierte, el ícono es el spinner y se ve
      (herr-09); un archivo terminado muestra su resultado sin esperar al
      último del lote (herr-11); sacar dos seguidos saca los que se tocaron
      (herr-07); cambiar el destino no rehace el inspector y la cápsula no
      vuelve a nacer de 0 (herr-04); un lote se puede cancelar (main-20), y
      el siguiente no despliega Cancelar con la frase vieja encima; al volver
      a la vista, lo plegable que nace abierto ya nace en su alto.

   Mismo criterio que el humo: se mide DÓNDE cae cada cosa y qué dice, no si
   existe el elemento. Lo que pasa por un relevo se lee con lo vivo (sin el
   calco que se va): durante un relevo textContent junta las dos frases. La
   ventana va visible en x:-20000 (ver humo.cjs). */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vigilarConsola } = require('./consola.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('convertir');

/* La red (tests-07): un rechazo, una excepción o pasarse de tiempo terminan
   la suite diciendo por qué, en vez de dejar a Electron colgado. Y la carpeta
   de salida se borra en TODAS las salidas (tests-11): se acumulaban
   quire-convertir-* en %TEMP%, una por corrida. Va envolviendo app.exit,
   como datos-propios, porque todas las salidas pasan por ahí. */
const { abandono } = require('./_comun.cjs');
abandono({ ms: 180000 });
let carpeta = null;
const salirApp = app.exit.bind(app);
app.exit = (codigo) => {
  if (carpeta) {
    try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch { /* Electron todavía tiene el PDF abierto */ }
  }
  salirApp(codigo);
};
const MOODLE = path.join(__dirname, 'fixtures', 'ejemplo-moodle.htm');

const problemas = [];
const notas = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const store = require(path.join(RAIZ, 'src', 'store.cjs'));
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  const conversion = require(path.join(RAIZ, 'src', 'conversion.cjs'));
  ipc.register();

  carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-convertir-'));

  // ── 1. Moodle → PDF con printToPDF ─────────────────────────────────────────
  {
    const t0 = Date.now();
    const res = await conversion.convertir({
      files: [MOODLE],
      outputs: ['pdf', 'markdown'],
      options: { destino: { modo: 'carpeta', ruta: carpeta } },
    });
    const r = res.results[0];
    const pdf = r.outputs.find((o) => o.name === 'pdf');
    const bytes = pdf ? fs.readFileSync(pdf.path) : Buffer.alloc(0);
    const n = {
      ok: r.ok, error: r.error, ms: Date.now() - t0,
      salidas: r.outputs.map((o) => path.basename(o.path)),
      pdfBytes: bytes.length,
      empiezaConPDF: bytes.subarray(0, 5).toString() === '%PDF-',
      paginas: (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length,
      preguntas: r.meta?.questions,
    };
    notas.push(['motor→pdf', n]);
    if (!n.ok) problemas.push(`motor: la conversión falló: ${n.error}`);
    if (!n.empiezaConPDF) problemas.push('motor: lo que salió como .pdf no empieza con %PDF-');
    if (n.pdfBytes < 20000) problemas.push(`motor: el PDF pesa ${n.pdfBytes} bytes, demasiado poco para un examen con imágenes`);
    if (n.paginas < 2) problemas.push(`motor: el examen tendría que ocupar varias páginas (${n.paginas})`);
    if (!n.salidas.includes('ejemplo-moodle.md')) problemas.push('motor: no salió el markdown');
  }

  // ── 2. La app, con la vista Convertir ──────────────────────────────────────
  /* Los ajustes son los de la carpeta de datos propia de esta prueba: no hay
     nada que guardar antes ni reponer después. */
  const ajustes = await store.loadSettings();
  await store.saveSettings({
    conversion: {
      ...ajustes.conversion,
      salidas: { pdf: true, markdown: true, txt: false, json: false, chunks: false },
      destino: 'carpeta',
      carpeta,
      abrirAlTerminar: true,
    },
  });

  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 900,
    backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  conversion.iniciar(() => win);
  vigilarConsola(win, problemas);
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);
  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

  // Lo vivo de un relevo: sin el calco de lo que se va.
  await js(`(() => {
    window.__vivo = (el) => {
      if (!el) return null;
      const c = el.cloneNode(true);
      c.querySelectorAll('.ox-swap-out').forEach((n) => n.remove());
      return c.textContent.replace(/\\s+/g, ' ').trim();
    };
    window.__dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    return true;
  })()`);

  // 2a. Se llega desde el rail y la vista cae donde tiene que caer.
  notas.push(['vista', await js(`(async () => {
    document.querySelector('.ox-navitem[data-view="convertir"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const titulo = document.querySelector('.ox-viewhead__title')?.textContent.trim();
    const cola = document.getElementById('cv-cola');
    const insp = document.querySelector('.qr-conv .ox-inspector');
    const rc = cola?.getBoundingClientRect();
    const ri = insp?.getBoundingClientRect();
    return {
      titulo,
      vacio: document.querySelector('.qr-conv__vacio .ox-empty__title')?.textContent.trim(),
      cola: rc ? { x: Math.round(rc.x), ancho: Math.round(rc.width), alto: Math.round(rc.height) } : null,
      inspector: ri ? { x: Math.round(ri.x), ancho: Math.round(ri.width), enPantalla: ri.right <= innerWidth + 1 } : null,
      salidas: document.querySelectorAll('#cv-opciones [data-salida]').length,
      salidasPrendidas: [...document.querySelectorAll('#cv-opciones [data-salida].is-on')].map((b) => b.dataset.salida),
      switches: document.querySelectorAll('#cv-opciones [data-ajuste]').length,
      botonDeshabilitado: document.getElementById('cv-convertir')?.disabled,
      activoEnRail: document.querySelector('.ox-navitem.is-active')?.dataset.view,
    };
  })()`)]);
  {
    const v = notas.at(-1)[1];
    if (v.titulo !== 'Convertir') problemas.push(`vista: el título es "${v.titulo}"`);
    if (!v.vacio) problemas.push('vista: sin archivos tendría que mostrar el estado vacío');
    if (!v.cola || v.cola.ancho < 300 || v.cola.alto < 200) problemas.push(`vista: la cola no ocupa el cuerpo (${JSON.stringify(v.cola)})`);
    if (!v.inspector || !v.inspector.enPantalla || v.inspector.ancho < 280) problemas.push(`vista: el inspector no cae en pantalla (${JSON.stringify(v.inspector)})`);
    if (v.salidas !== 5) problemas.push(`vista: tendría que haber 5 salidas, hay ${v.salidas}`);
    if (JSON.stringify(v.salidasPrendidas) !== '["pdf","markdown"]') problemas.push(`vista: las salidas no salieron de settings (${JSON.stringify(v.salidasPrendidas)})`);
    if (v.switches < 6) problemas.push(`vista: faltan opciones (${v.switches} switches)`);
    if (v.botonDeshabilitado !== true) problemas.push('vista: con la cola vacía el botón Convertir tiene que estar deshabilitado');
  }

  // 2b. Entra un archivo por el mismo camino que un arrastre.
  notas.push(['cola', await js(`(async () => {
    const mod = await import('./js/views/convertir.js');
    const n = await mod.encolar([${JSON.stringify(MOODLE)}]);
    await new Promise((r) => setTimeout(r, 300));
    const item = document.querySelector('.qr-conv__item');
    return {
      encolados: n,
      items: document.querySelectorAll('.qr-conv__item').length,
      nombre: item?.querySelector('.ox-listitem__title')?.textContent.trim(),
      sub: __vivo(item?.querySelector('.ox-listitem__sub')),
      contadorRail: __vivo(document.getElementById('nav-convertir-count')),
      botonDeshabilitado: document.getElementById('cv-convertir')?.disabled,
      resumen: __vivo(document.getElementById('cv-resumen')),
    };
  })()`)]);
  await esperar(500);
  fs.writeFileSync(path.join(RAIZ, 'test', 'convertir-cola.png'), (await win.webContents.capturePage()).toPNG());
  {
    const c = notas.at(-1)[1];
    if (c.encolados !== 1 || c.items !== 1) problemas.push(`cola: entró ${c.encolados}, se ven ${c.items}`);
    if (c.nombre !== 'ejemplo-moodle.htm') problemas.push(`cola: el nombre es "${c.nombre}"`);
    if (!/Moodle/.test(c.sub || '')) problemas.push(`cola: la ficha no dice el tipo ("${c.sub}")`);
    if (c.contadorRail !== '1') problemas.push(`cola: el rail no cuenta el pendiente ("${c.contadorRail}")`);
    if (c.botonDeshabilitado) problemas.push('cola: con un archivo y dos salidas el botón tiene que habilitarse');
    if (!/1 archivo por convertir/.test(c.resumen || '')) problemas.push(`cola: el resumen dice "${c.resumen}"`);
  }

  // 2c. Convertir de verdad, y el PDF termina abierto en una pestaña.
  notas.push(['conversion', await js(`(async () => {
    const estado = await import('./js/estado.js');
    const antes = estado.S.pestanas.length;
    document.getElementById('cv-convertir').click();
    const t0 = performance.now();
    let etapas = new Set();
    for (;;) {
      const item = document.querySelector('.qr-conv__item');
      const sub = __vivo(item?.querySelector('.ox-listitem__sub')) || '';
      if (/·/.test(sub)) etapas.add(sub.split('·').pop().trim());
      /* Terminó: el ítem quedó listo, o falló, o la vista ya no está —al abrir
         el PDF el shell navega al lector, y eso también es terminar bien. */
      if (!item || item.classList.contains('is-listo') || item.classList.contains('is-error')) break;
      if (performance.now() - t0 > 40000) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    // El lector abre el PDF después del toast: un respiro.
    await new Promise((r) => setTimeout(r, 1500));
    const vistaTrasConvertir = document.querySelector('.ox-navitem.is-active')?.dataset.view;
    // De vuelta a Convertir: la cola tiene que seguir ahí, con el resultado.
    document.querySelector('.ox-navitem[data-view="convertir"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const item = document.querySelector('.qr-conv__item');
    if (!item) return { error: 'al volver a Convertir la cola estaba vacía', vistaTrasConvertir };
    return {
      vistaTrasConvertir,
      ms: Math.round(performance.now() - t0),
      estado: [...item.classList].find((c) => c.startsWith('is-')),
      sub: __vivo(item.querySelector('.ox-listitem__sub')),
      chips: [...item.querySelectorAll('.qr-conv__salida')].map((c) => c.textContent.trim()),
      chipsConAbrir: item.querySelectorAll('.qr-conv__salida[data-abrir]').length,
      etapas: [...etapas],
      pestanasAntes: antes,
      pestanasDespues: estado.S.pestanas.length,
      docAbierto: estado.S.doc?.nombre,
      paginas: estado.S.doc?.paginas,
      contadorRail: document.getElementById('nav-convertir-count')?.textContent.trim(),
    };
  })()`)]);
  await esperar(500);
  fs.writeFileSync(path.join(RAIZ, 'test', 'convertir-listo.png'), (await win.webContents.capturePage()).toPNG());
  {
    const c = notas.at(-1)[1];
    if (c.error) problemas.push(`conversión: ${c.error}`);
    if (c.vistaTrasConvertir !== 'lector') problemas.push(`conversión: al abrir el PDF tenía que ir al lector (fue a ${c.vistaTrasConvertir})`);
    if (c.estado !== 'is-listo') problemas.push(`conversión: el ítem terminó en ${c.estado} ("${c.sub}")`);
    if (c.chips.length !== 2) problemas.push(`conversión: tendría que haber 2 chips de salida, hay ${c.chips.length}`);
    if (c.chipsConAbrir !== 1) problemas.push(`conversión: solo el chip del PDF abre en Quire (${c.chipsConAbrir})`);
    if (!/preguntas/.test(c.sub || '')) problemas.push(`conversión: la ficha final no cuenta las preguntas ("${c.sub}")`);
    // El del paso 1 ya ocupaba el nombre: este sale numerado, y ESE es el que se abre.
    if (c.docAbierto !== 'ejemplo-moodle (2).pdf') problemas.push(`conversión: el PDF no quedó abierto en el lector (abierto: ${c.docAbierto})`);
    if (c.pestanasDespues !== c.pestanasAntes + 1) problemas.push(`conversión: pestañas ${c.pestanasAntes} → ${c.pestanasDespues}`);
    if (!(c.paginas >= 2)) problemas.push(`conversión: el PDF abierto tiene ${c.paginas} páginas`);
    if (c.contadorRail !== '') problemas.push(`conversión: el rail sigue contando ("${c.contadorRail}") con todo convertido`);
  }

  // 2d. Los archivos están donde el ajuste dijo, y el original no se tocó.
  {
    const escritos = fs.readdirSync(carpeta).sort();
    const n = { carpeta: escritos, originalIntacto: fs.statSync(MOODLE).size > 0 };
    notas.push(['disco', n]);
    // El del paso 1 y el de la vista: el segundo se numera, no pisa.
    if (!escritos.includes('ejemplo-moodle (2).pdf')) problemas.push(`disco: el segundo PDF tenía que salir como " (2)" (${escritos.join(', ')})`);
  }

  // ── 3. La cola se pone al día sin rehacerse ────────────────────────────────
  /* Textos cortos para los lotes: van a PDF (con el Chromium de la app) y a
     Markdown, así cada uno tarda lo suficiente para mirarlo convirtiendo. */
  const textos = path.join(carpeta, 'textos');
  fs.mkdirSync(textos);
  const txt = (n) => {
    const r = path.join(textos, `${n}.txt`);
    fs.writeFileSync(r, `# ${n}\n\n${'Una línea de prueba para convertir. '.repeat(40)}\n`);
    return r;
  };
  const S1 = txt('saca-1'); const S2 = txt('saca-2'); const S3 = txt('saca-3'); const S4 = txt('saca-4');
  const CORTE = txt('corte'); const PRIMERO = txt('primero');

  // 3a. Abrir el PDF al terminar, apagado: estos lotes no tienen que llevarte al lector.
  await js(`(async () => {
    const sw = document.querySelector('#cv-opciones [data-ajuste="abrirAlTerminar"]');
    if (sw?.classList.contains('is-on')) sw.click();
    await __dormir(100);
  })()`);

  // 3b. Destino: la cápsula viaja, no renace de 0, y el inspector no se rehace.
  notas.push(['destino', await js(`(async () => {
    const seg = document.getElementById('cv-destino');
    const chunks = document.querySelector('#cv-opciones .qr-conv__chunks');
    const ancho = () => parseFloat(getComputedStyle(document.getElementById('cv-destino'), '::before').width) || 0;
    const antes = ancho();
    seg.querySelector('[data-value="descargas"]').click();
    const serie = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 360) { serie.push(Math.round(ancho())); await new Promise((r) => requestAnimationFrame(r)); }
    const r = {
      antes: Math.round(antes), serie, minimo: Math.min(...serie),
      mismoSegmentado: document.getElementById('cv-destino') === seg,
      mismaCaja: document.querySelector('#cv-opciones .qr-conv__chunks') === chunks,
      hint: __vivo(document.getElementById('cv-destino-hint')),
      carpetaPlegada: document.getElementById('cv-elegir-carpeta')?.hidden,
    };
    // Y de vuelta a la carpeta de la prueba (ya elegida: no abre el diálogo).
    document.querySelector('#cv-destino [data-value="carpeta"]').click();
    await __dormir(450);
    r.carpetaVisible = document.getElementById('cv-elegir-carpeta')?.hidden === false;
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    if (!d.mismoSegmentado || !d.mismaCaja) problemas.push('destino: cambiar el destino rehízo el inspector (herr-04)');
    // Viaja del ancho de una opción al de la otra: nunca pasa cerca de 0.
    if (d.minimo < Math.min(d.antes, d.serie.at(-1)) - 2) problemas.push(`destino: la cápsula vuelve a crecer desde ${d.minimo} px (${d.serie.join(' ')})`);
    if (!/Descargas/.test(d.hint || '')) problemas.push(`destino: la explicación no cambió ("${d.hint}")`);
    if (d.carpetaPlegada !== true || !d.carpetaVisible) problemas.push('destino: el botón de la carpeta tiene que plegarse y volver');
  }

  // 3c. Sacar dos seguidos saca los que se tocaron.
  notas.push(['sacar', await js(`(async () => {
    const mod = await import('./js/views/convertir.js');
    await mod.encolar(${JSON.stringify([S1, S2, S3, S4])});
    await __dormir(450);
    const fila = (n) => [...document.querySelectorAll('.qr-conv__item:not([data-state=closing])')]
      .find((f) => f.querySelector('.ox-listitem__title').textContent.trim() === n);
    const cruz = (f) => f?.querySelector('[data-saca]');
    cruz(fila('saca-2.txt'))?.click();
    cruz(fila('saca-3.txt'))?.click();
    await __dormir(60);
    const yendose = [...document.querySelectorAll('.qr-conv__item[data-state=closing]')];
    const r = {
      yendose: yendose.length,
      fueraDelFlujo: yendose.every((f) => getComputedStyle(f).position === 'absolute'),
    };
    await __dormir(600);
    r.quedan = [...document.querySelectorAll('.qr-conv__item:not([data-state=closing])')]
      .map((f) => f.querySelector('.ox-listitem__title').textContent.trim()).filter((n) => n.startsWith('saca-'));
    // Se limpian para los lotes de abajo.
    for (const n of r.quedan) { cruz(fila(n))?.click(); await __dormir(500); }
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    if (JSON.stringify(d.quedan) !== '["saca-1.txt","saca-4.txt"]') problemas.push(`sacar: quedaron ${JSON.stringify(d.quedan)} (herr-07)`);
    if (d.yendose !== 2 || !d.fueraDelFlujo) problemas.push(`sacar: las que se van tienen que esfumarse fuera del flujo (${d.yendose}, ${d.fueraDelFlujo})`);
  }

  // 3d. Cancelar un lote: lo cortado y lo que no empezó vuelven a la cola.
  notas.push(['cancelar', await js(`(async () => {
    const mod = await import('./js/views/convertir.js');
    // El Moodle de arriba quedó listo: se saca y vuelve a entrar, fresco.
    for (const b of document.querySelectorAll('.qr-conv__item:not([data-state=closing]) [data-saca]')) { b.click(); await __dormir(500); }
    await mod.encolar(${JSON.stringify([MOODLE, CORTE])});
    await __dormir(450);
    const cancelar = document.getElementById('cv-cancelar');
    const r = { cancelarAntes: cancelar ? cancelar.hidden : 'no existe' };
    document.getElementById('cv-convertir').click();
    r.cancelarDurante = cancelar ? cancelar.hidden : 'no existe';
    cancelar?.click();
    const t0 = performance.now();
    await __dormir(300);
    while (performance.now() - t0 < 20000) {
      const b = document.getElementById('cv-convertir');
      if (b.dataset.ocupado !== '1' && !b.querySelector(':scope > .qr-girando') && !document.querySelector('.qr-conv__item.is-convirtiendo')) break;
      await __dormir(60);
    }
    await __dormir(500);
    const filas = [...document.querySelectorAll('.qr-conv__item:not([data-state=closing])')];
    r.estados = filas.map((f) => [f.querySelector('.ox-listitem__title').textContent.trim(), [...f.classList].find((c) => c.startsWith('is-') && c !== 'is-inerte')]);
    r.cancelarDespues = cancelar ? cancelar.hidden : 'no existe';
    r.resumen = __vivo(document.getElementById('cv-resumen'));
    r.toast = __vivo([...document.querySelectorAll('.ox-toast')].at(-1));
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    if (d.cancelarAntes !== true || d.cancelarDurante !== false || d.cancelarDespues !== true) {
      problemas.push(`cancelar: el botón tiene que aparecer solo durante el lote (${d.cancelarAntes} / ${d.cancelarDurante} / ${d.cancelarDespues})`);
    }
    const estados = Object.fromEntries(d.estados || []);
    if (estados['corte.txt'] !== 'is-cola') problemas.push(`cancelar: el que no llegó a empezar quedó ${estados['corte.txt']} (main-20)`);
    if (!/cancelada/i.test(d.toast || '')) problemas.push(`cancelar: el aviso dice "${d.toast}"`);
  }

  // 3e. La misma fila de punta a punta, el spinner a la vista, y cada uno listo cuando termina.
  notas.push(['filas', await js(`(async () => {
    const mod = await import('./js/views/convertir.js');
    // Lo que quedó de antes se saca: este lote es [primero, Moodle].
    for (const b of document.querySelectorAll('.qr-conv__item:not([data-state=closing]) [data-saca]')) { b.click(); await __dormir(500); }
    await mod.encolar(${JSON.stringify([PRIMERO, MOODLE])});
    await __dormir(450);
    const porNombre = (n) => [...document.querySelectorAll('.qr-conv__item:not([data-state=closing])')]
      .find((f) => f.querySelector('.ox-listitem__title').textContent.trim() === n);
    const primero = porNombre('primero.txt');
    const moodle = porNombre('ejemplo-moodle.htm');
    const r = { filas: !!(primero && moodle) };
    if (!r.filas) return r;
    const cancelar = document.getElementById('cv-cancelar');
    r.cancelarAntes = cancelar ? { cancelando: cancelar.dataset.cancelando, hidden: cancelar.hidden } : null;
    /* En 3d el lote termina antes de que «Cancelando…» llegue a asentarse (el
       plegado lo apaga a mitad de su entrada, en opacidad 0, y swap() lo saca
       sin calco). Con un lote de verdad, que tarda en cortar, la frase se
       asienta: se fabrica ese estado. */
    cancelar?.querySelectorAll(':scope > .ox-swap-in').forEach((n) => n.classList.add('is-settled'));
    document.getElementById('cv-convertir').click();
    r.convirtiendo = [primero, moodle].map((f) => f.classList.contains('is-convirtiendo'));
    /* El lote de 3d se canceló: Cancelar quedó plegado con «Cancelando…». Al
       desplegarse en este lote tiene que decir «Cancelar» y nada más: sin el
       calco de la frase vieja esfumándose encima. */
    r.cancelarAlDesplegar = cancelar ? {
      calcos: cancelar.querySelectorAll(':scope > .ox-swap-out').length,
      texto: cancelar.textContent.replace(/\\s+/g, ' ').trim(),
      hidden: cancelar.hidden,
    } : null;
    await __dormir(260);
    // El spinner ES el ícono, y se ve (no vive en las acciones en opacidad 0).
    const opacidad = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
    const girando = moodle.querySelector('.qr-conv__icono > .qr-girando');
    r.spinner = girando ? Math.round(opacidad(girando) * 100) : null;
    // Muestreo: el primero tiene que quedar listo mientras el Moodle sigue.
    let listoAntes = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 40000) {
      if (primero.classList.contains('is-listo') && moodle.classList.contains('is-convirtiendo')) {
        listoAntes = true;
        r.chipsDelPrimero = primero.querySelectorAll('.qr-conv__salidas > .qr-conv__salida').length;
      }
      if (moodle.classList.contains('is-listo') || moodle.classList.contains('is-error')) break;
      await __dormir(25);
    }
    r.listoAntes = listoAntes;
    await __dormir(600);
    r.mismasFilas = porNombre('primero.txt') === primero && porNombre('ejemplo-moodle.htm') === moodle;
    r.finales = [primero, moodle].map((f) => [...f.classList].find((c) => c.startsWith('is-')));
    const lista = primero.parentElement;
    r.animacionLista = lista ? getComputedStyle(lista).animationName : null;
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    if (!d.filas) problemas.push('filas: no entraron los dos archivos');
    else {
      if (!d.mismasFilas) problemas.push('filas: la fila no es la misma en todos los estados (herr-06)');
      if (JSON.stringify(d.finales) !== '["is-listo","is-listo"]') problemas.push(`filas: terminaron ${JSON.stringify(d.finales)}`);
      if (!(d.spinner >= 90)) problemas.push(`filas: el spinner de la fila que convierte no se ve (${d.spinner}, herr-09)`);
      if (!d.listoAntes) problemas.push('filas: el primero no mostró su resultado hasta que terminó el último (herr-11)');
      else if (d.chipsDelPrimero !== 2) problemas.push(`filas: el primero, listo, tiene ${d.chipsDelPrimero} chips`);
      if (d.animacionLista !== 'none') problemas.push(`filas: la lista tiene entrada propia (${d.animacionLista})`);
    }
    // Sin el lote cancelado de 3d detrás, esto no prueba nada: se dice.
    if (d.cancelarAntes?.cancelando !== '1' || d.cancelarAntes?.hidden !== true) {
      problemas.push(`cancelar: el lote anterior tenía que dejar el botón plegado con «Cancelando…» (${JSON.stringify(d.cancelarAntes)})`);
    } else if (!d.cancelarAlDesplegar || d.cancelarAlDesplegar.hidden || d.cancelarAlDesplegar.calcos || d.cancelarAlDesplegar.texto !== 'Cancelar') {
      problemas.push(`cancelar: al desplegarse en el lote siguiente se relevó la frase vieja (${JSON.stringify(d.cancelarAlDesplegar)})`);
    }
  }

  // 3f. Unir textos: mientras une, el botón sigue a la vista, ocupado (herr-14).
  {
    // «Mostrar en la carpeta» abriría el Explorador en el escritorio de quien corre la prueba.
    const { ipcMain } = require('electron');
    ipcMain.removeHandler('conv:mostrar');
    ipcMain.handle('conv:mostrar', () => ({ ok: true, data: true }));
  }
  notas.push(['unir', await js(`(async () => {
    const mod = await import('./js/views/convertir.js');
    await mod.encolar(${JSON.stringify([S1, S4])});
    await __dormir(500);
    const unir = document.getElementById('cv-unir');
    const r = { visibleAntes: unir.hidden === false, rotulo: __vivo(unir) };
    unir.click();
    // En la misma tarea del clic: unir tres textos chicos tarda menos que un cuadro.
    r.durante = { visible: !unir.hidden, deshabilitado: unir.disabled, girando: !!unir.querySelector(':scope > .qr-girando') };
    const t0 = performance.now();
    while (performance.now() - t0 < 10000 && unir.dataset.ocupado === '1') await __dormir(40);
    await __dormir(500);
    r.despues = { visible: !unir.hidden, deshabilitado: unir.disabled, rotulo: __vivo(unir) };
    r.toast = __vivo([...document.querySelectorAll('.ox-toast')].at(-1));
    return r;
  })()`)]);
  {
    const u = notas.at(-1)[1];
    if (!u.visibleAntes || !/Unir los 3 textos/.test(u.rotulo || '')) problemas.push(`unir: con tres textos el botón dice "${u.rotulo}"`);
    if (!u.durante?.visible || !u.durante?.deshabilitado || !u.durante?.girando) problemas.push(`unir: mientras une, el botón tiene que seguir a la vista, deshabilitado y con su spinner (${JSON.stringify(u.durante)})`);
    if (!u.despues?.visible || u.despues?.deshabilitado || !/Unir los 3 textos/.test(u.despues?.rotulo || '')) problemas.push(`unir: al terminar el botón no volvió (${JSON.stringify(u.despues)})`);
    if (!/Textos unidos/.test(u.toast || '') || /→/.test(u.toast || '')) problemas.push(`unir: el aviso dice "${u.toast}"`);
  }

  // 3g. Volver a la vista: lo plegable que nace abierto ya nace en su alto.
  /* Los chips de las filas listas, el botón de la carpeta y Unir nacen
     visibles. Sin asentarlos crecían desde 0 por @starting-style debajo del
     calco del router, y las filas de abajo se veían bajar. Se mide el primer
     cuadro en que existe la vista nueva contra el reposo. Y el primer cambio
     de destino de esta visita no releva el rótulo de la carpeta, que no
     cambió (herr-04). */
  notas.push(['volver', await js(`(async () => {
    const vieja = document.getElementById('cv-cola');
    document.querySelector('.ox-navitem[data-view="herramientas"]').click();
    await __dormir(600);
    document.querySelector('.ox-navitem[data-view="convertir"]').click();
    const t0 = performance.now();
    while (performance.now() - t0 < 2000 && (!document.getElementById('cv-cola') || document.getElementById('cv-cola') === vieja)) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const altos = () => {
      const raiz = document.querySelector('.qr-conv');
      const alto = (el) => (el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null);
      return {
        salidas: [...raiz.querySelectorAll('.qr-conv__salidas:not([hidden])')].map(alto),
        carpeta: alto(raiz.querySelector('#cv-elegir-carpeta:not([hidden])')),
        unir: alto(raiz.querySelector('#cv-unir:not([hidden])')),
      };
    };
    const r = { primero: altos() };
    await __dormir(600);
    r.reposo = altos();

    const boton = document.getElementById('cv-elegir-carpeta');
    document.querySelector('#cv-destino [data-value="descargas"]').click();
    r.calcosAlPlegar = boton.querySelectorAll(':scope > .ox-swap-out').length;
    r.rotulo = __vivo(boton);
    await __dormir(400);
    document.querySelector('#cv-destino [data-value="carpeta"]').click();
    await __dormir(450);
    return r;
  })()`)]);
  {
    const v = notas.at(-1)[1];
    const p = v.primero || {}; const q = v.reposo || {};
    if (!q.salidas?.length || !q.carpeta || !q.unir) problemas.push(`volver: faltan los plegables que se iban a medir (${JSON.stringify(q)})`);
    else if (JSON.stringify(p) !== JSON.stringify(q)) problemas.push(`volver: los plegables crecen al volver a la vista (primer cuadro ${JSON.stringify(p)}, reposo ${JSON.stringify(q)})`);
    if (v.calcosAlPlegar !== 0) problemas.push(`volver: el rótulo de la carpeta se relevó sobre sí mismo al cambiar el destino (${v.calcosAlPlegar} calcos, herr-04)`);
    if (v.rotulo !== 'Cambiar la carpeta') problemas.push(`volver: la carpeta dice "${v.rotulo}"`);
  }

  console.log('\n===== CONVERTIR =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  console.log('\n----- problemas: ' + problemas.length + ' -----');
  for (const p of problemas) console.log('  ! ' + p);

  win.destroy();
  await esperar(300);
  app.exit(problemas.length ? 1 : 0);
}).catch(async (err) => {
  console.error('convertir FALLÓ:', err);
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  for (const p of problemas) console.log('  ! ' + p);
  app.exit(1);
});

// Sin esto, destruir la ventana oculta de printToPDF mata el proceso.
app.on('window-all-closed', () => {});
