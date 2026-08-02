/* pdf.js 5.x usa propuestas de TC39 que el V8 de Electron 40 (Chromium 144)
   todavía no trae. Sin esto:

   · Map/WeakMap.prototype.getOrInsertComputed (propuesta "upsert") →
     getDocument() muere con "getOrInsertComputed is not a function".
   · Math.sumPrecise → cada render escupe "Math.sumPrecise is not a function".
     Son 16 usos en el worker, uno por página que se pinta.

   Se importa en DOS realms distintos: el hilo principal (antes que pdf.mjs) y
   el worker (worker-shim.mjs). Un parche puesto en uno NO se ve en el otro.

   Cuando Electron suba a un Chromium que ya los traiga, esto se vuelve inerte
   solo — pero no lo saques sin verificar los dos realms. */

for (const C of [Map, WeakMap]) {
  if (typeof C.prototype.getOrInsert !== 'function') {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      writable: true,
      configurable: true,
      value(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
  if (typeof C.prototype.getOrInsertComputed !== 'function') {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      writable: true,
      configurable: true,
      value(key, callback) {
        if (!this.has(key)) this.set(key, callback(key));
        return this.get(key);
      },
    });
  }
}

/* Math.sumPrecise(iterable): suma sin acumular error de redondeo.
   El estándar pide el resultado EXACTO (algoritmo de Shewchuk). Acá va
   Kahan-Babuška-Neumaier, que lleva un término de compensación con los dígitos
   que la suma va perdiendo. No es exacto en el sentido del estándar, pero el
   error queda en el último bit — y pdf.js la usa para sumar longitudes de
   texto y coordenadas, donde eso es indistinguible de exacto. */
if (typeof Math.sumPrecise !== 'function') {
  Object.defineProperty(Math, 'sumPrecise', {
    writable: true,
    configurable: true,
    value(values) {
      let suma = 0;
      let compensacion = 0;
      let vacio = true;

      for (const valor of values) {
        vacio = false;
        const n = Number(valor);
        const parcial = suma + n;
        // El sumando más chico es el que pierde dígitos: se guarda cuáles.
        compensacion += Math.abs(suma) >= Math.abs(n)
          ? (suma - parcial) + n
          : (n - parcial) + suma;
        suma = parcial;
      }

      if (vacio) return -0;                    // el estándar pide -0, no 0
      // Con un Infinity o un NaN en la lista, la compensación sale NaN
      // (Infinity - Infinity): ahí el resultado es la suma cruda.
      return Number.isFinite(suma) ? suma + compensacion : suma;
    },
  });
}
