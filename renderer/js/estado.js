/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — estado
   Los documentos abiertos viven acá y no adentro de una vista, porque el router
   repinta las vistas enteras: si el PDF colgara de la vista del lector, ir a
   Imprimir y volver lo cerraría y lo reabriría.

   Quien necesite enterarse de un cambio se suscribe con alCambiar(). Las
   vistas se desuscriben solas vía Router.onLeave.

   ── Las pestañas ───────────────────────────────────────────────────────────
   Hay VARIOS documentos abiertos y uno activo. Pero las vistas siguen
   escribiendo `S.doc`, `S.pagina`, `S.zoom` como cuando había uno solo: esos
   campos son getters que delegan en la pestaña activa. Son casi doscientos
   accesos repartidos por las cuatro vistas, y ninguna necesita enterarse de
   que abajo hay una lista — cambiar de pestaña es cambiar a qué objeto apunta
   la fachada, y emitir 'documento' para que se repinten.

   El costo de tener varios abiertos a la vez es más chico de lo que parece:
   los bitmaps ya los maneja la virtualización del lector (solo existen las
   páginas en pantalla) y el worker de pdf.js es UNO para todos — ver
   pdf/documento.js. Lo que se paga por pestaña es la estructura parseada del
   PDF, que al lado de un canvas de 1200×1700 no es nada.
   ═══════════════════════════════════════════════════════════════════════════ */

import { abrirDocumento } from './pdf/documento.js';
import { CapaDeTinta } from './tinta/capa.js';

const api = window.onyx;

/* Cuatro, y no es un límite técnico: con el worker compartido entrarían más.
   Es de lectura. La franja reparte su ancho entre las pestañas abiertas, y
   pasadas cuatro los nombres se recortan tanto que dejás de distinguir un
   apunte del otro. Una pestaña que no sabés cuál es no sirve para nada. */
export const MAX_PESTANAS = 4;

/**
 * Lo que es de UN documento y no de la app, con su valor de arranque.
 *
 * Que la página, el zoom y la rotación sean de la pestaña es el punto: volver
 * a un documento tiene que devolverte donde estabas, igual que volver de
 * Imprimir al lector te devuelve a tu página.
 */
const CAMPOS = {
  /** @type {import('./pdf/documento.js').Documento | null} */
  doc: null,
  /** @type {import('./tinta/capa.js').CapaDeTinta | null} */
  tinta: null,
  geometrias: [],
  esquema: [],
  metadatos: null,

  pagina: 1,
  zoom: 1,
  modoZoom: 'ancho',      // 'ancho' | 'pagina' | 'fijo'
  rotacion: 0,            // 0 | 90 | 180 | 270, aplicada sobre todas las páginas

  /* El plan de imposición vivo. Sobrevive a navegar entre vistas Y a cambiar
     de pestaña: perder la configuración de un folleto por ir a mirar otro
     documento sería hostil. */
  plan: null,
};

/** Los documentos abiertos, en el orden en que se ven en la franja. */
const pestanas = [];
let activa = 0;
let proximoId = 1;

export const S = {
  /* ── Lo que es de la app y no de un documento ── */
  impresoras: [],
  impresora: null,        // el nombre de la elegida
  info: null,
  settings: {},
  cargando: false,

  /** Las pestañas abiertas. Solo para leer: se abren y cierran con las funciones de abajo. */
  get pestanas() { return pestanas; },
  /** La pestaña activa entera, cuando hace falta su id. */
  get pestana() { return pestanas[activa] || null; },
};

/* La fachada. Sin ninguna pestaña abierta, leer devuelve el vacío de cada
   campo y escribir no hace nada — y eso es lo correcto, no un descuido: la app
   arranca sin documento y las vistas se pintan igual (la de "no hay ningún PDF
   abierto" pregunta por S.doc para saberlo).

   El único filo: un `S.zoom = 2` antes de abrir nada se pierde en silencio.
   Por eso los valores de arranque de una pestaña salen de los ajustes adentro
   de nuevaPestana(), y no de escribirle a S durante el boot. */
for (const [campo, vacio] of Object.entries(CAMPOS)) {
  Object.defineProperty(S, campo, {
    enumerable: true,
    get: () => (pestanas[activa] ? pestanas[activa][campo] : vacio),
    set: (v) => { if (pestanas[activa]) pestanas[activa][campo] = v; },
  });
}

const oyentes = new Set();

