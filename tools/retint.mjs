/* ═══════════════════════════════════════════════════════════════════════════
   Re-tinta una app Onyx entera, dejando los tres lugares en sincronía.

   El color de la app vive en tokens.css (en oklch), pero hay dos copias en hex
   que NO se pueden derivar en tiempo de ejecución:
     · main.cjs → el backgroundColor de la ventana, que es lo que usa el
       compositor de Windows para pintar el frame de minimizar→restaurar.
     · index.html → el fondo del splash, que pinta antes de que exista un token.

   Cambiar el matiz a mano y olvidarse de esos dos es exactamente cómo vuelve
   el destello. Este script los toca a los tres de una.

   Uso:
     node tools/retint.mjs --accent cian
     node tools/retint.mjs --hue 285 --tint 1.6
     node tools/retint.mjs --mono roboto
     node tools/retint.mjs --accent "34 211 238" --hue 205 --dir C:\\tools\\MiApp
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { oklchToHex, ACCENTS } from './oklch.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const DIR = path.resolve(args.get('dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const TOKENS = path.join(DIR, 'renderer', 'css', 'tokens.css');
const MAIN = path.join(DIR, 'main.cjs');
const HTML = path.join(DIR, 'renderer', 'index.html');

for (const f of [TOKENS, MAIN, HTML]) {
  if (!fs.existsSync(f)) {
    console.error(`No parece una app Onyx: falta ${path.relative(DIR, f)}`);
    process.exit(1);
  }
}

let css = fs.readFileSync(TOKENS, 'utf8');

/* ── Acento ──────────────────────────────────────────────────────────────── */
const accentArg = args.get('accent');
if (accentArg) {
  const preset = ACCENTS[accentArg.toLowerCase()];
  const rgb = preset ? preset.rgb : accentArg.trim();
  if (!/^\d{1,3} \d{1,3} \d{1,3}$/.test(rgb)) {
    console.error(`Acento inválido: "${accentArg}". Usá un preset (${Object.keys(ACCENTS).join(', ')}) o un triplete "R G B".`);
    process.exit(1);
  }
  css = css.replace(/(--ox-accent-rgb:\s*)[^;]+/, `$1${rgb}`);
  // Un preset trae su matiz: el gris de la app acompaña al acento, que es lo
  // que hace que se vea deliberado y no como un color pegado sobre un gris ajeno.
  if (preset && !args.has('hue')) args.set('hue', String(preset.hue));
  console.log(`  acento    → ${rgb}${preset ? ` (${accentArg})` : ''}`);
}

/* ── Familia monoespaciada ────────────────────────────────────────────────────
   Solo se aceptan las que existen como token `--ox-mono-*` en tokens.css. Es a
   propósito: apuntar --ox-mono a una familia que nadie declaró en fonts.css no
   da error, da una app que se ve bien acá y distinta en otra máquina. */
if (args.has('mono')) {
  const pedida = String(args.get('mono')).trim().toLowerCase();
  const disponibles = [...css.matchAll(/--ox-mono-([a-z0-9-]+):/g)].map((m) => m[1]);
  if (!disponibles.includes(pedida)) {
    console.error(`Mono inválida: "${pedida}". Declaradas en tokens.css: ${disponibles.join(', ')}.`);
    console.error('Para sumar una: el .woff2 en renderer/fonts/, su @font-face en fonts.css, y su token acá.');
    process.exit(1);
  }
  css = css.replace(/(--ox-mono:\s*)[^;]+/, `$1var(--ox-mono-${pedida})`);
  console.log(`  mono      → ${pedida}`);
}

/* ── Matiz y temperatura ─────────────────────────────────────────────────── */
if (args.has('hue')) {
  const hue = Number(args.get('hue'));
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) { console.error('--hue tiene que estar entre 0 y 360'); process.exit(1); }
  css = css.replace(/(--ox-hue:\s*)[^;]+/, `$1${hue}`);
  console.log(`  matiz     → ${hue}°`);
}
if (args.has('tint')) {
  const tint = Number(args.get('tint'));
  if (!Number.isFinite(tint) || tint < 0) { console.error('--tint tiene que ser un número ≥ 0'); process.exit(1); }
  css = css.replace(/(--ox-tint:\s*)[^;]+/, `$1${tint}`);
  console.log(`  temperat. → ×${tint}`);
}

fs.writeFileSync(TOKENS, css);

/* ── Propagar el hex ─────────────────────────────────────────────────────── */
const hue = Number(css.match(/--ox-hue:\s*([\d.]+)/)[1]);
const tint = Number(css.match(/--ox-tint:\s*([\d.]+)/)[1]);
const bg = css.match(/--ox-bg:\s*oklch\(([\d.]+)%\s*calc\(([\d.]+)\s*\*\s*var\(--ox-tint\)\)/);
if (!bg) {
  console.error('No pude leer --ox-bg de tokens.css. ¿Le cambiaste la forma a la declaración?');
  process.exit(1);
}
const hex = oklchToHex(Number(bg[1]) / 100, Number(bg[2]) * tint, hue);

const main = fs.readFileSync(MAIN, 'utf8').replace(/(const BG\s*=\s*')#[0-9a-fA-F]{6}(')/, `$1${hex}$2`);
fs.writeFileSync(MAIN, main);

const html = fs.readFileSync(HTML, 'utf8')
  .replace(/(#boot-splash\s*\{[\s\S]*?background:\s*)#[0-9a-fA-F]{6}/, `$1${hex}`);
fs.writeFileSync(HTML, html);

console.log(`  fondo     → ${hex}  (main.cjs + splash del index.html)`);
console.log('\nListo. Corré `npm test` para confirmar que los tres quedaron en sincronía.');
