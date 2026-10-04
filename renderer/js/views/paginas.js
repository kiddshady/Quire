/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — organizar páginas
   Reordenar, rotar, borrar y extraer, sobre una grilla de miniaturas.

   Los cambios NO se aplican al vuelo: se acumulan en un orden y unas
   rotaciones que se ven en pantalla, y recién se escriben cuando pedís
   guardar. Así se puede tantear —borrar cuatro páginas, arrepentirse,
   rotar otra— sin haber tocado el archivo. Y como el resultado sale a un
   archivo nuevo, el original queda intacto pase lo que pase.

   Borrar es "no incluir en el orden". Una sola estructura cubre reordenar y
   borrar, y así no pueden contradecirse entre sí.

   ── Dónde vive lo pendiente ───────────────────────────────────────────────
   En la pestaña (S.organizar, ver CAMPOS en estado.js), no en la vista. Era
   un objeto de este módulo, uno solo para toda la app, y un Ctrl+Tab a otro
   documento tiraba los cambios sin avisar (shell-07, ux-03). Ahora cada
   pestaña tiene el suyo: { orden, rotaciones, seleccion, ultima, historial },
   con `historial` = { atras: [], adelante: [] } de fotos { orden, rotaciones }.

   ── Cómo se pone al día la grilla ─────────────────────────────────────────
   Por clave, con reconcile() (motion.js): cada página es SIEMPRE el mismo
   nodo, con su canvas ya pintado. Antes la grilla se rehacía con innerHTML al
   seleccionar todas, girar o quitar: todas las miniaturas volvían a blanco y
   pdf.js las repintaba de a una (shell-08). Quitar sale fuera del flujo y las
   de al lado viajan; girar gira la miniatura que ya está (shell-09).
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar, alCerrarPestana, cambiosDePaginas } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Modal, Menu, Tooltip } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc, attempt, viewEl } from '../ui.js';
import { plural } from '../format.js';
import { reconcile, frase, tick, asentarPlegables, deslizarAncho, ocupar } from '../motion.js';
import { reorganizar, tituloClave, queFaltaClave } from '../imposicion/motor.js';
import { aplanarTinta } from '../tinta/aplanar.js';
import { exportarImagenes } from '../exportar.js';

const api = window.onyx;
const DPI_PNG = 300;
const FILTRO_PNG = [{ name: 'Imagen PNG', extensions: ['png'] }];

/* Cuántos pasos se recuerdan para deshacer. Cada foto es un orden y unas
   rotaciones: con 300 páginas, unos KB. Cien alcanzan para una tarde de
   limpiar un escaneo. */
const MAX_HISTORIAL = 100;

/* Lo que es de la vista montada y no de un documento: el observador de las
   miniaturas muere con la grilla. */
const V = { observador: null };

/* Lo que se está haciendo con una pestaña (guardar, extraer, exportar), con
   su progreso. Por pestaña y no un sí o no de la vista: si guardás en una y
   te pasás a otra, la otra no tiene por qué quedar con los botones apagados,
   y al volver tenés que ver que la primera sigue trabajando. WeakMap: una
   pestaña cerrada se lleva lo suyo. */
const trabajos = new WeakMap();

/* Las miniaturas de las páginas quitadas, por documento. Una página que
   vuelve (deshacer, descartar) es un nodo nuevo: sin esto volvía en blanco y
   pdf.js la repintaba, cuando el canvas ya estaba hecho. Solo se guardan las
   de las que salen, así que la memoria la acota lo que quitaste. */
const guardadas = new WeakMap();
const guardadasDe = (doc) => {
  if (!guardadas.has(doc)) guardadas.set(doc, new Map());
  return guardadas.get(doc);
};

/* ── Lo pendiente, por pestaña ──────────────────────────────────────────── */

const ordenOriginal = (total) => Array.from({ length: total }, (_, i) => i + 1);

/** Lo de Páginas de una pestaña (la activa, si no se dice). Lo crea si no
    existe: ya no hay un reiniciar() que tire lo que había. */
function organizarDe(p = S.pestana) {
  if (!p?.doc) return null;
  if (!p.organizar) {
    p.organizar = {
      orden: ordenOriginal(p.doc.paginas),
      rotaciones: {},
      seleccion: new Set(),
      ultima: null,
      historial: { atras: [], adelante: [] },
    };
  }
  return p.organizar;
}

const rotDe = (o, n) => (((o.rotaciones[n] || 0) % 360) + 360) % 360;
const foto = (o) => ({ orden: [...o.orden], rotaciones: { ...o.rotaciones } });
const mismo = (a, b) => JSON.stringify(a.orden) === JSON.stringify(b.orden)
  && JSON.stringify(a.rotaciones) === JSON.stringify(b.rotaciones);

/** Anota cómo estaba ANTES de un cambio. Lo nuevo corta la rama de rehacer. */
function registrar(o) {
  o.historial.atras.push(foto(o));
  if (o.historial.atras.length > MAX_HISTORIAL) o.historial.atras.shift();
  o.historial.adelante.length = 0;
}

/* Pone una foto. La selección y la última clickeada se quedan solo con las
   páginas que siguen: una seleccionada que ya no está contaría en el chip y
   en el tope de «Quitar» (shell-14). */
function poner(o, f) {
  o.orden = [...f.orden];
  o.rotaciones = { ...f.rotaciones };
  const siguen = new Set(o.orden);
  for (const n of [...o.seleccion]) if (!siguen.has(n)) o.seleccion.delete(n);
  if (!siguen.has(o.ultima)) o.ultima = null;
}

function deshacer() {
  const o = organizarDe();
  const f = o?.historial.atras.pop();
  if (!f) return;
  o.historial.adelante.push(foto(o));
  poner(o, f);
  pintarGrilla();
}

function rehacer() {
  const o = organizarDe();
  const f = o?.historial.adelante.pop();
  if (!f) return;
  o.historial.atras.push(foto(o));
  poner(o, f);
  pintarGrilla();
}

/** «3 páginas quitadas, 2 giradas y el orden cambiado», o «1 página girada»
    si no se quitó ninguna. Para el Toast de descartar, la pregunta antes de
    cerrar la pestaña y la de cerrar la app (app.js la importa de acá): eran
    dos copias y la de la app decía «1 página girada» donde esta decía
    «1 girada» (paquete 4A). */
