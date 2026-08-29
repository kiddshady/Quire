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
   ═══════════════════════════════════════════════════════════════════════════ */

import { S, alCambiar } from '../estado.js';
import { Icons } from '../icons.js';
import { Toast, Modal } from '../overlays.js';
import Router from '../router.js';
import { paint, head, empty, esc, attempt } from '../ui.js';
import { plural } from '../format.js';
import { reorganizar } from '../imposicion/motor.js';
import { aplanarTinta } from '../tinta/aplanar.js';

const api = window.onyx;

const V = {
  docRuta: null,
  orden: [],
  rotaciones: {},
  seleccion: new Set(),
  observador: null,
};

function reiniciar() {
  V.docRuta = S.doc?.ruta ?? null;
  V.orden = S.doc ? Array.from({ length: S.doc.paginas }, (_, i) => i + 1) : [];
  V.rotaciones = {};
  V.seleccion.clear();
}

/* Solo cuentan las rotaciones de páginas que SIGUEN en el documento: girar una
   y después quitarla no deja ningún cambio pendiente, y decir "2 giradas"
   mientras en pantalla no hay ninguna girada es peor que no decir nada. */
const paginasGiradas = () => V.orden.filter((n) => (V.rotaciones[n] || 0) % 360 !== 0);

const hayCambios = () => S.doc && (
  V.orden.length !== S.doc.paginas
  || V.orden.some((n, i) => n !== i + 1)
  || paginasGiradas().length > 0
);

/* ── Vista ───────────────────────────────────────────────────────────────── */

