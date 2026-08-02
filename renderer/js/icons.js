/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — íconos
   Todo símbolo de la app es un SVG propio, dibujado sobre grilla de 16, trazo
   1.5 y puntas redondeadas. Cero emojis y cero glifos unicode: se renderizan
   distinto en cada máquina, no se les controla el peso ni el color, y rompen el
   trazo del resto. Un SVG se tiñe con currentColor y es idéntico en todos lados.

   Este es el set BASE: lo que necesita cualquier app de escritorio. Los íconos
   de tu dominio van en tu propio archivo y se suman con `Icons.add({...})` —
   así el set de Onyx queda estable y actualizable sin pisarte los tuyos.

   Uso:
     Icons.svg('play')                      → string SVG
     Icons.svg('play', 'ox-icon--sm')       → con clases extra
     <i data-icon="play"></i> + Icons.mount(root)   → reemplazo declarativo
     Icons.add({ miIcono: '<path d="…"/>' })        → sumar los propios
   ═══════════════════════════════════════════════════════════════════════════ */

const P = {
  /* ── Identidad ─────────────────────────────────────────────────────────────
     La marca de Onyx: una piedra tallada vista de frente. El canto exterior y
     la mesa del centro apagada — la misma jerarquía por elevación que rige todo
     el sistema, dicha en un símbolo de 16 px. */
  onyx: '<path d="M10.33 2.36H5.67L2.36 5.67v4.66l3.31 3.31h4.66l3.31-3.31V5.67z"/>'
      + '<path class="ox-brand__trail" d="M9.11 5.32H6.89L5.32 6.89v2.22l1.57 1.57h2.22l1.57-1.57V6.89z"/>',

  /* ── Navegación ────────────────────────────────────────────────────────── */
  home: '<path d="M2.4 6.9 8 2.2l5.6 4.7v6.1a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M6.3 14.2V9.4h3.4v4.8"/>',
  list: '<path d="M5.6 4h8.2M5.6 8h8.2M5.6 12h8.2"/><circle cx="2.6" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="2.6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2.6" cy="12" r=".9" fill="currentColor" stroke="none"/>',
  grid: '<rect x="2.2" y="2.2" width="5" height="5" rx="1.4"/><rect x="8.8" y="2.2" width="5" height="5" rx="1.4"/><rect x="2.2" y="8.8" width="5" height="5" rx="1.4"/><rect x="8.8" y="8.8" width="5" height="5" rx="1.4"/>',
  folder: '<path d="M2 4.4a1.6 1.6 0 0 1 1.6-1.6h2.5l1.5 1.9h4.8A1.6 1.6 0 0 1 14 6.3v5.3a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.6z"/>',
  settings: '<path d="M2 4.6h3.4M9.4 4.6H14M2 11.4h5.4M11.4 11.4H14"/><circle cx="7.4" cy="4.6" r="2"/><circle cx="9.4" cy="11.4" r="2"/>',
  sliders: '<path d="M3.2 2.4v11.2M8 2.4v11.2M12.8 2.4v11.2"/><circle cx="3.2" cy="10.6" r="1.7"/><circle cx="8" cy="5.4" r="1.7"/><circle cx="12.8" cy="9.4" r="1.7"/>',
  contrast: '<circle cx="8" cy="8" r="6.1"/><path d="M8 1.9a6.1 6.1 0 0 1 0 12.2z" fill="currentColor" stroke="none"/>',
  panel: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M9.9 2.8v10.4"/>',

  /* ── Acciones ──────────────────────────────────────────────────────────── */
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  minus: '<path d="M3.2 8h9.6"/>',
  close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  check: '<path d="M3.4 8.4 6.5 11.5 12.6 4.8"/>',
  search: '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14"/>',
  copy: '<rect x="6" y="6" width="8" height="8" rx="2"/><path d="M11 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M2.6 4.4h10.8M6 4.4V3.1a1.1 1.1 0 0 1 1.1-1.1h1.8A1.1 1.1 0 0 1 10 3.1v1.3"/><path d="M4.1 4.4l.6 8.1a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4l.6-8.1"/>',
  edit: '<path d="M8.6 3.2H4A1.8 1.8 0 0 0 2.2 5v7A1.8 1.8 0 0 0 4 13.8h7a1.8 1.8 0 0 0 1.8-1.8V7.4"/><path d="M11.4 1.9a1.6 1.6 0 0 1 2.3 2.3L8.4 9.5l-2.6.6.6-2.6z"/>',
  duplicate: '<rect x="2.2" y="2.2" width="7.4" height="7.4" rx="2"/><path d="M6.4 12.4v.2a1.4 1.4 0 0 0 1.4 1.2h4.6a1.4 1.4 0 0 0 1.4-1.4V7.8a1.4 1.4 0 0 0-1.2-1.4h-.2"/>',
  filter: '<path d="M2.2 3.8h11.6L9.4 9v4.2l-2.8-1.4V9z"/>',
  more: '<circle cx="8" cy="3.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="12.6" r="1.15" fill="currentColor" stroke="none"/>',
  moreH: '<circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  external: '<path d="M9.2 2.4h4.4v4.4M13.6 2.4 7.6 8.4"/><path d="M12 9.6V12a1.6 1.6 0 0 1-1.6 1.6H4A1.6 1.6 0 0 1 2.4 12V5.6A1.6 1.6 0 0 1 4 4h2.4"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.9.3l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.9-.3L3.4 8.4a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1"/>',
  download: '<path d="M8 2.4v7.8M4.7 7l3.3 3.3L11.3 7M2.8 13.4h10.4"/>',
  upload: '<path d="M8 10.6V2.8M4.7 6.1 8 2.8l3.3 3.3M2.8 13.4h10.4"/>',
  save: '<path d="M12.2 13.6H3.8a1.4 1.4 0 0 1-1.4-1.4V3.8a1.4 1.4 0 0 1 1.4-1.4h6.4l3.4 3.4v6.4a1.4 1.4 0 0 1-1.4 1.4z"/><path d="M5 2.4v3.8h5V2.4M5 13.6V9.4h6"/>',
  pin: '<path d="M6 2.4h4l-.6 4 2.2 2.4H4.4L6.6 6.4z"/><path d="M8 8.8v4.8"/>',
  retry: '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/><path d="M13.6 1.9v3.4h-3.4"/>',
  undo: '<path d="M3.2 7.4h7.4a3.4 3.4 0 0 1 0 6.8H6.4"/><path d="M6.1 4.1 2.8 7.4l3.3 3.3"/>',
  redo: '<path d="M12.8 7.4H5.4a3.4 3.4 0 0 0 0 6.8h4.2"/><path d="M9.9 4.1l3.3 3.3-3.3 3.3"/>',
  send: '<path d="M14 2 7.2 8.8M14 2 9.7 14.2 7.2 8.8 1.8 6.3z"/>',

  /* ── Transporte ────────────────────────────────────────────────────────── */
  play: '<path d="M5.6 3.4 12.6 8l-7 4.6z"/>',
  pause: '<path d="M6 3.4v9.2M10 3.4v9.2"/>',
  stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6"/>',

  /* ── Direcciones ───────────────────────────────────────────────────────── */
  chevronRight: '<path d="M6 3.4 10.6 8 6 12.6"/>',
  chevronLeft: '<path d="M10 3.4 5.4 8 10 12.6"/>',
  chevronDown: '<path d="M3.4 6 8 10.6 12.6 6"/>',
  chevronUp: '<path d="M3.4 10 8 5.4 12.6 10"/>',
  arrowRight: '<path d="M2.4 8h11.2M9.4 3.8 13.6 8l-4.2 4.2"/>',
  arrowLeft: '<path d="M13.6 8H2.4M6.6 3.8 2.4 8l4.2 4.2"/>',
  arrowUpRight: '<path d="M4.4 11.6 11.6 4.4M5.6 4.4h6v6"/>',

  /* ── Estado y aviso ────────────────────────────────────────────────────── */
  alert: '<path d="M8 2.3 14.4 13.4H1.6z"/><path d="M8 6.4v3.1M8 11.5v.6"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.6M8 4.9v.6"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.7"/>',
  calendar: '<rect x="2.2" y="3.4" width="11.6" height="10.4" rx="1.8"/><path d="M2.2 6.6h11.6M5.4 2v2.6M10.6 2v2.6"/>',
  bell: '<path d="M4.2 7a3.8 3.8 0 0 1 7.6 0c0 3 1.2 4.2 1.2 4.2H3s1.2-1.2 1.2-4.2z"/><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/>',
  zap: '<path d="M9.2 1.6 3.6 9h4l-.6 5.4L12.4 7H8.6z"/>',
  target: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.8"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/>',

  /* ── Datos y objetos ───────────────────────────────────────────────────── */
  file: '<path d="M9.2 1.9H5A1.8 1.8 0 0 0 3.2 3.7v8.6A1.8 1.8 0 0 0 5 14.1h6a1.8 1.8 0 0 0 1.8-1.8V5.5z"/><path d="M9.2 1.9v3.6h3.6"/>',
  layers: '<path d="M8 1.9 14 5.1 8 8.3 2 5.1z"/><path d="M2 10.9l6 3.2 6-3.2"/>',
  book: '<path d="M2.4 3.2a1.4 1.4 0 0 1 1.4-1.4H12a1.4 1.4 0 0 1 1.4 1.4v9.6a1.4 1.4 0 0 0-1.4-1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M2.4 10a1.4 1.4 0 0 1 1.4-1.4h9.6"/>',
  inbox: '<path d="M2 8.6h3.2l1 2h3.6l1-2H14"/><path d="M4.1 2.8h7.8l2.1 5.8v3.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.8V8.6z"/>',
  hash: '<path d="M5.4 2.2 4.2 13.8M11.8 2.2l-1.2 11.6M2.4 5.6h11.2M1.8 10.4h11.2"/>',
  terminal: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.6 6.2 6.8 8.4l-2.2 2.2M8.8 10.6h3"/>',
  globe: '<circle cx="8" cy="8" r="6.1"/><path d="M1.9 8h12.2"/><path d="M8 1.9a9.4 9.4 0 0 1 0 12.2 9.4 9.4 0 0 1 0-12.2z"/>',
  user: '<circle cx="8" cy="5.4" r="2.9"/><path d="M2.9 14.1a5.4 5.4 0 0 1 10.2 0"/>',
  tools: '<path d="M6 1.8v3.4M10 1.8v3.4M4.4 5.2h7.2v3.6a3.6 3.6 0 0 1-7.2 0zM8 12.4v1.8"/>',

  /* ── Seguridad y visibilidad ───────────────────────────────────────────── */
  lock: '<rect x="3" y="7" width="10" height="6.8" rx="2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
  key: '<circle cx="5" cy="8" r="2.7"/><path d="M7.7 8h6.3M12.2 8v2.4M10.1 8v1.8"/>',
  eye: '<path d="M1.4 8S4 3.4 8 3.4 14.6 8 14.6 8 12 12.6 8 12.6 1.4 8 1.4 8z"/><circle cx="8" cy="8" r="2.2"/>',
  eyeOff: '<path d="M6.3 3.7A6.4 6.4 0 0 1 8 3.4c4 0 6.6 4.6 6.6 4.6a12 12 0 0 1-2 2.6M4 4.8A11.7 11.7 0 0 0 1.4 8S4 12.6 8 12.6a6.7 6.7 0 0 0 2.4-.4"/><path d="M6.5 6.5a2.2 2.2 0 0 0 3 3M2.2 2.2l11.6 11.6"/>',

  /* ── Manipulación ──────────────────────────────────────────────────────── */
  grip: '<circle cx="6" cy="3.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="3.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="6" cy="12.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="12.4" r="1.1" fill="currentColor" stroke="none"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.6"/><path d="M7 5.2v3.6M5.2 7h3.6M10.4 10.4 14 14"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.6"/><path d="M5.2 7h3.6M10.4 10.4 14 14"/>',
  fit: '<path d="M2.2 5.8V3.4a1.2 1.2 0 0 1 1.2-1.2h2.4M10.2 2.2h2.4a1.2 1.2 0 0 1 1.2 1.2v2.4M13.8 10.2v2.4a1.2 1.2 0 0 1-1.2 1.2h-2.4M5.8 13.8H3.4a1.2 1.2 0 0 1-1.2-1.2v-2.4"/>',

  /* ── Teclas ────────────────────────────────────────────────────────────────
     También son SVG. Un ↑ o un ↵ unicode cambia de peso y de alto con cada
     fuente, y adentro de una tecla de 18 px eso se nota enseguida. */
  keyUp: '<path d="M8 13V3.4M3.9 7.5 8 3.4l4.1 4.1"/>',
  keyDown: '<path d="M8 3v9.6M3.9 8.5 8 12.6l4.1-4.1"/>',
  keyEnter: '<path d="M13.2 3.2v5.2a2 2 0 0 1-2 2H3.4"/><path d="M6.4 7.4 3.2 10.4l3.2 3"/>',

  /* ── Controles de ventana (trazo más fino, escala 12) ──────────────────── */
  winMin: '<path d="M2.5 8h11"/>',
  winMax: '<rect x="3" y="3" width="10" height="10" rx="1.4"/>',
  winRestore: '<rect x="2.6" y="5.4" width="8" height="8" rx="1.4"/><path d="M5.4 2.6h6.6a1.4 1.4 0 0 1 1.4 1.4v6.6"/>',
  winClose: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
};

