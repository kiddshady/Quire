/* ═══════════════════════════════════════════════════════════════════════════
   Copiado de Scrawl (S:\tools\Scrawl\renderer\js\engine\stroke.js) SIN cambios.

   Se copia y no se enlaza, igual que con Onyx: las dos apps quedan
   independientes. Si arreglás algo acá que también aplique allá, portalo a
   mano — es un archivo.

   Vino tal cual porque no sabe nada del motor de Scrawl: solo lee el stylus y
   construye el camino. Todo lo que Quire agrega encima (contorno con presión,
   coordenadas de página PDF, aplanado) vive en los archivos de al lado.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Entrada del stylus y construccion del camino.
 *
 * ── Por que Pointer Events y no mouse events ─────────────────────────────
 * Pointer Events es lo unico que entrega presion, inclinacion y tipo de
 * dispositivo. En Windows la tablet llega por Windows Ink y Chromium expone
 * e.pressure en 0..1 real.
 *
 * ── getCoalescedEvents: la diferencia entre curvas y poligonos ────────────
 * Una tablet muestrea a 200-300 Hz, pero el navegador entrega pointermove una
 * vez por frame (60 Hz). Los 3-5 puntos intermedios de cada frame no se
 * pierden: quedan "coalescidos" dentro del evento y solo se ven llamando a
 * getCoalescedEvents(). Sin eso, un trazo rapido queda con esquinas visibles
 * porque estas dibujando 1 de cada 4 puntos que la tablet reporto. Es el error
 * mas comun al hacer esto y la razon por la que muchos canvas web se sienten
 * "baratos" con tablet. */

export class StrokeInput {
  /* handlers: { begin, move, end, hover, leave, wheel }
   * Los puntos salen en px CSS relativos al elemento — la traduccion a
   * coordenadas de documento la hace quien conoce el viewport. */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.pointerId = null;
    // se usa para distinguir presion real de un valor fijo: si a lo largo del
    // trazo nunca cambia, la tablet no esta reportando presion de verdad
    this.pressureSeen = new Set();

