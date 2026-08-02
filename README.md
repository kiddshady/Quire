# Quire

Lector de PDF con foco en la impresión. Un *quire* es el pliego de hojas doblado
que forma un cuadernillo — la unidad de la imposición, que es de lo que se trata
esta app.

```
npm install
npm run dev
```

Construida sobre [Onyx](https://github.com/kiddshady/Onyx). Oscura, acromática,
todo hecho a mano. La referencia del sistema de diseño está en
[docs/sistema.md](docs/sistema.md), y la vitrina viva de los primitivos, dentro
de la app en **Piezas**.

---

## La idea que ordena todo

**Un solo pipeline de imposición: el preview y el papel comen del mismo PDF.**

Cuando elegís "folleto A5 sobre A4, dúplex", Quire genera con `pdf-lib` el PDF
**ya impuesto** —exactamente como va a quedar el papel— y ese mismo archivo es el
que se previsualiza *y* el que se manda a la cola de impresión. El preview no
puede mentir porque es el mismo byte.

Por eso `src/impresion.cjs` no escala, no rota y no reordena nada: cualquier
transformación ahí sería algo que el preview no mostró.

## Qué hace

**Leer** — scroll continuo virtualizado (un PDF de 400 páginas no come más
memoria que uno de 4), zoom, miniaturas, marcadores, rotación.

**Imponer** — simple, múltiple (N-up), póster y folleto, con escala, rangos,
orientación y dúplex. El preview dibuja el **área que el tóner no alcanza**, que
es el dato que ningún visor muestra y la causa de la mitad de los recortes.

**Anotar** — con la tablet, con presión real. Los trazos se guardan aparte: el
PDF original nunca se toca. Al imprimir o exportar se aplanan como paths
vectoriales sobre una copia — sin convertir el documento ni partirlo.

**Organizar** — reordenar, rotar, borrar y extraer páginas.

**Combinar, dividir, exportar** — a PNG, JPEG o WEBP con el DPI que elijas.

## El mapa

```
main.cjs               La ventana. El anti-flash viene de Onyx y está comentado ahí.
src/
  documentos.cjs       Abrir, leer y guardar PDFs. Los bytes van por IPC.
  impresion.cjs        Capacidades reales de la impresora + mandar el papel.
  ipc.cjs · store.cjs  El puente y el disco (de Onyx).
renderer/
  vendor/              pdf.js y pdf-lib, versionados a propósito.
  js/
    pdf/documento.js   Todo lo que sabe de pdf.js vive acá.
    imposicion/
      plan.js          Geometría pura: entra un plan, salen las hojas. Sin pdf-lib.
      motor.js         Escribe el PDF impuesto. No decide geometría.
    tinta/
      stroke.js        Copiado de Scrawl SIN cambios (stylus + suavizado).
      contorno.js      Puntos con presión → el polígono que ocupa la tinta.
      capa.js          El modelo, la persistencia y el dibujo.
      aplanar.js       Escribe los trazos en el PDF como paths vectoriales.
    views/             Una por vista del rail.
```

`plan.js` está separado de `motor.js` a propósito: la imposición es aritmética de
rectángulos y es donde de verdad uno se equivoca (un folleto mal impuesto se
descubre después de imprimir, doblar, y encontrar la página 5 donde iba la 3).
Sin pdf-lib de por medio se puede testear con Node pelado.

## Verificar

```
npm run verificar     # las cuatro suites, 161 aserciones
```

| | |
|---|---|
| `npm test` | Node pelado: tokens, escritura atómica y la aritmética de imposición |
| `npm run imposicion` | Impone de verdad y **vuelve a leer** el PDF para ver qué cayó dónde |
| `npm run tinta` | El vuelco de la Y, el contorno, el borrador y el historial |
| `npm run humo` | Monta la app, abre un PDF, dibuja con un stylus sintético |

El humo mide **dónde cae** cada cosa y si el canvas tiene tinta — no solo si el
elemento existe. Dos trampas aprendidas a los golpes, ya resueltas en el test:

- La ventana va en `x:-20000` + `showInactive()`, **no** `show:false`. Con la
  ventana oculta, Chromium congela las animaciones CSS y todo lo que entra
  animado se mide en `opacity: 0` — el test denuncia bugs que no existen.
- `capturePage()` devuelve el último frame *compuesto*, que puede ser anterior al
  último repintado. Hay que esperar antes de capturar.

## La impresora de referencia

Todo se probó contra una **HP LaserJet Professional P 1102w**, consultada por
`System.Printing`, no sacada del manual:

- Monocromo únicamente. A4 y A5 nativos.
- El driver **no** hace N-up ni folleto: por eso la imposición es nuestra.
- **Área imprimible A4: 203,2 × 289,0 mm, con origen en 3,97 mm.** Hay ~4 mm de
  borde muerto por lado.
- Declara dúplex, pero ese modelo no tiene unidad dúplex física: lo hace en dos
  pasadas. Por eso existe el **dúplex asistido**, que parte el trabajo y muestra
  un diagrama de cómo va el fajo de vuelta a la bandeja.

> Falta la prueba con papel de verdad. El primer trabajo debería ser un folleto
> de 4 páginas: es una sola hoja y valida de una la imposición, el dúplex y el
> área imprimible.

## La carpeta de datos

`data/`, al lado del proyecto y no en AppData: JSON legibles que se abren con un
editor. `QUIRE_DATA` la mueve. Ahí van los ajustes, los recientes y la tinta de
cada documento (un archivo por PDF, indexado por un hash de su ruta y tamaño).
No se versiona.
