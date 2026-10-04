/* ¿Qué color le manda el renderer a la ventana?
   app.js resuelve --ox-bg y se lo pasa al main con setBackgroundColor(), para
   que el frame que pinta el compositor quede del color de la app. Si ese
   parseo sale mal, el backgroundColor de la ventana queda de un color que no
   es el de la app — y ese color es lo que se ve mientras el contenido no cubra
   la superficie (el medio segundo de pantalla verde de `#009500`).

   Hasta octubre de 2026 esto era un diagnóstico que salía siempre con 0, y
   además medía su propia copia de la conversión (tests-02). Ahora escucha lo
   que la app manda de verdad por 'win:set-bg' —el mismo canal que usa
   preload.cjs— y sale con 1 si no es el fondo con el que main.cjs crea la
   ventana. El humo afirma lo mismo en su paso 0; este queda para mirarlo
   suelto, con el detalle de los dos métodos de conversión. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { abandono, hasta } = require('./_comun.cjs');

const RAIZ = path.join(__dirname, '..');

// Datos propios, antes de requerir src/ (el porqué, en datos-propios.cjs).
require('./datos-propios.cjs')('color');
const bail = abandono({ ms: 60000 });

// El fondo de main.cjs, leído del archivo: si retint.mjs lo cambia, esto lo sigue.
const BG = (fs.readFileSync(path.join(RAIZ, 'main.cjs'), 'utf8').match(/const BG = '(#[0-9a-f]{6})'/i) || [])[1];

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  // Esta prueba no carga main.cjs, así que este listener es el único del canal.
  const mandados = [];
  ipcMain.on('win:set-bg', (_e, hex) => mandados.push(hex));

  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 900, height: 700, backgroundColor: BG || '#000',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true },
  });
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  await hasta(() => mandados.length > 0, 10000, 'el renderer no mandó ningún color').catch(() => {});

  const r = await win.webContents.executeJavaScript(`(() => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;left:-9999px;color:var(--ox-bg)';
    document.body.appendChild(probe);
    const crudo = getComputedStyle(probe).color;
    probe.remove();

    // El método viejo: sacar los números con un regex.
    const numeros = crudo.match(/[0-9]+/g);
    const viejo = numeros
      ? '#' + numeros.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
      : null;

    // El método bueno: dejar que el canvas lo convierta a píxeles.
    const lienzo = document.createElement('canvas');
    lienzo.width = 1; lienzo.height = 1;
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = crudo;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const nuevo = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

    return { loQueDevuelveElNavegador: crudo, conRegex: viejo, conCanvas: nuevo };
  })()`);

  /* TODOS los mandados, no el último (revisión del paquete 0C): si la app
     manda un color malo al arrancar —una carrera con tokens.css que da
     #000000, o el verde— y después lo corrige, la ventana ya se vio mal
     pintada, y mirando solo el último la prueba pasaba. */
  const todos = mandados.map((c) => String(c).toLowerCase());
  const mandado = todos.join(', ');
  Object.assign(r, {
    loQueMandoLaApp: mandados,
    elQueDeberiaSer: BG,
    coincide: !!BG && todos.length > 0 && todos.every((c) => c === BG.toLowerCase()),
    loAceptaElMain: todos.length > 0 && todos.every((c) => /^#[0-9a-f]{6}$/.test(c)),
  });

  console.log('RESULTADO ' + JSON.stringify(r, null, 2));
  console.log(r.coincide ? '\n  ok   la app le manda a la ventana su mismo fondo'
    : `\n  FALLA la app le manda ${mandado || 'nada'} a la ventana, que nace con ${BG}`);
  app.exit(r.coincide ? 0 : 1);
}).catch((e) => bail('excepción', e));
