'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   QUIRE — impresión
   Dos cosas distintas viven acá:

   1. QUÉ PUEDE la impresora. Electron solo da el nombre; las capacidades
      reales (tamaños, dúplex, y sobre todo el ÁREA IMPRIMIBLE) salen del
      subsistema de impresión de Windows vía System.Printing. Ese último dato
      es el que ningún visor muestra y el que explica por qué a veces se come
      lo que está pegado al borde.

   2. MANDAR EL PAPEL. El PDF que llega acá ya viene impuesto por el renderer:
      es, página por página, lo que tiene que salir. Así que este módulo no
      escala, no rota y no reordena nada — solo lo entrega. Todo lo que toque
      acá sería una transformación que el preview no mostró.

   El trabajo NO lo manda Chromium. Se probó y no sirve: su impresión silenciosa
   spoolea siempre el papel por defecto del locale y no hay forma de moverlo,
   así que cualquier hoja que no fuera A4 salía corrida. Lo manda SumatraPDF
   portable, que acepta `paper=`, con `noscale` para que siga sin tocar nada.
   La medición completa está más abajo, arriba de rutaDelAyudante().
   ═══════════════════════════════════════════════════════════════════════════ */

const { BrowserWindow, app } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/* System.Printing mide en DIPs (1/96"). Todo lo que sale de este módulo va en
   milímetros, que es la unidad en la que se piensa el papel. */
const DIP_A_MM = 25.4 / 96;
const mm = (dip) => Math.round(dip * DIP_A_MM * 100) / 100;

/* ── Capacidades ─────────────────────────────────────────────────────────── */

/* Se consulta el área imprimible tamaño por tamaño: NO es la misma para A4 que
   para A5, y el driver solo reporta la del tamaño que tenga configurado. */
const PS_CAPACIDADES = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Printing | Out-Null
$srv = New-Object System.Printing.LocalPrintServer
$out = @()
foreach ($cola in $srv.GetPrintQueues()) {
  try {
    $caps = $cola.GetPrintCapabilities()
    $tamanos = @()
    foreach ($t in $caps.PageMediaSizeCapability) {
      $nombre = [string]$t.PageMediaSizeName
      if (-not $nombre) { continue }
      $area = $null
      try {
        $ticket = $cola.UserPrintTicket
        $ticket.PageMediaSize = New-Object System.Printing.PageMediaSize($t.PageMediaSizeName)
        $c2 = $cola.GetPrintCapabilities($ticket)
        if ($c2.PageImageableArea) {
          $area = @{
            originX = $c2.PageImageableArea.OriginWidth
            originY = $c2.PageImageableArea.OriginHeight
            ancho   = $c2.PageImageableArea.ExtentWidth
            alto    = $c2.PageImageableArea.ExtentHeight
          }
        }
      } catch {}
      $tamanos += @{
        nombre    = $nombre
        ancho     = $t.Width
        alto      = $t.Height
        imprimible = $area
      }
    }
    $out += @{
      nombre    = $cola.FullName
      duplex    = @($caps.DuplexingCapability | ForEach-Object { [string]$_ })
      color     = @($caps.OutputColorCapability | ForEach-Object { [string]$_ })
      orientacion = @($caps.PageOrientationCapability | ForEach-Object { [string]$_ })
      intercalar = @($caps.CollationCapability | ForEach-Object { [string]$_ })
      resoluciones = @($caps.PageResolutionCapability | ForEach-Object { @{ x = $_.X; y = $_.Y } })
      maxCopias = $cola.GetPrintCapabilities().MaxCopyCount
      tamanos   = $tamanos
    }
  } catch {}
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

let cacheCaps = null;

function correrPS(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(stdout);
      }
    );
  });
}

/**
 * Capacidades reales de cada cola de impresión, en milímetros.
 * Tarda ~1s, así que se cachea: las impresoras no aparecen y desaparecen
 * mientras la app está abierta. `refrescar()` la vuelve a pedir.
 */
async function capacidades({ refrescar = false } = {}) {
  if (cacheCaps && !refrescar) return cacheCaps;

  let crudo = [];
  try {
    const salida = await correrPS(PS_CAPACIDADES);
    const json = JSON.parse(salida.trim() || '[]');
    crudo = Array.isArray(json) ? json : [json];
  } catch (err) {
    // Sin capacidades la app sigue andando: se cae a los tamaños estándar y se
    // pierde el borde no imprimible. Es degradado, no roto.
    console.error('[impresion] no se pudieron leer las capacidades:', err.message);
  }

  cacheCaps = crudo.map((p) => ({
    nombre: p.nombre,
    duplex: p.duplex || [],
    soportaDuplex: (p.duplex || []).some((d) => /TwoSided/i.test(d)),
    soloMonocromo: (p.color || []).length > 0 && !(p.color || []).some((c) => /Color/i.test(c)),
    intercalar: (p.intercalar || []).some((c) => /^Collated$/i.test(c)),
    maxCopias: p.maxCopias || 1,
    resoluciones: (p.resoluciones || []).map((r) => ({ x: r.x, y: r.y })),
    tamanos: (p.tamanos || []).map((t) => ({
      nombre: t.nombre,
      ancho: mm(t.ancho),
      alto: mm(t.alto),
      // Lo que el tóner realmente alcanza, y el margen muerto de cada lado.
      imprimible: t.imprimible ? {
        x: mm(t.imprimible.originX),
        y: mm(t.imprimible.originY),
        ancho: mm(t.imprimible.ancho),
        alto: mm(t.imprimible.alto),
      } : null,
    })),
  }));

  return cacheCaps;
}

