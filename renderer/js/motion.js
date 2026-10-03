/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — motion (runtime)
   La mitad JS del sistema de movimiento. Su trabajo más importante es el que
   más se olvida: que lo que se va del DOM TERMINE su animación de salida antes
   de irse. Sin esto los overlays parpadean al cerrarse y la app se siente rota.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Dos frames: garantiza que el navegador ya aplicó los estilos iniciales. */
export function raf2(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Saca un elemento del DOM DESPUÉS de su animación de salida.
 * Marca data-state="closing" (el CSS engancha ahí) y espera al animationend,
 * con un timeout de red por si el elemento no tiene animación declarada.
 */
export function exit(el, { fallback = 400, onDone } = {}) {
  if (!el || el.dataset.state === 'closing') return Promise.resolve();
  el.dataset.state = 'closing';

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', onAnim);
      el.remove();
      onDone?.();
      resolve();
    };
    // Solo nos importa la animación del propio elemento, no la de sus hijos.
    const onAnim = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onAnim);
    const timer = setTimeout(finish, fallback);
  });
}

/* ── swap: reescribir un bloque sin cortes ──────────────────────────────────
   Un `innerHTML` a secas es un corte: lo viejo desaparece en el cuadro en que
   llega lo nuevo. Salió en Chem Engine, donde un auditor de transiciones lo
   encontró en todas partes, y cada caso pedía algo distinto:

   · APARECE (vacío → algo): lo nuevo entra con un fundido.
   · SE VA (algo → vacío): cada hijo termina de irse antes de salir del DOM.
     Hijo por hijo y no en una caja: si el contenedor es una grilla, una caja
     en el medio desarmaría las filas mientras se esfuman.
   · CAMBIA DE VALORES (algo → algo): se reescribe en el lugar y SIN volver a
     animar. Una ficha que se recalcula seguido destellaba en cada cambio.
   · CAMBIA DE ESTADO (`relevo`: pista → cargando → resultado, un estado por
     otro): lo viejo se esfuma en un calco ENCIMA, en el mismo lugar, y lo
     nuevo asoma cuando lo viejo ya va por un tercio. El calco copia el acomodo
     del contenedor para que lo viejo no se mueva mientras se va.
   · CAMBIA DE FORMA UN BLOQUE GRANDE (`fundido`: una tabla que gana o pierde
     columnas): la espera del relevo destapa —a mitad de camino lo viejo va
     por la mitad y lo nuevo por un tercio, y el bloque entero queda a media
     luz—. Con fundido el calco lleva el fondo opaco de lo que tiene detrás y
     va por encima del `th` sticky de la tabla nueva, y lo nuevo está entero y
     quieto debajo desde el primer cuadro. De Pharos 0.4.1.

   En los dos, el calco conserva la caja que tenía lo viejo (ancho, alto y
   dónde caía), no la del contenedor ya con lo nuevo: con `inset: 0`, una
   frase que se iba dentro de una caja más angosta se partía en dos renglones
   mientras se esfumaba, y una más ancha se corría (Pharos 0.4.1).

   Con el mismo HTML de la última vez no hace nada: se puede llamar en cada
   refresco sin reemplazar nodos que no cambiaron. Y si lo de antes todavía
   estaba ENTRANDO, lo nuevo sigue desde el mismo punto del fundido en vez de
   cortarlo (dos recálculos seguidos hacían saltar el bloque a opaco). */
const ultimo = new WeakMap();

