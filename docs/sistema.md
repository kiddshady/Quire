# Quire — referencia del sistema

Quire es una app de Onyx. El framework (todo lo `ox-`) se usa **sin cambios**:
`base`, `controls`, `fonts`, `motion`, `overlays`, `shell`, `surfaces` y
`tokens.css`, y `format`, `icons`, `motion`, `overlays`, `router` y `ui.js`
son copias de los de `S:\tools\Onyx` (en el árbol de Quire con CRLF). Un
arreglo de Onyx se trae copiando el archivo; lo propio de Quire vive en
archivos `qr-` y no se escribe adentro de esos.

Este documento tiene dos partes: **lo propio de Quire**, acá arriba, y **la
referencia de Onyx** abajo, la misma de `S:\tools\Onyx\docs\sistema.md`. Dos
avisos para leer la segunda:

- Los números de prueba que cita («lo mide el humo (8-terdecies)») son del
  humo de **Onyx** (`npm run smoke` en Onyx). El de Quire
  (`test/renderer.test.cjs`) tiene sus propios números y mide menos: el
  relevo y el repintado de vistas (9-ter, 9-quater), los overlays, los
  anillos. Lo de cada zona lo miden sus suites (`npm run verificar`).
- **Piezas** (la vitrina) solo está en el rail en modo desarrollo: `npm run
  dev` o `QUIRE_DEV` en el entorno (ux-39). La ruta existe igual. Su
  `design-view.js` es el de Onyx: si una sección que cita la referencia (por
  ejemplo «Ocupado y contadores») no aparece, es que esa copia quedó atrás.

---

## Lo propio de Quire

### Las hojas de estilo, por zona

En el orden de `index.html`, que es el de la cascada:

| Hoja | Qué tiene |
|---|---|
| `fonts` · `tokens` · `base` · `motion` · `shell` · `controls` · `surfaces` · `overlays` | Onyx, tal cual |
| `quire.css` | Lo que comparte toda la app: retoques al shell, los tokens `qr-`, las piezas de las plantillas, las pestañas y `.qr-lector` |
| `lector.css` | El lector: barra, panel lateral, visor, capas de texto, búsqueda, tinta y el puck |
| `imprimir.css` | Imprimir. También `.qr-inspector` y `.qr-pie`, que Convertir reusa tal cual |
| `herramientas.css` | Herramientas (Combinar, Dividir, Exportar) |
| `paginas.css` | Organizar páginas |
| `chrome.css` | Soltar un archivo sobre la ventana y el cartel de actualizaciones |
| `convertir.css` | Convertir |

Cada hoja de zona era un tramo de `quire.css` y se separó en octubre de 2026
sin cambiar el orden. Ese orden importa: `convertir.css` va después de
`imprimir.css` porque se apoya en su inspector y su pie.

### `quire.css`: lo compartido

**Tokens propios**, en `:root` y con prefijo `qr-` (vivían en `tokens.css`
con prefijo `ox-`, y eso impedía traer el de Onyx copiando el archivo, fw-18):

| Token | Para qué |
|---|---|
| `--qr-pie` | El alto de la franja pegada arriba de la statusbar: el pie del rail y la barra de la vista de al lado. Son dos componentes, y sus líneas se leen como una sola: si no miden lo mismo se ve el escalón |
| `--qr-statusbar-icono` · `--qr-statusbar-texto` | La columna donde arrancan los valores de la statusbar, para lo que se apila encima |
| `--qr-select-claro` | La selección sobre el papel (abajo) |
| `--qr-velo-soltar` | El velo que oscurece la app mientras arrastrás un archivo encima |

**Retoques al shell.** Sobrescriben clases `ox-` desde acá, nunca editando
`shell.css`: el pie del rail sin línea y con el alto de `--qr-pie` (y el nav
vuelve a esfumar abajo, salvo al llegar al fondo); `.ox-navitem[hidden]`, para
que el `hidden` de Piezas le gane al `display` del ítem; y **todo
`.ox-viewhead` cierra con su hairline**, así que arriba ninguna vista esfuma.
En Onyx eso lo pide cada vista con `head({ linea: true })`; en Quire es la
regla general.

**Piezas de las plantillas**, lo que se repetía como `style="…"` en las
vistas: `.qr-fila` (un switch o un check y su texto; `--arriba` si el texto
ocupa varias líneas), `.qr-apilado` (rótulo y explicación, pegados),
`.qr-deslizador` (un slider con su eco), `.qr-col-ancha` (el cuerpo de una
tarjeta de opciones), `.qr-col-chica` (rótulo, dato y explicación),
`.qr-angosto` (un segmentado que no se estira), `.qr-remate` (aire al final de
una página que scrollea), `.qr-ajustes` (la columna de Ajustes),
`.qr-cierre-lista` (los documentos con cambios, en la pregunta antes de
cerrar) y `.qr-abrir` (el botón Abrir, al ancho del rail). Más las pestañas
(`.qr-tabs`, `.qr-tab`, `__nombre`, `__cerrar`, `.qr-tabs__mas`) y la caja del
lector, `.qr-lector`.

### La selección sobre una superficie clara: `--qr-select-claro`

`--ox-select` es el acento tendido al 16 %, y el acento de esta paleta es casi
blanco: sobre el papel blanco del PDF deja la hoja en 253 de 255 (se despega
1,02:1, o sea nada). Sobre papel, seleccionar es el mismo gesto invertido:
**oscurece**, y lo que se tiende es el fondo de la app. Mismo alfa, color
invertido. Se escribe con `color-mix(in oklab, var(--ox-bg) 16%, transparent)`
y no repitiendo los números de `--ox-bg`: duplicados, cambiar el fondo
desincronizaría la selección sin aviso.

Lo usa `.qr-texto ::selection` (`lector.css`), con `color: transparent`
además del fondo: sin eso Chromium le pinta al texto seleccionado su color de
selección y las letras del canvas, debajo, quedan huecas. Los `<br>` de la
capa llevan `::selection` transparente, o la selección se ve dentada. Se
llamaba `--ox-select-claro` y vivía en `tokens.css`; no está en Onyx.

### Las vistas van de borde a borde

En Onyx la sangría lateral (24 px) la pone el shell. Las vistas de Quire son
superficies de visualización y resuelven su borde solas, así que se quedan
afuera de esa regla (fw-04, decisión de Fran):

- `.ox-bleed` en la caja de la vista: `.qr-lector`, `.qr-org` (Páginas) y
  `.qr-herr` (Herramientas);
- `.ox-viewbody__main--bleed` en las vistas con inspector: Imprimir (el
  preview hundido llega al inspector) y Convertir (la cola pone sus 24 px).

Ajustes y Piezas no lo llevan: la sangría del shell es la que quieren. Una
vista nueva que va de borde a borde lleva una de las dos; si no, el shell le
suma 24 px de cada lado encima de los suyos.

### El estado y sus avisos

`estado.js` guarda los documentos abiertos fuera de las vistas (el router las
repinta enteras). Hay hasta `MAX_PESTANAS` (4) y una activa. Quien necesita
enterarse se suscribe con `alCambiar(fn)`, que devuelve la función para
soltarse (a `Router.onLeave`).