function svg(name, extraClass = '') {
  const body = P[name];
  if (!body) {
    console.warn(`[Icons] no existe "${name}"`);
    return '';
  }
  const cls = extraClass ? `ox-icon ${extraClass}` : 'ox-icon';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}

/**
 * Suma los íconos de tu app al set base. Se llama una vez, al arrancar.
 * Avisa si pisás uno del sistema: casi siempre es un typo, no una intención.
 */
function add(set) {
  for (const [name, body] of Object.entries(set)) {
    if (P[name]) console.warn(`[Icons] "${name}" ya existía en el set base y fue reemplazado`);
    P[name] = body;
  }
}

/* El spinner es su propio caso: el arco recorre el círculo en vez de girar
   rígido, y la pista de atrás evita que el vacío se lea como un hueco. */
function spinner(extraClass = '') {
  return `<svg class="ox-icon ${extraClass}" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" opacity=".18"/>
    <circle cx="8" cy="8" r="6" style="animation: ox-arc 1.4s var(--ox-ease-both) infinite, ox-spin 1.6s linear infinite; transform-origin: center"/>
  </svg>`;
}

/* Reemplaza <i data-icon="nombre" data-icon-class="..."> por su SVG. */
function mount(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((el) => {
    const markup = svg(el.dataset.icon, el.dataset.iconClass || '');
    if (markup) el.outerHTML = markup;
  });
}

function has(name) { return Object.prototype.hasOwnProperty.call(P, name); }

export const Icons = { svg, spinner, mount, add, has, get names() { return Object.keys(P); } };
export default Icons;
