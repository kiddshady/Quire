/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — herramientas de documento
   Combinar, dividir y exportar a imágenes. Las tres trabajan sobre copias:
   ningún archivo de entrada se modifica, todo sale a un destino que elegís.

   Combinar y dividir COPIAN páginas de un PDF a otro sin re-renderizar nada:
   el texto sigue siendo texto y las fuentes viajan enteras. Exportar sí
   rasteriza, porque una imagen es eso — y por eso el DPI es lo primero que se
   elige.
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Modal } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc, attempt } from '../ui.js';
import { fmtBytes, plural } from '../format.js';
import { bindSwitcher, scrollFade, bindStepper } from '../motion.js';
import { combinar, dividir, reorganizar } from '../imposicion/motor.js';
import { aplanarTinta, contarTinta } from '../tinta/aplanar.js';
import { exportarImagenes, FORMATOS, DPIS, medidaAlDPI } from '../exportar.js';
import { resolverRango } from '../imposicion/plan.js';

const api = window.onyx;

const V = {
  seccion: 'combinar',
  /** Documentos en la cola de combinación, con sus bytes ya leídos. */
  cola: [],
  corte: { tipo: 'cada', cada: 1, rangos: '1-3, 4-6' },
  exportar: { formato: 'png', dpi: 150, calidad: 0.92, rango: 'todo', conTinta: true },
  trabajando: false,
};

const SECCIONES = [
  { id: 'combinar', label: 'Combinar', icono: 'combinar' },
  { id: 'dividir', label: 'Dividir', icono: 'dividir' },
  { id: 'exportar', label: 'Exportar', icono: 'download' },
];

/* ── Vista ───────────────────────────────────────────────────────────────── */

export function viewHerramientas() {
  paint(head({
    title: 'Herramientas',
    sub: S.doc ? esc(S.doc.nombre) : 'Combinar, dividir y exportar',
  }) + `
    <div class="qr-herr">
      <div class="ox-tabs qr-herr__tabs" id="herr-tabs">
        ${SECCIONES.map((s) => `
          <button class="ox-tab${V.seccion === s.id ? ' is-active' : ''}" data-value="${s.id}">
            <i data-icon="${s.icono}"></i> ${s.label}
          </button>`).join('')}
      </div>
      <div class="qr-herr__cuerpo" id="herr-cuerpo"></div>
    </div>`);

  bindSwitcher(document.getElementById('herr-tabs'), (v) => { V.seccion = v; pintarSeccion(); });
  pintarSeccion();
  // El fade de abajo se apaga solo al llegar al final del scroll.
  scrollFade(document.getElementById('herr-cuerpo'));

  const off = alCambiar((que) => { if (que === 'documento') Router.refresh(); });
  Router.onLeave(off);
}

function pintarSeccion() {
  const cuerpo = document.getElementById('herr-cuerpo');
  if (!cuerpo) return;
  cuerpo.innerHTML = { combinar: htmlCombinar, dividir: htmlDividir, exportar: htmlExportar }[V.seccion]();
  Icons.mount(cuerpo);
  ({ combinar: cablearCombinar, dividir: cablearDividir, exportar: cablearExportar }[V.seccion])();
}

/** Sin documento abierto, dividir y exportar no tienen sobre qué trabajar. */
function necesitaDocumento(texto) {
  return empty({
    icon: 'quire',
    title: 'No hay ningún documento abierto',
    text: texto,
    actions: '<button class="ox-btn ox-btn--primary ox-flashable" data-action="abrir"><i data-icon="folder"></i> Abrir un PDF</button>',
  });
}

/* ══ Combinar ════════════════════════════════════════════════════════════════ */

