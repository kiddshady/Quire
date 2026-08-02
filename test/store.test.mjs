/* ═══════════════════════════════════════════════════════════════════════════
   Escritura atómica bajo concurrencia.

   Existe porque en una app real dos guardados del mismo archivo se solaparon y
   el segundo murió con ENOENT: el `.tmp` tenía nombre fijo y el primero en
   renombrar se lo llevaba. La escritura perdida no dio ningún error visible —
   solo un registro que quedó congelado a mitad. Un test secuencial nunca lo
   habría encontrado, por eso acá se dispara todo a la vez.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-store-'));
process.env.QUIRE_DATA = DIR;
const store = require('../src/store.cjs');

console.log('\n1. Escrituras simultáneas del mismo archivo');
const file = path.join(DIR, 'concurrente.json');

// 40 escrituras a la vez: el escenario que rompía antes.
const resultados = await Promise.allSettled(
  Array.from({ length: 40 }, (_, i) => store.writeJSON(file, { n: i })),
);
const fallidas = resultados.filter((r) => r.status === 'rejected');
ok('ninguna escritura falla', fallidas.length === 0,
  fallidas.slice(0, 2).map((f) => f.reason?.message).join(' · '));

ok('el archivo final es JSON válido y completo', (() => {
  try { return typeof JSON.parse(fs.readFileSync(file, 'utf8')).n === 'number'; } catch { return false; }
})());

ok('gana la última en encolarse', JSON.parse(fs.readFileSync(file, 'utf8')).n === 39);

const sobrantes = fs.readdirSync(DIR).filter((f) => f.includes('.tmp'));
ok('no quedan temporales tirados', sobrantes.length === 0, sobrantes.join(', '));

console.log('\n2. Bloqueo transitorio del destino (lo que pasa en Windows)');
const lockFile = path.join(DIR, 'bloqueado.json');
await store.writeJSON(lockFile, { v: 0 });
// Mantener el archivo abierto un rato simula el EPERM del rename en Windows.
const fh = fs.openSync(lockFile, 'r+');
const escritura = store.writeJSON(lockFile, { v: 99 });
setTimeout(() => fs.closeSync(fh), 120);
let sobrevivio = true;
try { await escritura; } catch (err) { sobrevivio = false; console.log('    →', err.message); }
ok('la escritura sobrevive al bloqueo', sobrevivio);
ok('y el valor nuevo quedó', JSON.parse(fs.readFileSync(lockFile, 'utf8')).v === 99);

console.log('\n3. Un JSON corrupto no borra los datos');
const roto = path.join(DIR, 'roto.json');
fs.writeFileSync(roto, '{ esto no es json');
const leido = await store.readJSON(roto, { fallback: true });
ok('devuelve el fallback', leido?.fallback === true);
ok('y aparta el archivo ilegible en vez de perderlo',
  fs.readdirSync(DIR).some((f) => f.startsWith('roto.json.corrupto-')),
  fs.readdirSync(DIR).join(', '));

console.log('\n4. Ajustes');
const base = await store.loadSettings();
ok('el primer arranque escribe los defaults', base.schema === store.SCHEMA && fs.existsSync(store.SETTINGS_FILE));
const parche = await store.saveSettings({ papelDefecto: 'A5' });
ok('guardar un parche no pisa el resto', parche.papelDefecto === 'A5' && parche.duplexAsistido === store.DEFAULT_SETTINGS.duplexAsistido);
// Una clave nueva del código tiene que aparecer en un archivo viejo.
await store.writeJSON(store.SETTINGS_FILE, { schema: store.SCHEMA, papelDefecto: 'A5' });
const completado = await store.loadSettings();
ok('las claves nuevas se completan solas', 'duplexAsistido' in completado && completado.papelDefecto === 'A5');

console.log('\n5. Colección');
const col = store.collection('tinta');
const id = await col.nextId('n');
ok('el primer id es n-0001', id === 'n-0001', id);
await Promise.all([
  col.save({ id, name: 'uno' }),
  col.save({ id: 'n-0002', name: 'dos' }),
  col.save({ id: 'n-0003', name: 'tres' }),
]);
const lista = await col.list();
ok('lista los tres', lista.length === 3, String(lista.length));
ok('se pueden releer', (await col.get('n-0002'))?.name === 'dos');
ok('el id siguiente sigue la cuenta', (await col.nextId('n')) === 'n-0004');
await col.remove('n-0002');
ok('borrar saca de la lista', (await col.list()).length === 2);

console.log('\n6. Un id no puede escapar de la carpeta de datos');
for (const malo of ['../fuera', 'a/b', '..\\..\\x', '', 'con espacio', '.oculto']) {
  let tiro = false;
  try { store.assertId(malo); } catch { tiro = true; }
  ok(`rechaza ${JSON.stringify(malo)}`, tiro);
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
