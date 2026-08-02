/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el plan de imposición
   Geometría pura: entra un plan y las medidas de las páginas, sale la lista de
   hojas con qué va dibujado dónde. Acá no se toca ningún PDF — eso es motor.js.

   Está separado a propósito. La imposición es todo aritmética de rectángulos y
   es donde de verdad se puede equivocar uno (un folleto con el orden invertido
   sale mal recién cuando lo doblás). Sin pdf-lib de por medio se puede testear
   con Node pelado y afirmar el resultado número por número.

   Convenciones, las mismas que el PDF:
   · Todo en PUNTOS (1/72"). Los milímetros se convierten en el borde.
   · Origen abajo a la izquierda, la Y crece hacia arriba.
   ═══════════════════════════════════════════════════════════════════════════ */

export const MM = 72 / 25.4;
export const mm = (v) => v * MM;
export const aMM = (pt) => pt / MM;

/* ── El plan ─────────────────────────────────────────────────────────────── */

export const PLAN_DEFECTO = {
  /* Papel de destino, en mm. */
  papel: { nombre: 'A4', ancho: 210, alto: 297 },
  /* Área que la impresora realmente alcanza, en mm, relativa al papel. null =
     no se sabe (se usa el papel entero). */
  imprimible: null,
  respetarNoImprimible: true,

  /* Qué páginas del original entran, como texto tipo "1-7, 12". */
  rango: 'todo',
  subconjunto: 'todas',            // 'todas' | 'impares' | 'pares'
  invertir: false,

  modo: 'simple',                  // 'simple' | 'nup' | 'poster' | 'folleto'
  orientacion: 'auto',             // 'auto' | 'vertical' | 'horizontal'

  escala: { tipo: 'ajustar', valor: 100 },  // 'ajustar' | 'reducir' | 'real' | 'custom'

  nup: { filas: 2, columnas: 2, orden: 'horizontal', borde: false, separacion: 0 },
  poster: { escala: 100, solape: 12, marcas: true },
  folleto: { encuadernacion: 'izquierda', porCuadernillo: 0 },  // 0 = un solo cuadernillo

  margen: 0,                       // mm extra de aire, más allá del no imprimible
  duplex: 'simplex',               // 'simplex' | 'largo' | 'corto'
  copias: 1,
  intercalar: true,
};

export function planCon(parche = {}) {
  return {
    ...PLAN_DEFECTO,
    ...parche,
    papel: { ...PLAN_DEFECTO.papel, ...(parche.papel || {}) },
    escala: { ...PLAN_DEFECTO.escala, ...(parche.escala || {}) },
    nup: { ...PLAN_DEFECTO.nup, ...(parche.nup || {}) },
    poster: { ...PLAN_DEFECTO.poster, ...(parche.poster || {}) },
    folleto: { ...PLAN_DEFECTO.folleto, ...(parche.folleto || {}) },
  };
}

/* ── Rango de páginas ────────────────────────────────────────────────────── */

/**
 * "1-3, 8, 12-10" sobre 20 páginas → [1,2,3,8,12,11,10]
 * Un rango al revés se recorre al revés: es una forma cómoda de invertir un
 * tramo sin tener que enumerarlo.
 */
export function resolverRango(texto, total) {
  if (!texto || texto === 'todo') return Array.from({ length: total }, (_, i) => i + 1);

  const salida = [];
  for (const parte of String(texto).split(',')) {
    const t = parte.trim();
    if (!t) continue;

    const m = t.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) {
      let [, a, b] = m;
      a = Math.min(total, Math.max(1, +a));
      b = Math.min(total, Math.max(1, +b));
      const paso = a <= b ? 1 : -1;
      for (let n = a; paso > 0 ? n <= b : n >= b; n += paso) salida.push(n);
      continue;
    }

    const abierto = t.match(/^(\d+)\s*[-–]$/);   // "5-" = de la 5 al final
    if (abierto) {
      for (let n = Math.max(1, +abierto[1]); n <= total; n++) salida.push(n);
      continue;
    }

    const n = parseInt(t, 10);
    if (Number.isFinite(n) && n >= 1 && n <= total) salida.push(n);
  }
  return salida;
}

