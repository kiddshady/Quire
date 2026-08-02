/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — la capa de tinta
   Los trazos que Fran hace con la tablet encima del PDF.

   ── El PDF original NUNCA se toca ──────────────────────────────────────────
   Los trazos se guardan aparte, en un archivo JSON al lado de los datos de la
   app, referidos al documento por un hash de su ruta y tamaño. Se pueden
   seguir editando, deshacer, y borrar sin que el archivo original haya
   cambiado un byte. Recién al imprimir o exportar la tinta se aplana ENCIMA
   —sobre una copia en memoria— y eso es lo que sale. Nada de convertir el
   documento a otro formato ni de partirlo en pedazos.

   ── Las coordenadas ────────────────────────────────────────────────────────
   Todo se guarda en coordenadas de página PDF (origen abajo a la izquierda, en
   puntos). No en píxeles de pantalla: un trazo hecho al 150% de zoom tiene que
   caer en el mismo lugar del papel que uno hecho al 60%. La conversión la hace
   el viewport de pdf.js, que además ya tiene en cuenta el /Rotate de la página
   y la rotación que el lector le haya aplicado.
   ═══════════════════════════════════════════════════════════════════════════ */

import { pathDeTrazo, trazoTocado } from './contorno.js';

const api = window.onyx;

export const HERRAMIENTAS = {
  pluma: { etiqueta: 'Pluma', icono: 'tinta', ancho: 1.8, color: '#1a1a1a', opacidad: 1, sensible: true },
  fibra: { etiqueta: 'Fibra', icono: 'edit', ancho: 4.5, color: '#c0392b', opacidad: 1, sensible: true },
  resaltador: { etiqueta: 'Resaltador', icono: 'marcador', ancho: 14, color: '#f1c40f', opacidad: 0.34, sensible: false },
  borrador: { etiqueta: 'Borrador', icono: 'borrador', ancho: 16, color: null, opacidad: 1, sensible: false },
};

/* Tinta, no interfaz: acá el color lo elige el usuario y no compite con el
   acento de la app. El primero de cada fila es el que viene por defecto. */
export const COLORES = ['#1a1a1a', '#c0392b', '#1f6fb2', '#1e8449', '#8e44ad', '#f1c40f'];