    el.addEventListener('pointerdown', this.#down, { passive: false });
    el.addEventListener('pointermove', this.#move, { passive: false });
    el.addEventListener('pointerup', this.#up);
    el.addEventListener('pointercancel', this.#up);
    el.addEventListener('pointerleave', this.#leave);
    el.addEventListener('wheel', this.#wheel, { passive: false });
    // sin esto, el menu del navegador aparece al usar el boton del lapiz
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  #pt(e) {
    const r = this.el.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      p: readPressure(e),
      pen: e.pointerType === 'pen',
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      type: e.pointerType,
    };
  }

  #down = (e) => {
    if (this.pointerId !== null) return;   // un solo puntero por trazo
    e.preventDefault();
    this.pointerId = e.pointerId;
    /* Capturar el puntero: si no, al salirte del canvas mientras dibujas el
     * trazo se corta en el borde en vez de seguir. */
    this.el.setPointerCapture(e.pointerId);
    this.pressureSeen.clear();
    this.pressureSeen.add(Math.round(readPressure(e) * 100));
    this.h.begin?.(this.#pt(e), modifiers(e));
  };

  #move = (e) => {
    if (this.pointerId === null) {
      this.h.hover?.(this.#pt(e), modifiers(e));
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();

    /* Los puntos intermedios del frame. Chromium devuelve al menos el evento
     * actual, pero el fallback esta por si el motor no implementa la API. */
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const list = coalesced.length ? coalesced : [e];
    const mods = modifiers(e);
    for (const ev of list) {
      const pt = this.#pt(ev);
      this.pressureSeen.add(Math.round(pt.p * 100));
      this.h.move?.(pt, mods);
    }
  };

  #up = (e) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    this.h.end?.(modifiers(e));
  };

  #leave = () => {
    if (this.pointerId === null) this.h.leave?.();
  };

  #wheel = (e) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.h.wheel?.(e, e.clientX - r.left, e.clientY - r.top);
  };

  /* Si en todo el trazo se vio un solo valor de presion, el dispositivo la esta
   * reportando fija (mouse, o tablet con Windows Ink apagado). */
  get pressureIsReal() { return this.pressureSeen.size > 3; }
}

/* Presion normalizada.
 *
 * Cada dispositivo miente distinto:
 *   - mouse: pressure vale 0.5 fijo con el boton apretado, 0 sin apretar. No es
 *     presion, es un placeholder — se fuerza a 1 para que el pincel de su ancho
 *     completo en vez de la mitad.
 *   - pen: 0..1 real, pero el primer y el ultimo evento del trazo suelen venir
 *     en 0 exacto (el momento en que la punta toca y despega). Un 0 crudo daria
 *     radio cero y el trazo arrancaria con un hueco, asi que se le pone un piso. */
function readPressure(e) {
  if (e.pointerType === 'pen') {
    const p = e.pressure;
    if (!Number.isFinite(p) || p <= 0) return 0.02;
    return Math.min(1, p);
  }
  if (e.pointerType === 'touch') return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
  return 1;
}

function modifiers(e) {
  return {
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    button: e.button,
    buttons: e.buttons,
    /* La goma del stylus (el otro extremo del lapiz) llega como el bit 32 de
     * buttons, o directamente como pointerType 'eraser' en algunos drivers.
     * Darla vuelta y borrar es un gesto que uno espera que funcione. */
    eraser: e.pointerType === 'eraser' || (e.buttons & 32) !== 0,
    // boton lateral del lapiz: se usa para desplazar sin cambiar de herramienta
    barrel: (e.buttons & 2) !== 0,
    middle: (e.buttons & 4) !== 0,
  };
}

// ── construccion del camino ─────────────────────────────────────────────────

/* Toma los puntos crudos y emite segmentos listos para rasterizar.
 *
 * Dos etapas:
 *
 *   1. Suavizado exponencial. Toda tablet tiene jitter, sobre todo al mover
 *      despacio: la punta reporta micro-oscilaciones que se ven como un trazo
 *      tembloroso. El filtro persigue al punto crudo en vez de saltar a el.
 *
 *   2. Interpolacion cuadratica por midpoints. Unir los puntos con rectas deja
 *      un poligono; la tecnica clasica es curvar cada tramo usando el punto
 *      reportado como control y los puntos medios de sus vecinos como extremos.
 *      El resultado es C1-continuo: no hay quiebre de tangente en las uniones. */
export class StrokePath {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.reset();
  }

  reset() {
    this.pts = [];        // puntos ya suavizados
    this.smooth = null;   // estado del filtro
    this.cursor = null;   // ultimo punto emitido
    this.factor = 0;
  }

  /* smoothing 0 = sigue el crudo exacto; 0.9 = muy perezoso. */
  begin(pt, smoothing = 0.4) {
    this.reset();
    this.factor = Math.max(0, Math.min(0.92, smoothing));
    this.smooth = { x: pt.x, y: pt.y, p: pt.p };
    this.pts.push({ ...this.smooth });
    this.cursor = { ...this.smooth };
    return this.cursor;
  }

  push(pt) {
    const f = this.factor;
    const s = this.smooth;
    s.x += (pt.x - s.x) * (1 - f);
    s.y += (pt.y - s.y) * (1 - f);
    // la presion se suaviza siempre un poco: su ruido se ve como pulsos de ancho
    s.p += (pt.p - s.p) * 0.45;

    const next = { x: s.x, y: s.y, p: s.p };
    // descartar puntos practicamente repetidos: no aportan y ensucian los
    // controles de la curva
    const prev = this.pts[this.pts.length - 1];
    if (Math.hypot(next.x - prev.x, next.y - prev.y) < 0.05) return;

    this.pts.push(next);
    this.#emit();
  }

  #emit() {
    const n = this.pts.length;
    if (n < 2) return;

    if (n === 2) {
      // primer tramo: del punto inicial al primer midpoint
      this.#curve(this.pts[0], this.pts[0], mid(this.pts[0], this.pts[1]));
      return;
    }

    const p0 = this.pts[n - 3];
    const p1 = this.pts[n - 2];
    const p2 = this.pts[n - 1];
    this.#curve(mid(p0, p1), p1, mid(p1, p2));
  }

  /* Muestrea una Bezier cuadratica y emite los segmentos rectos entre muestras.
   * El paso de 2px es holgado: el Painter reparte sus propias estampas dentro de
   * cada segmento, asi que esto solo tiene que ser lo bastante fino para que la
   * curva no se vea facetada. */
  #curve(from, ctrl, to) {
    const approx = Math.hypot(ctrl.x - from.x, ctrl.y - from.y)
                 + Math.hypot(to.x - ctrl.x, to.y - ctrl.y);
    const steps = Math.max(1, Math.ceil(approx / 2));
    let prev = this.cursor || from;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const pt = {
        x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
        p: from.p + (to.p - from.p) * t,
      };
      this.onSegment(prev, pt);
      prev = pt;
    }
    this.cursor = prev;
  }

  /* Cierra el trazo llevandolo hasta el ultimo punto real: si no, el trazo
   * termina en el ultimo midpoint y queda medio segmento corto de donde el
   * usuario efectivamente levanto la punta. */
  end() {
    const n = this.pts.length;
    if (n >= 2) {
      const last = this.pts[n - 1];
      const from = this.cursor || this.pts[n - 2];
      this.#curve(from, mid(this.pts[n - 2], last), last);
    }
    const tail = this.cursor;
    this.reset();
    return tail;
  }
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 };
}