/** Aplica subconjunto (pares/impares) e inversión. */
export function paginasDelPlan(plan, total) {
  let p = resolverRango(plan.rango, total);
  if (plan.subconjunto === 'impares') p = p.filter((n) => n % 2 === 1);
  if (plan.subconjunto === 'pares') p = p.filter((n) => n % 2 === 0);
  if (plan.invertir) p = [...p].reverse();
  return p;
}

/* ── Papel y área útil ───────────────────────────────────────────────────── */

/** El papel en puntos, ya girado según la orientación pedida. */
export function papelDelPlan(plan, geometrias = []) {
  let ancho = mm(plan.papel.ancho);
  let alto = mm(plan.papel.alto);

  let girar = plan.orientacion === 'horizontal';

  if (plan.orientacion === 'auto') {
    /* Automática = seguir al contenido. En folleto no se pregunta: dos páginas
       lado a lado siempre quieren el papel apaisado. */
    if (plan.modo === 'folleto') girar = true;
    else if (geometrias.length) {
      const apaisadas = geometrias.filter((g) => g.anchoPt > g.altoPt).length;
      girar = apaisadas > geometrias.length / 2;
    }
  }

  if (girar !== (ancho > alto)) [ancho, alto] = [alto, ancho];
  return { ancho, alto, apaisado: ancho > alto };
}

/**
 * Dónde se puede dibujar, en puntos.
 *
 * Si la impresora reportó su área imprimible y el plan la respeta, el
 * contenido se ajusta a ESE rectángulo y no al papel: es la diferencia entre
 * un documento que sale entero y uno al que el tóner le come 4 mm por lado.
 */
export function areaUtil(plan, papel) {
  let x = 0; let y = 0;
  let ancho = papel.ancho; let alto = papel.alto;

  const im = plan.imprimible;
  if (plan.respetarNoImprimible && im) {
    /* El área viene medida sobre el papel en su orientación natural. Si el
       papel se giró, el margen también gira. */
    const giroDelPapel = (papel.ancho > papel.alto) !== (mm(plan.papel.ancho) > mm(plan.papel.alto));
    const [ix, iy, iw, ih] = giroDelPapel
      ? [im.y, im.x, im.alto, im.ancho]
      : [im.x, im.y, im.ancho, im.alto];

    x = mm(ix);
    ancho = mm(iw);
    alto = mm(ih);
    /* El origen que reporta Windows se mide desde ARRIBA; el PDF mide desde
       abajo. Sin este vuelco, el contenido queda corrido el doble del margen. */
    const margenInferior = (papel.alto - mm(iy) - mm(ih));
    y = margenInferior;
  }

  const extra = mm(plan.margen || 0);
  return {
    x: x + extra,
    y: y + extra,
    ancho: Math.max(1, ancho - extra * 2),
    alto: Math.max(1, alto - extra * 2),
  };
}

/* ── Encajar una página en un rectángulo ─────────────────────────────────── */

/**
 * Calcula dónde y con qué escala va una página dentro de una celda.
 *
 * Si `rotarSiConviene`, prueba también girada 90° y se queda con la que
 * aproveche más: una hoja apaisada en una celda vertical entra al 58% derecha
 * y al 100% de costado, y esa diferencia se ve.
 */