**Lo que es de cada pestaña** (`CAMPOS`): `doc`, `tinta`, `geometrias`,
`esquema` (los marcadores, `null` hasta que se abre la pestaña Marcadores del
lector: lector-24), `metadatos`, `pagina`, `zoom`, `modoZoom`, `rotacion`,
`plan` (la imposición viva), `organizar` (lo pendiente de Páginas) y `lugar`
(dónde estabas leyendo, más fino que la página). Las vistas los leen y
escriben como `S.doc`, `S.pagina`…: son getters que delegan en la pestaña
activa. Sin pestaña, leer da el vacío de cada campo y escribir no hace nada.

**Lo que es de la app**: `S.impresoras`, `S.impresora`, `S.info`,
`S.settings` y `S.cargando` (cuántos documentos se están abriendo: un
contador, no un sí o no). `S.pestanas` y `S.pestana` son para leer; se abre y
cierra con `abrir()`, `activar()`, `cerrarPestana()` y compañía.

**Los avisos** (`emitir(que)`):

| Aviso | Cuándo |
|---|---|
| `'documento'` | Cambió lo que se mira, `S.doc`, y **solo** entonces: al abrir uno que queda activo, al cambiar de pestaña, y al cerrar si la activa pasa a ser otra. Cerrar una pestaña de fondo no lo emite: Páginas lo tomaba como otro documento y tiraba los cambios, y el lector borraba la búsqueda y volvía a pintar todo. Lo mide `test/pestanas.cjs`; que el lector no repinte con un aviso sin cambio, `test/lector.cjs` (lector-20) |
| `'pestanas'` | La franja cambió: abrir, cerrar, activar, mover |
| `'cargando'` | Empezó o terminó una apertura (`S.cargando`) |
| `'tinta'` | La capa de tinta de la pestaña cambió |
| `'impresoras'` | Se releyeron las impresoras |

Las vistas repintan con `'documento'` (Imprimir, Páginas, Herramientas; el
lector solo si el documento es otro que el que pintó), y el chrome se pone al
día con todos. Antes de cerrar una pestaña corren las guardias de
`alCerrarPestana(fn)`: Páginas pregunta si hay cambios sin guardar.

---

# La referencia de Onyx

## Tokens

Todos en [`renderer/css/tokens.css`](../renderer/css/tokens.css). Ningún
componente escribe un valor crudo.

### Superficies — escalera de elevación

| Token | Para qué |
|---|---|
| `--ox-sunken` | Hundido: campos, consola, lienzo |
| `--ox-bg` | Base de la ventana |
| `--ox-s1` | Rail, statusbar |
| `--ox-s2` | Card, panel, fila elevada |
| `--ox-s3` | Menú, modal, popover |
| `--ox-s4` | Tooltip, lo más alto: lo que flota sobre todo |

La croma crece con la luminancia: un plano claro necesita más temperatura que
uno oscuro para no verse lavado.

**`--ox-surface` es «la superficie sobre la que estoy».** La declara cada plano
que aloja contenido —la base (`--ox-bg`), `.ox-card` (`--ox-s2`),
`.ox-inspector` (`--ox-s1`), `.ox-modal` (`--ox-s3`)— en el mismo renglón
donde pinta su fondo, y pinta con ella, así las dos no se pueden desencontrar. La
lee lo que necesita ser opaco del color de su entorno sin saber dónde cayó: hoy,
el encabezado sticky de `.ox-table`. Si armás un plano nuevo que pueda alojar
contenido, declarala.

### Texto — escalera de énfasis

`--ox-text` (primario, nunca blanco puro) · `--ox-text-2` (secundario) ·
`--ox-text-3` (muted: metadatos, labels) · `--ox-text-4` (faint: deshabilitado,
placeholder).

### Acento

`--ox-accent` y sus derivados: `--ox-wash-1` (hover sutil), `--ox-wash-2` (hover
fuerte / seleccionado), `--ox-wash-3` (activo / presionado), `--ox-ring` (focus),
`--ox-select` (`::selection`). Todos salen de `--ox-accent-rgb`: cambiar el
triplete los re-tinta a todos.

`--ox-accent-ink` es la tinta **sobre** el acento. Con un acento oscuro o muy
saturado hay que subirla.

### Rojo

`--ox-danger`, `--ox-danger-dim`, `--ox-danger-wash`, `--ox-danger-ring`.
Reservados al fallo. Si el rojo aparece decorando, deja de significar.

### Hairlines, elevación, radios

`--ox-line` / `-2` / `-3` para divisores finos — **siempre como
`box-shadow: inset 0 0 0 1px`**, porque un `border` real deja hilacha en las
esquinas redondeadas con `overflow:hidden`. `--ox-hairline` ya viene armado.

Sombras: `--ox-e1` a `--ox-e4`. Radios: `--ox-r-xs` (4) a `--ox-r-xl` (16), más
`--ox-r-pill`.

### Espaciado y tipografía

Escala de 4: `--ox-1` (4px) a `--ox-10` (72px). Tamaños: `--ox-fs-10` a
`--ox-fs-26`. Pesos: `--ox-w-regular` / `-medium` / `-semi`. Tracking:
`--ox-track-tight` para lo grande, `--ox-track-caps` para versalitas.

`--ox-font` es la sans (sale del sistema). `--ox-mono` es la monoespaciada y es
una **perilla**: apunta a un token `--ox-mono-*`, nunca directo a una familia.
Las empaquetadas viven en `renderer/fonts/` y se declaran en `fonts.css`.

```
node tools/retint.mjs --mono sistema     # roboto | sistema
```

Para sumar una: el `.woff2` en `renderer/fonts/`, su `@font-face` en
`fonts.css`, y su token en `tokens.css`. **Declará todos los pesos que uses** —
si falta el 500, el navegador engorda el 400 a mano y en una monoespaciada se
nota. Aparece sola en **Piezas**, que descubre los tokens leyendo las hojas de
estilo.

### Movimiento

| Token | Curva | Para |
|---|---|---|
| `--ox-ease` | expo-out | El default. Sale rápido, frena largo |
| `--ox-ease-soft` | cubic-out | Micro-hovers |
| `--ox-ease-both` | in-out | Lo que va y vuelve |
| `--ox-ease-in` | in | Salidas |

Duraciones: `--ox-t-1` (110ms, hover) · `--ox-t-2` (180ms, el default) ·
`--ox-t-3` (280ms, overlays) · `--ox-t-4` (420ms, vistas).

Transiciones ya compuestas: `--tr-color`, `--tr-move`, `--tr-fade`,
`--tr-surface`. **Nunca `transition: all`** — anima propiedades que no querías
y cuesta caro en repaints.

---

## Utilidades

`.ox-row` · `.ox-col` · `.ox-grow` · `.ox-spacer` · `.ox-truncate` · `.ox-path` ·
`.ox-scroll` (con esfumado) · `.ox-scroll-x` · `.ox-hr` · `.ox-vr`

**Recortar tiene dos formas.** `.ox-truncate` corta por la cola, que es lo que
corresponde a un nombre: el final es lo primero que deja de importar. Una
**ruta** es al revés — el principio lo comparten todas y el final es lo único
que la identifica — así que va con `.ox-path`, que recorta por el MEDIO. El
builder `path()` de `ui.js` arma el markup; el recorte lo decide el CSS, que
sabe cuánto entra:

```js
`<div class="ox-mono" data-tip="${esc(dir)}">${path(dir)}</div>`
// C:\Users\fulano\AppData\… → C:\Users\f…\Onyx\data
```

