# Pisadores dinamicos y reglas automaticas

## Objetivo

Ampliar los pisadores del LF Automatizador sin alterar el audio principal ante
fallos. El Editor de Pistas Avanzado permitira configurar cuatro pisadores
precisos por cancion. La playlist incorporara una herramienta rapida para
aplicar un pisador sencillo a una fila normal o a una carpeta aleatoria.

El diseno mantiene compatibilidad con pistas antiguas, evita lecturas de disco
en el momento critico del disparo y garantiza que el archivo cuya duracion se
usa para calcular el inicio sea exactamente el archivo reproducido.

## Alcance

Incluye:

- Cuatro pisadores uniformes `P1`, `P2`, `P3` y `P4`.
- Archivos especificos, carpetas aleatorias y locuciones integradas.
- Anclajes dinamicos al marcador Intro u Outro.
- Preseleccion, medicion y precarga antes del disparo.
- Politica configurable cuando un pisador no cabe antes del Intro.
- Herramienta rapida `Herramientas > Pisadores automaticos`.
- Persistencia local en `.lfplay` y preferencias reutilizables por ruta.
- Migracion compatible del bloque horario heredado.

No incluye:

- Deteccion de voz o recalculo automatico del Intro durante la emision.
- Modificacion masiva de canciones fisicas dentro de una carpeta.
- Uso de la herramienta rapida sobre comerciales, streams, locuciones o
  comandos especiales de playlist.
- Una tabla relacional nueva para pisadores.

## Modelo de datos

### Columnas por pista

Se mantienen las columnas actuales de `P1`, `P2` y `P3`. Se agregan:

```text
p1_options TEXT
p2_options TEXT
p3_options TEXT
p4_active INTEGER
p4_mode TEXT
p4_time TEXT
p4_file TEXT
p4_options TEXT
```

Las columnas nuevas se crean con el mecanismo idempotente `ensureColumn`.
`phora_active`, `phora_mode` y `phora_time` se conservan como legado para no
romper versiones anteriores.

### Migracion de locucion horaria

Una migracion idempotente copia el bloque heredado de hora a `P4` cuando:

- `phora_active` esta activo.
- `P4` todavia no tiene configuracion.

El descriptor importado sera:

```json
{"v":1,"kind":"builtin","name":"time"}
```

Las columnas `phora_*` no se borran. Una version anterior podra seguir leyendo
la locucion horaria original. La version nueva usara exclusivamente `P1-P4`
despues de normalizar la fila.

### Fuente del pisador

`pN_file` acepta dos formatos:

1. Ruta simple heredada para un archivo especifico.
2. Descriptor JSON versionado para fuentes nuevas.

Ejemplos:

```json
{"v":1,"kind":"folder","path":"C:\\Pisadores\\Intros"}
{"v":1,"kind":"folder","path":"/home/radio/pisadores/intros"}
{"v":1,"kind":"builtin","name":"time"}
{"v":1,"kind":"builtin","name":"temperature"}
{"v":1,"kind":"builtin","name":"humidity"}
```

El descriptor JSON evita concatenar prefijos con rutas y funciona con
separadores de Windows y Linux. Las rutas simples antiguas siguen siendo
validas y los archivos nuevos especificos pueden seguir guardandose como ruta
simple para facilitar un downgrade.

### Opciones del pisador

`pN_options` guarda JSON versionado:

```json
{"v":1,"overflowPolicy":"skip"}
```

Valores permitidos:

- `skip`: cancelar el pisador y registrar aviso.
- `truncate-at-intro`: iniciar desde el principio disponible y detener al
  cruzar Intro.
- `allow-overlap`: iniciar desde el principio disponible y dejar terminar.

El valor por defecto es `skip`.

### Condiciones temporales

El selector del editor muestra exactamente este orden:

1. `Inicia en`
2. `Termina en`
3. `Termina en Intro`
4. `Inicia en Outro`

Persistencia:

| Condicion | `pN_mode` | `pN_time` |
| --- | --- | --- |
| Inicia en | `start` | segundos como texto |
| Termina en | `end` | segundos como texto |
| Termina en Intro | `end` | `intro` |
| Inicia en Outro | `start` | `outro` |

Esto reutiliza `pN_time` sin cambiar el significado de datos numericos
existentes.

## Editor de Pistas Avanzado

El panel izquierdo reemplaza el bloque especial de hora por `P4`. Cada bloque
`P1-P4` contiene:

- Selector unico de condicion.
- Selector de fuente.
- Campo de ruta cuando la fuente lo requiere.
- Boton `...` para elegir archivo o carpeta.
- Boton `Fijar` para condiciones manuales.
- Boton de limpieza.
- Boton compacto de engranaje para seguridad.

El selector de fuente permite:

