/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — dibujar sobre una página
   Cablea un canvas de tinta encima de un pliego del lector: lee el stylus,
   suaviza el camino y guarda el trazo en coordenadas de página.

   La entrada y el suavizado vienen de Scrawl (stroke.js) sin tocar. Lo que
   agrega este archivo es la traducción a coordenadas de página PDF y el
   redibujado.
   ═══════════════════════════════════════════════════════════════════════════ */

import { StrokeInput, StrokePath } from './stroke.js';
import { dibujarTrazos, HERRAMIENTAS } from './capa.js';
import { pathDeTrazo } from './contorno.js';

/* ── El tope del bitmap ───────────────────────────────────────────────────
   El lector pide el viewport a escala × dpr, y el zoom llega a 8: una A4 a
   600 % con dpr 1,25 son unos 28 Mpx, más de 100 MB por canvas, y la tinta
   lleva uno por hoja de la ventana de precarga (lector-22). Mismo tope que el
   maxCanvasPixels del visor de pdf.js: 2^25 px. Pasado eso el bitmap se
   achica en proporción y el tamaño en pantalla no cambia —lo pone el CSS—, así
   que a zoom extremo la tinta se ve apenas más suave, igual que la hoja. */
export const MAX_PIXELES = 2 ** 25;

/* Si en esta sesión ya apareció un lápiz, un toque de dedo sobre la hoja es
   la palma apoyada, no alguien que quiere dibujar (tinta-23). Es de todo el
   módulo y no de cada editor: el lápiz que se vio en la página 3 es el mismo
   que va a escribir en la 4. */
let vistoLapiz = false;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opciones
 *   pagina, capa, viewport, herramienta() → {id, color, ancho, opacidad, sensible}
 *   onCambio(), activo() → boolean
 *   goma() → {id, ancho}            opcional: la goma del lápiz (el otro extremo).
 *                                   Sin ella, el ancho del borrador de HERRAMIENTAS.
 *   onPan({ fase, x, y })           opcional: el botón lateral del lápiz o el del
 *                                   medio arrastran. fase 'empezar' | 'mover' |
 *                                   'terminar'; x, y en px de la ventana (client).
 *                                   Sin él, esos botones no hacen nada.
 * @returns {{ redibujar(), actualizar(viewport), destruir(), readonly vivo: boolean }}
 */
export function cablearTinta(canvas, { pagina, capa, viewport, herramienta, goma, onCambio, onPan, activo }) {
  const ctx = canvas.getContext('2d');

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
  canvas.style.width = '';
  canvas.style.height = '';

  function medir() {
    const area = vp.width * vp.height;
    k = area > MAX_PIXELES ? Math.sqrt(MAX_PIXELES / area) : 1;
    canvas.width = Math.max(1, Math.round(vp.width * k));
    canvas.height = Math.max(1, Math.round(vp.height * k));
  }
  medir();

  let vivo = true;         // destruir() lo apaga: un editor muerto no acepta trazos
  let enCurso = null;      // { puntos, herramienta… } mientras la punta toca
  let frame = null;
  let sucio = false;       // la goma recortó algo y la página hay que rehacerla
  let paneo = false;       // el gesto en curso es un desplazamiento, no tinta
  let ultimoCrudo = null;  // el último punto tal cual llegó, sin suavizar

  const redibujar = () => {
    dibujarTrazos(ctx, capa.trazos(pagina), vp, { dpr: k });
    if (enCurso) pintarEnCurso();
  };

  function pintarEnCurso() {
    if (!enCurso || enCurso.puntos.length === 0) return;
    const d = pathDeTrazo(enCurso);
    if (!d) return;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.transform(...vp.transform);
    ctx.globalAlpha = enCurso.opacidad ?? 1;
    ctx.fillStyle = enCurso.color;
    ctx.fill(new Path2D(d));
    ctx.restore();
  }

  /** Un frame por movimiento, no un redibujado por punto coalescido. */
  function invalidar() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!vivo) return;
      /* La goma rehace la página una vez por cuadro, no una por cada punto
         coalescido que recortó algo: con tablet llegan 3 a 5 por cuadro, y
         cada redibujo recalcula todos los contornos (tinta-11). */
      if (sucio) { sucio = false; redibujar(); return; }
      /* Con tinta opaca alcanza con pintar el trazo en curso encima de lo que
         ya está. Con el resaltador no: superponer semitransparente sobre sí
         mismo lo va oscureciendo, así que hay que rehacer la página entera. */
      if (enCurso && (enCurso.opacidad ?? 1) < 1) redibujar();
      else pintarEnCurso();
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
     con el viewport, y desde tinta-02 no siempre: entre un zoom y el render
     siguiente el canvas ya mide lo del pliego nuevo y el viewport sigue siendo
     el viejo. Con la proporción real, lo que se dibuja en ese rato cae donde
     se ve la tinta estirada, que es donde se lo está viendo. */
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
      redibujar();
      onCambio?.();
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
    // Un trazo de un solo punto es un toque y vale; uno de cero, no.
    if (enCurso.puntos.length) capa.agregar(pagina, enCurso);
    enCurso = null;
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
    // El redibujo espera al cuadro: ver invalidar().
    if (hubo) { sucio = true; invalidar(); }
  }

  redibujar();

  return {
    redibujar,

    /**
     * El zoom o el giro cambiaron: el mismo editor sigue, con el viewport
     * nuevo (tinta-04). El bitmap se rehace al tamaño nuevo y se redibuja en la
     * misma tarea, así que no hay cuadro en blanco. Un trazo en curso sigue
     * valiendo: sus puntos están en coordenadas de página. Lo que no sigue
     * valiendo es el estado del suavizado, que está en px CSS de la caja
     * vieja: se vuelve a sembrar desde el último punto, medido con la caja de
     * ahora. Hoy el lector todavía rehace el editor; esto lo usa el paquete 3A.
     */
    actualizar(viewport) {
      if (!vivo || !viewport) return;
      vp = viewport;
      medir();
      if (enCurso?.puntos.length) {
        camino.begin(aCss(enCurso.puntos[enCurso.puntos.length - 1]), 0.35);
        ultimoCrudo = null;
      }
      redibujar();
    },

    destruir() {
      if (!vivo) return;
      /* Desde acá el editor no acepta nada. StrokeInput no expone un destroy y
         sus listeners siguen sobre el canvas hasta que el lector lo reemplaza:
         sin esta bandera, entre un zoom y el render siguiente se podía seguir
         dibujando con el viewport y la caja viejos, y el trazo caía corrido
         (tinta-04). */
      vivo = false;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      if (paneo) { paneo = false; onPan?.({ fase: 'terminar' }); }
      if (ultimoBorrado) {
        ultimoBorrado = null;
        gomaAnterior = null;
        sucio = false;
        capa.terminarBorrado();
      }
      /* Un trazo a medio hacer no se tira. Si el render termina con la punta
         apoyada, el lector cambia el canvas por un clon, el pointerup cae en el
         clon y este editor nunca se enteraba de que el trazo terminó: se perdía
         entero al levantar el lápiz. Se guarda con lo que tenga. */
      if (enCurso?.puntos.length) {
        cerrarTrazo();
        onCambio?.();
      }
      enCurso = null;
      ultimoCrudo = null;
      void entrada;
    },

    get vivo() { return vivo; },
  };
}
