/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — dibujar sobre una página
   Cablea los canvas de tinta encima de un pliego del lector: lee el stylus,
   suaviza el camino y guarda el trazo en coordenadas de página.

   La entrada y el suavizado vienen de Scrawl (stroke.js) sin tocar. Lo que
   agrega este archivo es la traducción a coordenadas de página PDF y el
   redibujado.

   ── Tres canvas por pliego, y ninguno reservado de más ─────────────────────
   · `.qr-tinta-resaltador`, abajo: los resaltadores. La hoja lo mezcla con
     multiply, así que la letra negra sigue negra debajo del amarillo
     (tinta-07).
   · `.qr-tinta`: lo confirmado de las demás herramientas. Es el que recibe el
     puntero (StrokeInput escucha acá).
   · `.qr-tinta-viva`, arriba: solo el trazo en curso y el anillo de la punta.
     En cada cuadro se borra y se pinta ESE trazo; lo confirmado no se toca
     mientras se dibuja (tinta-10). Antes el trazo en curso se pintaba entero
     encima de sí mismo en cada cuadro —el borde se iba engrosando y al
     levantar el lápiz adelgazaba de golpe—, y con el resaltador se rehacía la
     página entera en cada cuadro.
   Cada bitmap se reserva recién cuando hace falta: el de los resaltadores si
   la hoja tiene alguno, el de lo confirmado si tiene otra cosa, y el vivo
   mientras la punta anda por la hoja. En modo lectura, una hoja sin tinta no
   pesa nada (lector-23): antes cada hoja pintada reservaba un segundo lienzo
   del tamaño del suyo aunque no tuviera un solo trazo.
   ═══════════════════════════════════════════════════════════════════════════ */

import { StrokeInput, StrokePath } from './stroke.js';
import { dibujarTrazos, caminoDe, esResaltador, HERRAMIENTAS } from './capa.js';
import { pathDeTrazo } from './contorno.js';

/* ── El tope del bitmap ───────────────────────────────────────────────────
   El lector pide el viewport a escala × dpr, y el zoom llega a 8: una A4 a
   600 % con dpr 1,25 son unos 28 Mpx, más de 100 MB por canvas, y la tinta
   lleva uno por hoja de la ventana de precarga (lector-22). Mismo tope que el
   maxCanvasPixels del visor de pdf.js: 2^25 px. Pasado eso el bitmap se
   achica en proporción y el tamaño en pantalla no cambia —lo pone el CSS—, así
   que a zoom extremo la tinta se ve apenas más suave, igual que la hoja. */
export const MAX_PIXELES = 2 ** 25;

/* El fundido de lo que no hace el lápiz (deshacer, rehacer, borrar): t-2 y
   la curva de los relevos, que baja pareja (motion-timing). Son los tokens de
   motion.css; acá van en números porque el editor anima con la API. */
const FUNDIDO_MS = 180;
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)';

/* Si en esta sesión ya apareció un lápiz, un toque de dedo sobre la hoja es
   la palma apoyada, no alguien que quiere dibujar (tinta-23). Es de todo el
   módulo y no de cada editor: el lápiz que se vio en la página 3 es el mismo
   que va a escribir en la 4. */
let vistoLapiz = false;

/* El mismo chequeo que reducido() en motion.js, que no lo exporta. */
const reducido = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLCanvasElement} canvas   el `.qr-tinta`: lo confirmado, y el que escucha
 * @param {object} opciones
 *   pagina, capa, viewport, herramienta() → {id, color, ancho, opacidad, sensible}
 *   onCambio(), activo() → boolean
 *   resaltador, viva                opcionales: los otros dos canvas del pliego.
 *                                   Sin ellos se buscan entre los hermanos de
 *                                   `canvas` por su clase, y si no están se crean.
 *   goma() → {id, ancho}            opcional: la goma del lápiz (el otro extremo).
 *                                   Sin ella, el ancho del borrador de HERRAMIENTAS.
 *   onPan({ fase, x, y })           opcional: el botón lateral del lápiz o el del
 *                                   medio arrastran. fase 'empezar' | 'mover' |
 *                                   'terminar'; x, y en px de la ventana (client).
 *                                   Sin él, esos botones no hacen nada.
 * @returns {{ redibujar(), actualizar(viewport), fundir(cambio), reposo(),
 *             destruir(), readonly vivo: boolean, readonly viewport }}
 */