function htmlCombinar() {
  const cola = colaEfectiva();
  const paginas = cola.reduce((n, d) => n + (d.paginas || 0), 0);

  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Los PDFs se unen en el orden de la lista. Las páginas se copian tal cual:
        el texto sigue siendo texto, no se rasteriza nada.
      </p>

      ${cola.length ? `
        <div class="ox-list qr-cola" id="qr-cola">
          ${cola.map((d, i) => `
            <div class="ox-listitem" data-indice="${i}">
              <span class="qr-cola__orden ox-num">${i + 1}</span>
              <div class="ox-listitem__main">
                <span class="ox-listitem__title">${esc(d.nombre)}</span>
                <span class="ox-listitem__sub">
                  ${d.paginas ? `${plural(d.paginas, 'página', 'páginas')} · ` : ''}${esc(fmtBytes(d.tamano || 0))}
                  ${d.esActual ? ' · el que está abierto' : ''}
                </span>
              </div>
              <div class="ox-rowactions">
                <button class="ox-iconbtn ox-iconbtn--sm" data-cola-sube="${i}" ${i === 0 ? 'disabled' : ''}
                        data-tip="Subir"><i data-icon="chevronUp"></i></button>
                <button class="ox-iconbtn ox-iconbtn--sm" data-cola-baja="${i}" ${i === cola.length - 1 ? 'disabled' : ''}
                        data-tip="Bajar"><i data-icon="chevronDown"></i></button>
                ${d.esActual ? '' : `<button class="ox-iconbtn ox-iconbtn--sm" data-cola-saca="${i}"
                        data-tip="Sacar de la lista"><i data-icon="close"></i></button>`}
              </div>
            </div>`).join('')}
        </div>` : `
        <div class="ox-empty" style="margin:24px auto">${Icons.svg('combinar')}
          <div class="ox-empty__title">Todavía no hay nada que unir</div>
          <div class="ox-empty__text">Agregá dos o más PDFs. Si tenés uno abierto, va primero en la lista.</div>
        </div>`}

      <div class="qr-herr__acciones">
        <button class="ox-btn ox-btn--secondary ox-flashable" id="qr-comb-agregar">
          <i data-icon="plus"></i> Agregar PDFs
        </button>
        <div class="ox-spacer"></div>
        ${cola.length > 1 ? `<span class="ox-meta">${cola.length} documentos · ${paginas || '?'} páginas</span>` : ''}
        <button class="ox-btn ox-btn--primary ox-flashable" id="qr-comb-hacer" ${cola.length < 2 ? 'disabled' : ''}>
          <i data-icon="combinar"></i> Combinar y guardar
        </button>
      </div>
    </div>`;
}

/** El documento abierto va primero, salvo que ya lo hayas agregado a mano. */
function colaEfectiva() {
  if (!S.doc) return V.cola;
  const yaEsta = V.cola.some((d) => d.ruta && d.ruta === S.doc.ruta);
  if (yaEsta) return V.cola;
  return [{
    nombre: S.doc.nombre, ruta: S.doc.ruta, tamano: S.doc.tamano,
    paginas: S.doc.paginas, esActual: true,
  }, ...V.cola];
}

function cablearCombinar() {
  document.getElementById('qr-comb-agregar')?.addEventListener('click', async () => {
    const nuevos = await attempt(() => api.docs.elegirVarios(), { errorTitle: 'No se pudieron abrir' });
    if (!nuevos?.length) return;
    for (const a of nuevos) {
      if (V.cola.some((d) => d.ruta === a.ruta)) continue;
      V.cola.push({ nombre: a.nombre, ruta: a.ruta, tamano: a.tamano, bytes: a.bytes });
    }
    pintarSeccion();
  });

  document.getElementById('herr-cuerpo')?.addEventListener('click', (e) => {
    const sube = e.target.closest('[data-cola-sube]');
    const baja = e.target.closest('[data-cola-baja]');
    const saca = e.target.closest('[data-cola-saca]');
    if (!sube && !baja && !saca) return;

    /* Los índices son de la cola EFECTIVA (con el documento abierto adelante).
       Al mover algo, esa lista virtual se materializa: desde ese momento el
       orden es explícito y el abierto deja de tener un lugar privilegiado. */
    const cola = colaEfectiva();
    const i = Number((sube || baja || saca).dataset.colaSube ?? (baja || saca).dataset.colaBaja ?? saca.dataset.colaSaca);

    if (saca) cola.splice(i, 1);
    else {
      const j = sube ? i - 1 : i + 1;
      if (j < 0 || j >= cola.length) return;
      [cola[i], cola[j]] = [cola[j], cola[i]];
    }
    V.cola = cola.map((d) => ({ ...d, esActual: false }));
    pintarSeccion();
  });

  document.getElementById('qr-comb-hacer')?.addEventListener('click', hacerCombinar);
}

async function hacerCombinar() {
  const cola = colaEfectiva();
  if (cola.length < 2) return;

  await conTrabajo('qr-comb-hacer', 'Combinando…', async () => {
    // El documento abierto puede no estar leído: sus bytes están en memoria.
    const docs = [];
    for (const d of cola) {
      if (d.bytes) { docs.push({ bytes: d.bytes, nombre: d.nombre }); continue; }
      if (d.esActual || d.ruta === S.doc?.ruta) {
        // Con la tinta aplanada: lo anotado tiene que viajar al combinado.
        docs.push({ bytes: await aplanarTinta(S.doc.bytes, S.tinta), nombre: d.nombre });
        continue;
      }
      const leido = await api.docs.leer(d.ruta);
      docs.push({ bytes: leido.bytes, nombre: d.nombre });
    }

    const { bytes, indice } = await combinar(docs);
    const guardado = await api.docs.guardarComo(bytes, sugerirNombre('combinado'));
    if (!guardado) return;

    Toast.show({
      title: 'Combinado',
      text: `${indice.length} documentos · ${indice[indice.length - 1].hasta} páginas → ${guardado.nombre}`,
      icon: 'combinar',
    });
  });
}

/* ══ Dividir ═════════════════════════════════════════════════════════════════ */

function htmlDividir() {
  if (!S.doc) return necesitaDocumento('Abrí el PDF que querés partir en varios.');

  const c = V.corte;
  const partes = calcularPartes();

  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Cada parte sale como un PDF independiente, con las páginas copiadas sin
        re-renderizar. El original no se toca.
      </p>

      <div class="ox-segmented" id="qr-div-tipo" style="max-width:320px">
        <button class="ox-segmented__opt${c.tipo === 'cada' ? ' is-active' : ''}" data-value="cada">Cada N páginas</button>
        <button class="ox-segmented__opt${c.tipo === 'rangos' ? ' is-active' : ''}" data-value="rangos">Por rangos</button>
      </div>

      ${c.tipo === 'cada' ? `
        <div class="ox-field" style="max-width:280px">
          <label class="ox-field__label">Páginas por archivo</label>
          <div class="ox-stepper" id="qr-div-cada-stepper">
            <input class="ox-input ox-num" id="qr-div-cada" type="number" min="1" max="${S.doc.paginas}" value="${c.cada}">
            <div class="ox-stepper__btns">
              <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
              <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
            </div>
          </div>
        </div>` : `
        <div class="ox-field">
          <label class="ox-field__label">Rangos, uno por archivo</label>
          <input class="ox-input ox-input--mono" id="qr-div-rangos" spellcheck="false"
                 value="${esc(c.rangos)}" placeholder="1-3, 4-6, 7-">
          <span class="ox-field__hint">Separados por coma. Cada tramo es un archivo. Sobre ${S.doc.paginas} páginas.</span>
        </div>`}

      ${partes.length ? `
        <div class="qr-partes">
          <span class="ox-eyebrow">Van a salir ${plural(partes.length, 'archivo', 'archivos')}</span>
          <div class="qr-partes__lista">
            ${partes.slice(0, 12).map((p, i) => `
              <span class="ox-chip ox-chip--mono">${i + 1}. ${p.length === 1 ? `pág. ${p[0]}` : `${p[0]}–${p[p.length - 1]}`}</span>`).join('')}
            ${partes.length > 12 ? `<span class="ox-chip">y ${partes.length - 12} más</span>` : ''}
          </div>
        </div>` : '<span class="ox-meta">Ese corte no deja ninguna página.</span>'}

      <div class="qr-herr__acciones">
        <div class="ox-spacer"></div>
        <button class="ox-btn ox-btn--primary ox-flashable" id="qr-div-hacer" ${partes.length ? '' : 'disabled'}>
          <i data-icon="dividir"></i> Dividir y guardar
        </button>
      </div>
    </div>`;
}