`.ox-truncate` lleva `display: block` a propósito: sobre un elemento **inline**
—un `<span>` suelto dentro de un div— `overflow` y `text-overflow` no aplican, y
sin eso la clase no hace nada y el texto se corta al aire. Donde el span ya es
ítem de un flex (los menús) funcionaba igual, y por eso el agujero pasó
desapercibido tanto tiempo.

El esfumado de `.ox-scroll` va **solo donde el corte es al aire**. Si de ese lado
hay una línea — la statusbar, el pie de un panel, el hairline del propio bloque —
esa línea ya es el límite: el fade encima la ensucia, y además miente, porque el
contenido no se pierde en la nada sino que muere contra un borde.

```html
<div class="ox-scroll ox-scroll--line-bottom">…</div>
```

Modificadores: `--line-top` · `--line-bottom` (y `--line-left` · `--line-right`
en `.ox-scroll-x`). El shell ya los aplica donde corresponde, y con `:has()`, así
que si sacás la pieza que cerraba ese lado el fade vuelve solo: rail contra su
pie, inspector contra el suyo, vista contra la statusbar y contra un encabezado
con línea, modal contra su pie. **El menú no esfuma
nunca** — su hairline lo cierra por los cuatro lados, y como máscara y borde
viven en el mismo elemento, el fade le comía el propio hairline. El tamaño lo da
`--ox-fade`, y el contenedor lleva padding ≥ ese valor para que en reposo la
banda no coma el primer ni el último ítem.

`.ox-title` · `.ox-subtitle` · `.ox-display` · `.ox-label` · `.ox-meta` ·
`.ox-eyebrow` (versalita espaciada) · `.ox-mono` · `.ox-num` (tabular) ·
`.ox-dim` · `.ox-dim2` · `.ox-danger`

`.ox-copyable` — marca contenido como seleccionable. Ante la duda, ponelo.

`.ox-icon` con `--sm` / `--lg` / `--xl` / `--fill`.

**Un ícono adentro de `.ox-meta` o `.ox-label` va en el renglón.** Los dos son
texto en línea y todo `svg` es `display: block`, así que el ícono se iba solo a
un renglón de arriba (salió de Pharos: «de la red», «Aplicar descuento» tenían
el ícono flotando encima del texto). Con `:has(> .ox-icon)` pasan a
`inline-flex` solo los que llevan ícono. El de humo lo mide (8-decies).

---

## Shell

```html
<div class="ox-app">
  <header class="ox-titlebar">
    <div class="ox-brand ox-no-drag">…</div>
    <div class="ox-titlebar__context" id="titlebar-context"></div>
    <div class="ox-wincontrols">
      <button class="ox-wincontrol">…</button>
      <button class="ox-wincontrol ox-wincontrol--close">…</button>
    </div>
  </header>
  <div class="ox-body">
    <nav class="ox-rail">
      <div class="ox-rail__top">…</div>
      <div class="ox-rail__nav ox-scroll">
        <div class="ox-rail__group">
          <div class="ox-rail__group-label">Sección</div>
          <button class="ox-navitem" data-view="x">… <span class="ox-navitem__count">3</span></button>
        </div>
      </div>
      <div class="ox-rail__foot">…</div>
    </nav>
    <main class="ox-main" id="view"></main>
  </div>
  <footer class="ox-statusbar">
    <div class="ox-statusbar__item"><span class="ox-statusbar__value">…</span></div>
  </footer>
</div>
<div id="ox-layer"></div>
```

La titlebar entera es zona de arrastre; lo que sea clickeable lleva
`.ox-no-drag`. `#ox-layer` es donde se portalean todos los overlays.

Los `.ox-wincontrol` se clickean en todo el alto de la titlebar (maximizada,
la esquina acierta la cruz), pero se ven como una pastilla de 28 px adentro:
hover, press y el anillo de foco no llegan al canto de la ventana, donde se
cortaban. Si la titlebar tiene otras piezas al lado (pestañas, por ejemplo),
`--ox-wincontrol-nudge` corre la pastilla en vertical para alinearla.

### El anillo de foco no se corta

El anillo de `base.css` sale **3.5px por fuera** del elemento. Todo lo que
pueda recibir foco necesita ese aire hasta cualquier cosa que recorte (un
`.ox-scroll`, el borde de la ventana) y hasta el canto de la superficie que lo
contiene. Donde no lo hay, el anillo va **hacia adentro**: así lo llevan el
`.ox-segmented__opt` (2px de carril) y la `.ox-tr` con tabindex (va de borde a
borde, muchas veces de una card). El rail deja `--ox-2` arriba del nav por lo
mismo, y de paso separa el botón principal de la navegación. `npm run smoke`
lo mide en cada vista (9-bis): si sumás una pieza que pega su anillo contra un
borde, falla ahí.

### Dentro de la vista

`head({ title, sub, crumbs, actions, linea })` de `ui.js` arma el
`.ox-viewhead`. Con `linea: true` el encabezado se cierra con su hairline en vez
de cortar al aire, y el shell le apaga solo el esfumado de arriba al scroll de
esa vista: la línea ya es el límite. Con inspector no hace falta pedirla: el
panel es de otro plano y arranca con un borde duro justo debajo del encabezado,
así que si la columna principal se esfumara arriba el encabezado se vería
derretido de un lado y sólido del otro — el shell le pone la línea solo.

Hay dos layouts. El simple, que es el 90% de las vistas:

```html
<div class="ox-scroll ox-grow">…</div>
```

Y el de dos paneles:

```html
<div class="ox-viewbody">
  <div class="ox-viewbody__main">…</div>
  <aside class="ox-inspector">
    <div class="ox-inspector__head">…</div>
    <div class="ox-inspector__body ox-scroll">…</div>
    <div class="ox-inspector__foot">…</div>
  </aside>
</div>
```

**La sangría lateral la pone el shell, en los dos.** No le agregues padding
horizontal a tu contenedor: el contenido arranca en la misma columna que el
título de la vista, y el número sale de un solo lugar. Lo que va de borde a
borde —un lienzo, un mapa— lleva `.ox-bleed`.

`.ox-inspector.is-collapsed` lo cierra con transición. `.ox-viewbody__main` es
`position:relative` para anclar controles flotantes: si viven dentro del
contenedor que scrollea, se van de pantalla con el contenido.

---

## Controles

### Botones

`.ox-btn` + una variante: `--primary` (uno solo por pantalla) · `--secondary` ·
`--ghost` · `--danger` · `--danger-solid` (lo que no tiene vuelta atrás).
Tamaños `--sm` / `--lg`. `.ox-iconbtn` (+`--sm`) para los de solo ícono.

Deshabilitados (`disabled` o `aria-disabled="true"`), los dos se apagan a
`--ox-text-4` y no se iluminan con el mouse. El `.ox-iconbtn` no lo hacía: se
veía igual que uno activo y se iluminaba al pasarle el mouse, porque Chromium
le aplica `:hover` a un botón deshabilitado (en Quire, las flechas de Buscar y
el deshacer de la tinta). El color viaja con `--tr-color`, así que se apaga y
se prende suave.

La diferencia, a propósito: `.ox-btn` deshabilitado lleva `pointer-events:
none`, y `.ox-iconbtn` **no**. Al de ícono se le apagan el hover y el apretón,
pero sigue recibiendo el puntero, porque su nombre es su tooltip: con los
eventos cortados, uno apagado no decía qué era ni su atajo (Deshacer
«Ctrl Z» justo cuando no hay nada que deshacer). Un `[aria-disabled]` sigue
recibiendo también el click: lo ignora la vista. La vitrina muestra uno en
«Botones», y lo mide el humo (6-ter), con el mouse de verdad.

