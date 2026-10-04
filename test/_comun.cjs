'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Lo que comparten las suites: abandonar en vez de colgarse, esperar una
   señal en vez de un número de milisegundos, y leer lo que se ve.

   Nació de la auditoría de octubre de 2026 (tests-07, tests-13, tests-18,
   lector-39). Cada suite tenía su propia copia de estas cosas, o no la
   tenía:

   · Humo, tinta e imposición no tenían timeout ni manejador de rechazos: un
     executeJavaScript que rechazaba dejaba el proceso de Electron vivo con la
     ventana fuera de pantalla, y `npm run verificar` se quedaba trabado sin
     decir nada. cartel.cjs ya lo hacía bien (bail + los dos process.on + un
     setTimeout): `abandono()` es eso, en un solo lugar.

   · `hasta()` vivía en cerrar.cjs y era sincrónico (`const v = fn(); if (v)
     return v`). Con una condición del renderer, que es un executeJavaScript y
     devuelve una Promise, volvía en el acto: una Promise es truthy. Acá
     espera lo que devuelve fn, sea un valor o una Promise.

   · Con swap() y reconcile() de Onyx, lo que se va sigue en el DOM un rato:
     el texto viejo en un calco `.ox-swap-out`, las filas viejas con
     data-state="closing". Un textContent pelado lee las dos frases pegadas
     («1 de 42 de 4») y un querySelectorAll cuenta filas que ya no están
     (motion-timing, punto 11). `vivo()` y `sinSalir()` leen solo lo que
     queda.

     const { abandono, hasta, vivo, muestrear } = require('./_comun.cjs');
     const bail = abandono();          // 120 s por defecto
   ═══════════════════════════════════════════════════════════════════════════ */

const { vigilarConsola, esGrave } = require('./consola.cjs');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Con Electron, `require('electron')` da el módulo; con Node pelado (apertura
   lanza procesos y no corre adentro de Electron) da la ruta del ejecutable,
   un string. Por eso la salida se resuelve recién al salir: además así se
   agarra el app.exit que envuelve datos-propios.cjs, que borra la carpeta de
   datos al salir, aunque esa envoltura se haya puesto después de esto. */
function salidaPorDefecto(codigo) {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && typeof electron.app?.exit === 'function') {
    electron.app.exit(codigo);
  } else {
    process.exit(codigo);
  }
}

/**
 * Arma la red de la suite: un rechazo o una excepción sin atajar, o pasarse
 * de `ms`, terminan el proceso con código 3 diciendo por qué, en vez de
 * dejarlo colgado. Devuelve `bail(motivo, error)` para abandonar a mano.
 *
 * `salir(codigo)` reemplaza la salida por defecto (app.exit, o process.exit
 * con Node pelado) cuando hay que limpiar algo antes: matar procesos, borrar
 * una carpeta.
 *
 * `alAbandonar(motivo)` corre antes de salir, para volcar lo que la suite ya
 * juntó. Sin eso, un timeout del humo decía «ABORTADO timeout de 120 s» y
 * tiraba las notas y los problemas: justo el diagnóstico de qué afirmación
 * se quedó esperando (revisión del paquete 0C). Si tira, se avisa y se sale
 * igual: el gancho no puede dejar la suite colgada.
 *
 * La suite tiene que salir sola, con app.exit o process.exit: este timer no
 * la deja terminar «de muerte natural». Con Node pelado (apertura) el timer
 * va desreferenciado y, si el proceso se queda sin nada que esperar sin haber
 * salido —un await de una Promise que nunca se resuelve y no tiene nada vivo
 * detrás—, eso también es abandonar: sin el beforeExit Node saldría con 0 y
 * la suite pasaría sin haber terminado; con el timer referenciado esperaría
 * los 120 s para decir 3. En Electron el proceso lo sostiene la app, no el
 * timer, y beforeExit no llega.
 */
function abandono({ ms = 120000, salir = salidaPorDefecto, alAbandonar = null } = {}) {
  let yendose = false;
  const bail = (motivo, e) => {
    // Una excepción mientras se sale (la limpieza que tira) no vuelve a entrar.
    if (yendose) return;
    yendose = true;
    console.log(`
ABORTADO ${motivo}`, e?.stack || e || '');
    if (alAbandonar) {
      try { alAbandonar(motivo); } catch (err) { console.log('(el volcado de lo juntado también tiró)', err?.stack || err); }
    }
    salir(3);
  };
  process.on('unhandledRejection', (e) => bail('rechazo sin atajar', e));
  process.on('uncaughtException', (e) => bail('excepción sin atajar', e));
  const timer = setTimeout(() => bail(`timeout de ${Math.round(ms / 1000)} s`), ms);
  if (!process.versions.electron) {
    timer.unref?.();
    process.once('beforeExit', () => bail('la suite se quedó sin nada que esperar y no salió (falta un process.exit)'));
  }
  return bail;
}