export function describirCambios(c) {
  if (!c) return '';
  const partes = [];
  if (c.quitadas) partes.push(plural(c.quitadas, 'página quitada', 'páginas quitadas'));
  if (c.giradas) {
    partes.push(c.quitadas
      ? plural(c.giradas, 'girada', 'giradas')
      : plural(c.giradas, 'página girada', 'páginas giradas'));
  }
  if (c.reordenada) partes.push('el orden cambiado');
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}` : partes[0] || '';
}

/* Las palabras de la pregunta, las mismas que la del cierre de la app
   (app.js, confirmarCierreConCambios): el mismo título, la misma frase con
   lo que se pierde y el mismo botón. Cerrar una pestaña decía «¿Cerrar sin
   guardar?» y «Cerrar igual», y cerrar Quire «Hay cambios sin guardar en
   Páginas» y «Cerrar sin guardar», por lo mismo (paquete 4A). */
export const PREGUNTA_CAMBIOS = {
  titulo: 'Hay cambios sin guardar en Páginas',
  boton: 'Cerrar sin guardar',
  frase: (nombre, c, porQue) => `${nombre}: ${describirCambios(c)}. ${porQue} se pierden.`,
};

/**
 * Pregunta antes de cerrar una pestaña con cambios de Páginas sin guardar.
 * Devuelve true si se puede cerrar. La usa la guardia de abajo; se exporta
 * para que el cierre de la app (app.js) diga lo mismo con las mismas palabras.
 */
export async function preguntarSiDescartar(p) {
  const c = cambiosDePaginas(p);
  const nombre = p.doc?.nombre || 'documento.pdf';
  /* Con un trabajo andando también se pregunta, aunque no haya nada
     pendiente: una pestaña que exportaba PNG se cerraba sin avisar y el
     documento se soltaba mientras pdf.js todavía lo rasterizaba. Lo que
     corre después de cada await mira si la pestaña sigue (vigente()), así
     que cerrar igual corta en el próximo paso sin mostrar nada más. */
  const t = trabajos.get(p);
  if (t) {
    const que = { guardar: 'se está guardando', extraer: 'se están extrayendo sus páginas', png: 'se está exportando como PNG' }[t.tipo];
    const pendiente = c && t.tipo !== 'guardar' ? ` Y los cambios de Páginas (${describirCambios(c)}) no se guardaron.` : '';
    return Modal.confirm({
      title: '¿Cerrar sin terminar?',
      sub: `«${nombre}» todavía ${que}. Si lo cerrás ahora, queda a medias.${pendiente}`,
      confirmLabel: 'Cerrar igual',
      danger: true,
    });
  }
  if (!c) return true;
  return Modal.confirm({
    title: PREGUNTA_CAMBIOS.titulo,
    sub: PREGUNTA_CAMBIOS.frase(nombre, c, 'Si cerrás la pestaña,'),
    confirmLabel: PREGUNTA_CAMBIOS.boton,
    danger: true,
  });
}

/* Si la pestaña sigue abierta. Lo de un trabajo que viene después de un
   await (un diálogo, un Toast, la pregunta de abrir) lo mira antes de
   seguir: si la cerraste en el medio, no tiene a quién mostrárselo. */
const vigente = (p) => S.pestanas.includes(p);

/* La guardia es de la app, no de la vista montada: cerrar con la cruz una
   pestaña con cambios tiene que preguntar también desde el lector, que es
   donde se ve la franja la mayor parte del tiempo (ux-03). */
alCerrarPestana(preguntarSiDescartar);

/* ── Vista ───────────────────────────────────────────────────────────────── */

export function viewPaginas() {
  // Antes del early return: la pantalla vacía tiene que reaccionar cuando
  // aparece un documento (ver la nota en lector.js).
  Router.onLeave(alCambiar((que) => {
    /* Solo repinta. Lo pendiente vive en la pestaña: si llegó otro documento,
       la vista se pinta con lo suyo; si vuelve el de antes, con lo que había
       quedado. Reiniciar acá era tirar los cambios. */
    if (que === 'documento') Router.refresh();
  }));

  if (!S.doc) {
    paint(head({ title: 'Páginas' }) + empty({
      icon: 'grid',
      title: 'No hay ningún documento abierto',
      text: 'Abrí un PDF para reordenar, rotar, borrar o extraer sus páginas. Los cambios salen a un archivo nuevo: el original no se toca.',
      actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
    }));
    return;
  }

  const o = organizarDe();
  const c = cambiosDePaginas();
  const ocupado = ocupada();
  const bloqueado = conClave();
  const n = o.seleccion.size;
  /* Los botones nacen como van a quedar: con la selección y el historial que
     ya tenía la pestaña, si nacieran apagados se encenderían con su
     transición recién montada la vista. */
  const apagado = (cond) => (cond ? 'disabled' : '');

  // El nombre va crudo: head() ya lo escapa (ux-05).
  paint(head({
    title: 'Páginas',
    sub: subtitulo(o),
    crumbs: [{ label: 'Documento', view: 'lector' }, { label: 'Páginas' }],
  }) + `
    <div class="qr-org ox-bleed">
      <div class="qr-org__barra">
        <button class="ox-btn ox-btn--ghost ox-btn--sm" id="org-todas"
                data-tip="Seleccionar todas" data-tip-key="Ctrl A">Seleccionar todas</button>
        <button class="ox-btn ox-btn--ghost ox-btn--sm" id="org-ninguna"
                data-tip="Soltar la selección" data-tip-key="Esc">Ninguna</button>
        <div class="ox-vr"></div>
        <span class="ox-chip qr-org-cuenta${n ? '' : ' is-vacia'}" id="org-cuenta">${esc(textoCuenta(n))}</span>
        <div class="ox-spacer"></div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-deshacer" data-tip="Deshacer" data-tip-key="Ctrl Z" ${apagado(!o.historial.atras.length)}><i data-icon="undo"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-rehacer" data-tip="Rehacer" data-tip-key="Ctrl Y" ${apagado(!o.historial.adelante.length)}><i data-icon="redo"></i></button>
        <div class="ox-vr"></div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-rotar-izq" data-tip="Girar a la izquierda" ${apagado(!n)}><i data-icon="rotarIzq"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-rotar-der" data-tip="Girar a la derecha" ${apagado(!n)}><i data-icon="rotarDer"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-extraer" data-tip="${esc(bloqueado ? tipClave(FALTA_EXTRAER) : TIP_EXTRAER)}" ${apagado(!n || ocupado || bloqueado)}><i data-icon="external"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-exportar-png" data-tip="Exportar selección como PNG · 300 dpi" ${apagado(!n || ocupado)}><i data-icon="download"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm qr-iconbtn-danger" id="org-borrar" data-tip="Quitar del documento" data-tip-key="Supr" ${apagado(!n || n >= o.orden.length)}><i data-icon="trash"></i></button>
      </div>