Agregá `.ox-flashable` para el velo de luz al presionar. Se cablea solo con
`initClickFlash()`.

### Campos

```html
<div class="ox-field">
  <label class="ox-field__label">Nombre</label>
  <input class="ox-input" spellcheck="false">
  <span class="ox-field__hint">Ayuda</span>
</div>
```

`.ox-input.is-invalid` + `.ox-field__hint--error` para el error.
`.ox-textarea`, `--mono` en ambos. `.ox-inputwrap` para meter un ícono adentro.

### Los que no son nativos

| Clase | Notas |
|---|---|
| `.ox-select` | Es un `<button>`. Abre un `Menu` propio, no un `<select>` |
| `.ox-stepper` | Envuelve un `<input type=number>` y le pone flechas propias. Cablealo con `bindStepper()` |
| `.ox-switch` | `.is-on` lo prende |
| `.ox-check` | `.is-on`; el tilde se dibuja con `stroke-dashoffset` |
| `.ox-slider` | `<input type=range>` estilado; seteale `--ox-pct` |
| `.ox-segmented` | La cápsula viaja. Cablealo con `bindSwitcher()` |
| `.ox-kbd` | Una tecla |
| `.ox-textarea` | Se estira hacia abajo, con un agarrador dibujado (`::-webkit-resizer`) y no el de Chromium |

`bindSwitcher(el, onChange)` de `motion.js` sirve para `.ox-segmented` y
`.ox-tabs`: maneja el activo, hace viajar el indicador y reajusta al
redimensionar.

La flecha del `.ox-stepper` que llega al tope queda en `.25` de opacidad, y se
apaga **fundiéndose**: su transición lleva la opacidad además de
`--tr-color`. Sin ella caía de un cuadro al otro (Quire, Dividir). La que
**nace** en el tope, en cambio, nace apagada: el primer `sync()` de
`bindStepper` va sin transición (`.is-placing`, como `colocar()` con las
cápsulas). Si no, cuando algo forzaba el estilo entre el `paint()` y el
cableado, la flecha de un campo en 0 se fundía en cada montaje, también debajo
del fundido de un repintado.

**La cápsula del segmentado copia la geometría real de la opción activa**
(`--seg-x` / `--seg-w`, como el subrayado de los tabs), no `ancho / n`. Y el
control lleva `width: max-content` para que las opciones midan lo mismo
también adentro de una celda de tabla: el `1fr` reparte parejo solo con ancho
indefinido, y una celda `.ox-td--tight` le da un ancho definido igual a su
mínimo, sin espacio libre que repartir. Se descubrió en una tabla con un
segmentado de dos opciones de distinto largo: salían de 71 y 50px, y la cápsula
caía 10px corrida de su texto. El contrapeso es `max-width: 100%`: en un
contenedor más angosto que la suma de las opciones (el inspector de Quire, 288px
útiles y `overflow: hidden`) el control a max-content medía 317px y la última
opción quedaba recortada por el panel; acotado, el `1fr` reparte lo que hay, las
columnas quedan desparejas solo cuando no entra otra cosa, y la cápsula —que
mide— las sigue. El de humo mide el centro del texto contra el centro de la
cápsula en un flex, en una tabla y en un contenedor angosto.

**El ícono grande del estado vacío es solo el hijo directo** (`.ox-empty >
.ox-icon`): con el selector descendiente, un botón de acción con ícono adentro
del `empty()` heredaba los 34px y salía un botón con lupa gigante.

### Un botón nuevo declara SU padding

`base.css` pone `button { padding: 0 }`. No lo saques y no confíes en el padding
de fábrica: Chromium le da `1px 6px` a todo `<button>`, y con `box-sizing:
border-box` eso se come el interior de los controles chicos. En un `.ox-check`
de 15px dejaba una caja de contenido de 3px para un ícono de 11 — el ícono
desbordaba, y **un ítem de grid que desborda su área cae de `center` a
`start`**, así que el tilde salía 4px a la derecha y recortado contra el borde.
El `.ox-iconbtn` tenía lo mismo en chico (1,5px), invisible de a uno y presente
en toda la app.

El de humo lo vigila: recorre Piezas y falla si algún botón de solo ícono tiene
el SVG corrido más de medio píxel o desbordando.

---

## Superficies

`.ox-card` con `__head` / `__body` / `__foot`; `--interactive` le agrega hover.
`.ox-section` con `__head` / `__title`. `.ox-sunken` para lo hundido.

`.ox-list` + `.ox-listitem` con `__main` / `__title` / `__sub` / `__aside`.
Las acciones van en `.ox-rowactions` (aparecen con el hover o con el foco de teclado; el clic no las deja pegadas).
El anillo de foco de una `.ox-listitem` va hacia adentro: una lista suele ir de
borde a borde de un `.ox-scroll`, y el de afuera se cortaba contra ese borde.

`.ox-table` + `.ox-tr`; `.ox-td--num` alinea a la derecha con cifras tabulares,
`.ox-td--tight` achica el padding. El `<th>` es sticky y por eso opaco: pinta
`--ox-surface`, la superficie donde cayó la tabla, y no un plano fijo — con
`--ox-bg` a secas, dentro de una card el encabezado quedaba más oscuro que sus
propias filas. El de humo lo mide sobre la vista y dentro de una card.
Dentro de un `.ox-scroll` se clava con `top: -var(--ox-fade)`: el sticky se
engancha al borde del contenido, y sin eso quedaba debajo del padding del
esfumado con las filas pasando por arriba. Mientras está clavado, el scroller
lleva `.is-stuck-head` y no esfuma arriba: la hairline ya es el límite.

Una `.ox-tr` que se abre con Enter lleva `tabindex="0"`, y su anillo de foco es
un outline hacia adentro, pintado encima de las celdas.

**`.ox-td--num` va también en el `<th>`, no solo en las celdas.** Si el
encabezado no la lleva, el título se queda a la izquierda mientras los números
van a la derecha y la columna se lee corrida — los valores no caen debajo de su
propio título. Y ojo, que la clase esté puesta no alcanzaba: `.ox-table th`
trae `text-align: left` con especificidad (0,1,1) y le ganaba a `.ox-td--num`
(0,1,0), así que el `<th>` marcado seguía alineando mal. Por eso existe la
regla `.ox-table th.ox-td--num`. Se descubrió en una tabla de precios de cuatro
columnas numéricas, con 82px de desfase; el de humo lo mide.

`.ox-kv` para pares clave/valor (`__k` / `__v`). El valor va en **una línea** y
lo que no entra se elipsa; el que tiene que envolver —un SMILES, un hash largo—
lo pide con `.ox-kv__v--wrap`. `.ox-stat` para una cifra grande (`__value` /
`__unit` / `__label`).

`.ox-chip` (+ `--mono` / `--outline` / `--danger`) · `.ox-avatar` (+ `--lg`) ·
`.ox-empty` (`__title` / `__text`) · `.ox-skeleton` · `.ox-iconcell`.

`.ox-meter` + `.ox-meter__fill`, con `--ox-pct`. `--danger` lo pinta rojo,
`--indeterminate` lo hace recorrer la pista.

`.ox-log` para consolas: `__line` (+`--error` / `--muted`), `__time`, `__src`,
`__msg`.