export function swap(el, html, { relevo = false, fundido = false } = {}) {
  if (!el) return;
  if (ultimo.get(el) === html) return;
  ultimo.set(el, html);

  const viejos = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-swap-out')));
  const antes = viejos.some((n) => n.nodeType === 1 || n.textContent.trim());
  const despues = html.trim() !== '';
  if (!antes && !despues) return;

  // Lo que todavía se estaba yendo EN el flujo se corta: si no, durante el
  // fundido habría dos juegos de filas.
  if (despues) el.querySelectorAll(':scope > .ox-swap-out:not(.ox-swap-out--over)').forEach((n) => n.remove());

  // Solo las entradas: lo que gira para siempre (un spinner) no se toca.
  const finitas = () => el.getAnimations({ subtree: true })
    .filter((a) => a.effect?.getTiming().iterations !== Infinity);

  if (antes && despues && !relevo && !fundido) {
    const enCurso = finitas().filter((a) => a.playState === 'running').map((a) => a.currentTime);
    const t = enCurso.length ? Math.max(...enCurso) : null;
    el.innerHTML = html;
    if (t != null) for (const n of el.children) entrar(n);
    for (const a of finitas()) { if (t != null) a.currentTime = t; else a.cancel(); }
    return;
  }

  // Lo que todavía estaba ENTRANDO no se da por terminado. finish() lo llevaba
  // a opaco y el calco lo esfumaba desde ahí: dos relevos seguidos («Buscando…»
  // y el resultado a los 30 ms) mostraban entero, un instante, un estado que
  // nunca se había visto. Lo que no había asomado se va sin calco; lo que iba a
  // mitad de camino sale desde la opacidad que tenía. Salió de Quire (el cartel
  // de actualización ya lo hacía así).
  const aMitad = new Map();
  for (const n of viejos) {
    if (n.nodeType !== 1 || !n.classList.contains('ox-swap-in') || n.classList.contains('is-settled')) continue;
    const op = +getComputedStyle(n).opacity;
    if (op < 0.02) n.remove(); else aMitad.set(n, op);
  }
  const vivos = viejos.filter((n) => n.isConnected);
  const quedan = vivos.some((n) => n.nodeType === 1 || n.textContent.trim());
  // Si algo de antes se sigue yendo, lo nuevo igual espera su turno.
  const yendose = !!el.querySelector(':scope > .ox-swap-out');

  if (antes && !despues) {
    for (let n of vivos) {
      // Un texto suelto no puede salir animado: se borraba de golpe. Va en un
      // <span> y sale como los demás.
      if (n.nodeType === 3 && n.textContent.trim()) {
        const s = document.createElement('span');
        n.replaceWith(s);
        s.append(n);
        n = s;
      }
      if (n.nodeType !== 1) { n.remove(); continue; }
      // La salida no tiene `from`: parte de la opacidad de abajo, que sin esto
      // sería 1 aunque lo estuviera agarrando a mitad de su entrada.
      if (aMitad.has(n)) n.style.opacity = String(aMitad.get(n));
      n.classList.remove('ox-swap-in', 'is-after');
      n.classList.add('ox-swap-out');
      n.inert = true;
      exit(n, { fallback: 220 });
    }
    return;
  }

  let calco = null;
  let caja = null;
  if (quedan) {
    caja = cajaDe(el);
    calco = document.createElement('div');
    calco.className = `ox-swap-out ox-swap-out--over${fundido ? ' ox-swap-out--fundido' : ''}`;
    calco.inert = true;
    calco.setAttribute('aria-hidden', 'true');
    calco.append(...vivos);
    for (const x of calco.querySelectorAll('[id]')) x.removeAttribute('id');
    if (getComputedStyle(el).position === 'static') el.classList.add('ox-swap-host');
    // El fondo, del primer opaco hacia arriba: el calco no lleva la clase de
    // ninguna superficie que lo traiga.
    if (fundido) calco.style.background = fondoDetras(el);
    el.prepend(calco);
    // Mover un nodo le reinicia las animaciones CSS: lo que tenía su propia
    // entrada volvería a entrar desde cero adentro del calco que se va. Se da
    // por terminada, salvo la de lo que venía entrando: esa se cancela (una
    // de CSS cancelada no vuelve mientras no cambie su nombre) y queda en la
    // opacidad en que se la agarró.
    for (const a of calco.getAnimations({ subtree: true })) {
      if (aMitad.has(a.effect?.target)) a.cancel();
      else if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
    for (const [n, op] of aMitad) n.style.opacity = String(op);
    exit(calco, { fallback: 220 });
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // Un texto suelto no se puede animar: aparecía entero de golpe debajo de lo
  // viejo que se estaba yendo. Va en un <span> (de Pharos).
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType !== 3 || !n.textContent.trim()) continue;
    const s = document.createElement('span');
    n.replaceWith(s);
    s.append(n);
  }
  // Con fundido lo nuevo no anima: está entero debajo y el calco lo destapa.
  if (!(fundido && calco)) for (const n of tpl.content.children) entrar(n, quedan || yendose);
  el.append(tpl.content);

  // El calco, clavado en la caja vieja: medida ya con lo nuevo adentro.
  if (calco) {
    const ahora = cajaDe(el);
    Object.assign(calco.style, {
      inset: 'auto',
      left: `${caja.left - ahora.left}px`,
      top: `${caja.top - ahora.top}px`,
      width: `${caja.w}px`,
      height: `${caja.h}px`,
    });
  }
}

/* La caja de relleno de `el` (donde se apoya un hijo absoluto), con
   decimales. clientWidth redondea: a una frase de 105,06 px le daba 105 y
   no entraba —se partía en dos renglones igual—. */
function cajaDe(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  return {
    left: r.left + bl,
    top: r.top + bt,
    w: r.width - bl - (parseFloat(cs.borderRightWidth) || 0),
    h: r.height - bt - (parseFloat(cs.borderBottomWidth) || 0),
  };
}

/** El primer fondo opaco hacia arriba: lo que el calco de un fundido tiene que
    llevar para tapar lo nuevo sin que se note un parche. */
function fondoDetras(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (alfaDe(bg) >= 1) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** La opacidad de un color computado: `rgba(…, a)`, `oklch(… / a)` o sin alfa. */
function alfaDe(color) {
  if (!color || color === 'transparent') return 0;
  const barra = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (barra) return Number(barra[1]) / (barra[2] ? 100 : 1);
  const rgba = color.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/);
  return rgba ? Number(rgba[1]) : 1;
}

function entrar(n, tarde = false) {
  n.classList.add('ox-swap-in');
  if (tarde) n.classList.add('is-after');
  // Terminada la entrada se apaga con una clase y no con style.animation: un
  // fill `both` retenido deja la opacidad clavada, y un inline le ganaría
  // después a la regla de salida.
  n.addEventListener('animationend', function fin(ev) {
    if (ev.target !== n) return;
    n.removeEventListener('animationend', fin);
    n.classList.add('is-settled');
  });
}

/** Escalona los hijos de un contenedor seteando --i (el CSS lo usa de delay). */
export function stagger(container, selector = ':scope > *', step = 1) {
  container.querySelectorAll(selector).forEach((el, i) => {
    el.style.setProperty('--i', String(i * step));
  });
}

/* ── Click-flash ────────────────────────────────────────────────────────────
   Un velo de luz que nace con el press y decae. No viaja como un ripple de
   Material: solo confirma que el click llegó, y se limpia solo. */
export function initClickFlash(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest?.('.ox-flashable');
    if (!target || target.disabled) return;
    const flash = document.createElement('span');
    flash.className = 'ox-flash';
    target.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
  });
}

/* ── Esfumado del scroll ────────────────────────────────────────────────────
   Apaga el fade del lado donde no hay nada recortado: pegado arriba no se
   esfuma arriba. Sin esto el primer item vive a media luz sin razón. */
