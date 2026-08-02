/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — overlays
   Tooltip, toast, menú y modal. Todos se portalean a #ox-layer, todos entran y
   SALEN animados, y ninguno usa un primitivo del sistema: acá no hay title=
   amarillo ni confirm() de Chromium.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { exit, scrollFade } from './motion.js';

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

  function hide(immediate = false) {
    clearTimeout(timer);
    if (!current) return;
    const el = current;
    current = null;
    anchor = null;
    immediate ? el.remove() : exit(el, { fallback: 160 });
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

  function init(root = document) {
    root.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === anchor) return;
      clearTimeout(timer);
      // Si ya hay uno abierto, el siguiente entra sin demora: moverse entre
      // botones vecinos no debería reiniciar la espera cada vez.
      timer = setTimeout(() => show(el), current ? 60 : 420);
    });
    root.addEventListener('pointerout', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el && el === anchor) hide();
      else if (el) clearTimeout(timer);
    });
    // Un tooltip flotando sobre un click o un scroll es basura visual.
    root.addEventListener('pointerdown', () => hide(true));
    window.addEventListener('scroll', () => hide(true), true);
    window.addEventListener('blur', () => hide(true));
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
   * Toast.show({ title, text, tone: 'default'|'error', duration, icon })
   * duration:0 → se queda hasta que lo cierren.
   */
  function show({ title, text = '', tone = 'default', duration = 4200, icon } = {}) {
    const el = document.createElement('div');
    el.className = `ox-toast${tone === 'error' ? ' ox-toast--error' : ''}`;
    el.style.setProperty('--life', `${duration}ms`);

    const glyph = icon || (tone === 'error' ? 'alert' : 'info');
    el.innerHTML = `
      ${Icons.svg(glyph, 'ox-icon--sm')}
      <div class="ox-toast__main">
        <div class="ox-toast__title"></div>
        ${text ? '<div class="ox-toast__text"></div>' : ''}
      </div>
      <button class="ox-iconbtn ox-iconbtn--sm" data-close>${Icons.svg('close')}</button>
      ${duration ? '<span class="ox-toast__life"></span>' : ''}`;

    // textContent, no innerHTML: el contenido puede venir de un error real.
    el.querySelector('.ox-toast__title').textContent = title;
    if (text) el.querySelector('.ox-toast__text').textContent = text;

    ensure().appendChild(el);

    const close = () => exit(el, { fallback: 260 });
    el.querySelector('[data-close]').addEventListener('click', close);

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
    return { close };
  }

  return { show, error: (title, text) => show({ title, text, tone: 'error', duration: 7000 }) };
})();

/* ══ Menú ════════════════════════════════════════════════════════════════════
   items: { label, icon, key, danger, selected, onSelect } | { sep:true } | { groupLabel } */

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
        ${it.key ? `<span class="ox-menuitem__key">${it.key}</span>` : ''}
        ${it.selected ? Icons.svg('check', 'ox-icon--sm') : ''}`;
      b.querySelector('span.ox-truncate').textContent = it.label;
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

const Modal = (() => {
  let open = null;

  function close(result) {
    if (!open) return;
    const { scrim, anim, resolve, restore } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    exit(anim, { fallback: 300 });
    exit(scrim, { fallback: 300 });
    restore?.focus?.();
    resolve(result);
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    if (e.key !== 'Tab') return;
    // Trampa de foco: el tabulador no se escapa del modal.
    const f = [...open.anim.querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /**
   * Modal.show({ title, sub, body, actions, width, dismissible })
   * actions: [{ label, value, variant, autofocus }]  → resuelve con `value`.
   * body puede ser string HTML o un Node.
   */
  function show({ title, sub = '', body = '', actions = [], width, dismissible = true } = {}) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'ox-scrim';

      const anim = document.createElement('div');
      anim.className = 'ox-modal__anim';

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
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.className = `ox-btn ox-flashable ox-btn--${a.variant || 'ghost'}`;
        b.textContent = a.label;
        b.addEventListener('click', () => close(a.value));
        foot.appendChild(b);
        if (a.autofocus) setTimeout(() => b.focus(), 60);
      });

      modal.querySelector('[data-dismiss]')?.addEventListener('click', () => close(null));
      if (dismissible) scrim.addEventListener('click', () => close(null));

      anim.appendChild(modal);
      layer().append(scrim, anim);
      Icons.mount(modal);
      scrollFade(bodyEl);

      open = { scrim, anim, resolve, restore: document.activeElement };
      document.addEventListener('keydown', onKey, true);
      if (!actions.some((a) => a.autofocus)) {
        setTimeout(() => anim.querySelector('button,input,textarea')?.focus(), 60);
      }
    });
  }

  /** Confirmación destructiva: el rojo aparece acá porque algo se va a romper. */
  function confirm({ title, sub, confirmLabel = 'Confirmar', danger = false } = {}) {
    return show({
      title,
      sub,
      actions: [
        { label: 'Cancelar', value: false },
        { label: confirmLabel, value: true, variant: danger ? 'danger-solid' : 'primary', autofocus: true },
      ],
    }).then((v) => v === true);
  }

  return { show, confirm, close };
})();

export { Tooltip, Toast, Menu, Modal };
