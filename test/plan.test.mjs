/* ═══════════════════════════════════════════════════════════════════════════
   La aritmética de la imposición.

   Existe porque un folleto mal impuesto no se nota mirando el PDF: se nota
   después de imprimir, doblar y encontrar la página 5 donde iba la 3. Acá el
   orden se afirma número por número, sin gastar papel.

   Node pelado: plan.js no importa pdf-lib ni toca el DOM, justamente para que
   esto pueda correr así.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  MM, mm, planCon, resolverRango, paginasDelPlan, papelDelPlan, areaUtil, papelParaElDriver,
  encajar, celdasNup, ordenFolleto, mosaicoPoster, calcularHojas,
} from '../renderer/js/imposicion/plan.js';

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const cerca = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

/* Un documento A4 vertical de 8 páginas. */
const A4 = { anchoPt: 595.276, altoPt: 841.89 };
const doc = (n, geo = A4) => Array.from({ length: n }, (_, i) => ({ numero: i + 1, ...geo }));

console.log('\n1. Rango de páginas');
ok('"todo" da todas', resolverRango('todo', 5).join() === '1,2,3,4,5');
ok('"1-3, 8" mezcla tramo y suelta', resolverRango('1-3, 8', 20).join() === '1,2,3,8');
ok('un tramo al revés se recorre al revés', resolverRango('12-10', 20).join() === '12,11,10');
ok('"5-" llega hasta el final', resolverRango('5-', 7).join() === '5,6,7');
ok('recorta lo que se pasa del total', resolverRango('1-99', 3).join() === '1,2,3');
ok('ignora basura', resolverRango('1, xx, 3', 5).join() === '1,3');
ok('impares', paginasDelPlan(planCon({ subconjunto: 'impares' }), 6).join() === '1,3,5');
ok('pares e invertido', paginasDelPlan(planCon({ subconjunto: 'pares', invertir: true }), 6).join() === '6,4,2');

console.log('\n2. Papel y orientación');
ok('vertical por defecto con contenido vertical',
  !papelDelPlan(planCon(), doc(3)).apaisado);
ok('auto gira si el contenido es mayormente apaisado',
  papelDelPlan(planCon(), doc(3, { anchoPt: 841.89, altoPt: 595.276 })).apaisado);
ok('folleto siempre pide papel apaisado',
  papelDelPlan(planCon({ modo: 'folleto' }), doc(4)).apaisado);
ok('horizontal explícito manda',
  papelDelPlan(planCon({ orientacion: 'horizontal' }), doc(3)).apaisado);

console.log('\n3. Área imprimible — el vuelco de la Y');
/* Los números son los de la HP LaserJet P1102w, leídos del driver:
   origen 3,97 mm DESDE ARRIBA y 203,2 × 289 mm de extensión. */
const planHP = planCon({
  imprimible: { x: 3.97, y: 3.97, ancho: 203.2, alto: 289 },
});
const papelHP = papelDelPlan(planHP, doc(1));
const areaHP = areaUtil(planHP, papelHP);
ok('el ancho útil es el que reporta el driver', cerca(areaHP.ancho, mm(203.2)), String(areaHP.ancho));
ok('el alto útil también', cerca(areaHP.alto, mm(289)), String(areaHP.alto));
ok('el margen izquierdo es 3,97 mm', cerca(areaHP.x, mm(3.97)), String(areaHP.x));
/* 297 − 3,97 − 289 = 4,03 mm abajo. Si estuviera mal volcado daría 3,97 y el
   contenido saldría corrido casi medio milímetro para arriba. */
ok('el margen inferior es 4,03 mm, no 3,97', cerca(areaHP.y, mm(4.03)), String(aMMs(areaHP.y)));
ok('y arriba quedan los 3,97 originales',
  cerca(papelHP.alto - areaHP.y - areaHP.alto, mm(3.97)));
const areaLibre = areaUtil(planCon({ respetarNoImprimible: false, imprimible: planHP.imprimible }), papelHP);
ok('si no se respeta, el área es el papel entero', cerca(areaLibre.ancho, papelHP.ancho) && cerca(areaLibre.y, 0));