${bloqueado ? `
      <div class="qr-org__clave">
        <div class="qr-clave-aviso qr-clave-aviso--fila" id="org-clave">${Icons.svg('lock')}
          <span><span class="ox-label">${esc(tituloClave())}</span><span class="ox-meta">${esc(queFaltaClave(`${FALTA_GUARDAR} ni ${FALTA_EXTRAER}`))} Ordenar y girar sirven para mirar, y Exportar como PNG sí anda.</span></span>
        </div>
      </div>` : ''}
      <div class="qr-org__grilla" id="org-grilla"></div>

      <div class="qr-org__pie">
        <span class="ox-meta qr-org__estado" id="org-estado">${esc(textoEstado(c))}</span>
        <div class="qr-org__progreso ox-plegable--ancho" id="org-progreso" hidden>
          <div class="ox-meter"><div class="ox-meter__fill"></div></div>
          <span class="ox-meta qr-org__progreso-txt" id="org-progreso-txt"></span>
        </div>
        <div class="ox-spacer"></div>
        <button class="ox-btn ox-btn--ghost ox-flashable" id="org-reiniciar" ${apagado(!c || ocupado)}>
          <i data-icon="retry"></i> Descartar cambios
        </button>
        <button class="ox-btn ox-btn--primary ox-flashable" id="org-guardar" data-ocupado="${trabajos.get(S.pestana)?.tipo === 'guardar' ? 1 : 0}"${bloqueado ? ` data-tip="${esc(tipClave(FALTA_GUARDAR))}"` : ''} ${apagado(!c || ocupado || bloqueado)}>${rotuloGuardar(trabajos.get(S.pestana)?.tipo === 'guardar')}</button>
      </div>
    </div>`);

  montarGrilla();
  cablear();
  pintarProgreso();

  Router.onLeave(() => {
    V.observador?.disconnect();
    V.observador = null;
    // Un arrastre a medias se va con la vista, con sus escuchas en window: si
    // quedara anotado, ninguno nuevo podría empezar.
    arrastreEnCurso?.abandonar();
    arrastreEnCurso = null;
  });
}

const subtitulo = (o) => `${S.doc.nombre} · ${o.orden.length} de ${S.doc.paginas}`;
const textoCuenta = (n) => (n ? plural(n, 'página', 'páginas') : 'nada seleccionado');

/* El estado del pie. Sin cambios, dice cómo se reordena: es lo único de la
   vista que no tiene un botón que lo cuente (ux-01). */
function textoEstado(c) {
  if (!c) return 'Sin cambios pendientes · arrastrá una página para moverla';
  const partes = [];
  if (c.quitadas) partes.push(plural(c.quitadas, 'página quitada', 'páginas quitadas'));
  if (c.giradas) partes.push(plural(c.giradas, 'girada', 'giradas'));
  if (c.reordenada) partes.push('reordenado');
  return partes.join(' · ');
}

const rotuloGuardar = (ocupado) => (ocupado
  ? `${Icons.spinner('ox-icon--sm')}<span>Guardando…</span>`
  : `${Icons.svg('save')}<span>Guardar como…</span>`);

/* ── La grilla ───────────────────────────────────────────────────────────── */

const grilla = () => document.getElementById('org-grilla');

/* Las filas de la grilla, sin las que se están yendo. */
const filasVivas = () => [...(grilla()?.children ?? [])].filter((el) => el.dataset.state !== 'closing');

/* Cómo se ve una hoja según su giro. La caja toma la proporción girada (y la
   transiciona: el aspect-ratio se interpola). El canvas NO cambia de medidas
   —es siempre la página derecha, con el ancho de la caja— y gira con un
   transform; a 90 y 270 además se escala por ancho/alto, que es justo lo que
   lo hace entrar en la caja acostada. Con las medidas cambiadas, el canvas
   se deformaba o saltaba de tamaño en el primer cuadro del giro. */
function aspecto(n, rot) {
  const g = S.geometrias[n - 1];
  const acostada = rot === 90 || rot === 270;
  return {
    ratio: acostada ? `${g.altoPt} / ${g.anchoPt}` : `${g.anchoPt} / ${g.altoPt}`,
    escala: acostada ? +(g.anchoPt / g.altoPt).toFixed(5) : 1,
    /* La de la página derecha, para el canvas: su bitmap redondea el ancho
       y el alto, y con su propia proporción podía quedar medio píxel corto y
       asomar una raya blanca arriba o abajo. */
    proporcion: `${g.anchoPt} / ${g.altoPt}`,
  };
}

function itemsDe(o) {
  return o.orden.map((n, i) => {
    const rot = rotDe(o, n);
    const sel = o.seleccion.has(n);
    const { ratio, escala, proporcion } = aspecto(n, rot);
    return {
      key: `p:${n}`, n, i, rot, sel,
      /* El html dice TODO lo que puede cambiar: reconcile compara contra él
         para saber si la fila necesita su update(). Un solo nodo raíz. */
      html: `
        <button class="qr-org__item${sel ? ' is-sel' : ''}" data-pagina="${n}" data-pos="${i}" data-rot="${rot}" aria-pressed="${sel}">
          <span class="qr-org__hoja" style="aspect-ratio:${ratio};--qr-rot:${rot}deg;--qr-esc:${escala};--qr-proporcion:${proporcion}"></span>
          <span class="qr-org__pie2">
            <span class="ox-num qr-org__num">${i + 1}</span>
            <span class="ox-dim2 qr-org__era ox-plegable--ancho"${n !== i + 1 ? '' : ' hidden'}>(era ${n})</span>
            <span class="ox-chip ox-chip--mono qr-org__giro ox-plegable--ancho"${rot ? '' : ' hidden'}>${rot || 90}°</span>
          </span>
        </button>`,
    };
  });
}

/* Una fila que sigue y cambió algo, puesta al día EN el nodo: el canvas no
   se toca nunca (shell-08). reconcile no actualiza el.__item cuando hay
   update, así que todo sale del ítem que llega. */
function ponerFila(el, it) {
  el.classList.toggle('is-sel', it.sel);
  el.setAttribute('aria-pressed', String(it.sel));
  el.dataset.pos = String(it.i);
  cifra(el.querySelector('.qr-org__num'), String(it.i + 1));
  plegable(el.querySelector('.qr-org__era'), it.n !== it.i + 1, `(era ${it.n})`);
  plegable(el.querySelector('.qr-org__giro'), it.rot !== 0, `${it.rot}°`);

  const antes = Number(el.dataset.rot);
  if (antes !== it.rot) {
    /* El ángulo que se ve es acumulado: de 270 a 0 girando a la derecha son
       +90, no −270. Con el valor crudo la hoja daba tres cuartos de vuelta
       para el otro lado. */
    let d = (((it.rot - antes) % 360) + 360) % 360;
    if (d > 180) d -= 360;
    el.__giro = (el.__giro ?? antes) + d;
    const hoja = el.querySelector('.qr-org__hoja');
    const { ratio, escala } = aspecto(it.n, it.rot);
    hoja.style.setProperty('--qr-rot', `${el.__giro}deg`);
    hoja.style.setProperty('--qr-esc', String(escala));
    hoja.style.aspectRatio = ratio;
    el.dataset.rot = String(it.rot);
  }
}

/* ── Los destellos del pie, de una sola vez ──────────────────────────────────
   El número, el «era N» y el giro destellan cuando cambian, como numero() de
   motion.js. Pero numero() destella con tick(), que fuerza un reflow para
   reiniciar la animación, y ponerFila corre adentro de reconcile, entre un
   insertBefore y otro: quitar la primera de 300 páginas renumera las 299 de
   abajo, y eran 299 layouts sincrónicos de la grilla entera (más otros tantos
   del «era N», que pasaba por frase()). Medido: 2 a 2,4 s con la interfaz
   trabada, contra 50 ms al quitar la última.

   Así que acá solo se escribe (texto y sacar la clase, nada que mida) y se
   anota; pintarGrilla, cuando reconcile terminó, mide una vez y destella las
   que se ven. Las de fuera de la vista cambian sin destello: nadie lo vería,
   y reconcile tampoco las hace viajar.

   Los tres son siempre «solo cifras» (12 → 11, «(era 4)» → «(era 5)»,
   90° → 180°), que es el caso en que frase() escribe en el lugar y destella:
   no hace falta su relevo, y van con textContent. Ojo: con textContent y no
   con swap(), siempre. swap() recuerda el último html que le pasaron y no
   hace nada si llega el mismo; mezclados, un texto escrito por afuera podía
   quedar pegado. */
let destellos = null;

/** Escribe un dato del pie y lo anota para destellar. */
function cifra(el, texto, { destellar = true } = {}) {
  if (!el || el.textContent === texto) return;
  el.textContent = texto;
  el.classList.remove('ox-ticked');
  if (!destellar) return;
  if (destellos) destellos.push(el); else tick(el);
}

/* Un dato del pie que aparece y se va (el «era N», el giro): se pliega a lo
   ancho. Si estaba escondido, el texto nuevo se pone sin destello: aparece
   desplegándose, no es un cambio que haya que marcar. */
function plegable(el, visible, texto) {
  if (!el) return;
  if (!visible) { el.hidden = true; return; }
  cifra(el, texto, { destellar: !el.hidden });
  el.hidden = false;
}

/* Destella las anotadas que se ven. Primero todas las lecturas: la primera
   ya deja la grilla medida (con las clases sacadas aplicadas, que es lo que
   reinicia la animación), y las demás salen sin volver a medir. Recién
   después se escribe. */
function destellarVisibles(g, lista) {
  if (!lista.length) return;
  const caja = g.getBoundingClientRect();
  const visibles = lista.filter((el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > caja.top && r.top < caja.bottom;
  });
  for (const el of visibles) el.classList.add('ox-ticked');
}

/* Lo de la fila que no viene en el html: su miniatura. Si la página había
   salido y vuelve, trae el canvas que ya tenía; si no, la pide el
   observador cuando se acerca a la vista. */
function filaNueva(el) {
  const n = Number(el.dataset.pagina);
  const guardado = guardadasDe(S.doc).get(n);
  if (guardado) {
    guardadasDe(S.doc).delete(n);
    el.querySelector('.qr-org__hoja').replaceChildren(guardado);
    return;
  }
  V.observador?.observe(el);
}

/** La primera pintada de la grilla, con su observador. */
function montarGrilla() {
  const g = grilla();
  if (!g) return;

  /* Las miniaturas se pintan bajo demanda: en un documento largo, generar
     todas de una tarda más que abrir el archivo.

     El documento se toma UNA vez, acá, y no de S.doc en cada miniatura: las
     entradas se pintan de a una con un await en el medio, y en ese medio
     puede pasar de todo — cambiar de pestaña, cerrar la última. Con S.doc en
     vivo, la grilla de un documento terminaba con miniaturas del siguiente, o
     tiraba "Cannot read properties of null" al cerrar. */
  const doc = S.doc;
  const geometrias = S.geometrias;
  V.observador?.disconnect();
  V.observador = new IntersectionObserver(async (entradas, self) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      self.unobserve(e.target);
      // Ya no es el documento de esta grilla: lo que falte no le importa a nadie.
      if (S.doc !== doc) return;
      const n = Number(e.target.dataset.pagina);
      const hoja = e.target.querySelector('.qr-org__hoja');
      if (!hoja || hoja.firstElementChild) continue;
      try {
        const geo = geometrias[n - 1];
        const canvas = await doc.lienzo(n, { escala: 190 / geo.anchoPt, dpr: 2 });
        canvas.className = 'qr-org__lienzo';
        /* Entra fundiéndose: ox-fade-in tiene `from`, y qr-aparecer no tenía
           de dónde partir, así que la página saltaba del blanco a dibujada
           (shell-10, css-07). Terminada, la entrada se apaga con una clase:
           si la fila se mueve en el DOM (reordenar), una animación de CSS
           viva arrancaría de cero y la miniatura parpadearía. */
        canvas.addEventListener('animationend', () => canvas.classList.add('is-settled'), { once: true });
        if (!hoja.firstElementChild) hoja.replaceChildren(canvas);
      } catch (err) {
        // Cerrado a mitad del render no es un error: es que ya no hace falta.
        if (err?.name !== 'RenderingCancelledException' && S.doc === doc) console.error(`[páginas ${n}]`, err);
      }
    }
  }, { root: g, rootMargin: '150% 0px' });

  // Sin entrada propia: la grilla llega con la vista (o debajo de su fundido).
  pintarGrilla({ entrar: false });
  /* Los datos del pie que nacen visibles (el giro, el «era N») no se
     despliegan desde 0: al navegar nadie los asienta, y crecerían debajo
     del fundido. Al repintar lo hace repintar() solo. */
  asentarPlegables(g);
}

/**
 * Pone la grilla al día con lo pendiente de la pestaña activa, sin rehacerla:
 * las filas que siguen son el mismo nodo y viajan, las que se van salen fuera
 * del flujo, las que vuelven entran. Después, la barra.
 */
function pintarGrilla({ entrar = true } = {}) {
  const g = grilla();
  const o = organizarDe();
  if (!g || !o) return;

  /* Con una página levantada (o aterrizando) no se toca la grilla: reconcile
     movería filas que tienen puesto el transform del arrastre, y aterrizar()
     terminaría con lugares viejos. Lo pendiente ya cambió; la grilla se pone
     al día cuando la página termine de caer. */
  if (arrastreEnCurso?.vivo) {
    if (!arrastreEnCurso.repintar) {
      arrastreEnCurso.repintar = true;
      arrastreEnCurso.despues.push(() => pintarGrilla());
    }
    return;
  }

  // Mover una fila en el DOM le saca el foco: si lo tenía, se le devuelve.
  const foco = g.contains(document.activeElement) ? document.activeElement : null;
  destellos = [];
  let leaving;
  try {
    ({ leaving } = reconcile(g, itemsDe(o), {
      update: ponerFila,
      created: filaNueva,
      enter: entrar,
    }));
  } finally {
    const lista = destellos;
    destellos = null;
    destellarVisibles(g, lista);
  }
  for (const el of leaving) {
    const canvas = el.querySelector('.qr-org__lienzo');
    if (canvas && el.dataset.pagina) guardadasDe(S.doc).set(Number(el.dataset.pagina), canvas);
  }
  if (foco?.isConnected && document.activeElement !== foco) foco.focus({ preventScroll: true });

  actualizarBarra();
}

/* ── La barra y el pie ───────────────────────────────────────────────────── */

const ocupada = (p = S.pestana) => !!(p && trabajos.get(p));

/* ── Un PDF con contraseña ───────────────────────────────────────────────────
   Guardar y Extraer reescriben los bytes con pdf-lib, que no los descifra:
   salía un PDF con las hojas en blanco. Lo decidió Fran (paquete 4A): avisar
   y bloquear. Ordenar, girar y quitar siguen andando (es mirar, y Exportar
   como PNG sale de pdf.js, que sí lo lee): lo que se apaga es escribir, con
   el porqué en una franja arriba de la grilla y en el tooltip de los dos
   botones. */
// `cifrado`: la marca de los de solo lectura, si documento.js la pone (ver imprimir.js).
const conClave = (p = S.pestana) => !!(p?.doc?.conClave || p?.doc?.cifrado);
const FALTA_GUARDAR = 'guardar sus cambios';
const FALTA_EXTRAER = 'extraer sus páginas';
const TIP_EXTRAER = 'Extraer a un PDF nuevo';
const tipClave = (accion) => `${tituloClave()}: Quire todavía no puede ${accion}`;

function actualizarBarra() {
  const o = organizarDe();
  if (!o) return;
  const n = o.seleccion.size;
  const c = cambiosDePaginas();
  const trabajando = ocupada();

  /* Frases y no textContent (shell-11): si cambian solo las cifras («2
     páginas» → «3 páginas») se reescriben en el lugar con un destello; si
     cambia la frase, relevo. El chip además cambia de ancho: viaja. Solo si
     cambió: deslizarAncho corta el viaje anterior, y un aviso que no
     toca la cuenta (girar) lo dejaba saltar a su ancho final. */
  const cuenta = document.getElementById('org-cuenta');
  const html = esc(textoCuenta(n));
  if (cuenta && (cuenta.__frase ?? cuenta.innerHTML) !== html) {
    deslizarAncho(cuenta, () => frase(cuenta, html));
  }
  cuenta?.classList.toggle('is-vacia', !n);

  for (const id of ['org-rotar-izq', 'org-rotar-der']) {
    document.getElementById(id)?.toggleAttribute('disabled', !n);
  }
  document.getElementById('org-extraer')?.toggleAttribute('disabled', !n || trabajando || conClave());
  document.getElementById('org-exportar-png')?.toggleAttribute('disabled', !n || trabajando);
  // No se puede borrar todo: un PDF sin páginas no es un PDF.
  document.getElementById('org-borrar')?.toggleAttribute('disabled', !n || n >= o.orden.length);
  document.getElementById('org-deshacer')?.toggleAttribute('disabled', !o.historial.atras.length);
  document.getElementById('org-rehacer')?.toggleAttribute('disabled', !o.historial.adelante.length);
  document.getElementById('org-guardar')?.toggleAttribute('disabled', !c || trabajando || conClave());
  document.getElementById('org-reiniciar')?.toggleAttribute('disabled', !c || trabajando);

  frase(document.getElementById('org-estado'), esc(textoEstado(c)));

  /* El encabezado se pinta una vez; su cuenta hay que mantenerla al día a
     mano. Se busca en la vista viva: el calco de un fundido también tiene
     uno, y un querySelector suelto podría agarrar ese. */
  frase(viewEl()?.querySelector(':scope > .ox-viewhead .ox-viewhead__sub'), esc(subtitulo(o)));
}

/* El progreso de lo que esté haciendo la pestaña activa. Vive en `trabajos`
   y no en el DOM: si te vas y volvés, la vista nueva lo vuelve a mostrar. */
function pintarProgreso() {
  const t = trabajos.get(S.pestana);
  const caja = document.getElementById('org-progreso');
  if (!caja) return;
  const relleno = caja.querySelector('.ox-meter__fill');
  const visible = !!(t && t.total);
  const pct = visible ? `${((t.hecho / t.total) * 100).toFixed(1)}%` : null;
  if (visible && caja.hidden) {
    /* El medidor que arranca de nuevo toma su valor SIN transición: si no,
       se vería volver del 100 del trabajo anterior antes de avanzar. */
    caja.classList.add('is-placing');
    relleno.style.setProperty('--ox-pct', pct);
    void relleno.offsetWidth;
    caja.classList.remove('is-placing');
  } else if (visible) {
    relleno.style.setProperty('--ox-pct', pct);
  }
  if (visible) frase(document.getElementById('org-progreso-txt'), `${t.hecho} de ${t.total}`);
  caja.hidden = !visible;
}

/**
 * Corre `fn` con la pestaña marcada como ocupada: Guardar, Extraer y Exportar
 * se apagan (un doble click en «Guardar como…» aplanaba dos veces y abría dos
 * diálogos, shell-15) y Guardar cambia de rótulo mientras dura.
 *
 * Devuelve lo que devuelva `fn` (null si falló o si ya había otro). Lo que
 * NO es trabajo va afuera, después: la pregunta «¿Abrir el archivo nuevo?»
 * estaba adentro, y mientras se la contestaba el botón seguía diciendo
 * «Guardando…» con el archivo ya escrito.
 *
 * Si la pestaña se cerró en el medio, un error no se muestra: el documento
 * soltado hace fallar a pdf.js, y ese Toast hablaría de algo que ya no está.
 */
async function conTrabajo(p, tipo, fn, { errorTitle }) {
  if (!p || ocupada(p)) return null;
  const t = { tipo, hecho: 0, total: 0 };
  trabajos.set(p, t);
  const rotular = (ocupado) => {
    if (tipo !== 'guardar' || S.pestana !== p) return;
    ocupar(document.getElementById('org-guardar'), ocupado, rotuloGuardar(ocupado));
  };
  rotular(true);
  actualizarBarra();
  try {
    return await attempt(async () => {
      try { return await fn(t); } catch (err) { if (!vigente(p)) return null; throw err; }
    }, { errorTitle });
  } finally {
    // Completo mientras se pliega: un medidor que vuelve a 0 se desenrolla.
    if (t.total) { t.hecho = t.total; if (S.pestana === p) pintarProgreso(); }
    trabajos.delete(p);
    rotular(false);
    if (S.pestana === p && Router.name === 'paginas') { pintarProgreso(); actualizarBarra(); }
  }
}

/* ── Gestos ──────────────────────────────────────────────────────────────── */

function cablear() {
  const $ = (id) => document.getElementById(id);
  const g = $('org-grilla');

  g?.addEventListener('click', (e) => {
    const item = e.target.closest('.qr-org__item');
    if (!item || item.dataset.state === 'closing') return;
    const o = organizarDe();
    const n = Number(item.dataset.pagina);

    /* Shift extiende desde la última: seleccionar veinte páginas de a una es
       trabajo, y este es el gesto que todo el mundo ya tiene aprendido. Si la
       última ya no está (se quitó), es un click simple: con indexOf en −1 el
       rango metía `undefined` en la selección (shell-14). */
    const desde = e.shiftKey && o.ultima != null ? o.orden.indexOf(o.ultima) : -1;
    if (desde >= 0) {
      const hasta = o.orden.indexOf(n);
      const [a, b] = desde < hasta ? [desde, hasta] : [hasta, desde];
      for (let i = a; i <= b; i++) o.seleccion.add(o.orden[i]);
    } else if (e.ctrlKey || e.metaKey) {
      o.seleccion.has(n) ? o.seleccion.delete(n) : o.seleccion.add(n);
    } else if (o.seleccion.has(n) && o.seleccion.size === 1) {
      o.seleccion.clear();
    } else {
      o.seleccion.clear();
      o.seleccion.add(n);
    }
    o.ultima = n;
    pintarGrilla();
  });

  $('org-todas')?.addEventListener('click', seleccionarTodas);
  $('org-ninguna')?.addEventListener('click', soltarSeleccion);
  $('org-rotar-izq')?.addEventListener('click', () => rotar(-90));
  $('org-rotar-der')?.addEventListener('click', () => rotar(90));
  $('org-borrar')?.addEventListener('click', quitar);
  $('org-deshacer')?.addEventListener('click', deshacer);
  $('org-rehacer')?.addEventListener('click', rehacer);
  $('org-extraer')?.addEventListener('click', extraer);
  $('org-exportar-png')?.addEventListener('click', exportarPNG);
  $('org-guardar')?.addEventListener('click', guardar);
  $('org-reiniciar')?.addEventListener('click', descartar);

  if (g) cablearArrastre(g);

  /* El teclado (ux-33). En document y soltado al irse: un listener que
     sobrevive a la vista se acumula, y a la segunda visita cada tecla haría
     dos veces lo suyo. */
  document.addEventListener('keydown', alTeclear);
  Router.onLeave(() => document.removeEventListener('keydown', alTeclear));
}

function alTeclear(e) {
  if (!S.doc || Modal.isOpen || Menu.isOpen) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const o = organizarDe();
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  /* Con una página levantada o cayendo, solo Escape. Ctrl+Z, Supr o Alt con
     las flechas cambiaban el orden debajo del gesto: la arrastrada saltaba
     y caía en un orden que no era el que se veía al soltar. Las nuestras se
     comen (que Ctrl+A no seleccione la página); las demás siguen de largo. */
  if (arrastreEnCurso?.vivo) {
    if (e.key === 'Escape') { e.preventDefault(); arrastreEnCurso.cancelar(); return; }
    const nuestra = (ctrl && !e.altKey && /^[zya]$/.test(k)) || e.key === 'Delete'
      || (e.altKey && /^Arrow/.test(e.key));
    if (nuestra) e.preventDefault();
    return;
  }

  if (ctrl && !e.altKey && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) rehacer(); else deshacer();
    return;
  }
  if (ctrl && !e.altKey && !e.shiftKey && k === 'a') {
    e.preventDefault();
    seleccionarTodas();
    return;
  }
  if (e.key === 'Delete' && !ctrl && !e.altKey) {
    if (document.getElementById('org-borrar')?.disabled) return;
    e.preventDefault();
    quitar();
    return;
  }
  if (e.key === 'Escape') {
    if (!o.seleccion.size) return;
    e.preventDefault();
    soltarSeleccion();
    return;
  }
  /* Alt y las flechas mueven la selección: el mismo reordenar que arrastrar,
     para quien no suelta el teclado (ux-01). Arriba y abajo, de a una fila
     de la grilla. */
  if (e.altKey && !ctrl && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    if (!o.seleccion.size) return;
    e.preventDefault();
    const cols = columnas();
    moverSeleccion({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key]);
  }
}

/** Cuántas columnas tiene la grilla ahora (auto-fill: depende del ancho). */
function columnas() {
  const g = grilla();
  if (!g) return 1;
  return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length);
}

function seleccionarTodas() {
  const o = organizarDe();
  o.orden.forEach((n) => o.seleccion.add(n));
  pintarGrilla();
}

function soltarSeleccion() {
  organizarDe().seleccion.clear();
  pintarGrilla();
}

function rotar(grados) {
  const o = organizarDe();
  if (!o.seleccion.size) return;
  registrar(o);
  for (const n of o.seleccion) {
    o.rotaciones[n] = (((o.rotaciones[n] || 0) + grados) % 360 + 360) % 360;
  }
  pintarGrilla();
}

function quitar() {
  const o = organizarDe();
  if (!o.seleccion.size || o.seleccion.size >= o.orden.length) return;
  registrar(o);
  o.orden = o.orden.filter((n) => !o.seleccion.has(n));
  o.seleccion.clear();
  o.ultima = null;
  pintarGrilla();
}

/**
 * Corre las páginas seleccionadas `paso` lugares (negativo: hacia el
 * principio). Se mueven de a un lugar por vez, y una seleccionada no salta
 * sobre otra seleccionada: un bloque se mueve entero y contra el borde se
 * frena, como en cualquier lista.
 */
function moverSeleccion(paso) {
  const o = organizarDe();
  const orden = [...o.orden];
  const dir = Math.sign(paso);
  let movio = false;
  for (let v = 0; v < Math.abs(paso); v++) {
    const indices = orden.map((_, i) => i);
    if (dir > 0) indices.reverse();
    for (const i of indices) {
      if (!o.seleccion.has(orden[i])) continue;
      const j = i + dir;
      if (j < 0 || j >= orden.length || o.seleccion.has(orden[j])) continue;
      [orden[i], orden[j]] = [orden[j], orden[i]];
      movio = true;
    }
  }
  if (!movio) return;
  registrar(o);
  o.orden = orden;
  pintarGrilla();
  // La primera de la selección, a la vista: con Alt+abajo se puede ir de pantalla.
  const primera = orden.find((n) => o.seleccion.has(n));
  grilla()?.querySelector(`[data-key="p:${primera}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Vuelve al documento como estaba. No pregunta: aplica y ofrece «Deshacer»
 * en el Toast (ux-16, decisión de Fran), y queda en el historial, así que
 * Ctrl+Z también lo trae de vuelta. Y no repinta la vista (shell-12, fw-20):
 * la grilla se pone al día por clave —las quitadas vuelven a entrar, las
 * movidas viajan y las giradas vuelven girando— y el scroll no se toca.
 */
function descartar() {
  const p = S.pestana;
  const o = organizarDe(p);
  const c = cambiosDePaginas(p);
  if (!o || !c) return;
  const antes = foto(o);
  registrar(o);
  poner(o, { orden: ordenOriginal(p.doc.paginas), rotaciones: {} });
  o.seleccion.clear();
  o.ultima = null;
  pintarGrilla();

  const texto = describirCambios(c);
  Toast.show({
    title: 'Cambios descartados',
    text: `${texto.charAt(0).toUpperCase()}${texto.slice(1)}.`,
    icon: 'retry',
    action: {
      label: 'Deshacer',
      // A la pestaña de ese descarte, aunque ya estés mirando otra.
      /* Con una página levantada, espera a que caiga (ver pintarGrilla):
         poner la foto debajo del gesto le cambiaba el orden mientras caía. */
      run: () => trasArrastre(() => {
        if (!S.pestanas.includes(p) || !p.organizar) return;
        registrar(p.organizar);
        poner(p.organizar, antes);
        if (S.pestana === p && Router.name === 'paginas') pintarGrilla();
      }),
    },
  });
}

/* ── Arrastrar para reordenar (ux-01) ────────────────────────────────────────
   Con el puntero, como las pestañas (pestanas.js), y no con el drag & drop
   del navegador: ese dibuja una foto semitransparente que no se puede estilar
   y el cursor de «prohibido». Acá la miniatura de verdad sigue al puntero con
   un transform, y las demás se corren a hacerle lugar con su transición.

   La grilla es de dos dimensiones y scrollea, así que todo se mide en
   coordenadas del CONTENIDO de la grilla (con su scroll sumado): un
   transform vive en ese espacio, y si la grilla se desplaza mientras
   arrastrás (la rueda, o el borde que la empuja) la miniatura sigue debajo
   del puntero. Los lugares se miden al empezar, y durante el gesto el layout
   no cambia, solo los transforms: por eso pintarGrilla() espera a que la
   página aterrice, y el teclado no hace nada mientras tanto (salvo Escape).

   Lo que se aparta del patrón de las pestañas: el movimiento y el soltar se
   escuchan en `window` desde el pointerdown, no en la grilla. El puntero
   recién se captura al pasar el umbral, y antes de eso un pointerup que caía
   fuera de la grilla (apretar una miniatura cortada por el borde y correrse
   2 px hacia el pie) no llegaba nunca: el gesto quedaba colgado y el próximo
   paseo del mouse, sin ningún botón apretado, levantaba la página y la
   reordenaba al soltar (lo encontró la revisión de 2E). Por las dudas, un
   movimiento sin el botón apretado también suelta. Y un pointerdown nuevo
   reemplaza a un gesto que no llegó a despegar, como en pestanas.js; solo
   uno vivo (levantado o aterrizando) no se interrumpe.

   Se arrastra UNA página, la que agarraste. Para mover varias juntas está
   Alt con las flechas. */

/* Los píxeles antes de que un click se vuelva arrastre: sin umbral, el
   temblor de la mano al clickear ya despegaría la miniatura. */
const UMBRAL = 4;
/* La franja de arriba y de abajo de la grilla que la hace desplazarse. */
const BORDE = 40;

let arrastreEnCurso = null;
let tragarClick = false;

function cablearArrastre(g) {
  /* El click que viene atrás de un arrastre no selecciona nada. En captura:
     llega antes que el de la grilla. */
  g.addEventListener('click', (e) => {
    if (!tragarClick) return;
    tragarClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (arrastreEnCurso?.vivo) return;
    arrastreEnCurso?.abandonar();
    const item = e.target.closest('.qr-org__item');
    if (!item || item.dataset.state === 'closing') return;
    const filas = filasVivas();
    if (filas.length < 2) return;

    const p0 = enContenido(g, e.clientX, e.clientY);
    const gesto = {
      g, item, filas, puntero: e.pointerId,
      desde: filas.indexOf(item), hasta: filas.indexOf(item),
      x0: p0.x, y0: p0.y, cx: e.clientX, cy: e.clientY,
      rects: null, vivo: false, suelto: false, raf: 0,
      /* Lo que quiso pasar mientras la página estaba levantada (un repintado,
         el Deshacer de un Toast): corre cuando terminó de caer. */
      despues: [], repintar: false,
    };
    arrastreEnCurso = gesto;

    const escuchas = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      window.removeEventListener('pointercancel', soltar);
      g.removeEventListener('scroll', alScroll);
    };
    const mover = (ev) => {
      if (ev.pointerId !== gesto.puntero) return;
      // Sin el botón apretado ya no es un arrastre: el soltar se perdió.
      if ((ev.buttons & 1) === 0) { soltar(ev); return; }
      gesto.cx = ev.clientX;
      gesto.cy = ev.clientY;
      if (!gesto.vivo) {
        const p = enContenido(g, ev.clientX, ev.clientY);
        if (Math.hypot(p.x - gesto.x0, p.y - gesto.y0) < UMBRAL) return;
        empezar(gesto);
      }
      seguir(gesto);
    };
    const alScroll = () => { if (gesto.vivo && !gesto.suelto) seguir(gesto); };
    const soltar = (ev) => {
      if (ev.pointerId !== gesto.puntero || gesto.suelto) return;
      if (!gesto.vivo) { gesto.abandonar(); return; }
      gesto.suelto = true;
      escuchas();
      /* El click que sigue a este pointerup se lo come el de captura. Si no
         llega (un pointercancel, un Escape), la bandera no puede quedar
         levantada: se comería el próximo click de verdad. El click de un
         pointerup se despacha antes que cualquier timer. */
      tragarClick = true;
      setTimeout(() => { tragarClick = false; }, 0);
      aterrizar(gesto);
    };
    // Escape: vuelve a su lugar, como si la hubieras soltado donde estaba.
    gesto.cancelar = () => {
      if (!gesto.vivo || gesto.suelto) return;
      gesto.hasta = gesto.desde;
      correrVecinas(gesto);
      soltar({ pointerId: gesto.puntero });
    };
    /* Un gesto que no despegó, reemplazado por otro, o uno que se va con la
       vista. Lo que tenía pendiente corre igual: el Deshacer de un Toast no
       puede perderse porque la vista se repintó en el medio. */
    gesto.abandonar = () => {
      escuchas();
      cancelAnimationFrame(gesto.raf);
      if (arrastreEnCurso === gesto) arrastreEnCurso = null;
      for (const fn of gesto.despues.splice(0)) fn();
    };

    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
    window.addEventListener('pointercancel', soltar);
    g.addEventListener('scroll', alScroll, { passive: true });
  });
}

