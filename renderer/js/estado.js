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

  /* Lo que se está organizando en Páginas y todavía no se guardó:
     { orden, rotaciones, seleccion, ultima, historial }. Por la misma razón
     que el plan: era un estado de la vista, uno solo para la app, y un
     Ctrl+Tab a otro documento tiraba los cambios sin avisar. */
  organizar: null,

  /* Dónde estabas leyendo, más fino que la página: { pagina, fraccion,
     scrollLeft }. Con solo la página, volver a la pestaña te dejaba en el
     encabezado de la hoja y había que buscar el renglón. */
  lugar: null,
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
  /* Cuántos documentos se están abriendo ahora. Un contador y no un sí o no:
     con dos aperturas a la vez, la primera que terminaba lo apagaba aunque la
     otra siguiera cargando. */
  cargando: 0,

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

/* Las aperturas en curso, por ruta. abrir() mira si el archivo ya está y si hay
   lugar ANTES de los await de leerlo, y recién al final lo suma a la lista: dos
   aperturas que se pisaban (doble click repetido en el Explorador, el mismo PDF
   soltado dos veces) pasaban las dos y quedaban dos pestañas sobre la misma
   capa de tinta. La segunda espera a la primera. */
const enCurso = new Map();

/** ¿Ese archivo ya está abierto (o abriéndose)? */
export function estaAbierto(ruta) {
  return !!ruta && (enCurso.has(ruta) || pestanas.some((p) => p.doc?.ruta === ruta));
}

/** ¿Entra una pestaña más? Cuentan también las que se están abriendo. */
export function hayLugar() {
  return pestanas.length + enCurso.size < MAX_PESTANAS;
}

/* Lo que tiene que pasar antes de cerrar una pestaña: (pestana) => Promise<boolean>.
   Si alguna dice que no (Páginas con cambios sin guardar, y el usuario se
   arrepiente), la pestaña no se cierra. */
const guardias = new Set();

/** Registra una guardia de cierre. Devuelve la función para soltarla. */
export function alCerrarPestana(fn) {
  guardias.add(fn);
  return () => guardias.delete(fn);
}

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
 * Con `activar: false` la pestaña entra a la franja sin cambiar el documento
 * que se está mirando (salvo que sea la única): es lo que usa la sesión al
 * arrancar, que abría las cuatro de a una y el lector pasaba por todas antes
 * de volver a la primera.
 *
 * `posicion` es el lugar de la franja donde entra (por defecto, al final). La
 * sesión lo usa para poner cada pestaña directo en su lugar: abría todas al
 * final y después corría la activa, y la franja se reordenaba a la vista.
 *
 * Tirá el error si no hay lugar: quien llama sabe cómo avisarle al usuario.
 */
export async function abrir(archivo, { activar: activarla = true, posicion = null } = {}) {
  const ruta = archivo.ruta;
  if (ruta && enCurso.has(ruta)) {
    const doc = await enCurso.get(ruta);
    const p = pestanas.find((x) => x.doc === doc);
    if (p && activarla) activar(p.id);
    return doc;
  }
  if (!ruta) return abrirUna(archivo, activarla, posicion);
  const promesa = abrirUna(archivo, activarla, posicion);
  enCurso.set(ruta, promesa);
  try { return await promesa; } finally { enCurso.delete(ruta); }
}

