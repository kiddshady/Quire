/* El auditor de anillos de foco, traído del humo de Onyx (9-bis).

   El anillo de base.css sale 3.5px por fuera del elemento. Si el elemento se
   ve entero pero esos 3.5px caen afuera de un contenedor que recorta (un
   .ox-scroll, el borde de la ventana) o encima del canto de una superficie
   (una card, el carril del segmentado), con Tab se ve cortado. Cada elemento
   se enfoca como con teclado y se mide su anillo REAL (solo las sombras
   duras: una difusa es elevación, no anillo), así los que van hacia adentro
   cuentan cero.

   Devuelve el código a evaluar en el renderer; `alcance` es un selector (por
   defecto, el documento entero). El resultado es la lista de cortes: vacía
   quiere decir que no se corta nada. OJO: la ventana tiene que tener el foco,
   o :focus-visible no se aplica y todo mide cero. */

const auditarAnillos = (alcance = null) => `(((scope) => {
  if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before{transition:none!important}</style>');
  const extent = (el) => {
    el.focus({ focusVisible: true, preventScroll: true });
    const s = getComputedStyle(el);
    let m = 0;
    for (const part of s.boxShadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset') || part.trim() === 'none') continue;
      const nums = part.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)/g, '').match(/-?[\\d.]+px/g) || [];
      const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
      if (blur > 0) continue;
      m = Math.max(m, spread + Math.max(Math.abs(x), Math.abs(y)));
    }
    if (s.outlineStyle !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor)) m = Math.max(m, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    el.blur();
    return m;
  };
  const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
  };
  const out = [];
  for (const el of scope.querySelectorAll(SEL)) {
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const R = extent(el);
    if (R <= 0.5) continue;
    const boxes = [{ who: 'ventana', l: 0, t: 0, r: innerWidth, b: innerHeight }];
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || /paint|strict|content/.test(s.contain)) {
        const ar = a.getBoundingClientRect();
        const l = ar.left + a.clientLeft; const t = ar.top + a.clientTop;
        boxes.push({ who: name(a), l, t, r: l + a.clientWidth, b: t + a.clientHeight });
      }
    }
    const e = 0.5;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      const surf = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none') && parseFloat(s.borderTopLeftRadius) > 0;
      if (!surf) continue;
      const ar = a.getBoundingClientRect();
      const g = [r.left - ar.left, r.top - ar.top, ar.right - r.right, ar.bottom - r.bottom];
      if (g.some((x) => x < -e)) continue;
      const det = g.map((x, i) => ['izq', 'arriba', 'der', 'abajo'][i] + ' ' + x.toFixed(1)).filter((_, i) => g[i] < R - e);
      if (det.length) { out.push(name(el) + '  roza ' + name(a) + '  [' + det.join(', ') + ']'); break; }
    }
    for (const bx of boxes) {
      const inside = r.left >= bx.l - e && r.top >= bx.t - e && r.right <= bx.r + e && r.bottom <= bx.b + e;
      if (!inside) break;
      const lados = [];
      if (r.left - R < bx.l - e) lados.push('izq ' + (r.left - bx.l).toFixed(1));
      if (r.top - R < bx.t - e) lados.push('arriba ' + (r.top - bx.t).toFixed(1));
      if (r.right + R > bx.r + e) lados.push('der ' + (bx.r - r.right).toFixed(1));
      if (r.bottom + R > bx.b + e) lados.push('abajo ' + (bx.b - r.bottom).toFixed(1));
      if (lados.length) { out.push(name(el) + '  ← ' + bx.who + '  [' + lados.join(', ') + ']'); break; }
    }
  }
  document.querySelectorAll('.ox-scroll, .ox-main, [class*="scroll"]').forEach((s) => { s.scrollTop = 0; s.scrollLeft = 0; });
  // Se saca al terminar: si quedaba, todo lo que se medía después en la misma
  // página corría sin transiciones (el pliegue de los recientes no animaba).
  document.getElementById('aud-notr')?.remove();
  return out;
}))(${alcance ? `document.querySelector(${JSON.stringify(alcance)})` : 'document'})`;

/* Y el otro lado: que ningún control enfocable se quede SIN anillo.

   El anillo de base.css era una sombra, y la sombra propia de un control (el
   filete y la elevación del botón secundario, la del primario, la de un
   switch, un select o una tarjeta de modo) le ganaba por ir en una hoja
   posterior: 39 controles de las seis vistas no mostraban nada con Tab. El
   anillo pasó a ser un outline, y esto lo cuida. Cuenta como anillo
   cualquiera de los que hay en la casa: el outline (el de base.css y los
   propios del visor, las pestañas, las filas), una sombra que aparece con el
   foco (el inset del segmentado y de los ítems de lista) o la del ::before
   (los controles de ventana). Los campos de texto quedan afuera: dicen el
   foco con su halo, y se les ve también al hacer clic. */
const auditarSinAnillo = (alcance = null) => `(((scope) => {
  if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before,*::after{transition:none!important}</style>');
  const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const anillo = (el) => {
    const s = getComputedStyle(el);
    const b = getComputedStyle(el, '::before');
    return { sombra: s.boxShadow, antes: b.boxShadow + '|' + b.outlineStyle + b.outlineColor,
      outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor) };
  };
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const txt = (el.getAttribute('aria-label') || el.dataset.tip || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
  };
  const out = [];
  const foco = document.activeElement;
  for (const el of scope.querySelectorAll(SEL)) {
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
    if (el.matches('.ox-input, .ox-textarea')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    el.blur();
    const quieto = anillo(el);
    el.focus({ focusVisible: true, preventScroll: true });
    if (document.activeElement !== el || !el.matches(':focus-visible')) { el.blur(); continue; }
    const enfocado = anillo(el);
    el.blur();
    if (!enfocado.outline && enfocado.sombra === quieto.sombra && enfocado.antes === quieto.antes) out.push(name(el));
  }
  foco?.focus?.({ preventScroll: true });
  document.getElementById('aud-notr')?.remove();
  return out;
}))(${alcance ? `document.querySelector(${JSON.stringify(alcance)})` : 'document'})`;

module.exports = { auditarAnillos, auditarSinAnillo };