export function scrollFade(el) {
  if (!el || el.__vcFade) return;
  el.__vcFade = true;

  const update = () => {
    const slack = el.scrollHeight - el.clientHeight;
    if (slack <= 1) {                       // no hay nada que recortar
      el.classList.add('is-top', 'is-bottom');
      el.classList.remove('is-stuck-head');
      return;
    }
    el.classList.toggle('is-top', el.scrollTop <= 1);
    el.classList.toggle('is-bottom', el.scrollTop >= slack - 1);
    // Un encabezado de tabla clavado contra el borde: su tabla ya empezó arriba
    // del borde y todavía no terminó. Ahí la línea es el límite y el fade sobra.
    const top = el.getBoundingClientRect().top;
    const stuck = [...el.querySelectorAll('.ox-table')].some((t) => {
      if (t.closest('.ox-scroll') !== el) return false;
      const r = t.getBoundingClientRect();
      return r.top < top - 1 && r.bottom > top;
    });
    el.classList.toggle('is-stuck-head', stuck);
  };

  el.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(el);
  // El contenido puede cambiar de alto sin que cambie el del contenedor.
  new MutationObserver(update).observe(el, { childList: true, subtree: true });
  update();
}

/** Aplica scrollFade a todo .ox-scroll que todavía no lo tenga. */
export function initScrollFades(root = document) {
  root.querySelectorAll('.ox-scroll').forEach(scrollFade);
}

/* ── Indicadores que viajan ─────────────────────────────────────────────────
   La cápsula del segmentado y el subrayado de los tabs se DESLIZAN entre
   opciones. Que viajen en vez de saltar es lo que los hace sentir físicos. */

/* La cápsula copia la geometría REAL de la opción activa, igual que el
   subrayado de los tabs. Antes se calculaba como ancho/n asumiendo opciones
   iguales, y en una celda de tabla no lo son: la cápsula caía corrida y el
   texto parecía descentrado. offsetLeft es relativo al segmentado (position:
   relative), así que ya incluye su padding. */
export function syncSegmented(seg) {
  const active = seg.querySelector('.ox-segmented__opt.is-active') || seg.querySelector('.ox-segmented__opt');
  if (!active) return;
  seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
  seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
}

export function syncTabs(tabs) {
  const active = tabs.querySelector('.ox-tab.is-active');
  if (!active) return;
  tabs.style.setProperty('--tab-x', `${active.offsetLeft}px`);
  tabs.style.setProperty('--tab-w', `${active.offsetWidth}px`);
}

/* Pone un indicador en su lugar sin que viaje: la transición se apaga, se
   mide, se fuerza el estilo y se vuelve a prender. Leer el estilo del pseudo
   es lo que asienta el valor; sin eso, al sacar la clase el navegador ve el
   cambio recién ahí y lo anima igual. De Apex. */
function colocar(root, pseudo, fn) {
  root.classList.add('is-placing');
  fn();
  void getComputedStyle(root, pseudo).width;
  root.classList.remove('is-placing');
}

/**
 * Cablea un grupo (segmentado o tabs) para que se comporte solo.
 * onChange recibe el value del botón elegido.
 */
export function bindSwitcher(root, onChange) {
  const isSeg = root.classList.contains('ox-segmented');
  const optSel = isSeg ? '.ox-segmented__opt' : '.ox-tab';
  const pseudo = isSeg ? '::before' : '::after';
  const medir = () => (isSeg ? syncSegmented(root) : syncTabs(root));
  /* La primera medida no viaja: la cápsula nace donde va. Antes la primera
     medida llegaba recién en raf2, así que la cápsula nacía en ancho 0 contra
     la izquierda y crecía, en cada vista que se montaba. Si ya trae una
     posición (la que devolvió el repintado de la misma vista), viaja desde
     ahí: es la que se tocó. De Apex. */
  let colocado = !!root.style.getPropertyValue(isSeg ? '--seg-w' : '--tab-w');
  const sync = () => {
    if (colocado) return medir();
    if (!root.offsetWidth) return;          // todavía sin layout: lo hace el ResizeObserver
    colocar(root, pseudo, medir);
    colocado = true;
  };

  root.addEventListener('click', (e) => {
    const opt = e.target.closest(optSel);
    if (!opt || opt.classList.contains('is-active')) return;
    root.querySelectorAll(optSel).forEach((o) => o.classList.remove('is-active'));
    opt.classList.add('is-active');
    sync();
    onChange?.(opt.dataset.value, opt);
  });

  sync();
  new ResizeObserver(sync).observe(root);
  raf2(sync);   // las fuentes pueden cambiar el ancho después del primer layout
  return sync;
}

/* ── Cambiar o repintar la vista ────────────────────────────────────────────
   Navegar es un fundido: la vista que se va pasa a un calco opaco encima y se
   esfuma, y la nueva está entera debajo desde el primer cuadro (calcar, lo
   usa el router).

   Repintar la MISMA vista —Router.refresh() después de guardar, una vista
   que se vuelve a pintar con el dato nuevo— era un innerHTML en seco, y eso
   traía cuatro cosas que se veían en todas las apps:
   · lo viejo se iba en el mismo cuadro en que llegaba lo nuevo;
   · todo lo que tenía entrada propia volvía a entrar (filas escalonadas, el
     vacío que sube, la línea de un gráfico que se dibuja de nuevo);
   · los contadores (countTo) volvían a contar desde 0;
   · el lugar se perdía: el scroll volvía arriba, un revelado abierto se
     cerraba, el foco se iba y las cápsulas de los segmentados nacían de cero.
   Ahora paint() repinta con repintar(): el mismo calco que al navegar, y lo
   nuevo ASENTADO debajo —sin entradas, con los contadores en su valor y en el
   mismo lugar que lo viejo—. Lo que no cambió es idéntico en las dos capas y no
   se mueve; solo se funde lo distinto. El repintado con calco es de Pharos; la
   foto del lugar, del remontar() de Apex. */