### Estado

```html
<span class="ox-mark ox-mark--square" data-state="running">
  <span class="ox-mark__halo"></span><span class="ox-mark__core"></span>
</span>
```

Usá los helpers de `ui.js`: `mark(state, shape)` y `status(state, {shape, label})`.

**Formas:** `circle` (el default) · `square`. Hubo un rombo y un hexágono y se
sacaron: la punta y la silueta de seis lados no pegan con el redondeo sutil del
resto. Una forma nueva tiene que salir de la misma familia, no de sumar aristas.
**Estados:** `idle` · `queued` · `running` · `waiting` · `done` · `skipped` ·
`failed`.

La forma dice **qué es** la cosa, la luminancia si **está viva**, y el
movimiento (el halo que respira) es exclusivo de `running`. Renombrá las
palabras con `setStateLabels({...})`; las claves conviene dejarlas.

---

## Overlays

Todos se portalean a `#ox-layer` y todos entran **y salen** animados.

```js
Tooltip.init();                         // una vez, al arrancar
Toast.show({ title, text, icon, tone, duration });
Toast.error(title, text);
Menu.show(anchorEl, items, { align: 'end' });
await Modal.show({ title, sub, body, actions, width, dismissible });
await Modal.confirm({ title, sub, confirmLabel, danger });
```

**Tooltips**: declarativos. `data-tip="texto"`, opcionalmente `data-tip-side`
(`top`|`bottom`|`left`|`right`) y `data-tip-key` para el atajo. Nunca `title=`.
Aparecen con el mouse encima **y también con el foco del teclado**: cuando el
foco es `:focus-visible` y llegó **tabulando**. Antes solo con el
`pointerover`, y el que recorría la ventana con Tab no veía ningún atajo (en
Quire había una docena que la interfaz nunca decía). Un clic no lo muestra por
el foco —un campo clickeado también es `:focus-visible`, y el tooltip
estorbaría lo que se va a tipear—; con el mouse ya está el hover.

Cuenta Tab, no cualquier tecla: el foco que pone un script después de una
tecla no es navegar. Con «cualquier tecla», cerrar un modal con Enter o
Escape (el foco vuelve al botón que lo abrió, y queda `:focus-visible`)
dejaba flotando el tooltip de ese botón, y un atajo que enfoca un campo
(Ctrl+F) le ponía el suyo encima de lo que se iba a tipear. Cualquier otra
tecla corta también el que estaba por salir. Una app que mueve el foco con
otras teclas (las flechas de una barra) las suma en `Tooltip.init`. Lo mide
el humo (9-octies), con el clic, el tipeo y el Enter de verdad.

**Menu items**: `{ label, icon, key, hint, danger, selected, disabled, onSelect }`,
más `{ sep: true }` y `{ groupLabel }`. `hint` es una aclaración atenuada a la
derecha del nombre, que es el que cede si no entra: las medidas de un papel,
«del sistema» en la impresora predeterminada. Antes se descartaba en silencio.
La vitrina lo muestra en el select de **Piezas** («por defecto»).

**Modal**: devuelve una promesa con el `value` del botón que se apretó (`null`
si se cerró). El `body` puede ser HTML o un `Node` — si es un nodo, podés leer
sus campos después de que cierre. Atrapa el foco y cierra con Escape. Y se usa
con el teclado como cualquier diálogo de escritorio:

- **El foco arranca donde se va a trabajar.** En la acción con `autofocus`; sin
  ninguna, en el primer campo del cuerpo (si ya trae un valor, como al
  renombrar, queda seleccionado y se escribe encima); sin campos, en la acción
  `primary`; si no, en la primera del pie. **Nunca en la cruz** del
  encabezado: antes iba al primer botón o campo del modal, que en orden es la
  cruz, y lo que se tipeaba no entraba a ningún lado. Por eso un modal con un
  campo no le pone `autofocus` a su botón.
- **Enter en un campo de un renglón aplica**: resuelve con la acción `primary`
  si hay **una sola** y no está deshabilitada (una vista que valida la apaga
  mientras el dato no sirve, y así frena el Enter). Nunca con `danger-solid`.
  Un campo que maneja su propio Enter y llama a `preventDefault()` gana. El
  Enter se frena: si no, le llegaba como click al botón que abrió el modal
  —que recupera el foco al cerrarse— y lo volvía a abrir.
- `confirm({ danger: true })` arranca con el foco en **Cancelar**: con él en
  el botón rojo, un Enter por reflejo borraba lo que no se recupera.
- `Modal.isOpen`, como `Menu.isOpen`: para que los atajos de una vista no
  actúen detrás del velo (mientras sale ya cuenta como cerrado).
- **Un modal abierto encima de otro lo pisa**: el de abajo se contesta con
  `null` y sale con su `exit()`. Antes quedaba huérfano —la promesa colgada,
  y su velo y su caja en el DOM aunque se cerrara el nuevo—. Las dos cajas
  hacen un relevo: la de abajo sale en in-out y la nueva espera su turno
  (`is-after`) en vez de cruzarse con ella en el centro. La caja que sale
  queda inerte: antes se la podía clickear durante su salida y el botón le
  contestaba al modal **nuevo** (un «Borrar todo» de abajo confirmaba el
  «¿Cerrar sin guardar?» de arriba). El velo heredado respeta el
  `dismissible` del nuevo, y al cerrar el nuevo el foco vuelve a quien abrió
  el primero.
- **Un solo velo, siempre.** Con uno saliendo y otro entrando se apilaban dos
  capas y la pantalla se oscurecía en el medio del cambio (medido: de .62 a
  .79). Al pisar, el nuevo hereda el velo, quieto. Y en el caso más común
  —`Modal.close()` y enseguida otro `Modal.show()`: un confirm y después otro
  diálogo— el velo que se estaba yendo se revive y vuelve a su opacidad
  desde donde iba, en vez de entrar otro debajo. `Modal.close(valor)` no
  tiene opciones: dejar el velo puesto es cosa interna del `show()`.

Lo mide el humo en 5-ter, con las teclas de verdad. El `hint` del menú, en
5-quater. El modal que pisa a otro, en 5-quinquies.

---

## Movimiento (JS)

```js
exit(el, { fallback: 300 })    // saca del DOM DESPUÉS de la animación de salida
swap(el, html, { relevo, fundido }) // reescribe un bloque sin cortes (ver abajo)
calcar(host)                   // la vista que se va: calco opaco que se esfuma (lo usa el router)
recienCalcado(host)            // ¿lo de adentro todavía no se vio? (sin cuadro desde el calco, o < 60 ms; lo miran repintar y el router)
repintar(root, poner)          // repinta la misma vista con fundido y sin perder el lugar (lo usa paint)
asentarPlegables(root)         // los .ox-plegable visibles, en su lugar sin desplegarse (lo usa repintar)
raf2(fn)                       // dos frames: los estilos iniciales ya se aplicaron
stagger(container)             // escalona los hijos con --i
initClickFlash(root)
initScrollFades(root)          // cablea todo .ox-scroll
scrollFade(el)                 // uno solo
bindSwitcher(el, onChange)
bindStepper(el, onChange)      // las flechas de un .ox-stepper; repiten al aguantar
toggleReveal(el, open)         // alto con grid 0fr → 1fr, sin animar height
countTo(el, n, { format })     // un número que corre en vez de saltar
tick(el)                       // destella un valor que acaba de cambiar
```