/* Lo que no puede pasar con una página levantada: espera a que caiga. */
function trasArrastre(fn) {
  if (arrastreEnCurso?.vivo) arrastreEnCurso.despues.push(fn);
  else fn();
}

/** Un punto de la ventana, en coordenadas del contenido de la grilla. */
function enContenido(g, x, y) {
  const r = g.getBoundingClientRect();
  return { x: x - r.left + g.scrollLeft, y: y - r.top + g.scrollTop };
}

function empezar(gesto) {
  const { g, item, filas } = gesto;
  gesto.vivo = true;
  /* Los lugares, sin los viajes que hayan quedado andando de un reconcile
     anterior: un FLIP a medio camino corría el rectángulo y la miniatura
     aterrizaba con un salto. */
  for (const f of filas) f.__move?.finish();
  gesto.rects = filas.map((f) => {
    const r = f.getBoundingClientRect();
    const p = enContenido(g, r.left, r.top);
    return { x: p.x, y: p.y, w: r.width, h: r.height };
  });
  /* Capturar el puntero evita el hover de las vecinas mientras se pasa por
     encima. Soltar fuera de la grilla no depende de esto: el gesto escucha
     en window desde el pointerdown. */
  try { item.setPointerCapture(gesto.puntero); } catch { /* ya no está */ }
  item.classList.add('is-dragging');
  g.classList.add('is-reordering');
  Tooltip.hide(true);

  // El borde de arriba y el de abajo desplazan la grilla mientras se arrastra.
  const empujar = () => {
    if (arrastreEnCurso !== gesto || !gesto.vivo) return;
    const r = g.getBoundingClientRect();
    let v = 0;
    if (gesto.cy < r.top + BORDE) v = -(r.top + BORDE - gesto.cy);
    else if (gesto.cy > r.bottom - BORDE) v = gesto.cy - (r.bottom - BORDE);
    if (v) g.scrollTop += Math.sign(v) * Math.min(18, 2 + Math.abs(v) / 3);
    gesto.raf = requestAnimationFrame(empujar);
  };
  gesto.raf = requestAnimationFrame(empujar);
}