- `Archivo especifico`
- `Carpeta aleatoria`
- `Locucion de hora`
- `Temperatura`
- `Humedad`

No se muestra un campo adicional `Auto: Intro`. Para `Termina en Intro` e
`Inicia en Outro`, el selector ya comunica el anclaje. El campo manual y el
boton `Fijar` se bloquean u ocultan.

### Validacion de marcadores

Al seleccionar `Termina en Intro`, el editor comprueba que el marcador Intro
sea mayor que cero. Al seleccionar `Inicia en Outro`, comprueba lo mismo para
Outro.

Si falta el marcador:

- Se muestra una advertencia visible.
- El usuario puede corregir el marcador sin perder el resto del formulario.
- Se bloquea el guardado mientras ese pisador siga activo e invalido.

La emision no intenta detectar Intro u Outro en tiempo real. Solo usa los
marcadores guardados por el operador.

### Ventana del engranaje

El engranaje abre una mini ventana con la politica aplicable cuando un pisador
configurado como `Termina en Intro` no cabe antes del marcador:

- Cancelar y registrar aviso.
- Iniciar desde el principio disponible y truncar al llegar al Intro.
- Iniciar desde el principio disponible y dejar terminar completo.

La interfaz marca `Cancelar y registrar aviso` como opcion recomendada.

## Herramienta rapida de playlist

El menu contextual de playlist agrega:

```text
Herramientas > Pisadores automaticos
```

Solo se habilita sobre:

- Cancion normal.
- Carpeta aleatoria ya insertada en playlist.

La mini ventana reutiliza el selector de fuente del Editor Avanzado, pero solo
permite `Inicia en N segundos`. No muestra Intro, Outro, calculos hacia atras
ni configuracion de overflow.

Tambien permite elegir:

- `Respetar pisadores del Editor Avanzado`.
- `Ignorar pisadores del Editor Avanzado`.

Y el alcance:

- `Solo esta fila de playlist`.
- `Cada vez que se vuelva a anadir esta ruta`.

La eleccion de alcance esta disponible tanto para una cancion normal como para
una carpeta aleatoria.

### Persistencia de regla rapida

La regla tiene forma versionada:

```json
{
  "v": 1,
  "source": {"kind": "folder", "path": "/ruta/pisadores"},
  "startSeconds": 8,
  "advancedPolicy": "respect",
  "scope": "row"
}
```

Regla local:

- Se guarda como metadata de la fila.
- Viaja dentro de `.lfplay`.
- Se restaura al abrir la playlist.
- Se incluye en snapshots de sesion y operaciones de copiar, cortar y pegar.

Regla persistente por ruta:

- Se guarda en `config/automatic_sweeper_rules.json`.
- La clave es la ruta normalizada de la cancion o carpeta aleatoria.
- Se aplica al crear futuras filas para esa misma ruta.
- No modifica archivos de audio ni filas de la tabla `tracks`.
- Una regla incluida explicitamente en `.lfplay` prevalece sobre el valor
  persistente por ruta.

La comparacion de rutas usa `path.resolve`. Solo en Windows se compara sin
distincion entre mayusculas y minusculas.

## Resolucion durante reproduccion

### Separacion de contextos

Para una fila normal:

- Los pisadores avanzados se leen desde la pista fisica.
- La regla rapida se lee desde la fila de playlist.

Para una fila de carpeta aleatoria:

- Primero se resuelve la cancion fisica elegida por la playlist.
- Los pisadores avanzados se leen desde esa cancion fisica resuelta.
- La regla rapida se lee desde la fila de carpeta.

Esta separacion evita confundir metadata de carpeta con cues de una cancion.

### Prioridad

Si la regla rapida usa `respect` y existe al menos un pisador avanzado activo,
la regla rapida se omite por completo para esa reproduccion.

Si usa `ignore`, no se disparan pisadores avanzados y solo se prepara la regla
rapida.

Si no existe regla rapida, se preparan normalmente los pisadores avanzados.

### Plan de ejecucion por reproduccion

Cada inicio o reinicio de cancion crea una nueva sesion de overlays:

1. Recopilar pisadores aplicables.
2. Resolver la fuente concreta de cada pisador.
3. Medir la duracion real del archivo o secuencia concreta.
4. Calcular el instante de disparo.
5. Precargar en Rust con `autoplay: false`.
6. Mantener en memoria el `playerId`, fuente concreta, duracion, instante y
   politica de overflow.
7. Enviar `play` al cruzar el instante calculado.
8. Liberar el player al terminar, cambiar de pista o reiniciar.

Una carpeta se sortea una sola vez por sesion. La duracion calculada y el audio
reproducido pertenecen siempre al mismo archivo.

### Carpetas y filtro por duracion

Para `Termina en Intro`:

1. Calcular el espacio disponible entre el inicio efectivo de la cancion y el
   marcador Intro.