console.log('\n4. Encajar');
const celda = { x: 0, y: 0, ancho: 300, alto: 400 };
const ajuste = encajar({ ancho: 595.276, alto: 841.89 }, celda, { tipo: 'ajustar' });
ok('ajustar entra sin desbordar', !ajuste.desborda && cerca(ajuste.ancho, 282.8, 0.5), String(ajuste.ancho));
ok('y queda centrado', cerca(ajuste.x, (300 - ajuste.ancho) / 2) && cerca(ajuste.y, (400 - ajuste.alto) / 2));
const real = encajar({ ancho: 595.276, alto: 841.89 }, celda, { tipo: 'real' });
ok('tamaño real no escala y avisa que desborda', cerca(real.escala, 1) && real.desborda);
const reducir = encajar({ ancho: 100, alto: 100 }, celda, { tipo: 'reducir' });
ok('reducir no agranda lo chico', cerca(reducir.escala, 1));
const custom = encajar({ ancho: 200, alto: 200 }, celda, { tipo: 'custom', valor: 50 });
ok('custom aplica el porcentaje', cerca(custom.ancho, 100));
/* Una página apaisada en una celda vertical: girada aprovecha mucho más. */
const gira = encajar({ ancho: 841.89, alto: 595.276 }, { x: 0, y: 0, ancho: 400, alto: 600 }, { tipo: 'ajustar' });
ok('gira 90° cuando conviene', gira.rotacion === 90, `rot=${gira.rotacion}`);
const noGira = encajar({ ancho: 595.276, alto: 841.89 }, { x: 0, y: 0, ancho: 400, alto: 600 }, { tipo: 'ajustar' });
ok('y no gira cuando no conviene', noGira.rotacion === 0);
const sinGiro = encajar({ ancho: 841.89, alto: 595.276 }, { x: 0, y: 0, ancho: 400, alto: 600 }, { tipo: 'ajustar', rotarSiConviene: false });
ok('se le puede prohibir girar', sinGiro.rotacion === 0);

console.log('\n5. Celdas del N-up');
const area100 = { x: 0, y: 0, ancho: 100, alto: 100 };
const c2x2 = celdasNup(area100, { filas: 2, columnas: 2, orden: 'horizontal' });
ok('2×2 da cuatro celdas', c2x2.length === 4);
ok('la primera es la de ARRIBA a la izquierda', cerca(c2x2[0].x, 0) && cerca(c2x2[0].y, 50),
  JSON.stringify(c2x2[0]));
ok('la última es abajo a la derecha', cerca(c2x2[3].x, 50) && cerca(c2x2[3].y, 0));
const cInv = celdasNup(area100, { filas: 2, columnas: 2, orden: 'horizontal-inv' });
ok('horizontal invertido arranca por la derecha', cerca(cInv[0].x, 50) && cerca(cInv[0].y, 50));
const cVert = celdasNup(area100, { filas: 2, columnas: 2, orden: 'vertical' });
ok('vertical baja antes de correrse', cerca(cVert[1].x, 0) && cerca(cVert[1].y, 0));
const cSep = celdasNup(area100, { filas: 1, columnas: 2, separacion: 10 / MM });
ok('la separación sale del ancho de las celdas', cerca(cSep[0].ancho, 45), String(cSep[0].ancho));

console.log('\n6. Orden de folleto');
const f8 = ordenFolleto([1, 2, 3, 4, 5, 6, 7, 8]);
const comoTexto = (hs) => hs.map((h) => `${h.cara[0]}:${h.izquierda ?? '_'}|${h.derecha ?? '_'}`).join(' ');
ok('8 páginas → 8|1 2|7 6|3 4|5',
  comoTexto(f8) === 'f:8|1 d:2|7 f:6|3 d:4|5', comoTexto(f8));
ok('son 4 caras = 2 hojas físicas', f8.length === 4);
/* Cada página tiene que aparecer exactamente una vez. Un error de índice
   duplica una y pierde otra, y eso no se ve hasta imprimir. */
