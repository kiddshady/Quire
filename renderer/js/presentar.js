/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — presentar
   El PDF como diapositivas, una por pantalla: para las presentaciones que se
   convirtieron a PDF y se presentan desde el mismo PDF.

   Dos formas, según cuántas pantallas haya:

   · CON PROYECTOR (o segundo monitor): la diapositiva va sola a pantalla
     completa en la otra pantalla —la SALA— y en la notebook queda la vista
     del ORADOR: la actual, la siguiente, el cronómetro y la hora.
   · CON UNA SOLA: la diapositiva ocupa la ventana a pantalla completa, con
     el cronómetro en un rincón y una botonera que aparece al mover el mouse.

   La sala es una ventana del mismo origen (window.open, ver
   src/presentacion.cjs), así que este módulo le maneja el DOM directamente:
   cada pantalla que muestra una diapositiva es un ESCENARIO, y la sala, la
   actual del orador, la siguiente y la de una sola pantalla son el mismo
   código montado en documentos distintos. Las láminas se pintan una vez con
   pdf.js en esta ventana y cada escenario las copia (drawImage) a su tamaño.

   Lo que se dibuja encima (el láser y la tinta de paso) vive en coordenadas
   de la diapositiva —su ancho mide U— y cada escenario lo lleva a sus
   píxeles: lo que hacés sobre la actual del orador se ve igual en la sala.
   La tinta de paso no toca el PDF ni la capa de tinta del lector: se borra
   al cambiar de diapositiva.

   El cambio de diapositiva es un FUNDIDO (motion-timing, regla 2): la vieja
   queda encima como calco opaco y se apaga, con la nueva quieta debajo desde
   el primer cuadro. La pantalla nunca queda destapada.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar } from './estado.js';
import { Icons } from './icons.js';
import { Modal } from './overlays.js';
import { exit, raf2, asentarPlegables } from './motion.js';
import { StrokeInput } from './tinta/stroke.js';
import { contornoDeTrazo, trazoTocado } from './tinta/contorno.js';

/* Los tokens de motion.css que se usan desde acá. */
const T2 = 180;
const T3 = 280;
const EASE = 'cubic-bezier(.16, 1, .3, 1)';
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)';

/* Lo de encima de la diapositiva (la tinta, el láser) va en unidades de
   diapositiva: su ancho mide U. Mil y no uno porque el contorno de la tinta
   (contorno.js) tiene sus umbrales en unidades de página PDF —descarta
   puntos a menos de 0.08—, y con un ancho de 1 se comía el trazo entero. */
const U = 1000;

/* La tinta de paso. Colores para proyectar, no los del lector: saturados y
   claros, que se vean sobre una lámina blanca y sobre una oscura (por eso el
   blanco). El rojo es el de siempre. Los grosores en unidades de diapositiva:
   el mediano, 4.5, son ~9 px en un proyector de 1920. */
const COLORES_LAPIZ = [
  { hex: '#ff3b30', nombre: 'Rojo' },
  { hex: '#ffcc00', nombre: 'Amarillo' },
  { hex: '#34c759', nombre: 'Verde' },
  { hex: '#0a84ff', nombre: 'Azul' },
  { hex: '#ffffff', nombre: 'Blanco' },
  { hex: '#1a1a1a', nombre: 'Negro' },
];
const GROSORES = [
  { id: 'fino', nombre: 'Fino', ancho: 2.5, punto: 4 },
  { id: 'medio', nombre: 'Mediano', ancho: 4.5, punto: 7 },
  { id: 'grueso', nombre: 'Grueso', ancho: 9, punto: 11 },
];
const GOMA_RADIO = 18;

/* Lo que se eligió para el lápiz dura lo que dura la app: la próxima
   presentación arranca con el mismo color y grosor. */
const lapiz = { color: COLORES_LAPIZ[0].hex, grosor: 'medio' };
const anchoLapiz = () => (GROSORES.find((g) => g.id === lapiz.grosor) || GROSORES[1]).ancho;

/* Cuántas láminas ya pintadas se guardan. Cada escenario pide la suya a su
   tamaño, así que con la sala, la actual y la siguiente son ~3 por página. */
const LAMINAS_MAX = 12;

/* Lo que dura quieta la botonera de una sola pantalla antes de irse. */
const QUIETO_MS = 2200;

const P = {
  activa: false,
  cerrando: false,
  doc: null,
  n: 1,                // la diapositiva; doc.paginas + 1 es la tarjeta del final
  rot: 0,
  dual: false,
  sala: null,          // la ventana de la sala
  raiz: null,          // la capa de la presentación en esta ventana
  esc: {},             // principal, sala, siguiente
  negro: false,
  modo: null,          // null | 'laser' | 'lapiz'
  ctrl: false,
  puntero: null,       // dónde está el puntero sobre la principal (unidades de diapositiva)
  trazos: [],
  vivo: null,          // el trazo que se está dibujando
  grilla: null,
  digitos: '',
  reloj: { desde: 0, pausa: 0, verlo: true },
  tic: null,
  quieto: null,
  alTerminar: null,
  foco: null,
  quitar: [],
};

export const presentando = () => P.activa;

/* ── Las láminas ──────────────────────────────────────────────────────────────
   Una página pintada a la medida de un escenario. Se guardan las últimas y
   se piden de antemano las vecinas: avanzar no espera a pdf.js. */
const laminas = new Map();   // clave → promesa del canvas

const girada = () => P.rot === 90 || P.rot === 270;

async function medidaPt(n) {
  const g = await P.doc.geometria(n);
  return girada() ? { ancho: g.altoPt, alto: g.anchoPt } : { ancho: g.anchoPt, alto: g.altoPt };
}

