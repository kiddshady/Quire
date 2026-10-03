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

import { calcar, recienCalcado } from './motion.js';

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

  // La vista que se va pasa a un calco que se esfuma encima (calcar, en
  // motion.js): sin esto se iba de golpe y la nueva arrancaba desde
  // transparente, un cuadro vacío en cada navegación.
  //
  // Salvo que el host se haya calcado hace un instante: un refresh() y un
  // go() en la misma tarea (en Quire, abrir o cerrar un documento desde otra
  // vista: el aviso repinta la vista actual y enseguida se navega). Lo que
  // hay en el host es un estado intermedio que el calco del refresh —casi
  // opaco todavía— no dejó ver. Calcarlo otra vez dejaba DOS calcos
  // fundiéndose juntos, y el intermedio (Páginas con las hojas en blanco)
  // asomaba hasta un 25 % a mitad de camino (shell-29). Se descarta, y lo
  // nuevo va directo debajo del calco que ya está: el criterio de repintar().
  //
  // `__pinta` dice que en el host vive otra vista: lo que el repintado de
  // recién dejó pendiente para el final de la tarea (devolver el scroll y el
  // foco, asentar en motion.js) ya no es para ella.
  if (host) host.__pinta = (host.__pinta ?? 0) + 1;
  const intermedio = !!host && recienCalcado(host);
  if (intermedio) host.replaceChildren();
  const saliente = intermedio || calcar(host);
  route.view(param);

  // Si hay una vista yéndose, la nueva no anima nada: ya está entera y quieta
  // debajo del calco, que es opaco, y el relevo lo hace el calco al
  // esfumarse. Antes la nueva esperaba 90 ms invisible y entraba corrida
  // 10 px: la pantalla se destapaba hasta la mitad y volvía (con contenido
  // claro, un parpadeo) y lo que las dos vistas tienen en el mismo lugar —el
  // título, las barras— temblaba. Medido en Quire (0.9.5).
  //
  // Sin vista yéndose (el arranque) entra sobre el eje del flujo. La
  // transición se reinicia a mano: sin el reflow intermedio el navegador no
  // vuelve a disparar la animación al re-agregar la clase.
  if (host) host.classList.remove('ox-view', 'is-settled');
  if (host && !saliente) {
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

  listeners.forEach((fn) => fn({ ...current }, from));
  return true;
}

/** Vuelve a montar la vista actual (después de un cambio de datos de fondo).
 *  Es un fundido que no pierde el lugar —scroll, foco, revelados, cápsulas—
 *  y no vuelve a hacer entrar nada: lo hace paint() (repintar, en motion.js). */
export function refresh() {
  const route = routes.get(current.name);
  if (!route) return;
  release();
  route.view(current.param);
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
