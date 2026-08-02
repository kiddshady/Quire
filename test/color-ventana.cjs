/* ¿Qué color le manda el renderer a la ventana?
   app.js resuelve --ox-bg y se lo pasa al main con setBackgroundColor(), para
   que el frame que pinta el compositor quede del color de la app. Si ese
   parseo sale mal, el backgroundColor de la ventana queda de un color que no
   es el de la app — y ese color es lo que se ve mientras el contenido no cubra
   la superficie. */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, backgroundColor: '#0a0b0d' });
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

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

    // El método nuevo: dejar que el canvas lo convierta a píxeles.
    const lienzo = document.createElement('canvas');
    lienzo.width = 1; lienzo.height = 1;
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = crudo;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const nuevo = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

    return {
      loQueDevuelveElNavegador: crudo,
      conRegex: viejo,
      conCanvas: nuevo,
      // El fondo que main.cjs usa antes de que el renderer diga nada.
      elQueDeberiaSer: '#0a0b0d',
      coincide: nuevo.toLowerCase() === '#0a0b0d',
      loAceptaElMain: /^#[0-9a-f]{6}$/i.test(nuevo),
    };
  })()`);

  console.log('RESULTADO ' + JSON.stringify(r, null, 2));
  app.exit(0);
});