function lamina(n, w, h, dpr) {
  const clave = `${n}:${w}x${h}@${dpr}:${P.rot}`;
  if (laminas.has(clave)) {
    const p = laminas.get(clave);
    laminas.delete(clave);
    laminas.set(clave, p);
    return p;
  }
  const doc = P.doc;
  const promesa = (async () => {
    const m = await medidaPt(n);
    const escala = Math.min(w / m.ancho, h / m.alto);
    const canvas = document.createElement('canvas');
    await doc.render(n, { canvas, escala, dpr, rotacionExtra: P.rot }).promesa;
    return canvas;
  })();
  promesa.catch(() => laminas.delete(clave));
  laminas.set(clave, promesa);
  while (laminas.size > LAMINAS_MAX) {
    const [vieja, p] = laminas.entries().next().value;
    laminas.delete(vieja);
    p.then((c) => { c.width = 0; c.height = 0; }, () => {});
  }
  return promesa;
}

function soltarLaminas() {
  for (const p of laminas.values()) p.then((c) => { c.width = 0; c.height = 0; }, () => {});
  laminas.clear();
}

/** Dónde cae la diapositiva dentro de un escenario de w × h, en px CSS. */
function rectDe(m, w, h) {
  const escala = Math.min(w / m.ancho, h / m.alto);
  const rw = m.ancho * escala;
  const rh = m.alto * escala;
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

/* ── El escenario ─────────────────────────────────────────────────────────────
   Una pantalla que muestra una diapositiva, en el documento que sea. */
class Escenario {
  /* `fondo` es lo que rodea a la lámina: negro en la sala y en una sola
     pantalla (es un proyector); el fondo de la app en la vista del orador,
     donde la diapositiva flota sobre la ventana con su filete. */
  constructor(raiz, { tinta = true, siguiente = false, fondo = '#000', filete = false } = {}) {
    this.raiz = raiz;
    this.fondo = fondo;
    this.filete = filete;
    this.doc = raiz.ownerDocument;
    this.win = this.doc.defaultView;
    this.siguiente = siguiente;
    raiz.innerHTML = `
      <div class="qr-esc__laminas"></div>
      ${tinta ? '<canvas class="qr-esc__tinta"></canvas><div class="qr-esc__laser"></div>' : ''}
      <div class="qr-esc__fin">${siguiente ? 'Fin' : 'Fin de la presentación'}</div>
      <div class="qr-esc__negro"></div>`;
    this.capa = raiz.querySelector('.qr-esc__laminas');
    this.tinta = raiz.querySelector('.qr-esc__tinta');
    this.punto = raiz.querySelector('.qr-esc__laser');
    this.velo = raiz.querySelector('.qr-esc__negro');
    this.actual = null;
    this.n = 0;          // la que se ve
    this.pedida = 0;     // la última que se pidió (puede estar pintándose)
    this.gen = 0;
    this.rect = null;
    this.medidas = '';
    this.ro = new this.win.ResizeObserver(() => this.alCambiarTamano());
    this.ro.observe(raiz);
  }

  medir() {
    const r = this.raiz.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), dpr: this.win.devicePixelRatio || 1 };
  }

  /** Muestra la diapositiva n (o la tarjeta del final). Devuelve cuando se ve. */
  async mostrar(n, { fundir = true } = {}) {
    const gen = ++this.gen;
    this.pedida = n;
    const { w, h, dpr } = this.medir();
    this.medidas = `${w}x${h}@${dpr}`;
    const hay = n >= 1 && n <= P.doc.paginas;
    let lienzo = null;
    let m = null;
    if (hay && w > 1 && h > 1) {
      try {
        [lienzo, m] = await Promise.all([lamina(n, w, h, dpr), medidaPt(n)]);
      } catch {
        if (gen !== this.gen || !P.activa) return;
      }
    }
    if (gen !== this.gen || !P.activa) return;

    const nuevo = this.doc.createElement('canvas');
    nuevo.className = 'qr-esc__lamina';
    nuevo.width = Math.max(1, Math.round(w * dpr));
    nuevo.height = Math.max(1, Math.round(h * dpr));
    const ctx = nuevo.getContext('2d', { alpha: false });
    ctx.fillStyle = this.fondo;
    ctx.fillRect(0, 0, nuevo.width, nuevo.height);
    this.rect = null;
    if (lienzo && m) {
      const r = rectDe(m, w, h);
      this.rect = r;
      ctx.drawImage(lienzo, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
      if (this.filete) {
        ctx.strokeStyle = 'rgb(255 255 255 / .1)';
        ctx.lineWidth = dpr;
        ctx.strokeRect(r.x * dpr - dpr / 2, r.y * dpr - dpr / 2, r.w * dpr + dpr, r.h * dpr + dpr);
      }
    }
    // El negro tapa la diapositiva, no el fondo que la rodea.
    const r = this.rect;
    Object.assign(this.velo.style, r
      ? { inset: 'auto', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }
      : { inset: '', left: '', top: '', width: '', height: '' });

    const viejo = this.actual;
    // Lo que todavía se iba de un cambio anterior se va ya: quedan dos, nunca tres.
    for (const c of [...this.capa.children]) if (c !== viejo) c.remove();
    this.capa.prepend(nuevo);   // debajo de la vieja: la vieja es el calco
    this.actual = nuevo;
    const cambio = this.n !== n;
    this.n = n;
    this.raiz.classList.toggle('is-fin', n > P.doc.paginas);
    this.raiz.dataset.n = String(n);
    this.dibujarTinta();
    this.ponerLaser();

    /* Cada animación con su plazo de red (motion-timing, regla 1): una
       ventana tapada no avanza sus animaciones, y sin el plazo el calco se
       quedaba encima para siempre —o la lámina nueva, invisible—. */
    if (!viejo) {
      if (fundir) {
        const a = nuevo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T3, easing: EASE });
        setTimeout(() => a.finish(), T3 + 120);
      }
    } else if (fundir && cambio) {
      const a = viejo.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T2, easing: EASE_BOTH, fill: 'forwards' });
      const quitar = () => viejo.remove();
      a.finished.then(quitar, quitar);
      setTimeout(quitar, T2 + 120);
    } else {
      viejo.remove();
    }
  }

  alCambiarTamano() {
    const { w, h, dpr } = this.medir();
    if (`${w}x${h}@${dpr}` === this.medidas || !this.pedida) return;
    /* La PEDIDA y no la que se ve: si el tamaño cambia mientras se pinta la
       siguiente, repintar la que se ve cancelaba la nueva y la presentación
       volvía una diapositiva para atrás. Y con fundido si todavía no llegó:
       sigue siendo un cambio de diapositiva. */
    this.mostrar(this.pedida, { fundir: this.pedida !== this.n });
  }

  /* La tinta de la diapositiva que se va queda pegada a su calco: se apaga
     con ella en vez de desaparecer antes. */
  congelarTinta() {
    if (!this.tinta || !this.actual || !P.trazos.length) return;
    this.actual.getContext('2d').drawImage(this.tinta, 0, 0, this.actual.width, this.actual.height);
    const ctx = this.tinta.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.tinta.width, this.tinta.height);
  }

  dibujarTinta() {
    if (!this.tinta) return;
    const { w, h, dpr } = this.medir();
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (this.tinta.width !== W || this.tinta.height !== H) { this.tinta.width = W; this.tinta.height = H; }
    const ctx = this.tinta.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const r = this.rect;
    if (!r) return;
    const k = (dpr * r.w) / U;
    ctx.setTransform(k, 0, 0, k, dpr * r.x, dpr * r.y);
    for (const t of P.vivo ? [...P.trazos, P.vivo] : P.trazos) {
      ctx.fillStyle = t.color;
      const path = new this.win.Path2D();
      const v = t.contorno || contorno(t);
      if (!v.length) continue;
      path.moveTo(v[0][0], v[0][1]);
      for (let i = 1; i < v.length; i++) path.lineTo(v[i][0], v[i][1]);
      path.closePath();
      ctx.fill(path);
    }
  }

  ponerLaser() {
    if (!this.punto) return;
    const p = laserVisible();
    const r = this.rect;
    const on = !!(p && r);
    if (on) this.punto.style.transform = `translate(${(r.x + (p.x / U) * r.w).toFixed(1)}px, ${(r.y + (p.y / U) * r.w).toFixed(1)}px)`;
    this.punto.classList.toggle('is-on', on);
  }

  /** De px del escenario a unidades de diapositiva (o null si cae afuera). */
  aDiapositiva(x, y) {
    const r = this.rect;
    if (!r) return null;
    return { x: ((x - r.x) / r.w) * U, y: ((y - r.y) / r.w) * U };
  }

  destruir() {
    this.ro.disconnect();
    for (const c of this.capa.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
  }
}