function seguir(gesto) {
  const { g, item, rects, desde } = gesto;
  const p = enContenido(g, gesto.cx, gesto.cy);
  const dx = p.x - gesto.x0;
  const dy = p.y - gesto.y0;
  item.style.transform = `translate(${dx}px, ${dy}px)`;

  /* A qué lugar iría si la soltaras ahora: el de centro más cercano al
     centro de la que arrastrás. En una grilla no alcanza con «cuántas quedan
     a la izquierda», como en las pestañas: hay filas. */
  const mia = rects[desde];
  const cx = mia.x + mia.w / 2 + dx;
  const cy = mia.y + mia.h / 2 + dy;
  let hasta = desde;
  let mejor = Infinity;
  rects.forEach((r, k) => {
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (d < mejor) { mejor = d; hasta = k; }
  });
  if (hasta !== gesto.hasta) {
    gesto.hasta = hasta;
    correrVecinas(gesto);
  }
}

/** Corre las del medio un lugar, para dejarle el hueco en `hasta`. */
function correrVecinas(gesto) {
  const { filas, rects, desde, hasta } = gesto;
  filas.forEach((f, k) => {
    if (k === desde) return;
    let a = k;
    if (desde < k && k <= hasta) a = k - 1;        // le pasé por encima yendo hacia el final
    else if (hasta <= k && k < desde) a = k + 1;   // yendo hacia el principio
    f.style.transform = a === k ? '' : `translate(${rects[a].x - rects[k].x}px, ${rects[a].y - rects[k].y}px)`;
  });
}

