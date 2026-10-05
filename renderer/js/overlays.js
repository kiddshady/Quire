/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — overlays
   Tooltip, toast, menú y modal. Todos se portalean a #ox-layer, todos entran y
   SALEN animados, y ninguno usa un primitivo del sistema: acá no hay title=
   amarillo ni confirm() de Chromium.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { exit, scrollFade } from './motion.js';
import { tomarFoco, devolverFoco } from './foco.js';

const GAP = 8;      // separación entre el overlay y su ancla
const EDGE = 10;    // margen mínimo contra el borde de la ventana

function layer() {
  let el = document.getElementById('ox-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ox-layer';
    document.body.appendChild(el);
  }
  return el;
}

/** Mantiene un rectángulo dentro de la ventana. */
function clamp(x, y, w, h) {
  return [
    Math.min(Math.max(EDGE, x), window.innerWidth - w - EDGE),
    Math.min(Math.max(EDGE, y), window.innerHeight - h - EDGE),
  ];
}

/* ══ Tooltip ═════════════════════════════════════════════════════════════════
   Declarativo: data-tip="texto" y opcionalmente data-tip-side / data-tip-key.
   Reemplaza al title= nativo, que es amarillo, lento y no se puede estilar. */

const Tooltip = (() => {
  let current = null;
  let anchor = null;
  let timer = null;
  let left = -Infinity;  // cuándo se fue el último por salir de su ancla

  function hide(immediate = false) {
    clearTimeout(timer);
    if (!current) return;
    const el = current;
    current = null;
    anchor = null;
    if (immediate) el.remove();
    else { left = performance.now(); exit(el, { fallback: 160 }); }
  }

  function show(el) {
    hide(true);
    anchor = el;

    const tip = document.createElement('div');
    tip.className = 'ox-tooltip';
    tip.textContent = el.dataset.tip;
    if (el.dataset.tipKey) {
      const k = document.createElement('span');
      k.className = 'ox-tooltip__key';
      k.textContent = el.dataset.tipKey;
      tip.appendChild(k);
    }
    layer().appendChild(tip);
    current = tip;

    const a = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const side = el.dataset.tipSide || 'top';

    let x, y;
    if (side === 'bottom')      { x = a.left + a.width / 2 - t.width / 2; y = a.bottom + GAP; }
    else if (side === 'left')   { x = a.left - t.width - GAP;             y = a.top + a.height / 2 - t.height / 2; }
    else if (side === 'right')  { x = a.right + GAP;                      y = a.top + a.height / 2 - t.height / 2; }
    else                        { x = a.left + a.width / 2 - t.width / 2; y = a.top - t.height - GAP; }

    // Si arriba no entra, se da vuelta abajo (y viceversa).
    if (side === 'top' && y < EDGE) y = a.bottom + GAP;
    if (side === 'bottom' && y + t.height > window.innerHeight - EDGE) y = a.top - t.height - GAP;

    [x, y] = clamp(x, y, t.width, t.height);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  /* Moverse entre botones vecinos no reinicia la espera larga. No alcanza con
     mirar `current`: el pointerout del botón anterior llega ANTES que este
     pointerover y ya lo cerró. Por eso cuenta también el que se acaba de ir.
     La espera corta (100 ms) es lo que dura su salida: el nuevo aparece
     cuando el viejo terminó de irse, sin encimarse. Si el ancla se fue del
     DOM durante la espera, no hay dónde anclarlo: saldría en la esquina. */
  function programar(el, sigue = () => true) {
    clearTimeout(timer);
    const warm = current || performance.now() - left < 400;
    timer = setTimeout(() => { if (el.isConnected && sigue()) show(el); }, warm ? 100 : 420);
  }

  function init(root = document) {
    root.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === anchor) return;
      programar(el);
    });
    root.addEventListener('pointerout', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el && el === anchor) hide();
      else if (el) clearTimeout(timer);
    });

    /* Con el teclado también. Solo con el pointerover, el que recorre la
       ventana con Tab no veía ningún tooltip, y ahí viven los atajos
       (`data-tip-key`): Quire tenía una docena que la interfaz nunca decía
       (ux-17). Va cuando el foco es :focus-visible y llegó NAVEGANDO con el
       teclado: un campo de texto clickeado también es :focus-visible, y un
       tooltip encima de lo que se está por tipear estorba.

       Navegar es Tab, no cualquier tecla. Con «cualquier tecla» contaba como
       teclado el foco que pone un script después de una: el Enter o el Escape
       que cierran un modal (Modal.close devuelve el foco al botón que lo
       abrió, y ese foco es :focus-visible) o un atajo que enfoca un campo
       (Ctrl+F). Al cerrar el «Renombrar» de la sonda con Enter, a los 420 ms
       aparecía «Renombrar F2» encima del botón sin que nadie hubiera tabulado;
       en Quire, el tacho de «Borrar toda la tinta» al salir de su confirm.
       Cualquier otra tecla lo apaga, y también corta el que estaba por salir:
       el que tabula a un campo y empieza a escribir no lo ve aparecer encima.
       Una app que mueve el foco con otras teclas (las flechas de una barra)
       las suma acá. */
    let teclado = false;
    root.addEventListener('keydown', (e) => { teclado = e.key === 'Tab'; }, true);
    root.addEventListener('focusin', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === anchor || !teclado || !e.target.matches(':focus-visible')) return;
      programar(el, () => teclado && el.contains(document.activeElement));
    });
    root.addEventListener('focusout', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el && el === anchor) hide();
      else if (el) clearTimeout(timer);
    });

    // Un tooltip flotando sobre un click o un scroll es basura visual.
    root.addEventListener('pointerdown', () => { teclado = false; hide(true); });
    window.addEventListener('scroll', () => hide(true), true);
    // Volver a la ventana (Alt+Tab) le devuelve el foco al mismo botón: eso
    // no es tabular hasta él.
    window.addEventListener('blur', () => { teclado = false; hide(true); });
  }

  return { init, hide };
})();