const contorno = (t) => contornoDeTrazo(t.puntos, { ancho: t.ancho, minRadio: t.ancho * 0.18 });

const escenarios = () => Object.values(P.esc).filter(Boolean);

/* ── Navegar ──────────────────────────────────────────────────────────────── */

const ultima = () => P.doc.paginas + 1;   // la tarjeta del final

function ir(n) {
  n = Math.max(1, Math.min(ultima(), n));
  // Con la pantalla en negro, la primera tecla la vuelve a prender y nada más.
  if (P.negro) { ponerNegro(false); return; }
  if (n === P.n) return;
  for (const e of escenarios()) e.congelarTinta?.();
  P.trazos = [];
  P.vivo = null;
  P.n = n;
  mostrarTodo();
  actualizarTextos();
  precargar();
}

const avanzar = () => ir(P.n + 1);
const retroceder = () => ir(P.n - 1);

function mostrarTodo({ fundir = true } = {}) {
  const { principal, sala, siguiente } = P.esc;
  return Promise.all([
    principal?.mostrar(P.n, { fundir }),
    sala?.mostrar(P.n, { fundir }),
    siguiente?.mostrar(Math.min(ultima(), P.n + 1), { fundir }),
  ]);
}

/* Las vecinas, una detrás de otra para no taparle el worker a la que se ve. */
let precargando = 0;
async function precargar() {
  const gen = ++precargando;
  const pedidos = [];
  for (const e of [P.esc.sala, P.esc.principal]) {
    if (!e) continue;
    const { w, h, dpr } = e.medir();
    for (const n of [P.n + 1, P.n - 1, P.n + 2]) pedidos.push([n, w, h, dpr]);
  }
  if (P.esc.siguiente) {
    const { w, h, dpr } = P.esc.siguiente.medir();
    pedidos.push([P.n + 2, w, h, dpr]);
  }
  for (const [n, w, h, dpr] of pedidos) {
    if (gen !== precargando || !P.activa) return;
    if (n < 1 || n > P.doc.paginas || w < 2 || h < 2) continue;
    await lamina(n, w, h, dpr).catch(() => {});
  }
}

/* ── Negro, láser y tinta ─────────────────────────────────────────────────── */

function ponerNegro(on) {
  P.negro = on;
  for (const e of escenarios()) if (e !== P.esc.siguiente) e.raiz.classList.toggle('is-negro', on);
  marcarBotones();
}

/* El láser se ve con su modo prendido, o mientras se aprieta Ctrl o el botón
   del costado de la lapicera (también dibujando: es un láser de paso). */
