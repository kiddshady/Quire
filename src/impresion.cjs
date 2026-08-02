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

   El truco de fondo: Chromium sabe rasterizar PDFs. Se carga el archivo en una
   BrowserWindow oculta con `plugins:true` y se imprime esa ventana. Es la
   misma ruta que usa el visor de PDF del navegador, así que lo que sale por la
   impresora es lo que Chromium ya sabe pintar bien.
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
 *   collate     intercalar copias
 *   pageSize    'A4' | 'A5' | {width,height} en MICRONES
 *   duplexMode  'simplex' | 'longEdge' | 'shortEdge'
 *   etiqueta    para el nombre del temporal (diagnóstico)
 */
async function imprimir(bytes, opciones = {}) {
  const {
    deviceName,
    copies = 1,
    collate = true,
    pageSize,
    duplexMode = 'simplex',
    etiqueta = 'trabajo',
  } = opciones;

  if (!deviceName) throw new Error('Falta elegir la impresora');

  const dir = await carpetaTemp();
  const archivo = path.join(dir, `${String(++trabajoN).padStart(3, '0')}-${etiqueta}.pdf`);
  await fs.writeFile(archivo, Buffer.from(bytes));

  const win = new BrowserWindow({
    show: false,
    // Fuera de pantalla y no en 0,0: si algo la mostrara por error, no aparece
    // un rectángulo blanco en el medio del escritorio.
    x: -20000,
    y: -20000,
    width: 1000,
    height: 1400,
    backgroundColor: '#0a0b0d',
    webPreferences: { plugins: true, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadURL('file:///' + archivo.replace(/\\/g, '/'));

    // El visor de PDF de Chromium monta su <embed> después del load. Sin esta
    // espera, print() a veces sale con la primera página en blanco.
    await new Promise((r) => setTimeout(r, 500));

    const resultado = await new Promise((resolve) => {
      win.webContents.print(
        {
          silent: true,             // el diálogo es nuestro, no el del sistema
          deviceName,
          printBackground: true,
          color: false,             // la P1102w es monocromo; pedir color no aporta
          copies: Math.max(1, Math.min(999, Math.round(copies))),
          collate,
          duplexMode,
          // El PDF ya viene impuesto: cualquier escala o margen de acá lo
          // rompería y el preview habría mentido.
          margins: { marginType: 'none' },
          scaleFactor: 100,
          ...(pageSize ? { pageSize } : {}),
        },
        (ok, motivo) => resolve({ ok, motivo })
      );
    });

    if (!resultado.ok) {
      // "cancelled" es el usuario cerrando el diálogo del driver, no una falla.
      const m = String(resultado.motivo || '').toLowerCase();
      if (m.includes('cancel')) return { ok: false, cancelado: true };
      throw new Error(resultado.motivo || 'La impresora rechazó el trabajo');
    }

    return { ok: true, archivo };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
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