function calcularPartes() {
  if (!S.doc) return [];
  const total = S.doc.paginas;
  const c = V.corte;
  if (c.tipo === 'rangos') {
    return String(c.rangos).split(',')
      .map((t) => resolverRango(t.trim(), total))
      .filter((r) => r.length);
  }
  const cada = Math.max(1, c.cada || 1);
  const out = [];
  for (let i = 0; i < total; i += cada) {
    out.push(Array.from({ length: Math.min(cada, total - i) }, (_, k) => i + k + 1));
  }
  return out;
}

function cablearDividir() {
  const seg = document.getElementById('qr-div-tipo');
  seg?.querySelectorAll('.ox-segmented__opt').forEach((b) => {
    b.addEventListener('click', () => { V.corte.tipo = b.dataset.value; pintarSeccion(); });
  });

  bindStepper(document.getElementById('qr-div-cada-stepper'));
  const cada = document.getElementById('qr-div-cada');
  cada?.addEventListener('input', () => {
    V.corte.cada = Math.max(1, parseInt(cada.value, 10) || 1);
    pintarSeccion();
    document.getElementById('qr-div-cada')?.focus();
  });

  const rangos = document.getElementById('qr-div-rangos');
  rangos?.addEventListener('change', () => { V.corte.rangos = rangos.value; pintarSeccion(); });

  document.getElementById('qr-div-hacer')?.addEventListener('click', hacerDividir);
}

