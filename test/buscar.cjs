/* ═══════════════════════════════════════════════════════════════════════════
   La búsqueda, de punta a punta.

   Lo que de verdad se juega acá es la CORRESPONDENCIA entre dos listas que se
   arman por caminos distintos: los fragmentos que lee el índice
   (doc.fragmentos → getTextContent) y los spans que arma la capa de texto
   (pdf.js TextLayer). El buscador ubica una coincidencia por (fragmento,
   offset) y después la pinta midiendo un Range sobre el span de ese número. Si
   las dos listas dejan de ser la misma, el resaltado cae sobre la palabra de al
   lado — y eso NO se ve como un error: se ve como que el buscador encontró otra
   cosa. Es el bug más caro posible acá, así que se mide.

   Por eso el test no pregunta "¿hay una marca?": compara el rectángulo de la
   marca contra el del span que tiene las letras, y los dos tienen que dar lo
   mismo.

   El PDF de prueba se genera acá al lado con pdf-lib, y no está versionado a
   propósito: lo que hace falta probar son casos —la palabra cortada con guion,
   la tilde, la página sin texto— y un archivo binario en el repo no dice cuáles
   son. Acá se leen al lado de lo que se espera de ellos.
   ═══════════════════════════════════════════════════════════════════════════ */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cerca = (a, b, tol) => Math.abs(a - b) <= tol;

const morir = (por, err) => {
  console.log(`\n!!! ${por}: ${err?.stack || err}`);
  console.log(`\n═══ ${pass} ok · ${fail + 1} fallas ═══`);
  app.exit(1);
};
process.on('unhandledRejection', (e) => morir('promesa sin atrapar', e));
const reloj = setTimeout(() => morir('se colgó', new Error('pasaron 90 s')), 90_000);

/* ── El cobayo del buscador ───────────────────────────────────────────────────
   Cuatro páginas, cada una probando algo:
     1 · un renglón cortado ("El estado" / "del arte") y una palabra partida con
         guion y con tilde ("compen-" / "sación"), más una en mayúsculas.
     2 · dos coincidencias en la misma página, para contar y para navegar.
     3 · SIN texto — un rectángulo y nada más. Es el escaneo: la página donde no
         hay nada que buscar y la app tiene que decirlo sin romperse.
     4 · una más, después de la página muda, para que el recorrido no se corte
         en la que no tiene texto. */
async function armarCobayo() {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);

  const escribir = (pagina, lineas) => {
    for (const [x, y, texto] of lineas) {
      pagina.drawText(texto, { x, y, size: 16, font: fuente, color: rgb(0, 0, 0) });
    }
  };

  escribir(pdf.addPage([595, 842]), [
    [60, 760, 'El estado'],
    [60, 736, 'del arte'],
    [60, 700, 'Una compen-'],
    [60, 676, 'sación continua'],
    [60, 620, 'PALABRA sola'],
  ]);
  escribir(pdf.addPage([595, 842]), [
    [60, 760, 'palabra en la dos'],
    [60, 736, 'otra palabra mas'],
  ]);

  // La muda: solo un rectángulo, como un escaneo.
  pdf.addPage([595, 842]).drawRectangle({ x: 60, y: 600, width: 200, height: 120, color: rgb(0.8, 0.8, 0.8) });

  escribir(pdf.addPage([595, 842]), [[60, 760, 'palabra final']]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-buscar-'));
  const ruta = path.join(dir, 'cobayo-buscar.pdf');
  fs.writeFileSync(ruta, await pdf.save());
  return { dir, ruta };
}

