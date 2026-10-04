/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — Piezas (documentación viva)
   Todos los primitivos del sistema, funcionando. No es una vista del producto:
   es el catálogo contra el que se compara todo lo demás.

   Regla: si un primitivo no aparece acá, no existe en el sistema. Agregarlo
   acá es parte de crearlo — un componente sin vitrina se vuelve invisible y
   alguien termina reinventándolo peor tres pantallas más allá.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast, Menu, Modal } from './overlays.js';
import { bindSwitcher, bindStepper, swap, ocupar, contador } from './motion.js';
import { mark, status, copy, colorToken, path, esc } from './ui.js';

/* ── Las tres perillas ───────────────────────────────────────────────────────
   Los presets del acento. El nombre importa: son las cinco temperaturas que
   cubren casi cualquier app. El rojo NO está, a propósito — está reservado
   para el fallo, y un acento rojo lo deja sin significado. */
const ACCENTS = [
  { id: 'luz',     label: 'Luz',      rgb: '240 243 247', hue: 258 },
  { id: 'cian',    label: 'Cian',     rgb: '34 211 238',  hue: 205 },
  { id: 'violeta', label: 'Violeta',  rgb: '167 139 250', hue: 285 },
  { id: 'verde',   label: 'Verde',    rgb: '74 222 128',  hue: 155 },
  { id: 'ambar',   label: 'Ámbar',    rgb: '251 191 36',  hue: 60 },
];

const swatch = (name, varName) => `
  <div class="ox-col" style="gap:6px">
    <div style="height:52px;border-radius:8px;background:var(${varName});box-shadow:var(--ox-hairline)"></div>
    <span class="ox-meta">${name}</span>
    <span class="ox-mono ox-dim2" style="font-size:10px">${varName}</span>
  </div>`;

const fadeDemoRows = Array.from({ length: 14 }, (_, i) =>
  `<div style="padding:7px 0;font-size:12px;color:var(--ox-text-2);box-shadow:inset 0 -1px 0 var(--ox-line)">Elemento de lista ${i + 1}</div>`).join('');

const section = (title, note, body) => `
  <section style="margin-bottom:40px">
    <div class="ox-row" style="margin-bottom:4px"><span class="ox-eyebrow">${title}</span></div>
    ${note ? `<p class="ox-meta ox-copyable" style="max-width:640px;line-height:1.65;margin-bottom:16px">${note}</p>` : '<div style="height:12px"></div>'}
    ${body}
  </section>`;

