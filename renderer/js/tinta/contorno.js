/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el contorno de un trazo
   Convierte una lista de puntos con presión en el POLÍGONO que ocupa la tinta.

   Por qué un polígono relleno y no una línea con grosor: una línea de canvas
   tiene un solo `lineWidth` para todo el trazo, así que la presión se pierde.
   Calculando el contorno se obtiene una forma que se ensancha y se afina, y
   además —lo importante acá— es la MISMA figura que se puede escribir en el
   PDF como path vectorial. El trazo que ves en pantalla y el que sale por la
   impresora salen del mismo string.

   Todo en coordenadas de página PDF: origen abajo a la izquierda, en puntos.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Cuántos segmentos tiene media tapa redonda. Con 6 ya no se ve el facetado a
   ninguna escala razonable de impresión, y mantiene el path corto. */
const SEG_TAPA = 6;

/** Radio de la tinta en un punto, según su presión. */
function radio(p, ancho, minimo) {
  return Math.max(minimo, (ancho / 2) * (0.15 + 0.85 * Math.max(0, Math.min(1, p))));
}

/**
 * El polígono que ocupa un trazo.
 *
 * @param {Array<[number,number,number]>} puntos  [x, y, presión]
 * @param {{ancho:number, sensible?:boolean, minRadio?:number}} opciones
 * @returns {Array<[number,number]>} vértices en orden, listos para cerrar
 */
export function contornoDeTrazo(puntos, { ancho = 2, sensible = true, minRadio = 0.12 } = {}) {
  // Puntos prácticamente repetidos ensucian las normales y engordan el path.
  const p = [];
  for (const q of puntos) {
    const ult = p[p.length - 1];
    if (ult && Math.hypot(q[0] - ult[0], q[1] - ult[1]) < 0.08) {
      // Se queda con la presión más alta: al frenar la mano llegan muchos
      // puntos casi iguales y quedarse con el último apaga el trazo.
      if (q[2] > ult[2]) ult[2] = q[2];
      continue;
    }
    p.push([q[0], q[1], q[2] ?? 1]);
  }

  const r = (i) => (sensible ? radio(p[i][2], ancho, minRadio) : Math.max(minRadio, ancho / 2));

  // Un solo punto: un toque de la punta. Es un círculo, no un trazo.
  if (p.length === 1) return circulo(p[0][0], p[0][1], r(0));
  if (p.length === 0) return [];

  /* La normal en cada punto sale de la tangente entre sus vecinos: usar el
     segmento anterior deja un quiebre visible en cada vértice de las curvas. */
  const normales = p.map((_, i) => {
    const a = p[Math.max(0, i - 1)];
    const b = p[Math.min(p.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const largo = Math.hypot(tx, ty) || 1;
    tx /= largo; ty /= largo;
    return [-ty, tx];
  });

  const izquierda = [];
  const derecha = [];
  for (let i = 0; i < p.length; i++) {
    const [nx, ny] = normales[i];
    const ri = r(i);
    izquierda.push([p[i][0] + nx * ri, p[i][1] + ny * ri]);
    derecha.push([p[i][0] - nx * ri, p[i][1] - ny * ri]);
  }

  const ultimo = p.length - 1;
  return [
    ...izquierda,
    ...tapa(p[ultimo], normales[ultimo], r(ultimo), false),
    ...derecha.reverse(),
    ...tapa(p[0], normales[0], r(0), true),
  ];
}

/** Media vuelta alrededor de un extremo, para que el trazo no termine en filo. */
function tapa(punto, normal, r, esInicio) {
  const base = Math.atan2(normal[1], normal[0]);
  const desde = esInicio ? base + Math.PI : base;
  const pts = [];
  for (let i = 1; i < SEG_TAPA; i++) {
    const a = desde - (Math.PI * i) / SEG_TAPA;
    pts.push([punto[0] + Math.cos(a) * r, punto[1] + Math.sin(a) * r]);
  }
  return pts;
}

function circulo(cx, cy, r) {
  const pts = [];
  const n = SEG_TAPA * 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** El polígono como path SVG. Sirve para Path2D (canvas) y para pdf-lib. */
export function pathDeContorno(vertices) {
  if (!vertices.length) return '';
  const n = (v) => (Math.round(v * 100) / 100).toString();
  let d = `M${n(vertices[0][0])} ${n(vertices[0][1])}`;
  for (let i = 1; i < vertices.length; i++) d += `L${n(vertices[i][0])} ${n(vertices[i][1])}`;
  return d + 'Z';
}

/** Atajo: de los puntos de un trazo al path listo para dibujar. */
export function pathDeTrazo(trazo) {
  return pathDeContorno(contornoDeTrazo(trazo.puntos, {
    ancho: trazo.ancho,
    sensible: trazo.herramienta !== 'resaltador',
  }));
}

/** La caja que ocupa un trazo, para saber si el borrador lo tocó. */
export function cajaDeTrazo(trazo) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const margen = trazo.ancho / 2 + 1;
  for (const [x, y] of trazo.puntos) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - margen, y0: y0 - margen, x1: x1 + margen, y1: y1 + margen };
}

/**
 * ¿El borrador tocó este trazo?
 *
 * Se mide contra los SEGMENTOS y no contra los puntos: en un trazo rápido los
 * puntos quedan lejos entre sí, y con solo mirar vértices el borrador pasa por
 * el medio de una línea sin borrarla.
 */
export function trazoTocado(trazo, x, y, radio) {
  const caja = cajaDeTrazo(trazo);
  if (x < caja.x0 - radio || x > caja.x1 + radio || y < caja.y0 - radio || y > caja.y1 + radio) return false;

  const alcance = radio + trazo.ancho / 2;
  const pts = trazo.puntos;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= alcance;

  for (let i = 1; i < pts.length; i++) {
    if (distanciaASegmento(x, y, pts[i - 1], pts[i]) <= alcance) return true;
  }
  return false;
}

function distanciaASegmento(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const largo2 = dx * dx + dy * dy;
  if (largo2 === 0) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / largo2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
