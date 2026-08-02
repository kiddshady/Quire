/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — command palette
   El centro de mando: Ctrl+K. En una app de teclado esto no es un extra, es la
   navegación principal — el rail es para el mouse, la palette es para las manos.

   El match es por subsecuencia (tipeás "rndg" y encontrás "Research Digest") y
   lo que coincide se ILUMINA en blanco, no se pinta de amarillo.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { exit, scrollFade } from './motion.js';

const commands = [];
let open = null;

/** Registra comandos. { id, label, group, icon, hint, run } */
export function register(list) {
  commands.push(...list);
}

export function clear() { commands.length = 0; }

/* ── Match por subsecuencia ────────────────────────────────────────────────
   Devuelve los índices que matchearon y un puntaje: premia matches al
   principio de palabra y contiguos, castiga los saltos largos. */
function match(text, query) {
  if (!query) return { hits: [], score: 0 };
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const hits = [];
  let score = 0;
  let from = 0;

  for (let i = 0; i < q.length; i++) {
    const at = lower.indexOf(q[i], from);
    if (at === -1) return null;
    const isWordStart = at === 0 || /[\s\-_/.]/.test(text[at - 1]);
    const isContiguous = hits.length && at === hits[hits.length - 1] + 1;
    score += isWordStart ? 12 : isContiguous ? 8 : 2;
    score -= Math.min(6, at - from);          // castigo por saltar lejos
    hits.push(at);
    from = at + 1;
  }
  score -= text.length * 0.05;                // ante empate, gana lo más corto
  return { hits, score };
}

function highlight(text, hits) {
  const set = new Set(hits);
  const frag = document.createDocumentFragment();
  let buffer = '';
  let marked = false;

  const flush = () => {
    if (!buffer) return;
    if (marked) {
      const m = document.createElement('mark');
      m.textContent = buffer;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(buffer));
    }
    buffer = '';
  };

  for (let i = 0; i < text.length; i++) {
    const isHit = set.has(i);
    if (isHit !== marked) { flush(); marked = isHit; }
    buffer += text[i];
  }
  flush();
  return frag;
}

function close() {
  if (!open) return;
  const { scrim, anim } = open;
  open = null;
  document.removeEventListener('keydown', onKey, true);
  exit(anim, { fallback: 300 });
  exit(scrim, { fallback: 300 });
}

function move(dir) {
  if (!open) return;
  const items = [...open.list.querySelectorAll('.ox-palette__item')];
  if (!items.length) return;
  const i = items.findIndex((el) => el.classList.contains('is-active'));
  const next = items[Math.min(items.length - 1, Math.max(0, i + dir))];
  items.forEach((el) => el.classList.remove('is-active'));
  next.classList.add('is-active');
  next.scrollIntoView({ block: 'nearest' });
}

function run() {
  const active = open?.list.querySelector('.ox-palette__item.is-active');
  if (!active) return;
  const cmd = commands.find((c) => c.id === active.dataset.id);
  close();
  // Corre después del cierre para que la salida del overlay no compita con
  // la transición de la vista que el comando dispara.
  setTimeout(() => cmd?.run?.(), 40);
}

function onKey(e) {
  if (!open) return;
  if (e.key === 'Escape')         { e.preventDefault(); e.stopPropagation(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter')     { e.preventDefault(); run(); }
}

function render(query) {
  const { list } = open;
  list.innerHTML = '';

  const scored = commands
    .map((c) => {
      const m = match(c.label, query);
      if (query && !m) return null;
      return { cmd: c, hits: m?.hits || [], score: m?.score || 0 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    list.innerHTML = `
      <div class="ox-empty" style="padding:32px 16px">
        ${Icons.svg('search')}
        <div class="ox-empty__text">Nada coincide con lo que escribiste.</div>
      </div>`;
    return;
  }

  let lastGroup = null;
  scored.forEach(({ cmd, hits }, i) => {
    // Los grupos solo se muestran sin filtro: al buscar, el orden es el ranking.
    if (!query && cmd.group && cmd.group !== lastGroup) {
      lastGroup = cmd.group;
      const g = document.createElement('div');
      g.className = 'ox-palette__group';
      g.textContent = cmd.group;
      list.appendChild(g);
    }

    const b = document.createElement('button');
    b.className = `ox-palette__item${i === 0 ? ' is-active' : ''}`;
    b.dataset.id = cmd.id;
    b.innerHTML = cmd.icon ? Icons.svg(cmd.icon) : '<span style="width:15px"></span>';

    const label = document.createElement('span');
    label.className = 'ox-truncate';
    label.appendChild(query ? highlight(cmd.label, hits) : document.createTextNode(cmd.label));
    b.appendChild(label);

    if (cmd.hint) {
      const h = document.createElement('span');
      h.className = 'ox-palette__item__hint';
      h.textContent = cmd.hint;
      b.appendChild(h);
    }

    b.addEventListener('click', run);
    b.addEventListener('pointerenter', () => {
      list.querySelectorAll('.ox-palette__item').forEach((el) => el.classList.remove('is-active'));
      b.classList.add('is-active');
    });
    list.appendChild(b);
  });
}

export function show() {
  if (open) return;

  const host = document.getElementById('ox-layer') || document.body;

  const scrim = document.createElement('div');
  scrim.className = 'ox-scrim';
  scrim.addEventListener('click', close);

  const anim = document.createElement('div');
  anim.className = 'ox-palette__anim';
  anim.innerHTML = `
    <div class="ox-palette" role="dialog" aria-modal="true">
      <div class="ox-palette__search">
        ${Icons.svg('search', 'ox-icon--lg')}
        <input class="ox-palette__input" placeholder="Buscar comandos, pipelines, agentes…" spellcheck="false" autocomplete="off">
      </div>
      <div class="ox-palette__list ox-scroll"></div>
      <div class="ox-palette__foot">
        <span class="ox-row"><span class="ox-kbd">${Icons.svg('keyUp')}</span><span class="ox-kbd">${Icons.svg('keyDown')}</span> navegar</span>
        <span class="ox-row"><span class="ox-kbd">${Icons.svg('keyEnter')}</span> ejecutar</span>
        <span class="ox-row"><span class="ox-kbd">Esc</span> cerrar</span>
      </div>
    </div>`;

  host.append(scrim, anim);

  const input = anim.querySelector('.ox-palette__input');
  const list = anim.querySelector('.ox-palette__list');
  open = { scrim, anim, input, list };

  input.addEventListener('input', () => render(input.value.trim()));
  render('');
  scrollFade(list);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => input.focus(), 40);
}

export function toggle() { open ? close() : show(); }

/** Cablea Ctrl+K / Cmd+K globalmente. */
export function init() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle();
    }
  });
}

export const Palette = { register, clear, show, close, toggle, init };
export default Palette;
