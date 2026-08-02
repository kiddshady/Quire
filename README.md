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

**Abrir con doble click** — si lo ponés como lector predeterminado, el PDF se
carga solo. Con Quire ya abierta, otro doble click reusa la ventana en vez de
levantar una segunda. El instalador **no** toca las asociaciones de archivo: si
querés que sea tu lector por defecto, se lo decís vos a Windows.

**Actualizarse sola** — busca al arrancar y avisa solo si hay algo. **Nunca baja
nada sin que se lo pidas**: el instalador pesa casi 100 MB y hacerlo de prepo en
la conexión de otro no está bien. La versión portable no se actualiza sola y lo
dice en pantalla en vez de fallar callada.

## El mapa

```
main.cjs               La ventana, el lock de instancia única y el argv de entrada.
src/
  actualizador.cjs     electron-updater contra los releases del repo.
  argv.cjs             El PDF con el que te abrieron. Sin Electron, para testearlo.
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
    actualizar.js      El cartel que muta entre estados + el aviso de la statusbar.
    views/             Una por vista del rail.
```

`plan.js` está separado de `motor.js` a propósito: la imposición es aritmética de
rectángulos y es donde de verdad uno se equivoca (un folleto mal impuesto se
descubre después de imprimir, doblar, y encontrar la página 5 donde iba la 3).
Sin pdf-lib de por medio se puede testear con Node pelado.

## Verificar

```
npm run verificar     # las cinco suites, 205 aserciones
```

| | |
|---|---|
| `npm test` | Node pelado: tokens, escritura atómica, la aritmética de imposición, el parseo de argv y las decisiones del actualizador |
| `npm run imposicion` | Impone de verdad y **vuelve a leer** el PDF para ver qué cayó dónde |
| `npm run tinta` | El vuelco de la Y, el contorno, el borrador y el historial |
| `npm run humo` | Monta la app, abre un PDF, dibuja con un stylus sintético |
| `npm run apertura` | Lanza la app **como proceso**, con un PDF en la línea de comandos |

`apertura` es el único que lanza la app entera desde afuera, y existe por un bug
que ninguna otra suite podía ver: el doble click abría Quire vacía porque nadie
miraba `process.argv`. Todo lo observable —el ícono, la asociación, la ventana—
andaba bien. La señal que mira es `ultimoDocumento` en disco, que solo se escribe
cuando un PDF terminó de abrirse de verdad.

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

### Cómo se recarga el fajo (corregido con papel, 2 ago 2026)

La bandeja carga **boca arriba** y la hoja sale **boca abajo**: el recorrido le
da una vuelta de campana. De ahí salen las dos reglas, y ninguna es la que dicen
los drivers:

- **La pila no se da vuelta nunca.** La cara en blanco ya sale mirando para
  arriba. Pasarla "como la hoja de un cuaderno" imprime los dorsos encima de los
  frentes — es el error que costó el primer fajo.
- **Lado largo → girar media vuelta en el plano**, como un volante, sin
  levantarla de la mesa. **Lado corto → no girar.** La diferencia entre
  encuadernar por un lado o por el otro *es* exactamente ese giro de 180°.

El orden de la segunda pasada es un problema aparte y no depende del movimiento:
la salida apila boca abajo (la última hoja queda arriba) y la entrada toma de
arriba, así que los dorsos van invertidos. Ver `partirDuplex` en
`renderer/js/imposicion/motor.js`.

## La carpeta de datos

`data/`, al lado del proyecto y no en AppData: JSON legibles que se abren con un
editor. `QUIRE_DATA` la mueve. Ahí van los ajustes, los recientes y la tinta de
cada documento (un archivo por PDF, indexado por un hash de su ruta y tamaño).
No se versiona.