function laserVisible() {
  const p = P.puntero;
  if (!p) return null;
  return P.modo === 'laser' || P.ctrl || p.barril ? p : null;
}

function ponerLaserEnTodos() {
  for (const e of escenarios()) e.ponerLaser();
  P.raiz?.classList.toggle('is-laser', !!laserVisible() || P.modo === 'laser');
}

function ponerModo(modo) {
  P.modo = P.modo === modo ? null : modo;
  P.raiz?.classList.toggle('is-lapiz', P.modo === 'lapiz');
  ponerLaserEnTodos();
  marcarBotones();
}

function dibujarTintaEnTodos() {
  for (const e of escenarios()) e.dibujarTinta();
}

function borrarTinta() {
  if (!P.trazos.length) return;
  const capas = escenarios().map((e) => e.tinta).filter(Boolean);
  const anims = capas.map((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T2, easing: EASE_BOTH, fill: 'forwards' }));
  let hecho = false;
  const listo = () => {
    if (hecho) return;
    hecho = true;
    P.trazos = [];
    dibujarTintaEnTodos();
    anims.forEach((a) => a.cancel());
  };
  Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(listo);
  setTimeout(listo, T2 + 120);
}

/* El puntero sobre la principal: el láser, la tinta y el clic que avanza. */
function cablearPuntero(esc) {
  let dibujando = false;
  let borrando = false;
  const borrarEn = (q) => {
    const antes = P.trazos.length;
    P.trazos = P.trazos.filter((t) => !trazoTocado(t, q.x, q.y, GOMA_RADIO));
    if (P.trazos.length !== antes) dibujarTintaEnTodos();
  };
  const entrada = new StrokeInput(esc.raiz, {
    begin(pt, mods) {
      const q = esc.aDiapositiva(pt.x, pt.y);
      if (mods.eraser) { borrando = true; if (q) borrarEn(q); return; }
      if (P.modo === 'lapiz' && q && mods.button === 0) {
        dibujando = true;
        P.vivo = { puntos: [[q.x, q.y, pt.p]], ancho: anchoLapiz(), color: lapiz.color };
        dibujarTintaEnTodos();
        return;
      }
      if (P.modo === 'laser' || P.ctrl) { P.puntero = q; ponerLaserEnTodos(); return; }
      if (mods.button === 0) avanzar();
    },
    move(pt) {
      const q = esc.aDiapositiva(pt.x, pt.y);
      if (borrando) { if (q) borrarEn(q); return; }
      if (dibujando && q) {
        P.vivo.puntos.push([q.x, q.y, pt.p]);
        dibujarTintaEnTodos();
        return;
      }
      P.puntero = q;
      ponerLaserEnTodos();
    },
    end() {
      if (dibujando && P.vivo) {
        P.vivo.contorno = contorno(P.vivo);
        P.trazos.push(P.vivo);
      }
      P.vivo = null;
      dibujando = false;
      borrando = false;
      dibujarTintaEnTodos();
    },
    hover(pt, mods) {
      const q = esc.aDiapositiva(pt.x, pt.y);
      // El botón del costado de la lapicera es un láser mientras lo apretás.
      P.puntero = q ? { ...q, barril: mods.barrel } : null;
      ponerLaserEnTodos();
    },
    leave() { P.puntero = null; ponerLaserEnTodos(); },
    wheel: (e) => rueda(e),
  });
  return entrada;
}

/* La rueda pasa diapositivas, una por gesto: un trackpad manda decenas de
   eventos por cada deslizada. */
let ruedaAcum = 0;
let ruedaHasta = 0;
function rueda(e) {
  e.preventDefault?.();
  const ahora = performance.now();
  if (ahora < ruedaHasta) return;
  ruedaAcum += e.deltaY;
  if (Math.abs(ruedaAcum) < 40) return;
  ruedaAcum > 0 ? avanzar() : retroceder();
  ruedaAcum = 0;
  ruedaHasta = ahora + 320;
}

/* ── El reloj ─────────────────────────────────────────────────────────────── */

function transcurrido() {
  const r = P.reloj;
  return Math.max(0, (r.pausa || performance.now()) - r.desde);
}

