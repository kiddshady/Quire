'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   El proceso principal, sin Electron.

   Lo que se prueba acá son las decisiones de src/ que no necesitan una
   ventana: qué archivo entra, qué se encola, cómo se nombra lo que se escribe,
   qué se le pide a la impresora. Casi todo salió de la auditoría de octubre
   de 2026 (los ids main-NN, imprimir-NN, herr-18 van en cada caso), y cada
   caso falla con el código de antes: así se probó.

   Corre con Node pelado. Los require de Electron de src/ son defensivos, así
   que cargan igual; donde hace falta un ipcMain o un contextBridge se le pone
   uno de mentira en el caché de require, al final y a propósito, para no
   contaminar lo de arriba.

   Lo que vive en main.cjs (la ventana fuera de pantalla con QUIRE_FUERA, la
   recarga cuando se cae el renderer) necesita Electron de verdad y no está
   acá: la caída la prueba test/caida.cjs.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-main-'));

/* Datos propios, antes de requerir nada de src/: store.cjs resuelve su raíz al
   cargarse. */
process.env.QUIRE_DATA = path.join(TMP, 'datos');

/* Un execFile con perilla, puesto ANTES de cargar impresion.cjs, que se lo
   guarda al cargarse. Por defecto pasa derecho al de verdad; los casos de las
   capacidades lo cambian para contar llamadas o simular un PowerShell roto. */
const execFileReal = childProcess.execFile;
const ps = { modo: 'real', llamadas: 0, salida: '[]' };
childProcess.execFile = function execFileDePrueba(archivo, args, opciones, cb) {
  if (archivo !== 'powershell.exe' || ps.modo === 'real') return execFileReal.call(this, archivo, args, opciones, cb);
  ps.llamadas++;
  /* Como el de verdad: contesta en otra vuelta del event loop, para que dos
     pedidos casi juntos se solapen. */
  setTimeout(() => {
    if (ps.modo === 'falla') cb(new Error('PowerShell no contestó'), '', 'PowerShell no contestó');
    else cb(null, ps.salida, '');
  }, 30);
  return null;
};

const { formatoDe, BYTES_CABECERA } = require('../src/firmas.cjs');
const documentos = require('../src/documentos.cjs');
const impresion = require('../src/impresion.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que algo deje de ser falsy, o se rinde y devuelve lo último. */
async function hasta(fn, ms = 3000) {
  const limite = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < limite) { await esperar(20); v = fn(); }
  return v;
}

const COBAYO = fs.readFileSync(path.join(RAIZ, 'renderer', 'vendor', 'cobayo.pdf'));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function archivo(nombre, ...partes) {
  const ruta = path.join(TMP, nombre);
  fs.writeFileSync(ruta, Buffer.concat(partes.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))));
  return ruta;
}

