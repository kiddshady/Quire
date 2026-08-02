/* ═══════════════════════════════════════════════════════════════════════════
   OKLCH → sRGB, con las mismas matrices que usa el navegador.

   Existe por un motivo puntual: la paleta vive en oklch (para poder re-tintar
   toda la app con una variable) pero Electron solo entiende hex en el
   `backgroundColor` de la ventana. Alguien tiene que hacer la conversión, y
   hacerla a ojo es cómo se desincronizan los dos valores.

   Lo usan el test de tokens (verifica que no hayan divergido) y retint.mjs
   (los mantiene sincronizados cuando cambiás el matiz).
   ═══════════════════════════════════════════════════════════════════════════ */

/** @param {number} L 0..1 · @param {number} C croma · @param {number} Hdeg grados */
export function oklchToHex(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3; const m = m_ ** 3; const s = s_ ** 3;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const enc = (x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return `#${lin.map((x) => enc(x).toString(16).padStart(2, '0')).join('')}`;
}

/** Dos hex son "el mismo color" si no difieren más de 1 por canal: el redondeo
    de Chromium y el de acá pueden separarse en el último bit sin que se vea. */
export function sameColor(a, b, tol = 1) {
  if (!a || !b) return false;
  return [1, 3, 5].every((i) =>
    Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= tol);
}

/** Los presets de acento del sistema. El rojo no está: está reservado al fallo. */
export const ACCENTS = {
  luz:     { rgb: '240 243 247', hue: 258 },
  cian:    { rgb: '34 211 238',  hue: 205 },
  violeta: { rgb: '167 139 250', hue: 285 },
  verde:   { rgb: '74 222 128',  hue: 155 },
  ambar:   { rgb: '251 191 36',  hue: 60 },
};