/** Id estable del documento: la ruta y el tamaño, en un hash corto. */
export function idDocumento(doc) {
  const semilla = `${doc.ruta || doc.nombre}|${doc.tamano ?? 0}`;
  // FNV-1a: corto, sin dependencias, y suficiente para nombrar un archivo.
  let h = 0x811c9dc5;
  for (let i = 0; i < semilla.length; i++) {
    h ^= semilla.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t-${h.toString(16).padStart(8, '0')}`;
}

export class CapaDeTinta {
  constructor(doc) {
    this.doc = doc;
    this.id = idDocumento(doc);
    /** @type {Map<number, Array>} página → trazos */
    this.paginas = new Map();
    this.historial = [];
    this.deshechos = [];
    this.sucia = false;
    this._guardado = null;
    this._contador = 0;
    this.onCambio = null;
    /* Sube con cada cambio. Sirve para saber si el PDF aplanado que hay en
       caché sigue valiendo, sin tener que comparar los trazos uno por uno. */
    this.version = 0;
  }

  trazos(pagina) { return this.paginas.get(pagina) || []; }

  get vacia() {
    for (const t of this.paginas.values()) if (t.length) return false;
    return true;
  }

  get cuenta() {
    let n = 0;
    for (const t of this.paginas.values()) n += t.length;
    return n;
  }

  paginasConTinta() {
    return [...this.paginas.entries()].filter(([, t]) => t.length).map(([n]) => n).sort((a, b) => a - b);
  }

  /* ── Editar ────────────────────────────────────────────────────────────── */

  agregar(pagina, trazo) {
    const t = { id: `s${++this._contador}`, ...trazo };
    if (!this.paginas.has(pagina)) this.paginas.set(pagina, []);
    this.paginas.get(pagina).push(t);
    this.#anotar({ tipo: 'agregar', pagina, trazos: [t] });
    return t;
  }

  /** Borra los trazos que el borrador tocó. Devuelve cuántos se fueron. */
  borrarEn(pagina, x, y, radio) {
    const lista = this.paginas.get(pagina);
    if (!lista?.length) return 0;

    const tocados = lista.filter((t) => trazoTocado(t, x, y, radio));
    if (!tocados.length) return 0;

    const ids = new Set(tocados.map((t) => t.id));
    this.paginas.set(pagina, lista.filter((t) => !ids.has(t.id)));
    this.#anotar({ tipo: 'borrar', pagina, trazos: tocados });
    return tocados.length;
  }

  limpiarPagina(pagina) {
    const lista = this.paginas.get(pagina) || [];
    if (!lista.length) return 0;
    this.paginas.set(pagina, []);
    this.#anotar({ tipo: 'borrar', pagina, trazos: lista });
    return lista.length;
  }

  #anotar(op) {
    this.historial.push(op);
    // Una acción nueva corta la rama de rehacer: es lo que uno espera.
    this.deshechos.length = 0;
    if (this.historial.length > 200) this.historial.shift();
    this.#marcar();
  }

  deshacer() {
    const op = this.historial.pop();
    if (!op) return false;
    this.#aplicarInverso(op);
    this.deshechos.push(op);
    this.#marcar();
    return true;
  }

  rehacer() {
    const op = this.deshechos.pop();
    if (!op) return false;
    this.#aplicar(op);
    this.historial.push(op);
    this.#marcar();
    return true;
  }

  #aplicar(op) {
    const lista = this.paginas.get(op.pagina) || [];
    if (op.tipo === 'agregar') this.paginas.set(op.pagina, [...lista, ...op.trazos]);
    else {
      const ids = new Set(op.trazos.map((t) => t.id));
      this.paginas.set(op.pagina, lista.filter((t) => !ids.has(t.id)));
    }
  }

  #aplicarInverso(op) {
    this.#aplicar({ ...op, tipo: op.tipo === 'agregar' ? 'borrar' : 'agregar' });
  }

  #marcar() {
    this.sucia = true;
    this.version++;
    this.onCambio?.();
    this.#programarGuardado();
  }

  /* ── Disco ─────────────────────────────────────────────────────────────── */

  #programarGuardado() {
    clearTimeout(this._guardado);
    // Se guarda al parar de dibujar, no en cada trazo: anotar una página son
    // decenas de trazos y no tiene sentido reescribir el archivo en cada uno.
    this._guardado = setTimeout(() => this.guardar().catch(() => {}), 900);
  }

  async guardar() {
    if (!this.sucia) return;
    const paginas = {};
    for (const [n, lista] of this.paginas) if (lista.length) paginas[n] = lista;

    await api.col('tinta').save({
      id: this.id,
      ruta: this.doc.ruta,
      nombre: this.doc.nombre,
      tamano: this.doc.tamano ?? null,
      actualizado: Date.now(),
      paginas,
    });
    this.sucia = false;
    this.onCambio?.();
  }

  static async cargar(doc) {
    const capa = new CapaDeTinta(doc);
    const guardado = await api.col('tinta').get(capa.id).catch(() => null);
    if (guardado?.paginas) {
      for (const [n, lista] of Object.entries(guardado.paginas)) {
        capa.paginas.set(Number(n), lista);
        for (const t of lista) {
          // Seguir la numeración para que un id nuevo no pise uno guardado.
          const n2 = parseInt(String(t.id).slice(1), 10);
          if (Number.isFinite(n2) && n2 > capa._contador) capa._contador = n2;
        }
      }
    }
    capa.sucia = false;
    return capa;
  }

  async borrarTodo() {
    this.paginas.clear();
    this.historial.length = 0;
    this.deshechos.length = 0;
    this.sucia = false;
    await api.col('tinta').remove(this.id).catch(() => {});
    this.onCambio?.();
  }
}

/* ── Dibujo ──────────────────────────────────────────────────────────────── */

/**
 * Pinta los trazos de una página en un canvas.
 *
 * La transformación sale del viewport de pdf.js, así que el mismo path en
 * coordenadas de página cae exactamente donde va con cualquier zoom y con la
 * página rotada. Y es el MISMO path que después se escribe en el PDF.
 */
export function dibujarTrazos(ctx, trazos, viewport, { dpr = 1, resaltar = null } = {}) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
  ctx.transform(...viewport.transform);

  /* Los resaltadores van primero y todos juntos: si se intercalaran con la
     tinta opaca, un trazo de pluma anterior quedaría lavado por el amarillo. */
  const orden = [
    ...trazos.filter((t) => t.herramienta === 'resaltador'),
    ...trazos.filter((t) => t.herramienta !== 'resaltador'),
  ];

  for (const t of orden) {
    const d = pathDeTrazo(t);
    if (!d) continue;
    ctx.globalAlpha = t.opacidad ?? 1;
    ctx.fillStyle = t.color || '#000';
    ctx.fill(new Path2D(d));

    if (resaltar && resaltar.has(t.id)) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = 1 / Math.abs(viewport.scale || 1);
      ctx.stroke(new Path2D(d));
    }
  }

  ctx.restore();
}