/**
 * Al soltar, la miniatura no salta a su lugar: se desliza hasta el hueco que
 * le dejaron, y recién cuando llegó se cambia el orden de verdad, así y en la
 * misma tarea (corrección 6 del plan, que salió de shell-01):
 *   1. se saca la clase que transiciona los transform;
 *   2. se limpian los transform, sin transición;
 *   3. se mueve el nodo a su lugar y se pone al día el orden: lo que se ve ya
 *      coincide con el DOM, así que reconcile no encuentra nada que viajar;
 *   4. recién ahí se saca `is-settling`, y lo levantado se funde en el mismo
 *      nodo.
 * En otro orden (limpiar y después mover, o mover en otro cuadro) la
 * miniatura volvía un cuadro a su lugar viejo, o reconcile la hacía viajar
 * desde ahí.
 */
function aterrizar(gesto) {
  const { g, item, filas, rects, desde, hasta } = gesto;
  cancelAnimationFrame(gesto.raf);

  item.classList.replace('is-dragging', 'is-settling');
  item.style.transform = `translate(${rects[hasta].x - rects[desde].x}px, ${rects[hasta].y - rects[desde].y}px)`;

  let hecho = false;
  const terminar = () => {
    if (hecho) return;
    hecho = true;
    item.removeEventListener('transitionend', alTerminar);
    if (arrastreEnCurso === gesto) arrastreEnCurso = null;
    const despues = gesto.despues.splice(0);
    if (item.isConnected && grilla() === g) {                    // si no, la vista se repintó en el medio
      g.classList.remove('is-reordering');                       // 1
      for (const f of filas) f.style.transform = '';             // 2
      const o = organizarDe();
      const n = Number(item.dataset.pagina);
      /* Si mientras caía la quitaron (Supr espera, pero un botón de la barra
         no), no se la vuelve a meter en el orden. */
      if (hasta !== desde && o?.orden.includes(n)) {              // 3
        const otras = filas.filter((f) => f !== item);
        g.insertBefore(item, hasta < otras.length ? otras[hasta] : otras.at(-1).nextSibling);
        registrar(o);
        const orden = o.orden.filter((x) => x !== n);
        orden.splice(Math.min(hasta, orden.length), 0, n);
        o.orden = orden;
        pintarGrilla();
      }
      item.classList.remove('is-settling');                      // 4
    }
    for (const fn of despues) fn();
  };
  /* Que termine de deslizarse. El timeout es la red: si el transform ya valía
     eso (soltar justo en el hueco) no hay transitionend. */
  const alTerminar = (e) => { if (e.target === item && e.propertyName === 'transform') terminar(); };
  item.addEventListener('transitionend', alTerminar);
  setTimeout(terminar, 260);
}

