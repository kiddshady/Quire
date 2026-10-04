/* Herramientas, con Electron de verdad: Combinar, Dividir y Exportar.

   Lo que mide sale de la auditoría de octubre de 2026 (paquete 2D):

   1. Combinar (herr-01, herr-21, ux-23): la secuencia que rompía el delegado
      acumulado —Combinar, Dividir, volver, dos archivos, Subir dos veces,
      Sacar— deja el orden esperado y uno menos; la fila es el MISMO nodo y el
      foco se queda en el botón después de Subir. El documento abierto se
      puede sacar y no vuelve.
   2. El panel (herr-02, css-04): sigue siendo el mismo nodo después de tocar
      el DPI o el formato, y no tiene animación propia.
   3. La cápsula de los segmentados (herr-03, fw-05): mide más que 0 y cae
      centrada en la opción activa.
   4. Cambiar de pestaña es un fundido: aparece `.ox-swap-out--fundido`, el
      calco es opaco, lo nuevo está quieto debajo y la pantalla queda tapada
      ≥ 97 en toda la serie (muestreada y congelada).
   5. Dividir (herr-22, ux-36): los chips son los mismos nodos con el texto
      nuevo; los rangos siguen lo que se escribe, una coma de más no agrega
      el documento entero y lo que no se entiende se dice.
   6. Exportar con tinta (imprimir-01, tinta-01): el fondo sale blanco, el
      texto sigue oscuro y el trazo está.
   7. La barra de exportar arranca en 0 la segunda vez (herr-16), y la
      segunda tanda se numera en vez de pisar (herr-18).
   8. El combinado lleva lo anotado aunque el abierto se haya elegido en el
      diálogo (herr-20); el botón ocupado se ve ocupado, nace ocupado si la
      vista se repinta en el medio (herr-14) y no deja destellos (herr-15,
      contado en el mismo botón, paso 10).
   9. Soltar en Combinar (ux-13), y dos documentos sin ruta son dos filas
      (paso 11). El arrastre de verdad (paso 12): parado en Combinar, un PDF
      y una imagen soltados van a la lista y no abren una pestaña; parado en
      Dividir, las imágenes llevan a Combinar con las imágenes cargadas.
  10. Un PDF con contraseña (paso 13): Dividir y Combinar avisan y apagan su
      botón con el porqué, sin llegar a pdf-lib; sacarlo de la cola vuelve a
      habilitar Combinar, y Exportar (pdf.js) sigue andando.

   Los diálogos (elegir varios, guardar como, elegir carpeta) se reemplazan
   desde el proceso principal: la prueba dice qué se eligió. La ventana va
   visible en x:-20000 (ver humo.cjs). */