/**
 * La vista que se va no desaparece de un cuadro al otro: su contenido pasa a
 * un calco con la misma clase de `.ox-main`, en la misma celda de la grilla, y
 * se esfuma encima. Sin esto, la vieja se iba de golpe y la nueva arrancaba
 * desde transparente: un cuadro vacío en cada navegación.
 *
 * El calco va sin ids (nadie tiene que encontrar un #campo que se está yendo),
 * inerte, y conserva su scroll. Si la vista vieja todavía estaba entrando, el
 * calco arranca desde la opacidad y el corrimiento en que la agarró. Si ya
 * había otro calco yéndose, el nuevo va DEBAJO de ese, pegado a la vista: así
 * el cuadro siguiente es la misma composición que el anterior (lo que se iba
 * sigue a su opacidad, encima de lo que acaba de calcarse). Encima de todos,
 * el calco nuevo —opaco— tapaba de golpe lo que se iba: medido, lo que se veía
 * al 79 % pasaba a 0 % de un cuadro al otro. Quire lo tenía así.
 */
export function calcar(host) {
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
  // propia entrada (un bloque que se funde, una lista escalonada) volvía a
  // entrar desde cero adentro del calco que se está yendo: caía a opacidad 0
  // en el primer cuadro y reaparecía mientras la vista se esfumaba. Medido en
  // Chem Engine: 0 → 38 → 53 → 75 % con el calco bajando. Se dan por
  // terminadas; lo que gira para siempre (un spinner) sigue girando.
  for (const a of calco.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }

  exit(calco, { fallback: 260 });
  host.__calcadoEn = performance.now();
  // Hasta el cuadro siguiente, lo que se ponga en host no se pintó nunca (ver
  // recienCalcado). El tope es por si la ventana no está pintando.
  const marca = host.__sinPintar = {};
  const pintado = () => { if (host.__sinPintar === marca) host.__sinPintar = null; };
  requestAnimationFrame(pintado);
  setTimeout(pintado, 100);
  return calco;
}

/**
 * Si lo que hay en `host` es un estado intermedio que el calco —todavía casi
 * opaco— no dejó ver: otro calco encima lo mostraría. Lo miran repintar() y
 * el router: el que llega en ese rato va directo debajo del calco que ya está.
 *
 * Es «todavía no hubo un cuadro desde el calco» o «hace menos de 60 ms». Con
 * el reloj solo, un refresh() que tardaba (un innerHTML grande, armar
 * miniaturas, otros oyentes del aviso) se pasaba de los 60 ms antes del go()
 * de la MISMA tarea, que volvía a calcar: dos calcos, y el intermedio
 * asomando, justo con los documentos grandes (en la sonda, 80 ms de trabajo).
 * En la misma tarea no se pinta nada, así que eso se decide por cuadros. Con
 * la ventana oculta no hay cuadros y la marca dura hasta el tope (que en
 * segundo plano Chromium estira a un segundo): ahí vale solo el reloj, o un
 * segundo refresco con la ventana minimizada se quedaría sin foto del lugar.
 */
export function recienCalcado(host) {
  if (!host) return false;
  if (host.__sinPintar && document.visibilityState === 'visible') return true;
  return performance.now() - (host.__calcadoEn ?? -Infinity) < 60;
}

const INDICADORES = [
  { sel: '.ox-segmented', pseudo: '::before', x: '--seg-x', w: '--seg-w' },
  { sel: '.ox-tabs', pseudo: '::after', x: '--tab-x', w: '--tab-w' },
];

/** Mientras se asienta un repintado, countTo() no cuenta: escribe el valor.
    Cada uno con la pintada que asienta: si go() ya puso otra vista encima
    (ver asentar), la nueva cuenta como siempre. */
const asentando = new Set();
const asentandoAlgo = () => [...asentando].some((a) => a.root.__pinta === a.pinta);

/** El lugar de una vista, antes de repintarla. Se reconoce por ids. */
function fotografiar(root) {
  const f = { scrolls: [], indicadores: new Map(), revelados: [], foco: null };
  root.querySelectorAll('.ox-scroll').forEach((el) => f.scrolls.push(el.scrollTop));
  for (const ind of INDICADORES) {
    root.querySelectorAll(`${ind.sel}[id]`).forEach((el) => {
      // Lo que se VE, no el destino: si la cápsula venía viajando, sigue desde ahí.
      const cs = getComputedStyle(el, ind.pseudo);
      const x = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform).m41 : 0;
      f.indicadores.set(el.id, { ind, x, w: parseFloat(cs.width) || 0 });
    });
  }
  root.querySelectorAll('.ox-reveal.is-open[id]').forEach((el) => f.revelados.push(el.id));
  const act = document.activeElement;
  const dueño = act && root.contains(act) ? act.closest('[id]') : null;
  // Se reconoce por su id o por el data-value dentro de un grupo con id; si
  // no, no hay forma honesta de encontrar su gemelo y el foco no se devuelve.
  if (dueño && root.contains(dueño) && (dueño === act || act.dataset.value != null)) {
    f.foco = { id: dueño.id, valor: dueño === act ? null : act.dataset.value };
  }
  return f;
}

/** Lo que la vista tiene que ver ANTES de cablearse: revelados e indicadores. */
function devolverAlPintar(root, f) {
  for (const id of f.revelados) root.querySelector(`#${CSS.escape(id)}`)?.classList.add('is-open');
  for (const [id, { ind, x, w }] of f.indicadores) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el?.matches(ind.sel) || !w) continue;
    colocar(el, ind.pseudo, () => {
      el.style.setProperty(ind.x, `${x}px`);
      el.style.setProperty(ind.w, `${w}px`);
    });
  }
}

/**
 * Repinta `root` con `poner()`, que escribe lo nuevo. Si `root` ya tenía una
 * vista, es un fundido que no pierde el lugar (ver arriba) y devuelve true; si
 * estaba vacío, solo pinta.
 *
 * Si `root` se calcó hace un instante (el router, al navegar; una vista que
 * pinta «cargando» y el dato a los pocos ms), lo nuevo va directo debajo de
 * ese calco: otro en el medio dejaba ver un instante el estado intermedio
 * —encabezado sin cuerpo— y la pantalla bajaba de brillo (Pharos).
 */