const usadas = f8.flatMap((h) => [h.izquierda, h.derecha]).filter(Boolean).sort((a, b) => a - b);
ok('cada página aparece una sola vez', usadas.join() === '1,2,3,4,5,6,7,8', usadas.join());

const f6 = ordenFolleto([1, 2, 3, 4, 5, 6]);
ok('6 páginas completan a 8 con blancos', comoTexto(f6) === 'f:_|1 d:2|_ f:6|3 d:4|5', comoTexto(f6));
ok('y los blancos caen al final del cuadernillo, no al principio',
  f6[0].derecha === 1 && f6[0].izquierda === null);

const fDer = ordenFolleto([1, 2, 3, 4], { encuadernacion: 'derecha' });
ok('encuadernado a la derecha espeja cada cara', comoTexto(fDer) === 'f:1|4 d:3|2', comoTexto(fDer));

const fCuad = ordenFolleto([1, 2, 3, 4, 5, 6, 7, 8], { porCuadernillo: 1 });
ok('cuadernillos de 1 hoja parten en dos bloques independientes',
  comoTexto(fCuad) === 'f:4|1 d:2|3 f:8|5 d:6|7', comoTexto(fCuad));

console.log('\n7. Mosaico del póster');
const m = mosaicoPoster({ ancho: 595.276, alto: 841.89 }, { x: 0, y: 0, ancho: 500, alto: 700 },
  { escala: 200, solape: 0 });
ok('al 200% no entra en una hoja', m.baldosas.length > 1, `${m.filas}×${m.columnas}`);
ok('las baldosas cubren todo el ancho del original',
  cerca(Math.max(...m.baldosas.map((b) => b.recorte.right)), 595.276, 1));
ok('y todo el alto', cerca(Math.min(...m.baldosas.map((b) => b.recorte.bottom)), 0, 1));
const m1 = mosaicoPoster({ ancho: 400, alto: 500 }, { x: 0, y: 0, ancho: 500, alto: 700 }, { escala: 100, solape: 0 });
ok('al 100% en una hoja grande es una sola baldosa', m1.baldosas.length === 1);
const mSol = mosaicoPoster({ ancho: 1000, alto: 500 }, { x: 0, y: 0, ancho: 500, alto: 700 },
  { escala: 100, solape: 25.4 });   // 25,4 mm = 72 pt
ok('el solape agrega material repetido entre baldosas',
  mSol.baldosas.length >= 2 && mSol.baldosas[1].recorte.left < mSol.baldosas[0].recorte.right,
  `${mSol.baldosas[0].recorte.right} vs ${mSol.baldosas[1]?.recorte.left}`);

console.log('\n8. Plan completo');
const simple = calcularHojas(planCon(), doc(7));
ok('simple: una hoja por página', simple.hojas.length === 7);
ok('y una colocación por hoja', simple.hojas.every((h) => h.colocaciones.length === 1));

const nup = calcularHojas(planCon({ modo: 'nup', nup: { filas: 2, columnas: 2, orden: 'horizontal' } }), doc(7));
ok('2×2 sobre 7 páginas da 2 hojas', nup.hojas.length === 2);
ok('la última hoja lleva las 3 que sobran', nup.hojas[1].colocaciones.length === 3);
ok('el resumen cuenta bien', nup.resumen.paginasOriginales === 7 && nup.resumen.hojas === 2);

const foll = calcularHojas(planCon({ modo: 'folleto' }), doc(8));
ok('folleto de 8 → 4 caras', foll.hojas.length === 4);
ok('con papel apaisado', foll.papel.apaisado);
ok('y dos por cara', foll.hojas[0].colocaciones.length === 2);
ok('la primera cara lleva la 8 a la izquierda y la 1 a la derecha',
  foll.hojas[0].colocaciones[0].pagina === 8 && foll.hojas[0].colocaciones[1].pagina === 1);
ok('y la 1 cae en la mitad derecha del papel',
  foll.hojas[0].colocaciones[1].x > foll.papel.ancho / 2 - 1);