export function encajar(origen, celda, { tipo = 'ajustar', valor = 100, rotarSiConviene = true } = {}) {
  const opciones = [{ rot: 0, w: origen.ancho, h: origen.alto }];
  if (rotarSiConviene) opciones.push({ rot: 90, w: origen.alto, h: origen.ancho });

  let mejor = null;
  for (const o of opciones) {
    const cabe = Math.min(celda.ancho / o.w, celda.alto / o.h);
    let escala;
    if (tipo === 'real') escala = 1;
    else if (tipo === 'custom') escala = (valor || 100) / 100;
    else if (tipo === 'reducir') escala = Math.min(1, cabe);
    else escala = cabe;                                  // 'ajustar'

    /* Se elige por cuánto ocupa la celda, no por la escala: con "tamaño real"
       las dos orientaciones dan escala 1 y hay que desempatar por área. */
    const ocupa = Math.min(1, (o.w * escala) / celda.ancho) * Math.min(1, (o.h * escala) / celda.alto);
    if (!mejor || ocupa > mejor.ocupa + 1e-6) mejor = { ...o, escala, ocupa };
  }

  const ancho = mejor.w * mejor.escala;
  const alto = mejor.h * mejor.escala;

  return {
    x: celda.x + (celda.ancho - ancho) / 2,
    y: celda.y + (celda.alto - alto) / 2,
    ancho,
    alto,
    escala: mejor.escala,
    rotacion: mejor.rot,
    /* Se sale de la celda: con 'real' o 'custom' es esperable y hay que
       avisarlo en la UI, no corregirlo por atrás. */
    desborda: ancho > celda.ancho + 0.5 || alto > celda.alto + 0.5,
  };
}

/* ── Celdas del N-up ─────────────────────────────────────────────────────── */

/** Los rectángulos de una grilla, en el orden en que se van llenando. */
export function celdasNup(area, { filas, columnas, orden = 'horizontal', separacion = 0 }) {
  const sep = mm(separacion || 0);
  const ancho = (area.ancho - sep * (columnas - 1)) / columnas;
  const alto = (area.alto - sep * (filas - 1)) / filas;

  const celdas = [];
  for (let f = 0; f < filas; f++) {
    for (let c = 0; c < columnas; c++) {
      celdas.push({
        fila: f,
        columna: c,
        // La fila 0 es la de ARRIBA, y en PDF la Y crece hacia arriba.
        x: area.x + c * (ancho + sep),
        y: area.y + area.alto - (f + 1) * alto - f * sep,
        ancho,
        alto,
      });
    }
  }

  const clave = {
    horizontal: (a) => a.fila * columnas + a.columna,
    'horizontal-inv': (a) => a.fila * columnas + (columnas - 1 - a.columna),
    vertical: (a) => a.columna * filas + a.fila,
    'vertical-inv': (a) => (columnas - 1 - a.columna) * filas + a.fila,
  }[orden] || ((a) => a.fila * columnas + a.columna);

  return [...celdas].sort((a, b) => clave(a) - clave(b));
}

/* ── Orden de folleto ────────────────────────────────────────────────────── */

/**
 * El orden de un cuadernillo cosido por el lomo.
 *
 * Con 8 páginas sale: frente [8,1] · dorso [2,7] · frente [6,3] · dorso [4,5].
 * Doblado por la mitad y apilado, se lee 1,2,3…8. Las posiciones que sobran al
 * completar el múltiplo de 4 van en null (hoja en blanco).
 *
 * @returns {Array<{cara:'frente'|'dorso', izquierda:number|null, derecha:number|null}>}
 */
export function ordenFolleto(paginas, { encuadernacion = 'izquierda', porCuadernillo = 0 } = {}) {
  const hojas = [];
  const tamCuadernillo = porCuadernillo > 0 ? porCuadernillo * 4 : Math.ceil(paginas.length / 4) * 4;

  for (let inicio = 0; inicio < paginas.length; inicio += tamCuadernillo) {
    const bloque = paginas.slice(inicio, inicio + tamCuadernillo);
    const n = Math.ceil(bloque.length / 4) * 4;
    const p = (i) => (i >= 0 && i < bloque.length ? bloque[i] : null);

    for (let i = 0; i < n / 4; i++) {
      // Frente: la última contra la primera. Dorso: las dos de adentro.
      let frente = { izquierda: p(n - 1 - 2 * i), derecha: p(2 * i) };
      let dorso = { izquierda: p(2 * i + 1), derecha: p(n - 2 - 2 * i) };

      if (encuadernacion === 'derecha') {
        frente = { izquierda: frente.derecha, derecha: frente.izquierda };
        dorso = { izquierda: dorso.derecha, derecha: dorso.izquierda };
      }

      hojas.push({ cara: 'frente', ...frente });
      hojas.push({ cara: 'dorso', ...dorso });
    }
  }
  return hojas;
}