/* ══ Toasts ══════════════════════════════════════════════════════════════════ */

const Toast = (() => {
  let host = null;

  function ensure() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'ox-toasts';
    layer().appendChild(host);
    return host;
  }

  /**
   * Toast.show({ title, text, tone: 'default'|'error', duration, icon, action })
   * duration:0 → se queda hasta que lo cierren.
   */
  function show({ title, text = '', tone = 'default', duration = 4200, icon, action } = {}) {
    const el = document.createElement('div');
    el.className = `ox-toast${tone === 'error' ? ' ox-toast--error' : ''}`;
    el.style.setProperty('--life', `${duration}ms`);

    const glyph = icon || (tone === 'error' ? 'alert' : 'info');
    el.innerHTML = `
      ${Icons.svg(glyph, 'ox-icon--sm')}
      <div class="ox-toast__main">
        <div class="ox-toast__title"></div>
        ${text ? '<div class="ox-toast__text"></div>' : ''}
        ${action ? '<button class="ox-btn ox-btn--secondary ox-btn--sm ox-toast__action"></button>' : ''}
      </div>
      <button class="ox-iconbtn ox-iconbtn--sm" data-close>${Icons.svg('close')}</button>
      ${duration ? '<span class="ox-toast__life"></span>' : ''}`;

    // textContent, no innerHTML: el contenido puede venir de un error real.
    el.querySelector('.ox-toast__title').textContent = title;
    if (text) el.querySelector('.ox-toast__text').textContent = text;

    ensure().appendChild(el);

    const close = () => exit(el, { fallback: 260 });
    el.querySelector('[data-close]').addEventListener('click', close);
    // action: { label, run } → un botón adentro del toast (Deshacer, Ver…). Al
    // apretarlo el toast se cierra y corre `run`. Es lo que permite que una
    // acción no pida permiso antes y aun así tenga vuelta atrás.
    if (action) {
      const btn = el.querySelector('.ox-toast__action');
      btn.textContent = action.label;
      btn.addEventListener('click', () => { close(); action.run?.(); });
    }

    if (duration) {
      let timer = setTimeout(close, duration);
      const life = el.querySelector('.ox-toast__life');
      // Hover pausa la cuenta: si te acercás a leerlo, no se te escapa.
      el.addEventListener('pointerenter', () => {
        clearTimeout(timer);
        if (life) life.style.animationPlayState = 'paused';
      });
      el.addEventListener('pointerleave', () => {
        if (life) life.style.animationPlayState = 'running';
        const left = life ? duration * (1 - (parseFloat(getComputedStyle(life).transform.split(',')[0].replace('matrix(', '')) || 0)) : 1200;
        timer = setTimeout(close, Math.max(900, left));
      });
    }
    return { close, el };
  }

  return { show, error: (title, text) => show({ title, text, tone: 'error', duration: 7000 }) };
})();