app.whenReady().then(async () => {
  require(path.join(RAIZ, 'src', 'ipc.cjs')).register();
  const { dir, ruta } = await armarCobayo();

  /* Fuera de pantalla pero VISIBLE: Chromium congela las animaciones de una
     ventana con show:false, y acá se miden cosas que entran animadas. El porqué
     largo está en humo.cjs. */
  const win = new BrowserWindow({
    show: false, x: -20000, y: -20000, width: 1400, height: 900,
    backgroundColor: '#0a0b0d',
    webPreferences: {
      preload: path.join(RAIZ, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(e.message.slice(0, 200)); });

  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  win.showInactive();
  await esperar(1400);

  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

  /* Las pestañas de la sesión anterior se cierran ANTES de abrir el cobayo.
     La app restaura sola lo que estaba abierto la última vez, y con cuatro ya
     no entra una quinta: corriendo esta suite después de las otras, el test
     moría en el arranque con "ya hay 4 documentos abiertos". Un test tiene que
     arrancar del documento que él eligió y no del que quedó de antes. */
  await js(`(async () => {
    const mod = await import('./js/estado.js');
    for (const p of [...mod.S.pestanas]) await mod.cerrarPestana(p.id);
    const archivo = await window.onyx.docs.leer(${JSON.stringify(ruta)});
    await mod.abrir(archivo);
    const router = (await import('./js/router.js')).default;
    router.go('lector');
    router.refresh();
  })()`);
  await esperar(2200);

  /* Las ayudas quedan colgadas del window una sola vez: los bloques de abajo
     las reusan después de buscar, de navegar y de zoomear. */
  await js(`(() => {
    window.T = {
      /* Escribir en el campo como escribe una persona: el valor y el evento.
         Sin el evento no corre el debounce y no se busca nada. */
      async tipear(texto) {
        const campo = document.getElementById('qr-buscar-campo');
        campo.value = texto;
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      },
      caja(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      },
      pliego: (n) => document.querySelector('.qr-pliego[data-pagina="' + n + '"]'),
      marcas(n) {
        const p = window.T.pliego(n);
        return p ? [...p.querySelectorAll('.qr-marca')].map(window.T.caja) : [];
      },
      spans(n) {
        const p = window.T.pliego(n);
        return p ? [...p.querySelectorAll('.qr-texto span')].map(window.T.caja) : [];
      },
    };
    return true;
  })()`);

  /* ── 1 · Las dos listas son la misma ─────────────────────────────────── */
  console.log('\n1. El índice y la capa de texto hablan de lo mismo');

  const alineacion = await js(`(async () => {
    const { S } = await import('./js/estado.js');
    const { armarIndice } = await import('./js/pdf/buscador.js');
    const salida = [];
    const cont = document.createElement('div');
    cont.style.cssText = 'position:absolute;left:-99999px;top:0';
    document.body.append(cont);
    for (let n = 1; n <= S.doc.paginas; n++) {
      const frags = await S.doc.fragmentos(n);
      const idx = armarIndice(frags);
      const r = await S.doc.capaTexto(n, { contenedor: cont, escala: 1 }).promesa;
      salida.push({
        n,
        fragmentos: idx.fragmentos,
        divs: r.divs.length,
        calzan: r.divs.every((d, i) => d.textContent === frags[i].str),
        texto: idx.texto,
        plano: idx.plano,
        saltos: frags.filter((f) => f.salto).length,
      });
    }
    cont.remove();
    return salida;
  })()`);

  for (const p of alineacion) {
    ok(`página ${p.n}: ${p.fragmentos} fragmentos y ${p.divs} spans`, p.fragmentos === p.divs,
      `(${p.fragmentos} vs ${p.divs})`);
    ok(`página ${p.n}: cada span dice lo que dice su fragmento`, p.calzan);
  }

  const p1 = alineacion[0];
  ok('los renglones vienen marcados como tales', p1.saltos > 0, `(saltos: ${p1.saltos})`);
  ok('el plegado une el renglón cortado', p1.plano.includes('el estado del arte'),
    `\n         plano: ${JSON.stringify(p1.plano)}`);
  ok('y la palabra partida con guion', p1.plano.includes('compensacion continua'),
    `\n         plano: ${JSON.stringify(p1.plano)}`);
  ok('la página sin texto no tiene fragmentos', alineacion[2].fragmentos === 0);

  /* ── 2 · Buscar ──────────────────────────────────────────────────────── */
  console.log('\n2. Buscar');

  await js(`document.querySelector('.qr-panel__tab[data-panel="buscar"]').click()`);
  await esperar(300);
  ok('la pestaña Buscar existe y abre su panel',
    await js(`!!document.getElementById('qr-buscar-campo')`));

  await js(`window.T.tipear('palabra')`);
  await esperar(900);

  const buscada = await js(`(() => ({
    filas: document.querySelectorAll('.qr-hit').length,
    cuenta: document.getElementById('qr-buscar-cuenta').textContent,
    paginas: [...document.querySelectorAll('.qr-hit__pag')].map((e) => +e.textContent),
    marcadas: [...document.querySelectorAll('.qr-hit mark')].map((e) => e.textContent),
  }))()`);

  ok('encuentra las cuatro', buscada.filas === 4, `(${buscada.filas})`);
  ok('sin importar mayúsculas ni en qué página estén',
    JSON.stringify(buscada.paginas) === JSON.stringify([1, 2, 2, 4]),
    JSON.stringify(buscada.paginas));
  ok('y muestra el texto tal como está en la hoja',
    buscada.marcadas[0] === 'PALABRA' && buscada.marcadas[1] === 'palabra',
    JSON.stringify(buscada.marcadas));
  /* Sin haberse parado en ninguna, el contador dice cuántas hay; recién al
     saltar a una pasa a decir en cuál. */
  ok('el contador dice cuántas hay', buscada.cuenta === '4 coincidencias', `("${buscada.cuenta}")`);

  /* ── 3 · La marca cae sobre las letras ───────────────────────────────── */
  console.log('\n3. La marca cae sobre las letras');

  const geo = await js(`(() => {
    const marcas = window.T.marcas(1);
    const spans = window.T.spans(1);
    // "PALABRA sola" es el último renglón de la página: su span es el último.
    return { marcas, span: spans[spans.length - 1], spans: spans.length };
  })()`);

  ok('hay UNA marca en la página 1', geo.marcas.length === 1, `(${geo.marcas.length})`);
  const m = geo.marcas[0];
  const sp = geo.span;
  ok('arranca donde arranca el renglón', cerca(m.x, sp.x, 1.5), `(marca ${m?.x} · span ${sp?.x})`);
  ok('a la misma altura', cerca(m.y, sp.y, 2), `(marca ${m?.y} · span ${sp?.y})`);
  /* La marca sale un toque más alta que el span, y está bien: el rectángulo de
     un Range es la caja de la FUENTE —sube hasta el ascendente y baja hasta el
     descendente— y el span mide el cuerpo de la letra. Un resaltador que corta
     justo en la panza de las pes se ve peor que uno que las cubre. Lo que no
     puede pasar es que se desborde al renglón de al lado: de ahí el techo. */
  ok('del alto del renglón, con el aire de la fuente',
    m.h >= sp.h && m.h <= sp.h * 1.25, `(marca ${m?.h} · span ${sp?.h})`);
  ok('resalta "PALABRA" y no "PALABRA sola"', m.w > sp.w * 0.45 && m.w < sp.w * 0.85,
    `(marca ${m?.w} de ${sp?.w})`);

  /* La que cruza el renglón tiene que pintarse en DOS pedazos, uno por línea. */
  await js(`window.T.tipear('estado del')`);
  await esperar(900);
  const cruzada = await js(`({ marcas: window.T.marcas(1), filas: document.querySelectorAll('.qr-hit').length })`);
  ok('la coincidencia que cruza el renglón se encuentra', cruzada.filas === 1, `(${cruzada.filas} filas)`);
  ok('y se pinta en dos pedazos, uno por renglón', cruzada.marcas.length === 2,
    `(${cruzada.marcas.length})`);
  ok('el segundo pedazo va más abajo que el primero',
    cruzada.marcas.length === 2 && cruzada.marcas[1].y > cruzada.marcas[0].y);

  await js(`window.T.tipear('compensación')`);
  await esperar(900);
  ok('la palabra partida con guion se encuentra escribiéndola entera',
    await js(`document.querySelectorAll('.qr-hit').length`) === 1);
  await js(`window.T.tipear('compensacion')`);
  await esperar(900);
  ok('y también sin la tilde',
    await js(`document.querySelectorAll('.qr-hit').length`) === 1);

  /* ── 4 · Navegar ─────────────────────────────────────────────────────── */
  console.log('\n4. Navegar entre resultados');

  await js(`window.T.tipear('palabra')`);
  await esperar(900);
  await js(`document.getElementById('qr-buscar-next').click()`);
  await esperar(700);

  const primera = await js(`(() => ({
    cuenta: document.getElementById('qr-buscar-cuenta').textContent,
    fila: document.querySelector('.qr-hit.is-actual')?.dataset.i,
    pagina: document.getElementById('qr-pagina-input').value,
    vivas: document.querySelectorAll('.qr-marca.is-actual').length,
  }))()`);
  ok('el contador se para en la primera', primera.cuenta.startsWith('1 de'), `("${primera.cuenta}")`);
  ok('la fila de la lista queda marcada', primera.fila === '0');
  ok('hay UNA marca viva en todo el documento', primera.vivas === 1, `(${primera.vivas})`);

  await js(`document.getElementById('qr-buscar-next').click()`);
  await esperar(900);
  const segunda = await js(`(() => {
    const viva = document.querySelector('.qr-marca.is-actual');
    const m = viva?.getBoundingClientRect();
    const v = document.getElementById('qr-visor').getBoundingClientRect();
    return {
      cuenta: document.getElementById('qr-buscar-cuenta').textContent,
      marca: m && { y: Math.round(m.top), alto: Math.round(m.height) },
      aLaVista: !!m && m.top >= v.top && m.bottom <= v.bottom,
      vivasEn2: document.querySelectorAll('.qr-pliego[data-pagina="2"] .qr-marca.is-actual').length,
      vivasEnTodo: document.querySelectorAll('.qr-marca.is-actual').length,
    };
  })()`);
  ok('la siguiente avanza el contador', segunda.cuenta.startsWith('2 de'), `("${segunda.cuenta}")`);
  /* Lo que importa no es qué número muestra el paginador —que sigue su propia
     regla: la página que cruza el tercio de arriba— sino que la coincidencia
     esté DELANTE DE LOS OJOS. Centrada, arriba de ella queda media pantalla, y
     esa media pantalla puede ser todavía el final de la página anterior. */
  ok('y deja la coincidencia dentro del visor', segunda.aLaVista, JSON.stringify(segunda.marca));
  ok('la marca viva ahora está en la 2', segunda.vivasEn2 === 1, `(${segunda.vivasEn2})`);
  /* Y sigue habiendo UNA sola en todo el documento: la de la página anterior
     tiene que haberse apagado. Es lo que se rompe si se repinta nada más que la
     hoja de destino. */
  ok('y la de la página anterior se apagó', segunda.vivasEnTodo === 1, `(${segunda.vivasEnTodo})`);

  /* Desde la primera, "anterior" tiene que dar la vuelta al final y no clavarse. */
  await js(`(() => { const b = document.getElementById('qr-buscar-prev'); b.click(); b.click(); })()`);
  await esperar(900);
  ok('desde la primera, anterior da la vuelta al final',
    (await js(`document.getElementById('qr-buscar-cuenta').textContent`)).startsWith('4 de'));

  /* ── 5 · Nada que encontrar ──────────────────────────────────────────── */
  console.log('\n5. Cuando no hay nada');

  await js(`window.T.tipear('zutano')`);
  await esperar(1000);
  const sin = await js(`(() => ({
    filas: document.querySelectorAll('.qr-hit').length,
    dice: document.querySelector('.qr-panel__vacio .ox-meta')?.textContent || '',
    marcas: document.querySelectorAll('.qr-marca').length,
    cuenta: document.getElementById('qr-buscar-cuenta').textContent,
  }))()`);
  ok('no lista nada', sin.filas === 0);
  ok('lo dice con todas las letras', /Sin coincidencias/.test(sin.dice), `("${sin.dice}")`);
  ok('y el contador vuelve a vacío', sin.cuenta === '—', `("${sin.cuenta}")`);

  await js(`window.T.tipear('')`);
  await esperar(700);
  ok('con el campo vacío avisa que no hay OCR',
    /escaneo/.test(await js(`document.querySelector('.qr-buscar__nota')?.textContent || ''`)));
  ok('y la hoja queda limpia',
    await js(`[...document.querySelectorAll('.qr-marcas')].every((c) => !c.classList.contains('is-visible'))`));

  /* ── 6 · Zoom ────────────────────────────────────────────────────────── */
  console.log('\n6. Al cambiar el zoom, las marcas se vuelven a medir');

  /* Volver a la 1 ANTES de medir: la navegación de arriba dejó la vista en la
     página 4, y el zoom ancla en la página que estás mirando. Sin esto se mide
     una página que no está en pantalla y no hay marcas que medir. */
  await js(`(async () => { (await import('./js/views/lector.js')).irA(1, { suave: false }); })()`);
  await esperar(600);
  await js(`window.T.tipear('palabra')`);
  await esperar(900);
  const antes = await js(`window.T.marcas(1)[0]`);
  ok('antes de zoomear hay una marca para medir', !!antes);

  await js(`document.getElementById('qr-zoom-mas').click()`);
  await esperar(1800);

  const despues = await js(`(() => ({ marca: window.T.marcas(1)[0], span: window.T.spans(1).at(-1) }))()`);
  ok('la marca sigue existiendo después de zoomear', !!despues.marca);
  ok('y creció con la página', despues.marca && despues.marca.w > antes.w * 1.05,
    `(${antes?.w} → ${despues.marca?.w})`);
  ok('y sigue calzada sobre su renglón',
    despues.marca && cerca(despues.marca.x, despues.span.x, 2) && cerca(despues.marca.y, despues.span.y, 2.5),
    `(marca ${despues.marca?.x}/${despues.marca?.y} · span ${despues.span?.x}/${despues.span?.y})`);

  /* ── 7 · Con la página girada ────────────────────────────────────────── */
  console.log('\n7. Con la página girada 90°');

  /* La capa de texto se arma SIEMPRE en la orientación original y se gira
     entera por CSS (ver .qr-texto[data-main-rotation] en quire.css). Como las
     marcas se miden con getClientRects() —que ya viene con las transformaciones
     aplicadas— tienen que seguir cayendo sobre las letras sin que el buscador
     sepa nada del giro. Si alguna vez se midieran con offsetLeft/offsetTop, este
     es el test que se rompe. */
  await js(`document.getElementById('qr-rotar-der').click()`);
  await esperar(2000);

  const girada = await js(`(() => {
    const p = window.T.pliego(1);
    const marca = window.T.marcas(1)[0];
    const spans = window.T.spans(1);
    const caja = window.T.caja(p);
    return {
      apaisado: caja.w > caja.h,
      angulo: p.querySelector('.qr-texto').dataset.mainRotation,
      marca,
      span: spans[spans.length - 1],
      adentro: marca && marca.x >= caja.x - 1 && marca.x + marca.w <= caja.x + caja.w + 1,
    };
  })()`);

  ok('el pliego quedó apaisado', girada.apaisado);
  ok('pdf.js dejó el ángulo en el atributo', girada.angulo === '90', `(${girada.angulo})`);
  ok('la marca se repintó girada', !!girada.marca);
  ok('sigue calzada sobre su renglón',
    girada.marca && cerca(girada.marca.x, girada.span.x, 2) && cerca(girada.marca.y, girada.span.y, 2.5),
    `(marca ${girada.marca?.x}/${girada.marca?.y} · span ${girada.span?.x}/${girada.span?.y})`);
  ok('y no se salió de la hoja', girada.adentro, JSON.stringify(girada.marca));

  // Se devuelve la hoja a su lugar para lo que viene.
  await js(`document.getElementById('qr-rotar-izq').click()`);
  await esperar(1800);

  /* ── 8 · Virtualización ──────────────────────────────────────────────── */
  console.log('\n8. Las marcas se van con su página');

  await js(`(async () => {
    const { irA } = await import('./js/views/lector.js');
    irA(4, { suave: false });
  })()`);
  await esperar(1500);
  ok('la página lejana soltó sus marcas',
    await js(`window.T.marcas(1).length`) === 0);
  ok('y la que llegó tiene las suyas',
    await js(`window.T.marcas(4).length`) === 1);

  await js(`(async () => {
    const { irA } = await import('./js/views/lector.js');
    irA(1, { suave: false });
  })()`);
  await esperar(1500);
  ok('al volver, se vuelven a pintar', await js(`window.T.marcas(1).length`) === 1);

  console.log(`\n----- errores de consola: ${errores.length} -----`);
  for (const e of errores.slice(0, 6)) console.log('   ', e);
  ok('sin errores en la consola', errores.length === 0);

  /* Y se cierra al irse. El cobayo vive en una carpeta temporal que se borra
     acá abajo: dejarlo en la lista de "últimos documentos" haría que la próxima
     vez la app arranque buscando un archivo que ya no está. */
  await js(`(async () => {
    const mod = await import('./js/estado.js');
    for (const p of [...mod.S.pestanas]) await mod.cerrarPestana(p.id);
  })()`);
  await esperar(400);

  fs.rmSync(dir, { recursive: true, force: true });
  clearTimeout(reloj);
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => morir('el arranque', e));