`exit()` es el más importante y el que más se olvida: sin él, todo lo que se va
del DOM parpadea. Lo que se está yendo se puede **revivir**: sacarle
`data-state` antes de que termine lo deja en el DOM (y `onDone` no corre).
Así vuelven el velo de un modal que se cierra y otro que abre enseguida, y el
número de un contador que reaparece a mitad de su salida.

**`swap()` en vez de `innerHTML`** para todo bloque que cambia con la app
andando. Un `innerHTML` a secas se lleva lo viejo en el mismo cuadro en que
llega lo nuevo; `swap()` distingue cuatro casos:

- **aparece** (vacío → algo): lo nuevo se funde;
- **se va** (algo → vacío): cada hijo termina de irse antes de salir del DOM;
- **cambian los valores** (algo → algo, sin `relevo`): se escribe en el lugar y
  sin volver a animar — para lecturas que se recalculan seguido;
- **un estado reemplaza a otro** (`{ relevo: true }`: pista → cargando →
  resultado): lo viejo se esfuma en un calco encima, en el mismo lugar, y lo
  nuevo asoma cuando lo viejo va por un tercio;
- **un bloque grande cambia de forma** (`{ fundido: true }`: una tabla que gana
  o pierde columnas): la espera del relevo lo dejaría entero a media luz, así
  que el calco lleva el fondo opaco de lo que tiene detrás, va por encima del
  `th` sticky de la tabla nueva, y lo nuevo está entero y quieto debajo desde
  el primer cuadro.

En el relevo y en el fundido el calco conserva la caja que tenía lo viejo
(ancho, alto y dónde caía), no la del contenedor ya con lo nuevo: con
`inset: 0`, una frase que se iba dentro de una caja más angosta se partía en
dos renglones. La caja se mide **con decimales** (`getBoundingClientRect`, no
`clientWidth`, que redondea: a una frase de 105,06 px le daba 105 y se partía
igual), y el calco copia el acomodo del contenedor, sea flex o **grilla** (sus
columnas también: sin ellas, una grilla de 7 caía a una columna durante el
fundido). Los textos sueltos se envuelven en un `<span>` para que también
entren —y se vayan— animados. Viene de Pharos 0.4.1 y de Finway.

Con el mismo HTML de la última vez no hace nada, así que se puede llamar en cada
refresco. Si lo de antes todavía estaba entrando, lo nuevo sigue desde el mismo
punto del fundido. Mientras dura un relevo el contenido viejo sigue en el DOM
adentro de `.ox-swap-out--over`, sin ids: buscá lo nuevo con `:scope > …`, no
con un `querySelector` suelto que puede agarrar lo que se está yendo. Lo muestra
la vitrina en «Reescribir un bloque» y lo mide el humo (8-undecies, que
también mide la caja del calco y el fundido de una tabla).

**Lo que cambia con la app andando, en chico.** Para lo que se pone al día sin
repintar la vista hay siete ayudas más (nacieron en Finway, Apex, Prism y Quire):

```js
numero(el, v)                // un número suelto: en su lugar, con destello (tick)
frase(el, html)              // una frase: si cambian solo sus cifras, destello; si no, relevo
valor(el, html)              // lo que cambia MUY seguido (un stepper apretado): siempre en su lugar
deslizarAlto(el, cambio)     // hace cambio() y la caja va de su alto al nuevo
deslizarAncho(el, cambio)    // lo mismo a lo ancho: un ítem de una fila (la statusbar)
ocupar(btn, ocupado, html)   // un botón libre ↔ ocupado: relevo adentro y el ancho viaja
contador(el, n)              // un contador que aparece, cambia en su lugar y se va
reconcile(box, items, opts)  // una lista por clave (abajo)
```

- **El primer llenado no es un cambio.** `numero()` no destella cuando el
  elemento estaba vacío. Por eso un contador del chrome nace **vacío** en el
  HTML, no en «0»: si no, el primer dato cuenta como cambio y queda teñido de
  acento mientras se va el splash (Finway 0.8.5).
- **`frase()` compara la frase con los números tapados.** «3 tomas» → «4 tomas»
  es la misma frase (destello); «1 toma» → «2 tomas», no (relevo). Si algo cambia
  en cada paso de un stepper y cambia palabras («hasta el lunes» → «hasta el
  martes»), va con `valor()`: un relevo en cada paso sería un parpadeo constante.
- **`reconcile(box, items)`** pone una lista al día fila por fila, por clave
  (`items: [{ key, html }]`): las que siguen son el MISMO nodo y viajan a su
  lugar (FLIP), las que se van salen esfumándose fuera del flujo desde donde
  estaban, y las nuevas entran cuando las viejas casi no se ven. Es lo que va
  al filtrar, buscar o borrar: con `swap(…, { fundido })` las filas que cambian
  de lugar se cruzan con las de al lado. Sirve para el `<tbody>` de una tabla:
  la fila que se va lleva congelado el ancho de sus celdas (una fila absoluta
  pierde el de las columnas y se encogería). Opciones: `update`, `created`
  (montar íconos), `height`, `enter`.
- **`deslizarAncho(el, cambio)`** es `deslizarAlto` a lo ancho, para un ítem
  de una fila que cambia de texto: sin él cambiaba de ancho en un cuadro y
  todo lo que tenía a la derecha saltaba (en Quire, el nombre del documento
  corría a la página y a la medida de la statusbar al cambiar de pestaña).
  Mientras viaja, lo de adentro va en un renglón y lo que sobra se recorta.
  Con un relevo adentro va solo: `deslizarAncho(item, () => swap(valor, html,
  { relevo: true }))` —el calco conserva la caja vieja y no cuenta para el
  ancho nuevo—.
- **Con un relevo adentro, primero se va lo de adentro.** `deslizarAncho` y
  `deslizarAlto` miran si después del `cambio()` hay un calco de `swap()`
  yéndose. Si la caja se **achica**, espera 100 ms y se pliega in-out (con
  `fill: backwards`): plegándose en el acto le cortaba a la frase que se iba
  un pedazo cuando todavía estaba casi entera (con el calco al 50 %, 71 px).
  Si **crece**, no espera y se abre en expo-out: lo nuevo entra con el
  retardo del relevo y encuentra la caja casi abierta. Sin relevo adentro,
  in-out parejo como siempre; con un `fundido` adentro también (esa espera
  se midió con la salida del relevo, 160 ms, y la del fundido dura 180 y
  lleva fondo opaco). Es el `glideSize` de Prism; en Quire había dos copias
  locales (Imprimir y Páginas) y el pedido de la statusbar (2F).
- **`ocupar(btn, ocupado, html)`**: el botón que hace un trabajo pasa a
  «ocupado» («Exportar» → spinner y «Exportando…») con un relevo en el
  lugar, y su ancho viaja con `deslizarAncho`. El estado vive en
  `data-ocupado`, no en la memoria de `swap()`, que es del nodo: si la vista
  se repinta en medio del trabajo, el botón nuevo nace ocupado y el primer
  `ocupar()` relevaba su propio rótulo. Por eso el HTML que lo arma lleva
  `data-ocupado="1"` cuando nace ocupado (sin la marca cuenta como libre).
  Pone `aria-busy`; el `disabled` es de quien lo llama.
