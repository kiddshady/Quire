/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — dibujar sobre una página
   Cablea un canvas de tinta encima de un pliego del lector: lee el stylus,
   suaviza el camino y guarda el trazo en coordenadas de página.

   La entrada y el suavizado vienen de Scrawl (stroke.js) sin tocar. Lo que
   agrega este archivo es la traducción a coordenadas de página PDF y el
   redibujado.
   ═══════════════════════════════════════════════════════════════════════════ */

import { StrokeInput, StrokePath } from './stroke.js';
import { dibujarTrazos } from './capa.js';
import { pathDeTrazo } from './contorno.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opciones
 *   pagina, capa, viewport, herramienta() → {id, color, ancho, opacidad, sensible}
 *   onCambio(), activo() → boolean
 */
export function cablearTinta(canvas, { pagina, capa, viewport, herramienta, onCambio, activo }) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');

  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

  let enCurso = null;      // { puntos, herramienta… } mientras la punta toca
  let frame = null;

  const redibujar = () => {
    dibujarTrazos(ctx, capa.trazos(pagina), viewport, { dpr: 1 });
    if (enCurso) pintarEnCurso();
  };

  function pintarEnCurso() {
    if (!enCurso || enCurso.puntos.length === 0) return;
    const d = pathDeTrazo(enCurso);
    if (!d) return;
    ctx.save();
    ctx.transform(...viewport.transform);
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
      /* Con tinta opaca alcanza con pintar el trazo en curso encima de lo que
         ya está. Con el resaltador no: superponer semitransparente sobre sí
         mismo lo va oscureciendo, así que hay que rehacer la página entera. */
      if (enCurso && (enCurso.opacidad ?? 1) < 1) redibujar();
      else pintarEnCurso();
    });
  }

  /* De píxeles del canvas a coordenadas de página. Es lo que hace que un trazo
     hecho al 150% de zoom caiga en el mismo lugar del papel que uno hecho al
     60%, y que la página rotada no descoloque nada. */
  const aPagina = (pt) => {
    const [x, y] = viewport.convertToPdfPoint(pt.x * dpr, pt.y * dpr);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, pt.p];
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

  const camino = new StrokePath(() => {});
  let ultimoBorrado = null;

  const entrada = new StrokeInput(canvas, {
    begin(pt, mods) {
      if (!activo()) return;
      const h = herramienta();

      // La goma del stylus borra sin cambiar de herramienta en la barra.
      if (h.id === 'borrador' || mods.eraser) {
        ultimoBorrado = h;
        borrarEn(pt, h);
        return;
      }

      enCurso = {
        herramienta: h.id,
        color: h.color,
        ancho: h.ancho,
        opacidad: h.opacidad ?? 1,
        puntos: [aPagina(pt)],
      };
      camino.begin(pt, 0.35);
      invalidar();
    },

    move(pt, mods) {
      if (!activo()) return;
      if (ultimoBorrado) { borrarEn(pt, ultimoBorrado); return; }
      if (!enCurso) return;

      /* El suavizado de Scrawl emite puntos ya filtrados; se toma el último
         estado del camino en vez del punto crudo para que el trazo no tiemble
         con el jitter de la tablet. */
      camino.push(pt);
      const s = camino.pts[camino.pts.length - 1];
      enCurso.puntos.push(aPagina({ x: s.x, y: s.y, p: s.p }));
      invalidar();
    },

    end() {
      if (ultimoBorrado) { ultimoBorrado = null; onCambio?.(); return; }
      if (!enCurso) return;
      camino.end();

      // Un trazo de un solo punto es un toque y vale; uno de cero, no.
      if (enCurso.puntos.length) capa.agregar(pagina, enCurso);
      enCurso = null;
      redibujar();
      onCambio?.();
    },
  });

  function borrarEn(pt, h) {
    const [x, y] = aPagina(pt);
    const radio = (h.ancho || 16) / 2;
    if (capa.borrarEn(pagina, x, y, radio)) redibujar();
  }

  redibujar();

  return {
    redibujar,
    destruir() {
      if (frame) cancelAnimationFrame(frame);
      // StrokeInput no expone un destroy: alcanza con soltar el canvas, que se
      // va del DOM con su pliego y se lleva los listeners.
      enCurso = null;
      void entrada;
    },
  };
}