(async () => {
  /* ── Firmas ──────────────────────────────────────────────────────────────── */
  console.log('\n1. La firma del PDF puede venir corrida (main-07)');

  ok('con un BOM adelante sigue siendo un PDF',
    formatoDe(Buffer.concat([BOM, Buffer.from('%PDF-1.7\n')])) === 'pdf');
  ok('con espacios y un renglón adelante, también',
    formatoDe(Buffer.from('  \r\n%PDF-1.4\n')) === 'pdf');
  ok('en el byte 0, sin guion, como siempre', formatoDe(Buffer.from('%PDF')) === 'pdf');
  ok('pasado el primer KB ya no cuenta',
    formatoDe(Buffer.concat([Buffer.alloc(BYTES_CABECERA, 0x20), Buffer.from('%PDF-1.7')])) === null);
  ok('corrido hace falta el guion: «%PDF» suelto no alcanza',
    formatoDe(Buffer.from('hola %PDF y nada más')) === null);
  ok('un PNG con basura adelante no es un PNG',
    formatoDe(Buffer.from([0x20, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === null);

  /* ── Leer ────────────────────────────────────────────────────────────────── */
  console.log('\n2. Leer un archivo (main-07, main-17)');

  const conBom = archivo('con-bom.pdf', BOM, COBAYO);
  const leido = await documentos.leer(conBom, { reciente: false }).catch((e) => e);
  ok('un PDF con BOM adelante se abre', leido?.formato === 'pdf', leido?.message);
  ok('y viajan todos sus bytes, BOM incluido', leido?.bytes?.byteLength === COBAYO.length + 3,
    String(leido?.bytes?.byteLength));

  /* El archivo que no es PDF se rechaza mirando el primer KB, sin leerlo
     entero: readFile no se llega a llamar. */
  const noPdf = archivo('no-es.pdf', Buffer.alloc(256 * 1024, 0x41));
  const readFileReal = fsp.readFile;
  let lecturasEnteras = 0;
  fsp.readFile = (...a) => { lecturasEnteras++; return readFileReal(...a); };
  const rechazo = await documentos.leer(noPdf).then(() => null, (e) => e);
  fsp.readFile = readFileReal;
  ok('lo que no es PDF se rechaza', /encabezado %PDF/.test(rechazo?.message || ''), rechazo?.message);
  ok('sin cargarlo entero', lecturasEnteras === 0, `${lecturasEnteras} lecturas`);

  /* Los bytes de un archivo grande van como su propio ArrayBuffer: sin el
     slice() que copiaba el archivo entero en el main. */
  const grande = archivo('grande.pdf', COBAYO, Buffer.alloc(64 * 1024, 0x20));
  const sliceReal = ArrayBuffer.prototype.slice;
  let copias = 0;
  ArrayBuffer.prototype.slice = function sliceContado(...a) { copias++; return sliceReal.apply(this, a); };
  const doc = await documentos.leer(grande, { reciente: false }).finally(() => { ArrayBuffer.prototype.slice = sliceReal; });
  ok('un PDF de 64 KB no se copia para mandarlo', copias === 0 && doc.bytes.byteLength === COBAYO.length + 65536,
    `${copias} copias, ${doc.bytes.byteLength} bytes`);

  /* ── Recientes ───────────────────────────────────────────────────────────── */
  console.log('\n3. Recientes (main-08, main-17)');

  const RECIENTES = path.join(process.env.QUIRE_DATA, 'recientes.json');
  const leerRecientes = () => { try { return JSON.parse(fs.readFileSync(RECIENTES, 'utf8')).lista; } catch { return null; } };

  const uno = archivo('uno.pdf', COBAYO);
  await documentos.leer(uno);
  /* La anotación es una escritura con fsync: la apertura ya volvió y el
     archivo todavía no está. Con el await de antes, sí estaba. */
  ok('abrir no espera a que se escriba Recientes', !fs.existsSync(RECIENTES));
  ok('pero se escribe igual', (await hasta(() => leerRecientes()?.[0]?.ruta === uno)) === true,
    JSON.stringify(leerRecientes()));

  const cuatro = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((n) => archivo(n, COBAYO));
  await Promise.all(cuatro.map((r) => documentos.leer(r)));
  await hasta(() => leerRecientes()?.length === 5);
  const lista = (leerRecientes() || []).map((r) => path.basename(r.ruta));
  ok('cuatro abiertos a la vez quedan los cuatro', cuatro.every((r) => lista.includes(path.basename(r))),
    lista.join(', '));
  ok('y el de antes sigue', lista.includes('uno.pdf'), lista.join(', '));

  const pieza = archivo('pieza.pdf', COBAYO);
  await documentos.leer(pieza, { imagenes: true, reciente: false });
  await esperar(200);
  ok('con reciente:false no se anota (las piezas de Combinar)',
    !(leerRecientes() || []).some((r) => r.ruta === pieza));

  /* ── Combinar ────────────────────────────────────────────────────────────── */
  console.log('\n4. Un archivo malo no tira la tanda (main-08)');

  const gif = archivo('animado.gif', 'GIF89a basura');
  const tanda = await documentos.leerVarios([cuatro[0], gif, cuatro[1]], { imagenes: true, reciente: false })
    .catch((e) => ({ error: e }));
  ok('los buenos entran', tanda.leidos?.length === 2, tanda.error?.message || JSON.stringify(tanda.leidos?.map((d) => d.nombre)));
  ok('en el orden en que se eligieron', tanda.leidos?.[0]?.ruta === cuatro[0] && tanda.leidos?.[1]?.ruta === cuatro[1]);
  ok('y el malo vuelve con su nombre y su motivo',
    tanda.fallidos?.length === 1 && tanda.fallidos[0].nombre === 'animado.gif' && /No se reconoce/.test(tanda.fallidos[0].error),
    JSON.stringify(tanda.fallidos));

  /* ── Lo pendiente del doble click ────────────────────────────────────────── */
  console.log('\n5. Varios PDFs desde el Explorador con Quire cerrada (main-02)');

  const P = ['C:\\apuntes\\uno.pdf', 'C:\\apuntes\\dos.pdf', 'C:\\apuntes\\tres.pdf'];
  ok('arranca sin reclamar', documentos.yaReclamo() === false);
  for (const r of [P[0], P[1], P[0], P[2]]) documentos.encolar(r);
  documentos.encolar(null);
  const pendientes = documentos.tomarPendientes();
  ok('se encolan todos, en orden y sin repetir', JSON.stringify(pendientes) === JSON.stringify(P), JSON.stringify(pendientes));
  ok('reclamar los entrega una sola vez', documentos.tomarPendientes().length === 0);
  ok('y desde ahí van por evento', documentos.yaReclamo() === true);
  documentos.soltarReclamo();
  ok('un renderer que recarga vuelve a encolar', documentos.yaReclamo() === false);
  documentos.encolar(P[1]); documentos.encolar(P[2]);
  ok('el canal viejo da la primera', documentos.tomarPendiente() === P[1]);
  ok('y sin nada, null', documentos.tomarPendiente() === null);

  /* ── Escribir sin pisar ──────────────────────────────────────────────────── */
  console.log('\n6. Exportar dos veces a la misma carpeta (herr-18)');

  const CARPETA = path.join(TMP, 'export');
  fs.mkdirSync(CARPETA);
  const a = await documentos.escribir(CARPETA, 'pag-01.png', new Uint8Array([1]));
  const b = await documentos.escribir(CARPETA, 'pag-01.png', new Uint8Array([2]), { noPisar: true });
  const c = await documentos.escribir(CARPETA, 'pag-01.png', new Uint8Array([3]), { noPisar: true });
  ok('noPisar numera como el motor', path.basename(b) === 'pag-01 (2).png' && path.basename(c) === 'pag-01 (3).png',
    `${path.basename(b)} · ${path.basename(c)}`);
  ok('y lo de antes queda intacto', fs.readFileSync(a)[0] === 1);
  const [x, y] = await Promise.all([
    documentos.escribir(CARPETA, 'pag-02.png', new Uint8Array([4]), { noPisar: true }),
    documentos.escribir(CARPETA, 'pag-02.png', new Uint8Array([5]), { noPisar: true }),
  ]);
  ok('dos a la vez no se toman el mismo nombre', x !== y && fs.readFileSync(x)[0] !== fs.readFileSync(y)[0], `${x} · ${y}`);
  const d = await documentos.escribir(CARPETA, 'pag-01.png', new Uint8Array([9]));
  ok('sin la opción pisa, como siempre (el renderer de hoy)', d === a && fs.readFileSync(a)[0] === 9);
  const fuera = await documentos.escribir(CARPETA, '..\\..\\fuera.png', new Uint8Array([1]), { noPisar: true });
  ok('y el nombre sigue sin poder salirse de la carpeta', path.dirname(fuera) === CARPETA, fuera);

  /* ── Impresoras: nombres con tilde ───────────────────────────────────────── */
  console.log('\n7. Una impresora con tilde en el nombre (main-01)');

  if (process.platform === 'win32') {
    /* El preámbulo de PS_CAPACIDADES de verdad, con el execFile de verdad:
       lo que se prueba es la página de códigos de PowerShell 5.1. */
    const lineas = impresion.PS_CAPACIDADES.split('\n');
    const preambulo = lineas.slice(0, lineas.findIndex((l) => l.includes('$ErrorActionPreference')) + 1).join('\n');
    const nombre = 'Impresora habitación — 2º ñ';
    const salida = await impresion.correrPS(`${preambulo}\n@(@{ nombre = '${nombre}' }) | ConvertTo-Json -Compress`)
      .catch((e) => `error: ${e.message}`);
    let vuelta = null;
    try { vuelta = JSON.parse(salida.trim()).nombre; } catch { /* queda null */ }
    ok('PowerShell devuelve el nombre entero', vuelta === nombre, JSON.stringify(vuelta ?? salida));
  } else {
    console.log('  (sin PowerShell: se saltea)');
  }

  const caps = [{ nombre: 'Impresora habitación — 2º' }, { nombre: 'HP LaserJet Professional P 1102w' }];
  ok('el nombre exacto se encuentra', impresion.colaDe(caps, 'HP LaserJet Professional P 1102w') === caps[1]);
  ok('con U+FFFD y la raya cambiada por guion, también',
    impresion.colaDe([{ nombre: 'Impresora habitaci\uFFFDn - 2\uFFFD' }], 'Impresora habitación — 2º')?.nombre === 'Impresora habitaci\uFFFDn - 2\uFFFD');
  ok('si el esqueleto apunta a dos, no adivina',
    impresion.colaDe([{ nombre: 'Sala ñ' }, { nombre: 'Sala ó' }], 'Sala \uFFFD') === null);
  ok('lo que no está, no está', impresion.colaDe(caps, 'Otra impresora') === null);

  /* ── Impresoras: capacidades ─────────────────────────────────────────────── */
  console.log('\n8. Capacidades: la caché, los reintentos y el refresco (main-05, imprimir-22)');

  ps.modo = 'json';
  ps.salida = JSON.stringify([{ nombre: 'HP', maxCopias: null, duplex: ['OneSided', 'TwoSidedLongEdge'], tamanos: [] }]);
  ps.llamadas = 0;
  const [c1, c2] = await Promise.all([impresion.capacidades(), impresion.capacidades()]);
  ok('dos pedidos juntos lanzan un solo PowerShell', ps.llamadas === 1, `${ps.llamadas} llamadas`);
  ok('y los dos reciben lo mismo', c1 === c2 && c1[0]?.nombre === 'HP');
  ok('un driver que no informa el máximo de copias deja 999', c1[0]?.maxCopias === 999, String(c1[0]?.maxCopias));

  ps.llamadas = 0;
  await impresion.listar({ refrescar: true });
  ok('listar({ refrescar }) vuelve a preguntar', ps.llamadas === 1, `${ps.llamadas} llamadas`);
  await impresion.listar();
  ok('y sin refrescar usa la caché', ps.llamadas === 1, `${ps.llamadas} llamadas`);

  ps.modo = 'falla';
  ps.llamadas = 0;
  const vacia = await impresion.capacidades({ refrescar: true });
  ok('si PowerShell falla, la app sigue sin capacidades', Array.isArray(vacia) && vacia.length === 0);
  /* Pero el fracaso tampoco se cobra en cada impresión. Un PowerShell que
     falla siempre (bloqueado por directiva, el spooler colgado) se volvía a
     lanzar en cada imprimir() —fichaDeImpresora pide las capacidades— y se
     esperaba antes de mandar el trabajo: hasta los 25 s del timeout. */
  await impresion.capacidades();
  await impresion.listar();
  ok('enseguida, sin refrescar, no lo vuelve a lanzar', ps.llamadas === 1, `${ps.llamadas} llamadas`);
  ps.modo = 'json';
  const pedido = await impresion.capacidades({ refrescar: true });
  ok('refrescar reintenta igual', ps.llamadas === 2 && pedido[0]?.nombre === 'HP', `${ps.llamadas} llamadas`);

  ps.modo = 'falla';
  await impresion.capacidades({ refrescar: true });
  ps.modo = 'json';
  /* Un minuto después, sin esperarlo: Date.now() adelantado. */
  const ahoraReal = Date.now;
  Date.now = () => ahoraReal() + 61000;
  const otraVez = await impresion.capacidades().finally(() => { Date.now = ahoraReal; });
  ok('y el fracaso no queda para siempre: pasado el minuto, el próximo pedido reintenta',
    ps.llamadas === 4 && otraVez[0]?.nombre === 'HP', `${ps.llamadas} llamadas`);

  /* listar() cruza dos listas, y en Node no hay ventanas: deElectron daba []
     y no se cruzaba nada, así que contar PowerShells no probaba el orden. Se
     carga otra copia de impresion.cjs con un Electron de mentira que tiene
     una ventana con impresoras, como hace el test del actualizador. La copia
     de arriba sigue siendo la de Node pelado, y el caché de require vuelve a
     quedar como estaba. */
  const claveElectronImp = require.resolve('electron');
  const claveImpresion = require.resolve('../src/impresion.cjs');
  const impresionPelada = require.cache[claveImpresion];
  let deElectron = [{ name: 'HP', displayName: 'HP', isDefault: true, status: 0 }];
  require.cache[claveElectronImp] = {
    id: claveElectronImp, filename: claveElectronImp, loaded: true,
    exports: {
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [{ webContents: { getPrintersAsync: async () => deElectron } }] },
    },
  };
  delete require.cache[claveImpresion];
  const conVentana = require('../src/impresion.cjs');
  require.cache[claveImpresion] = impresionPelada;
  delete require.cache[claveElectronImp];

  const unaHP = (maxCopias) => JSON.stringify([{ nombre: 'HP', maxCopias, duplex: [], tamanos: [] }]);
  ps.salida = unaHP(5);
  const primera = await conVentana.listar();
  ok('listar cruza lo de Electron con las capacidades', primera[0]?.nombre === 'HP' && primera[0]?.maxCopias === 5,
    JSON.stringify(primera[0]));
  /* La impresora cambió (el driver nuevo informa otro máximo). Con el bug,
     «Releer impresoras» cruzaba con la caché vieja y recién después
     refrescaba: el primer clic seguía dando 5. */
  ps.salida = unaHP(7);
  const releida = await conVentana.listar({ refrescar: true });
  ok('«Releer impresoras» cruza con lo recién leído, en un solo clic', releida[0]?.maxCopias === 7,
    String(releida[0]?.maxCopias));

  /* Y el cruce usa colaDe: el nombre que da Electron está bien, el de
     PowerShell llega mal decodificado (main-01), y la fila tiene que salir con
     sus tamaños y su dúplex igual. */
  deElectron = [{ name: 'Impresora habitación', displayName: 'Impresora habitación', isDefault: false, status: 0 }];
  ps.salida = JSON.stringify([{
    nombre: 'Impresora habitaci�n', maxCopias: 3, duplex: ['OneSided', 'TwoSidedLongEdge'],
    tamanos: [{ nombre: 'A4', ancho: 793.7, alto: 1122.5, imprimible: null }],
  }]);
  const conTilde = (await conVentana.listar({ refrescar: true }))[0];
  ok('una impresora con el nombre mal decodificado sale con sus tamaños',
    conTilde?.nombre === 'Impresora habitación' && conTilde?.tamanos?.length === 1 && conTilde?.soportaDuplex === true,
    JSON.stringify(conTilde));
  ps.modo = 'real';

  /* ── Impresoras: lo demás ────────────────────────────────────────────────── */
  console.log('\n9. Papeles, etiquetas y tiempos (imprimir-19, imprimir-26, main-06)');

  /* Los papeles que el plan nombra tienen que poder pedirse. El día que el
     plan sume uno y main no, este test lo dice antes que la impresora. */
  const plan = fs.readFileSync(path.join(RAIZ, 'renderer', 'js', 'imposicion', 'plan.js'), 'utf8');
  const bloque = plan.match(/const PAPELES_CON_NOMBRE = \[([\s\S]*?)\];/)?.[1] || '';
  const delPlan = [...bloque.matchAll(/\['([^']+)'/g)].map((m) => m[1]);
  const deMain = impresion.papelesConNombre();
  ok('se leyeron los papeles del plan', delPlan.length >= 10, delPlan.join(', '));
  ok('todo papel que nombra el plan se puede pedir por nombre',
    delPlan.every((p) => deMain.includes(p)), delPlan.filter((p) => !deMain.includes(p)).join(', '));
  ok('A0 viaja como paper=A0', impresion.ajustesDeImpresion({ pageSize: 'A0', copies: 1 }).includes('paper=A0'));
  ok('un nombre fuera de la lista no viaja',
    !impresion.ajustesDeImpresion({ pageSize: 'A4;rm', copies: 1 }).includes('paper='));

  ok('las etiquetas de hoy pasan', ['simple', 'nup', 'folleto', 'poster', 'frentes', 'dorsos']
    .every((e) => impresion.etiquetaSegura(e) === e));
  ok('una etiqueta con ruta no entra al nombre del temporal', impresion.etiquetaSegura('/../../x') === 'trabajo');
  ok('ni una con espacios o mayúsculas', impresion.etiquetaSegura('Mi Trabajo') === 'trabajo');
  ok('ni una larga', impresion.etiquetaSegura('a'.repeat(25)) === 'trabajo');
  ok('sin etiqueta, «trabajo»', impresion.etiquetaSegura(undefined) === 'trabajo');

  ok('sin páginas, los 120 s de siempre', impresion.tiempoDelAyudante(undefined) === 120000);
  ok('un trabajo corto no baja de 120 s', impresion.tiempoDelAyudante(4) === 120000);
  ok('uno de 100 páginas tiene 30 s más 3 s por página', impresion.tiempoDelAyudante(100) === 330000,
    String(impresion.tiempoDelAyudante(100)));
  ok('con techo de una hora', impresion.tiempoDelAyudante(1e9) === 3600000);
  ok('y un número raro se ignora', impresion.tiempoDelAyudante('muchas') === 120000 && impresion.tiempoDelAyudante(-3) === 120000);

  /* ── El puente ───────────────────────────────────────────────────────────── */
  console.log('\n10. Los canales nuevos, del preload al main (main-02, main-20, herr-18, ux-12, imprimir-19)');

  /* Un Electron de mentira en el caché de require, solo para ipc.cjs y
     preload.cjs, que se cargan recién acá. Lo de arriba ya se cargó con el de
     verdad (Node pelado) y no se entera. */
  const handlers = new Map();
  const invocados = [];
  let expuesto = null;
  const claveElectron = require.resolve('electron');
  require.cache[claveElectron] = {
    id: claveElectron, filename: claveElectron, loaded: true,
    exports: {
      app: { getName: () => 'Quire', getVersion: () => '0.0.0' },
      ipcMain: { handle: (canal, fn) => handlers.set(canal, fn) },
      contextBridge: { exposeInMainWorld: (_n, api) => { expuesto = api; } },
      ipcRenderer: { invoke: async (canal, ...args) => { invocados.push({ canal, args }); return { ok: true, data: null }; } },
      webUtils: { getPathForFile: () => null },
    },
  };
  const conversion = require('../src/conversion.cjs');
  require('../src/ipc.cjs').register();
  require('../preload.cjs');

  const llamar = (canal, ...args) => handlers.get(canal)?.({}, ...args);

  ok('conv:cancelar existe', handlers.has('conv:cancelar'));
  const sinCancelar = await llamar('conv:cancelar');
  ok('sin conversion.cancelar contesta false en vez de romper',
    sinCancelar?.ok === true && sinCancelar.data === false, JSON.stringify(sinCancelar));
  conversion.cancelar = () => true;
  ok('con conversion.cancelar, la llama', (await llamar('conv:cancelar'))?.data === true);
  delete conversion.cancelar;

  documentos.encolar(P[0]); documentos.encolar(P[2]);
  ok('docs:pendientes devuelve la lista', JSON.stringify((await llamar('docs:pendientes'))?.data) === JSON.stringify([P[0], P[2]]));
  ok('print:papeles-con-nombre devuelve la lista', (await llamar('print:papeles-con-nombre'))?.data?.includes('A5'));
  const escrito = await llamar('docs:escribir', CARPETA, 'pag-03.png', new Uint8Array([7]), { noPisar: true });
  const reescrito = await llamar('docs:escribir', CARPETA, 'pag-03.png', new Uint8Array([8]), { noPisar: true });
  ok('docs:escribir le pasa noPisar a escribir', path.basename(reescrito?.data || '') === 'pag-03 (2).png',
    JSON.stringify([escrito, reescrito]));

  const api = expuesto;
  ok('el preload expone la API', !!api);
  await api?.docs.pendientes();
  await api?.docs.elegir({ varios: true });
  await api?.docs.elegirVarios({ conFallidos: true });
  await api?.docs.escribir('C:\\x', 'n.png', new Uint8Array([1]), { noPisar: true });
  await api?.print.listar({ refrescar: true });
  await api?.print.papelesConNombre();
  await api?.conv.cancelar();
  const visto = (canal) => invocados.find((i) => i.canal === canal);
  ok('docs.pendientes → docs:pendientes', !!visto('docs:pendientes'));
  ok('docs.elegir pasa sus opciones', visto('docs:elegir')?.args[0]?.varios === true);
  ok('docs.elegirVarios pasa sus opciones', visto('docs:elegir-varios')?.args[0]?.conFallidos === true);
  ok('docs.escribir pasa la cuarta', visto('docs:escribir')?.args[3]?.noPisar === true);
  ok('print.listar pasa refrescar', visto('print:listar')?.args[0]?.refrescar === true);
  ok('print.papelesConNombre → print:papeles-con-nombre', !!visto('print:papeles-con-nombre'));
  ok('conv.cancelar → conv:cancelar', !!visto('conv:cancelar'));
  /* Lo de siempre sigue igual: el renderer de hoy llama sin argumentos. */
  invocados.length = 0;
  await api?.docs.elegir();
  await api?.docs.pendiente();
  ok('docs.elegir() sin nada sigue siendo el de un archivo', visto('docs:elegir')?.args[0] === undefined);
  ok('docs.pendiente sigue existiendo', !!visto('docs:pendiente'));

  delete require.cache[claveElectron];

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.log(`\n  FALLA excepción sin atajar: ${err?.stack || err}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ya no está */ }
  process.exit(1);
});