async function hacerDividir() {
  const partes = calcularPartes();
  if (!partes.length) return;

  const carpeta = await attempt(() => api.docs.elegirCarpeta());
  if (!carpeta) return;

  await conTrabajo('qr-div-hacer', 'Dividiendo…', async () => {
    const base = S.doc.nombre.replace(/\.pdf$/i, '');
    const bytes = await aplanarTinta(S.doc.bytes, S.tinta);
    const salida = await dividir(bytes, { tipo: 'rangos', rangos: partes }, base);

    for (const p of salida) await api.docs.escribir(carpeta, p.nombre, p.bytes);

    Toast.show({
      title: `${plural(salida.length, 'archivo', 'archivos')}`,
      text: carpeta,
      icon: 'dividir',
    });
  });
}

/* ══ Exportar imágenes ═══════════════════════════════════════════════════════ */

function htmlExportar() {
  if (!S.doc) return necesitaDocumento('Abrí el PDF cuyas páginas querés exportar como imágenes.');

  const e = V.exportar;
  const fmt = FORMATOS[e.formato];
  const paginas = resolverRango(e.rango, S.doc.paginas);
  const geo = S.geometrias[(paginas[0] || 1) - 1];
  const medida = geo ? medidaAlDPI(geo, e.dpi) : null;
  const tinta = contarTinta(S.tinta);

  return `
    <div class="qr-herr__panel">
      <p class="qr-herr__intro">
        Cada página sale como un archivo de imagen. Acá sí se rasteriza —una
        imagen es eso—, así que la resolución es lo que decide la calidad.
      </p>

      <div class="qr-herr__grid">
        <div class="ox-field">
          <label class="ox-field__label">Formato</label>
          <div class="ox-segmented" id="qr-exp-formato">
            ${Object.entries(FORMATOS).map(([id, f]) => `
              <button class="ox-segmented__opt${e.formato === id ? ' is-active' : ''}" data-value="${id}">${f.etiqueta}</button>`).join('')}
          </div>
        </div>

        <div class="ox-field">
          <label class="ox-field__label">Páginas</label>
          <input class="ox-input ox-input--mono" id="qr-exp-rango" spellcheck="false"
                 value="${e.rango === 'todo' ? '' : esc(e.rango)}" placeholder="todas">
        </div>
      </div>

      <div class="ox-field">
        <label class="ox-field__label">Resolución</label>
        <div class="qr-dpis" id="qr-exp-dpi">
          ${DPIS.map((d) => `
            <button class="qr-dpi${e.dpi === d ? ' is-active' : ''}" data-value="${d}">
              <span class="qr-dpi__n ox-num">${d}</span><span class="ox-meta">dpi</span>
            </button>`).join('')}
        </div>
        ${medida ? `
          <span class="ox-field__hint">
            La página ${paginas[0] || 1} sale de <b class="ox-num">${medida.ancho} × ${medida.alto} px</b>.
            ${e.dpi >= 300 ? ' A esta resolución se puede volver a imprimir sin que se note.' : ''}
            ${medida.excedeLimite ? ' <span class="ox-danger">Demasiado grande: bajá el DPI.</span>' : ''}
          </span>` : ''}
      </div>

      ${fmt.calidad ? `
        <div class="ox-field" style="max-width:340px">
          <label class="ox-field__label">Calidad</label>
          <div class="ox-row" style="gap:10px;align-items:center">
            <input class="ox-slider ox-grow" id="qr-exp-calidad" type="range" min="40" max="100" step="1"
                   value="${Math.round(e.calidad * 100)}" style="--ox-pct:${((e.calidad * 100 - 40) / 60 * 100).toFixed(1)}%">
            <span class="ox-chip ox-chip--mono" id="qr-exp-calidad-eco">${Math.round(e.calidad * 100)}%</span>
          </div>
        </div>` : ''}

      ${tinta ? `
        <label class="ox-row" style="gap:12px">
          <button class="ox-switch${e.conTinta ? ' is-on' : ''}" id="qr-exp-tinta"></button>
          <span class="ox-col" style="gap:2px">
            <span class="ox-label">Incluir lo anotado</span>
            <span class="ox-meta">${plural(tinta, 'trazo', 'trazos')} en el documento.</span>
          </span>
        </label>` : ''}

      <div class="qr-herr__acciones">
        <div class="qr-progreso" id="qr-exp-progreso" hidden>
          <div class="ox-meter"><div class="ox-meter__fill" style="--ox-pct:0%"></div></div>
          <span class="ox-meta" id="qr-exp-progreso-txt"></span>
        </div>
        <div class="ox-spacer"></div>
        <span class="ox-meta">${plural(paginas.length, 'imagen', 'imágenes')}</span>
        <button class="ox-btn ox-btn--primary ox-flashable" id="qr-exp-hacer"
                ${!paginas.length || medida?.excedeLimite ? 'disabled' : ''}>
          <i data-icon="download"></i> Exportar
        </button>
      </div>
    </div>`;
}

