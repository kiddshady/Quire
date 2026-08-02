/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — estado
   El documento abierto vive acá y no adentro de una vista, porque el router
   repinta las vistas enteras: si el PDF colgara de la vista del lector, ir a
   Imprimir y volver lo cerraría y lo reabriría.

   Quien necesite enterarse de un cambio se suscribe con alCambiar(). Las
   vistas se desuscriben solas vía Router.onLeave.
   ═══════════════════════════════════════════════════════════════════════════ */

import { abrirDocumento } from './pdf/documento.js';
import { CapaDeTinta } from './tinta/capa.js';

const api = window.onyx;

export const S = {
  /** @type {import('./pdf/documento.js').Documento | null} */
  doc: null,
  geometrias: [],
  esquema: [],
  metadatos: null,

  /* Vista */
  pagina: 1,
  zoom: 1,
  modoZoom: 'ancho',      // 'ancho' | 'pagina' | 'fijo'
  rotacion: 0,            // 0 | 90 | 180 | 270, aplicada sobre todas las páginas

  /* Impresión */
  impresoras: [],
  impresora: null,        // el nombre de la elegida
  /* El plan de imposición vivo. Sobrevive a navegar entre vistas: perder la
     configuración de un folleto por ir a mirar una página sería hostil. */
  plan: null,

  /** @type {import('./tinta/capa.js').CapaDeTinta | null} */
  tinta: null,

  info: null,
  settings: {},
  cargando: false,
};

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

/**
 * Abre un PDF ya leído del disco ({ruta, nombre, bytes, tamano}).
 * Cierra el anterior: dos documentos abiertos serían dos workers de pdf.js
 * vivos y el doble de memoria, sin que nada en la UI los muestre a los dos.
 */
export async function abrir(archivo) {
  S.cargando = true;
  emitir('cargando');
  try {
    const doc = await abrirDocumento(archivo.bytes, {
      nombre: archivo.nombre,
      ruta: archivo.ruta,
      tamano: archivo.tamano,
    });

    // Lo que quedó sin guardar del documento anterior se escribe antes de soltarlo.
    await S.tinta?.guardar().catch(() => {});
    S.doc?.destruir();
    S.doc = doc;
    S.pagina = 1;
    S.rotacion = 0;
    S.geometrias = await doc.geometrias();
    S.esquema = await doc.esquema();
    S.metadatos = await doc.metadatos();
    /* La tinta se busca por un hash de la ruta y el tamaño: reabrir el mismo
       PDF trae de vuelta lo anotado, sin que el archivo haya cambiado nunca. */
    S.tinta = await CapaDeTinta.cargar(doc).catch((err) => {
      console.error('[tinta] no se pudo cargar:', err.message);
      return new CapaDeTinta(doc);
    });
    S.tinta.onCambio = () => emitir('tinta');
    emitir('documento');
    return doc;
  } finally {
    S.cargando = false;
    emitir('cargando');
  }
}

export async function cerrar() {
  await S.tinta?.guardar().catch(() => {});
  S.doc?.destruir();
  S.doc = null;
  S.tinta = null;
  S.geometrias = [];
  S.esquema = [];
  S.metadatos = null;
  S.pagina = 1;
  S.rotacion = 0;
  emitir('documento');
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
