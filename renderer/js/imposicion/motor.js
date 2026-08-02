/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — motor de imposición
   Toma el plan ya resuelto por plan.js y escribe el PDF que va a salir por la
   impresora. Este archivo no decide NADA de geometría: si algo cae en el lugar
   equivocado, el error está en plan.js y ahí hay tests que lo agarran.

   El PDF que sale de acá es el único artefacto: el preview lo rasteriza con
   pdf.js y la impresora lo recibe tal cual. No hay dos caminos que puedan
   divergir.

   ── La trampa de la rotación ───────────────────────────────────────────────
   pdf-lib embebe el contenido del MediaBox y NO aplica el /Rotate de la
   página; pdf.js sí lo aplica. Una página escaneada con /Rotate 90 mide
   842×595 según pdf.js y 595×842 según pdf-lib, y si no se compensa sale
   acostada. Por eso acá se lee la rotación intrínseca y se suma a la que pidió
   el plan.

   Y `drawPage` rota alrededor del punto (x,y), no del centro: para que el
   resultado caiga en el rectángulo pedido hay que corregir el ancla según el
   ángulo. Está en anclar().
   ═══════════════════════════════════════════════════════════════════════════ */

import { PDFDocument, degrees, rgb } from '../../vendor/pdf-lib/pdf-lib.mjs';
import { calcularHojas, mm } from './plan.js';

/**
 * Dónde poner el ancla y qué medidas pasarle a drawPage para que el contenido
 * termine ocupando exactamente {x, y, ancho, alto} después de rotar θ.
 *
 * `ancho`/`alto` son las medidas YA rotadas (lo que se ve). `width`/`height`
 * son las de antes de rotar, que es lo que espera pdf-lib.
 */
function anclar({ x, y, ancho, alto }, theta) {
  switch (((theta % 360) + 360) % 360) {
    case 90:  return { x: x + ancho, y, width: alto, height: ancho };
    case 180: return { x: x + ancho, y: y + alto, width: ancho, height: alto };
    case 270: return { x, y: y + alto, width: alto, height: ancho };
    default:  return { x, y, width: ancho, height: alto };
  }
}

/* Gris medio para lo que es marca de taller y no contenido: bordes del N-up y
   marcas de corte. Suficiente para verse, discreto para no competir. */
const TINTA_MARCA = rgb(0.62, 0.62, 0.62);

/** Las cuatro esquinas de la ventana, en ángulo, para saber dónde cortar. */
function marcasDeCorte(hoja, largo = mm(6)) {
  const v = hoja.ventana;
  if (!v) return [];
  const lineas = [];
  const esquinas = [
    [v.x, v.y, 1, 1],                       // inferior izquierda
    [v.x + v.ancho, v.y, -1, 1],            // inferior derecha
    [v.x, v.y + v.alto, 1, -1],             // superior izquierda
    [v.x + v.ancho, v.y + v.alto, -1, -1],  // superior derecha
  ];
  for (const [cx, cy, dx, dy] of esquinas) {
    lineas.push({ start: { x: cx, y: cy }, end: { x: cx + dx * largo, y: cy } });
    lineas.push({ start: { x: cx, y: cy }, end: { x: cx, y: cy + dy * largo } });
  }
  return lineas;
}

/**
 * Impone un PDF según el plan.
 *
 * @param {Uint8Array|ArrayBuffer} bytes  el PDF original, intacto
 * @param {object} plan
 * @param {Array} geometrias  las de pdf.js, con /Rotate ya aplicado
 * @param {{onProgreso?:(hecho:number,total:number)=>void}} opciones
 * @returns {Promise<{bytes:Uint8Array, calculo:object}>}
 */