- **`contador(el, n)`**: un contador que solo se ve cuando hay algo (el de un
  ítem del rail). 0, vacío o `null` es «nada». Aparece y se va con `swap()`
  (fundido) y cambia en su lugar con destello. Junta lo que `swap()` y
  `numero()` no pueden hacer sobre el mismo nodo: cada uno tiene su memoria,
  y `numero()` compara contra el `textContent`, que durante una salida
  todavía dice el número que se va (si ese número volvía, no se escribía y
  el contador quedaba vacío). `numero(el, '')` además corta de golpe. Si un
  número vuelve mientras el contador se iba (12 → 0 → 12), el que se iba se
  revive desde su opacidad: con `swap()` la salida se cortaba y lo nuevo
  entraba desde 0 (0,93 → 0 en un cuadro). Nace vacío en el HTML, como
  cualquier contador.

Lo mide el humo (8-terdecies y 8-terdecies-bis). La vitrina muestra
`ocupar()` y `contador()` en «Ocupado y contadores» (7-bis).

La vitrina usa lo mismo que predica: el valor del select de demo cambia con
`swap(…, { relevo: true })`, y los botones de mono de **Las perillas** se arman
una vez y después solo alternan `--primary`/`--secondary` (antes se rehacían
con `innerHTML` en cada click: el elegido cambiaba de un cuadro al otro y el
destello del click se iba con el nodo viejo). Lo mide el humo (7-bis).

### Clases de animación

Entradas: `.ox-in-fade` · `.ox-in-rise` · `.ox-in-glide` · `.ox-in-pop`.
Estado: `.ox-spinning` · `.ox-breathing` · `.ox-shaking` · `.ox-skeleton` ·
`.ox-ticked`. `.ox-view` es la transición de vista (la aplica el router).
`.ox-reveal` con `.is-open` para el alto.

**Para repetir una entrada desde JS, `el.animate(…)` sin `fill`** —como
«Repetir entradas» en Piezas, con la duración y la curva leídas de los
tokens—. Nunca un `style.animation` en línea con `both`: retiene el último
cuadro para siempre (el elemento queda bloque contenedor de lo `fixed` y
frontera de backdrop) y, como inline, le gana a cualquier regla de salida.
La vitrina lo hacía así hasta octubre de 2026. Lo mide el humo (7-bis).

**Lo que se prende con `hidden` se pliega.** `.ox-plegable` (alto) y
`.ox-plegable--ancho` (ancho, en una fila) hacen que `el.hidden = …` no sea un
corte: se pliega hasta 0 mientras se desvanece y recién al final pasa a
`display: none`, con `@starting-style`, `interpolate-size` y `display`
`allow-discrete`. El JS no cambia. `.ox-reveal` sigue siendo para cuando
manejás una clase y tenés un envoltorio. En una fila, declarale a la fila su
`gap` en `--ox-plegable-gap` (la statusbar ya lo trae): si no, los de al lado
saltan cuando el plegado pasa a `display: none`. En una columna es igual: el
`.ox-plegable` se come el gap con el margen de arriba mientras se pliega (un
`.ox-field` ya se lo declara a sus pistas; otra columna, con
`--ox-plegable-gap`). Sin eso el gap desaparecía de golpe al final. Si lo de abajo reacciona al
tamaño (un ResizeObserver que redibuja), que espere a que termine el pliegue.
Lo muestra la vitrina en «Mostrar y esconder» y lo mide el humo (8-duodecies).

**Al repintar, lo plegable no se vuelve a desplegar.** Un `.ox-plegable` que
nace visible se despliega desde 0 con una *transición* (`@starting-style`), y
`repintar()` daba por terminadas las animaciones pero no las transiciones: la
barra que ya estaba crecía de 0 a su alto debajo del fundido y empujaba lo de
abajo (Quire, la barra de tinta al cambiar de documento). Ahora `repintar()`
llama a `asentarPlegables(root)`: les apaga la transición con `.is-placing`,
fuerza el estilo y se la devuelve, y termina la que ya hubiera arrancado
(algo forzó el estilo antes, como una cápsula que vuelve a su lugar). Uno que
se prende **después** con `hidden = false` se despliega como siempre. Al
navegar no corre sola: una vista que no quiere que los suyos crezcan debajo
del calco la llama después de pintar. Lo mide el humo (9-quinquies).

**El cambio de vista es un fundido.** Al navegar, el router pasa el contenido
de la vista vieja a un calco (`.ox-main--saliente`: misma clase, sin ids, inerte
y con su scroll) en la misma celda de `.ox-body`, encima, y lo esfuma
(`--ox-t-2`, in-out). La nueva no anima nada: ya está entera y quieta debajo, y
como el calco es opaco (el fondo de `.ox-main`) la pantalla está tapada en todo
momento. `.ox-view` (el glide) queda para el arranque, cuando no hay nada que
relevar. El de humo mide cuánto está tapada la pantalla cada 40 ms (9-ter).

**Cada vista es su propio contexto de apilamiento** (`isolation: isolate` en
`.ox-body > .ox-main`, en motion.css). Sin eso, un hijo de la vista nueva con
`z-index` 2 o más —un panel absoluto, el `th` sticky de una tabla que no llega
a scrollear— competía en la raíz con el calco (`z-index: 1`) y le ganaba: se
veía entero desde el primer cuadro mientras el resto se fundía (en Quire, la
columna de miniaturas del lector). Con `isolation` los `z-index` de adentro
quedan adentro. Un `z-index` de una vista ya no la saca por encima del rail
ni de la titlebar: lo que tenga que flotar sobre todo va a `#ox-layer`, como
los overlays. No es bloque contenedor (un `fixed` de adentro sigue contra la
ventana) ni frontera de backdrop: medido con fotos, un vidrio de adentro de la
vista sigue esmerilando lo que tiene detrás, y el scrim de un modal sigue
esmerilando la vista. El humo congela el fundido a los 60 ms y mide el píxel
(9-sexies): con el calco al 85 %, el píxel es 85 % calco.

**Repintar y navegar en la misma tarea deja un solo calco.** Un `refresh()`
seguido de un `go()` (en Quire, abrir o cerrar un documento desde otra vista:
el aviso repinta la actual y enseguida se navega) armaba dos calcos que se
fundían juntos, y el del medio —un estado que nadie llegó a ver— asomaba
hasta un 25 % a mitad de camino. Ahora, si lo que hay en el host todavía no
se vio (`recienCalcado()`: no hubo un cuadro desde el calco, o pasaron menos
de 60 ms), `go()` no lo vuelve a calcar: descarta lo intermedio y pinta lo
nuevo directo debajo del calco que ya está, el mismo criterio de
`repintar()`. En la misma tarea se decide por cuadros y no por reloj: un
`refresh()` que tarda (un `innerHTML` grande, armar miniaturas) se pasaba de
los 60 ms antes del `go()` y volvía a calcar. Y lo que el repintado dejó
pendiente para el final de la tarea (devolver el scroll y el foco, dar por
terminadas las entradas, escribir los contadores en vez de contarlos) no se
aplica a la vista nueva: le ponía el scroll de la vieja. Lo mide el humo
(9-septies), también con 80 ms de trabajo después del `paint()`, con una
vista scrolleada y con un `countTo()` en la vista nueva.

Con dos navegaciones en tareas distintas dentro de esos 60 ms no es gratis:
la vista del medio ya se pintó debajo del calco, y al descartarla se corta de
un cuadro al otro, a lo sumo con un ~15 % de opacidad (el calco va por ~85 %
a los 60 ms). Se acepta porque la otra salida es peor: calcarla también deja
dos calcos fundiéndose juntos, y el del medio asoma hasta un 25 % y durante
más tiempo.