export function viewPaginas() {
  // Antes del early return: la pantalla vacía tiene que reaccionar cuando
  // aparece un documento (ver la nota en lector.js).
  Router.onLeave(alCambiar((que) => {
    if (que === 'documento') { reiniciar(); Router.refresh({ animar: true }); }
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

  // Si cambió el documento desde la última visita, se empieza de cero.
  if (V.docRuta !== S.doc.ruta || !V.orden.length) reiniciar();

  paint(head({
    title: 'Páginas',
    sub: `${esc(S.doc.nombre)} · ${V.orden.length} de ${S.doc.paginas}`,
    crumbs: [{ label: 'Documento', view: 'lector' }, { label: 'Páginas' }],
  }) + `
    <div class="qr-org">
      <div class="qr-org__barra">
        <button class="ox-btn ox-btn--ghost ox-btn--sm" id="org-todas">Seleccionar todas</button>
        <button class="ox-btn ox-btn--ghost ox-btn--sm" id="org-ninguna">Ninguna</button>
        <div class="ox-vr"></div>
        <span class="ox-chip" id="org-cuenta">nada seleccionado</span>
        <div class="ox-spacer"></div>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-rotar-izq" data-tip="Girar a la izquierda" disabled><i data-icon="rotarIzq"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-rotar-der" data-tip="Girar a la derecha" disabled><i data-icon="rotarDer"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" id="org-extraer" data-tip="Extraer a un PDF nuevo" disabled><i data-icon="external"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm qr-iconbtn-danger" id="org-borrar" data-tip="Quitar del documento" disabled><i data-icon="trash"></i></button>
      </div>

      <div class="qr-org__grilla" id="org-grilla"></div>

      <div class="qr-org__pie">
        <span class="ox-meta" id="org-estado"></span>
        <div class="ox-spacer"></div>
        <button class="ox-btn ox-btn--ghost ox-flashable" id="org-reiniciar" ${hayCambios() ? '' : 'disabled'}>
          <i data-icon="retry"></i> Descartar cambios
        </button>
        <button class="ox-btn ox-btn--primary ox-flashable" id="org-guardar" ${hayCambios() ? '' : 'disabled'}>
          <i data-icon="save"></i> Guardar como…
        </button>
      </div>
    </div>`);

  pintarGrilla();
  cablear();

  Router.onLeave(() => V.observador?.disconnect());
}

function pintarGrilla() {
  const grilla = document.getElementById('org-grilla');
  if (!grilla) return;

  grilla.innerHTML = V.orden.map((n, i) => {
    const g = S.geometrias[n - 1];
    const rot = (V.rotaciones[n] || 0) % 360;
    const girada = rot === 90 || rot === 270;
    const ratio = girada ? `${g.altoPt} / ${g.anchoPt}` : `${g.anchoPt} / ${g.altoPt}`;
    return `
      <button class="qr-org__item${V.seleccion.has(n) ? ' is-sel' : ''}" data-pagina="${n}" data-pos="${i}">
        <span class="qr-org__hoja" style="aspect-ratio:${ratio}" data-rot="${rot}"></span>
        <span class="qr-org__pie2">
          <span class="ox-num">${i + 1}</span>
          ${n !== i + 1 ? `<span class="ox-dim2">(era ${n})</span>` : ''}
          ${rot ? `<span class="ox-chip ox-chip--mono">${rot}°</span>` : ''}
        </span>
      </button>`;
  }).join('');

  /* Las miniaturas se pintan bajo demanda: en un documento largo, generar
     todas de una tarda más que abrir el archivo. */
  V.observador?.disconnect();
  V.observador = new IntersectionObserver(async (entradas, self) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      self.unobserve(e.target);
      const n = Number(e.target.dataset.pagina);
      const hoja = e.target.querySelector('.qr-org__hoja');
      try {
        const g = S.geometrias[n - 1];
        const canvas = await S.doc.lienzo(n, { escala: 190 / g.anchoPt, dpr: 2 });
        canvas.className = 'qr-org__lienzo';
        hoja.replaceChildren(canvas);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.error(`[páginas ${n}]`, err);
      }
    }
  }, { root: grilla, rootMargin: '150% 0px' });

  grilla.querySelectorAll('.qr-org__item').forEach((el) => V.observador.observe(el));
  actualizarBarra();
}

function actualizarBarra() {
  const n = V.seleccion.size;
  const cuenta = document.getElementById('org-cuenta');
  if (cuenta) {
    cuenta.textContent = n ? `${plural(n, 'página', 'páginas')}` : 'nada seleccionado';
    cuenta.classList.toggle('is-vacia', !n);
  }
  for (const id of ['org-rotar-izq', 'org-rotar-der', 'org-extraer', 'org-borrar']) {
    document.getElementById(id)?.toggleAttribute('disabled', !n);
  }
  // No se puede borrar todo: un PDF sin páginas no es un PDF.
  document.getElementById('org-borrar')?.toggleAttribute('disabled', !n || n >= V.orden.length);

  document.getElementById('org-guardar')?.toggleAttribute('disabled', !hayCambios());
  document.getElementById('org-reiniciar')?.toggleAttribute('disabled', !hayCambios());

  const estado = document.getElementById('org-estado');
  if (estado) {
    const quitadas = S.doc.paginas - V.orden.length;
    const rotadas = paginasGiradas().length;
    const partes = [];
    if (quitadas) partes.push(`${plural(quitadas, 'página quitada', 'páginas quitadas')}`);
    if (rotadas) partes.push(`${plural(rotadas, 'girada', 'giradas')}`);
    if (V.orden.some((p, i) => p !== i + 1) && !quitadas) partes.push('reordenado');
    estado.textContent = partes.length ? partes.join(' · ') : 'Sin cambios pendientes';
  }

  // El encabezado se pinta una vez; su cuenta hay que mantenerla al día a mano.
  const sub = document.querySelector('.ox-viewhead__sub');
  if (sub) sub.textContent = `${S.doc.nombre} · ${V.orden.length} de ${S.doc.paginas}`;
}

function cablear() {
  const $ = (id) => document.getElementById(id);

  $('org-grilla')?.addEventListener('click', (e) => {
    const item = e.target.closest('.qr-org__item');
    if (!item) return;
    const n = Number(item.dataset.pagina);

    /* Shift extiende desde la última: seleccionar veinte páginas de a una es
       trabajo, y este es el gesto que todo el mundo ya tiene aprendido. */
    if (e.shiftKey && V.ultima != null) {
      const desde = V.orden.indexOf(V.ultima);
      const hasta = V.orden.indexOf(n);
      const [a, b] = desde < hasta ? [desde, hasta] : [hasta, desde];
      for (let i = a; i <= b; i++) V.seleccion.add(V.orden[i]);
    } else if (e.ctrlKey || e.metaKey) {
      V.seleccion.has(n) ? V.seleccion.delete(n) : V.seleccion.add(n);
    } else if (V.seleccion.has(n) && V.seleccion.size === 1) {
      V.seleccion.clear();
    } else {
      V.seleccion.clear();
      V.seleccion.add(n);
    }
    V.ultima = n;

    document.querySelectorAll('.qr-org__item').forEach((el) => {
      el.classList.toggle('is-sel', V.seleccion.has(Number(el.dataset.pagina)));
    });
    actualizarBarra();
  });

  $('org-todas')?.addEventListener('click', () => {
    V.orden.forEach((n) => V.seleccion.add(n));
    pintarGrilla();
  });
  $('org-ninguna')?.addEventListener('click', () => { V.seleccion.clear(); pintarGrilla(); });

  $('org-rotar-izq')?.addEventListener('click', () => rotar(-90));
  $('org-rotar-der')?.addEventListener('click', () => rotar(90));

  $('org-borrar')?.addEventListener('click', () => {
    V.orden = V.orden.filter((n) => !V.seleccion.has(n));
    V.seleccion.clear();
    pintarGrilla();
  });

  $('org-extraer')?.addEventListener('click', extraer);
  $('org-guardar')?.addEventListener('click', guardar);
  $('org-reiniciar')?.addEventListener('click', () => { reiniciar(); Router.refresh(); });
}

function rotar(grados) {
  for (const n of V.seleccion) {
    V.rotaciones[n] = (((V.rotaciones[n] || 0) + grados) % 360 + 360) % 360;
  }
  pintarGrilla();
}

async function extraer() {
  const paginas = V.orden.filter((n) => V.seleccion.has(n));
  if (!paginas.length) return;

  await attempt(async () => {
    const bytes = await aplanarTinta(S.doc.bytes, S.tinta);
    const nuevo = await reorganizar(bytes, { orden: paginas, rotaciones: V.rotaciones });
    const base = S.doc.nombre.replace(/\.pdf$/i, '');
    const guardado = await api.docs.guardarComo(nuevo, `${base}-extraido.pdf`);
    if (!guardado) return;
    Toast.show({
      title: `${plural(paginas.length, 'página extraída', 'páginas extraídas')}`,
      text: guardado.nombre,
      icon: 'external',
    });
  }, { errorTitle: 'No se pudo extraer' });
}

async function guardar() {
  if (!hayCambios()) return;

  await attempt(async () => {
    const bytes = await aplanarTinta(S.doc.bytes, S.tinta);
    const nuevo = await reorganizar(bytes, { orden: V.orden, rotaciones: V.rotaciones });
    const base = S.doc.nombre.replace(/\.pdf$/i, '');
    const guardado = await api.docs.guardarComo(nuevo, `${base}-organizado.pdf`);
    if (!guardado) return;

    Toast.show({
      title: 'Guardado',
      text: `${plural(V.orden.length, 'página', 'páginas')} → ${guardado.nombre}`,
      icon: 'save',
    });

    const abrir = await Modal.confirm({
      title: '¿Abrir el archivo nuevo?',
      sub: `${guardado.nombre}. El original sigue como estaba.`,
      confirmLabel: 'Abrirlo',
    });
    if (abrir) {
      const archivo = await api.docs.leer(guardado.ruta);
      const { abrir: abrirDoc } = await import('../estado.js');
      await abrirDoc(archivo);
      reiniciar();
      Router.go('lector');
    }
  }, { errorTitle: 'No se pudo guardar' });
}