/* ── Salidas a archivo ───────────────────────────────────────────────────── */

async function exportarPNG() {
  const p = S.pestana;
  const o = organizarDe(p);
  const paginas = o?.orden.filter((n) => o.seleccion.has(n)) ?? [];
  if (!paginas.length) return;
  // Todo lo de la pestaña se toma ahora: en los await de abajo puede cambiar la activa.
  const { doc, tinta } = p;
  const rotaciones = { ...o.rotaciones };

  await conTrabajo(p, 'png', async (t) => {
    /* Para un lote se elige la carpeta ANTES de rasterizar: cancelar no
       debería hacer trabajar a pdf.js ni reservar cientos de MB porque sí. */
    const carpeta = paginas.length > 1 ? await api.docs.elegirCarpeta() : null;
    if ((paginas.length > 1 && !carpeta) || !vigente(p)) return;

    // El progreso se ve solo con varias: una sola tarda un instante.
    if (paginas.length > 1) {
      t.total = paginas.length;
      if (S.pestana === p && Router.name === 'paginas') pintarProgreso();
    }
    const imagenes = await exportarImagenes(doc, {
      paginas,
      formato: 'png',
      dpi: DPI_PNG,
      capa: tinta,
      rotaciones,
      onProgreso: (hecho) => {
        if (!t.total) return;
        t.hecho = hecho;
        if (S.pestana === p && Router.name === 'paginas') pintarProgreso();
      },
    });

    if (!vigente(p)) return;
    if (imagenes.length === 1) {
      const imagen = imagenes[0];
      const guardado = await api.docs.guardarComo(imagen.bytes, imagen.nombre, FILTRO_PNG);
      if (!guardado || !vigente(p)) return;
      Toast.show({
        title: 'Página exportada como PNG',
        text: `${imagen.ancho} × ${imagen.alto} px · ${guardado.nombre}`,
        icon: 'download',
      });
      return;
    }

    for (const imagen of imagenes) {
      if (!vigente(p)) return;
      await api.docs.escribir(carpeta, imagen.nombre, imagen.bytes);
    }
    if (!vigente(p)) return;

    const primera = imagenes[0];
    Toast.show({
      title: `${plural(imagenes.length, 'página exportada', 'páginas exportadas')} como PNG`,
      text: `${primera.ancho} × ${primera.alto} px · ${carpeta}`,
      icon: 'download',
    });
  }, { errorTitle: 'No se pudo exportar como PNG' });
}