function cablearExportar() {
  document.getElementById('qr-exp-formato')?.querySelectorAll('.ox-segmented__opt').forEach((b) => {
    b.addEventListener('click', () => { V.exportar.formato = b.dataset.value; pintarSeccion(); });
  });

  document.getElementById('qr-exp-dpi')?.querySelectorAll('.qr-dpi').forEach((b) => {
    b.addEventListener('click', () => { V.exportar.dpi = +b.dataset.value; pintarSeccion(); });
  });

  const rango = document.getElementById('qr-exp-rango');
  rango?.addEventListener('change', () => {
    V.exportar.rango = rango.value.trim() || 'todo';
    pintarSeccion();
  });

  const calidad = document.getElementById('qr-exp-calidad');
  calidad?.addEventListener('input', () => {
    V.exportar.calidad = +calidad.value / 100;
    calidad.style.setProperty('--ox-pct', `${((+calidad.value - 40) / 60 * 100).toFixed(1)}%`);
    document.getElementById('qr-exp-calidad-eco').textContent = `${calidad.value}%`;
  });

  document.getElementById('qr-exp-tinta')?.addEventListener('click', (ev) => {
    V.exportar.conTinta = !ev.currentTarget.classList.contains('is-on');
    ev.currentTarget.classList.toggle('is-on', V.exportar.conTinta);
  });

  document.getElementById('qr-exp-hacer')?.addEventListener('click', hacerExportar);
}

async function hacerExportar() {
  const e = V.exportar;
  const paginas = resolverRango(e.rango, S.doc.paginas);
  if (!paginas.length) return;

  const carpeta = await attempt(() => api.docs.elegirCarpeta());
  if (!carpeta) return;

  const barra = document.getElementById('qr-exp-progreso');
  const relleno = barra?.querySelector('.ox-meter__fill');
  const texto = document.getElementById('qr-exp-progreso-txt');
  if (barra) barra.hidden = false;

  await conTrabajo('qr-exp-hacer', 'Exportando…', async () => {
    const imagenes = await exportarImagenes(S.doc, {
      paginas,
      formato: e.formato,
      dpi: e.dpi,
      calidad: e.calidad,
      capa: e.conTinta ? S.tinta : null,
      rotacion: S.rotacion,
      onProgreso: (hecho, total) => {
        if (relleno) relleno.style.setProperty('--ox-pct', `${(hecho / total * 100).toFixed(1)}%`);
        if (texto) texto.textContent = `${hecho} de ${total}`;
      },
    });

    for (const img of imagenes) await api.docs.escribir(carpeta, img.nombre, img.bytes);

    const primera = imagenes[0];
    Toast.show({
      title: `${plural(imagenes.length, 'imagen exportada', 'imágenes exportadas')}`,
      text: `${primera.ancho} × ${primera.alto} px · ${carpeta}`,
      icon: 'download',
    });
  });

  if (barra) barra.hidden = true;
}

/* ── Común ───────────────────────────────────────────────────────────────── */

function sugerirNombre(sufijo) {
  const base = (S.doc?.nombre || 'documento').replace(/\.pdf$/i, '');
  return `${base}-${sufijo}.pdf`;
}

/** Bloquea el botón mientras dura la operación y muestra el error si falla. */
async function conTrabajo(idBoton, textoOcupado, fn) {
  if (V.trabajando) return;
  V.trabajando = true;
  const boton = document.getElementById(idBoton);
  const original = boton?.innerHTML;
  boton?.setAttribute('disabled', '');
  if (boton) boton.innerHTML = `${Icons.spinner()} ${textoOcupado}`;

  try {
    await fn();
  } catch (err) {
    console.error('[herramientas]', err);
    Toast.error('No se pudo completar', err.message);
  } finally {
    V.trabajando = false;
    boton?.removeAttribute('disabled');
    if (boton && original) boton.innerHTML = original;
  }
}

export { reorganizar };
