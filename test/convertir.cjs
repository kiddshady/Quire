/* La conversión con Electron de verdad, de punta a punta:

   1. El motor imprime el cuestionario Moodle a PDF con el Chromium de la app
      (lo único que el test de Node no puede probar).
   2. La vista Convertir monta, recibe un archivo por el mismo camino que un
      arrastre, lo convierte, y el PDF resultante aparece abierto en una
      pestaña — que es la promesa entera de haber traído Omnimuter acá.

   Mismo criterio que el humo: se mide DÓNDE cae cada cosa y qué dice, no si
   existe el elemento. La ventana va visible en x:-20000 (ver humo.cjs). */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RAIZ = path.join(__dirname, '..');
const MOODLE = path.join(__dirname, 'fixtures', 'ejemplo-moodle.htm');

const problemas = [];
const notas = [];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Los ajustes son los de la app instalada en esta máquina (mismo userData):
   se guardan antes y se restauran al final, pase lo que pase. */
let ajustesPrevios = null;

app.whenReady().then(async () => {
  const store = require(path.join(RAIZ, 'src', 'store.cjs'));
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  const conversion = require(path.join(RAIZ, 'src', 'conversion.cjs'));
  ipc.register();

  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-convertir-'));

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
  ajustesPrevios = await store.loadSettings();
  await store.saveSettings({
    conversion: {
      ...ajustesPrevios.conversion,
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
  win.webContents.on('console-message', (e) => {
    if (e.level >= 2) problemas.push(`consola[${e.level}] ${e.message.slice(0, 200)}`);
  });
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);
  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

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
      sub: item?.querySelector('.ox-listitem__sub')?.textContent.trim(),
      contadorRail: document.getElementById('nav-convertir-count')?.textContent.trim(),
      botonDeshabilitado: document.getElementById('cv-convertir')?.disabled,
      resumen: document.getElementById('cv-resumen')?.textContent.replace(/\\s+/g, ' ').trim(),
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
      const sub = item?.querySelector('.ox-listitem__sub')?.textContent || '';
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
      sub: item.querySelector('.ox-listitem__sub')?.textContent.trim(),
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

  console.log('\n===== CONVERTIR =====');
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  console.log('\n----- problemas: ' + problemas.length + ' -----');
  for (const p of problemas) console.log('  ! ' + p);

  /* Y las pestañas: la app de este test abrió PDFs temporales que ya no van a
     existir, y sin esto quedan en la sesión guardada de la app instalada. */
  win.destroy();
  await esperar(300);
  await store.saveSettings({ conversion: ajustesPrevios.conversion, ultimosDocumentos: ajustesPrevios.ultimosDocumentos });
  app.exit(problemas.length ? 1 : 0);
}).catch(async (err) => {
  console.error('convertir FALLÓ:', err);
  for (const [k, v] of notas) console.log(k + ': ' + JSON.stringify(v));
  for (const p of problemas) console.log('  ! ' + p);
  if (ajustesPrevios) {
    const store = require(path.join(RAIZ, 'src', 'store.cjs'));
    await store.saveSettings({ conversion: ajustesPrevios.conversion, ultimosDocumentos: ajustesPrevios.ultimosDocumentos }).catch(() => {});
  }
  app.exit(1);
});

// Sin esto, destruir la ventana oculta de printToPDF mata el proceso.
app.on('window-all-closed', () => {});