export function repintar(root, poner) {
  const f = !recienCalcado(root) && root.firstChild ? fotografiar(root) : null;
  const calco = f ? calcar(root) : null;
  poner();
  if (!calco) return false;
  devolverAlPintar(root, f);
  asentar(root, f);
  return true;
}

/* Lo nuevo queda quieto debajo del calco: sus entradas se dan por terminadas
   (lo que gira para siempre sigue, y las transiciones también: una cápsula
   que viene de donde estaba tiene que llegar viajando). La excepción son los
   plegables: un .ox-plegable que nace visible se despliega desde 0 con una
   TRANSICIÓN (@starting-style), así que también hay que asentarlo, o crece
   debajo del fundido (asentarPlegables, abajo). Se hace dos veces: ahora,
   con lo que trajo el HTML, y al terminar la tarea, con lo que la vista haya
   arrancado al cablearse. Recién ahí se devuelven el scroll y el foco, que
   dependen del alto final. */
function asentar(root, f) {
  const terminar = () => {
    asentarPlegables(root);
    for (const a of root.getAnimations({ subtree: true })) {
      if (a.effect?.target === root) continue;
      if (a instanceof CSSTransition) {
        // El que ya había arrancado (algo forzó el estilo antes, como colocar
        // una cápsula), se termina. El de un pseudo no es un plegable.
        if (!a.effect?.pseudoElement && a.effect?.target?.matches?.(PLEGABLE)) a.finish();
        continue;
      }
      if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
  };
  /* `__pinta` cuenta las vistas que pasaron por root, y go() lo sube. Un
     refresh() y un go() en la misma tarea (shell-29) dejaban este pendiente
     corriendo sobre la vista NUEVA: le ponía a sus .ox-scroll el scroll de
     la vieja (en la sonda, B nacía en 0 y saltaba a 700), podía enfocar algo
     suyo por un id que coincidiera, le daba por terminadas sus entradas y sus
     countTo() escribían el valor en vez de contar. Pasaba también antes, con
     el calco doble. Si la vista ya es otra, no se toca nada. */
  const yo = { root, pinta: root.__pinta };
  asentando.add(yo);
  terminar();
  queueMicrotask(() => {
    asentando.delete(yo);
    if (root.__pinta !== yo.pinta) return;
    terminar();
    const scrolls = root.querySelectorAll('.ox-scroll');
    f.scrolls.forEach((top, i) => { if (scrolls[i] && top) scrolls[i].scrollTop = top; });
    // Si la vista ya puso el foco donde quería, se respeta.
    if (f.foco && (!document.activeElement || document.activeElement === document.body)) {
      const dueño = root.querySelector(`#${CSS.escape(f.foco.id)}`);
      const el = f.foco.valor != null
        ? dueño?.querySelector(`[data-value="${CSS.escape(f.foco.valor)}"]`)
        : dueño;
      el?.focus({ preventScroll: true });
    }
  });
}

const PLEGABLE = '.ox-plegable, .ox-plegable--ancho';

/**
 * Pone en su lugar, sin desplegarse, los plegables visibles de `root`: les
 * apaga la transición (`.is-placing`), fuerza el estilo y se la devuelve.
 * Si todavía no tenían estilo, nacen ya abiertos (@starting-style no tiene
 * con qué transicionar); si ya venían desplegándose, sacarles la transición
 * los corta en su alto final. Uno que se prende DESPUÉS con `hidden = false`
 * se despliega como siempre.
 *
 * Lo llama solo repintar(). Una vista que se monta navegando y no quiere que
 * los suyos crezcan debajo del calco (la barra de tinta de Quire, que nace
 * visible si la tinta estaba prendida) lo llama después de pintar. Es lo que
 * hace colocar() con las cápsulas, para los plegables. De css-13 (Quire).
 */
export function asentarPlegables(root) {
  if (!root) return;
  const sel = '.ox-plegable:not([hidden]), .ox-plegable--ancho:not([hidden])';
  const todos = [...root.querySelectorAll(sel)];
  if (root.matches?.(sel)) todos.unshift(root);
  if (!todos.length) return;
  for (const el of todos) el.classList.add('is-placing');
  for (const el of todos) void getComputedStyle(el).height;
  for (const el of todos) el.classList.remove('is-placing');
}

/* ── Campo numérico ─────────────────────────────────────────────────────────
   El spinner de `<input type=number>` es de Chromium y está tapado en el CSS.
   Esto le devuelve las flechas, ya dibujadas por nosotros.

   El input NO se reemplaza: sigue siendo el dueño del valor, del foco y del
   teclado. Por eso cada paso despacha `input` Y `change` con bubbles — quien
   escuchaba al campo antes de tener flechas sigue funcionando sin tocar nada.

   Mantener apretado repite, y acelera: un campo de copias que llega a 50 de a
   un click por vez no lo usa nadie. */

const ESPERA = 380;    // antes de empezar a repetir: distingue click de aguante
const PASO_LENTO = 110;
const PASO_RAPIDO = 45;
const ACELERA_A = 1200;   // ms aguantando antes de pasar a rápido

/**
 * Cablea un `.ox-stepper` (input + dos flechas).
 * onChange recibe el valor numérico ya acotado a min/max.
 */
export function bindStepper(root, onChange) {
  const input = root?.querySelector('input[type="number"]');
  if (!input) return () => {};

  const num = (attr, fallback) => {
    const v = parseFloat(input.getAttribute(attr));
    return Number.isFinite(v) ? v : fallback;
  };

  const leer = () => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : num('min', 0);
  };

  /** Los topes se releen en cada paso: el max suele depender de otra cosa. */
  const acotar = (v) => Math.min(num('max', Infinity), Math.max(num('min', -Infinity), v));

  const sync = () => {
    const v = leer();
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');
    if (arriba) arriba.disabled = v >= num('max', Infinity);
    if (abajo) abajo.disabled = v <= num('min', -Infinity);
  };

  function mover(dir) {
    /* Si el input ya se fue del documento, el listener del paso anterior repintó
       el panel entero y este quedó huérfano: su número no lo ve nadie, pero cada
       paso sigue despachando 'change' y volviendo a repintar. Acá se corta. */
    if (!input.isConnected) return false;

    const antes = leer();
    const v = acotar(antes + dir * num('step', 1));
    if (v === antes) { sync(); return false; }
    input.value = String(v);
    sync();
    // bubbles: los listeners suelen estar en el contenedor, no en el input.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onChange?.(v, input);
    return true;
  }

  let timer = null;
  function frenar() {
    clearTimeout(timer);
    timer = null;
    window.removeEventListener('pointerup', frenar);
    window.removeEventListener('pointercancel', frenar);
  }

  function arrancar(dir, desde) {
    const transcurrido = Date.now() - desde;
    if (!mover(dir)) { frenar(); return; }
    timer = setTimeout(() => arrancar(dir, desde), transcurrido > ACELERA_A ? PASO_RAPIDO : PASO_LENTO);
  }

  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    e.preventDefault();                 // que el campo no pierda el foco
    frenar();                           // nunca dos repeticiones sobre el mismo campo
    const dir = btn.dataset.step === 'up' ? 1 : -1;

    /* Soltar tiene que frenar SIEMPRE, y el pointerup no siempre llega hasta acá:
       si el primer paso hace que quien escucha repinte, este root sale del
       documento y el evento cae sobre los nodos nuevos. window sí lo ve. Se
       enganchan al apretar y los suelta frenar(), así no se acumulan. */
    window.addEventListener('pointerup', frenar);
    window.addEventListener('pointercancel', frenar);

    mover(dir);
    const desde = Date.now();
    timer = setTimeout(() => arrancar(dir, desde), ESPERA);
    /* La captura del puntero mantiene el aguante aunque el dedo se salga del
       botón. Si el paso de recién ya se llevó puesto el botón, tirar acá no
       importa: el freno de verdad está en window. */
    try { btn.setPointerCapture(e.pointerId); } catch { /* ya no está en el DOM */ }
  });

  input.addEventListener('input', sync);

  /* La primera vez, sin transición: una flecha que NACE en el tope ya está
     apagada, no se apaga. Con la opacidad en la transición (U4), si algo
     había forzado el estilo entre el paint() y este cableado, la flecha de
     abajo de un campo en 0 se fundía en cada montaje: 100 100 76 58 44 35 30
     27 25, al navegar y al repintar (debajo del fundido, que asentar() no
     corta porque solo termina los plegables). Lo de colocar() con las
     cápsulas: una clase que la apaga, forzar el estilo, sacarla. */
  root.classList.add('is-placing');
  sync();
  for (const b of root.querySelectorAll('[data-step]')) void getComputedStyle(b).opacity;
  root.classList.remove('is-placing');
  return sync;
}

