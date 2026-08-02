# Caza el flash verde capturando la PANTALLA real mientras arranca la app.
#
# capturePage() de Electron no sirve para esto: lee el swap chain de Chromium
# antes de la composición final, así que un frame pintado por el compositor de
# Windows le es invisible. Hay que sacarle una foto al escritorio.

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$salida = Join-Path $PSScriptRoot 'flash'
New-Item -ItemType Directory -Force -Path $salida | Out-Null
Get-ChildItem $salida -Filter *.png | Remove-Item -Force -ErrorAction SilentlyContinue

$pantalla = [System.Windows.Forms.Screen]::PrimaryScreen
if (-not $pantalla) {
  Add-Type -AssemblyName System.Windows.Forms
  $pantalla = [System.Windows.Forms.Screen]::PrimaryScreen
}
$w = $pantalla.Bounds.Width
$h = $pantalla.Bounds.Height

Write-Host "  pantalla: ${w}x${h}"
Write-Host "  lanzando la app y muestreando..."

$exe = Join-Path $raiz 'node_modules\electron\dist\electron.exe'
$proc = Start-Process -FilePath $exe -ArgumentList $raiz -PassThru

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)

$frames = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# ~90 muestras en unos 3 segundos: alcanza para cazar un frame suelto.
for ($i = 0; $i -lt 90; $i++) {
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $t = $sw.ElapsedMilliseconds

  # Muestreo en grilla: contar cuánto de la pantalla es verde saturado.
  $verdes = 0
  $total = 0
  for ($y = 100; $y -lt $h - 100; $y += 40) {
    for ($x = 100; $x -lt $w - 100; $x += 40) {
      $p = $bmp.GetPixel($x, $y)
      $total++
      if ($p.G -gt 80 -and $p.R -lt 70 -and $p.B -lt 70 -and ($p.G - $p.R) -gt 40) { $verdes++ }
    }
  }
  $pct = if ($total) { [math]::Round(100 * $verdes / $total, 1) } else { 0 }
  $frames += [pscustomobject]@{ ms = $t; verde = $pct }

  if ($pct -gt 8) {
    $bmp.Save((Join-Path $salida ("verde-{0:D4}ms.png" -f $t)), [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("  !! {0,5} ms  ->  {1}% de la pantalla en verde  (frame guardado)" -f $t, $pct) -ForegroundColor Green
  }
  Start-Sleep -Milliseconds 25
}

$g.Dispose(); $bmp.Dispose()
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

$pico = $frames | Sort-Object verde -Descending | Select-Object -First 1
Write-Host ""
Write-Host ("  pico de verde: {0}% a los {1} ms" -f $pico.verde, $pico.ms)
$conVerde = @($frames | Where-Object { $_.verde -gt 8 })
Write-Host ("  frames con verde: {0} de {1}" -f $conVerde.Count, $frames.Count)
if ($conVerde.Count) {
  Write-Host ("  ventana del flash: {0} ms a {1} ms" -f $conVerde[0].ms, $conVerde[-1].ms)
}