/** Nombre + default de Electron, cruzado con las capacidades de Windows. */
async function listar() {
  const win = BrowserWindow.getAllWindows()[0];
  const deElectron = win ? await win.webContents.getPrintersAsync() : [];
  const caps = await capacidades();

  return deElectron.map((p) => {
    const c = caps.find((x) => x.nombre === p.name) || null;
    return {
      nombre: p.name,
      etiqueta: p.displayName || p.name,
      predeterminada: !!p.isDefault,
      estado: p.status,
      ...(c ? {
        duplex: c.duplex,
        soportaDuplex: c.soportaDuplex,
        soloMonocromo: c.soloMonocromo,
        intercalar: c.intercalar,
        maxCopias: c.maxCopias,
        tamanos: c.tamanos,
      } : { tamanos: [], soportaDuplex: false, soloMonocromo: false, maxCopias: 999 }),
    };
  });
}

/* ── Por qué el papel lo manda SumatraPDF y no Chromium ──────────────────────
   Porque Chromium no puede elegir el tamaño de hoja. Medido contra el spooler,
   con la cola en pausa para no gastar papel:

     pedido                          driver     trabajo spooleado
     pageSize: 'A5'          (PDF)   A5     →   A4 210 x 297 mm
     pageSize: 148000×210000 (PDF)   A5     →   A4 210 x 297 mm
     pageSize: 'A5'          (HTML)  A5     →   A4 210 x 297 mm
     pageSize: 148000×210000 (HTML)  A5     →   A4 210 x 297 mm
     sin pageSize            (PDF)   A5     →   A4 210 x 297 mm
     sin pageSize            (HTML)  A5     →   A4 210 x 297 mm
     SumatraPDF, paper=A5            A4     →   A5 148 x 210 mm   ← el único

   `webContents.print({ silent: true })` SIEMPRE spoolea el papel por defecto de
   Chromium para el locale —acá A4— y no hay forma de moverlo desde la app: ni
   por nombre, ni en micrones, ni omitiéndolo, ni dejándole el papel puesto al
   driver desde antes de que arranque el proceso, ni imprimiendo HTML.

   El síntoma no parecía un problema de papel, y esa era la trampa: la hoja
   salía CORRIDA hacia abajo y le faltaba el final. Una A5 compuesta sobre una
   A4 se corre (297 − 210) / 2 = 43,5 mm, porque el driver centra la página en
   su hoja y la impresora imagina el papel real desde el borde de arriba.
   Imprimir en A4 salía bien de casualidad, no por mérito.

   Así que el trabajo lo manda un ayudante: SumatraPDF portable, que sí acepta
   `paper=`. Sigue sin escalar, sin rotar y sin reordenar nada —`noscale` es
   justamente eso—, así que la regla de este módulo no cambia: lo que llega acá
   ya es, página por página, lo que tiene que salir.

   Ver vendor/sumatrapdf/LEEME.md para la versión, el hash, la firma y la
   licencia (es GPLv3 y va como programa separado). */

const AYUDANTE_EXE = 'SumatraPDF-3.6.1-64.exe';

/* Empaquetado va a resources/, FUERA del asar: un .exe adentro del asar no se
   puede ejecutar. En desarrollo sale del repo. */
function rutaDelAyudante() {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'sumatrapdf', AYUDANTE_EXE)
    : path.join(__dirname, '..', 'vendor', 'sumatrapdf', AYUDANTE_EXE);
}

/* Los papeles que SumatraPDF sabe nombrar en `paper=`. Coinciden con los que
   nombra el plan (ver papelParaElDriver). Lista blanca a propósito: esto se
   arma dentro de un argumento de línea de comandos. */
const PAPELES_CON_NOMBRE = new Set(
  ['A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Statement', 'Executive']
);

/**
 * Los `-print-settings` del trabajo.
 *
 * `noscale` es lo primero y lo más importante: el PDF ya viene impuesto y
 * cualquier escalado de acá sería una transformación que el preview no mostró.
 */