/* ── Mosaico del póster ──────────────────────────────────────────────────── */

/**
 * Parte una página agrandada en baldosas del tamaño del área útil.
 * El solape es material repetido a propósito: sin él, pegar las hojas exige
 * cortar justo por el filo y cualquier error deja una línea blanca.
 */
export function mosaicoPoster(origen, area, { escala = 100, solape = 12 } = {}) {
  const f = (escala || 100) / 100;
  const anchoTotal = origen.ancho * f;
  const altoTotal = origen.alto * f;
  const sol = mm(solape || 0);

  const pasoX = Math.max(1, area.ancho - sol);
  const pasoY = Math.max(1, area.alto - sol);

  /* Cuántas baldosas COMO MUCHO. El número final sale de contar las que
     sobreviven al filtro de abajo, no de esta cuenta: un PDF cuya página mide
     842 pt en vez de los 841,89 de un A4 real se pasa 0,22 pt al 200% y esta
     división pide una fila entera para ese pelo. Declararla como fila real
     hacía que la UI prometiera 3×2 y el motor entregara 2×2. */
  const columnasMax = Math.max(1, Math.ceil((anchoTotal - sol) / pasoX));
  const filasMax = Math.max(1, Math.ceil((altoTotal - sol) / pasoY));

  /* Una baldosa con menos de 1 mm de contenido no es una baldosa: no se puede
     recortar ni pegar, y en papel es una hoja en blanco que confunde. */
  const MINIMO = mm(1);

  const baldosas = [];
  for (let fila = 0; fila < filasMax; fila++) {
    for (let col = 0; col < columnasMax; col++) {
      // Región del ORIGINAL que cae en esta baldosa (coordenadas sin escalar).
      const left = (col * pasoX) / f;
      const right = Math.min(origen.ancho, (col * pasoX + area.ancho) / f);
      // La fila 0 es la de arriba: en coordenadas PDF eso es la Y más alta.
      const top = origen.alto - (fila * pasoY) / f;
      const bottom = Math.max(0, origen.alto - (fila * pasoY + area.alto) / f);

      if (right - left < MINIMO || top - bottom < MINIMO) continue;

      baldosas.push({
        fila,
        columna: col,
        etiqueta: `${fila + 1}-${col + 1}`,
        recorte: { left, bottom, right, top },

        /* La página ENTERA, escalada y corrida para que el vértice (left, top)
           del original caiga en la esquina superior izquierda del área útil.

           Se dibuja entera y no recortada a propósito: lo que se pasa del papel
           no se imprime igual, y lo que cae en el borde no imprimible es
           justamente material de más para pegar sin que quede una línea blanca.
           Recortar al filo obligaría a cortar con precisión de milímetro. */
        dibujo: {
          x: area.x - left * f,
          y: area.y + area.alto - top * f,
          ancho: origen.ancho * f,
          alto: origen.alto * f,
        },

        // El rectángulo de la hoja donde cae esta baldosa: para las marcas de corte.
        ventana: {
          x: area.x,
          y: area.y + area.alto - (top - bottom) * f,
          ancho: (right - left) * f,
          alto: (top - bottom) * f,
        },
      });
    }
  }
  // La grilla que se reporta es la de las baldosas que quedaron de verdad.
  return {
    filas: new Set(baldosas.map((b) => b.fila)).size || 1,
    columnas: new Set(baldosas.map((b) => b.columna)).size || 1,
    baldosas,
  };
}