/**
 * Espera a que `fn()` dé algo truthy y lo devuelve; si no llega en `ms`,
 * tira `Error(mensaje)`. `fn` puede devolver una Promise (una condición del
 * renderer por executeJavaScript): se espera antes de mirarla.
 */
async function hasta(fn, ms, mensaje = 'la condición no se cumplió', { cada = 120 } = {}) {
  const limite = Date.now() + ms;
  let ultimo;
  while (Date.now() < limite) {
    ultimo = await fn();
    if (ultimo) return ultimo;
    await esperar(cada);
  }
  throw new Error(`${mensaje} (en ${ms} ms; lo último: ${JSON.stringify(ultimo)})`);
}

/**
 * Espera a que `fn()` devuelva lo mismo `veces` lecturas seguidas (y algo
 * truthy), y lo devuelve. Para «la cuenta cambió y se quedó quieta»: la
 * cantidad de hojas pintadas, el contador de una búsqueda que todavía está
 * recorriendo páginas. Se compara por JSON, así sirve para objetos chicos.
 */
async function hastaQuieto(fn, ms, mensaje = 'no se quedó quieto', { veces = 2, cada = 120 } = {}) {
  const limite = Date.now() + ms;
  let previo; let iguales = 0; let ultimo;
  while (Date.now() < limite) {
    ultimo = await fn();
    const clave = JSON.stringify(ultimo);
    iguales = ultimo && clave === previo ? iguales + 1 : 1;
    previo = clave;
    if (ultimo && iguales >= veces) return ultimo;
    await esperar(cada);
  }
  throw new Error(`${mensaje} (en ${ms} ms; lo último: ${JSON.stringify(ultimo)})`);
}

/**
 * Código para el renderer: el texto de lo que QUEDA en `sel`, sin lo que se
 * está yendo en un relevo. Da null si el elemento no existe.
 *
 * Se filtran los nodos hijos y no `:scope > :not(.ox-swap-out)`: el
 * contenido suele ser un nodo de texto suelto (lo escribió un textContent, o
 * swap() lo dejó así al entrar), y un selector de elementos no lo ve. Lo que
 * se va siempre queda en un elemento con `.ox-swap-out`: en un relevo, el
 * nodo de texto viejo se muda tal cual adentro del calco
 * (`.ox-swap-out--over`); al vaciar, swap() lo envuelve en un <span> con esa
 * clase. Las dos formas se descartan igual.
 */
const vivo = (sel) => `((el) => el ? [...el.childNodes]
  .filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out')))
  .map((n) => n.textContent).join('').replace(/\\s+/g, ' ').trim() : null)(document.querySelector(${JSON.stringify(sel)}))`;

/** El selector de las filas que se quedan: las que reconcile() está sacando llevan data-state="closing". */
const sinSalir = (sel) => `${sel}:not([data-state="closing"])`;

/**
 * Código para el renderer: muestrea `fn` (código de una función que recibe
 * los ms desde que arrancó) cada `cada` ms durante `durante` ms, y resuelve a
 * la lista de valores. Corre EN la página y no desde Electron: así la serie
 * no lleva la latencia del IPC entre muestra y muestra (recetas §11).
 *
 *   await js(muestrear(`(t) => ({ t, op: +getComputedStyle(calco).opacity })`, 20, 300))
 *
 * `antes` es código que corre justo antes de la primera muestra, en la misma
 * tarea: el gesto que dispara lo que se mide.
 */
const muestrear = (fn, cada = 30, durante = 420, antes = '') => `(async () => {
  const f = (${fn});
  ${antes};
  const out = []; const t0 = performance.now();
  for (;;) {
    const t = Math.round(performance.now() - t0);
    out.push(f(t));
    if (t >= ${durante}) break;
    await new Promise((r) => setTimeout(r, ${cada}));
  }
  return out;
})()`;

/**
 * El mismo muestreo, del lado de Electron, para lo que solo se ve desde acá:
 * una serie de capturePage. `fn(t)` puede ser async; cada muestra espera a
 * la anterior, así que con una foto de por medio el ritmo real lo pone la
 * foto (~15 ms), no `cada`.
 */
async function muestrearAca(fn, cada = 30, durante = 420) {
  const out = []; const t0 = Date.now();
  for (;;) {
    const t = Date.now() - t0;
    out.push(await fn(t));
    if (t >= durante) break;
    if (cada > 0) await esperar(cada);
  }
  return out;
}

/**
 * Código para el renderer: una función `(canvas, alto?) => datos RGBA` que lee
 * una COPIA del canvas, nunca el canvas de la app.
 *
 * Por qué (revisión del paquete 0C): leer dos veces el mismo canvas con
 * getImageData hace que Chromium avise por consola «Canvas2D: Multiple
 * readback operations using getImageData are faster with the
 * willReadFrequently attribute set to true», y vigilarConsola lo cuenta como
 * problema. Pasó con el canvas de tinta de la página 1, leído en 'tinta' y en
 * 'tinta-stylus': el humo se ponía rojo por una lectura del propio test, no
 * por un bug de la app. Y no es solo el aviso: pasado ese umbral Chromium
 * puede mudar ese contexto a CPU, o sea que el test le cambiaba el canvas a
 * la app. Con la copia, el canvas de la app solo pasa por un drawImage (que
 * no cuenta como lectura), y el que se lee es uno descartable creado con
 * willReadFrequently, que se lee una vez y se tira. Así da igual cuántas
 * veces se lea la misma hoja (el preview reusado entre Imprimir y folleto, los
 * canvases del lector).
 */