async function abrirUna(archivo, activarla, posicion) {
  /* El mismo archivo dos veces es UNA pestaña. Abrirlo de nuevo desde el
     diálogo, o arrastrarlo otra vez, te lleva a la que ya está — y no es solo
     prolijidad: la capa de tinta se identifica por un hash de la ruta, así que
     dos pestañas del mismo PDF serían dos capas sobre el mismo id, y la última
     en guardar le pisaría los trazos a la otra. */
  const repetida = pestanas.find((p) => p.doc?.ruta && p.doc.ruta === archivo.ruta);
  if (repetida) {
    if (activarla) activar(repetida.id);
    return repetida.doc;
  }

  // Cuentan también las que se están abriendo (esta todavía no entró a
  // enCurso: esto corre antes del primer await).
  if (pestanas.length + enCurso.size >= MAX_PESTANAS) {
    throw new Error(`Ya hay ${MAX_PESTANAS} documentos abiertos. Cerrá uno para abrir otro.`);
  }

  S.cargando += 1;
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
    /* Los marcadores no se leen al abrir: los pide el lector recién cuando
       abrís la pestaña Marcadores (lector-24). En un PDF con un índice largo
       eran cientos de idas al worker antes de ver la primera hoja.
       Documento.esquema() guarda la promesa, así que pedirlos dos veces no
       vuelve a salir. */
    p.esquema = null;
    p.metadatos = await doc.metadatos();
    /* La tinta se busca por un hash de la ruta y el tamaño: reabrir el mismo
       PDF trae de vuelta lo anotado, sin que el archivo haya cambiado nunca. */
    p.tinta = await CapaDeTinta.cargar(doc).catch((err) => {
      console.error('[tinta] no se pudo cargar:', err.message);
      return new CapaDeTinta(doc);
    });
    p.tinta.onCambio = () => emitir('tinta');

    /* Donde se pidió, recortado a los bordes. Si entra delante de la activa,
       la activa sigue siendo la MISMA pestaña: se la vuelve a buscar. */
    const actual = pestanas[activa];
    const i = Number.isInteger(posicion) ? Math.max(0, Math.min(pestanas.length, posicion)) : pestanas.length;
    pestanas.splice(i, 0, p);
    const cambia = activarla || pestanas.length === 1;
    activa = cambia ? i : pestanas.indexOf(actual);
    emitir('pestanas');
    if (cambia) emitir('documento');
    return doc;
  } finally {
    S.cargando = Math.max(0, S.cargando - 1);
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

/**
 * Corre una pestaña a otro lugar de la franja. `destino` es el índice donde
 * tiene que quedar; se recorta a los bordes, así que pasarse no rompe nada.
 *
 * La activa sigue siendo la MISMA pestaña, esté donde esté después del
 * corrimiento: mover una franja no es elegir un documento. Por eso acá se
 * emite solo 'pestanas' y no 'documento' — el lector no tiene nada que
 * repintar.
 */
export function mover(id, destino) {
  const i = pestanas.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const j = Math.max(0, Math.min(pestanas.length - 1, destino));
  if (i === j) return false;

  const actual = pestanas[activa];
  const [p] = pestanas.splice(i, 1);
  pestanas.splice(j, 0, p);
  activa = pestanas.indexOf(actual);

  emitir('pestanas');
  return true;
}

/**
 * Lo que Páginas tiene sin guardar en una pestaña (la activa, si no se dice):
 * { quitadas, giradas, reordenada } o null si no hay nada pendiente. Vive acá
 * y no en la vista porque lo leen tres: la barra de Páginas, la guardia que
 * pregunta antes de cerrar la pestaña y la que pregunta antes de cerrar la app.
 * Solo cuentan los giros de páginas que SIGUEN: girar una y quitarla no deja
 * nada pendiente.
 */
export function cambiosDePaginas(p = pestanas[activa]) {
  const o = p?.organizar;
  const total = p?.doc?.paginas;
  if (!o || !total || !Array.isArray(o.orden)) return null;
  const quitadas = total - o.orden.length;
  const giradas = o.orden.filter((n) => ((o.rotaciones?.[n] || 0) % 360) !== 0).length;
  const reordenada = o.orden.some((n, i) => i > 0 && n < o.orden[i - 1]);
  return quitadas || giradas || reordenada ? { quitadas, giradas, reordenada } : null;
}

/** Cierra una pestaña y activa la que ocupa su lugar. */
export async function cerrarPestana(id) {
  const p = pestanas.find((x) => x.id === id);
  if (!p) return false;
  /* Una sola vez. El índice se tomaba antes del await de guardar la tinta, y
     una segunda llamada en el medio (doble click en la cruz, Ctrl+W sostenido)
     hacía splice con el índice viejo: cerraba la pestaña de al lado, sin
     guardar su tinta ni soltar su documento. */
  if (p.cerrando) return false;
  p.cerrando = true;

  for (const guardia of [...guardias]) {
    let sigue = true;
    try { sigue = await guardia(p); } catch (err) { console.error('[estado] guardia de cierre:', err); }
    if (sigue === false) { p.cerrando = false; return false; }
  }

  /* Lo que quedó sin guardar se escribe ANTES de soltar el documento: la capa
     de tinta guarda con 900 ms de retardo, y cerrar de golpe se comería el
     último trazo. */
  await p.tinta?.guardar().catch(() => {});
  // Después del await se vuelve a buscar: la lista pudo cambiar en el medio.
  const i = pestanas.indexOf(p);
  if (i < 0) return false;
  const docAntes = pestanas[activa]?.doc ?? null;
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
  /* 'documento' solo si de verdad cambió lo que se mira. Cerrar una pestaña
     de fondo lo emitía igual, y Páginas lo tomaba como otro documento: tiraba
     los cambios sin guardar; el lector borraba la búsqueda y volvía a pintar
     todas sus hojas. */
  if ((pestanas[activa]?.doc ?? null) !== docAntes) emitir('documento');
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

/**
 * En qué lugar de la franja estaba la activa. Es lo que rutasAbiertas() pierde
 * al ponerla primera, y hace falta para que el orden en que acomodaste las
 * pestañas sobreviva a cerrar la app. Se cuenta sobre las que TIENEN ruta,
 * que son las únicas que se van a restaurar: un documento sin ruta delante de
 * la activa no va a estar en la próxima sesión para ocupar su lugar.
 */
export function posicionActiva() {
  return pestanas.slice(0, activa).filter((p) => p.doc?.ruta).length;
}

/** Carga la lista de impresoras y elige una si todavía no hay. */
export async function cargarImpresoras({ refrescar = false } = {}) {
  /* El refresco va ADENTRO de listar: antes se pedían las capacidades frescas
     después de listar con las viejas, y el resultado se tiraba. «Releer
     impresoras» necesitaba dos clics para ver una impresora nueva. */
  S.impresoras = await api.print.listar({ refrescar });

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