/* ── Revelado de alto (grid 0fr → 1fr) ───────────────────────────────────── */
export function toggleReveal(el, open) {
  const next = open ?? !el.classList.contains('is-open');
  el.classList.toggle('is-open', next);
  return next;
}

/* ── Números que cuentan ────────────────────────────────────────────────────
   Un contador que salta de 0 a 1284 no se lee; uno que corre, sí. */
export function countTo(el, to, { from = 0, duration = 700, format = (n) => n } = {}) {
  // Repintando la misma vista, el número ya estaba en pantalla: volver a
  // contar desde 0 lo haría entrar de nuevo. Va el valor; si cambió, el
  // fundido del repintado lo muestra.
  if (asentandoAlgo()) { el.textContent = format(Math.round(to)); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Marca un valor que acaba de cambiar: destella y vuelve. */
export function tick(el) {
  el.classList.remove('ox-ticked');
  void el.offsetWidth;          // reinicia la animación
  el.classList.add('ox-ticked');
}

/* ── Lo que cambia con la app andando ───────────────────────────────────────
   Para lo que se pone al día SIN repintar la vista: un textContent o un
   innerHTML a secas cambian de un cuadro al otro. Las cuatro primeras nacieron
   en Finway y en Apex (cada una tenía su copia, en vivo.js); reconcile(), en
   Prism (Opal).
     numero(el, v)               un número suelto: en su lugar, con destello
     frase(el, html)             una frase: si cambiaron solo sus cifras,
                                 destella; si cambió la frase, relevo
     valor(el, html)             algo que cambia MUY seguido (las flechas de un
                                 stepper apretadas): siempre en su lugar
     deslizarAlto(el, cambio)    la caja va de su alto al nuevo, no salta
     deslizarAncho(el, cambio)   lo mismo a lo ancho (un ítem de una fila)
     reconcile(box, items)       una lista que se pone al día por clave */

/* Los tokens de motion.css, para lo que se anima desde JS. */
const T = { in: 280, out: 150, move: 280, size: 180, after: 80, step: 14 };
const EASE = 'cubic-bezier(.16, 1, .3, 1)';         // --ox-ease
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)';   // --ox-ease-both

const reducido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Una animación hecha desde JS que, si la ventana no pinta, igual termina. */
function settled(anim, ms, fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  anim.finished.then(go, () => {});
  setTimeout(go, ms);
}

/** Un número suelto (un contador, un monto): se reescribe en su lugar y
    destella en el acento. No se apaga: tipeando cambia en cada tecla, y
    apagarse y prenderse en cada una se leería como un parpadeo. El primer
    llenado (el elemento vacío) no es un cambio y no destella: por eso un
    contador del chrome nace vacío en el HTML, no en «0» —si no, el primer
    dato cuenta como cambio y queda teñido mientras se va el splash—. */
export function numero(el, v) {
  if (!el) return;
  const texto = String(v);
  if (el.textContent === texto) return;
  const primero = el.textContent === '';
  el.textContent = texto;
  if (!primero) tick(el);
}

const textoDe = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.textContent.trim();
};
/** La frase con los números tapados: «3 tomas» y «4 tomas» son la misma
    frase; «1 toma» y «2 tomas», no. */