/* ══ Menú ════════════════════════════════════════════════════════════════════
   items: { label, icon, key, hint, danger, selected, disabled, onSelect }
          | { sep:true } | { groupLabel }
   `hint` es una aclaración atenuada después del nombre: las medidas de un
   papel, «del sistema» en la impresora predeterminada. */

const Menu = (() => {
  let open = null;

  function close(immediate = false) {
    if (!open) return;
    const { el, anchor, onClose } = open;
    open = null;
    anchor?.classList.remove('is-open');
    onClose?.();
    immediate ? el.remove() : exit(el, { fallback: 200 });
    document.removeEventListener('keydown', onKey, true);
  }

  function move(dir) {
    if (!open) return;
    const items = [...open.el.querySelectorAll('.ox-menuitem:not(:disabled)')];
    if (!items.length) return;
    const i = items.findIndex((it) => it.classList.contains('is-active'));
    const next = items[(i + dir + items.length) % items.length] || items[0];
    items.forEach((it) => it.classList.remove('is-active'));
    next.classList.add('is-active');
    next.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape')          { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter')      { e.preventDefault(); open.el.querySelector('.ox-menuitem.is-active')?.click(); }
  }

  function show(anchorEl, items, { align = 'start', onClose } = {}) {
    /* Volver a pedir el menú del MISMO ancla es cerrarlo.
       Sin esto el toggle no funciona y parece que el menú "rebota": el
       manejador de click-afuera deja pasar al ancla a propósito (si no, cerrar
       y reabrir competirían), así que el click llega al handler del botón, que
       llama a show() otra vez → cierra y reabre dentro del mismo gesto. */
    if (open && open.anchor === anchorEl) {
      close();
      return null;
    }
    close(true);

    const el = document.createElement('div');
    el.className = 'ox-menu ox-scroll';
    el.setAttribute('role', 'menu');

    items.forEach((it) => {
      if (it.sep) {
        el.insertAdjacentHTML('beforeend', '<div class="ox-menu__sep"></div>');
        return;
      }
      if (it.groupLabel) {
        const l = document.createElement('div');
        l.className = 'ox-menu__label';
        l.textContent = it.groupLabel;
        el.appendChild(l);
        return;
      }
      const b = document.createElement('button');
      b.className = `ox-menuitem${it.danger ? ' ox-menuitem--danger' : ''}${it.selected ? ' is-selected' : ''}`;
      b.setAttribute('role', 'menuitem');
      if (it.disabled) b.disabled = true;
      b.innerHTML = `
        ${it.icon ? Icons.svg(it.icon) : '<span style="width:14px"></span>'}
        <span class="ox-truncate"></span>
        ${it.hint ? '<span class="ox-menuitem__hint"></span>' : ''}
        ${it.key ? `<span class="ox-menuitem__key">${it.key}</span>` : ''}
        ${it.selected ? Icons.svg('check', 'ox-icon--sm') : ''}`;
      b.querySelector('span.ox-truncate').textContent = it.label;
      /* El hint se dibuja. Antes se descartaba en silencio, y tres menús de
         Quire lo mandaban: el papel con sus medidas y las impresoras con «del
         sistema» (ux-07). textContent: suele venir de un dato. */
      if (it.hint) b.querySelector('.ox-menuitem__hint').textContent = it.hint;
      b.addEventListener('click', () => { close(); it.onSelect?.(it); });
      el.appendChild(b);
    });

    layer().appendChild(el);
    scrollFade(el);
    anchorEl.classList.add('is-open');

    const a = anchorEl.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    let x = align === 'end' ? a.right - m.width : a.left;
    let y = a.bottom + 6;
    // Si abajo no entra, abre hacia arriba y cambia el origen de la animación.
    const flipUp = y + m.height > window.innerHeight - EDGE;
    if (flipUp) y = a.top - m.height - 6;
    el.style.setProperty('--origin', `${flipUp ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`);

    [x, y] = clamp(x, y, m.width, m.height);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.minWidth = `${Math.max(m.width, a.width)}px`;

    open = { el, anchor: anchorEl, onClose };
    document.addEventListener('keydown', onKey, true);
    /* Cierre por click afuera. El setTimeout evita que el mismo gesto que abrió
       el menú lo cierre. Se consulta `open.anchor` y no la variable capturada:
       si se abrió otro menú mientras este escuchador seguía armado, mirar el
       ancla vieja cerraría el menú nuevo apenas tocás su propio botón. */
    setTimeout(() => {
      document.addEventListener('pointerdown', function once(ev) {
        if (!open) return;                       // ya se cerró por otra vía
        if (open.el.contains(ev.target) || open.anchor.contains(ev.target)) {
          document.addEventListener('pointerdown', once, { once: true });
          return;
        }
        close();
      }, { once: true });
    }, 0);

    return { close };
  }

  return { show, close, get isOpen() { return !!open; } };
})();

