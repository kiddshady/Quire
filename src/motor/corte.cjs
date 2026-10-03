'use strict';
/**
 * Cancelar un lote (main-20).
 *
 * Antes no se podía: el lote corría hasta el final, y si Fran mandaba el PDF
 * equivocado (o con el OCR prendido sin querer) la única salida era cerrar
 * Quire. Ahora src/conversion.cjs tiene un AbortController por lote y su
 * `signal` viaja por el pipeline hasta los bucles de pdf.cjs, que lo miran
 * entre archivo y archivo, entre página y página y entre reconocimiento y
 * reconocimiento del OCR.
 *
 * No se corta a mitad de un paso: el render de una página para el OCR o el
 * parseo inicial de pdf.js son sincrónicos y nadie los puede interrumpir
 * desde el mismo hilo. Matarlos en seco es lo que va a dar el utilityProcess
 * (paso 2 de main-03), que todavía no está.
 *
 * El corte viaja como un error con código propio para que cada `catch` del
 * camino lo distinga de una falla de verdad: el OCR caído degrada con gracia,
 * pero un corte no se puede tragar como si fuera un OCR caído.
 */

const CANCELADA = 'Conversión cancelada.';
const CODIGO = 'QUIRE_CANCELADA';

function errorDeCorte() {
  const err = new Error(CANCELADA);
  err.code = CODIGO;
  return err;
}

/** ¿Este error es un corte pedido, y no una falla? */
const esCorte = (err) => Boolean(err) && err.code === CODIGO;

/** Tira el corte si ya lo pidieron. Va en cada vuelta de los bucles largos. */
function revisar(signal) {
  if (signal && signal.aborted) throw errorDeCorte();
}

/**
 * Espera `promesa`, pero se suelta apenas llega el corte. Hace falta para el
 * OCR: un worker de tesseract terminado deja sus trabajos pendientes sin
 * resolver ni rechazar NUNCA (tesseract.js 7, createWorker.js), así que un
 * `await` directo se quedaría colgado para siempre.
 */
function conCorte(promesa, signal) {
  if (!signal) return promesa;
  revisar(signal);
  return new Promise((resolve, reject) => {
    const alCortar = () => reject(errorDeCorte());
    signal.addEventListener('abort', alCortar, { once: true });
    promesa.then(
      (v) => { signal.removeEventListener('abort', alCortar); resolve(v); },
      (e) => { signal.removeEventListener('abort', alCortar); reject(e); },
    );
  });
}

module.exports = { CANCELADA, errorDeCorte, esCorte, revisar, conCorte };
