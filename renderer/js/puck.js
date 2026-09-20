/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — el puck de navegación
   Un disco que aparece bajo el puntero mientras se mantiene la barra
   espaciadora en modo de anotación: apoyar en el núcleo hace zoom, apoyar en
   el anillo —o en cualquier otro lado— desplaza. Es el gesto de Scrawl, y acá
   hace más falta todavía: mientras anotás, el canvas de tinta se queda con el
   puntero, y con el lápiz en la mano no hay forma de scrollear ni de acercarse
   sin soltarlo y estirarse hasta la rueda.

   ── El puck no recibe eventos ─────────────────────────────────────────────
   Va con pointer-events:none y el reparto entre zonas es aritmética sobre su
   ancla: distancia al centro. Con dos elementos que escucharan sus propios
   pointerdown habría que pelear con la captura de puntero del visor, y el
   disco se quedaría con eventos que el visor necesita. Siendo puro afiche, el
   visor sigue siendo el único que escucha.

   ── Por qué se queda quieto ───────────────────────────────────────────────
   El disco se ancla donde la barra lo dejó y no sigue al puntero. Si siguiera,
   el puntero estaría siempre en el centro y no habría manera de apuntarle al
   anillo: las dos zonas dejarían de significar nada. Para moverlo se suelta y
   se vuelve a apretar la barra, que es un toque de la mano que ya está ahí.

   Las coordenadas que entran y salen son px relativos al contenedor donde se
   monta, que es el mismo sistema en el que el lector mide el puntero.
   ═══════════════════════════════════════════════════════════════════════════ */

const R_OUT = 54;               // borde exterior del disco
const R_IN = 24;                // borde del núcleo: la zona de zoom
const PAD = 2;                  // aire para el hairline y el antialias
const BOX = R_OUT + PAD;        // medio lado del lienzo del svg

const NS = 'http://www.w3.org/2000/svg';

function nodo(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/* Todo el disco es un solo SVG, con las mismas convenciones que icons.js
   (trazo de 2, puntas redondeadas) para que se lea como parte del mismo set.

   El anillo se dibuja como un stroke grueso y no como un disco con otro disco
   encima: así el núcleo queda libre y cada zona se pinta por separado. Con
   superficies translúcidas, un disco debajo del otro sumaría opacidades y el
   centro saldría más oscuro que el borde sin que nadie lo haya pedido. */
function dibujar() {
  const art = nodo('svg', {
    class: 'qr-puck__art',
    width: BOX * 2,
    height: BOX * 2,
    viewBox: `${-BOX} ${-BOX} ${BOX * 2} ${BOX * 2}`,
  });

  art.append(
    nodo('circle', {
      class: 'qr-puck__anillo',
      r: (R_OUT + R_IN) / 2,
      'stroke-width': R_OUT - R_IN,
    }),
    nodo('circle', { class: 'qr-puck__nucleo', r: R_IN }),
    // hairlines: el de afuera cierra el disco, el de adentro es el límite entre
    // las dos zonas — el único borde que hay que poder leer de un vistazo
    nodo('circle', { class: 'qr-puck__borde', r: R_OUT - 0.5 }),
    nodo('circle', { class: 'qr-puck__borde', r: R_IN }),
  );

  /* Radios en las diagonales: parten el anillo en cuatro y le dan al disco
     lectura de instrumento en vez de mancha. */
  for (const a of [45, 135, 225, 315]) {
    art.append(nodo('line', {
      class: 'qr-puck__rayo',
      x1: 0, y1: -(R_IN + 3),
      x2: 0, y2: -(R_OUT - 3),
      transform: `rotate(${a})`,
    }));
  }

  // cuatro puntas hacia afuera, una por cuadrante: el símbolo de desplazar
  const medio = (R_OUT + R_IN) / 2;
  for (const a of [0, 90, 180, 270]) {
    art.append(nodo('path', {
      class: 'qr-puck__glifo qr-puck__flecha',
      d: `M-5.5 ${-(medio - 4.5)}L0 ${-(medio + 4.5)}L5.5 ${-(medio - 4.5)}`,
      transform: `rotate(${a})`,
    }));
  }

  // lupa en el núcleo: el símbolo de zoom
  art.append(
    nodo('circle', { class: 'qr-puck__glifo qr-puck__lupa', cx: 2.5, cy: -2.5, r: 7 }),
    nodo('path', { class: 'qr-puck__glifo qr-puck__lupa', d: 'M-2.4 2.4L-8.8 8.8' }),
  );

  return art;
}

/** Monta el disco dentro de `padre` y devuelve el control. */
export function montarPuck(padre) {
  const host = document.createElement('div');
  host.className = 'qr-puck';
  // el vidrio va aparte del svg porque backdrop-filter es de elementos, no de
  // formas svg: es un círculo de css puesto justo debajo del dibujo
  const vidrio = document.createElement('div');
  vidrio.className = 'qr-puck__vidrio';
  host.append(vidrio, dibujar());
  padre.append(host);

  let visible = false;
  let cx = 0;
  let cy = 0;

  return {
    get visible() { return visible; },
    get x() { return cx; },
    get y() { return cy; },

    mostrar(x, y) {
      cx = x;
      cy = y;
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      visible = true;
      host.classList.add('is-visible');
    },

    ocultar() {
      visible = false;
      host.classList.remove('is-visible');
      host.dataset.hover = '';
      host.dataset.activo = '';
    },

    /* 'nucleo' | 'anillo' | null. El null es "fuera del disco", que para quien
       pregunta significa lo mismo que el anillo (desplaza) pero se distingue
       porque el resaltado no tiene a quién iluminar. */
    zonaEn(x, y) {
      if (!visible) return null;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R_IN) return 'nucleo';
      if (d <= R_OUT) return 'anillo';
      return null;
    },

    hover(zona) { host.dataset.hover = zona || ''; },
    activo(zona) { host.dataset.activo = zona || ''; },

    destruir() { host.remove(); },
  };
}