export async function imponer(bytes, plan, geometrias, { onProgreso, limiteHojas = 0 } = {}) {
  const calculo = calcularHojas(plan, geometrias);
  if (!calculo.hojas.length) throw new Error('El plan no deja ninguna página para imprimir');

  /* El preview puede pedir solo las primeras hojas: imponer 400 hojas en cada
     tecleo del campo de escala haría que la app se arrastre. El CÁLCULO sigue
     siendo completo —el resumen dice cuántas hojas van a salir de verdad— y
     las que se generan salen del mismo camino que las de la impresión. Lo que
     se ve sigue siendo lo que sale; solo se ve una parte. */
  const hojasAGenerar = limiteHojas > 0 ? calculo.hojas.slice(0, limiteHojas) : calculo.hojas;

  const origen = await PDFDocument.load(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    // Un PDF con permisos de solo-lectura igual se puede imponer: el permiso
    // es del documento, no del papel que ya tenés en la mano.
    { ignoreEncryption: true, updateMetadata: false }
  );
  const salida = await PDFDocument.create();

  /* Cada página del original se embebe UNA sola vez aunque aparezca en varias
     hojas (un póster la usa en todas sus baldosas). Sin esto, un póster 4×4
     mete dieciséis copias del mismo contenido en el archivo. */
  const usadas = [...new Set(hojasAGenerar.flatMap((h) => h.colocaciones.map((c) => c.pagina)))].sort((a, b) => a - b);
  const paginasOrigen = usadas.map((n) => origen.getPage(n - 1));
  const embebidas = await salida.embedPages(paginasOrigen);

  const porNumero = new Map(usadas.map((n, i) => [n, embebidas[i]]));
  const rotacionIntrinseca = new Map(
    usadas.map((n, i) => [n, ((paginasOrigen[i].getRotation().angle % 360) + 360) % 360])
  );

  const { papel } = calculo;

  for (const [i, hoja] of hojasAGenerar.entries()) {
    const pagina = salida.addPage([papel.ancho, papel.alto]);

    for (const c of hoja.colocaciones) {
      const emb = porNumero.get(c.pagina);
      if (!emb) continue;

      const theta = (c.rotacion || 0) + (rotacionIntrinseca.get(c.pagina) || 0);
      pagina.drawPage(emb, anclar(c, theta));

      // El borde del N-up va alrededor de la página, no de la celda: marca
      // dónde termina el contenido, que es lo que uno quiere ver al recortar.
      if (c.borde) {
        pagina.drawRectangle({
          x: c.x, y: c.y, width: c.ancho, height: c.alto,
          borderColor: TINTA_MARCA, borderWidth: 0.5, opacity: 0,
        });
      }
    }

    if (hoja.marcas) {
      for (const l of marcasDeCorte(hoja)) {
        pagina.drawLine({ ...l, thickness: 0.4, color: TINTA_MARCA });
      }
    }

    onProgreso?.(i + 1, hojasAGenerar.length);
  }

  salida.setProducer('Quire');
  salida.setCreator('Quire');
  salida.setTitle(tituloDe(plan, calculo));
  salida.setCreationDate(new Date());

  return {
    bytes: await salida.save({ useObjectStreams: true }),
    calculo,
    generadas: hojasAGenerar.length,
    parcial: hojasAGenerar.length < calculo.hojas.length,
  };
}

function tituloDe(plan, calculo) {
  const modo = {
    simple: 'Impresión', nup: 'Múltiple', poster: 'Póster', folleto: 'Folleto',
  }[plan.modo] || 'Impresión';
  return `${modo} · ${plan.papel.nombre} · ${calculo.hojas.length} hojas`;
}

/**
 * Parte un trabajo en las dos pasadas del dúplex manual.
 *
 * La P1102w no tiene unidad dúplex: imprime un lado, se recarga el fajo a mano,
 * y se imprime el otro. Manejarlo nosotros —en vez de dejárselo al driver—
 * permite mostrar cómo va el papel y, sobre todo, ordenar bien la segunda
 * pasada.
 *
 * El orden es lo que más se equivoca, y no depende de cómo se recarga sino de
 * dos hechos mecánicos que se combinan:
 *
 *   · la bandeja de salida apila BOCA ABAJO, así que la última hoja impresa
 *     queda ARRIBA de todo;
 *   · la bandeja de entrada toma de ARRIBA.
 *
 * O sea que la primera hoja de la segunda pasada es la ÚLTIMA de la primera. Si
 * los dorsos salieran en el mismo orden que los frentes, cada uno caería en la
 * hoja equivocada. Por eso el reverso va invertido.
 *
 * Ojo: esto es independiente del movimiento del fajo (ver diagramaVuelta en
 * views/imprimir.js). Girar la pila media vuelta en el plano no cambia qué hoja
 * está arriba; darla vuelta SÍ lo cambiaría, y por eso el instructivo insiste
 * con que no se da vuelta.
 *
 * @returns {{frentes:number[], dorsos:number[], hojasDePapel:number}}
 *   índices (base 0) dentro del PDF impuesto.
 */
export function partirDuplex(totalCaras, { invertirReverso = true } = {}) {
  const frentes = [];
  const dorsos = [];
  for (let i = 0; i < totalCaras; i++) (i % 2 === 0 ? frentes : dorsos).push(i);
  if (invertirReverso) dorsos.reverse();
  return { frentes, dorsos, hojasDePapel: frentes.length };
}