'use strict';

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vigilarConsola } = require('./consola.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('herramientas');
const COBAYO = path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf');

const problemas = [];
const notas = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  const documentos = require(path.join(RAIZ, 'src', 'documentos.cjs'));
  ipc.register();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-herramientas-'));
  const A = path.join(tmp, 'apuntes-a.pdf');
  const B = path.join(tmp, 'apuntes-b.pdf');
  fs.copyFileSync(COBAYO, A);
  fs.copyFileSync(COBAYO, B);
  const salidas = path.join(tmp, 'salidas');
  fs.mkdirSync(salidas);
  /* Para soltar (paso 12): otro PDF y dos imágenes de verdad, en disco. */
  const C = path.join(tmp, 'apuntes-c.pdf');
  fs.copyFileSync(COBAYO, C);
  const png = nativeImage.createFromBitmap(Buffer.alloc(8 * 6 * 4, 0xc8), { width: 8, height: 6 }).toPNG();
  const FOTO = path.join(tmp, 'foto-guia.png');
  const FOTO2 = path.join(tmp, 'foto-guia-2.png');
  fs.writeFileSync(FOTO, png);
  fs.writeFileSync(FOTO2, png);
  // Y uno que no se combina pero se convierte: soltado junto, va a Convertir.
  const NOTAS = path.join(tmp, 'notas-guia.txt');
  fs.writeFileSync(NOTAS, 'Una línea de notas.' + String.fromCharCode(10));

  /* Los diálogos, contestados por la prueba. `eleccion` es lo que «elige» el
     próximo Agregar; guardar como escribe en la carpeta temporal y puede
     demorarse, para mirar el botón ocupado mientras tanto. */
  let eleccion = [];
  let demoraGuardar = 0;
  const reemplazar = (canal, fn) => {
    ipcMain.removeHandler(canal);
    ipcMain.handle(canal, async (_e, ...args) => {
      try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
    });
  };
  reemplazar('docs:elegir-varios', async (opciones) => {
    const r = await documentos.leerVarios(eleccion, { imagenes: true, reciente: false });
    return opciones?.conFallidos ? r : r.leidos;
  });
  reemplazar('docs:guardar-como', async (bytes, nombre) => {
    await esperar(demoraGuardar);
    const ruta = path.join(tmp, nombre);
    fs.writeFileSync(ruta, Buffer.from(bytes));
    return { ruta, nombre };
  });
  reemplazar('docs:elegir-carpeta', async () => salidas);

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
  const paso = (nombre, codigo) => js(codigo).catch((err) => {
    problemas.push(`${nombre}: la página tiró ${err.message}`);
    return {};
  });

  // Ayudas en la página: lo vivo de un relevo, filas sin las que se van, esperar.
  await js(`(() => {
    window.__vivo = (el) => {
      if (!el) return null;
      const c = el.cloneNode(true);
      c.querySelectorAll('.ox-swap-out').forEach((n) => n.remove());
      return c.textContent.replace(/\\s+/g, ' ').trim();
    };
    window.__filas = () => [...document.querySelectorAll('#qr-cola > .ox-listitem:not([data-state=closing])')];
    window.__nombres = () => __filas().map((f) => f.querySelector('.ox-listitem__title').textContent.trim());
    // Los botones de una fila de la cola; el [data-cola-x] es el del código de antes, para correr la prueba al revés.
    window.__boton = (fila, que) => fila?.querySelector('[data-cola="' + que + '"], [data-cola-' + que + ']') || null;
    window.__dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__hasta = async (fn, tope = 8000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < tope) { const v = fn(); if (v) return v; await __dormir(30); }
      return null;
    };
    window.__panel = () => document.querySelector('#herr-cuerpo > .qr-herr__panel');
    window.__tab = (id) => document.querySelector('#herr-tabs .ox-tab[data-value="' + id + '"]').click();
    return true;
  })()`);

  // ── 0. Abrir el cobayo e ir a Herramientas ─────────────────────────────────
  await js(`(async () => {
    const archivo = await window.onyx.docs.leer(${JSON.stringify(COBAYO)});
    const est = await import('./js/estado.js');
    await est.abrir(archivo);
    const router = (await import('./js/router.js')).default;
    router.go('herramientas');
  })()`);
  await esperar(900);

  // ── 1. Combinar ────────────────────────────────────────────────────────────
  eleccion = [A, B];
  notas.push(['combinar', await paso('combinar', `(async () => {
    const r = {};
    // La secuencia de herr-01: Combinar, Dividir y de vuelta a Combinar.
    __tab('combinar'); await __dormir(250);
    __tab('dividir'); await __dormir(300);
    __tab('combinar'); await __dormir(400);
    r.alEntrar = __nombres();
    document.getElementById('qr-comb-agregar')?.click();
    await __hasta(() => __filas().length === 3);
    await __dormir(350);
    r.agregados = __nombres();

    const filaB = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.includes('apuntes-b'));
    const sube = __boton(filaB, 'sube');
    sube?.focus(); sube?.click();
    await __dormir(350);
    r.trasSubir1 = __nombres();
    r.mismaFila1 = __filas()[1] === filaB;
    r.focoSeQueda = document.activeElement === sube;
    sube?.click();
    await __dormir(350);
    r.trasSubir2 = __nombres();
    r.mismaFila2 = __filas()[0] === filaB;
    // Llegó arriba: Subir se apaga y el foco pasa al otro botón de la MISMA fila.
    r.subeApagado = sube?.disabled;
    r.focoEnLaFila = !!document.activeElement && !!filaB?.contains(document.activeElement);
    r.ordenes = __filas().map((f) => f.querySelector('.qr-cola__orden').textContent.trim());

    const filaA = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.includes('apuntes-a'));
    __boton(filaA, 'saca')?.click();
    // La que se va sale fuera del flujo, esfumándose: se mide a mitad de camino.
    await __dormir(60);
    const yendose = document.querySelector('#qr-cola > [data-state=closing]');
    r.salidaAbsoluta = yendose ? getComputedStyle(yendose).position : null;
    r.salidaOpacidad = yendose ? Math.round(+getComputedStyle(yendose).opacity * 100) : null;
    await __dormir(400);
    r.trasSacar = __nombres();

    // ux-23: el abierto también se saca, y no vuelve al repintar la sección.
    const filaAbierto = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.includes('cobayo'));
    r.abiertoTieneCruz = !!__boton(filaAbierto, 'saca');
    __boton(filaAbierto, 'saca')?.click();
    await __dormir(400);
    __tab('dividir'); await __dormir(300);
    __tab('combinar'); await __dormir(400);
    r.sinElAbierto = __nombres();
    return r;
  })()`)]);
  {
    const c = notas.at(-1)[1];
    const n = (l) => JSON.stringify((l || []).map((x) => x.replace(/\.pdf$/, '')));
    if (n(c.agregados) !== '["cobayo","apuntes-a","apuntes-b"]') problemas.push(`combinar: al agregar quedó ${n(c.agregados)}`);
    if (n(c.trasSubir1) !== '["cobayo","apuntes-b","apuntes-a"]') problemas.push(`combinar: Subir no subió (${n(c.trasSubir1)})`);
    if (n(c.trasSubir2) !== '["apuntes-b","cobayo","apuntes-a"]') problemas.push(`combinar: el segundo Subir dejó ${n(c.trasSubir2)}`);
    if (!c.mismaFila1 || !c.mismaFila2) problemas.push('combinar: la fila que sube no es el mismo nodo');
    if (!c.focoSeQueda) problemas.push('combinar: el foco se fue del botón Subir');
    if (!c.subeApagado || !c.focoEnLaFila) problemas.push(`combinar: arriba de todo, Subir se apaga y el foco queda en la fila (apagado ${c.subeApagado}, en la fila ${c.focoEnLaFila})`);
    if (JSON.stringify(c.ordenes) !== '["1","2","3"]') problemas.push(`combinar: los números de orden quedaron ${JSON.stringify(c.ordenes)}`);
    if (n(c.trasSacar) !== '["apuntes-b","cobayo"]') problemas.push(`combinar: Sacar dejó ${n(c.trasSacar)} (tenía que irse uno solo)`);
    if (c.salidaAbsoluta !== 'absolute' || !(c.salidaOpacidad > 0 && c.salidaOpacidad < 100)) {
      problemas.push(`combinar: la fila que se saca tiene que esfumarse fuera del flujo (${c.salidaAbsoluta}, ${c.salidaOpacidad} %)`);
    }
    if (!c.abiertoTieneCruz) problemas.push('combinar: el documento abierto no tiene cruz para sacarlo (ux-23)');
    if (n(c.sinElAbierto) !== '["apuntes-b"]') problemas.push(`combinar: el abierto volvió a la lista (${n(c.sinElAbierto)})`);
  }

  // ── 2-4. Exportar: el panel, la cápsula y el fundido ───────────────────────
  notas.push(['panel', await paso('panel', `(async () => {
    const r = {};
    const capsula = (id) => {
      const seg = document.getElementById(id);
      const act = seg?.querySelector('.ox-segmented__opt.is-active');
      if (!seg || !act) return null;
      const cs = getComputedStyle(seg, '::before');
      const x = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform).m41 : 0;
      const ancho = parseFloat(cs.width) || 0;
      const centro = parseFloat(cs.left || 0) + x + ancho / 2;
      return { ancho: Math.round(ancho), desvio: Math.round(Math.abs(centro - (act.offsetLeft + act.offsetWidth / 2)) * 10) / 10 };
    };
    __tab('exportar'); await __dormir(450);
    const panel = __panel();
    r.capsulaFormato = capsula('qr-exp-formato');
    r.animacionPropia = panel ? getComputedStyle(panel).animationName : null;
    const hint0 = __vivo(document.getElementById('qr-exp-hint'));
    document.querySelector('#qr-exp-dpi .qr-dpi[data-value="300"]').click();
    await __dormir(30);
    r.animacionesTrasDpi = panel ? panel.getAnimations().length : null;
    await __dormir(400);
    r.mismoPanelDpi = __panel() === panel;
    r.dpiActivo = document.querySelector('#qr-exp-dpi .qr-dpi.is-active')?.dataset.value;
    r.hint = [hint0, __vivo(document.getElementById('qr-exp-hint'))];
    // El formato: la cápsula viaja y Calidad se despliega, sin rehacer nada.
    const calidad = document.getElementById('qr-exp-campo-calidad');
    r.calidadAntes = calidad?.hidden;
    document.querySelector('#qr-exp-formato [data-value="jpeg"]').click();
    await __dormir(450);
    r.mismoPanelFormato = __panel() === panel;
    r.mismoCampoCalidad = document.getElementById('qr-exp-campo-calidad') === calidad;
    r.calidadDespues = calidad?.hidden;
    r.capsulaJpeg = capsula('qr-exp-formato');
    // herr-31: el eco de Calidad mide lo mismo en 99 que en 100.
    const slider = document.getElementById('qr-exp-calidad');
    const eco = document.getElementById('qr-exp-calidad-eco');
    const anchoEco = (v) => { slider.value = String(v); slider.dispatchEvent(new Event('input', { bubbles: true })); return eco.getBoundingClientRect().width; };
    r.eco = [anchoEco(99), anchoEco(100)].map((w) => Math.round(w * 10) / 10);
    // herr-23: con el lector girado un cuarto, la medida se anuncia girada.
    const est = await import('./js/estado.js');
    est.S.rotacion = 90;
    document.querySelector('#qr-exp-dpi .qr-dpi[data-value="300"]').click();
    await __dormir(450);
    r.hintGirado = __vivo(document.getElementById('qr-exp-hint'));
    est.S.rotacion = 0;
    document.querySelector('#qr-exp-dpi .qr-dpi[data-value="300"]').click();
    __tab('dividir'); await __dormir(450);
    r.capsulaCorte = capsula('qr-div-tipo');
    return r;
  })()`)]);
  {
    const p = notas.at(-1)[1];
    if (p.animacionPropia !== 'none') problemas.push(`panel: tiene animación propia (${p.animacionPropia})`);
    if (p.animacionesTrasDpi !== 0) problemas.push(`panel: al tocar el DPI el panel anima (${p.animacionesTrasDpi})`);
    if (!p.mismoPanelDpi || !p.mismoPanelFormato) problemas.push('panel: tocar el DPI o el formato rehízo el panel');
    if (p.dpiActivo !== '300') problemas.push(`panel: el DPI activo es ${p.dpiActivo}`);
    if (!/2480 × 3508|2479 × 3507|2480 × 3507|2479 × 3508/.test(p.hint?.[1] || '')) problemas.push(`panel: la medida no siguió al DPI ("${p.hint?.[1]}")`);
    if (!(p.calidadAntes === true && p.calidadDespues === false && p.mismoCampoCalidad)) problemas.push('panel: Calidad tiene que desplegarse en el lugar con JPEG');
    if (!p.eco || p.eco[0] !== p.eco[1]) problemas.push(`panel: el eco de Calidad cambia de ancho en 100 (${JSON.stringify(p.eco)}, herr-31)`);
    if (!/3508 × 2479|3507 × 2479|3508 × 2480|3507 × 2480/.test(p.hintGirado || '')) problemas.push(`panel: con el lector girado la medida no se da vuelta ("${p.hintGirado}", herr-23)`);
    for (const [k, c] of [['formato', p.capsulaFormato], ['jpeg', p.capsulaJpeg], ['corte', p.capsulaCorte]]) {
      if (!c || c.ancho <= 0) problemas.push(`cápsula[${k}]: mide ${c?.ancho} (tiene que verse)`);
      else if (c.desvio > 1) problemas.push(`cápsula[${k}]: corrida ${c.desvio} px de la opción activa`);
    }
  }

  notas.push(['fundido', await paso('fundido', `(async () => {
    const cuerpo = document.getElementById('herr-cuerpo');
    const alfa = (color) => { const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = color; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[3]; };
    const muestra = () => {
      const calco = cuerpo.querySelector(':scope > .ox-swap-out--fundido');
      const nueva = __panel();
      const viejo = calco ? Math.round(+getComputedStyle(calco).opacity * 100) : null;
      const nuevo = nueva ? Math.round(+getComputedStyle(nueva).opacity * 100) : 0;
      return { viejo, nuevo, tapado: Math.round(viejo == null ? nuevo : viejo + (100 - viejo) * nuevo / 100),
        quieta: nueva ? getComputedStyle(nueva).transform === 'none' : null,
        fondo: calco ? alfa(calco.style.background || getComputedStyle(calco).backgroundColor) : null };
    };
    // La serie en vivo: de Dividir a Exportar, cada 15 ms.
    __tab('exportar');
    const serie = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 300) { serie.push({ t: Math.round(performance.now() - t0), ...muestra() }); await __dormir(15); }
    await __dormir(200);
    // Congelado a los 90 ms (solo lo que corre): de Exportar a Combinar.
    __tab('combinar');
    await new Promise((r) => requestAnimationFrame(r));
    const corriendo = cuerpo.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
    for (const a of corriendo) { a.pause(); a.currentTime = 90; }
    const congelado = muestra();
    for (const a of corriendo) a.play();
    await __dormir(400);
    return { serie, congelado, calcosAlFinal: cuerpo.querySelectorAll(':scope > .ox-swap-out').length };
  })()`)]);
  {
    const f = notas.at(-1)[1];
    f.serie = f.serie || [];
    f.congelado = f.congelado || {};
    const conCalco = f.serie.filter((m) => m.viejo != null);
    if (!conCalco.length) problemas.push('fundido: cambiar de pestaña no armó el calco `.ox-swap-out--fundido`');
    else {
      if (f.serie.some((m) => m.tapado < 97)) problemas.push(`fundido: la pantalla se destapa (${f.serie.map((m) => m.tapado).join(' ')})`);
      if (conCalco.some((m) => m.fondo !== 255)) problemas.push('fundido: el calco no es opaco');
      if (f.serie.some((m) => m.quieta === false)) problemas.push('fundido: lo nuevo se mueve debajo del calco');
      if (!conCalco.some((m) => m.viejo > 5 && m.viejo < 95)) problemas.push(`fundido: el calco no pasa por opacidades intermedias (${conCalco.map((m) => m.viejo).join(' ')})`);
    }
    const c = f.congelado;
    if (c.viejo == null || !(c.viejo > 5 && c.viejo < 95) || c.tapado < 97) problemas.push(`fundido: congelado a 90 ms (${JSON.stringify(c)})`);
    if (f.calcosAlFinal) problemas.push(`fundido: quedaron ${f.calcosAlFinal} calcos`);
  }

  // ── 5. Dividir ─────────────────────────────────────────────────────────────
  notas.push(['dividir', await paso('dividir', `(async () => {
    const r = {};
    __tab('dividir'); await __dormir(450);
    document.querySelector('#qr-div-tipo [data-value="cada"]').click();
    await __dormir(300);
    const chips = () => [...document.querySelectorAll('#qr-div-lista > [data-key]:not([data-state=closing])')];
    const eyebrow = document.getElementById('qr-div-eyebrow');
    const antes = chips();
    r.chipsAntes = antes.map((c) => c.textContent.trim());
    const cada = document.getElementById('qr-div-cada');
    cada.value = '2';
    cada.dispatchEvent(new Event('input', { bubbles: true }));
    await __dormir(400);
    const despues = chips();
    r.chipsDespues = despues.map((c) => c.textContent.trim());
    r.mismoPrimerChip = despues[0] === antes[0];
    r.mismoEyebrow = document.getElementById('qr-div-eyebrow') === eyebrow;
    r.eyebrow = __vivo(document.getElementById('qr-div-eyebrow'));

    document.querySelector('#qr-div-tipo [data-value="rangos"]').click();
    await __dormir(350);
    r.campos = { cada: document.getElementById('qr-div-campo-cada').hidden, rangos: document.getElementById('qr-div-campo-rangos').hidden };
    const rangos = document.getElementById('qr-div-rangos');
    rangos.focus();
    // Una coma de más: no es «todo el documento».
    rangos.value = '1-2, 3-4,';
    rangos.dispatchEvent(new Event('input', { bubbles: true }));
    await __dormir(450);
    r.trasEscribir = __vivo(document.getElementById('qr-div-eyebrow'));
    r.chipsRangos = chips().map((c) => c.textContent.trim());
    rangos.value = '1-2, x';
    rangos.dispatchEvent(new Event('input', { bubbles: true }));
    await __dormir(450);
    r.hint = __vivo(document.getElementById('qr-div-hint'));
    r.focoEnRangos = document.activeElement === rangos;
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    d.chipsAntes = d.chipsAntes || []; d.campos = d.campos || {};
    if (d.chipsAntes.length !== 4) problemas.push(`dividir: de a 1 tendría que haber 4 chips (${d.chipsAntes.length})`);
    if (JSON.stringify(d.chipsDespues) !== '["1. 1–2","2. 3–4"]') problemas.push(`dividir: de a 2 quedó ${JSON.stringify(d.chipsDespues)}`);
    if (!d.mismoPrimerChip) problemas.push('dividir: el primer chip se rehízo en vez de cambiar su texto');
    if (!d.mismoEyebrow || d.eyebrow !== 'Van a salir 2 archivos') problemas.push(`dividir: el eyebrow ("${d.eyebrow}", mismo nodo ${d.mismoEyebrow})`);
    if (!(d.campos.cada === true && d.campos.rangos === false)) problemas.push(`dividir: los campos no se cambiaron de lugar (${JSON.stringify(d.campos)})`);
    if (d.trasEscribir !== 'Van a salir 2 archivos') problemas.push(`dividir: los rangos no siguen lo que se escribe, o la coma de más suma un archivo ("${d.trasEscribir}")`);
    if (!/«x»/.test(d.hint || '')) problemas.push(`dividir: no avisa lo que no entendió ("${d.hint}")`);
    if (!d.focoEnRangos) problemas.push('dividir: escribir en los rangos le sacó el foco al campo');
  }

  // ── 6. Exportar con tinta ──────────────────────────────────────────────────
  notas.push(['exportar-tinta', await paso('exportar-tinta', `(async () => {
    const est = await import('./js/estado.js');
    const { exportarImagenes } = await import('./js/exportar.js');
    // Un trazo rojo gordo en la página 1, abajo de todo (lejos de las esquinas de arriba).
    est.S.tinta.agregar(1, { herramienta: 'pluma', color: '#ff0000', ancho: 12, opacidad: 1,
      puntos: [[100, 120, 1], [300, 120, 1], [480, 120, 1]] });
    const [img] = await exportarImagenes(est.S.doc, { paginas: [1], formato: 'png', dpi: 72, capa: est.S.tinta });
    const bm = await createImageBitmap(new Blob([img.bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bm, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let rojos = 0; let oscuros = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      if (r > 200 && g < 70 && b < 70) rojos++;
      else if (r < 90 && g < 90 && b < 90) oscuros++;
    }
    // La esquina sale del mismo volcado: una segunda lectura del canvas es otro aviso de consola.
    const k = (4 * c.width + 4) * 4;
    const esquina = [px[k], px[k + 1], px[k + 2]];
    /* imprimir-28: las medidas se validan todas antes de empezar. A 4000 dpi
       no entra ninguna: el error las nombra y no se entregó ninguna imagen. */
    let entregadas = 0; let limite = null;
    try {
      await exportarImagenes(est.S.doc, { paginas: [1, 2, 3], dpi: 4000, onImagen: () => { entregadas++; } });
    } catch (e) { limite = e.message; }
    return { ancho: c.width, alto: c.height, esquina, rojos, oscuros, total: c.width * c.height, limite, entregadas };
  })()`)]);
  {
    const t = notas.at(-1)[1];
    t.esquina = t.esquina || [];
    if (!t.esquina.length || !t.esquina.every((v) => v >= 245)) problemas.push(`exportar con tinta: el fondo no es blanco (${t.esquina})`);
    if (t.rojos < 200) problemas.push(`exportar con tinta: el trazo no está (${t.rojos} px rojos)`);
    // El texto del cobayo sigue: muchos oscuros, pero lejos de ser la página entera.
    if (t.oscuros < 100 || t.oscuros > t.total * 0.5) problemas.push(`exportar con tinta: el texto (${t.oscuros} px oscuros de ${t.total})`);
    if (!/páginas 1, 2 y 3/.test(t.limite || '') || t.entregadas) problemas.push(`exportar: el límite se tiene que validar antes, nombrando las páginas ("${t.limite}", ${t.entregadas} entregadas)`);
  }

  // ── 7. La barra de exportar, dos veces seguidas ────────────────────────────
  notas.push(['exportar-barra', await paso('exportar-barra', `(async () => {
    __tab('exportar'); await __dormir(450);
    document.querySelector('#qr-exp-formato [data-value="png"]').click();
    document.querySelector('#qr-exp-dpi .qr-dpi[data-value="150"]').click();
    await __dormir(300);
    const vuelta = async () => {
      const barra = document.getElementById('qr-exp-progreso');
      const relleno = barra.querySelector('.ox-meter__fill');
      const pista = barra.querySelector('.ox-meter');
      document.getElementById('qr-exp-hacer').click();
      await __hasta(() => !barra.hidden, 5000);
      const serie = [];
      const textos = [];
      const t0 = performance.now();
      while (!barra.hidden && performance.now() - t0 < 15000) {
        serie.push(Math.round(relleno.getBoundingClientRect().width / Math.max(1, pista.getBoundingClientRect().width) * 100));
        textos.push(__vivo(document.getElementById('qr-exp-hechas')));
        await new Promise((r) => requestAnimationFrame(r));
      }
      await __dormir(500);
      return { serie: serie.slice(0, 6), max: Math.max(...serie), textoInicial: textos[0], textos: [...new Set(textos)] };
    };
    const primera = await vuelta();
    const segunda = await vuelta();
    return { primera, segunda, libre: !document.querySelector('#qr-exp-hacer > .qr-girando') };
  })()`)]);
  {
    const b = notas.at(-1)[1];
    for (const [k, v] of [['primera', b.primera], ['segunda', b.segunda]]) {
      if (!(v?.serie?.[0] <= 30)) problemas.push(`barra[${k}]: arranca en ${v?.serie?.[0]} % (tiene que arrancar de 0)`);
      if (v?.textoInicial !== '0' && v?.textoInicial !== '1') problemas.push(`barra[${k}]: el texto arranca en "${v?.textoInicial}"`);
    }
    if (!b.libre) problemas.push('barra: el botón quedó ocupado');
    const escritos = fs.readdirSync(salidas).sort();
    notas.push(['disco-exportar', escritos]);
    const pngs = escritos.filter((f) => f.endsWith('.png'));
    if (pngs.length !== 8) problemas.push(`exportar: tenían que quedar 8 PNG (4 + 4 numerados), hay ${pngs.length}: ${pngs.join(', ')}`);
    if (!pngs.includes('cobayo-1 (2).png')) problemas.push('exportar: la segunda tanda tenía que numerarse, no pisar (herr-18)');
  }

  // ── 8. Combinar con lo anotado, y el botón ocupado ─────────────────────────
  eleccion = [COBAYO, A];
  demoraGuardar = 900;
  notas.push(['combinar-tinta', await paso('combinar-tinta', `(async () => {
    const r = {};
    __tab('combinar'); await __dormir(450);
    // Queda solo apuntes-b de antes: se saca, y entran el abierto (desde el diálogo) y apuntes-a.
    __boton(__filas()[0], 'saca')?.click();
    await __dormir(450);
    r.vacio = !!document.querySelector('#qr-comb-lista > .ox-empty');
    document.getElementById('qr-comb-agregar')?.click();
    await __hasta(() => __filas().length === 2);
    await __dormir(400);
    r.cola = __nombres();

    const boton = document.getElementById('qr-comb-hacer');
    // El destello del clic, como lo pone initClickFlash en un pointerdown de verdad.
    boton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    boton.click();
    await __dormir(250);
    r.ocupado = { girando: !!boton.querySelector(':scope > .qr-girando'), deshabilitado: boton.disabled,
      texto: __vivo(boton) };
    // Un repintado de la vista en el medio: el botón nuevo nace ocupado.
    (await import('./js/router.js')).default.refresh();
    await __dormir(250);
    const nuevo = document.getElementById('qr-comb-hacer');
    r.trasRepintar = { otroNodo: nuevo !== boton, girando: !!nuevo.querySelector(':scope > .qr-girando'), deshabilitado: nuevo.disabled };
    await __hasta(() => !document.querySelector('#qr-comb-hacer > .qr-girando') && !document.getElementById('qr-comb-hacer').disabled, 8000);
    await __dormir(900);
    const fin = document.getElementById('qr-comb-hacer');
    r.libre = { texto: __vivo(fin), deshabilitado: fin.disabled, destellos: fin.querySelectorAll('.ox-flash').length };
    r.toast = __vivo([...document.querySelectorAll('.ox-toast')].at(-1));
    return r;
  })()`)]);
  {
    const c = notas.at(-1)[1];
    if (!c.vacio) problemas.push('combinar: sin archivos tenía que quedar el vacío');
    if (JSON.stringify(c.cola) !== '["cobayo.pdf","apuntes-a.pdf"]') problemas.push(`combinar: la cola para combinar es ${JSON.stringify(c.cola)}`);
    c.ocupado = c.ocupado || {}; c.trasRepintar = c.trasRepintar || {}; c.libre = c.libre || {};
    if (!c.ocupado.girando || !c.ocupado.deshabilitado || !/Combinando/.test(c.ocupado.texto)) problemas.push(`ocupado: el botón no se ve ocupado (${JSON.stringify(c.ocupado)})`);
    if (!c.trasRepintar.girando || !c.trasRepintar.deshabilitado) problemas.push(`ocupado: repintada la vista, el botón nació libre (${JSON.stringify(c.trasRepintar)})`);
    if (c.libre.texto !== 'Combinar y guardar' || c.libre.deshabilitado) problemas.push(`ocupado: al terminar el botón no volvió (${JSON.stringify(c.libre)})`);
    if (c.libre.destellos) problemas.push(`ocupado: quedaron ${c.libre.destellos} destellos en el botón (herr-15)`);
    if (/→/.test(c.toast || '')) problemas.push(`combinar: el toast tiene una flecha unicode ("${c.toast}")`);
  }
  {
    // El combinado: la página 1 es la del abierto y tiene que traer el trazo rojo.
    const combinado = path.join(tmp, 'cobayo-combinado.pdf');
    if (!fs.existsSync(combinado)) problemas.push('combinar: no se guardó el combinado');
    else {
      const rojo = await paso('combinado', `(async () => {
        const { abrirDocumento } = await import('./js/pdf/documento.js');
        const bytes = new Uint8Array(await window.onyx.docs.leer(${JSON.stringify(combinado)}, { reciente: false }).then((a) => a.bytes));
        const d = await abrirDocumento(bytes, { nombre: 'x.pdf' });
        const canvas = await d.lienzo(1, { escala: 1, dpr: 1 });
        const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 70 && px[i + 2] < 70) n++;
        const paginas = d.paginas;
        d.destruir();
        return { rojos: n, paginas };
      })()`);
      notas.push(['combinado', rojo]);
      if (rojo.paginas !== 8) problemas.push(`combinar: el combinado tiene ${rojo.paginas} páginas (tenían que ser 8)`);
      if (rojo.rojos < 200) problemas.push(`combinar: el combinado salió sin lo anotado (${rojo.rojos} px rojos, herr-20)`);
    }
  }

  // ── 9. Soltar en Combinar (ux-13): la función que va a usar el arrastre ────
  notas.push(['encolar', await paso('encolar', `(async () => {
    const mod = await import('./js/views/herramientas.js');
    __tab('exportar'); await __dormir(450);
    const n = await mod.encolarCombinar(${JSON.stringify([B, path.join(tmp, 'no-existe.png')])});
    await __dormir(500);
    return {
      n, seccion: mod.seccionActual(),
      tab: document.querySelector('#herr-tabs .ox-tab.is-active')?.dataset.value,
      cola: __nombres(),
      aviso: __vivo([...document.querySelectorAll('.ox-toast')].at(-1)),
    };
  })()`)]);
  {
    const e = notas.at(-1)[1];
    if (e.n !== 1 || e.seccion !== 'combinar' || e.tab !== 'combinar') problemas.push(`encolar: tenía que entrar uno y pasar a Combinar (${JSON.stringify(e)})`);
    if (!(e.cola || []).includes('apuntes-b.pdf')) problemas.push(`encolar: apuntes-b no está en la cola (${JSON.stringify(e.cola)})`);
    if (!/no-existe/.test(e.aviso || '')) problemas.push(`encolar: el que no se pudo leer no se avisó ("${e.aviso}")`);
  }

  // ── 10. El destello del clic no vuelve al terminar (herr-15) ───────────────
  /* En el MISMO botón y sin repintar en el medio: el chequeo del paso 8
     cuenta en el botón nacido del repintado, que nunca tuvo un destello, y
     daba 0 también con el código viejo. Con la foto del innerHTML, el
     destello que estaba al empezar se volvía a crear al terminar, sin nadie
     que lo sacara. */
  demoraGuardar = 300;
  notas.push(['destellos', await paso('destellos', `(async () => {
    __tab('combinar'); await __dormir(450);
    const boton = document.getElementById('qr-comb-hacer');
    const r = { habilitado: !boton.disabled };
    boton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    r.alClic = boton.querySelectorAll('.ox-flash').length;
    boton.click();
    await __hasta(() => boton.dataset.ocupado === '1', 2000);
    await __hasta(() => boton.dataset.ocupado === '0' && !boton.disabled, 8000);
    await __dormir(900);
    r.mismoBoton = document.getElementById('qr-comb-hacer') === boton;
    r.texto = __vivo(boton);
    r.destellos = boton.querySelectorAll('.ox-flash').length;
    return r;
  })()`)]);
  {
    const d = notas.at(-1)[1];
    if (!d.habilitado || !(d.alClic >= 1)) problemas.push(`destellos: el clic tenía que poner su destello para que esto pruebe algo (${JSON.stringify(d)})`);
    else if (!d.mismoBoton) problemas.push('destellos: la vista se repintó en el medio y el botón es otro');
    else if (d.destellos) problemas.push(`destellos: al terminar quedaron ${d.destellos} destellos en el botón (herr-15)`);
    if (d.texto !== 'Combinar y guardar') problemas.push(`destellos: al terminar el botón dice "${d.texto}"`);
  }

  // ── 11. Dos documentos sin ruta, dos filas ─────────────────────────────────
  /* Uno sin ruta que ya se materializó en la cola (al bajarlo) y el abierto
     nuevo de otra pestaña, también sin ruta: con la clave «abierto» para los
     dos, reconcile hacía una sola fila. Los documentos son de mentira (solo lo
     que lee la fila) y se ponen directo en S.doc, sin avisar a nadie. */
  notas.push(['sin-ruta', await paso('sin-ruta', `(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;
    const original = est.S.doc;
    const r = {};
    try {
      est.S.doc = { nombre: 'sin-ruta-a.pdf', paginas: 1, tamano: 1000 };
      router.refresh(); await __dormir(500);
      r.conA = __nombres();
      __boton(__filas()[0], 'baja')?.click();
      await __dormir(450);
      r.materializado = __nombres();
      est.S.doc = { nombre: 'sin-ruta-b.pdf', paginas: 2, tamano: 2000 };
      router.refresh(); await __dormir(500);
      r.conB = __nombres();
      // Sacar el de A saca el de A: con la misma clave, moverEnCola agarraba el primero (el de B).
      const filaA = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.includes('sin-ruta-a'));
      __boton(filaA, 'saca')?.click();
      await __dormir(500);
      r.sinA = __nombres();
    } finally {
      est.S.doc = original;
      router.refresh(); await __dormir(500);
    }
    return r;
  })()`)]);
  {
    const s = notas.at(-1)[1];
    const n = (l) => JSON.stringify((l || []).map((x) => x.replace(/\.pdf$/, '')));
    if (n(s.materializado) !== '["cobayo","sin-ruta-a","apuntes-a","apuntes-b"]') problemas.push(`sin ruta: al bajar el abierto quedó ${n(s.materializado)} (antes ${n(s.conA)})`);
    else if (n(s.conB) !== '["sin-ruta-b","cobayo","sin-ruta-a","apuntes-a","apuntes-b"]') problemas.push(`sin ruta: con otro abierto sin ruta la cola muestra ${n(s.conB)}`);
    else if (n(s.sinA) !== '["sin-ruta-b","cobayo","apuntes-a","apuntes-b"]') problemas.push(`sin ruta: Sacar en sin-ruta-a dejó ${n(s.sinA)}`);
  }

  // ── 12. Soltar archivos (ux-13): el arrastre de la ventana ────────────────
  /* Por soltarArchivos de app.js, que es lo que llama el 'drop' de la
     ventana con la lista de lo soltado: un File fabricado en la página no
     tiene ruta en disco (webUtils da ''), así que un drop sintético no llega
     más allá de «No se pudo ubicar el archivo». */
  notas.push(['soltar', await paso('soltar', `(async () => {
    const { soltarArchivos } = await import('./js/app.js');
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;
    const toasts = () => [...document.querySelectorAll('.ox-toast:not([data-state=closing])')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim());
    const r = {};
    __tab('combinar'); await __dormir(450);
    const pestanas = est.S.pestanas.length;
    const { pendientes } = await import('./js/views/convertir.js');
    const enConvertir = pendientes();
    await soltarArchivos([
      { nombre: 'apuntes-c.pdf', ruta: ${JSON.stringify(C)} },
      { nombre: 'foto-guia.png', ruta: ${JSON.stringify(FOTO)} },
      { nombre: 'notas-guia.txt', ruta: ${JSON.stringify(NOTAS)} },
    ]);
    await __dormir(700);
    r.enCombinar = { vista: router.name, pestanas: est.S.pestanas.length - pestanas, nombres: __nombres(), toasts: toasts(), aConvertir: pendientes() - enConvertir };

    // Si el PDF abrió una pestaña (el código de antes), se vuelve: lo de abajo igual se mide.
    if (router.name !== 'herramientas') { router.go('herramientas'); await __dormir(700); }
    __tab('dividir'); await __dormir(450);
    await soltarArchivos([{ nombre: 'foto-guia-2.png', ruta: ${JSON.stringify(FOTO2)} }]);
    await __dormir(800);
    r.desdeDividir = {
      vista: router.name,
      tab: document.querySelector('#herr-tabs .ox-tab.is-active')?.dataset.value,
      nombres: __nombres(), toasts: toasts(),
    };
    return r;
  })()`)]);
  {
    const r = notas.at(-1)[1];
    const a = r.enCombinar || {};
    const b = r.desdeDividir || {};
    if (a.vista !== 'herramientas' || a.pestanas !== 0) problemas.push(`soltar: en Combinar, soltar un PDF abrió una pestaña o cambió de vista (${JSON.stringify(a)})`);
    if (!a.nombres?.includes('apuntes-c.pdf') || !a.nombres?.includes('foto-guia.png')) problemas.push(`soltar: en Combinar, el PDF y la imagen soltados no quedaron en la lista (${JSON.stringify(a.nombres)})`);
    /* Soltado junto, lo que no se combina pero se convierte iba a ningún
       lado sin decir nada (revisión del 4A): va a la cola de Convertir y un
       aviso lo dice, sin sacarte de Combinar. */
    if (a.aConvertir !== 1 || !a.toasts?.some((t) => /1 archivo fue a Convertir/.test(t)) || a.nombres?.includes('notas-guia.txt')) problemas.push(`soltar: en Combinar, el .txt soltado junto no fue a Convertir con su aviso (${JSON.stringify(a)})`);
    if (a.toasts?.some((t) => /Acá se abren PDFs|Eso no es un PDF/.test(t))) problemas.push(`soltar: en Combinar, soltar dio un error (${JSON.stringify(a.toasts)})`);
    if (b.vista !== 'herramientas' || b.tab !== 'combinar' || !b.nombres?.includes('foto-guia-2.png')) problemas.push(`soltar: desde Dividir, la imagen tenía que llevar a Combinar con ella en la lista (${JSON.stringify(b)})`);
  }

  // ── 13. Un PDF con contraseña ─────────────────────────────────────────────
  /* Combinar y Dividir copian páginas con pdf-lib, que no descifra: con un
     PDF abierto con contraseña salían hojas en blanco (decisión de Fran:
     avisar y bloquear, paquete 4A). Se fabrica el estado, conClave en el
     documento abierto como lo deja el lector, y se espía pdf-lib en la misma
     instancia de módulo que usa el motor. Exportar rasteriza con pdf.js: se
     exporta de verdad y tiene que salir, sin tocar pdf-lib.
     Los clics a los botones apagados van por dispatchEvent: .click() sobre
     un botón deshabilitado no despacha nada (medido en Electron 40), y así
     no se probaban las guardias de hacerDividir() y hacerCombinar(), solo
     que el botón estaba apagado (revisión del 4A). Un evento despachado sí
     llega al handler delegado. */
  const clicForzado = `((id) => document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true })))`;
  const pngsAntes = fs.readdirSync(salidas).length;
  notas.push(['con-clave', await paso('con-clave', `(async () => {
    const est = await import('./js/estado.js');
    const router = (await import('./js/router.js')).default;
    const { PDFDocument } = await import('./vendor/pdf-lib/pdf-lib.mjs');
    const cargar = PDFDocument.load; const crear = PDFDocument.create;
    let cargas = 0;
    PDFDocument.load = function (...a) { cargas++; return cargar.apply(this, a); };
    PDFDocument.create = function (...a) { cargas++; return crear.apply(this, a); };
    const boton = (id) => { const b = document.getElementById(id); return b && { apagado: b.disabled, explica: (b.disabled && getComputedStyle(b).pointerEvents === 'auto'), tip: b.dataset.tip || null, puntero: getComputedStyle(b).pointerEvents }; };
    const aviso = (id) => { const a = document.getElementById(id); return a && { visible: !a.hidden && a.getBoundingClientRect().height > 20, texto: __vivo(a) }; };
    const r = {};
    let falsa = null;
    try {
      if (router.name !== 'herramientas') { router.go('herramientas'); await __dormir(700); }
      est.S.doc.conClave = true;
      __tab('dividir'); await __dormir(500);
      r.dividir = { aviso: aviso('qr-div-clave'), boton: boton('qr-div-hacer') };
      ${clicForzado}('qr-div-hacer');
      await __dormir(300);
      r.cargasDividir = cargas;

      __tab('combinar'); await __dormir(500);
      r.combinar = { aviso: aviso('qr-comb-clave'), boton: boton('qr-comb-hacer'), nombres: __nombres() };
      ${clicForzado}('qr-comb-hacer');
      await __dormir(300);
      r.cargasCombinar = cargas;
      // Sacarlo de la lista: lo demás se puede combinar.
      /* El aviso se pliega, no desaparece de golpe (motion-timing §10: el
         alto y la opacidad pasan por valores intermedios). Se muestrea cada
         cuadro desde el mismo task del clic. */
      const fila = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.trim() === 'cobayo.pdf');
      const plegado = document.getElementById('qr-comb-clave');
      const serie = [];
      __boton(fila, 'saca')?.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 450) {
        const cs = getComputedStyle(plegado);
        serie.push({ alto: Math.round(plegado.getBoundingClientRect().height), op: Math.round(+cs.opacity * 100) });
        await new Promise((r) => requestAnimationFrame(r));
      }
      await __dormir(300);
      r.sinEl = { aviso: aviso('qr-comb-clave'), boton: boton('qr-comb-hacer'), nombres: __nombres(), serie };

      /* Plegado, frena otro: el nombre se repone en seco y recién después
         se despliega. Con frase() siempre, el calco de «cobayo.pdf» se
         esfumaba encima del nombre nuevo mientras el aviso se abría
         (revisión del 4A). La contraseña se fabrica con una pestaña del
         mismo archivo que apuntes-c.pdf de la lista, que es lo que mira
         bloqueaCombinar; lo que pone la lista al día es sacar otra fila. */
      falsa = { doc: { ruta: ${JSON.stringify(C)}, nombre: 'apuntes-c.pdf', conClave: true } };
      est.S.pestanas.push(falsa);
      {
        const titulo = document.getElementById('qr-comb-clave-titulo');
        const otra = __filas().find((f) => f.querySelector('.ox-listitem__title').textContent.trim() === 'foto-guia-2.png');
        const serieB = [];
        __boton(otra, 'saca')?.click();
        const t1 = performance.now();
        while (performance.now() - t1 < 450) {
          serieB.push({ calco: !!titulo.querySelector('.ox-swap-out'), texto: __vivo(titulo), alto: Math.round(plegado.getBoundingClientRect().height) });
          await new Promise((r) => requestAnimationFrame(r));
        }
        r.otro = { serie: serieB, hallada: !!otra, aviso: aviso('qr-comb-clave'), boton: boton('qr-comb-hacer') };
      }
      est.S.pestanas.splice(est.S.pestanas.indexOf(falsa), 1);
      falsa = null;

      __tab('exportar'); await __dormir(500);
      r.exportar = { avisos: document.querySelectorAll('#herr-cuerpo > .qr-herr__panel .qr-clave-aviso:not([hidden])').length, boton: boton('qr-exp-hacer') };
      document.getElementById('qr-exp-rango').value = '1';
      document.getElementById('qr-exp-rango').dispatchEvent(new Event('change', { bubbles: true }));
      await __dormir(200);
      document.getElementById('qr-exp-hacer').click();
      await __hasta(() => document.getElementById('qr-exp-hacer')?.dataset.ocupado === '1', 2000);
      await __hasta(() => document.getElementById('qr-exp-hacer')?.dataset.ocupado === '0', 8000);
      r.cargas = cargas;
    } finally {
      PDFDocument.load = cargar; PDFDocument.create = crear;
      if (falsa) est.S.pestanas.splice(est.S.pestanas.indexOf(falsa), 1);
      est.S.doc.conClave = false;
      router.refresh(); await __dormir(500);
    }
    return r;
  })()`)]);
  {
    const r = notas.at(-1)[1];
    const d = r.dividir || {};
    const c = r.combinar || {};
    const sin = r.sinEl || {};
    const e = r.exportar || {};
    if (!d.aviso?.visible || !/Este PDF tiene contraseña/.test(d.aviso.texto || '') || !/todavía no dividirlo/.test(d.aviso.texto || '')) problemas.push(`con clave: Dividir no avisa (${JSON.stringify(d.aviso)})`);
    if (!d.boton?.apagado || !d.boton.explica || !/tiene contraseña: Quire todavía no puede dividirlo/.test(d.boton.tip || '') || d.boton.puntero !== 'auto') problemas.push(`con clave: el botón de Dividir no se apaga diciendo por qué (${JSON.stringify(d.boton)})`);
    if (!c.aviso?.visible || !/«cobayo\.pdf» tiene contraseña/.test(c.aviso.texto || '') || !/todavía no combinarlo/.test(c.aviso.texto || '')) problemas.push(`con clave: Combinar no avisa cuál frena (${JSON.stringify(c.aviso)})`);
    if (!c.boton?.apagado || !c.boton.explica || !/tiene contraseña/.test(c.boton.tip || '')) problemas.push(`con clave: el botón de Combinar no se apaga diciendo por qué (${JSON.stringify(c.boton)})`);
    if (sin.aviso?.visible || sin.boton?.apagado || sin.boton?.explica || sin.boton?.tip || sin.nombres?.includes('cobayo.pdf')) problemas.push(`con clave: sacarlo de la lista no vuelve a habilitar Combinar (${JSON.stringify({ ...sin, serie: undefined })})`);
    {
      const serie = sin.serie || [];
      const alto0 = serie[0]?.alto || 0;
      const medios = serie.filter((f) => f.alto > 2 && f.alto < alto0 - 2).length;
      const final = serie.at(-1);
      if (!(alto0 > 20) || medios < 2 || !final || final.alto > 0) problemas.push(`con clave: el aviso de Combinar no se pliega de a poco (${serie.map((f) => `${f.alto}/${f.op}`).join(' ')})`);
    }
    {
      const o = r.otro || {};
      const serie = o.serie || [];
      const abriendo = serie.filter((f) => f.alto > 2);
      if (!o.hallada || !o.aviso?.visible || !/«apuntes-c\.pdf» tiene contraseña/.test(o.aviso.texto || '') || !o.boton?.apagado) problemas.push(`con clave: otro con contraseña no vuelve a frenar Combinar (${JSON.stringify({ ...o, serie: undefined })})`);
      else if (serie.some((f) => f.calco) || abriendo.some((f) => !/apuntes-c/.test(f.texto || ''))) problemas.push(`con clave: al desplegarse, el aviso mostró el nombre de antes (${serie.map((f) => `${f.alto}${f.calco ? '+calco' : ''}`).join(' ')})`);
      else if (serie[0]?.alto > 2 || abriendo.length < 2) problemas.push(`con clave: el aviso no se desplegó de a poco desde plegado (${serie.map((f) => f.alto).join(' ')})`);
    }
    if (r.cargasDividir !== 0 || r.cargasCombinar !== 0) problemas.push(`con clave: el clic despachado al botón apagado llegó a pdf-lib (dividir ${r.cargasDividir}, combinar ${r.cargasCombinar})`);
    if (e.avisos || e.boton?.apagado) problemas.push(`con clave: Exportar no tendría que avisar ni apagarse, rasteriza con pdf.js (${JSON.stringify(e)})`);
    if (r.cargas !== 0) problemas.push(`con clave: algo llegó a pdf-lib (${r.cargas} cargas)`);
  }
  {
    const nuevos = fs.readdirSync(salidas).length - pngsAntes;
    if (nuevos !== 1) problemas.push(`con clave: Exportar tenía que sacar la página 1 como imagen y salieron ${nuevos}`);
  }

  fs.writeFileSync(path.join(RAIZ, 'test', 'herramientas.png'), (await win.webContents.capturePage()).toPNG());

  console.log('\n===== HERRAMIENTAS =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  console.log('\n----- problemas: ' + problemas.length + ' -----');
  for (const p of problemas) console.log('  ! ' + p);

  win.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* lo limpia el sistema */ }
  await esperar(300);
  app.exit(problemas.length ? 1 : 0);
}).catch(async (err) => {
  console.error('herramientas FALLÓ:', err);
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  for (const p of problemas) console.log('  ! ' + p);
  app.exit(1);
});

app.on('window-all-closed', () => {});
