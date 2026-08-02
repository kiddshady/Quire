/* El worker de pdf.js, precedido por el parche de compatibilidad.
   El worker corre en su propio realm: el parche del hilo principal no llega
   acá. Este archivo es el que va en GlobalWorkerOptions.workerSrc. */
import './compat.mjs';
import './pdf.worker.mjs';
