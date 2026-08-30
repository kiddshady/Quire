/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el buscador
   Encontrar una palabra en el PDF. No hay OCR y no lo va a haber: si el
   archivo es un escaneo, acá no hay nada que buscar. La prueba es la misma que
   ve el usuario — si el texto se puede seleccionar con el mouse, se encuentra.

   pdf.js trae su propio buscador, pero vive en `web/`, la carpeta del visor de
   ejemplo, y lo que está vendorizado en renderer/vendor/pdfjs/ es solo el
   núcleo. Así que está escrito a mano, igual que la selección.

   ── Lo que hace difícil buscar en un PDF ────────────────────────────────────

   Un PDF no guarda párrafos: guarda fragmentos de texto con su posición. Tres
   cosas se rompen si uno los pega y busca ahí nomás:

   · Las LIGADURAS. "oficina" está guardado como "o" + "ﬁ" + "cina", con la
     "ﬁ" como UN glifo. Buscando "oficina" no aparece nunca.
   · Las TILDES y las MAYÚSCULAS. Nadie quiere escribir "compensación" con la
     tilde puesta para encontrarla.
   · Los RENGLONES. Los fragmentos se pegan sin nada en el medio, así que el
     final de una línea queda soldado al principio de la siguiente: "el estado"
     partido en dos renglones no se encuentra, y aparece un "estadoen" que en
     la hoja no existe. Y si la palabra venía cortada con guion —"compen-
     sación"— tampoco.

   La respuesta a las tres es plegar(): una versión del texto en minúsculas,
   sin tildes, con las ligaduras abiertas, los espacios colapsados y las
   palabras partidas vueltas a unir. Se busca sobre ESA, y un mapa dice de qué
   carácter del original salió cada uno de los plegados — que es lo que deja
   volver, del match, a las letras exactas que hay que resaltar en la hoja.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las marcas combinantes: la tilde de un texto ya descompuesto (a + ́ ). */
const MARCA = /\p{M}/u;
const MARCA_G = /\p{M}/gu;
const BLANCO = /\s/;

/* La tilde de la eñe, suelta, como viene en un texto ya descompuesto. */
const TILDE_N = '\u0303';

/**
 * Deja un texto listo para comparar, y dice de dónde salió cada carácter.
 *
 * Devuelve `{ plano, mapa }`: `plano` es el texto plegado y `mapa[i]` es el
 * índice, EN EL ORIGINAL, del carácter que produjo el i-ésimo del plegado.
 * Ese mapa es todo el asunto — sin él se sabría que hay una coincidencia pero
 * no sobre qué letras de la página pintarla.
 *
 * El recorrido es carácter por carácter y no una normalización de toda la
 * cadena a propósito: normalizando de una, "ﬁ" pasa a ser dos caracteres y
 * todo lo que viene después se corre un lugar, sin que nada avise de cuánto.
 */
export function plegar(texto) {
  let plano = '';
  const mapa = [];
  let hueco = -1;              // índice del espacio pendiente de emitir, o -1

  const emitir = (str, en) => {
    for (const ch of str) { plano += ch; mapa.push(en); }
  };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];

    /* Los espacios se colapsan a uno solo, y se emiten TARDE: recién cuando
       aparece algo después. Así no quedan espacios al principio ni al final,
       que son los que hacen que una consulta no matchee por un blanco de más
       que nadie ve. */
    if (BLANCO.test(c)) {
      const desde = i;
      let renglon = false;
      while (i < texto.length && BLANCO.test(texto[i])) {
        if (texto[i] === '\n' || texto[i] === '\r') renglon = true;
        i++;
      }
      i--;                     // el for lo vuelve a incrementar

      /* Palabra partida al final del renglón. "compen-\nsación" es UNA
         palabra y el guion no forma parte de ella: se lo saca y no se emite
         espacio, así "compensación" la encuentra entera. */
      if (renglon && plano.length > 1 && plano.endsWith('-')) {
        plano = plano.slice(0, -1);
        mapa.pop();
        hueco = -1;
        continue;
      }

      if (plano) hueco = desde;
      continue;
    }

    /* Una marca combinante suelta ya viajó pegada a su letra: la letra se
       emitió sin ella y emitirla aparte correría el mapa. */
    if (MARCA.test(c)) continue;

    // El guion blando es una sugerencia de corte invisible, no es texto.
    if (c === '­') continue;

    if (hueco >= 0) { emitir(' ', hueco); hueco = -1; }

    /* La eñe se salva de la poda, y las vocales no.

       Buscar sin tildes es lo que uno quiere: nadie escribe "compensación" con
       la tilde puesta para encontrarla. Pero la ñ no es una ene con un adorno,
       es otra letra del alfabeto — planchándola, "año" y "ano" pasan a ser la
       misma palabra, que es exactamente lo que no queremos.

       La segunda rama es para los PDF que la traen descompuesta (una ene y la
       tilde suelta atrás); a la tilde la descarta el filtro de marcas en la
       vuelta siguiente. */
    const bajo = c.toLowerCase();
    if (bajo === 'ñ' || (bajo === 'n' && texto[i + 1] === TILDE_N)) { emitir('ñ', i); continue; }

    /* NFKD abre las ligaduras ("ﬁ" → "fi") y separa la tilde de su letra, que
       el replace descarta. Un carácter puede rendir cero, uno o dos: por eso
       emitir() empuja al mapa una entrada por cada uno. */
    const plegado = c.normalize('NFKD').replace(MARCA_G, '').toLowerCase();
    if (plegado) emitir(plegado, i);
  }

  return { plano, mapa };
}