const molde = (s) => s.replace(/\d[\d.,]*/g, '#');

/**
 * Una frase que se actualiza en vivo (`html` ya escapado). Si cambiaron solo
 * sus números, se reescribe en el lugar con un destello, como un número: un
 * relevo de la frase entera en cada tecla la apagaría y prendería sin parar.
 * Si cambió la frase, relevo; lo vacío entra o se va esfumándose.
 */
export function frase(el, html) {
  if (!el) return;
  // Durante un relevo el textContent junta lo que se va con lo que llega: por
  // eso se compara contra la última frase puesta, no contra el DOM.
  const viejo = el.__frase != null ? textoDe(el.__frase) : el.textContent.trim();
  const nuevo = textoDe(html);
  el.__frase = html;
  if (viejo === nuevo) return;
  const soloCifras = viejo !== '' && nuevo !== '' && molde(viejo) === molde(nuevo);
  swap(el, html, soloCifras ? {} : { relevo: true });
  if (soloCifras) tick(el);
}

/** Algo que cambia muy seguido (con las flechas apretadas, cada 45 ms): se
    reescribe SIEMPRE en el lugar con un destello, aunque cambien palabras
    («hasta el lunes» → «hasta el martes»). Un relevo en cada paso sería un
    parpadeo constante. La primera vez, lo que ya dice no es un cambio. */
export function valor(el, html) {
  if (!el || el.__valor === html) return;
  const primera = el.__valor == null && el.innerHTML === html;
  el.__valor = html;
  if (primera) return;
  swap(el, html);
  tick(el);
}

/* La caja va del alto `h0` al que tiene ahora. Mientras viaja recorta lo que
   sobra (el calco de un relevo, que conserva el alto viejo). */
function glideAlto(el, h0) {
  const h1 = el.getBoundingClientRect().height;
  if (Math.abs(h1 - h0) < 1 || reducido() || typeof el.animate !== 'function') return;
  el.__glide = el.animate([{ height: `${h0}px`, overflow: 'clip' }, { height: `${h1}px`, overflow: 'clip' }],
    { duration: T.size, easing: EASE_BOTH });
}

/**
 * Hace `cambio()` (que cambia el contenido de `el`) y desliza el alto de `el`
 * desde el que tenía hasta el nuevo, en vez de saltar. Para una caja que
 * cambia de forma adentro de un modal o una card: sin esto todo lo de abajo
 * —y el modal entero— cambiaba de alto en un cuadro (Apex, la zona de
 * cantidad al cambiar de sustancia).
 */
export function deslizarAlto(el, cambio) {
  if (!el) { cambio(); return; }
  // El alto que se VE (si venía deslizándose, desde donde iba), y recién
  // después se corta el viaje anterior: el alto nuevo se mide sin él.
  const h0 = el.getBoundingClientRect().height;
  el.__glide?.cancel();
  cambio();
  glideAlto(el, h0);
}

/* Lo mismo a lo ancho: la caja va del ancho `w0` al que tiene ahora. Lo de
   adentro no se acomoda en dos renglones mientras viaja: queda en uno y lo
   que sobra se recorta. */
function glideAncho(el, w0) {
  const w1 = el.getBoundingClientRect().width;
  if (Math.abs(w1 - w0) < 1 || reducido() || typeof el.animate !== 'function') return;
  el.__glideAncho = el.animate([
    { width: `${w0}px`, overflow: 'clip', whiteSpace: 'nowrap' },
    { width: `${w1}px`, overflow: 'clip', whiteSpace: 'nowrap' },
  ], { duration: T.size, easing: EASE_BOTH });
}

/**
 * deslizarAlto, a lo ancho: hace `cambio()` y el ancho de `el` va del que
 * tenía al nuevo. Para un ítem de una fila que cambia de texto (la
 * statusbar): sin esto cambiaba de ancho en un cuadro y todo lo que tenía a
 * la derecha saltaba. En Quire, el nombre del documento al cambiar de
 * pestaña, la impresora y el aviso de actualización (shell-22, shell-23).
 * Con un relevo adentro (swap con `relevo`) va solo: el calco conserva la
 * caja vieja y no cuenta para el ancho nuevo.
 */
export function deslizarAncho(el, cambio) {
  if (!el) { cambio(); return; }
  const w0 = el.getBoundingClientRect().width;
  el.__glideAncho?.cancel();
  cambio();
  glideAncho(el, w0);
}

/* ── Listas que se ponen al día ─────────────────────────────────────────────
   Rehacer una lista con innerHTML la hace parpadear: lo que estaba se va de
   un cuadro al otro y lo nuevo aparece todo junto, aunque sea casi lo mismo
   (buscar, filtrar, borrar una fila). Y con swap(…, { fundido }) las filas
   que cambian de lugar se cruzan con las de al lado. reconcile() la pone al
   día fila por fila, por clave:
   · las que siguen son el MISMO nodo, y viajan a su lugar nuevo (FLIP);
   · las que ya no están salen desde donde estaban, fuera del flujo;
   · las nuevas entran, y si había algo yéndose, esperan a que casi no se vea.
   Sirve también para las filas de una tabla (box = el <tbody>): la que se va
   lleva congelado el ancho de cada celda, porque una fila absoluta pierde el
   de sus columnas y se encogería mientras se esfuma.

   items: [{ key, html, ...lo que quieras }]. Opciones:
     update(el, item)   pone al día una fila que sigue y cuyo html cambió (sin
                        esto se le copian los atributos —las clases nuevas
                        corren con sus transiciones— y si cambió el contenido
                        se releva con un parpadeo corto)
     created(el, item)  después de crear una fila o reemplazar su contenido
                        (montar íconos)
     height             la caja va de su alto al nuevo
     enter              false: las nuevas aparecen sin animar
   De Prism (Opal), octubre de 2026. */