async function extraer() {
  const p = S.pestana;
  const o = organizarDe(p);
  const paginas = o?.orden.filter((n) => o.seleccion.has(n)) ?? [];
  if (!paginas.length || conClave(p)) return;
  const { doc, tinta } = p;
  const rotaciones = { ...o.rotaciones };

  await conTrabajo(p, 'extraer', async () => {
    const bytes = await aplanarTinta(doc.bytes, tinta);
    const nuevo = await reorganizar(bytes, { orden: paginas, rotaciones, accion: FALTA_EXTRAER });
    if (!vigente(p)) return;
    const base = doc.nombre.replace(/\.pdf$/i, '');
    const guardado = await api.docs.guardarComo(nuevo, `${base}-extraido.pdf`);
    if (!guardado || !vigente(p)) return;
    Toast.show({
      title: `${plural(paginas.length, 'página extraída', 'páginas extraídas')}`,
      text: guardado.nombre,
      icon: 'external',
    });
  }, { errorTitle: 'No se pudo extraer' });
}

async function guardar() {
  const p = S.pestana;
  const o = organizarDe(p);
  if (!o || !cambiosDePaginas(p) || conClave(p)) return;
  const { doc, tinta } = p;
  const guardada = foto(o);

  // El trabajo es aplanar, reorganizar y escribir; lo demás va después.
  const guardado = await conTrabajo(p, 'guardar', async () => {
    const bytes = await aplanarTinta(doc.bytes, tinta);
    const nuevo = await reorganizar(bytes, { ...guardada, accion: FALTA_GUARDAR });
    if (!vigente(p)) return null;
    const base = doc.nombre.replace(/\.pdf$/i, '');
    return api.docs.guardarComo(nuevo, `${base}-organizado.pdf`);
  }, { errorTitle: 'No se pudo guardar' });
  if (!guardado || !vigente(p)) return;

  // Sin flecha: en las apps de la casa todo símbolo es un SVG (shell-33).
  Toast.show({
    title: 'Guardado',
    text: `${plural(guardada.orden.length, 'página', 'páginas')} en ${guardado.nombre}`,
    icon: 'save',
  });

  /* Lo pendiente ya está en el archivo nuevo: esta pestaña vuelve a ser el
     original, que es lo que es. Si quedara pendiente, cerrarla preguntaría
     «¿cerrar sin guardar?» por algo que se acaba de guardar. Va al historial
     (Ctrl+Z lo trae de vuelta), y solo si nadie lo tocó mientras se
     guardaba. Antes de preguntar si abrirlo: mientras se contesta, la vista
     ya dice que no queda nada pendiente. */
  if (p.organizar === o && cambiosDePaginas(p) && mismo(foto(o), guardada)) {
    registrar(o);
    poner(o, { orden: ordenOriginal(doc.paginas), rotaciones: {} });
    o.seleccion.clear();
    if (S.pestana === p && Router.name === 'paginas') pintarGrilla();
  }

  const abrir = await Modal.confirm({
    title: '¿Abrir el archivo nuevo?',
    sub: `${guardado.nombre}. El original sigue como estaba.`,
    confirmLabel: 'Abrirlo',
  });
  if (!abrir) return;
  await attempt(async () => {
    const archivo = await api.docs.leer(guardado.ruta);
    const { abrir: abrirDoc } = await import('../estado.js');
    await abrirDoc(archivo);
    Router.go('lector');
  }, { errorTitle: 'No se pudo abrir el archivo nuevo' });
}
