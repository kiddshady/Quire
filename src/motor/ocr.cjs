'use strict';
/**
 * OCR con tesseract.js: UN scheduler por lote, con 1 a 3 workers (main-22).
 *
 * Antes cada PDF levantaba su propio worker —y volvía a cargar spa+eng desde
 * el caché— y reconocía de a una página: un lote de 10 escaneos pagaba 10
 * arranques del modelo, y un libro escaneado usaba un solo núcleo. Ahora el
 * pipeline crea el pool una vez por lote, se lo pasa a cada PDF en
 * `options.ocrPool` y lo termina al final. Si alguien llama al conversor
 * suelto (el test de OCR, la vista previa), pdf.cjs se arma uno para ese PDF.
 *
 * Los workers se suman de a uno y solo cuando hay páginas esperando turno:
 * cada worker es un modelo entero en memoria, y un lote con una sola página
 * escaneada no tiene por qué pagar tres arranques. El tope es un núcleo menos
 * que los que hay (el render de las páginas también necesita uno), y nunca
 * más de 3.
 *
 * Tres cosas de tesseract.js 7 que este archivo tiene que esquivar:
 *  · Sin `errorHandler`, un trabajo que falla TIRA desde el listener del
 *    worker (createWorker.js, onMessage): es una excepción no atrapada en el
 *    proceso principal. Pasaba con los modelos faltantes —medido con el
 *    código viejo: `ENOENT …spa.traineddata.gz` y el proceso se cae—, y la
 *    promesa de pdf.cjs («si el OCR falla, la conversión sigue sin él») no se
 *    cumplía. Con `errorHandler`, el error llega a la promesa del trabajo.
 *  · Con `errorHandler`, si falla la CARGA del modelo, createWorker no
 *    resuelve ni rechaza nunca (el .catch(() => {}) del final se lo traga).
 *    Por eso la creación corre contra el primer error que avise el handler.
 *  · El caché descomprimido lo escribe cada worker con un fs.writeFile que no
 *    es atómico (worker-script/node/cache.js), y lo lee con un readFile pelado.
 *    Con el caché vacío, un worker que arranca mientras otro lo está
 *    escribiendo se lleva el .traineddata por la mitad (o en cero, si justo
 *    otro lo vuelve a abrir para escribirlo), y tesseract no avisa: imprime
 *    «Failed loading language 'spa'», sigue con eng solo y las páginas salen
 *    sin tildes ni eñes, con ocrError vacío («La sefiora pidié una cancion»).
 *    Lo encontró la revisión de 0B2 en 4 de 8 corridas (6 páginas escaneadas,
 *    caché vacío): pasa en el primer OCR después de instalar y cada vez que
 *    se borra el caché. Por eso los workers extra se levantan recién cuando
 *    el primero está listo: createWorker resuelve después de que
 *    loadLanguage esperó su writeCache, así que para entonces el caché está
 *    entero y los demás solo lo leen.
 *
 * El caché descomprimido de los modelos va por defecto a %TEMP%\quire-tessdata
 * (main-21). Sin cachePath, tesseract lo escribe en `${cachePath || '.'}`, o
 * sea el directorio de trabajo: así quedaron 41 MB de .traineddata en la raíz
 * del repo después de correr el test de OCR. La app igual pasa el suyo
 * (userData, ver rutasOcr en src/conversion.cjs).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_POR_DEFECTO = path.join(os.tmpdir(), 'quire-tessdata');

function topeDeWorkers() {
  const nucleos = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(3, nucleos - 1));
}

/** La carpeta del caché, creada: si no existe, tesseract no avisa y el caché no se escribe. */
function carpetaDeCache(pedida) {
  const dir = pedida || CACHE_POR_DEFECTO;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* sin caché se descomprime cada vez */ }
  return dir;
}

/* Los modelos se buscan ANTES de levantar el worker. Si falta uno, tesseract
   avisa recién adentro del worker, y ese worker queda vivo para siempre: con
   la carga fallada, createWorker no devuelve el objeto que lo terminaría.
   Un hilo así mantiene vivo al proceso (el test de OCR no terminaba nunca).
   Se mira el caché descomprimido y, si no está ahí, el .gz de tessdata. */