export function designHTML() {
  return `
    <div class="ox-scroll ox-grow" id="design-scroll">
    <div id="design-body" style="max-width:920px">

      ${section('Las perillas', 'Todo el sistema deriva de estas cuatro variables. Movelas: la app entera se re-tinta en vivo, incluido el color con el que el compositor de Windows pinta el frame de restaurar. Esto es literalmente lo que hacés al empezar una app nueva — salvo que ahí lo hacés con <span class="ox-mono">node tools/retint.mjs</span>, que además mantiene en sincronía las dos copias en hex del color base.', `
        <div class="ox-card" style="padding:18px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px 28px;align-items:start">
            <div class="ox-field">
              <label class="ox-field__label">Matiz <span class="ox-mono ox-dim2" id="hue-val"></span></label>
              <input type="range" class="ox-slider" id="knob-hue" min="0" max="360" step="1">
              <span class="ox-field__hint">El matiz de toda la escalera de grises. El gris puro se lee muerto.</span>
            </div>
            <div class="ox-field">
              <label class="ox-field__label">Temperatura <span class="ox-mono ox-dim2" id="tint-val"></span></label>
              <input type="range" class="ox-slider" id="knob-tint" min="0" max="60" step="1">
              <span class="ox-field__hint">Cuánta croma. 0 es gris absoluto; arriba de 3 el tinte es evidente.</span>
            </div>
            <div class="ox-field" style="grid-column:1/-1">
              <label class="ox-field__label">Monoespaciada</label>
              <div class="ox-row" style="gap:6px;flex-wrap:wrap" id="knob-mono"></div>
              <span class="ox-field__hint">Empaquetada en <span class="ox-mono">renderer/fonts/</span>, no tomada del sistema: si depende de lo que haya instalado, la app se ve distinta en cada máquina.</span>
              <div class="ox-sunken" style="margin-top:10px;padding:12px 14px">
                <div class="ox-mono" id="mono-sample" style="font-size:13px;line-height:19px">
                  const total = items.filter(i =&gt; i.ok).length;  // 0O1lI|i{}[]<br>
                  n-0007 · 42.3k · 1m 12s · C:\\tools\\Onyx · ñ á é í ó ú ü
                </div>
              </div>
            </div>

            <div class="ox-field" style="grid-column:1/-1">
              <label class="ox-field__label">Acento</label>
              <div class="ox-row" style="gap:6px;flex-wrap:wrap" id="knob-accent">
                ${ACCENTS.map((a) => `
                  <button class="ox-btn ox-btn--secondary ox-flashable" data-accent="${a.id}" style="gap:8px">
                    <span style="width:11px;height:11px;border-radius:50%;background:rgb(${a.rgb});box-shadow:0 0 0 1px rgb(0 0 0 / .35)"></span>${a.label}
                  </button>`).join('')}
                <div class="ox-spacer"></div>
                <button class="ox-btn ox-btn--ghost ox-flashable" id="knob-reset"><i data-icon="retry"></i> Volver al default</button>
              </div>
              <span class="ox-field__hint">Con un acento saturado, revisá <span class="ox-mono">--ox-accent-ink</span>: la tinta encima tiene que contrastar.</span>
            </div>
          </div>
        </div>`)}

      ${section('Superficies', 'La jerarquía se construye por elevación, nunca con bordes marcados. Cada plano que flota sube un escalón y proyecta sombra. La croma crece con la luminancia: un plano claro necesita más temperatura que uno oscuro para no verse lavado.', `
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">
          ${swatch('Hundido', '--ox-sunken')}${swatch('Base', '--ox-bg')}${swatch('Rail', '--ox-s1')}
          ${swatch('Panel', '--ox-s2')}${swatch('Flotante', '--ox-s3')}${swatch('Máximo', '--ox-s4')}
        </div>

        <!-- LAS DOS FORMAS DE LA TARJETA, y están las dos a propósito.

             El cuerpo llevaba padding-top en cero para no repetir el aire que
             el encabezado ya pone. Con encabezado se veía perfecto; SIN él, el
             contenido quedaba pegado al borde de arriba: 0 px contra 16 abajo.

             Sobrevivió porque acá se mostraba UNA tarjeta y con padding inline,
             salteándose el componente. La vitrina existe para ver las piezas y
             era el único lugar donde la pieza rota no se veía. Si una variante
             no está en esta página, no está verificada. -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
          <div class="ox-card">
            <div class="ox-card__head">
              <span class="ox-grow" style="font-size:var(--ox-fs-13)">Con encabezado</span>
              <button class="ox-iconbtn" data-tip="Más">${Icons.svg('more')}</button>
            </div>
            <div class="ox-card__body">
              <div class="ox-kv">
                <span class="ox-kv__k">Estado</span><span class="ox-kv__v">Listo</span>
                <span class="ox-kv__k">Versión</span><span class="ox-kv__v ox-mono">1.4.0</span>
              </div>
            </div>
          </div>
          <div class="ox-card">
            <div class="ox-card__body">
              <div class="ox-kv">
                <span class="ox-kv__k">Sin head</span><span class="ox-kv__v">El cuerpo pone su aire</span>
                <span class="ox-kv__k">Arriba</span><span class="ox-kv__v ox-mono">= abajo</span>
              </div>
            </div>
          </div>
        </div>`)}

      ${section('Tipografía', 'Sans para toda la interfaz, mono <b>solo</b> para dato exacto: IDs, números, rutas, timestamps. El mono en texto corrido se ve técnico de más; la sans en una columna de números la desalinea.', `
        <div class="ox-col" style="gap:10px">
          <div class="ox-display">Instrumento silencioso</div>
          <div class="ox-title">Título de vista</div>
          <div class="ox-subtitle">Subtítulo de panel</div>
          <div>Cuerpo de la interfaz a 13 píxeles, que es la densidad de una herramienta profesional.</div>
          <div class="ox-meta">Metadato secundario · 11 px</div>
          <div class="ox-eyebrow">Versalita espaciada</div>
          <div class="ox-mono">n-0007 · 42.3k · 1m 12s · C:\\tools\\Onyx</div>
        </div>`)}

      ${section('Texto que no entra', 'Recortar tiene dos formas y no son intercambiables. Un <b>nombre</b> se corta por la cola, que es donde deja de importar. Una <b>ruta</b> se corta por el medio: el principio lo comparten todas y el final es lo único que la identifica, así que <span class="ox-mono">.ox-truncate</span> sobre una ruta deja justo la mitad que no informa. Y ojo con <span class="ox-mono">.ox-truncate</span> sobre un <span class="ox-mono">&lt;span&gt;</span> suelto: en un elemento <i>inline</i> <span class="ox-mono">overflow</span> no aplica, la clase no hace nada y el texto se corta al aire — por eso la clase trae <span class="ox-mono">display:block</span>.', `
        <div class="ox-card" style="max-width:320px"><div class="ox-card__body ox-col" style="gap:16px">
          <div class="ox-col" style="gap:6px">
            <span class="ox-eyebrow">.ox-truncate · por la cola</span>
            <div class="ox-truncate">Configuración de despliegue del entorno de staging</div>
            <div class="ox-truncate ox-mono ox-dim">C:\\Users\\fulano\\AppData\\Roaming\\Onyx\\data</div>
          </div>
          <div class="ox-col" style="gap:6px">
            <span class="ox-eyebrow">.ox-path · por el medio</span>
            <div class="ox-mono ox-dim">${path('C:\\Users\\fulano\\AppData\\Roaming\\Onyx\\data')}</div>
          </div>
        </div></div>`)}

      ${section('Estado', 'La pieza central. La <b>forma</b> dice qué es la cosa, la <b>luminancia</b> si está viva, y el <b>movimiento</b> es exclusivo de lo que corre ahora mismo. Con eso se lee una pantalla entera sin un solo color — que es el punto: así el rojo queda libre para significar «se rompió».', `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:20px 12px">
          ${['idle', 'queued', 'running', 'waiting', 'done', 'skipped', 'failed'].map((s) => `
            <div class="ox-col" style="gap:8px">${status(s)}
              <div class="ox-row" style="gap:10px;padding-left:2px">
                ${mark(s, 'circle')}${mark(s, 'square')}
              </div>
            </div>`).join('')}
        </div>
        <div class="ox-row ox-meta ox-dim2" style="gap:20px;margin-top:22px;flex-wrap:wrap">
          ${[['circle', 'círculo'], ['square', 'cuadrado']]
            .map(([k, label]) => `<span class="ox-row" style="gap:7px">${mark('done', k)}${label}</span>`).join('')}
        </div>`)}

      ${section('Botones', 'Como máximo un primario por pantalla: en una paleta acromática el blanco pleno <i>es</i> el acento, y dos acentos compitiendo destruyen la jerarquía. El sólido rojo se reserva para lo que no tiene vuelta atrás.', `
        <div class="ox-row" style="flex-wrap:wrap;gap:8px">
          <button class="ox-btn ox-btn--primary ox-flashable"><i data-icon="play"></i> Acción primaria</button>
          <button class="ox-btn ox-btn--secondary ox-flashable">Secundario</button>
          <button class="ox-btn ox-btn--ghost ox-flashable">Ghost</button>
          <button class="ox-btn ox-btn--danger ox-flashable"><i data-icon="trash"></i> Eliminar</button>
          <button class="ox-btn ox-btn--danger-solid ox-flashable">Borrar todo</button>
          <button class="ox-btn ox-btn--secondary" disabled>Deshabilitado</button>
          <button class="ox-iconbtn" data-tip="Botón de ícono"><i data-icon="settings"></i></button>
          <button class="ox-iconbtn" disabled><i data-icon="trash"></i></button>
          <button class="ox-btn ox-btn--sm ox-btn--secondary">Chico</button>
          <button class="ox-btn ox-btn--lg ox-btn--secondary">Grande</button>
        </div>`)}

      ${section('Campos y controles', 'Ningún control nativo de Chromium sobrevive: el select abre un menú nuestro, el tilde se dibuja con <span class="ox-mono">stroke-dashoffset</span> y la cápsula del segmentado viaja entre opciones en vez de saltar. Un control nativo grita «esto es una página web en una ventana».', `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px">
          <div class="ox-field">
            <label class="ox-field__label">Nombre</label>
            <input class="ox-input" value="Sin título" spellcheck="false">
          </div>
          <div class="ox-field">
            <label class="ox-field__label">Modelo</label>
            <button class="ox-select" id="demo-select">
              <span class="ox-select__value">claude-opus-5</span><i data-icon="chevronDown"></i>
            </button>
          </div>
          <div class="ox-field">
            <label class="ox-field__label">Con error</label>
            <input class="ox-input is-invalid" value="temperatura = 3.4" spellcheck="false">
            <span class="ox-field__hint ox-field__hint--error">Tiene que estar entre 0 y 1.</span>
          </div>
          <div class="ox-field">
            <label class="ox-field__label">Deslizador</label>
            <input type="range" class="ox-slider" id="demo-slider" min="0" max="100" value="30">
          </div>
          <div class="ox-field">
            <label class="ox-field__label">Copias</label>
            <div class="ox-stepper" id="demo-stepper">
              <input class="ox-input ox-num" type="number" min="1" max="12" step="1" value="1">
              <div class="ox-stepper__btns">
                <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
                <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
              </div>
            </div>
            <span class="ox-field__hint">Mantené apretada una flecha: repite, y acelera. El tope apaga el botón.</span>
          </div>
          <div class="ox-field" style="grid-column:1/-1">
            <label class="ox-field__label">Texto largo</label>
            <textarea class="ox-textarea" placeholder="Escribí algo…"></textarea>
          </div>
          <div class="ox-col" style="gap:12px">
            <label class="ox-row" style="gap:10px"><button class="ox-switch is-on" data-toggle></button> <span class="ox-label">Guardado automático</span></label>
            <label class="ox-row" style="gap:10px"><button class="ox-switch" data-toggle></button> <span class="ox-label">Confirmar al salir</span></label>
            <label class="ox-row" style="gap:10px"><button class="ox-check is-on" data-check><i data-icon="check"></i></button> <span class="ox-label">Recordar la ventana</span></label>
            <label class="ox-row" style="gap:10px"><button class="ox-check" data-check><i data-icon="check"></i></button> <span class="ox-label">Notificar al terminar</span></label>
          </div>
          <div class="ox-col" style="gap:12px;align-items:flex-start">
            <div class="ox-segmented" id="demo-seg">
              <button class="ox-segmented__opt is-active" data-value="a">Lista</button>
              <button class="ox-segmented__opt" data-value="b">Grilla</button>
              <button class="ox-segmented__opt" data-value="c">Tabla</button>
            </div>
            <div class="ox-tabs" id="demo-tabs">
              <button class="ox-tab is-active" data-value="1">Resumen</button>
              <button class="ox-tab" data-value="2">Detalle <span class="ox-tab__count">12</span></button>
              <button class="ox-tab" data-value="3">Historial</button>
            </div>
            <div class="ox-row" style="gap:6px">
              <span class="ox-kbd">Ctrl</span><span class="ox-kbd">S</span>
              <span class="ox-meta">una tecla, dibujada</span>
            </div>
          </div>
        </div>`)}

      ${section('Overlays', 'Todos entran <i>y salen</i> animados, y todos son nuestros: ni un <span class="ox-mono">title=</span> amarillo, ni un <span class="ox-mono">confirm()</span> del sistema. Lo que más se olvida es la salida — un overlay que desaparece de golpe hace sentir rota a toda la app.', `
        <div class="ox-row" style="flex-wrap:wrap;gap:8px">
          <button class="ox-btn ox-btn--secondary" data-tip="Portaleado, con entrada y salida animadas, y se da vuelta solo si no entra">Tooltip (hover)</button>
          <button class="ox-btn ox-btn--secondary ox-flashable" id="demo-menu">Menú</button>
          <button class="ox-btn ox-btn--secondary ox-flashable" id="demo-modal">Modal</button>
          <button class="ox-btn ox-btn--secondary ox-flashable" id="demo-confirm">Confirmación destructiva</button>
          <button class="ox-btn ox-btn--secondary ox-flashable" id="demo-toast">Toast</button>
          <button class="ox-btn ox-btn--secondary ox-flashable" id="demo-toast-err">Toast de error</button>
        </div>`)}

      ${section('Reescribir un bloque', 'Un <span class="ox-mono">innerHTML</span> a secas es un corte: lo viejo se va en el mismo cuadro en que llega lo nuevo. <span class="ox-mono">swap(el, html, { relevo })</span> distingue los casos: lo que <b>aparece</b> se funde, lo que <b>se va</b> termina de irse, un estado que <b>reemplaza</b> a otro hace relevo en el mismo lugar, y un cambio de <b>valores</b> se escribe en el lugar sin volver a animar. Tocá los estados en cualquier orden, rápido también.', `
        <div class="ox-row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap" id="demo-swap-btns">
          <button class="ox-btn ox-btn--ghost ox-btn--sm" data-swap="pista">Pista</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" data-swap="cargando">Cargando</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" data-swap="resultado">Resultado</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" data-swap="vacio">Vaciar</button>
        </div>
        <div class="ox-card" style="max-width:420px">
          <div class="ox-card__body">
            <div id="demo-swap" style="display:flex;align-items:center;gap:10px;min-height:40px"></div>
          </div>
        </div>`)}

      ${section('Ocupado y contadores', 'Dos piezas para lo que cambia con la app andando, armadas sobre <span class="ox-mono">swap()</span>. <span class="ox-mono">ocupar(btn, ocupado, html)</span>: un botón que hace un trabajo pasa a «ocupado» con un relevo en el lugar, y su ancho viaja en vez de saltar — al achicarse espera a que el rótulo que se va casi no se vea, así la caja no lo corta. El vecino acompaña. <span class="ox-mono">contador(el, n)</span>: un contador que solo se ve cuando hay algo; aparece y se va fundiéndose, y cuando cambia se escribe en su lugar con un destello.', `
        <div class="ox-row" style="gap:8px;margin-bottom:16px;align-items:center">
          <button class="ox-btn ox-btn--primary ox-flashable" id="demo-ocupar" data-ocupado="0">${Icons.svg('download')} Exportar</button>
          <span class="ox-meta" id="demo-ocupar-vecino">el vecino acompaña</span>
        </div>
        <div class="ox-row" style="gap:8px;align-items:center">
          <button class="ox-btn ox-btn--ghost ox-btn--sm" id="demo-contar-mas">Sumar</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" id="demo-contar-vaciar">Vaciar</button>
          <div class="ox-navitem" style="width:200px;pointer-events:none">${Icons.svg('grid')} Páginas <span class="ox-navitem__count" id="demo-contador"></span></div>
        </div>`)}

      ${section('Mostrar y esconder', 'Lo que se prende con <span class="ox-mono">el.hidden</span> no aparece de golpe: con <span class="ox-mono">.ox-plegable</span> el alto se pliega mientras se desvanece, y lo de abajo se corre de a poco en vez de saltar. <span class="ox-mono">.ox-plegable--ancho</span> hace lo mismo en una fila, con los de al lado. El JS no cambia: sigue siendo <span class="ox-mono">hidden</span>. Si manejás una clase y tenés un envoltorio, <span class="ox-mono">.ox-reveal</span>.', `
        <div class="ox-row" style="gap:8px;margin-bottom:12px">
          <button class="ox-btn ox-btn--ghost ox-btn--sm" id="demo-plegar">Opciones avanzadas</button>
          <button class="ox-btn ox-btn--ghost ox-btn--sm" id="demo-plegar-ancho">Dato del medio</button>
        </div>
        <div class="ox-card" style="max-width:420px">
          <div class="ox-card__body">
            <div class="ox-plegable" id="demo-plegable" hidden>
              <div class="ox-meta" style="padding-bottom:12px">Lo que estaba escondido. Todo lo de abajo se corre con él.</div>
            </div>
            <div class="ox-row" id="demo-plegable-fila" style="gap:8px;--ox-plegable-gap:8px">
              <span class="ox-chip">primero</span>
              <span class="ox-chip ox-plegable--ancho" id="demo-plegable-ancho">el del medio</span>
              <span class="ox-chip">último</span>
            </div>
          </div>
        </div>`)}

      ${section('Métricas y medidores', '', `
        <div class="ox-row" style="gap:40px;margin-bottom:20px;flex-wrap:wrap">
          <div class="ox-stat"><span class="ox-stat__value">42.3<span class="ox-stat__unit">k</span></span><span class="ox-stat__label">Registros</span></div>
          <div class="ox-stat"><span class="ox-stat__value">96<span class="ox-stat__unit">%</span></span><span class="ox-stat__label">Éxito</span></div>
          <div class="ox-stat"><span class="ox-stat__value"><span class="ox-stat__unit">USD </span>3.42</span><span class="ox-stat__label">Gasto</span></div>
        </div>
        <div class="ox-col" style="gap:14px;max-width:420px">
          <div class="ox-meter" style="--ox-pct:62%"><div class="ox-meter__fill"></div></div>
          <div class="ox-meter ox-meter--danger" style="--ox-pct:88%"><div class="ox-meter__fill"></div></div>
          <div class="ox-meter ox-meter--indeterminate"><div class="ox-meter__fill"></div></div>
        </div>`)}

      ${section('Chips, avatares y esqueletos', 'El esqueleto va donde va a aparecer el contenido, con su forma. Un spinner centrado dice «esperá»; un esqueleto dice «esto va a ser una lista de tres líneas», que es mucho más.', `
        <div class="ox-row" style="flex-wrap:wrap;gap:8px;margin-bottom:20px">
          <span class="ox-chip">7 elementos</span>
          <span class="ox-chip ox-chip--mono">claude-opus-5</span>
          <span class="ox-chip ox-chip--outline">Borrador</span>
          <span class="ox-chip ox-chip--danger">2 fallos</span>
          <span class="ox-avatar">FP</span>
          <span class="ox-avatar ox-avatar--lg">ON</span>
        </div>
        <div class="ox-col" style="gap:8px;max-width:420px">
          <div class="ox-skeleton" style="height:12px;width:70%"></div>
          <div class="ox-skeleton" style="height:12px;width:92%"></div>
          <div class="ox-skeleton" style="height:12px;width:48%"></div>
        </div>`)}

      ${section('Listas y tablas', 'La fila entera es el objetivo del click, no un link adentro. Las acciones de fila aparecen con el hover para no ensuciar la lectura en reposo.', `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">
          <div class="ox-list">
            ${[['Documento de trabajo', 'modificado recién', 'running'],
               ['Notas de la reunión', 'hace 2 h', 'done'],
               ['Borrador sin título', 'ayer', 'idle']].map(([t, s, st]) => `
              <div class="ox-listitem" role="button" tabindex="0">
                ${mark(st)}
                <div class="ox-listitem__main">
                  <span class="ox-listitem__title">${t}</span>
                  <span class="ox-listitem__sub">${s}</span>
                </div>
                <div class="ox-rowactions">
                  <button class="ox-iconbtn ox-iconbtn--sm" data-tip="Editar"><i data-icon="edit"></i></button>
                  <button class="ox-iconbtn ox-iconbtn--sm" data-tip="Más"><i data-icon="more"></i></button>
                </div>
              </div>`).join('')}
          </div>
          <table class="ox-table">
            <thead><tr><th>Id</th><th>Estado</th><th class="ox-td--num">Tamaño</th></tr></thead>
            <tbody>
              ${[['n-0003', 'done', '4.2 kB'], ['n-0002', 'failed', '820 B'], ['n-0001', 'done', '12 kB']].map(([id, st, sz]) => `
                <tr class="ox-tr"><td class="ox-mono">${id}</td><td>${status(st)}</td><td class="ox-td--num ox-num">${sz}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>`)}

      ${section('Esfumado del scroll', 'Donde el scroll recorta <b>al aire</b>, el contenido se desvanece: un corte al aire se lee como un bug, y el fade dice «hay más, seguí». Pero el fade no va en todo corte — va donde nada más explica el límite. Si de ese lado hay una línea, la línea YA es el límite: el esfumado encima la ensucia y además miente, porque el contenido no se pierde en la nada sino que muere contra un borde. Ese lado se apaga con <span class="ox-mono">.ox-scroll--line-top</span> / <span class="ox-mono">--line-bottom</span>. Los dos casos, con la misma lista:', `
        <div class="ox-row" style="gap:20px;align-items:flex-start;flex-wrap:wrap">
          <div class="ox-col" style="gap:8px">
            <span class="ox-meta">Sin borde — se esfuma de los dos lados</span>
            <div style="width:296px;height:180px">
              <div class="ox-scroll" style="height:100%;--ox-fade:20px">
                ${fadeDemoRows}
              </div>
            </div>
          </div>
          <div class="ox-col" style="gap:8px">
            <span class="ox-meta">Con borde — corta limpio contra él</span>
            <div class="ox-sunken" style="width:296px;height:180px;overflow:hidden">
              <div class="ox-scroll ox-scroll--line-top ox-scroll--line-bottom"
                   style="height:100%;padding-left:14px;padding-right:14px;--ox-fade:20px">
                ${fadeDemoRows}
              </div>
            </div>
          </div>
        </div>`)}

      ${section('Íconos', 'El set base. Todos sobre grilla de 16, trazo 1.5, puntas redondeadas — por eso se ven de la misma familia. Hacé click en cualquiera para copiar su etiqueta. Los de tu dominio se suman con <span class="ox-mono">Icons.add({...})</span>, no editando este archivo.', `
        <div id="icon-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(94px,1fr));gap:2px">
          ${Icons.names.map((n) => `
            <button class="ox-iconcell" data-icon-name="${n}" data-tip="&lt;i data-icon=&quot;${n}&quot;&gt;">
              ${Icons.svg(n, 'ox-icon--lg')}<span class="ox-truncate">${n}</span>
            </button>`).join('')}
        </div>`)}

    </div>
    <div style="height:32px"></div>
    </div>`;
}

const DEMO_MENU = [
  { groupLabel: 'Acciones' },
  { label: 'Abrir', icon: 'external', key: 'Ctrl O' },
  { label: 'Editar', icon: 'edit' },
  { label: 'Duplicar', icon: 'duplicate', selected: true },
  { sep: true },
  { label: 'Eliminar', icon: 'trash', danger: true },
];

/* ── Las perillas en vivo ────────────────────────────────────────────────────
   Escriben sobre :root, que es exactamente lo que harías en tokens.css. Se
   avisa al proceso principal del color nuevo para que el frame fantasma del
   compositor siga camuflado (si no, minimizar y restaurar delata el cambio). */
const root = document.documentElement;

function readKnob(name, fallback) {
  const v = getComputedStyle(root).getPropertyValue(name).trim();
  return v ? parseFloat(v) : fallback;
}

function pushBackground() {
  /* Mover las perillas re-tinta la app entera, así que el fondo de la ventana
     tiene que seguirlas o el frame fantasma del restore queda del color viejo.
     La traducción a hex la hace colorToken() con un canvas — ver ui.js. */
  const hex = colorToken('--ox-bg');
  if (hex) window.onyx?.win?.setBackground(hex);
}

export function wireDesign(rootEl) {
  /* Perillas */
  const hue = rootEl.querySelector('#knob-hue');
  const tint = rootEl.querySelector('#knob-tint');
  const hueVal = rootEl.querySelector('#hue-val');
  const tintVal = rootEl.querySelector('#tint-val');

  const syncSlider = (el) => el.style.setProperty('--ox-pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);

  const applyHue = () => {
    root.style.setProperty('--ox-hue', hue.value);
    hueVal.textContent = `${hue.value}°`;
    syncSlider(hue);
    pushBackground();
  };
  const applyTint = () => {
    const v = (tint.value / 10).toFixed(1);
    root.style.setProperty('--ox-tint', v);
    tintVal.textContent = `×${v}`;
    syncSlider(tint);
    pushBackground();
  };

  hue.value = readKnob('--ox-hue', 258);
  tint.value = Math.round(readKnob('--ox-tint', 1) * 10);
  applyHue();
  applyTint();
  hue.addEventListener('input', applyHue);
  tint.addEventListener('input', applyTint);

  /* Las monoespaciadas se descubren solas leyendo los tokens `--ox-mono-*` de
     las hojas de estilo. Si mañana sumás una en tokens.css, aparece acá sin
     tocar este archivo — que es la única forma de que la vitrina no mienta. */
  const monoHost = rootEl.querySelector('#knob-mono');
  const monoIds = monoHost ? [...new Set(
    [...document.styleSheets]
      .flatMap((ss) => { try { return [...ss.cssRules]; } catch { return []; } })
      .filter((r) => r.style)
      .flatMap((r) => [...r.style].filter((p) => p.startsWith('--ox-mono-')))
      .map((p) => p.replace('--ox-mono-', '')),
  )].sort() : [];

  /* Los botones se arman una vez y después solo cambian de variante. Antes se
     rehacían con innerHTML en cada click: el elegido pasaba a primario de un
     cuadro al otro (era un nodo nuevo, sin de dónde transicionar) y el
     destello del click se iba con el nodo viejo. La vitrina es lo que se
     copia: tiene que mostrar el patrón bueno. */
  const pintarMono = () => {
    if (!monoHost) return;
    if (!monoHost.children.length) {
      monoHost.innerHTML = monoIds.map((id) => `
        <button class="ox-btn ox-flashable" data-mono="${id}" style="font-family:var(--ox-mono-${id})">${id}</button>`).join('');
    }
    /* getComputedStyle RESUELVE el var() de una propiedad propia: devuelve la
       familia, no `var(--ox-mono-roboto)`. Se compara la familia de cada
       token con la que quedó. Antes se buscaba el nombre del token adentro
       del valor, no aparecía nunca, y ningún botón salía elegido. */
    const cs = getComputedStyle(root);
    const hoy = cs.getPropertyValue('--ox-mono').trim();
    for (const b of monoHost.querySelectorAll('[data-mono]')) {
      const es = cs.getPropertyValue(`--ox-mono-${b.dataset.mono}`).trim() === hoy;
      b.classList.toggle('ox-btn--primary', es);
      b.classList.toggle('ox-btn--secondary', !es);
    }
  };
  pintarMono();

  monoHost?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mono]');
    if (!btn) return;
    root.style.setProperty('--ox-mono', `var(--ox-mono-${btn.dataset.mono})`);
    pintarMono();
    Toast.show({ title: `Mono: ${btn.dataset.mono}`, text: `--ox-mono: var(--ox-mono-${btn.dataset.mono})`, icon: 'check' });
  });

  rootEl.querySelector('#knob-accent')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-accent]');
    if (!btn) return;
    const a = ACCENTS.find((x) => x.id === btn.dataset.accent);
    root.style.setProperty('--ox-accent-rgb', a.rgb);
    // Con un acento de color, la tinta encima tiene que ser oscura igual, pero
    // el matiz de la app acompaña: es lo que hace que se vea deliberado y no
    // como un color pegado encima de un gris ajeno.
    hue.value = a.hue;
    applyHue();
    Toast.show({ title: `Acento: ${a.label}`, text: `--ox-accent-rgb: ${a.rgb}`, icon: 'check' });
  });

  rootEl.querySelector('#knob-reset')?.addEventListener('click', () => {
    root.style.removeProperty('--ox-accent-rgb');
    root.style.removeProperty('--ox-hue');
    root.style.removeProperty('--ox-tint');
    root.style.removeProperty('--ox-mono');
    pintarMono();
    hue.value = readKnob('--ox-hue', 258);
    tint.value = Math.round(readKnob('--ox-tint', 1) * 10);
    applyHue();
    applyTint();
  });

  /* Controles */
  rootEl.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('is-on')));
  rootEl.querySelectorAll('[data-check]').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('is-on')));

  const seg = rootEl.querySelector('#demo-seg');
  if (seg) bindSwitcher(seg, () => {});
  const tabs = rootEl.querySelector('#demo-tabs');
  if (tabs) bindSwitcher(tabs, () => {});

  const slider = rootEl.querySelector('#demo-slider');
  if (slider) {
    const sync = () => syncSlider(slider);
    sync();
    slider.addEventListener('input', sync);
  }

  const stepper = rootEl.querySelector('#demo-stepper');
  if (stepper) bindStepper(stepper);

  let modelo = rootEl.querySelector('#demo-select .ox-select__value')?.textContent.trim();
  rootEl.querySelector('#demo-select')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const val = btn.querySelector('.ox-select__value');
    Menu.show(btn, ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4.5', 'minimax-m3', 'qwen3.5-9b'].map((m, i) => ({
      label: m,
      // La aclaración atenuada: como «del sistema» en una impresora.
      hint: i === 0 ? 'por defecto' : '',
      selected: modelo === m,
      /* Un valor por otro: relevo en el mismo lugar, no un textContent que
         cambia de un cuadro al otro. Se recuerda en `modelo` porque durante
         el relevo el textContent junta lo que se va con lo que llega. Elegir
         el que ya estaba no hace nada: swap() recuerda recién después de su
         primer uso (el valor de arranque lo escribió el HTML), y la primera
         vez relevaba la misma palabra por sí misma. */
      onSelect: () => {
        if (m === modelo) return;
        modelo = m;
        swap(val, esc(m), { relevo: true });
      },
    })));
  });

  /* Overlays */
  rootEl.querySelector('#demo-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    Menu.show(e.currentTarget, DEMO_MENU);
  });

  rootEl.querySelector('#demo-modal')?.addEventListener('click', () => {
    Modal.show({
      title: 'Nuevo elemento',
      sub: 'Arranca en el primer campo, Enter en un renglón aplica, atrapa el foco, cierra con Escape y devuelve una promesa con el valor del botón que apretaste.',
      body: `
        <div class="ox-col" style="gap:16px">
          <div class="ox-field">
            <label class="ox-field__label">Nombre</label>
            <input class="ox-input" placeholder="Sin título" spellcheck="false">
          </div>
          <div class="ox-field">
            <label class="ox-field__label">Descripción</label>
            <textarea class="ox-textarea" placeholder="Para qué sirve…"></textarea>
          </div>
        </div>`,
      actions: [
        { label: 'Cancelar', value: null },
        { label: 'Crear', value: true, variant: 'primary' },
      ],
    }).then((v) => v && Toast.show({ title: 'Devolvió true', text: 'Esto es la vitrina: no se creó nada.', icon: 'info' }));
  });

  rootEl.querySelector('#demo-confirm')?.addEventListener('click', () => {
    Modal.confirm({
      title: '¿Eliminar “Documento de trabajo”?',
      sub: 'Se borra también su historial. Esto no se puede deshacer.',
      confirmLabel: 'Eliminar',
      danger: true,
    }).then((ok) => ok && Toast.error('Vitrina', 'No se borró nada: acá solo se muestran los primitivos.'));
  });

  rootEl.querySelector('#demo-toast')?.addEventListener('click', () =>
    Toast.show({ title: 'Guardado', text: 'El documento quedó en disco · 4.2 kB.', icon: 'check' }));

  rootEl.querySelector('#demo-toast-err')?.addEventListener('click', () =>
    Toast.error('No se pudo guardar', 'EPERM: el archivo está tomado por otro proceso. Se reintentó 5 veces.'));

  /* swap(): los cuatro estados del bloque de demo. Vaciar no lleva relevo —se
     va—; los otros tres se reemplazan entre sí. */
  const SWAP = {
    pista: '<span class="ox-meta">Escribí algo para empezar.</span>',
    cargando: `${Icons.spinner()}<span class="ox-meta">Buscando…</span>`,
    resultado: `${Icons.svg('check')}<span>Tres coincidencias</span><span class="ox-chip">n-0042</span>`,
    vacio: '',
  };
  const swapBox = rootEl.querySelector('#demo-swap');
  swap(swapBox, SWAP.pista);
  rootEl.querySelector('#demo-swap-btns')?.addEventListener('click', (e) => {
    const k = e.target.closest('[data-swap]')?.dataset.swap;
    if (k) swap(swapBox, SWAP[k], { relevo: k !== 'vacio' });
  });

  /* ocupar(): el botón de demo trabaja 1,6 s y vuelve. El rótulo de cada
     estado sale de acá, no de una foto del innerHTML: la foto se llevaría el
     destello del clic que todavía está (Quire, herr-15). */
  const ocupadoBtn = rootEl.querySelector('#demo-ocupar');
  const ROTULO = {
    libre: `${Icons.svg('download')} Exportar`,
    ocupado: `${Icons.spinner()} Exportando las 12 páginas…`,
  };
  ocupadoBtn?.addEventListener('click', () => {
    if (ocupadoBtn.dataset.ocupado === '1') return;
    ocupar(ocupadoBtn, true, ROTULO.ocupado);
    setTimeout(() => { if (ocupadoBtn.isConnected) ocupar(ocupadoBtn, false, ROTULO.libre); }, 1600);
  });

  /* contador(): nace vacío (vacío es «nada que contar»). */
  let cuenta = 0;
  const cont = rootEl.querySelector('#demo-contador');
  rootEl.querySelector('#demo-contar-mas')?.addEventListener('click', () => contador(cont, ++cuenta));
  rootEl.querySelector('#demo-contar-vaciar')?.addEventListener('click', () => { cuenta = 0; contador(cont, 0); });

  /* Mostrar y esconder: el JS solo cambia `hidden`, el CSS pliega. */
  const plegable = rootEl.querySelector('#demo-plegable');
  rootEl.querySelector('#demo-plegar')?.addEventListener('click', () => { plegable.hidden = !plegable.hidden; });
  const ancho = rootEl.querySelector('#demo-plegable-ancho');
  rootEl.querySelector('#demo-plegar-ancho')?.addEventListener('click', () => { ancho.hidden = !ancho.hidden; });

  /* Íconos: click = copiar la etiqueta lista para pegar. */
  rootEl.querySelector('#icon-grid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-icon-name]');
    if (cell) copy(`<i data-icon="${cell.dataset.iconName}"></i>`, { label: 'Etiqueta copiada' });
  });
}