const dup = calcularHojas(planCon({ modo: 'folleto', duplex: 'largo' }), doc(8));
ok('con dúplex, 4 caras son 2 hojas de papel', dup.resumen.hojasFisicas === 2);

const rango = calcularHojas(planCon({ rango: '2-4' }), doc(10));
ok('el rango filtra', rango.hojas.length === 3 && rango.hojas[0].colocaciones[0].pagina === 2);

const desb = calcularHojas(planCon({ escala: { tipo: 'real' }, imprimible: planHP.imprimible }), doc(2));
ok('avisa cuando el contenido se sale del área imprimible', desb.resumen.desborde);

/* ── 9. El papel que se le pide al driver ────────────────────────────────────
   Es el último dato que sale de la app antes del papel de verdad, y el único
   que el preview no puede mostrar. Si no describe la MISMA hoja que se escribió
   en el PDF, el driver se pone a encajar por su cuenta y el preview mintió.

   El bug que motivó esto: se mandaban MEDIDAS a medida en vez del nombre, y el
   driver de Windows se quedaba con el papel que ya tenía configurado (Carta).
   Una A5 se componía sobre la geometría de una Carta y salía corrida 69 mm,
   que es la diferencia de alto entre las dos hojas. */
console.log('\n9. El papel que se le pide al driver');
{
  const pedir = (plan, d) => papelParaElDriver(papelDelPlan(plan, d));
  const A5 = { nombre: 'A5', ancho: 148, alto: 210 };

  const a4 = pedir(planCon(), doc(3));
  ok('A4 se pide por su NOMBRE, no por sus medidas', a4.pageSize === 'A4', JSON.stringify(a4));
  ok('y parada', a4.landscape === false);

  const a5 = pedir(planCon({ papel: A5 }), doc(3));
  ok('A5 también', a5.pageSize === 'A5' && a5.landscape === false, JSON.stringify(a5));

  /* Acá estaba el otro bug: se declaraba el papel NOMINAL, que siempre está
     vertical, mientras el PDF llevaba páginas acostadas. */
  const foll = pedir(planCon({ modo: 'folleto' }), doc(4));
  ok('un folleto A4 pide la hoja ACOSTADA', foll.landscape === true, JSON.stringify(foll));
  // El PAPEL sigue siendo A4: acostar la hoja es orientación, no otro papel.
  ok('pero el papel sigue siendo A4', foll.pageSize === 'A4', JSON.stringify(foll));

  const hor = pedir(planCon({ orientacion: 'horizontal' }), doc(3));
  ok('y la orientación horizontal también acuesta', hor.landscape === true && hor.pageSize === 'A4');

  const cartaMM = { nombre: 'Carta', ancho: 215.9, alto: 279.4 };
  ok('Carta se reconoce por la medida', pedir(planCon({ papel: cartaMM }), doc(1)).pageSize === 'Letter');

  /* Los drivers reportan medidas redondeadas: una A4 puede llegar como 209,9.
     Si eso no se reconoce, se cae al camino de papel a medida — el que falla. */
  const casiA4 = { nombre: 'A4', ancho: 209.9, alto: 297.05 };
  ok('un A4 con la medida redondeada por el driver sigue siendo A4',
    pedir(planCon({ papel: casiA4 }), doc(1)).pageSize === 'A4');

  // Un tamaño que no es ninguno de los conocidos sí va por medidas, en micrones.
  const raro = pedir(planCon({ papel: { nombre: 'Ficha', ancho: 100, alto: 160 } }), doc(1));
  ok('un papel sin nombre va por medidas, en micrones',
    raro.pageSize.width === 100000 && raro.pageSize.height === 160000, JSON.stringify(raro));

  const calc = calcularHojas(planCon({ modo: 'folleto', papel: A5 }), doc(4));
  const delCalculo = papelParaElDriver(calc.papel);
  ok('el cálculo y el pedido describen la misma hoja',
    delCalculo.pageSize === 'A5' && delCalculo.landscape === true, JSON.stringify(delCalculo));
}

function aMMs(pt) { return (pt / MM).toFixed(2) + 'mm'; }

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
