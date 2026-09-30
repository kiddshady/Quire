/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — router
   Una app de escritorio no tiene URLs: tiene un nombre de vista y, a lo sumo,
   un parámetro. Eso es todo lo que hace falta, y hacerlo con un router web
   (history, hash, rutas parseadas) es traer una máquina para clavar un clavo.

   Su trabajo real, el que se olvida y produce fugas, es el CICLO DE VIDA:
   antes de montar una vista nueva hay que soltar los suscriptores, timers y
   observers de la anterior. Sin eso, cada navegación deja basura escuchando y
   la app se degrada sola después de un rato de uso.
   ═══════════════════════════════════════════════════════════════════════════ */

import { exit } from './motion.js';

const routes = new Map();
const listeners = new Set();

/** Trabajo de limpieza que dejó la vista actual. Se vacía al navegar. */
let cleanups = [];

let current = { name: null, param: null };
let host = null;

/**
 * Declara las vistas.
 *   Router.define({
 *     inicio: { view: viewInicio },
 *     item:   { view: viewItem, nav: 'inicio' },   // nav = qué ítem del rail se ilumina
 *   }, document.getElementById('view'));
 */
export function define(map, hostEl) {
  host = hostEl || host || document.getElementById('view');
  for (const [name, def] of Object.entries(map)) {
    routes.set(name, typeof def === 'function' ? { view: def } : def);
  }
}

/**
 * Registra limpieza para la vista que se está montando ahora.
 * Devolvé desde tu vista lo que haya que soltar:
 *   Router.onLeave(store.onEvent(repintar));
 *   Router.onLeave(() => clearInterval(id));
 */
export function onLeave(fn) {
  if (typeof fn === 'function') cleanups.push(fn);
}

function release() {
  const pending = cleanups;
  cleanups = [];
  for (const fn of pending) {
    // Una limpieza que explota no puede impedir las demás ni bloquear la
    // navegación: la vista nueva tiene que montar igual.
    try { fn(); } catch (err) { console.error('[Router] falló una limpieza:', err); }
  }
}

/**
 * La vista que se va no desaparece de un cuadro al otro: su contenido pasa a
 * un calco con la misma clase de `.ox-main`, en la misma celda de la grilla, y
 * se esfuma encima mientras la nueva entra. Sin esto, la vieja se iba de golpe
 * y la nueva arrancaba desde transparente: un cuadro vacío en cada navegación.
 *
 * El calco va sin ids (nadie tiene que encontrar un #campo que se está yendo),
 * inerte, y conserva su scroll. Si la vista vieja todavía estaba entrando, el
 * calco arranca desde la opacidad y el corrimiento en que la agarró.
 */
function retirarVista() {
  if (!host || !host.firstChild || !host.parentElement) return null;
  const cs = getComputedStyle(host);
  const calco = document.createElement(host.tagName);
  calco.className = host.className;
  calco.classList.remove('ox-view', 'is-settled');
  calco.classList.add('ox-main--saliente');
  calco.setAttribute('aria-hidden', 'true');
  calco.inert = true;
  calco.style.opacity = cs.opacity;
  if (cs.transform !== 'none') calco.style.transform = cs.transform;

  const scrolls = [...host.querySelectorAll('*')]
    .filter((el) => el.scrollTop || el.scrollLeft)
    .map((el) => [el, el.scrollTop, el.scrollLeft]);
  calco.append(...host.childNodes);
  for (const el of calco.querySelectorAll('[id]')) el.removeAttribute('id');
  host.after(calco);
  for (const [el, top, left] of scrolls) { el.scrollTop = top; el.scrollLeft = left; }

  // Mover un nodo en el DOM le REINICIA las animaciones CSS. Lo que tenía su
  // propia entrada volvía a entrar desde cero adentro del calco que se está
  // yendo: las miniaturas del lector caían a opacidad 0 y reaparecían
  // (0 → 63 → 86 %) mientras la vista se esfumaba, y lo mismo los paneles de
  // Herramientas. Se dan por terminadas; lo que gira para siempre (un spinner)
  // sigue girando. Traído de Onyx.
  for (const a of calco.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }

  exit(calco, { fallback: 260 });
  return calco;
}

/** Navega. Repetir la vista+parámetro actual no hace nada (evita repintados). */
export function go(name, param = null) {
  const route = routes.get(name);
  if (!route) {
    console.warn(`[Router] no existe la vista "${name}"`);
    return false;
  }
  if (name === current.name && param === current.param) return false;

  release();
  const from = { ...current };
  current = { name, param };

  // El rail marca activo el grupo, no la vista: el detalle de un ítem sigue
  // iluminando la sección de la que salió.
  const navKey = route.nav || name;
  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === navKey));

  const saliente = retirarVista();
  route.view(param);
  animarEntrada(saliente);

  listeners.forEach((fn) => fn({ ...current }, from));
  return true;
}

/**
 * Si hay una vista yéndose, la nueva no anima nada: ya está entera y quieta
 * debajo del calco, que es opaco, y el relevo lo hace el calco al esfumarse.
 * Antes la nueva esperaba 90 ms invisible y entraba corrida 10 px: la
 * pantalla se destapaba hasta la mitad y volvía (con las hojas blancas de un
 * PDF, un parpadeo) y lo que las dos vistas tienen en el mismo lugar —el
 * título, las barras— temblaba.
 *
 * Sin vista yéndose (el arranque) entra sobre el eje del flujo. La transición
 * se reinicia a mano: sin el reflow intermedio el navegador no vuelve a
 * disparar la animación al re-agregar la clase.
 */
function animarEntrada(saliente) {
  if (!host) return;
  host.classList.remove('ox-view', 'is-settled');
  if (saliente) return;
  void host.offsetWidth;
  host.classList.add('ox-view');
  // Terminada la entrada, se apaga con una clase: una animación con fill
  // `both` deja su último cuadro aplicado para siempre, y una opacidad
  // retenida vuelve a la vista frontera de backdrop para lo que tenga adentro.
  const settle = (ev) => {
    if (ev.target !== host || ev.animationName !== 'ox-glide-in') return;
    host.removeEventListener('animationend', settle);
    host.classList.add('is-settled');
  };
  host.addEventListener('animationend', settle);
}

/**
 * Vuelve a montar la vista actual (después de un cambio de datos de fondo).
 *
 * `animar` distingue los dos usos que tiene esto, que se ven iguales y no lo
 * son. Refrescar porque cambió un dato de la vista —elegiste otra impresora,
 * reiniciaste el orden de las páginas— es una actualización EN EL LUGAR, y
 * deslizar la pantalla entera por eso sobreactúa. Refrescar porque cambió el
 * documento es otra cosa: llegó contenido nuevo, igual que al navegar, y sin
 * la animación la vista salta de golpe.
 *
 * Por defecto NO anima, que es como se comportaba antes de que existiera el
 * parámetro: así ningún llamador viejo cambia de conducta sin que se lo pidan.
 * Cuando anima, es un relevo como al navegar: el documento de antes se
 * esfuma mientras entra el nuevo, en vez de irse de un cuadro al otro.
 */
export function refresh({ animar = false } = {}) {
  const route = routes.get(current.name);
  if (!route) return;
  release();
  const saliente = animar ? retirarVista() : null;
  route.view(current.param);
  if (animar) animarEntrada(saliente);
}

/** Se avisa después de cada navegación: (a, desde) => {} */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const Router = {
  define, go, refresh, onLeave, onChange,
  get current() { return { ...current }; },
  get name() { return current.name; },
  get param() { return current.param; },
  has: (name) => routes.has(name),
};

export default Router;