const PIXELES = `((c, alto = c.height) => {
  const k = document.createElement('canvas');
  k.width = c.width; k.height = alto;
  const x = k.getContext('2d', { willReadFrequently: true });
  x.drawImage(c, 0, 0, c.width, alto, 0, 0, c.width, alto);
  return x.getImageData(0, 0, c.width, alto).data;
})`;

/**
 * Código para el renderer: qué hay en el bitmap de un canvas de hoja.
 * `canvas` es código que da el elemento. Resuelve a `{ lienzo, lados }`, con
 * un lado (o dos, con `mitades`: izquierda y derecha) de
 * `{ medidos, transparentes, oscuros, claros }`, o a `{ motivo }` si no hay
 * canvas o no tiene bitmap. `alto` limita las filas que se leen.
 *
 * Por qué no alcanza con contar oscuros (revisión del paquete 0C): una hoja
 * NEGRA tiene todos los píxeles oscuros, y es justo la familia de bugs
 * «sale negro» (imprimir-01, tinta-01): el canvas de la hoja es
 * `alpha: false` (documento.js), y uno que se borra o no se pinta queda
 * negro. Y una hoja transparente también pasaba: getImageData da R = 0 con
 * A = 0, y cada píxel contaba como letra. Por eso se cuentan solo los opacos
 * y se separa lo oscuro (las letras) de lo claro (el papel); quien juzga es
 * `faltaContenido()`, del lado de Electron.
 */
const leerHoja = (canvas, { alto = 0, mitades = false } = {}) => `((c) => {
  if (!c) return { motivo: 'sin canvas' };
  if (!(c.width > 2)) return { motivo: 'el canvas no tiene bitmap', lienzo: c.width + 'x' + c.height };
  const h = ${Number(alto) || 0} ? Math.min(c.height, ${Number(alto) || 0}) : c.height;
  const d = ${PIXELES}(c, h);
  const lados = Array.from({ length: ${mitades ? 2 : 1} }, () => ({ medidos: 0, transparentes: 0, oscuros: 0, claros: 0 }));
  const mitad = c.width / 2;
  for (let i = 0; i < d.length; i += 4) {
    const lado = lados[${mitades ? '((i / 4) % c.width) < mitad ? 0 : 1' : '0'}];
    if (d[i + 3] <= 200) { lado.transparentes++; continue; }
    lado.medidos++;
    const luz = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (luz < 140) lado.oscuros++;
    else if (luz > 200) lado.claros++;
  }
  return { lienzo: c.width + 'x' + c.height, lados };
})(${canvas})`;

/**
 * Juzga un lado de `leerHoja()`: null si es papel con letras, o por qué no.
 * Papel con letras es: casi todo opaco, más de `minOscuros` oscuros, los
 * oscuros por debajo del 60 % de lo medido y lo claro por encima del 30 %.
 * Una página de texto da del orden de 2 a 10 % de oscuros y el resto papel;
 * una hoja negra, 100 % oscuros; una transparente, nada medido.
 */
function faltaContenido(lado, { minOscuros = 50 } = {}) {
  if (!lado) return 'no se pudo medir';
  const total = lado.medidos + lado.transparentes;
  if (!total) return 'no hay píxeles';
  if (lado.medidos < total * 0.9) return `la hoja es transparente (${lado.transparentes} de ${total} píxeles sin opacidad)`;
  if (lado.oscuros <= minOscuros) return `no tiene letras (${lado.oscuros} píxeles oscuros de ${lado.medidos})`;
  if (lado.oscuros > lado.medidos * 0.6) return `es una mancha oscura, no papel con letras (${lado.oscuros} de ${lado.medidos} oscuros)`;
  if (lado.claros < lado.medidos * 0.3) return `no hay papel claro (${lado.claros} de ${lado.medidos} claros)`;
  return null;
}

/** Brillo medio (0-255) de una NativeImage de capturePage: lo que «ve el ojo» en un fundido (recetas §5). */
function brillo(img) {
  const buf = img.toBitmap();                 // BGRA
  if (!buf.length) return null;
  let s = 0;
  for (let i = 0; i < buf.length; i += 4) s += 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
  return Math.round(s / (buf.length / 4));
}

module.exports = {
  abandono, hasta, hastaQuieto, vivo, sinSalir, muestrear, muestrearAca, brillo, esperar,
  leerHoja, faltaContenido, PIXELES,
  vigilarConsola, esGrave,
};