/* ══ Modal ═══════════════════════════════════════════════════════════════════ */

/* Los campos de un renglón: ahí Enter es «listo» y no un salto de línea. */
const UN_RENGLON = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

const Modal = (() => {
  let open = null;

  /* Cierra el que está abierto. `pisado` lo pasa solo show(), cuando abre
     otro encima: el velo se queda para el nuevo y la caja sale en relevo. No
     es una opción de Modal.close: desde afuera, un close que dejara el velo
     puesto lo dejaría huérfano para siempre. */
  function cerrar(result, pisado = false) {
    if (!open) return;
    const { scrim, anim, resolve, restore } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    /* La caja que se va ya no contesta. data-state=closing no apaga los
       eventos y .ox-modal lleva pointer-events: auto: durante su salida se
       la podía clickear, y su botón llamaba a close(), que cierra al que
       esté abierto —el NUEVO—. Medido: el «Borrar todo» de abajo, a los
       40 ms, contestaba con su valor el modal de arriba. */
    anim.inert = true;
    if (pisado) anim.classList.add('ox-modal__anim--pisada');
    exit(anim, { fallback: 300 });
    if (!pisado) exit(scrim, { fallback: 300 });
    // Como estaba: el botón que abrió con un clic no vuelve con el anillo (foco.js).
    devolverFoco(restore);
    resolve(result);
  }
  const close = (result) => cerrar(result);

  /* El velo de un modal que se acaba de cerrar, si todavía se está yendo:
     el que abre ahora lo revive en vez de poner otro debajo (ver show). */
  function veloSaliendo() {
    const v = [...layer().children].reverse()
      .find((n) => n.classList.contains('ox-scrim') && n.dataset.state === 'closing');
    if (!v) return null;
    const op = +getComputedStyle(v).opacity;
    // Sin data-state, exit() ya no lo saca (ver exit en motion.js). Vuelve a
    // su opacidad desde donde iba: --ox-desde es el `from` de su animación.
    delete v.dataset.state;
    v.style.setProperty('--ox-desde', String(op));
    v.classList.add('ox-scrim--vuelve');
    return v;
  }

  /* Con una caja todavía saliendo, la nueva espera su turno (is-after). Si la
     de abajo se cerró en este mismo cuadro (close y show seguidos), también
     pasa a la salida del relevo: todavía no se movió, así que cambiarle la
     curva no salta. Si ya venía saliendo, se la deja como va. */
  function cajaSaliendo() {
    const a = [...layer().children]
      .find((n) => n.classList.contains('ox-modal__anim') && n.dataset.state === 'closing');
    if (!a) return false;
    const t = a.getAnimations()[0]?.currentTime;
    if (t == null || t < 17) a.classList.add('ox-modal__anim--pisada');
    return true;
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') {
      /* Si hay un menú abierto encima, el Escape es suyo. Los dos escuchan en
         `document` y en captura, así que gana el que se registró primero — y
         ese es el modal, que abrió antes. Sin esta guarda, desplegar un select
         adentro del diálogo y arrepentirse cerraba el diálogo entero y se
         llevaba todo lo tipeado. El que ya está saliendo no cuenta: sigue en
         el DOM hasta que termine su animación. */
      if (document.querySelector('.ox-menu:not([data-state="closing"])')) return;
      e.preventDefault(); e.stopPropagation(); close(null);
    }
    if (e.key !== 'Tab') return;
    // Trampa de foco: el tabulador no se escapa del modal.
    const f = [...open.anim.querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* Enter en un campo de un renglón resuelve con la acción primaria, como en
     cualquier diálogo de escritorio: sin esto, escribir «1-7, 12» en el rango
     de Quire y apretar Enter no hacía nada (ux-06, imprimir-16). Solo si hay
     UNA primaria y está prendida: una vista que apaga «Aplicar» mientras el
     dato no sirve tiene que poder frenarlo. Nunca con la roja
     (`danger-solid`): lo que no tiene vuelta atrás no sale de un Enter
     tipeado al pasar. Escucha en la burbuja del propio modal, así un campo
     que maneja su Enter (y llama a preventDefault) gana. */
  function alEnter(e) {
    if (!open || e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target.tagName !== 'INPUT' || !UN_RENGLON.has(e.target.type)) return;
    // Con un menú abierto encima (un select del diálogo), el Enter es suyo.
    if (document.querySelector('.ox-menu:not([data-state="closing"])')) return;
    const primarias = open.botones.filter(({ a }) => a.variant === 'primary');
    if (primarias.length !== 1 || primarias[0].b.disabled) return;
    /* El preventDefault no es de adorno: al cerrar, el foco vuelve al botón
       que abrió el modal, y el mismo Enter le llegaba como click y lo volvía
       a abrir. Medido en el humo. */
    e.preventDefault();
    close(primarias[0].a.value);
  }

  /* El foco de arranque, si ninguna acción pide `autofocus`: el primer campo
     del cuerpo —es lo que se viene a hacer—; si no hay, la acción primaria; si
     no, la primera del pie. Nunca la cruz del encabezado: antes iba al primer
     botón o campo del modal, que en orden es la cruz, y lo que se tipeaba no
     entraba a ningún lado. */
  function focoInicial(bodyEl, foot, botones) {
    const campo = [...bodyEl.querySelectorAll('input:not([type="hidden"]), textarea, select')]
      .find((el) => !el.disabled && el.getClientRects().length);
    return campo
      || botones.find(({ a, b }) => a.variant === 'primary' && !b.disabled)?.b
      || foot?.querySelector('button:not(:disabled)')
      || null;
  }

  /**
   * Modal.show({ title, sub, body, actions, width, dismissible })
   * actions: [{ label, value, variant, autofocus }]  → resuelve con `value`.
   * body puede ser string HTML o un Node.
   * El foco arranca en la acción con `autofocus`; sin ninguna, en el primer
   * campo del cuerpo (ver focoInicial). Enter en un campo de un renglón
   * resuelve con la única acción `primary` (ver alEnter).
   */
  function show({ title, sub = '', body = '', actions = [], width, dismissible = true } = {}) {
    return new Promise((resolve) => {
      /* Un modal abierto encima de otro lo pisa: el de abajo se contesta con
         null y sale con su exit(). Antes quedaba huérfano —su promesa no se
         resolvía nunca, y su velo y su caja se quedaban en el DOM, tapando
         la app aunque se cerrara el nuevo— (Quire, 2F). El velo NO se va: lo
         hereda el nuevo. Con uno saliendo y otro entrando se apilaban dos
         capas a .62 y la pantalla se oscurecía de golpe (medido: hasta .79)
         en el medio del cambio; el mismo velo queda quieto. Y si el de antes
         ya se había cerrado (close y show seguidos) y su velo todavía se iba,
         ese velo vuelve: el mismo oscurecimiento salía por ahí. */
      const heredado = open?.scrim || null;
      if (open) cerrar(null, true);
      const revivido = heredado ? null : veloSaliendo();
      const scrim = heredado || revivido || document.createElement('div');
      if (!revivido) scrim.className = 'ox-scrim';

      // Dos cajas que se reemplazan hacen un relevo, no se cruzan en el
      // centro (motion-timing, regla 2).
      const anim = document.createElement('div');
      anim.className = `ox-modal__anim${cajaSaliendo() ? ' is-after' : ''}`;

      const modal = document.createElement('div');
      modal.className = 'ox-modal';
      if (width) modal.style.width = `min(${width}px, calc(100vw - 96px))`;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      modal.innerHTML = `
        <div class="ox-modal__head">
          <div class="ox-grow">
            <div class="ox-modal__title"></div>
            ${sub ? '<div class="ox-modal__sub"></div>' : ''}
          </div>
          ${dismissible ? `<button class="ox-iconbtn" data-dismiss data-tip="Cerrar" data-tip-key="Esc">${Icons.svg('close')}</button>` : ''}
        </div>
        <div class="ox-modal__body ox-scroll"></div>
        ${actions.length ? '<div class="ox-modal__foot"></div>' : ''}`;

      modal.querySelector('.ox-modal__title').textContent = title;
      if (sub) modal.querySelector('.ox-modal__sub').textContent = sub;

      const bodyEl = modal.querySelector('.ox-modal__body');
      if (body instanceof Node) bodyEl.appendChild(body);
      else bodyEl.innerHTML = body;

      const foot = modal.querySelector('.ox-modal__foot');
      const botones = actions.map((a) => {
        const b = document.createElement('button');
        b.className = `ox-btn ox-flashable ox-btn--${a.variant || 'ghost'}`;
        b.textContent = a.label;
        // Atado a SU modal: aunque la caja se vuelva inerte al irse, un
        // click que ya venía en camino no le contesta al que la pisó.
        b.addEventListener('click', () => { if (open?.anim === anim) close(a.value); });
        foot.appendChild(b);
        return { a, b };
      });

      modal.querySelector('[data-dismiss]')?.addEventListener('click', () => { if (open?.anim === anim) close(null); });
      // En propiedad y no con addEventListener: un velo heredado traería el
      // oyente del modal de antes, y cerraría uno que no se deja descartar.
      scrim.onclick = dismissible ? () => close(null) : null;

      anim.appendChild(modal);
      // El heredado (o el revivido) ya está en la capa: moverlo le
      // reiniciaría la animación. La caja nueva va encima de todo.
      if (heredado || revivido) layer().append(anim);
      else layer().append(scrim, anim);
      Icons.mount(modal);
      scrollFade(bodyEl);

      open = { scrim, anim, resolve, restore: tomarFoco(), botones };
      document.addEventListener('keydown', onKey, true);
      anim.addEventListener('keydown', alEnter);
      setTimeout(() => {
        if (open?.anim !== anim) return;          // ya se cerró
        const el = botones.find(({ a }) => a.autofocus)?.b || focoInicial(bodyEl, foot, botones);
        el?.focus();
        // Un campo que ya trae un valor (renombrar) queda seleccionado: se
        // escribe encima, como en cualquier diálogo de escritorio.
        if (el?.tagName === 'INPUT' && UN_RENGLON.has(el.type)) el.select();
      }, 60);
    });
  }

  /** Confirmación destructiva: el rojo aparece acá porque algo se va a romper.
      Con `danger` el foco arranca en Cancelar: con él en el botón rojo, un
      Enter por reflejo borraba lo que no se recupera (Quire, «¿Borrar toda la
      tinta?», ux-09). */
  function confirm({ title, sub, confirmLabel = 'Confirmar', danger = false } = {}) {
    return show({
      title,
      sub,
      actions: [
        { label: 'Cancelar', value: false, autofocus: danger },
        { label: confirmLabel, value: true, variant: danger ? 'danger-solid' : 'primary', autofocus: !danger },
      ],
    }).then((v) => v === true);
  }

  /* isOpen: para que los atajos de una vista no actúen detrás del velo (en
     Quire, Ctrl+Z y Espacio llegaban al documento de atrás). Mientras sale ya
     cuenta como cerrado. */
  return { show, confirm, close, get isOpen() { return !!open; } };
})();

export { Tooltip, Toast, Menu, Modal };
