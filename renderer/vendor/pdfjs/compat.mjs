/* pdf.js 5.x llama Map/WeakMap.prototype.getOrInsertComputed, de la propuesta
   "upsert" de TC39. El V8 de Electron 40 todavía no la trae, así que sin esto
   getDocument() muere con "getOrInsertComputed is not a function".

   Se importa en DOS realms distintos: el hilo principal (antes que pdf.mjs) y
   el worker (worker-shim.mjs). Un parche puesto en uno NO se ve en el otro.

   Cuando Electron suba a un Chromium que ya lo traiga, esto se vuelve inerte
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