export function cablearTinta(canvas, opciones) {
  const { pagina, capa, viewport, herramienta, goma, onCambio, onPan, activo } = opciones;

  /* Los otros dos canvas van pegados a este: el de los resaltadores antes
     (debajo) y el vivo después (encima). */
  function hermano(clase, antes) {
    const padre = canvas.parentElement;
    const hay = padre?.querySelector(`:scope > canvas.${clase}`);
    if (hay) return hay;
    const c = document.createElement('canvas');
    c.className = clase;
    c.width = 0;
    c.height = 0;
    if (padre) { if (antes) canvas.before(c); else canvas.after(c); }
    return c;
  }
  const capas = {
    resaltador: opciones.resaltador ?? hermano('qr-tinta-resaltador', true),
    tinta: canvas,
  };
  const viva = opciones.viva ?? hermano('qr-tinta-viva', false);
  const ctxDe = new Map([capas.resaltador, capas.tinta, viva].map((c) => [c, c.getContext('2d')]));

  let vp = viewport;
  let k = 1;               // px del bitmap por px del viewport: < 1 solo pasado el tope

  /* El bitmap mide el viewport (con el tope), pero el tamaño EN PANTALLA no
     se escribe acá: lo pone `.qr-tinta { width: 100%; height: 100% }`, o sea
     el pliego. Antes se escribía en línea, le ganaba al CSS, y al cambiar el
     zoom la hoja se estiraba enseguida mientras la tinta se quedaba con la
     caja vieja, clavada arriba a la izquierda, hasta que terminaba el render
     (tinta-02). Al 100 % del pliego, la tinta se estira junto con el bitmap
     viejo de la hoja y las dos se ven igual de borrosas un instante.
     Se limpia por si el canvas es un clon de uno cableado por una versión
     vieja: cloneNode copia el atributo style. */
  for (const c of [capas.resaltador, capas.tinta, viva]) { c.style.width = ''; c.style.height = ''; }

  function medir() {
    const area = vp.width * vp.height;
    k = area > MAX_PIXELES ? Math.sqrt(MAX_PIXELES / area) : 1;
  }
  const anchoBitmap = () => Math.max(1, Math.round(vp.width * k));
  const altoBitmap = () => Math.max(1, Math.round(vp.height * k));

  /** Reserva (o suelta, con `hace` en false) el bitmap de un canvas. Devuelve si cambió. */
  function reservar(c, hace) {
    const w = hace ? anchoBitmap() : 0;
    const h = hace ? altoBitmap() : 0;
    if (c.width === w && c.height === h) return false;
    c.width = w;
    c.height = h;
    return true;
  }
  medir();

  let vivo = true;         // destruir() lo apaga: un editor muerto no acepta trazos
  let enCurso = null;      // { puntos, herramienta… } mientras la punta toca
  let anillo = null;       // { pt, h }: dónde está la punta en el aire, y con qué
  let frame = null;
  let sucio = false;       // la goma recortó algo y la página hay que rehacerla
  let paneo = false;       // el gesto en curso es un desplazamiento, no tinta
  let ultimoCrudo = null;  // el último punto tal cual llegó, sin suavizar

  /* Mientras llega algo fundiéndose (deshacer un borrado, rehacer un trazo),
     la base no lo dibuja todavía: lo trae su calco. `sin` son los ids que la
     base se saltea y `mas` lo que dibuja aunque ya no esté en la capa (los
     pedazos de la goma). Ver fundir(). */
  let base = null;
  const calcos = new Set();

  function trazosDeLaBase() {
    const todos = capa.trazos(pagina);
    if (!base) return todos;
    const quedan = todos.filter((t) => !base.sin.has(t.id));
    const ids = new Set(quedan.map((t) => t.id));
    return [...quedan, ...base.mas.filter((t) => !ids.has(t.id))];
  }

  /** Redibuja lo confirmado: cada capa, solo si tiene algo (si no, suelta su bitmap). */
  const redibujar = () => {
    const lista = trazosDeLaBase();
    for (const tipo of ['resaltador', 'tinta']) {
      const c = capas[tipo];
      const hay = lista.some((t) => esResaltador(t) === (tipo === 'resaltador'));
      reservar(c, hay);
      if (hay) dibujarTrazos(ctxDe.get(c), lista, vp, { dpr: k, solo: tipo });
    }
    if (enCurso || anillo) pintarViva();
  };

  /* Un trazo recién confirmado se pinta solo, encima de su capa: es el último
     de la lista, así que el orden de apilado queda igual que redibujando todo.
     Si esa capa todavía no tenía bitmap (el primer trazo de la hoja), se
     reserva y ahí sí se pinta entera, que es ese trazo solo. */
  function confirmar(t) {
    const c = capas[esResaltador(t) ? 'resaltador' : 'tinta'];
    if (base || reservar(c, true)) { redibujar(); return; }
    const ctx = ctxDe.get(c);
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.transform(...vp.transform);
    const p = caminoDe(t);
    if (p) { ctx.globalAlpha = t.opacidad ?? 1; ctx.fillStyle = t.color || '#000'; ctx.fill(p); }
    ctx.restore();
  }

  /* ── El canvas vivo ────────────────────────────────────────────────────── */

  function pintarViva() {
    const vctx = ctxDe.get(viva);
    const algo = (enCurso && enCurso.puntos.length) || anillo;
    if (!algo) {
      if (viva.width) { vctx.setTransform(1, 0, 0, 1, 0, 0); vctx.clearRect(0, 0, viva.width, viva.height); }
      return;
    }
    reservar(viva, true);
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, viva.width, viva.height);
    if (enCurso) {
      /* El resaltador en curso también va con multiply, como va a quedar:
         lo dice el atributo, que el CSS lee. */
      viva.dataset.herramienta = enCurso.herramienta;
      const d = pathDeTrazo(enCurso);
      if (!d) return;
      vctx.save();
      vctx.setTransform(k, 0, 0, k, 0, 0);
      vctx.transform(...vp.transform);
      vctx.globalAlpha = enCurso.opacidad ?? 1;
      vctx.fillStyle = enCurso.color;
      vctx.fill(new Path2D(d));
      vctx.restore();
      return;
    }
    pintarAnillo(vctx);
  }

  /* ── El anillo de la punta (tinta-21) ─────────────────────────────────────
     Con la punta en el aire, el cursor era la misma cruz para todo: con el
     borrador en 16 o en 48 no se sabía qué iba a borrar hasta que borraba.
     Ahora el borrador muestra un anillo del tamaño de la goma (blanco por
     fuera y oscuro por dentro, así se ve sobre el papel y sobre la letra), y
     las demás herramientas un punto de su color y su grosor. */
  function pintarAnillo(vctx) {
    const { pt, h } = anillo;
    const r = canvas.getBoundingClientRect();
    const f = r.width > 0 ? viva.width / r.width : 1;   // px del bitmap por px CSS
    const [px, py] = aPagina(pt);
    const [vx, vy] = vp.convertToViewportPoint(px, py);
    const x = vx * k;
    const y = vy * k;
    const radio = ((h.ancho || 1) / 2) * Math.abs(vp.scale) * k;
    vctx.save();
    if (h.id === 'borrador') {
      viva.dataset.herramienta = 'borrador';
      vctx.beginPath();
      vctx.arc(x, y, Math.max(radio, 2 * f), 0, Math.PI * 2);
      vctx.lineWidth = 3 * f;
      vctx.strokeStyle = 'rgba(255, 255, 255, .9)';
      vctx.stroke();
      vctx.lineWidth = 1.25 * f;
      vctx.strokeStyle = 'rgba(0, 0, 0, .62)';
      vctx.stroke();
    } else {
      viva.dataset.herramienta = h.id;
      vctx.beginPath();
      vctx.arc(x, y, Math.max(radio, 1.5 * f), 0, Math.PI * 2);
      vctx.globalAlpha = h.opacidad ?? 1;
      vctx.fillStyle = h.color || '#000';
      vctx.fill();
    }
    vctx.restore();
  }

  /** Suelta el bitmap vivo cuando la punta se fue de la hoja. */
  function soltarViva() {
    anillo = null;
    if (enCurso) return;
    reservar(viva, false);
    delete viva.dataset.herramienta;
  }

  /** Un frame por movimiento, no un redibujado por punto coalescido. */
  function invalidar() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!vivo) return;
      /* La goma rehace lo confirmado una vez por cuadro, no una por cada
         punto coalescido que recortó algo: con tablet llegan 3 a 5 por
         cuadro, y cada redibujo pinta todos los contornos (tinta-11). */
      if (sucio) { sucio = false; redibujar(); return; }
      /* El trazo en curso y el anillo viven en el canvas de arriba: lo
         confirmado no se toca mientras se dibuja (tinta-10). */
      pintarViva();
    });
  }

  /** Si quedó un redibujo de la goma esperando el cuadro, va ya. */
  function asentar() {
    if (!sucio) return;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    sucio = false;
    redibujar();
  }

  /* De píxeles CSS del canvas a coordenadas de página. Es lo que hace que un
     trazo hecho al 150% de zoom caiga en el mismo lugar del papel que uno
     hecho al 60%, y que la página rotada no descoloque nada.

     La proporción sale de lo que el canvas mide EN PANTALLA contra el
     viewport, no del devicePixelRatio. Son lo mismo solo si la caja coincide
     con el viewport, y desde tinta-02 no siempre: entre un zoom y el viewport
     nuevo el canvas ya mide lo del pliego nuevo y el viewport sigue siendo el
     viejo. Con la proporción real, lo que se dibuja en ese rato cae donde se
     ve la tinta estirada, que es donde se lo está viendo. */
  function escalaCss() {
    const r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return [vp.width / r.width, vp.height / r.height, r];
    const dpr = window.devicePixelRatio || 1;
    return [dpr, dpr, r];
  }

  const aPagina = (pt) => {
    const [sx, sy] = escalaCss();
    const [x, y] = vp.convertToPdfPoint(pt.x * sx, pt.y * sy);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, pt.p];
  };

  /** Al revés: de un punto de página a px CSS del canvas, con la caja de ahora. */
  const aCss = ([x, y, p]) => {
    const [sx, sy] = escalaCss();
    const [vx, vy] = vp.convertToViewportPoint(x, y);
    return { x: vx / sx, y: vy / sy, p };
  };

  /** Un punto de StrokeInput (relativo al canvas) en px de la ventana. */
  const aCliente = (pt) => {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + pt.x, y: r.top + pt.y };
  };

  /* ── La rueda tiene que seguir scrolleando el documento ───────────────────
     StrokeInput escucha `wheel` y hace `preventDefault()` SIEMPRE: en Scrawl
     la rueda hace zoom del lienzo, así que ahí corresponde. Acá el canvas está
     encima de la página, y con el modo de anotación activo se comía el scroll
     — la rueda dejaba de mover el documento.

     Como stroke.js vino de Scrawl sin cambios y así se queda, se lo ataja
     antes: un listener en fase de CAPTURA corre primero y, cuando el gesto es
     un scroll normal, corta la cadena con stopImmediatePropagation(). El
     listener de StrokeInput no llega a ejecutarse, nadie cancela el evento, y
     el navegador scrollea como siempre.

     Con Ctrl apretado NO se corta: ahí sí queremos que el preventDefault ocurra
     (para que el navegador no haga su propio zoom) y que el evento suba hasta
     el visor, que lo convierte en zoom del documento. */
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) e.stopImmediatePropagation();
  }, { capture: true, passive: true });

  /* ── La palma no le gana al lápiz ─────────────────────────────────────────
     StrokeInput toma el PRIMER puntero que llega, de cualquier tipo, y mientras
     dura ignora a los demás. En una pantalla táctil, apoyar la mano dejaba una
     mancha y el lápiz no escribía hasta levantarla (tinta-23). Ignorar el toque
     en begin() no alcanza: para entonces StrokeInput ya se quedó con el
     puntero. Se corta antes, con el mismo truco de la rueda: en captura, y
     solo anotando y después de haber visto un lápiz; un 2 en 1 sin lápiz sigue
     pudiendo dibujar con el dedo. */
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') vistoLapiz = true;
    else if (e.pointerType === 'touch' && vistoLapiz && vivo && activo()) e.stopImmediatePropagation();
  }, { capture: true });

  const camino = new StrokePath(() => {});
  let ultimoBorrado = null;

  /** La goma del otro extremo del lápiz: la del borrador, no la herramienta activa. */
  const gomaDelLapiz = () => goma?.() ?? { id: 'borrador', ancho: HERRAMIENTAS.borrador.ancho };

  const entrada = new StrokeInput(canvas, {
    begin(pt, mods) {
      if (!vivo || !activo()) return;

      /* El botón lateral del lápiz o la rueda del mouse no dibujan: desplazan,
         si el lector se ofreció a hacerlo (tinta-15). El lateral cuenta solo
         con pointerType 'pen': el botón derecho del mouse prende el mismo bit
         de `buttons` y no tiene por qué arrastrar la hoja. */
      if (onPan && (mods.middle || (mods.barrel && pt.type === 'pen'))) {
        paneo = true;
        onPan({ fase: 'empezar', ...aCliente(pt) });
        return;
      }
      /* Cualquier otro botón que no sea el principal se ignora: un clic
         derecho dejaba un punto y arrastrarlo, una raya. La goma llega con
         button 5, y esa sí borra. */
      if (mods.button > 0 && !mods.eraser) return;

      const h = herramienta();

      // La goma del stylus borra sin cambiar de herramienta en la barra.
      if (h.id === 'borrador' || mods.eraser) {
        /* Con el ancho del borrador, no con el de la herramienta elegida: con
           la pluma, la goma del lápiz tenía 0,9 pt de radio y había que pasar
           justo por encima de cada línea (tinta-05). */
        ultimoBorrado = h.id === 'borrador' ? h : gomaDelLapiz();
        // Toda la pasada de la goma es UN deshacer: ver borrarEn() en capa.js.
        capa.empezarBorrado();
        borrarEn(pt, ultimoBorrado);
        return;
      }

      anillo = null;
      enCurso = {
        herramienta: h.id,
        color: h.color,
        ancho: h.ancho,
        opacidad: h.opacidad ?? 1,
        puntos: [aPagina(pt)],
      };
      ultimoCrudo = pt;
      camino.begin(pt, 0.35);
      invalidar();
    },

    move(pt) {
      if (paneo) { onPan?.({ fase: 'mover', ...aCliente(pt) }); return; }
      if (!vivo || !activo()) return;
      if (ultimoBorrado) { borrarEn(pt, ultimoBorrado); return; }
      if (!enCurso) return;

      /* El suavizado de Scrawl emite puntos ya filtrados; se toma el último
         estado del camino en vez del punto crudo para que el trazo no tiemble
         con el jitter de la tablet. El crudo se guarda igual: es el que cierra
         el trazo (ver cerrarTrazo). */
      ultimoCrudo = pt;
      camino.push(pt);
      const s = camino.pts[camino.pts.length - 1];
      enCurso.puntos.push(aPagina({ x: s.x, y: s.y, p: s.p }));
      invalidar();
    },

    end() {
      if (paneo) { paneo = false; onPan?.({ fase: 'terminar' }); return; }
      if (!vivo) return;
      if (ultimoBorrado) { terminarGoma(); onCambio?.(); return; }
      if (!enCurso) return;
      cerrarTrazo();
      onCambio?.();
    },

    /* La punta en el aire: el anillo la sigue, un cuadro a la vez. */
    hover(pt, mods) {
      if (!vivo || !activo()) { if (anillo) soltarViva(); return; }
      const h = mods.eraser ? gomaDelLapiz() : herramienta();
      anillo = { pt, h };
      invalidar();
    },

    leave() {
      if (!anillo && !viva.width) return;
      soltarViva();
    },
  });

  /* El filtro va unos 0,5 eventos detrás de la punta, y StrokeInput no trae
     el punto del pointerup: sin esto, los remates de las letras y las flechas
     rápidas quedaban 1 a 4 px cortos de donde se levantó el lápiz (tinta-22).
     El último punto crudo entra al final, con la presión suavizada —la cruda
     al despegar suele ser 0 y afinaría el remate de golpe—. */
  function cerrarTrazo() {
    const presion = camino.smooth?.p;
    camino.end();
    if (ultimoCrudo && enCurso.puntos.length) {
      const ult = aPagina({ x: ultimoCrudo.x, y: ultimoCrudo.y, p: presion ?? ultimoCrudo.p });
      const prev = enCurso.puntos[enCurso.puntos.length - 1];
      if (Math.hypot(ult[0] - prev[0], ult[1] - prev[1]) >= 0.01) enCurso.puntos.push(ult);
    }
    ultimoCrudo = null;
    const hecho = enCurso;
    enCurso = null;
    // Un trazo de un solo punto es un toque y vale; uno de cero, no.
    if (hecho.puntos.length) confirmar(capa.agregar(pagina, hecho));
    // Lo vivo se limpia en la misma tarea en que lo confirmado lo recibe: ningún cuadro ve los dos.
    if (frame) { cancelAnimationFrame(frame); frame = null; }
    pintarViva();
  }

  function terminarGoma() {
    ultimoBorrado = null;
    gomaAnterior = null;
    asentar();
    capa.terminarBorrado();
  }

  /* Por dónde pasó la goma la última vez, en coordenadas de página. La
     tablet entrega un punto cada tantos píxeles, y con una pasada rápida los
     círculos quedan separados: un trazo que cruce el hueco entre dos no se
     borra. Se rellena el camino de un punto al otro con círculos a medio
     radio, así la goma borra una franja continua como en el papel. */
  let gomaAnterior = null;

  function borrarEn(pt, h) {
    const [x, y] = aPagina(pt);
    const radio = (h.ancho || 16) / 2;
    let hubo = false;

    if (gomaAnterior) {
      const [x0, y0] = gomaAnterior;
      const pasos = Math.ceil(Math.hypot(x - x0, y - y0) / (radio / 2));
      for (let i = 1; i < pasos; i++) {
        const t = i / pasos;
        if (capa.borrarEn(pagina, x0 + (x - x0) * t, y0 + (y - y0) * t, radio)) hubo = true;
      }
    }
    if (capa.borrarEn(pagina, x, y, radio)) hubo = true;
    gomaAnterior = [x, y];
    // El anillo acompaña a la goma mientras borra.
    anillo = { pt, h };
    // El redibujo espera al cuadro: ver invalidar().
    if (hubo) sucio = true;
    invalidar();
  }

  /* ── Lo que cambia sin el lápiz se funde (tinta-13, lector-33) ────────────
     Deshacer, rehacer y borrar redibujaban en seco: el trazo desaparecía de
     un cuadro al otro, y al confirmar «Borrar toda la tinta» las anotaciones
     de la hoja se iban de golpe mientras el cartel todavía se esfumaba.
     Ahora lo que se va pasa a un calco —un canvas con la misma caja, pegado a
     su capa— que se esfuma en t-2 con la curva de los relevos, y la base se
     redibuja sin eso en la misma tarea. Lo que llega entra en otro calco que
     se funde, y la base lo suma recién cuando terminó: en ningún cuadro hay
     dos copias.

     La goma es un caso aparte: deshacerla devuelve los trazos ENTEROS donde
     hoy hay pedazos. Fundir el original entero encima de los pedazos
     doblaría la tinta (y el resaltador, que es transparente, se oscurecería
     donde se pisan). Por eso `debajo`: los pedazos se quedan en la base todo
     el fundido, y al calco se le recortan con destination-out, así lo único
     que se funde es el tramo que la goma se había comido. */
  function calco(tipo, trazos, debajo) {
    const capaEl = capas[tipo];
    const c = document.createElement('canvas');
    c.className = `qr-tinta-calco qr-tinta-calco--${tipo}`;
    c.width = anchoBitmap();
    c.height = altoBitmap();
    const ctx = c.getContext('2d');
    dibujarTrazos(ctx, trazos, vp, { dpr: k, solo: tipo });
    if (debajo.length) {
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.transform(...vp.transform);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      for (const t of debajo) { const p = caminoDe(t); if (p) ctx.fill(p); }
      ctx.restore();
    }
    /* Pegado a su capa: el nuevo queda DEBAJO de otro calco que todavía se
       esté yendo, no encima (motion-timing: un calco opaco nuevo encima de
       otro tapa de golpe lo que se iba). */
    if (capaEl.parentElement) capaEl.after(c);
    calcos.add(c);
    return c;
  }

  /* El calco va de `de` a `a` en t-2. `parte` acorta la duración cuando
     arranca a mitad de camino (un fundido que se da vuelta, ver fundir()):
     la velocidad es la de siempre, no un fundido entero para medio recorrido. */
  function animar(c, de, a, alTerminar, parte = 1) {
    const ms = Math.max(60, Math.round(FUNDIDO_MS * parte));
    let listo = false;
    const fin = () => {
      if (listo) return;
      listo = true;
      clearTimeout(red);
      alTerminar();
    };
    c.__anim = typeof c.animate === 'function'
      ? c.animate([{ opacity: de }, { opacity: a }], { duration: ms, easing: EASE_BOTH, fill: 'both' })
      : null;
    c.__anim?.finished.then(fin, () => {});
    // Red: una ventana que no pinta no corre animaciones.
    const red = setTimeout(fin, ms + 200);
    // Para darlo vuelta sin que el final viejo se dispare igual.
    c.__parar = () => { listo = true; clearTimeout(red); c.__anim?.cancel(); };
  }

  function sacarCalco(c) {
    calcos.delete(c);
    c.__parar?.();
    c.remove();
    c.width = 0;
    c.height = 0;
  }

  /* Lo que la base se saltea (`sin`) y lo que dibuja aunque ya no esté en la
     capa (`mas`, los pedazos de la goma) sale de los calcos que todavía
     entran: cada uno lleva sus ids y sus pedazos. */
  function ponerBase() {
    const sin = new Set();
    const mas = new Map();
    for (const c of calcos) {
      if (!c.__entra) continue;
      for (const id of c.__ids) sin.add(id);
      for (const t of c.__mas) mas.set(t.id, t);
    }
    base = sin.size || mas.size ? { sin, mas: [...mas.values()] } : null;
  }

  /* Un calco que entra terminó: la base suma lo que traía y el calco se va en
     la MISMA tarea, así el cuadro siguiente es la misma imagen, ya sin él. */
  function llego(c) {
    if (!calcos.has(c)) return;
    sacarCalco(c);
    ponerBase();
    redibujar();
  }

  /* Un fundido que se da vuelta: sigue desde la opacidad que tiene ahora
     hacia el otro lado. */
  function invertir(c, mas) {
    const op = Number(getComputedStyle(c).opacity);
    c.__parar?.();
    c.__entra = !c.__entra;
    c.__mas = c.__entra ? mas : [];
    const a = c.__entra ? 1 : 0;
    const de = Number.isFinite(op) ? op : 1 - a;
    animar(c, de, a, c.__entra ? () => llego(c) : () => sacarCalco(c), Math.abs(a - de));
  }

  /* Varios fundidos seguidos (Ctrl+Z o Ctrl+Y con la tecla sostenida, que
     repite cada ~30 ms) se SUMAN. Antes cada fundir() nuevo cortaba en seco lo
     que estaba entrando y la base lo dibujaba entero en ese cuadro: cada
     deshacer de un borrado o rehacer de un trazo aparecía de golpe, justo lo
     que tinta-13 venía a sacar (revisión del paquete 3A). Ahora lo que entra
     termina su fundido, y la base se saltea lo de todos los calcos que todavía
     entran.

     Y lo que vuelve sobre un fundido que todavía corre lo da vuelta: rehacer
     un trazo que se estaba yendo (o deshacer uno que estaba llegando) ya no
     pone un calco nuevo desde 1 o desde 0 encima del viejo, que saltaba desde
     su opacidad de ese momento; el mismo calco sigue desde donde estaba hacia
     el otro lado. Pasa solo si el calco lleva exactamente esos trazos, que es
     lo que da el historial (el Ctrl+Y rehace lo que deshizo el Ctrl+Z).

     Con prefers-reduced-motion no hay calcos: se redibuja en seco, como hace
     motion.js con reducido(). */
  function fundir({ salen = [], entran = [], debajo = [] } = {}) {
    if (!vivo) return [];
    if (reducido()) { cortarFundidos(); redibujar(); return []; }
    const hechos = [];
    const sal = new Set(salen.map((t) => t.id));
    const ent = new Set(entran.map((t) => t.id));
    for (const c of [...calcos]) {
      const contra = c.__entra ? sal : ent;
      if (!c.__ids.size || ![...c.__ids].every((id) => contra.has(id))) continue;
      for (const id of c.__ids) contra.delete(id);
      invertir(c, debajo.filter((t) => esResaltador(t) === (c.__tipo === 'resaltador')));
      hechos.push(c);
    }
    for (const tipo of ['resaltador', 'tinta']) {
      const deTipo = (lista) => lista.filter((t) => esResaltador(t) === (tipo === 'resaltador'));
      const sl = deTipo(salen).filter((t) => sal.has(t.id));
      const en = deTipo(entran).filter((t) => ent.has(t.id));
      const deb = deTipo(debajo);
      if (sl.length) {
        const c = calco(tipo, sl, deb);
        Object.assign(c, { __tipo: tipo, __ids: new Set(sl.map((t) => t.id)), __entra: false, __mas: [] });
        animar(c, 1, 0, () => sacarCalco(c));
        hechos.push(c);
      }
      if (en.length) {
        const c = calco(tipo, en, deb);
        Object.assign(c, { __tipo: tipo, __ids: new Set(en.map((t) => t.id)), __entra: true, __mas: deb });
        animar(c, 0, 1, () => llego(c));
        hechos.push(c);
      }
    }
    /* La base espera solo lo que llega. Si solo se van cosas (y los pedazos
       de `debajo` ya están en la capa), se redibuja como está. */
    ponerBase();
    redibujar();
    return hechos;
  }

  /** Termina en seco todo fundido en curso (zoom, giro, destruir). */
  function cortarFundidos() {
    for (const c of [...calcos]) sacarCalco(c);
    base = null;
  }

  redibujar();

  return {
    /** Redibuja lo confirmado con lo que tiene la capa ahora, en seco. */
    redibujar() { if (vivo) { cortarFundidos(); redibujar(); } },

    /**
     * El zoom o el giro cambiaron: el mismo editor sigue, con el viewport
     * nuevo (tinta-04). Los bitmaps se rehacen al tamaño nuevo y se redibujan
     * en la misma tarea, así que no hay cuadro en blanco. Un trazo en curso
     * sigue valiendo: sus puntos están en coordenadas de página. Lo que no
     * sigue valiendo es el estado del suavizado, que está en px CSS de la caja
     * vieja: se vuelve a sembrar desde el último punto, medido con la caja de
     * ahora.
     */
    actualizar(viewport) {
      if (!vivo || !viewport) return;
      cortarFundidos();
      vp = viewport;
      medir();
      if (enCurso?.puntos.length) {
        camino.begin(aCss(enCurso.puntos[enCurso.puntos.length - 1]), 0.35);
        ultimoCrudo = null;
      }
      if (viva.width) reservar(viva, true);
      redibujar();
    },

    fundir,

    /** La tinta se apagó: el anillo se va y el bitmap vivo se suelta. */
    reposo() {
      if (!vivo || enCurso) return;
      soltarViva();
    },

    destruir() {
      if (!vivo) return;
      /* Desde acá el editor no acepta nada. StrokeInput no expone un destroy y
         sus listeners siguen sobre el canvas hasta que el lector lo reemplaza
         por un clon. */
      vivo = false;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      cortarFundidos();
      if (paneo) { paneo = false; onPan?.({ fase: 'terminar' }); }
      if (ultimoBorrado) {
        ultimoBorrado = null;
        gomaAnterior = null;
        sucio = false;
        capa.terminarBorrado();
      }
      /* Un trazo a medio hacer no se tira: se guarda con lo que tenga. Pasaba
         cuando el lector rehacía el editor con la punta apoyada (tinta-04);
         ahora el lector lo conserva al hacer zoom, pero la hoja todavía se
         puede ir de la precarga en medio de un trazo. */
      if (enCurso?.puntos.length) {
        cerrarTrazo();
        onCambio?.();
      }
      enCurso = null;
      ultimoCrudo = null;
      anillo = null;
      reservar(viva, false);
      void entrada;
    },

    get vivo() { return vivo; },
    /** El viewport con el que está medido: el lector lo compara antes de actualizar. */
    get viewport() { return vp; },
  };
}