2. Enumerar audios compatibles de la carpeta.
3. Resolver sus duraciones usando cache y medicion anticipada cuando falten.
4. Filtrar los candidatos cuya duracion cabe.
5. Sortear unicamente entre candidatos validos.

Si no existe ningun candidato valido, aplicar `overflowPolicy`.

La enumeracion, medicion y precarga ocurren al cargar la cancion, no cuando el
reloj ya alcanzo el disparo.

### Fuentes integradas

- Hora: resolver la secuencia horaria vigente y sumar su duracion real.
- Temperatura: resolver el archivo correspondiente al ultimo dato disponible.
- Humedad: resolver el archivo correspondiente al ultimo dato disponible.

La capa de overlays abstrae archivo unico y secuencia. El contrato con Rust
debe permitir precargar sin autoplay y reproducir posteriormente el player ya
cargado. Para secuencias, se reutiliza o extiende el mecanismo gapless
existente.

### Overflow

Cuando un pisador no cabe:

- `skip`: no se crea el disparo y se registra incidente.
- `truncate-at-intro`: iniciar desde el principio efectivo disponible y
  detener el overlay al cruzar Intro.
- `allow-overlap`: iniciar desde el principio efectivo disponible y permitir
  que termine.

El audio principal nunca se detiene por esta situacion.

## Cache y ciclo de vida

Se mantienen caches separadas:

- Archivos enumerados por carpeta con TTL.
- Duracion por ruta concreta.
- Planes de overlays precargados por sesion de reproduccion.

Al cambiar de pista o reiniciar:

- Detener players precargados o activos de la sesion anterior.
- Limpiar planes de sesion.
- Sortear de nuevo las carpetas.
- Resolver de nuevo hora y clima para usar datos vigentes.

Los avisos de fallo deben incluir pista principal, pisador, fuente y motivo.

## Manejo de fallos

Se aplica una politica fail-soft:

- Carpeta vacia: omitir pisador y registrar aviso.
- Archivo ausente: omitir pisador y registrar aviso.
- Descriptor JSON invalido: omitir pisador y registrar aviso.
- Clima sin dato o locucion ausente: omitir pisador y registrar aviso.
- Marcador dinamico ausente en runtime: omitir pisador y registrar aviso.
- Fallo de medicion o precarga: omitir pisador y registrar aviso.
- Cambio de pista antes del disparo: cancelar preload anterior.

La cancion principal continua sin interrupciones.

## Pruebas

### Persistencia y compatibilidad

- Leer rutas heredadas de archivo.
- Crear columnas nuevas de forma idempotente.
- Importar `phora_*` a `P4 = Hora` sin borrar legado.
- Leer descriptores JSON con rutas Windows y Linux.
- Guardar y restaurar regla local dentro de `.lfplay`.
- Aplicar preferencia persistente por ruta a cancion y carpeta aleatoria.
- Conservar regla al copiar, cortar, pegar y restaurar snapshot.

### Resolucion

- Sortear una carpeta una sola vez por sesion.
- Calcular y reproducir el mismo archivo concreto.
- Filtrar por duracion antes de `Termina en Intro`.
- Aplicar `skip`, `truncate-at-intro` y `allow-overlap`.
- Resolver duracion de hora, temperatura y humedad.
- Resolver cues avanzados desde la pista fisica dentro de una fila aleatoria.

### Prioridad

- Omitir regla rapida con `respect` cuando exista algun pisador avanzado.
- Usar solo regla rapida con `ignore`.
- Usar pisadores avanzados cuando no haya regla rapida.

### Motor y ciclo de vida

- Enviar preload con `autoplay: false`.
- Enviar `play` al cruzar el instante.
- Cancelar players al cambiar de pista.
- Reiniciar pista, limpiar sesion y volver a sortear.
- Mantener reproduccion principal ante fallos de overlay.

### Interfaz

- Mostrar condiciones en el orden aprobado.
- Bloquear campo manual y `Fijar` para Intro y Outro.
- Advertir y bloquear guardado si falta el marcador dinamico.
- Cambiar dialogo `...` segun archivo o carpeta.
- Mostrar engranaje y mini ventana de overflow.
- Habilitar herramienta rapida solo en filas permitidas.

## Criterios de aceptacion

- Un pisador aleatorio nunca calcula con la duracion de un archivo y reproduce
  otro distinto.
- Un anclaje dinamico nunca se guarda activo sin su marcador requerido.
- Un fallo de pisador nunca detiene la cancion principal.
- `P1-P4` admiten las cinco fuentes aprobadas.
- Las reglas rapidas locales sobreviven al guardado y apertura de `.lfplay`.
- Las reglas persistentes por ruta se reaplican al crear filas futuras.
- Windows y Linux interpretan correctamente los descriptores de carpeta.
