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

  route.view(param);

  // La transición de vista se reinicia a mano: sin el reflow intermedio el
  // navegador no vuelve a disparar la animación al re-agregar la clase.
  if (host) {
    host.classList.remove('ox-view');
    void host.offsetWidth;
    host.classList.add('ox-view');
  }

  listeners.forEach((fn) => fn({ ...current }, from));
  return true;
}

/** Vuelve a montar la vista actual (después de un cambio de datos de fondo). */
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
