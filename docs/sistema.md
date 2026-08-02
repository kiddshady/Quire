# Onyx — referencia del sistema

La versión que se toca está adentro de la app, en **Piezas**. Esto es para
buscar mientras escribís.

Todo lleva el prefijo `ox-`. Los modificadores van con `--`, los elementos con
`__`, y los estados son clases `is-*` o atributos `data-state`.

---

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
| `--ox-s3` | Menú, modal, popover, tooltip |
| `--ox-s4` | Paleta de comandos, lo más alto |

La croma crece con la luminancia: un plano claro necesita más temperatura que
uno oscuro para no verse lavado.

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

`.ox-row` · `.ox-col` · `.ox-grow` · `.ox-spacer` · `.ox-truncate` ·
`.ox-scroll` (con esfumado) · `.ox-scroll-x` · `.ox-hr` · `.ox-vr`

`.ox-title` · `.ox-subtitle` · `.ox-display` · `.ox-label` · `.ox-meta` ·
`.ox-eyebrow` (versalita espaciada) · `.ox-mono` · `.ox-num` (tabular) ·
`.ox-dim` · `.ox-dim2` · `.ox-danger`

`.ox-copyable` — marca contenido como seleccionable. Ante la duda, ponelo.

`.ox-icon` con `--sm` / `--lg` / `--xl` / `--fill`.

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

### Dentro de la vista

`head({ title, sub, crumbs, actions })` de `ui.js` arma el `.ox-viewhead`.
Para dos paneles:

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

`.ox-inspector.is-collapsed` lo cierra con transición. `.ox-viewbody__main` es
`position:relative` para anclar controles flotantes: si viven dentro del
contenedor que scrollea, se van de pantalla con el contenido.

---

## Controles

### Botones

`.ox-btn` + una variante: `--primary` (uno solo por pantalla) · `--secondary` ·
`--ghost` · `--danger` · `--danger-solid` (lo que no tiene vuelta atrás).
Tamaños `--sm` / `--lg`. `.ox-iconbtn` (+`--sm`) para los de solo ícono.

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
| `.ox-switch` | `.is-on` lo prende |
| `.ox-check` | `.is-on`; el tilde se dibuja con `stroke-dashoffset` |
| `.ox-slider` | `<input type=range>` estilado; seteale `--ox-pct` |
| `.ox-segmented` | La cápsula viaja. Cablealo con `bindSwitcher()` |
| `.ox-kbd` | Una tecla |

`bindSwitcher(el, onChange)` de `motion.js` sirve para `.ox-segmented` y
`.ox-tabs`: maneja el activo, hace viajar el indicador y reajusta al
redimensionar.

---

## Superficies

`.ox-card` con `__head` / `__body` / `__foot`; `--interactive` le agrega hover.
`.ox-section` con `__head` / `__title`. `.ox-sunken` para lo hundido.

`.ox-list` + `.ox-listitem` con `__main` / `__title` / `__sub` / `__aside`.
Las acciones van en `.ox-rowactions` (aparecen con el hover).

`.ox-table` + `.ox-tr`; `.ox-td--num` alinea a la derecha con cifras tabulares,
`.ox-td--tight` achica el padding.

`.ox-kv` para pares clave/valor (`__k` / `__v`). `.ox-stat` para una cifra
grande (`__value` / `__unit` / `__label`).

`.ox-chip` (+ `--mono` / `--outline` / `--danger`) · `.ox-avatar` (+ `--lg`) ·
`.ox-empty` (`__title` / `__text`) · `.ox-skeleton` · `.ox-iconcell`.

`.ox-meter` + `.ox-meter__fill`, con `--ox-pct`. `--danger` lo pinta rojo,
`--indeterminate` lo hace recorrer la pista.

`.ox-log` para consolas: `__line` (+`--error` / `--muted`), `__time`, `__src`,
`__msg`.

### Estado

```html
<span class="ox-mark ox-mark--diamond" data-state="running">
  <span class="ox-mark__halo"></span><span class="ox-mark__core"></span>
</span>
```

Usá los helpers de `ui.js`: `mark(state, shape)` y `status(state, {shape, label})`.

**Formas:** `circle` · `square` · `diamond` · `hex`.
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
Palette.init(); Palette.register([...]); Palette.toggle();
```

**Tooltips**: declarativos. `data-tip="texto"`, opcionalmente `data-tip-side`
(`top`|`bottom`|`left`|`right`) y `data-tip-key` para el atajo. Nunca `title=`.

**Menu items**: `{ label, icon, key, danger, selected, disabled, onSelect }`,
más `{ sep: true }` y `{ groupLabel }`.

**Modal**: devuelve una promesa con el `value` del botón que se apretó (`null`
si se cerró). El `body` puede ser HTML o un `Node` — si es un nodo, podés leer
sus campos después de que cierre. Atrapa el foco y cierra con Escape.

**Palette**: comandos `{ id, label, group, icon, hint, run }`. Match por
subsecuencia: "rndg" encuentra "Research Digest". Re-registrá cuando cambien
los datos (`Palette.clear()` primero).

---

## Movimiento (JS)

```js
exit(el, { fallback: 300 })    // saca del DOM DESPUÉS de la animación de salida
raf2(fn)                       // dos frames: los estilos iniciales ya se aplicaron
stagger(container)             // escalona los hijos con --i
initClickFlash(root)
initScrollFades(root)          // cablea todo .ox-scroll
scrollFade(el)                 // uno solo
bindSwitcher(el, onChange)
toggleReveal(el, open)         // alto con grid 0fr → 1fr, sin animar height
countTo(el, n, { format })     // un número que corre en vez de saltar
tick(el)                       // destella un valor que acaba de cambiar
```

`exit()` es el más importante y el que más se olvida: sin él, todo lo que se va
del DOM parpadea.

### Clases de animación

Entradas: `.ox-in-fade` · `.ox-in-rise` · `.ox-in-glide` · `.ox-in-pop`.
Estado: `.ox-spinning` · `.ox-breathing` · `.ox-shaking` · `.ox-skeleton` ·
`.ox-ticked`. `.ox-view` es la transición de vista (la aplica el router).
`.ox-reveal` con `.is-open` para el alto.

---

## Router

```js
Router.define({
  inicio: { view: viewInicio },
  item:   { view: viewItem, nav: 'inicio' },   // qué ítem del rail se ilumina
}, document.getElementById('view'));

Router.go('item', 'n-0003');
Router.refresh();                 // remonta la actual
Router.onLeave(store.onEvent(f)); // limpieza de la vista que se está montando
Router.onChange((a, desde) => {});
Router.current / .name / .param
```

`onLeave` es el que evita la fuga: las vistas que se suscriben a algo tienen que
soltarlo al navegar, o cada navegación deja basura escuchando y la app se
degrada sola.

---

## Helpers de vista

```js
paint(html)                        // innerHTML + monta íconos + cablea fades
head({ title, sub, crumbs, actions })
empty({ icon, title, text, actions })
esc(str)                           // TODO dato de afuera pasa por acá
mark(state, shape) / status(state, opts)
await attempt(fn, { errorTitle })  // el error se ve, no se traga
await copy(texto)
```

Y de `format.js`: `fmtDur` · `fmtNum` · `fmtBytes` · `fmtMoney` · `fmtClock` ·
`fmtDate` · `relTime` · `monogram` · `plural` · `ellipsize`.

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