/**
 * Pliega lo que escribió el usuario.
 *
 * Los espacios de los BORDES se reponen a mano, y no es un detalle: plegar()
 * los tira —para eso está—, pero en una consulta significan algo. Buscando
 * "el " con el espacio puesto, uno quiere "el " y no "elefante".
 */
export function plegarConsulta(consulta) {
  const crudo = String(consulta ?? '');
  const { plano } = plegar(crudo);
  if (!plano) return '';
  return (/^\s/.test(crudo) ? ' ' : '') + plano + (/\s$/.test(crudo) ? ' ' : '');
}

/**
 * El índice de una página: su texto entero, el plegado, y dónde arranca cada
 * fragmento.
 *
 * El salto de renglón se mete DESPUÉS del fragmento que lo trae y queda fuera
 * de su largo. Los dos datos hacen falta y son distintos: el salto tiene que
 * estar en el texto para que plegar() sepa que ahí hay un corte de palabra,
 * pero no puede contarse como parte del fragmento, porque en el DOM de la capa
 * de texto no es un span sino un `<br>` — y los `<br>` no están en la lista de
 * spans sobre la que después se resalta.
 */
export function armarIndice(fragmentos) {
  let texto = '';
  const corte = [];
  const largo = [];

  for (const f of fragmentos) {
    corte.push(texto.length);
    largo.push(f.str.length);
    texto += f.str;
    if (f.salto) texto += '\n';
  }

  const { plano, mapa } = plegar(texto);
  return { texto, corte, largo, plano, mapa, fragmentos: fragmentos.length };
}

/**
 * Dónde está la aguja en el pajar, en coordenadas del texto ORIGINAL.
 *
 * `hasta` sale de `mapa[fin - 1] + 1` y no de `mapa[fin]`: si la coincidencia
 * termina a la mitad de una ligadura —buscar "of" adentro de "oﬁcina"— hay que
 * quedarse con el glifo entero, porque en la hoja es una sola letra y no se
 * puede resaltar la mitad.
 */
export function coincidencias({ plano, mapa }, aguja) {
  const salida = [];
  if (!aguja) return salida;

  let desde = 0;
  for (;;) {
    const at = plano.indexOf(aguja, desde);
    if (at === -1) break;
    salida.push({ desde: mapa[at], hasta: mapa[at + aguja.length - 1] + 1 });
    // Sin solapamiento: "aa" en "aaa" son una coincidencia, no dos.
    desde = at + aguja.length;
  }
  return salida;
}

/**
 * Parte un tramo del texto de la página en los fragmentos que lo cruzan.
 *
 * Devuelve `[{ i, a, b }]`: el fragmento número `i`, de su carácter `a` al `b`.
 * Es lo que necesita el lector para armar un Range sobre el span que le
 * corresponde y preguntarle al navegador dónde cae en pantalla.
 */
export function ubicar({ corte, largo }, desde, hasta) {
  const segmentos = [];
  for (let k = 0; k < corte.length; k++) {
    const a = corte[k];
    const b = a + largo[k];
    if (b <= a) continue;              // fragmento vacío: no hay nada que pintar
    if (b <= desde) continue;
    if (a >= hasta) break;
    segmentos.push({
      i: k,
      a: Math.max(0, desde - a),
      b: Math.min(largo[k], hasta - a),
    });
  }
  return segmentos;
}

/* Cuánto texto se muestra a cada lado de la coincidencia en la lista de
   resultados. Cuarenta y pico de caracteres es lo que entra en el ancho del
   panel sin que la fila pase de dos renglones. */
const AIRE = 42;

/** El renglón de contexto de un resultado, ya listo para mostrar. */
function contexto(texto, desde, hasta) {
  const a = Math.max(0, desde - AIRE);
  const b = Math.min(texto.length, hasta + AIRE);
  const limpiar = (s) => s.replace(/\s+/g, ' ');

  /* Cortando a tantos caracteres se corta a la mitad de una palabra. La de la
     izquierda se descarta entera; la de la derecha se deja, porque ahí el ojo
     ya venía leyendo y el "…" explica el final. */
  let antes = limpiar(texto.slice(a, desde));
  if (a > 0) antes = '…' + antes.replace(/^\S*\s?/, '');

  let despues = limpiar(texto.slice(hasta, b));
  if (b < texto.length) despues += '…';

  return { antes, medio: limpiar(texto.slice(desde, hasta)), despues };
}

/* Cuántos resultados se guardan CON su contexto. Buscar una sola letra en un
   tratado son cientos de miles de coincidencias, y guardarles a todas su
   renglón de texto es lo que hace que la app se quede sin memoria por un
   descuido de tipeo. Pasado el tope se siguen CONTANDO y se siguen resaltando
   en la hoja —eso pesa dos números por coincidencia—; lo que se deja de armar
   es la lista. Quien muestre esto tiene que decir que la recortó. */