/* ── El plan completo → hojas ────────────────────────────────────────────── */

/**
 * Traduce un plan a la lista literal de hojas a imprimir.
 *
 * Esta función es la única fuente de verdad de la imposición: el preview la
 * llama para dibujar y el motor la llama para generar el PDF. Si las dos
 * pasaran por caminos distintos, tarde o temprano mostrarían cosas distintas.
 *
 * @param {object} plan
 * @param {Array<{numero,anchoPt,altoPt}>} geometrias  todas las del documento
 */
export function calcularHojas(plan, geometrias) {
  const total = geometrias.length;
  const paginas = paginasDelPlan(plan, total);
  const papel = papelDelPlan(plan, geometrias.filter((g) => paginas.includes(g.numero)));
  const area = areaUtil(plan, papel);
  const geo = (n) => geometrias[n - 1];
  const tamano = (n) => ({ ancho: geo(n).anchoPt, alto: geo(n).altoPt });

  const hojas = [];
  const comun = { papel, area };

  if (plan.modo === 'folleto') {
    const celdas = celdasNup(area, { filas: 1, columnas: 2, orden: 'horizontal' });
    for (const h of ordenFolleto(paginas, plan.folleto)) {
      const colocaciones = [];
      for (const [i, n] of [h.izquierda, h.derecha].entries()) {
        if (!n) continue;
        const caja = encajar(tamano(n), celdas[i], { ...plan.escala, rotarSiConviene: false });
        colocaciones.push({ pagina: n, ...caja, borde: false, recorte: null });
      }
      hojas.push({ ...comun, cara: h.cara, colocaciones, indice: hojas.length });
    }
  } else if (plan.modo === 'poster') {
    for (const n of paginas) {
      const m = mosaicoPoster(tamano(n), area, plan.poster);
      for (const b of m.baldosas) {
        hojas.push({
          ...comun,
          indice: hojas.length,
          cara: null,
          etiquetaPoster: `${n} · ${b.etiqueta}`,
          mosaico: { filas: m.filas, columnas: m.columnas, fila: b.fila, columna: b.columna },
          marcas: plan.poster.marcas,
          ventana: b.ventana,
          colocaciones: [{
            pagina: n,
            ...b.dibujo,
            rotacion: 0,
            escala: (plan.poster.escala || 100) / 100,
            recorte: b.recorte,
            ventana: b.ventana,
            borde: false,
            desborda: false,
          }],
        });
      }
    }
  } else if (plan.modo === 'nup') {
    const { filas, columnas } = plan.nup;
    const porHoja = Math.max(1, filas * columnas);
    const celdas = celdasNup(area, plan.nup);
    for (let i = 0; i < paginas.length; i += porHoja) {
      const grupo = paginas.slice(i, i + porHoja);
      hojas.push({
        ...comun,
        indice: hojas.length,
        cara: null,
        colocaciones: grupo.map((n, j) => ({
          pagina: n,
          ...encajar(tamano(n), celdas[j], plan.escala),
          borde: !!plan.nup.borde,
          celda: celdas[j],
          recorte: null,
        })),
      });
    }
  } else {
    for (const n of paginas) {
      hojas.push({
        ...comun,
        indice: hojas.length,
        cara: null,
        colocaciones: [{
          pagina: n,
          ...encajar(tamano(n), area, { ...plan.escala, rotarSiConviene: plan.orientacion === 'auto' }),
          borde: false,
          recorte: null,
        }],
      });
    }
  }

  return {
    papel,
    area,
    hojas,
    resumen: {
      paginasOriginales: paginas.length,
      hojas: hojas.length,
      // Con dúplex, cada dos caras es una hoja física de papel.
      hojasFisicas: plan.duplex === 'simplex' ? hojas.length : Math.ceil(hojas.length / 2),
      desborde: hojas.some((h) => h.colocaciones.some((c) => c.desborda)),
    },
  };
}