function faltaModelo(langs, langPath, cachePath) {
  if (!langPath || /^https?:/i.test(langPath)) return null;
  for (const lang of langs.split('+')) {
    const enCache = fs.existsSync(path.join(cachePath, `${lang}.traineddata`));
    const enTessdata = fs.existsSync(path.join(langPath, `${lang}.traineddata.gz`))
      || fs.existsSync(path.join(langPath, `${lang}.traineddata`));
    if (!enCache && !enTessdata) return `${lang}.traineddata.gz`;
  }
  return null;
}

/**
 * @param {object} options  ocrLangs, tessdataPath, ocrCachePath y, para los
 *                          tests, ocrWorkers (el tope).
 * @returns {{ reconocer(png: Buffer): Promise<string>, terminar(): Promise<void>,
 *             tope: number, readonly workers: number }}
 */
function crearPoolOcr(options = {}) {
  const tope = Math.max(1, Number(options.ocrWorkers) || topeDeWorkers());
  let tesseract = null;    // se pide con la primera página, ver reconocer()
  let scheduler = null;
  let primero = null;      // el primer worker: sin él, addJob tira
  let pedidos = 0;         // workers creados, en camino o esperando al primero
  let listos = 0;
  let enVuelo = 0;
  let terminado = false;
  /* Terminar el pool suelta a todos los que esperan un reconocimiento. Un
     worker terminado deja sus trabajos sin resolver ni rechazar nunca, y el
     scheduler tira la cola sin avisar: sin esto, quien estuviera esperando
     se quedaba colgado para siempre. */
  let soltar = () => {};
  const fin = new Promise((_, reject) => { soltar = reject; });
  fin.catch(() => {});   // nadie tiene por qué estar escuchando cuando termina
  const MENSAJE_FIN = 'El OCR de este lote ya terminó.';

  function levantarWorker() {
    if (terminado) return Promise.resolve();   // un extra que esperaba al primero y llegó tarde
    const langs = options.ocrLangs || 'spa+eng';
    const cachePath = carpetaDeCache(options.ocrCachePath);
    const falta = faltaModelo(langs, options.tessdataPath, cachePath);
    if (falta) return Promise.reject(new Error(`Faltan los modelos de OCR: no está ${falta} en ${options.tessdataPath}.`));
    let avisar = () => {};
    const falla = new Promise((_, reject) => { avisar = reject; });
    const creacion = tesseract.createWorker(langs, 1, {
      langPath: options.tessdataPath,
      cachePath,
      gzip: true,
      errorHandler: (e) => avisar(new Error(String(e))),
    });
    return Promise.race([creacion, falla]).then((w) => {
      if (terminado) { w.terminate(); return; }
      scheduler.addWorker(w);
      listos++;
    });
  }

  async function reconocer(png) {
    if (terminado) throw new Error(MENSAJE_FIN);
    if (!scheduler) {
      /* tesseract.js se pide recién acá, con la primera página a reconocer, y
         por el objeto del módulo (así el test puede contar los createWorker).
         El pipeline arma el pool para todo lote con el OCR prendido, aunque no
         traiga ni un PDF: si el require estuviera en crearPoolOcr, un
         tesseract.js que no carga —el riesgo del build empaquetado— tumbaba
         el lote entero, aunque fuera de un .txt (lo midió la revisión de 0B2:
         «Cannot find module 'tesseract.js'»). Acá cae adentro del OCR de un
         PDF, que lo anota como ocrError y sigue con el texto que tenía. */
      tesseract = require('tesseract.js');
      scheduler = tesseract.createScheduler();
      pedidos++;
      primero = levantarWorker();
    } else if (enVuelo >= pedidos && pedidos < tope) {
      // Hay páginas esperando turno y queda lugar: uno más, pero recién
      // cuando el primero esté listo (el caché, arriba). Se cuenta ya, para
      // no pedir de más mientras espera. Si no arranca, siguen los que ya
      // están; no tumba el lote.
      pedidos++;
      primero.then(levantarWorker).catch(() => {});
    }
    enVuelo++;
    try {
      await Promise.race([primero, fin]);
      const { data } = await Promise.race([scheduler.addJob('recognize', png), fin]);
      return data && data.text ? data.text : '';
    } finally {
      enVuelo--;
    }
  }

  async function terminar() {
    if (terminado) return;
    terminado = true;
    soltar(new Error(MENSAJE_FIN));
    if (scheduler) await scheduler.terminate().catch(() => {});
  }

  return { reconocer, terminar, tope, get workers() { return listos; } };
}

module.exports = { crearPoolOcr, CACHE_POR_DEFECTO };