const TOPE = 2000;

/**
 * El buscador de UN documento.
 *
 * El índice se arma por página y queda cacheado: la primera búsqueda de un
 * documento largo tarda lo que tarde leer su texto, las siguientes son
 * instantáneas. Por eso vive pegado al documento y no a la vista — volver a
 * una pestaña no tiene que volver a leer el libro entero.
 */
class Buscador {
  constructor(doc) {
    this.doc = doc;
    this._indices = new Map();      // nº de página → promesa del índice
    this._listos = new Map();       // nº de página → el índice ya resuelto

    this.consulta = '';
    /** [{ pagina, enPagina, desde, hasta, antes, medio, despues }] — hasta TOPE. */
    this.resultados = [];
    /** nº de página → [{ desde, hasta }]. Lo que se resalta en la hoja. */
    this.porPagina = new Map();
    this.total = 0;                 // coincidencias de verdad, sin tope
    this.leidas = 0;                // páginas ya recorridas (para el progreso)
    this.terminada = false;

    this._corrida = 0;
  }

  /** El tope existe y se alcanzó: la lista está recortada. */
  get recortada() { return this.total > this.resultados.length; }

  async indice(n) {
    if (!this._indices.has(n)) {
      this._indices.set(n, this.doc.fragmentos(n).then((f) => {
        const armado = armarIndice(f);
        this._listos.set(n, armado);
        return armado;
      }));
    }
    return this._indices.get(n);
  }

  /**
   * El índice de una página, solo si ya está leído.
   *
   * Existe para que resaltar sea SÍNCRONO. La versión con await funcionaba,
   * pero el resaltado se pinta cada vez que una página entra en pantalla, y
   * entre el await y su vuelta la página puede haberse ido: quedaban marcas
   * pintadas sobre una capa de texto que ya no era la de esa página. Cuando hay
   * resultados el índice SIEMPRE está leído —buscar es lo que lo leyó—, así que
   * no esperar no cuesta nada. */
  indiceListo(n) { return this._listos.get(n) || null; }

  cancelar() { this._corrida++; }

  /**
   * Recorre el documento entero.
   *
   * Va avisando por `alAvanzar` en vez de devolver todo al final: en un
   * documento de mil páginas, esperar a terminar para mostrar el primer
   * resultado se siente como que la app se colgó, cuando en realidad ya
   * encontró lo que buscabas en la página 3.
   */
  async buscar(consulta, { alAvanzar } = {}) {
    this._corrida++;
    const mia = this._corrida;

    const aguja = plegarConsulta(consulta);
    this.consulta = String(consulta ?? '');
    this.resultados = [];
    this.porPagina = new Map();
    this.total = 0;
    this.leidas = 0;
    this.terminada = false;

    if (!aguja) { this.terminada = true; alAvanzar?.(this); return this; }

    for (let n = 1; n <= this.doc.paginas; n++) {
      let indice;
      try {
        indice = await this.indice(n);
      } catch (err) {
        /* Una página cuyo texto no se puede leer no invalida las otras: se
           salta y se sigue. El documento entero no se cae por una. */
        console.error(`[buscador] página ${n}:`, err);
        this._indices.delete(n);
        if (this._corrida !== mia) return this;
        this.leidas = n;
        continue;
      }
      // Mientras se leía llegó otra consulta: esta ya no le importa a nadie.
      if (this._corrida !== mia) return this;

      const hits = coincidencias(indice, aguja);
      if (hits.length) {
        this.porPagina.set(n, hits);
        this.total += hits.length;
        for (let k = 0; k < hits.length; k++) {
          if (this.resultados.length >= TOPE) break;
          /* `enPagina` es el número de coincidencia DENTRO de su página. La
             lista es plana y el resaltado va por página: sin este número, para
             saber cuál de las cinco marcas de la hoja es la que estás mirando
             habría que contar hacia atrás desde el principio del documento. */
          this.resultados.push({
            pagina: n,
            enPagina: k,
            ...hits[k],
            ...contexto(indice.texto, hits[k].desde, hits[k].hasta),
          });
        }
      }
      this.leidas = n;

      /* Se avisa cuando hay algo nuevo que mostrar, y cada tanto aunque no lo
         haya: sin lo segundo, la barra de progreso se queda quieta en un
         documento donde las primeras cien páginas no tienen nada. */
      if (alAvanzar && (hits.length || n % 8 === 0 || n === this.doc.paginas)) alAvanzar(this);
    }

    this.terminada = true;
    alAvanzar?.(this);
    return this;
  }
}

/* Uno por documento, y colgado del documento: cerrar la pestaña se lleva el
   índice puesto sin que nadie tenga que acordarse de limpiarlo. */
const buscadores = new WeakMap();

/** El buscador de un documento, creándolo la primera vez. */
export function buscadorDe(doc) {
  if (!buscadores.has(doc)) buscadores.set(doc, new Buscador(doc));
  return buscadores.get(doc);
}

export { Buscador };
