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

/**
 * Le saca a un trazo lo que cae dentro del círculo del borrador y devuelve
 * los pedazos que quedan, como listas de puntos: cero si se lo comió entero,
 * uno si lo mordió por una punta, dos si lo partió por el medio.
 *
 * La goma borra un TRAMO, no el trazo: como en el papel. Y corta en el borde
 * exacto del círculo, no en el punto más cercano: los puntos de un trazo
 * vienen espaciados por el muestreo, y cortar ahí dejaría el tajo dentado y
 * corrido de donde apoyaste la goma. Por eso, donde un segmento cruza el
 * borde se inserta el punto del cruce, con la presión interpolada, y el
 * pedazo termina o empieza justo ahí.
 *
 * `alcance` es el radio de la goma más medio ancho del trazo: lo que se
 * busca es que el hueco visible en la tinta mida lo que mide la goma, y el
 * cuerpo del trazo se pasa medio ancho del eje para cada lado.
 *
 * Un pedazo de un solo punto no vale: sería una miga dejada por la goma, no
 * un toque que alguien quiso dar.
 */
export function recortarTrazo(puntos, x, y, alcance) {
  const dentro = (p) => Math.hypot(p[0] - x, p[1] - y) <= alcance;
  const pedazos = [];
  let actual = [];
  const cerrar = () => { if (actual.length >= 2) pedazos.push(actual); actual = []; };

  if (puntos.length === 1) return dentro(puntos[0]) ? [] : [puntos.slice()];

  if (!dentro(puntos[0])) actual.push(puntos[0]);
  for (let i = 1; i < puntos.length; i++) {
    const a = puntos[i - 1];
    const b = puntos[i];
    const aDentro = dentro(a);
    const bDentro = dentro(b);

    if (aDentro && bDentro) continue;

    const [t1, t2] = crucesConCirculo(a, b, x, y, alcance);
    if (!aDentro && !bDentro) {
      // los dos afuera: o el segmento pasa de largo, o atraviesa el círculo
      if (t1 !== null) { actual.push(enSegmento(a, b, t1)); cerrar(); actual.push(enSegmento(a, b, t2)); }
      actual.push(b);
    } else if (!aDentro) {
      // entra: el pedazo termina en el borde
      if (t1 !== null) actual.push(enSegmento(a, b, t1));
      cerrar();
    } else {
      // sale: el pedazo nuevo empieza en el borde
      if (t2 !== null) actual.push(enSegmento(a, b, t2));
      actual.push(b);
    }
  }
  cerrar();
  return pedazos;
}

/** Dónde el segmento a→b cruza el círculo, como [t entrada, t salida] en (0,1); [null, null] si no lo toca. */
function crucesConCirculo(a, b, cx, cy, r) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - cx;
  const fy = a[1] - cy;
  const A = dx * dx + dy * dy;
  if (A === 0) return [null, null];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [null, null];
  const raiz = Math.sqrt(disc);
  const t1 = (-B - raiz) / (2 * A);
  const t2 = (-B + raiz) / (2 * A);
  // El cruce tiene que estar dentro del segmento; en las puntas no cuenta.
  if (t2 <= 0 || t1 >= 1) return [null, null];
  return [Math.max(0, t1), Math.min(1, t2)];
}

/** El punto a la fracción t del segmento a→b, con la presión interpolada. */
function enSegmento(a, b, t) {
  const r = (v) => Math.round(v * 100) / 100;
  const pa = a[2] ?? 0.5;
  const pb = b[2] ?? 0.5;
  return [r(a[0] + (b[0] - a[0]) * t), r(a[1] + (b[1] - a[1]) * t), r(pa + (pb - pa) * t)];
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
