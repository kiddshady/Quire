/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — íconos del dominio
   Van por Icons.add() y no dentro de icons.js: así se puede traer una versión
   nueva del set base de Onyx sin pisar estos.

   Misma receta que el set base: viewBox 0 0 16 16, contenido entre 1.8 y 14.2,
   trazo 1.5 con puntas redondeadas, sin fill. Lo punteado (stroke-dasharray)
   siempre significa "acá se corta o se dobla el papel".
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';

Icons.add({
  /* La marca: un pliego de hojas doblado por el lomo. Igual que el splash del
     index.html y que el brand de la titlebar — los tres tienen que coincidir. */
  quire: '<path d="M8 4.3 2.4 6.2v5.9L8 10.3l5.6 1.8V6.2z"/><path d="M8 4.3v6"/>',

  /* Bandeja de entrada arriba, cuerpo, y la hoja que sale abajo. */
  printer: '<path d="M4.6 6.4V2.9h6.8v3.5"/>'
    + '<path d="M4.6 11.4H3.3a1.5 1.5 0 0 1-1.5-1.5V7.9a1.5 1.5 0 0 1 1.5-1.5h9.4a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-1.3"/>'
    + '<path d="M4.6 9.7h6.8v3.4H4.6z"/>',

  /* Múltiple (N-up): una hoja repartida en cuatro. */
  nup: '<path d="M2.6 2.8h10.8v10.4H2.6z"/><path d="M8 2.8v10.4M2.6 8h10.8"/>',

  /* Folleto: el cuadernillo abierto, visto desde arriba. */
  folleto: '<path d="M8 4.7 2.5 3.1v9L8 13.7l5.5-1.6v-9z"/><path d="M8 4.7v9"/>',

  /* Póster: una imagen que se reparte entre varias hojas. Punteado = corte. */
  poster: '<path d="M2.4 2.6h11.2v10.8H2.4z"/>'
    + '<path d="M8 2.6v10.8" stroke-dasharray="1.9 1.7"/>'
    + '<path d="M2.4 8h11.2" stroke-dasharray="1.9 1.7"/>',

  /* Dúplex: la hoja y su reverso, con el giro que hay que darle. */
  duplex: '<path d="M9.7 2.9H4.5a1.2 1.2 0 0 0-1.2 1.2v7.8a1.2 1.2 0 0 0 1.2 1.2h1.2"/>'
    + '<path d="M6.3 13.1h5.2a1.2 1.2 0 0 0 1.2-1.2V4.1a1.2 1.2 0 0 0-1.2-1.2h-1.2"/>'
    + '<path d="M8 5.6 9.6 8 8 10.4"/>',

  /* Escala: dos escuadras opuestas. */
  escala: '<path d="M2.9 9V3.1h5.9"/><path d="M13.1 7v5.9H7.2"/>',

  /* Ajustar al ancho. Para "ajustar a la página" ya está `fit` en el set base. */
  ancho: '<path d="M2.2 8h11.6"/><path d="M4.7 5.5 2.2 8l2.5 2.5"/><path d="M11.3 5.5 13.8 8l-2.5 2.5"/>',

  /* Combinar: dos documentos que desembocan en uno. */
  combinar: '<path d="M2.6 2.9h4.6v4.2H2.6z"/><path d="M8.8 8.9h4.6v4.2H8.8z"/>'
    + '<path d="M7.2 5h2.8a1.1 1.1 0 0 1 1.1 1.1v2.8"/>',

  /* Convertir: un documento que entra y sale distinto — la hoja de la
     izquierda pasa a la de la derecha por una flecha. */
  convertir: '<path d="M2.4 3.4h4.2v9.2H2.4z"/><path d="M9.4 3.4h4.2v9.2H9.4z"/>'
    + '<path d="M6.6 8h2.8"/><path d="M8.3 6.9 9.4 8l-1.1 1.1"/>',

  /* Markdown: la M y la flecha hacia abajo del logo, a trazo. */
  markdown: '<path d="M2.4 11.4V4.6l2.8 3.3 2.8-3.3v6.8"/><path d="M11 4.6v6.8"/><path d="M9.2 9.6 11 11.4l1.8-1.8"/>',

  /* Dividir: dos mitades y la línea por donde se parte. */
  dividir: '<path d="M2.6 3.5h3.7v9H2.6z"/><path d="M9.7 3.5h3.7v9H9.7z"/>'
    + '<path d="M8 2.2v11.6" stroke-dasharray="1.9 1.7"/>',

  /* Rotaciones: el arco abierto dice hacia dónde gira. */
  rotarDer: '<path d="M12.7 6.9A5.3 5.3 0 1 0 13.3 9.4"/><path d="M9.6 6.9h3.5V3.4"/>',
  rotarIzq: '<path d="M3.3 6.9A5.3 5.3 0 1 1 2.7 9.4"/><path d="M6.4 6.9H2.9V3.4"/>',

  /* Área imprimible: la hoja y, punteado, hasta dónde llega el tóner. */
  margen: '<path d="M2.6 2.6h10.8v10.8H2.6z"/>'
    + '<path d="M4.7 4.7h6.6v6.6H4.7z" stroke-dasharray="1.9 1.7"/>',

  /* Tinta: la punta de la pluma sobre el trazo que deja. */
  tinta: '<path d="m10.9 2.7 2.4 2.4-7.3 7.3-3.2.8.8-3.2z"/><path d="m9.2 4.4 2.4 2.4"/>',

  /* Resaltador: punta ancha y chanfleada, y la banda que va dejando.
     Se llamaba `marcador`, igual que el del esquema de más abajo, y en un
     literal la segunda clave pisa a la primera sin aviso: el botón del
     resaltador mostraba la cinta del esquema y este dibujo no se veía en
     ningún lado (tinta-14, shell-32). */
  resaltador: '<path d="m9.7 2.6 3.7 3.7-5.4 5.4H4.3V8.1z"/><path d="M2.2 13.9h11.6"/>',

  /* Borrador: el bloque en diagonal, apoyado sobre la línea que limpia. */
  borrador: '<path d="m7.7 3.5 4.8 4.8-4.2 4.2H4.5L2.6 10.6z"/><path d="M7.4 13.5h6.2"/>',

  /* Marcador del esquema del documento. */
  marcador: '<path d="M4.2 2.7h7.6v10.6L8 10.6l-3.8 2.7z"/>',

  /* Orientación del papel. */
  vertical: '<path d="M4.3 2.4h7.4v11.2H4.3z"/>',
  horizontal: '<path d="M2.4 4.3h11.2v7.4H2.4z"/>',

  /* Presentar: la pantalla de proyección sobre su trípode, con el «play». */
  presentar: '<path d="M2 2.9h12"/><path d="M3 2.9v6.6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2.9"/>'
    + '<path d="M8 10.5v1.6M5.5 14.1 8 12.1l2.5 2"/><path d="M7 5.1v3l2.4-1.5z"/>',

  /* Puntero láser: el punto y lo que irradia. */
  laser: '<circle cx="8" cy="8" r="1.9"/><path d="M8 1.9v2M8 12.1v2M1.9 8h2M12.1 8h2"/>'
    + '<path d="m3.7 3.7 1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1"/>',

  /* Pantalla en negro: el monitor, apagado. */
  pantallaNegra: '<rect x="2.2" y="3" width="11.6" height="8" rx="1.4"/><path d="M5.8 13.6h4.4"/><path d="m2.4 1.9 11.2 11.2"/>',

  /* Intercambiar las pantallas: una flecha que va y otra que vuelve. */
  intercambiar: '<path d="M2.6 5.3h10.2M10.5 3l2.3 2.3-2.3 2.3"/><path d="M13.4 10.7H3.2M5.5 8.4l-2.3 2.3 2.3 2.3"/>',
});
