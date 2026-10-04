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

import { pathDeTrazo, trazoTocado, recortarTrazo } from './contorno.js';
import { Toast } from '../overlays.js';

const api = window.onyx;

export const HERRAMIENTAS = {
  pluma: { etiqueta: 'Pluma', icono: 'tinta', ancho: 1.8, color: '#1a1a1a', opacidad: 1, sensible: true },
  fibra: { etiqueta: 'Fibra', icono: 'edit', ancho: 4.5, color: '#c0392b', opacidad: 1, sensible: true },
  resaltador: { etiqueta: 'Resaltador', icono: 'resaltador', ancho: 14, color: '#f1c40f', opacidad: 0.34, sensible: false },
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

/**
 * Cuántos trazos hay en una lista, contados como los HIZO Fran y no como
 * quedaron guardados. La goma parte un trazo en pedazos, y cada pedazo es un
 * trazo en la lista: contando la lista, borrarle el medio a una línea hacía
 * SUBIR el contador de 1 a 2, y el cartel de borrar todo decía «Se van 37
 * trazos» después de haber borrado cosas (tinta-19). Los pedazos llevan el id
 * del trazo del que salieron en `origen`, y se cuentan los orígenes distintos.
 */
export function contarTrazos(lista) {
  const origenes = new Set();
  for (const t of lista) origenes.add(t.origen ?? t.id);
  return origenes.size;
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
    /* El gesto de la goma en curso: la operación del historial a la que se
       le van sumando los recortes hasta levantar el lápiz. Ver borrarEn(). */
    this._borrado = null;
    this.onCambio = null;
    /* Sube con cada cambio. Sirve para saber si el PDF aplanado que hay en
       caché sigue valiendo, sin tener que comparar los trazos uno por uno. */
    this.version = 0;
    /* Cuánto se espera después del último cambio para escribir el archivo.
       Es un campo y no una constante para que los tests no tengan que esperar
       casi un segundo por cada guardado. */
    this.esperaGuardado = 900;
    /* Si el último guardado programado falló. Mientras siga fallando se avisa
       UNA vez, no con cada trazo (tinta-28). */
    this._fallando = false;
  }

  trazos(pagina) { return this.paginas.get(pagina) || []; }

  get vacia() {
    for (const t of this.paginas.values()) if (t.length) return false;
    return true;
  }

  /** Los trazos del documento, como los hizo Fran: ver contarTrazos(). */
  get cuenta() {
    let n = 0;
    for (const t of this.paginas.values()) n += contarTrazos(t);
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

  /**
   * La goma: le saca a cada trazo tocado el tramo que cae bajo el círculo.
   * Devuelve cuántos trazos recortó.
   *
   * Borra un TRAMO y no el trazo entero, como en el papel: lo que queda de
   * cada lado sigue viviendo como trazos nuevos, con las mismas propiedades
   * y en el mismo lugar de la lista —el orden de apilado importa, un
   * resaltador que pase por encima de una pluma se ve distinto que debajo—.
   *
   * ── Un gesto, un deshacer ─────────────────────────────────────────────
   * El editor llama a esto en cada movimiento del lápiz. Si cada llamada
   * fuera una entrada del historial, deshacer una pasada de goma serían
   * treinta Ctrl+Z. Entre empezarBorrado() y terminarBorrado() los recortes
   * se van sumando a UNA operación; un pedazo recortado por un movimiento y
   * vuelto a recortar por el siguiente se reemplaza dentro de ella, así el
   * historial siempre relaciona los trazos originales con lo que quedó al
   * final, sin estados intermedios. */
  borrarEn(pagina, x, y, radio) {
    const lista = this.paginas.get(pagina);
    if (!lista?.length) return 0;

    const cortes = [];
    const nueva = [];
    for (const t of lista) {
      if (!trazoTocado(t, x, y, radio)) { nueva.push(t); continue; }
      // Cada pedazo recuerda de qué trazo salió: es lo que cuenta contarTrazos().
      const piezas = recortarTrazo(t.puntos, x, y, radio + t.ancho / 2)
        .map((puntos) => ({ ...t, id: `s${++this._contador}`, origen: t.origen ?? t.id, puntos }));
      cortes.push({ original: t, piezas });
      nueva.push(...piezas);
    }
    if (!cortes.length) return 0;

    this.paginas.set(pagina, nueva);
    this.#anotarRecorte(pagina, cortes);
    return cortes.length;
  }

  /** Abre el gesto de la goma: hasta terminarBorrado(), todo recorte es una sola operación. */
  empezarBorrado() { this._borrado = { op: null, aviso: false }; }

  /* Cierra el gesto. Si en el medio hubo recortes, recién ahora se avisa: ver
     #anotarRecorte(). */
  terminarBorrado() {
    const avisar = this._borrado?.aviso;
    this._borrado = null;
    if (avisar) this.onCambio?.();
  }

  #anotarRecorte(pagina, cortes) {
    const abierto = this._borrado;
    const op = abierto?.op;
    /* Dentro de un gesto, cada recorte NO avisa: el editor llama a borrarEn()
       por cada punto coalescido, y cada aviso es un emitir('tinta') que pone
       al día la barra y el chrome, varias veces por cuadro (tinta-11). Se
       anota que hubo cambios y se avisa una sola vez, al levantar la goma. El
       guardado se sigue programando igual: eso es solo reponer un timer. */
    const avisar = !abierto;
    if (abierto) abierto.aviso = true;
    // Se suma al gesto solo si su operación sigue siendo la última: si en el
    // medio alguien deshizo, lo que viene es un gesto nuevo.
    if (op && op.pagina === pagina && this.historial.at(-1) === op) {
      for (const c of cortes) {
        const previo = op.cortes.find((k) => k.piezas.some((p) => p.id === c.original.id));
        if (previo) previo.piezas = previo.piezas.flatMap((p) => (p.id === c.original.id ? c.piezas : [p]));
        else op.cortes.push(c);
      }
      this.#marcar(avisar);
      return;
    }
    const nueva = { tipo: 'recortar', pagina, cortes };
    if (abierto) abierto.op = nueva;
    this.#anotar(nueva, avisar);
  }

  limpiarPagina(pagina) {
    const lista = this.paginas.get(pagina) || [];
    if (!lista.length) return 0;
    this.paginas.set(pagina, []);
    this.#anotar({ tipo: 'borrar', pagina, trazos: lista });
    return contarTrazos(lista);
  }

  #anotar(op, avisar = true) {
    this.historial.push(op);
    // Una acción nueva corta la rama de rehacer: es lo que uno espera.
    this.deshechos.length = 0;
    if (this.historial.length > 200) this.historial.shift();
    this.#marcar(avisar);
  }

  /* deshacer() y rehacer() devuelven la operación ({ tipo, pagina, … }), o
     false si no había nada. El historial es del documento entero: con la
     página de la operación, el lector puede redibujar solo ese editor y avisar
     si cayó en una hoja que no está a la vista (tinta-12). Quien solo
     preguntaba «¿hizo algo?» sigue andando: un objeto es verdadero. */
  deshacer() {
    const op = this.historial.pop();
    if (!op) return false;
    this.#aplicarInverso(op);
    this.deshechos.push(op);
    this.#marcar();
    return op;
  }

  rehacer() {
    const op = this.deshechos.pop();
    if (!op) return false;
    this.#aplicar(op);
    this.historial.push(op);
    this.#marcar();
    return op;
  }

  #aplicar(op) {
    const lista = this.paginas.get(op.pagina) || [];
    if (op.tipo === 'agregar') this.paginas.set(op.pagina, [...lista, ...op.trazos]);
    else if (op.tipo === 'borrar') {
      const ids = new Set(op.trazos.map((t) => t.id));
      this.paginas.set(op.pagina, lista.filter((t) => !ids.has(t.id)));
    } else {
      // recortar: cada original se reemplaza, en su lugar, por sus pedazos
      this.paginas.set(op.pagina, lista.flatMap((t) => {
        const c = op.cortes.find((k) => k.original.id === t.id);
        return c ? c.piezas : [t];
      }));
    }
  }

  #aplicarInverso(op) {
    if (op.tipo !== 'recortar') {
      this.#aplicar({ ...op, tipo: op.tipo === 'agregar' ? 'borrar' : 'agregar' });
      return;
    }
    /* Al revés: el original vuelve donde está su primer pedazo y los demás se
       van. Un trazo que la goma se comió entero no tiene pedazo que marque su
       lugar: vuelve al final, igual que lo hace deshacer un borrado de página. */
    const lista = this.paginas.get(op.pagina) || [];
    const vuelta = lista.flatMap((t) => {
      const c = op.cortes.find((k) => k.piezas.some((p) => p.id === t.id));
      if (!c) return [t];
      return c.piezas[0].id === t.id ? [c.original] : [];
    });
    for (const c of op.cortes) if (!c.piezas.length) vuelta.push(c.original);
    this.paginas.set(op.pagina, vuelta);
  }

  #marcar(avisar = true) {
    this.sucia = true;
    this.version++;
    if (avisar) this.onCambio?.();
    this.#programarGuardado();
  }

  /* ── Disco ─────────────────────────────────────────────────────────────── */

  #programarGuardado() {
    clearTimeout(this._guardado);
    // Se guarda al parar de dibujar, no en cada trazo: anotar una página son
    // decenas de trazos y no tiene sentido reescribir el archivo en cada uno.
    this._guardado = setTimeout(() => {
      this.guardar().catch((err) => this.#avisarFallo(err));
    }, this.esperaGuardado);
  }

  /* Antes el error se tragaba entero: con el disco lleno o sin permisos en
     data/, Fran anotaba toda la tarde y al reabrir no había nada (tinta-28).
     El trazo sigue en pantalla y `sucia` sigue en true, así que el próximo
     cambio —o el cierre— lo vuelve a intentar. Por eso se avisa una sola vez
     mientras siga fallando, y no con cada trazo. */
  #avisarFallo(err) {
    if (this._fallando) return;
    this._fallando = true;
    console.error('[tinta] no se pudo guardar', this.doc?.nombre, err?.message);
    Toast.error('No se pudo guardar la tinta',
      'Lo anotado sigue en pantalla, pero todavía no está en el disco. Se vuelve a intentar con el próximo trazo.');
  }

  async guardar() {
    if (!this.sucia) return;
    /* La foto de los trazos se saca acá, antes del await. Si mientras se
       escribe entra otro trazo, la versión sube y `sucia` tiene que quedar en
       true: si no, el guardado que ese trazo programó encontraba !sucia y no
       escribía nada, y el último trazo antes de cerrar no llegaba nunca al
       disco (tinta-03). */
    const version = this.version;
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
    if (this.version === version) this.sucia = false;
    // Escribió: si venía fallando, el próximo fallo vuelve a avisar.
    this._fallando = false;
    this.onCambio?.();
  }

  static async cargar(doc) {
    const capa = new CapaDeTinta(doc);
    const guardado = await api.col('tinta').get(capa.id).catch(() => null);
    if (guardado?.paginas) {
      for (const [n, lista] of Object.entries(guardado.paginas)) {
        capa.paginas.set(Number(n), lista);
        for (const t of lista) {
          /* Seguir la numeración para que un id nuevo no pise uno guardado. El
             origen de un pedazo también cuenta: si su trazo original ya no
             está, un id nuevo igual a ese origen sumaría el trazo nuevo a los
             pedazos viejos en contarTrazos(). */
          for (const id of [t.id, t.origen]) {
            const n2 = parseInt(String(id ?? '').slice(1), 10);
            if (Number.isFinite(n2) && n2 > capa._contador) capa._contador = n2;
          }
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