function ajustesDeImpresion({ pageSize, copies, duplexMode, monocromo }) {
  const partes = ['noscale'];

  /* Un papel sin nombre conocido no se puede pedir: SumatraPDF solo entiende
     nombres. Se cae al del driver, que es lo que pasaba antes con todo. */
  if (typeof pageSize === 'string' && PAPELES_CON_NOMBRE.has(pageSize)) {
    partes.push(`paper=${pageSize}`);
  }

  const n = Math.max(1, Math.min(999, Math.round(copies) || 1));
  if (n > 1) partes.push(`${n}x`);

  partes.push(duplexMode === 'longEdge' ? 'duplexlong'
    : duplexMode === 'shortEdge' ? 'duplexshort'
      : 'simplex');

  // Solo si la impresora no sabe otra cosa: forzarlo en una a color sería
  // decidir por el usuario algo que no pidió.
  if (monocromo) partes.push('monochrome');

  return partes.join(',');
}

/**
 * La ficha de capacidades de una impresora, o null.
 *
 * Devuelve también si la lista se pudo leer, porque las dos cosas se confunden:
 * "no está en la lista" y "no hay lista" no son lo mismo, y tratarlas igual
 * dejaría a la app sin imprimir cuando lo que falló fue PowerShell.
 */
async function fichaDeImpresora(deviceName) {
  try {
    const caps = await capacidades();
    return { hayLista: caps.length > 0, ficha: caps.find((p) => p.nombre === deviceName) || null };
  } catch {
    return { hayLista: false, ficha: null };
  }
}

/* ── Mandar el papel ─────────────────────────────────────────────────────── */

async function carpetaTemp() {
  const dir = path.join(os.tmpdir(), 'quire-print');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/* Un contador basta: los trabajos de una misma sesión no se pisan, y el nombre
   queda legible si hay que mirarlo a mano cuando algo sale raro. */
let trabajoN = 0;

/**
 * Imprime un PDF ya impuesto.
 *
 * @param {ArrayBuffer|Uint8Array} bytes  El PDF tal cual tiene que salir.
 * @param {object} opciones
 *   deviceName  nombre exacto de la impresora
 *   copies      cuántas
 *   pageSize    'A4' | 'A5' | … El NOMBRE, que es lo único que se puede pedir.
 *               Un objeto en micrones se acepta pero no se puede honrar: cae al
 *               papel del driver.
 *   duplexMode  'simplex' | 'longEdge' | 'shortEdge'
 *   etiqueta    para el nombre del temporal (diagnóstico)
 */
async function imprimir(bytes, opciones = {}) {
  const {
    deviceName,
    copies = 1,
    pageSize,
    duplexMode = 'simplex',
    etiqueta = 'trabajo',
  } = opciones;

  if (!deviceName) throw new Error('Falta elegir la impresora');

  /* Con `-silent`, el ayudante no protesta si la impresora no existe: se cierra
     sin hacer nada y sin código de error. Sin este chequeo, Quire diría
     "mandado a imprimir" y no habría salido nada. */
  const { hayLista, ficha } = await fichaDeImpresora(deviceName);
  if (hayLista && !ficha) {
    throw new Error(`La impresora "${deviceName}" ya no está. Elegí otra.`);
  }

  const ayudante = rutaDelAyudante();
  try {
    await fs.access(ayudante);
  } catch {
    /* Sin el ayudante no se imprime, y es a propósito: el camino de Chromium
       manda cualquier papel como A4, así que "imprimir igual" sería sacar una
       hoja corrida sin avisar. Que falle acá es más honesto. */
    throw new Error(
      `Falta el ayudante de impresión (${AYUDANTE_EXE}). Sin él no se puede elegir el tamaño de papel; reinstalá Quire.`
    );
  }

  const dir = await carpetaTemp();
  const archivo = path.join(dir, `${String(++trabajoN).padStart(3, '0')}-${etiqueta}.pdf`);
  await fs.writeFile(archivo, Buffer.from(bytes));

  const ajustes = ajustesDeImpresion({
    pageSize,
    copies,
    duplexMode,
    monocromo: !!ficha?.soloMonocromo,
  });

  await new Promise((resolve, reject) => {
    execFile(
      ayudante,
      [
        '-print-to', deviceName,
        '-print-settings', ajustes,
        '-silent',            // sin carteles de error suyos: los nuestros son nuestros
        '-exit-when-done',
        archivo,
      ],
      { windowsHide: true, timeout: 120000 },
      (err) => {
        if (!err) return resolve();
        if (err.killed) return reject(new Error('El ayudante de impresión no respondió'));
        reject(new Error(`La impresora rechazó el trabajo (${err.message})`));
      }
    );
  });

  return { ok: true, archivo, ajustes };
}

/** Borra los temporales de trabajos viejos. Se llama al salir. */
async function limpiarTemporales() {
  try {
    const dir = await carpetaTemp();
    const archivos = await fs.readdir(dir);
    await Promise.all(archivos.map((f) => fs.unlink(path.join(dir, f)).catch(() => {})));
  } catch { /* que no se pueda limpiar no es motivo para nada */ }
}

app?.on?.('will-quit', () => { limpiarTemporales(); });

module.exports = { listar, capacidades, imprimir, limpiarTemporales };