**Repintar la misma vista también es un fundido, y no pierde el lugar.**
`Router.refresh()` (después de guardar, duplicar, borrar) o una vista que se
vuelve a pintar con el dato nuevo pasan por `paint()`, y `paint()` repinta con
`repintar()` (motion.js): el mismo calco que al navegar, y lo nuevo **asentado**
debajo. Antes era un `innerHTML` en seco y se veían cuatro cosas en todas las
apps (la auditoría de Finway y Apex de octubre de 2026):

- lo viejo se iba en el mismo cuadro en que llegaba lo nuevo;
- todo lo que tiene entrada propia volvía a entrar —las filas escalonadas, el
  vacío que sube, la línea de un gráfico que se dibuja— y ahora se da por
  terminado (lo infinito, como un spinner, sigue; las transiciones también);
- `countTo()` volvía a contar desde 0, y ahora escribe el valor (si cambió, el
  fundido lo muestra);
- el lugar se perdía. Ahora se saca una foto antes de pintar (el `remontar()`
  de Apex): los revelados abiertos y las cápsulas se devuelven apenas se
  pinta, para que la vista los vea al cablearse, y el scroll y el foco cuando
  terminó de cablearse. Todo se reconoce por **id**: un `.ox-reveal` o un
  segmentado sin id no se recuerda; el scroll va por orden de los `.ox-scroll`.

Lo nuevo se asienta dos veces: al pintar, y al terminar la tarea con lo que la
vista haya arrancado al cablearse. Lo que una vista arranque después de un
`await` ya no cuenta como repintado y entra normal. Si la vista se calcó hace
menos de 60 ms (navegó y pintó «cargando» y enseguida el dato), lo nuevo va
directo debajo de ese calco, sin otro en el medio. Lo mide el humo (9-quater).

De paso: la cápsula de un segmentado y el subrayado de los tabs **nacen en su
lugar** (`colocar()`, de Apex). Antes la primera medida llegaba en `raf2` y la
cápsula nacía en ancho 0 contra la izquierda y crecía, en cada vista montada.

Hubo dos versiones antes. En la primera la vieja se iba de un cuadro al otro y
la nueva arrancaba desde transparente: un cuadro vacío. En la segunda la nueva
esperaba 90 ms invisible y entraba con el glide —la receta de `swap()`, que es
para bloques chicos sobre el mismo fondo—. Con vistas enteras la pantalla bajaba
a un tercio de tapada y volvía: en Quire, con las hojas blancas de un PDF, el
brillo medido iba 207 → 36 → 50, más oscuro que las dos vistas, y el título y
las barras que las dos tienen en el mismo lugar se veían temblar al correrse.

Consecuencia para las apps: durante el fundido hay un segundo `.ox-main` en el
DOM, así que buscá por id o dentro de `#view`, no con un
`document.querySelector('.ox-main …')` suelto.

Dos cosas más del calco, que salieron de Chem Engine:

- **Mover un nodo le reinicia las animaciones CSS.** El router da por terminadas
  las entradas de lo que pasa al calco (las infinitas, como un spinner, siguen);
  sin eso, un bloque con fundido propio caía a 0 y volvía a entrar mientras la
  vista se esfumaba.
- **La limpieza de la vista (`onLeave`) corre ANTES del relevo.** Lo que se
  suelte ahí se ve suelto durante esos 160 ms. Un canvas WebGL al que se le
  fuerza la pérdida del contexto se pinta **blanco**: soltalo con un
  `setTimeout` más largo que la salida, no en el acto.

---

## Router

```js
Router.define({
  inicio: { view: viewInicio },
  item:   { view: viewItem, nav: 'inicio' },   // qué ítem del rail se ilumina
}, document.getElementById('view'));

Router.go('item', 'n-0003');
Router.refresh();                 // remonta la actual: fundido, sin perder el lugar
Router.onLeave(store.onEvent(f)); // limpieza de la vista que se está montando
Router.onChange((a, desde) => {});
Router.current / .name / .param
```

`onLeave` es el que evita la fuga: las vistas que se suscriben a algo tienen que
soltarlo al navegar, o cada navegación deja basura escuchando y la app se
degrada sola.

`go()` antes del primer cuadro de un calco o dentro de sus 60 ms (un
`refresh()` en la misma tarea, otra navegación recién hecha) no calca de
nuevo: lo intermedio no se llegó a ver y lo nuevo va directo debajo del calco
que ya está (ver «Repintar y navegar en la misma tarea», arriba).

---

## Helpers de vista

```js
paint(html)                        // pinta + monta íconos + cablea fades; repintar la misma vista es un fundido
head({ title, sub, crumbs, actions, linea })
empty({ icon, title, text, actions })
esc(str)                           // TODO dato de afuera pasa por acá
mark(state, shape) / status(state, opts)
await attempt(fn, { errorTitle })  // el error se ve, no se traga
await copy(texto)

colorToken('--ox-bg')              // un token de color, resuelto a #rrggbb
aHex('oklch(.149 .0046 258)')      // cualquier color CSS, a #rrggbb
```

**Para pasarle un color a Electron, usá `colorToken()` y nunca un regex.** Desde
Chromium 144 el valor computado de una var en oklch se devuelve tal cual
(`"oklch(0.149 0.0046 258)"`), y sacarle los números con `.match(/\d+/g)` toma
el `0.149` del lightness como si fuera el canal verde: arma `#009500` y la app
arranca con medio segundo de pantalla **verde**. Es un hex válido, así que
ninguna validación de forma lo agarra. `colorToken()` pinta el color en un
canvas de 1×1 y lee el píxel, que funciona con cualquier notación presente y
futura. El caso completo está en
`C:\tools\electron-dev-docs\METODO-Flash-Verde-Arranque-Electron-Win11.md`.

Y de `format.js`: `fmtDur` · `fmtNum` · `fmtBytes` · `fmtMoney` · `fmtClock` ·
`fmtDate` · `relTime` · `monogram` · `plural` · `ellipsize`.

Todos escriben el decimal según `locale.tag` (por defecto `es-AR`, o sea coma).
**No uses `toFixed()` para nada que vaya a pantalla**: escribe siempre con punto
y deja la app diciendo "2.1 MB" al lado de "209,9 mm". Si necesitás un número
con decimales que no encaja en ninguna de estas funciones, sumale una a
`format.js` en vez de formatearlo a mano en la vista.

---

## Íconos

```js
Icons.svg('play')                       // string SVG
Icons.svg('play', 'ox-icon--sm')
Icons.spinner()
Icons.mount(root)                       // reemplaza <i data-icon="…">
Icons.add({ miIcono: '<path d="…"/>' }) // los de tu dominio
```

El set base tiene 72, todos sobre grilla de 16, trazo 1.5, puntas redondeadas —
por eso se ven de la misma familia. Miralos todos en **Piezas**; click en
cualquiera copia su etiqueta.

Dibujá los tuyos con la misma receta: `viewBox="0 0 16 16"`, contenido entre 1.8
y 14.2, sin `fill` salvo para puntos macizos (ahí va
`fill="currentColor" stroke="none"`).

**No edites `icons.js` para agregar los tuyos.** Usá `Icons.add()` — así podés
traerte una versión nueva del set base sin pisar tu trabajo.