function textoReloj(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const hora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

function tic() {
  if (!P.raiz) return;
  const t = textoReloj(transcurrido());
  for (const el of P.raiz.querySelectorAll('[data-reloj]')) if (el.textContent !== t) el.textContent = t;
  const hh = hora();
  const elH = P.raiz.querySelector('[data-hora]');
  if (elH && elH.textContent !== hh) elH.textContent = hh;
}

function pausarReloj() {
  const r = P.reloj;
  if (r.pausa) { r.desde += performance.now() - r.pausa; r.pausa = 0; } else r.pausa = performance.now();
  P.raiz?.classList.toggle('is-pausado', !!r.pausa);
  marcarBotones();
  tic();
}

function reiniciarReloj() {
  P.reloj.desde = performance.now();
  if (P.reloj.pausa) P.reloj.pausa = P.reloj.desde;
  tic();
}

/* ── La capa ──────────────────────────────────────────────────────────────── */

const boton = (act, icono, tip, tecla, { toggle = false } = {}) =>
  `<button class="ox-iconbtn${toggle ? ' qr-tool' : ''}" data-act="${act}" data-tip="${tip}"${tecla ? ` data-tip-key="${tecla}"` : ''} data-tip-side="top"><i data-icon="${icono}"></i></button>`;

function botonera() {
  return `
    ${boton('anterior', 'chevronLeft', 'Anterior', '←')}
    ${boton('siguiente', 'chevronRight', 'Siguiente', '→')}
    <div class="ox-vr"></div>
    ${boton('laser', 'laser', 'Puntero láser', 'L', { toggle: true })}
    ${boton('lapiz', 'tinta', 'Dibujar encima', 'D', { toggle: true })}
    <!-- El color y el grosor solo con el lápiz prendido: se despliegan a lo
         ancho al apretar D y se pliegan al soltarlo. -->
    <div class="qr-pres__lapiz ox-plegable--ancho" data-lapiz hidden>
      <div class="ox-vr"></div>
      ${COLORES_LAPIZ.map((c) => `<button class="qr-color" data-color="${c.hex}" style="--tinta:${c.hex}" data-tip="${c.nombre}" data-tip-side="top"></button>`).join('')}
      <div class="ox-vr"></div>
      ${GROSORES.map((g) => `<button class="ox-iconbtn qr-tool qr-pres__grosor" data-grosor="${g.id}" data-tip="${g.nombre}" data-tip-side="top"><span style="--d:${g.punto}px"></span></button>`).join('')}
    </div>
    ${boton('borrar', 'borrador', 'Borrar lo dibujado', 'E')}
    <div class="ox-vr"></div>
    ${boton('negro', 'pantallaNegra', 'Pantalla en negro', 'B', { toggle: true })}
    ${boton('grilla', 'grid', 'Todas las diapositivas', 'G')}`;
}

function htmlSola() {
  return `
    <div class="qr-esc qr-esc--principal"></div>
    <div class="qr-pres__flota" data-flota>
      ${botonera()}
      <div class="ox-vr"></div>
      <span class="qr-pres__cuenta ox-num" data-cuenta></span>
      ${boton('terminar', 'close', 'Terminar', 'Esc')}
    </div>
    <button class="qr-pres__reloj ox-num" data-act="pausar" data-tip="Pausar el cronómetro" data-tip-key="T oculta" data-tip-side="top" data-reloj></button>
    <div class="qr-pres__salto" data-salto></div>`;
}

function htmlOrador() {
  return `
    <header class="qr-orador__cabeza">
      <div class="qr-orador__cual" data-cuenta></div>
      <div class="qr-orador__reloj">
        <span class="qr-orador__tiempo ox-num" data-reloj></span>
        ${boton('pausar', 'pause', 'Pausar el cronómetro', 'T', { toggle: true })}
        ${boton('reiniciar', 'retry', 'Volver a cero', '')}
      </div>
      <div class="qr-orador__hora ox-num" data-hora></div>
    </header>
    <div class="qr-orador__cuerpo">
      <div class="qr-orador__actual">
        <div class="qr-esc qr-esc--principal qr-esc--orador"></div>
        <div class="qr-pres__salto" data-salto></div>
      </div>
      <div class="qr-orador__lado">
        <div class="qr-orador__rotulo">Siguiente</div>
        <div class="qr-esc qr-esc--siguiente"></div>
      </div>
    </div>
    <footer class="qr-orador__pie">
      ${botonera()}
      <div class="ox-spacer"></div>
      ${boton('intercambiar', 'intercambiar', 'Intercambiar las pantallas', '')}
      <button class="ox-btn ox-btn--secondary ox-btn--sm" data-act="terminar" data-tip="Terminar la presentación" data-tip-key="Esc" data-tip-side="top">Terminar</button>
    </footer>`;
}

/* Arma (o rearma, si se fue la sala) lo de esta ventana. */
function armar() {
  for (const e of [P.esc.principal, P.esc.siguiente]) e?.destruir();
  P.entrada = null;
  const raiz = P.raiz;
  raiz.classList.toggle('qr-pres--orador', P.dual);
  raiz.classList.toggle('qr-pres--sola', !P.dual);
  raiz.querySelector('[data-cont]').innerHTML = P.dual ? htmlOrador() : htmlSola();
  Icons.mount(raiz);
  const fondo = P.dual ? getComputedStyle(raiz).backgroundColor : '#000';
  P.esc.principal = new Escenario(raiz.querySelector('.qr-esc--principal'), { fondo, filete: P.dual });
  P.esc.siguiente = P.dual ? new Escenario(raiz.querySelector('.qr-esc--siguiente'), { tinta: false, siguiente: true, fondo, filete: true }) : null;
  P.entrada = cablearPuntero(P.esc.principal);
  if (P.negro) ponerNegro(true);
  P.raiz.classList.toggle('is-pausado', !!P.reloj.pausa);
  P.raiz.querySelector('.qr-pres__reloj')?.classList.toggle('is-oculto', !P.reloj.verlo);
  actualizarTextos();
  marcarBotones();
  // Si se rearma con el lápiz prendido, su color y grosor nacen en su lugar.
  asentarPlegables(raiz);
  tic();
}

function actualizarTextos() {
  if (!P.raiz) return;
  const total = P.doc.paginas;
  const fin = P.n > total;
  for (const el of P.raiz.querySelectorAll('[data-cuenta]')) {
    el.innerHTML = P.dual
      ? (fin ? 'Fin de la presentación' : `Diapositiva <span class="ox-num">${P.n}</span> de <span class="ox-num">${total}</span>`)
      : (fin ? 'Fin' : `${P.n} / ${total}`);
  }
  const ant = P.raiz.querySelector('[data-act="anterior"]');
  const sig = P.raiz.querySelector('[data-act="siguiente"]');
  if (ant) ant.disabled = P.n <= 1;
  if (sig) sig.disabled = fin;
}

function marcarBotones() {
  if (!P.raiz) return;
  const on = { laser: P.modo === 'laser', lapiz: P.modo === 'lapiz', negro: P.negro, pausar: !!P.reloj.pausa };
  for (const [act, v] of Object.entries(on)) {
    for (const b of P.raiz.querySelectorAll(`[data-act="${act}"].qr-tool`)) b.classList.toggle('is-on', v);
  }
  for (const el of P.raiz.querySelectorAll('[data-lapiz]')) el.hidden = P.modo !== 'lapiz';
  for (const b of P.raiz.querySelectorAll('[data-color]')) b.classList.toggle('is-on', b.dataset.color === lapiz.color);
  for (const b of P.raiz.querySelectorAll('[data-grosor]')) b.classList.toggle('is-on', b.dataset.grosor === lapiz.grosor);
  const pausa = P.raiz.querySelector('.qr-orador__reloj [data-act="pausar"]');
  if (pausa) {
    pausa.dataset.tip = P.reloj.pausa ? 'Seguir con el cronómetro' : 'Pausar el cronómetro';
    pausa.querySelector('svg')?.replaceWith(htmlAElemento(Icons.svg(P.reloj.pausa ? 'play' : 'pause')));
  }
  const chip = P.raiz.querySelector('.qr-pres__reloj');
  if (chip) chip.dataset.tip = P.reloj.pausa ? 'Seguir con el cronómetro' : 'Pausar el cronómetro';
}

function htmlAElemento(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function accion(act) {
  switch (act) {
    case 'anterior': retroceder(); break;
    case 'siguiente': avanzar(); break;
    case 'laser': ponerModo('laser'); break;
    case 'lapiz': ponerModo('lapiz'); break;
    case 'borrar': borrarTinta(); break;
    case 'negro': ponerNegro(!P.negro); break;
    case 'grilla': P.grilla ? cerrarGrilla() : abrirGrilla(); break;
    case 'pausar': pausarReloj(); break;
    case 'reiniciar': reiniciarReloj(); break;
    case 'intercambiar': intercambiar(); break;
    case 'terminar': terminar(); break;
    default:
  }
}

/* Una sola pantalla: la botonera y el cursor se van si no se mueve el mouse. */
function despertar() {
  if (!P.raiz || P.dual) return;
  P.raiz.classList.remove('is-quieto');
  P.raiz.querySelector('[data-flota]')?.classList.add('is-visible');
  clearTimeout(P.quieto);
  P.quieto = setTimeout(dormir, QUIETO_MS);
}

function dormir() {
  if (!P.raiz || P.dual) return;
  const flota = P.raiz.querySelector('[data-flota]');
  if (flota?.matches(':hover') || P.grilla) { P.quieto = setTimeout(dormir, QUIETO_MS); return; }
  flota?.classList.remove('is-visible');
  P.raiz.classList.add('is-quieto');
}

/* ── Ir a una diapositiva tecleando su número ─────────────────────────────── */

let saltoReloj = null;
function ponerSalto(digitos) {
  P.digitos = digitos;
  clearTimeout(saltoReloj);
  const el = P.raiz?.querySelector('[data-salto]');
  if (el) {
    if (digitos) el.innerHTML = `Ir a la <span class="ox-num">${digitos}</span>`;
    el.classList.toggle('is-visible', !!digitos);
  }
  if (digitos) saltoReloj = setTimeout(() => ponerSalto(''), 3000);
}

/* ── La grilla ────────────────────────────────────────────────────────────── */

function abrirGrilla() {
  if (P.grilla || !P.raiz) return;
  const total = P.doc.paginas;
  const el = document.createElement('div');
  el.className = 'qr-diapos';
  el.innerHTML = `
    <div class="qr-diapos__cabeza">
      <span class="qr-diapos__titulo">Diapositivas</span>
      ${boton('grilla', 'close', 'Volver', 'Esc')}
    </div>
    <div class="qr-diapos__lista">
      ${Array.from({ length: total }, (_, i) => `
        <button class="qr-diapos__item${i + 1 === P.n ? ' is-actual' : ''}" data-ir="${i + 1}">
          <span class="qr-diapos__hoja"><img alt=""></span>
          <span class="ox-num">${i + 1}</span>
        </button>`).join('')}
    </div>`;
  P.raiz.append(el);
  Icons.mount(el);
  el.addEventListener('animationend', (e) => { if (e.target === el && !el.dataset.state) el.classList.add('is-settled'); });
  P.grilla = el;
  const actual = el.querySelector('.is-actual');
  actual?.scrollIntoView({ block: 'center' });
  actual?.focus({ preventScroll: true });
  cargarMiniaturas(el);
  marcarBotones();
}

/* Primero las de alrededor de la actual: son las que se ven al abrir. */
async function cargarMiniaturas(el) {
  const total = P.doc.paginas;
  const orden = Array.from({ length: total }, (_, i) => i + 1)
    .sort((a, b) => Math.abs(a - P.n) - Math.abs(b - P.n));
  const doc = P.doc;
  for (const n of orden) {
    if (P.grilla !== el || P.doc !== doc) return;
    const url = await doc.miniatura(n).promesa.catch(() => null);
    const img = el.querySelector(`[data-ir="${n}"] img`);
    if (!url || !img) continue;
    img.onload = () => img.classList.add('is-lista');
    img.src = url;
  }
}

function cerrarGrilla({ ir: destino = null } = {}) {
  const el = P.grilla;
  if (!el) return;
  P.grilla = null;
  el.classList.remove('is-settled');
  exit(el, { fallback: 300 });
  if (destino) ir(destino);
  P.raiz?.focus({ preventScroll: true });
}

function teclaGrilla(e) {
  const items = [...P.grilla.querySelectorAll('.qr-diapos__item')];
  const i = Math.max(0, items.indexOf(P.grilla.ownerDocument.activeElement));
  const k = e.key;
  if (k === 'Escape' || k === 'g' || k === 'G') { cerrarGrilla(); return; }
  if (k === 'Enter' || k === ' ') { cerrarGrilla({ ir: i + 1 }); return; }
  const columnas = Math.max(1, items.filter((b) => b.offsetTop === items[0].offsetTop).length);
  const paso = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columnas, ArrowUp: -columnas, Home: -Infinity, End: Infinity }[k];
  if (paso === undefined) return;
  const j = Math.max(0, Math.min(items.length - 1, i + paso));
  items[j].focus({ preventScroll: true });
  items[j].scrollIntoView({ block: 'nearest' });
}

/* ── El teclado ───────────────────────────────────────────────────────────────
   Mientras se presenta, el teclado es de la presentación: el lector y el
   shell no se enteran (ningún Ctrl+W cierra el documento detrás). Los
   presentadores de mano mandan AvPág y RePág, y algunos B o el punto para
   la pantalla en negro, que es lo que esperan PowerPoint y compañía. */
const SIGUIENTE = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N']);
const ANTERIOR = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P']);

function tecla(e) {
  if (!P.activa) return;
  if (Modal.isOpen) return;
  e.stopImmediatePropagation();
  const k = e.key;
  if (k === 'Control') { if (!P.ctrl) { P.ctrl = true; ponerLaserEnTodos(); } return; }
  // Alt+F4 y compañía son de Windows; lo demás no baja a la app.
  if (e.altKey) return;
  e.preventDefault();
  if (P.cerrando) return;
  // Mientras arranca, solo Escape: lo demás movería escenarios que no existen.
  if (!P.listo) { if (k === 'Escape') terminar(); return; }
  despertar();

  if (P.grilla) { teclaGrilla(e); return; }

  if (/^[0-9]$/.test(k) && !e.ctrlKey) { if (P.digitos.length < 4) ponerSalto(P.digitos + k); return; }
  if (k === 'Enter' && P.digitos) { const n = +P.digitos; ponerSalto(''); if (n) ir(n); return; }
  if (k === 'Escape') {
    if (P.digitos) ponerSalto('');
    else if (P.modo) ponerModo(P.modo);
    else terminar();
    return;
  }
  if (e.ctrlKey) return;
  if (SIGUIENTE.has(k)) { avanzar(); return; }
  if (ANTERIOR.has(k)) { retroceder(); return; }
  if (k === 'Home') { ir(1); return; }
  if (k === 'End') { ir(P.doc.paginas); return; }
  if (e.repeat) return;
  const l = k.toLowerCase();
  if (l === 'b' || k === '.') ponerNegro(!P.negro);
  else if (l === 'g') abrirGrilla();
  else if (l === 'l') ponerModo('laser');
  else if (l === 'd') ponerModo('lapiz');
  else if (l === 'e') borrarTinta();
  else if (l === 't') {
    if (P.dual) pausarReloj();
    else {
      P.reloj.verlo = !P.reloj.verlo;
      P.raiz.querySelector('.qr-pres__reloj')?.classList.toggle('is-oculto', !P.reloj.verlo);
    }
  }
}

function soltarTecla(e) {
  if (!P.activa) return;
  if (e.key === 'Control' && P.ctrl) { P.ctrl = false; ponerLaserEnTodos(); }
}

function perderFoco() {
  if (P.ctrl) { P.ctrl = false; ponerLaserEnTodos(); }
}

function cablearVentana(win) {
  win.addEventListener('keydown', tecla, true);
  win.addEventListener('keyup', soltarTecla, true);
  win.addEventListener('blur', perderFoco);
  return () => {
    win.removeEventListener('keydown', tecla, true);
    win.removeEventListener('keyup', soltarTecla, true);
    win.removeEventListener('blur', perderFoco);
  };
}

/* ── La sala ──────────────────────────────────────────────────────────────── */

function abrirSala() {
  const w = window.open('', 'qr-sala');
  if (!w) return false;
  const d = w.document;
  const css = new URL('./css/', location.href).href;
  d.title = 'Quire — presentación';
  d.head.innerHTML = `<meta charset="utf-8">
    <link rel="stylesheet" href="${css}tokens.css">
    <link rel="stylesheet" href="${css}presentar.css">`;
  d.body.className = 'qr-sala';
  d.body.innerHTML = '<div class="qr-esc qr-esc--sala"></div><div class="qr-pres__telon"></div>';
  P.sala = w;
  P.esc.sala = new Escenario(d.querySelector('.qr-esc--sala'));
  P.quitar.push(cablearVentana(w));
  // En la sala, un clic avanza y la rueda pasa diapositivas: por si el mouse quedó allá.
  d.addEventListener('pointerdown', (e) => { if (e.button === 0) avanzar(); });
  d.addEventListener('wheel', rueda, { passive: false });
  d.addEventListener('contextmenu', (e) => e.preventDefault());
  return true;
}

/* El telón de la sala se levanta cuando la ventana ya llegó a su monitor y
   tiene la diapositiva pintada: hasta ahí, negro. */
function levantarTelonSala() {
  const telon = P.sala?.document?.querySelector('.qr-pres__telon');
  if (telon) raf2(() => telon.classList.add('is-abierto'));
}

function salaCerrada() {
  if (!P.activa || P.cerrando || !P.dual) return;
  P.esc.sala?.destruir();
  P.esc.sala = null;
  P.sala = null;
  P.dual = false;
  armar();
  mostrarTodo({ fundir: false });
  despertar();
}

async function intercambiar() {
  if (!P.dual || P.cambiando) return;
  P.cambiando = true;
  const telones = [P.raiz.querySelector(':scope > .qr-pres__telon'), P.sala?.document?.querySelector('.qr-pres__telon')].filter(Boolean);
  telones.forEach((t) => t.classList.remove('is-abierto'));
  await esperar(T3);
  await window.onyx.presentar.intercambiar().catch(() => false);
  await new Promise((r) => raf2(r));
  await mostrarTodo({ fundir: false });
  telones.forEach((t) => t.classList.add('is-abierto'));
  P.cambiando = false;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Empezar y terminar ───────────────────────────────────────────────────── */

/**
 * Empieza a presentar el documento que se está mirando.
 * @param {{desde?: number, alTerminar?: (pagina:number) => void}} opciones
 */
export async function presentar({ desde = 1, alTerminar = null } = {}) {
  if (P.activa || !S.doc) return;
  Object.assign(P, {
    activa: true,
    cerrando: false,
    doc: S.doc,
    n: Math.max(1, Math.min(S.doc.paginas, desde)),
    rot: S.rotacion || 0,
    dual: false,
    sala: null,
    esc: {},
    negro: false,
    modo: null,
    ctrl: false,
    puntero: null,
    trazos: [],
    vivo: null,
    grilla: null,
    digitos: '',
    alTerminar,
    foco: document.activeElement,
    quitar: [],
    listo: false,
    cambiando: false,
    salaPintada: null,
    entrada: null,
  });
  P.reloj = { desde: performance.now(), pausa: 0, verlo: true };

  const raiz = document.createElement('div');
  raiz.id = 'qr-presentacion';
  raiz.className = 'qr-pres';
  raiz.tabIndex = -1;
  raiz.innerHTML = '<div class="qr-pres__cont" data-cont></div><div class="qr-pres__telon"></div>';
  raiz.addEventListener('animationend', (e) => { if (e.target === raiz && !raiz.dataset.state) raiz.classList.add('is-settled'); });
  raiz.addEventListener('click', (e) => {
    const color = e.target.closest('[data-color]');
    if (color) { lapiz.color = color.dataset.color; marcarBotones(); return; }
    const grosor = e.target.closest('[data-grosor]');
    if (grosor) { lapiz.grosor = grosor.dataset.grosor; marcarBotones(); return; }
    const ir2 = e.target.closest('[data-ir]');
    if (ir2) { cerrarGrilla({ ir: +ir2.dataset.ir }); return; }
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled) accion(b.dataset.act);
  });
  raiz.addEventListener('pointermove', despertar);
  raiz.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(raiz);
  P.raiz = raiz;
  raiz.focus({ preventScroll: true });
  P.quitar.push(cablearVentana(window));
  P.quitar.push(alCambiar((que) => { if (que === 'documento' && S.doc !== P.doc) terminar({ rapido: true }); }));

  // Primero el negro sobre la app; recién ahí la pantalla completa.
  const info = await window.onyx.presentar.preparar().catch(() => ({ dual: false }));
  await esperar(T3);
  if (!P.activa || P.cerrando) return;
  await window.onyx.presentar.pantallaCompleta(true).catch(() => {});
  if (!P.activa || P.cerrando) return;

  P.dual = !!info.dual && abrirSala();
  if (P.dual) {
    let pintada = null;
    let lista = false;
    const intentar = () => { if (lista && pintada) levantarTelonSala(); };
    P.quitar.push(window.onyx.presentar.alSalaLista(() => { lista = true; intentar(); }));
    P.quitar.push(window.onyx.presentar.alCerrarSala(salaCerrada));
    pintada = false;
    P.salaPintada = () => { pintada = true; intentar(); };
    // Por si el aviso de la sala no llega: negro para siempre sería peor.
    setTimeout(() => { lista = true; intentar(); }, 1500);
  }
  armar();
  await new Promise((r) => raf2(r));
  await mostrarTodo({ fundir: false });
  if (!P.activa || P.cerrando) return;
  P.listo = true;
  P.salaPintada?.();
  raiz.querySelector(':scope > .qr-pres__telon').classList.add('is-abierto');
  P.tic = setInterval(tic, 250);
  despertar();
  precargar();
}

/** Termina la presentación y vuelve al lector, en la diapositiva donde quedó. */
export async function terminar({ rapido = false } = {}) {
  if (!P.activa || P.cerrando) return;
  P.cerrando = true;
  const raiz = P.raiz;
  const final = Math.min(P.n, P.doc.paginas);
  cerrarGrilla();
  clearInterval(P.tic);
  clearTimeout(P.quieto);
  ponerSalto('');

  if (!rapido) {
    raiz.querySelector(':scope > .qr-pres__telon')?.classList.remove('is-abierto');
    P.sala?.document?.querySelector('.qr-pres__telon')?.classList.remove('is-abierto');
    await esperar(T3);
  }
  P.quitar.forEach((f) => { try { f(); } catch { /* ya no estaba */ } });
  P.quitar = [];
  for (const e of escenarios()) e.destruir();
  P.esc = {};
  if (P.dual) await window.onyx.presentar.cerrarSala().catch(() => {});
  P.sala = null;
  await window.onyx.presentar.pantallaCompleta(false).catch(() => {});
  soltarLaminas();
  P.activa = false;
  P.cerrando = false;
  if (S.doc === P.doc) P.alTerminar?.(final);
  P.doc = null;
  P.raiz = null;
  raiz.classList.remove('is-settled');
  await new Promise((r) => raf2(r));
  exit(raiz, { fallback: 500 });
  if (P.foco?.isConnected) P.foco.focus({ preventScroll: true });
  P.foco = null;
}

/* Para los tests: el estado sin tocar nada. */
window.__quirePresentacion = () => ({
  activa: P.activa,
  n: P.n,
  dual: P.dual,
  negro: P.negro,
  modo: P.modo,
  trazos: P.trazos.length,
  grilla: !!P.grilla,
  sala: !!P.sala,
  pausado: !!P.reloj.pausa,
  laminas: laminas.size,
});
window.__quireSala = () => P.sala?.document || null;