/** Devuelve la función para desuscribirse — pasásela a Router.onLeave. */
export function alCambiar(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

export function emitir(que = 'todo') {
  for (const fn of [...oyentes]) {
    try { fn(que); } catch (err) { console.error('[estado] oyente:', err); }
  }
}

/** La impresora elegida, con sus capacidades. */
export function impresoraActual() {
  return S.impresoras.find((p) => p.nombre === S.impresora) || null;
}

/** El tamaño de papel de la impresora activa que coincida con un nombre. */
export function papelDe(nombre) {
  const p = impresoraActual();
  if (!p) return null;
  // Los nombres de Windows son ISOA4, NorthAmericaLetter… y los nuestros A4, Letter.
  const buscado = String(nombre).toLowerCase().replace(/[^a-z0-9]/g, '');
  return p.tamanos.find((t) => t.nombre.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith(buscado)) || null;
}

/* Los nombres del Print Schema de Windows, en castellano legible. Lo que no
   esté acá se muestra tal cual: es mejor un "JISB5" crudo que inventarle un
   nombre a un tamaño que no conocemos. */
const NOMBRES_PAPEL = {
  ISOA3: 'A3', ISOA4: 'A4', ISOA5: 'A5', ISOA6: 'A6',
  NorthAmericaLetter: 'Carta', NorthAmericaLegal: 'Oficio',
  NorthAmericaExecutive: 'Ejecutivo', JISB5: 'B5 (JIS)', ISOB5Envelope: 'Sobre B5',
  ISOC5Envelope: 'Sobre C5', ISODLEnvelope: 'Sobre DL',
  NorthAmericaNumber10Envelope: 'Sobre nº10', NorthAmericaMonarchEnvelope: 'Sobre Monarca',
  JapanHagakiPostcard: 'Postal', JapanDoubleHagakiPostcardRotated: 'Postal doble',
};

export const nombrePapel = (crudo) => NOMBRES_PAPEL[crudo] || String(crudo).replace(/^(ISO|NorthAmerica|Japan)/, '');

/**
 * Los papeles que se pueden elegir. Salen de la impresora si contestó, porque
 * son los que de verdad puede cargar; si no, de una lista estándar.
 */
export function papelesDisponibles() {
  const p = impresoraActual();
  if (p?.tamanos?.length) {
    return p.tamanos.map((t) => ({
      id: t.nombre,
      nombre: nombrePapel(t.nombre),
      ancho: t.ancho,
      alto: t.alto,
      imprimible: t.imprimible,
    }));
  }
  return [
    { id: 'ISOA4', nombre: 'A4', ancho: 210, alto: 297, imprimible: null },
    { id: 'ISOA5', nombre: 'A5', ancho: 148, alto: 210, imprimible: null },
    { id: 'NorthAmericaLetter', nombre: 'Carta', ancho: 215.9, alto: 279.4, imprimible: null },
  ];
}

/** Mete un papel en el plan, arrastrando su área imprimible. */
export function aplicarPapel(plan, papelId) {
  const p = papelesDisponibles().find((x) => x.id === papelId) || papelesDisponibles()[0];
  if (!p) return plan;
  return {
    ...plan,
    papel: { nombre: p.nombre, id: p.id, ancho: p.ancho, alto: p.alto },
    imprimible: p.imprimible,
  };
}

/* ══ Pestañas ════════════════════════════════════════════════════════════════ */

/** Una pestaña vacía, con los valores de arranque que digan los ajustes. */
function nuevaPestana(doc) {
  return {
    ...CAMPOS,
    // Explícitos y no heredados del spread: si no, las cuatro pestañas
    // compartirían el MISMO array de geometrías.
    geometrias: [],
    esquema: [],
    id: proximoId++,
    doc,
    modoZoom: S.settings?.modoZoomInicial || 'ancho',
  };
}

/**
 * Abre un PDF ya leído del disco ({ruta, nombre, bytes, tamano}) en una
 * pestaña nueva, y la deja activa.
 *
 * Tirá el error si no hay lugar: quien llama sabe cómo avisarle al usuario.
 */
export async function abrir(archivo) {
  /* El mismo archivo dos veces es UNA pestaña. Abrirlo de nuevo desde el
     diálogo, o arrastrarlo otra vez, te lleva a la que ya está — y no es solo
     prolijidad: la capa de tinta se identifica por un hash de la ruta, así que
     dos pestañas del mismo PDF serían dos capas sobre el mismo id, y la última
     en guardar le pisaría los trazos a la otra. */
  const repetida = pestanas.find((p) => p.doc?.ruta && p.doc.ruta === archivo.ruta);
  if (repetida) {
    activar(repetida.id);
    return repetida.doc;
  }

  if (pestanas.length >= MAX_PESTANAS) {
    throw new Error(`Ya hay ${MAX_PESTANAS} documentos abiertos. Cerrá uno para abrir otro.`);
  }

  S.cargando = true;
  emitir('cargando');
  try {
    const doc = await abrirDocumento(archivo.bytes, {
      nombre: archivo.nombre,
      ruta: archivo.ruta,
      tamano: archivo.tamano,
    });

    /* La pestaña se llena ENTERA antes de entrar a la lista. Si algo de esto
       falla, no queda una pestaña a medias en la franja: no llegó a existir.
       Mientras tanto se sigue viendo el documento anterior, que es mejor que
       vaciar la pantalla para volver a llenarla. */
    const p = nuevaPestana(doc);
    p.geometrias = await doc.geometrias();
    p.esquema = await doc.esquema();
    p.metadatos = await doc.metadatos();
    /* La tinta se busca por un hash de la ruta y el tamaño: reabrir el mismo
       PDF trae de vuelta lo anotado, sin que el archivo haya cambiado nunca. */
    p.tinta = await CapaDeTinta.cargar(doc).catch((err) => {
      console.error('[tinta] no se pudo cargar:', err.message);
      return new CapaDeTinta(doc);
    });
    p.tinta.onCambio = () => emitir('tinta');

    pestanas.push(p);
    activa = pestanas.length - 1;
    emitir('pestanas');
    emitir('documento');
    return doc;
  } finally {
    S.cargando = false;
    emitir('cargando');
  }
}

/** Trae al frente la pestaña con ese id. */
export function activar(id) {
  const i = pestanas.findIndex((p) => p.id === id);
  if (i < 0 || i === activa) return false;
  activa = i;
  emitir('pestanas');
  emitir('documento');
  return true;
}

/** La de al lado, en la dirección que le pidas. Da la vuelta en las puntas. */
export function activarRelativa(paso) {
  if (pestanas.length < 2) return false;
  const i = (activa + paso + pestanas.length) % pestanas.length;
  return activar(pestanas[i].id);
}

/** Cierra una pestaña y activa la que ocupa su lugar. */
export async function cerrarPestana(id) {
  const i = pestanas.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const p = pestanas[i];

  /* Lo que quedó sin guardar se escribe ANTES de soltar el documento: la capa
     de tinta guarda con 900 ms de retardo, y cerrar de golpe se comería el
     último trazo. */
  await p.tinta?.guardar().catch(() => {});
  p.doc?.destruir();
  pestanas.splice(i, 1);

  /* A dónde saltar. Si cerraste la activa, a la que se corrió a su lugar — la
     de la derecha, que es donde ya estaba el ojo; y si cerraste la última, a
     la de la izquierda. Si cerraste otra, seguís en la tuya: solo hay que
     corregir el índice por el corrimiento. */
  if (activa > i) activa -= 1;
  else if (activa === i) activa = Math.min(i, pestanas.length - 1);
  if (activa < 0) activa = 0;

  emitir('pestanas');
  emitir('documento');
  return true;
}

/** Cierra la pestaña activa (Ctrl+W). */
export async function cerrar() {
  const p = pestanas[activa];
  if (!p) return false;
  return cerrarPestana(p.id);
}

/**
 * Escribe lo que quedó pendiente en TODAS las pestañas.
 *
 * La capa de tinta guarda con 900 ms de retardo, así que en cualquier momento
 * puede haber trazos dibujados que todavía no tocaron el disco — y no solo en
 * la pestaña que estás mirando: si dibujaste en una y te pasaste a otra, la
 * primera se quedó con lo suyo en el aire.
 *
 * Las cuatro van en paralelo y ninguna puede voltear a las demás: son archivos
 * distintos, y que una falle no es motivo para no guardar el resto. Devuelve
 * cuántas se guardaron de verdad, que es lo único que se puede afirmar.
 */
export async function guardarTodo() {
  const hechas = await Promise.all(pestanas.map((p) => (
    p.tinta
      ? p.tinta.guardar().then(() => true).catch((err) => {
        console.error('[tinta] no se pudo guardar', p.doc?.nombre, err.message);
        return false;
      })
      : Promise.resolve(false)
  )));
  return hechas.filter(Boolean).length;
}

/**
 * Las rutas de lo abierto, con la ACTIVA primero. Es lo que se guarda en
 * ajustes para poder rearmar la sesión al arrancar, y el orden importa: la
 * primera es la que se vuelve a mirar.
 */
export function rutasAbiertas() {
  // Se reordena la LISTA y recién después se sacan las rutas: filtrando
  // primero, un documento sin ruta correría los índices y `activa` señalaría
  // a otra pestaña.
  const orden = [...pestanas];
  if (activa > 0 && activa < orden.length) orden.unshift(...orden.splice(activa, 1));
  return orden.map((p) => p.doc?.ruta).filter(Boolean);
}

/** Carga la lista de impresoras y elige una si todavía no hay. */
export async function cargarImpresoras({ refrescar = false } = {}) {
  S.impresoras = await api.print.listar();
  if (refrescar) await api.print.capacidades({ refrescar: true });

  if (!S.impresora || !S.impresoras.some((p) => p.nombre === S.impresora)) {
    const guardada = S.settings?.impresora;
    S.impresora = S.impresoras.find((p) => p.nombre === guardada)?.nombre
      ?? S.impresoras.find((p) => p.predeterminada)?.nombre
      /* Print to PDF y XPS son destinos, no impresoras: si hay una de verdad,
         esa es la que el usuario quiere ver elegida al abrir el diálogo. */
      ?? S.impresoras.find((p) => !/(print to pdf|xps|fax)/i.test(p.nombre))?.nombre
      ?? S.impresoras[0]?.nombre
      ?? null;
  }
  emitir('impresoras');
  return S.impresoras;
}