/**
 * Extrae un subconjunto de páginas de un PDF ya impuesto, conservando el orden
 * pedido. Es lo que se manda a la cola en cada pasada del dúplex.
 */
export async function extraerCaras(bytesImpuestos, indices) {
  const doc = await PDFDocument.load(bytesImpuestos, { ignoreEncryption: true });
  const salida = await PDFDocument.create();
  const copiadas = await salida.copyPages(doc, indices);
  for (const p of copiadas) salida.addPage(p);
  salida.setProducer('Quire');
  return salida.save({ useObjectStreams: true });
}

/* ── Combinar y dividir ──────────────────────────────────────────────────────
   Viven acá y no en un módulo aparte porque son la misma operación de fondo
   que la imposición: copiar páginas de un documento a otro sin re-renderizar
   nada. El contenido llega intacto — no se rasteriza en el camino. */

/**
 * Reordena, rota y borra páginas.
 *
 * `orden` es la lista de páginas del original (base 1) en el orden nuevo: lo
 * que no aparece, no queda. Borrar es no incluir, y por eso una sola operación
 * cubre las tres cosas sin que puedan contradecirse entre sí.
 *
 * `rotaciones` es un giro EXTRA sobre el /Rotate que la página ya tenía: una
 * página escaneada al revés ya viene con 180, y sumarle 90 tiene que dar 270.
 *
 * @param {Uint8Array} bytes
 * @param {{orden:number[], rotaciones?:Record<number,number>}} cambios
 */
export async function reorganizar(bytes, { orden, rotaciones = {} }) {
  if (!orden?.length) throw new Error('No queda ninguna página');

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = doc.getPageCount();
  const validas = orden.filter((n) => n >= 1 && n <= total);
  if (!validas.length) throw new Error('Ninguna de las páginas pedidas existe');

  const salida = await PDFDocument.create();
  const copiadas = await salida.copyPages(doc, validas.map((n) => n - 1));

  for (const [i, pagina] of copiadas.entries()) {
    const extra = rotaciones[validas[i]] || 0;
    if (extra) {
      const actual = pagina.getRotation().angle || 0;
      pagina.setRotation(degrees((((actual + extra) % 360) + 360) % 360));
    }
    salida.addPage(pagina);
  }

  salida.setProducer('Quire');
  return salida.save({ useObjectStreams: true });
}

/** Une varios PDFs en uno. `docs` es [{bytes, nombre}]. */
export async function combinar(docs) {
  const salida = await PDFDocument.create();
  const indice = [];

  for (const d of docs) {
    const doc = await PDFDocument.load(d.bytes, { ignoreEncryption: true });
    const desde = salida.getPageCount();
    const paginas = await salida.copyPages(doc, doc.getPageIndices());
    for (const p of paginas) salida.addPage(p);
    indice.push({ nombre: d.nombre, desde: desde + 1, hasta: salida.getPageCount() });
  }

  salida.setProducer('Quire');
  salida.setTitle(`Combinado · ${docs.length} documentos`);
  return { bytes: await salida.save({ useObjectStreams: true }), indice };
}

/**
 * Parte un PDF en varios.
 * @param {object} corte  {tipo:'cada'|'rangos', cada:number, rangos:number[][]}
 * @returns {Promise<Array<{nombre:string, bytes:Uint8Array, desde:number, hasta:number}>>}
 */
export async function dividir(bytes, corte, nombreBase = 'documento') {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = doc.getPageCount();

  let bloques = [];
  if (corte.tipo === 'rangos') {
    bloques = (corte.rangos || []).map((r) => r.filter((n) => n >= 1 && n <= total));
  } else {
    const cada = Math.max(1, corte.cada || 1);
    for (let i = 0; i < total; i += cada) {
      bloques.push(Array.from({ length: Math.min(cada, total - i) }, (_, k) => i + k + 1));
    }
  }
  bloques = bloques.filter((b) => b.length);
  if (!bloques.length) throw new Error('El corte no deja ninguna página');

  const ancho = String(bloques.length).length;
  const partes = [];
  for (const [i, paginas] of bloques.entries()) {
    const salida = await PDFDocument.create();
    const copiadas = await salida.copyPages(doc, paginas.map((n) => n - 1));
    for (const p of copiadas) salida.addPage(p);
    salida.setProducer('Quire');
    partes.push({
      nombre: `${nombreBase}-${String(i + 1).padStart(ancho, '0')}.pdf`,
      bytes: await salida.save({ useObjectStreams: true }),
      desde: paginas[0],
      hasta: paginas[paginas.length - 1],
      paginas: paginas.length,
    });
  }
  return partes;
}
