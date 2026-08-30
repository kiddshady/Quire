/* ═══════════════════════════════════════════════════════════════════════════
   El plegado: lo que hace que una palabra se encuentre.

   Todo lo que este archivo prueba son casos que aparecen en PDFs reales y que
   hacen que una búsqueda ingenua no encuentre nada — la ligadura, la tilde, el
   renglón cortado— más el MAPA, que es la parte que nadie mira hasta que un
   resaltado cae sobre la palabra de al lado.
   ═══════════════════════════════════════════════════════════════════════════ */
import {
  plegar, plegarConsulta, armarIndice, coincidencias, ubicar,
} from '../renderer/js/pdf/buscador.js';

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `\n         esperado ${JSON.stringify(b)}\n         obtenido ${JSON.stringify(a)}`);

console.log('\n1. Plegar');
eq('la ligadura se abre', plegar('oﬁcina').plano, 'oficina');
eq('la tilde se cae', plegar('Compensación').plano, 'compensacion');
eq('la diéresis también', plegar('pingüino').plano, 'pinguino');
/* La ñ es otra letra, no una ene con adorno: si se planchara, "año" y "ano"
   serían la misma palabra. Las vocales sí se planchan, que es lo que uno
   quiere al escribir una consulta a las apuradas. */
eq('la eñe NO se cae', plegar('año').plano, 'año');
// Escrita con el escape a la vista: en el editor se ve igual que la de arriba.
eq('ni descompuesta (n + tilde suelta)', plegar('a' + 'n' + '\u0303' + 'o').plano, 'año');
eq('así "ano" no encuentra "año"', plegarConsulta('ano') === plegar('año').plano, false);
eq('los espacios se colapsan', plegar('  hola \n\n  mundo  ').plano, 'hola mundo');
eq('la palabra partida se une', plegar('compen-\nsación').plano, 'compensacion');
eq('el guion de verdad se queda', plegar('anti-horario').plano, 'anti-horario');
eq('el guion blando desaparece', plegar('com­pensación').plano, 'compensacion');

/* El mapa es lo que deja volver del texto plegado al original. Una ligadura
   rinde DOS caracteres plegados que apuntan al mismo del original: sin eso, el
   resaltado se corre un lugar por cada ligadura de la página. */
console.log('\n2. El mapa vuelve al original');
eq('la ligadura ocupa dos y apunta a uno', plegar('oﬁcina').mapa, [0, 1, 1, 2, 3, 4, 5]);
eq('el espacio colapsado apunta al primer blanco', plegar('a   b').mapa, [0, 1, 4]);

console.log('\n3. La consulta');
eq('un espacio al final se conserva', plegarConsulta('el '), 'el ');
eq('uno al principio también', plegarConsulta(' el'), ' el');
eq('en el medio no cambia nada', plegarConsulta('el gato'), 'el gato');
eq('solo espacios no es consulta', plegarConsulta('   '), '');
eq('vacío tampoco', plegarConsulta(''), '');

/* El caso que más importa: los fragmentos son los pedazos en que el PDF guarda
   el texto, y una palabra buscada casi nunca cae adentro de uno solo. */
console.log('\n4. Buscar cruzando fragmentos');
const idx = armarIndice([
  { str: 'El estado', salto: true },
  { str: 'en compen-', salto: true },
  { str: 'sación de oﬁcina', salto: false },
]);
eq('el índice pega los fragmentos con su salto', idx.texto, 'El estado\nen compen-\nsación de oﬁcina');
eq('y el plegado los deja buscables', idx.plano, 'el estado en compensacion de oficina');

const trozo = (h) => idx.texto.slice(h.desde, h.hasta);
const una = (q) => coincidencias(idx, plegarConsulta(q));

ok('cruza el salto de renglón', una('estado en').length === 1);
eq('y devuelve las letras de la hoja, con el salto adentro', trozo(una('estado en')[0]), 'estado\nen');
ok('encuentra la palabra partida con guion', una('compensacion').length === 1);
eq('y se lleva el guion y el salto', trozo(una('compensacion')[0]), 'compen-\nsación');
ok('encuentra a través de la ligadura', una('oficina').length === 1);
eq('y resalta el glifo entero', trozo(una('oficina')[0]), 'oﬁcina');
ok('no le importan las mayúsculas', una('ESTADO').length === 1);
ok('lo que no está no aparece', una('bicicleta').length === 0);

/* Buscar "of" adentro de "oﬁcina" cae a la mitad de la ligadura. En la hoja esa
   ligadura es UNA letra: no se puede resaltar media. */
eq('media ligadura resalta la ligadura entera', trozo(una('of')[0]), 'oﬁ');

console.log('\n5. Repartir la coincidencia entre los fragmentos');
const h = una('estado en')[0];
eq('la que cruza toca dos fragmentos', ubicar(idx, h.desde, h.hasta), [
  { i: 0, a: 3, b: 9 },
  { i: 1, a: 0, b: 2 },
]);
const sola = una('oficina')[0];
eq('la que no cruza toca uno solo', ubicar(idx, sola.desde, sola.hasta), [{ i: 2, a: 10, b: 16 }]);

/* Un fragmento vacío no es un span con letras: si se colara en la lista, el
   resaltado intentaría medir un Range sobre un nodo que no existe. */
const conVacio = armarIndice([
  { str: 'hola', salto: false },
  { str: '', salto: true },
  { str: 'mundo', salto: false },
]);
const hm = coincidencias(conVacio, plegarConsulta('hola mundo'))[0];
eq('los fragmentos vacíos no entran', ubicar(conVacio, hm.desde, hm.hasta), [
  { i: 0, a: 0, b: 4 },
  { i: 2, a: 0, b: 5 },
]);

console.log('\n6. Repeticiones');
const rep = armarIndice([{ str: 'ana banana', salto: false }]);
eq('cuenta las que hay', coincidencias(rep, plegarConsulta('an')).length, 3);
eq('sin solaparse: "ana" en "banana" es una sola', coincidencias(rep, plegarConsulta('ana')).length, 2);

console.log('\n7. Una página sin texto');
const vacio = armarIndice([]);
eq('no tiene nada que buscar', coincidencias(vacio, plegarConsulta('lo que sea')).length, 0);
eq('y no rompe', vacio.texto, '');

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
if (fail) process.exit(1);
