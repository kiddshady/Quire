# SumatraPDF, acá adentro

Este ejecutable es el que manda el papel a la impresora. **No es un capricho:
es lo único que puede elegir el tamaño de hoja.**

## Por qué

`webContents.print({ silent: true })` de Electron siempre spoolea el papel por
defecto de Chromium para el locale —en Argentina, A4— y la app no lo puede
mover: ni pasándole `pageSize` por nombre, ni en micrones, ni omitiéndolo, ni
dejándole el papel puesto al driver desde antes de que arranque el proceso, ni
imprimiendo HTML en vez de un PDF. Está todo medido contra el spooler en el
README principal, en "HOY SOLO SE PUEDE IMPRIMIR EN A4".

Con eso, cualquier papel que no fuera A4 salía corrido: una A5 se corría
(297 − 210) / 2 = 43,5 mm hacia abajo y se perdía el final de la hoja.

Con SumatraPDF, el mismo trabajo sale **A5 148 × 210 mm** en el spooler aunque
el driver esté configurado en A4. Verificado con la cola en pausa.

## Qué es

| | |
|---|---|
| Versión | 3.6.1, 64 bits, portable |
| Origen | https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip |
| SHA-256 del .exe | `719F689B34F47BE8CA105CE8484948474DAFDE0E106BAB599E4A89326070C3D0` |
| Firma | Authenticode válida — CN=Krzysztof Kowalczyk, emitida por Certum Code Signing 2021 CA |
| Licencia | **GPLv3** (ver `LICENSE-GPLv3.txt`) |

## La licencia

SumatraPDF es GPLv3 y Quire es MIT. Van juntos en el instalador como programas
separados —Quire lo invoca por línea de comandos, no lo enlaza—, que es lo que
la GPL llama *mera agregación* y está permitido. Lo que sí obliga:

- distribuir el texto de la licencia (está acá al lado, y va al paquete);
- ofrecer el código fuente de SumatraPDF a quien lo pida. El código está en
  https://github.com/sumatrapdfreader/sumatrapdf y la versión exacta es la 3.6.1.

Eso está anotado en el `NOTICE` de la raíz, que es lo que se distribuye.

## Cómo se lo llama

Ver `src/impresion.cjs`. En resumen:

```
SumatraPDF.exe -print-to "<impresora>" -print-settings "noscale,paper=A5,..." \
               -silent -exit-when-done <archivo.pdf>
```

`noscale` es lo más importante de todo: el PDF ya viene impuesto y cualquier
escalado de acá sería una transformación que el preview no mostró.

## Si hay que actualizarlo

Bajar el zip portable de la versión nueva, verificar la firma con
`Get-AuthenticodeSignature`, reemplazar el .exe, y actualizar la versión, la URL
y el hash de esta tabla más la constante `AYUDANTE` de `src/impresion.cjs`.