export function reconcile(box, items, { update, created, height = false, enter = true } = {}) {
  const was = new Map();
  const leaving = [];
  for (const el of box.children) {
    if (el.dataset.state === 'closing') continue;
    if (el.dataset.key != null && !was.has(el.dataset.key)) was.set(el.dataset.key, el);
    else leaving.push(el);    // lo que no tiene clave (un innerHTML de antes) también se va
  }
  const keep = new Set(items.map((it) => it.key));
  for (const [k, el] of was) if (!keep.has(k)) leaving.push(el);

  // Dónde estaba cada cosa: todas las lecturas antes de cualquier escritura.
  const box0 = box.getBoundingClientRect();
  const h0 = height ? box0.height : 0;
  const first = new Map();
  for (const el of box.children) if (el.dataset.state !== 'closing') first.set(el, el.getBoundingClientRect());
  const celdas = new Map(leaving.filter((el) => el.cells)
    .map((el) => [el, [...el.cells].map((c) => c.getBoundingClientRect().width)]));
  for (const el of was.values()) { el.__move?.cancel(); el.__move = null; }

  if (leaving.length && getComputedStyle(box).position === 'static') box.style.position = 'relative';
  for (const el of leaving) {
    const r = first.get(el);
    // Una fila de tabla absoluta deja de ser fila: sus celdas pierden el ancho
    // de las columnas. Se lo lleva puesto.
    celdas.get(el)?.forEach((w, i) => { el.cells[i].style.width = `${w}px`; });
    Object.assign(el.style, {
      position: 'absolute', margin: '0', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '0',
      top: `${r.top - box0.top - box.clientTop + box.scrollTop}px`,
      left: `${r.left - box0.left - box.clientLeft + box.scrollLeft}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
    el.dataset.state = 'closing';
    if (reducido()) { el.remove(); continue; }
    const op = Number(getComputedStyle(el).opacity) || 0;
    const anim = el.animate([{ opacity: op }, { opacity: 0 }], { duration: T.out, easing: EASE_BOTH, fill: 'forwards' });
    settled(anim, T.out + 200, () => el.remove());
  }

  const fresh = [];
  let prev = null;
  for (const it of items) {
    let el = was.get(it.key);
    if (!el) {
      el = hacerFila(it);
      fresh.push(el);
    } else if (el.__html !== it.html) {
      if (update) update(el, it); else ponerFila(el, it, created);
      el.__html = it.html;
    }
    // A su lugar, salteando lo que se está yendo (no cuenta para el orden).
    let want = prev ? prev.nextElementSibling : box.firstElementChild;
    while (want && want !== el && want.dataset.state === 'closing') want = want.nextElementSibling;
    if (want !== el) {
      box.insertBefore(el, want);
      if (!fresh.includes(el)) callar(el);   // moverlo le reinicia las animaciones de CSS
    }
    prev = el;
  }
  for (const el of fresh) { callar(el); created?.(el, el.__item); }

  if (!reducido()) {
    // Las que siguen viajan de donde estaban a donde quedaron.
    const vh = window.innerHeight;
    for (const el of was.values()) {
      if (!keep.has(el.dataset.key)) continue;
      const a = first.get(el);
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if ((a.bottom < 0 && b.bottom < 0) || (a.top > vh && b.top > vh)) continue;   // afuera: nadie lo ve
      el.__move = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: T.move, easing: EASE });
    }
    if (enter) {
      const wait = leaving.length ? T.after : 0;
      fresh.forEach((el, i) => {
        el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
          { duration: T.in, easing: EASE, delay: wait + Math.min(i, 16) * T.step, fill: 'backwards' });
      });
    }
  }

  if (height) { box.__glide?.cancel(); glideAlto(box, h0); }
  return { fresh, leaving };
}

function hacerFila(it) {
  const t = document.createElement('template');
  t.innerHTML = it.html.trim();
  const el = t.content.firstElementChild;
  el.dataset.key = it.key;
  el.__html = it.html;
  el.__inner = el.innerHTML;
  el.__item = it;
  return el;
}

/* Sin la entrada propia de la fila (la que tiene en su CSS para cuando la
   lista se pinta entera): de entrar se encarga reconcile(). Cancelada por la
   API, una animación de CSS no vuelve hasta que cambie su nombre, así que la
   salida de [data-state=closing] (exit()) sigue funcionando. */
function callar(el) {
  for (const a of el.getAnimations()) if (a instanceof CSSAnimation && a.effect?.getTiming().iterations !== Infinity) a.cancel();
}

/* Una fila que sigue pero cambió: los atributos se copian (las clases nuevas
   corren con sus transiciones de color), y el contenido, si cambió, se releva
   con un parpadeo corto en vez de cambiar de un cuadro al otro. */
function ponerFila(el, it, created) {
  const t = document.createElement('template');
  t.innerHTML = it.html.trim();
  const nu = t.content.firstElementChild;
  for (const { name } of [...el.attributes]) if (name !== 'data-key' && name !== 'data-state' && name !== 'style' && !nu.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of [...nu.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  el.__item = it;
  if (nu.innerHTML === el.__inner) return;
  el.__inner = nu.innerHTML;
  el.__next = nu;
  if (el.__blink) return;               // ya hay uno en curso: usa lo último que llegue
  if (reducido()) { el.replaceChildren(...nu.childNodes); el.__next = null; created?.(el, el.__item); return; }
  el.__blink = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: EASE_BOTH, fill: 'forwards' });
  settled(el.__blink, 200, () => {
    const latest = el.__next;
    el.__next = null;
    el.replaceChildren(...latest.childNodes);
    created?.(el, el.__item);
    el.__blink.cancel();
    el.__blink = null;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T.in - 100, easing: EASE });
  });
}
