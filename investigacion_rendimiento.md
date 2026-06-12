# Investigación de rendimiento — verificación independiente

Fecha: 2026-06-11 · Rama analizada: `main` (db40304) · Verificado contra el código real, no contra el documento de hipótesis.

## 0. Hallazgo previo: la hipótesis describe OTRA rama

Los archivos que cita la hipótesis (`frontend/main_library_search.js`, `frontend/library_search_shared.js`, el canal IPC `library-index-search`) **no existen en `main`**. Existen en la rama `codex/respaldo-auditoria-eventos` (commit 9525128, "Bump version to 0.9.15"), que va 6 commits por delante de `main`. En `main` quedaron los tests de esos módulos (`tests/library_index.test.js`, `tests/file_type_resolver.test.js`) sin su implementación, por eso fallan desde antes de esta intervención.

El "buscador integrado en la interfaz principal" solo existe en esa rama. En `main`, el único buscador es el de la ventana Biblioteca (`frontend/libreria.js`).

## 1. Buscador / congelamiento de la interfaz

### Confirmado (con matices)

- **En la rama 0.9.15**: la hipótesis es correcta tal cual. `performSearch()` invoca `library-index-search` con `query: ''` y `limit: 3000`, y luego ejecuta `fuzzySearch` (Fuse + Levenshtein) sobre hasta 3000 filas **en el hilo de la UI**, en cada tecleo (debounce 220 ms).
- **En `main`**: el buscador de la Biblioteca hacía lo equivalente: `fuseEngine.search(query)` sobre TODA la lista (`workQueueTracks`, sin límite) en el hilo del renderer.

### Lo que la hipótesis NO vio (y es lo más grave)

El congelamiento de "todo el software" no lo causa la búsqueda difusa (eso solo congela su propia ventana: cada BrowserWindow tiene su proceso renderer). Lo causa el **proceso principal de Electron**:

1. `lib-get-db-tracks` (backend/ipc/library.js) ejecutaba consultas **síncronas** de better-sqlite3 más un mapeo pesado por fila (`mapTrackRowToClient`: regex de artistas, inferencias, joins de país) **en el proceso main**. Al abrir la Biblioteca con decenas de miles de pistas se pide TODO de una vez → el event loop del main queda bloqueado segundos → **todas** las ventanas dejan de recibir IPC y la app entera parece colgada.
2. Al abrir la Biblioteca, `initializeExplorer()` hacía `fs.existsSync()` **en serie por cada pista guardada** (50,000 stats síncronos contra el disco) antes de pintar nada.

## 2. Audio que "intenta sonar y se detiene" (HDD + RustAudio timeout)

### Confirmado parcialmente, con corrección importante del mecanismo

- El timeout de comandos RustAudio es efectivamente **3 segundos** (`backend/audio_engine_process.js`, `command()`), y al fallar dispara `recover()` → reinicio del motor → el bucle descrito.
- El guardián de reproducción existe tal cual (`PLAYBACK_GUARD_STALL_MS = 9000`, `runPlaybackGuard` → `triggerPlaybackGuardRecovery`).

### Refutado / corregido

- `takeRandomFolderFileAvoidingRecentMusic` **ya no congela el renderer**: el escaneo recursivo usa `fs.promises.readdir` cediendo el hilo (frontend/random_folder_source.js, `readRelativeAsync`). El comentario del propio código documenta que el lector síncrono anterior causaba justo los falsos stalls. La hipótesis describía el estado viejo.
- El mecanismo real del "Timeout esperando respuesta RustAudio" no requiere que el disco "secuestre" a Rust: **el puente con RustAudio (stdin/stdout y sus timers de 3 s) vive en el proceso main**, el mismo que ejecutaba las consultas SQLite síncronas. Camino verificado en código:
  1. Modo aleatorio resuelve pista → `ensureDbTracksLoaded(songEligible)` puede pedir **miles** de rutas (separación por artista) → `lib-get-db-tracks` bloquea el main varios segundos.
  2. Mientras el main está bloqueado, las respuestas de Rust quedan sin leer en el buffer; en Node los timers se procesan antes que el I/O pendiente al desbloquear → el timeout de 3 s "gana" aunque Rust haya respondido a tiempo.
  3. Falso `engineUnresponsive` → reinicio del motor → re-lectura fuerte en el HDD → se repite → "Error crítico".
- La contención de I/O en HDD es real como **amplificador** (statSync masivos, escaneos, decodificación), pero el cuello arquitectónico era el event loop del main. Un "I/O scheduler" no habría arreglado los falsos timeouts.

## 3. Correcciones aplicadas (rama `main`)

1. **Búsqueda fuera del hilo de la UI** (mandato principal):
   - `frontend/library_search_worker.js` (nuevo): hilo dedicado (`worker_threads`) que mantiene el índice y responde consultas.
   - `frontend/library_search_shared.js`: restaurado desde 9525128 y extendido con `createSearchSession()` (índice Fuse precalculado; antes se reconstruía el índice en cada consulta). Es el mismo módulo que usará el buscador de la interfaz principal cuando se integre la 0.9.15 — su test ya pasa.
   - `frontend/libreria.js`: el buscador envía la consulta al worker y aplica resultados de forma asíncrona con protección contra respuestas tardías; si el worker no está disponible, cae a una sesión en línea (comportamiento previo) para nunca dejar el buscador muerto.
2. **Consultas masivas fuera del proceso main** (raíz del congelamiento global y de los falsos timeouts de RustAudio):
   - `backend/services/track_mapper.js` (nuevo): `mapTrackRowToClient`, firmas de archivo y la consulta por lotes, compartidos entre main y worker (una sola copia de la lógica).
   - `backend/library_worker.js`: nueva acción `lib-get-db-tracks` (conexión SQLite propia, WAL ya activo).
   - `backend/ipc/library.js`: el handler delega al worker; red de seguridad en main si el worker falla.
   - `main.js`: las funciones extraídas se importan del módulo compartido (−160 líneas duplicadas).
3. **Arranque de la Biblioteca sin stats síncronos**: `filterExistingPathsAsync()` (fs.promises.access, concurrencia 8 para no castigar discos mecánicos).

Verificación: `node --check` en todos los archivos tocados; smoke test bajo Electron (mapper + ambos workers responden, búsqueda con typos funciona); `npm test` queda con los mismos 3 fallos preexistentes (EPIPE de Rust stdin, y los 2 tests de módulos que solo existen en la rama 0.9.15) y un fallo menos que antes (`library_search_shared` ahora pasa).

## 4. Segunda tanda (2026-06-11, tarde): crash en producción, bucle "disco rayado" y permisos de administrador

### 4.1 Crash "Object has been destroyed" (captura del usuario) — CONFIRMADO y corregido

`broadcastAnalyzerResult` (main.js:333 en el build empacado) enviaba a `libraryWindow`/`mainWindow` comprobando solo que la variable no fuera null, **sin `isDestroyed()`**. Los workers de análisis/metadatos emiten resultados después de que el usuario cerró la ventana → `webContents.send` sobre ventana destruida → excepción no capturada en el proceso main → el diálogo de error de Electron. La traza de la captura coincide exactamente (Worker → broadcastAnalyzerResult).

**Corrección:** helper `sendToWindowSafe()` en main.js (verifica ventana y webContents vivos, con try/catch) aplicado a todas las emisiones desde callbacks asíncronos: analizador, metadatos local/red y refresh-manual-cues.

### 4.2 Bucle de ~1 segundo repitiendo la canción (HDD saturado) — CONFIRMADO y corregido

Primero se descartó el nivel de audio: el motor Rust emite **silencio** en underrun (main.rs:2156-2182), no repite buffer. El bucle es del renderer: `triggerPlaybackGuardRecovery` relanzaba la misma pista desde `resumeStart` cada 6 segundos fijos, **sin límite de intentos** (a diferencia de la recuperación RustAudio, que corta tras 2). Con el disco saturado: relanza → suena ~1s (lo que había en caché) → se ahoga → relanza el mismo punto → "disco rayado". "A veces sale" = el disco se liberó a tiempo; "a veces no" = bucle infinito.

**Corrección (escalera de recuperación):**
- `playbackGuard.staleRecoveries` cuenta recuperaciones consecutivas sin avance real del reloj (solo se reinicia cuando la reproducción progresa de verdad, no al relanzar).
- Backoff exponencial: 6s → 12s → 24s… tope 60s, para no exigirle lecturas nuevas a un disco que no da abasto.
- Al 3er intento sin avance, salta a la siguiente pista (fuente de datos distinta) en lugar de insistir con la misma. Si la siguiente también falla, sigue saltando con espera creciente: nunca bucle infinito, nunca silencio definitivo.

### 4.3 "Solo funciona como administrador" — CONFIRMADO y corregido

El instalador NSIS es por-usuario y no requiere admin. La raíz estaba en el asistente de primer inicio: `wizard:installVcRedist` lanzaba `vc_redist.x64.exe /install /quiet` con `cp.spawn` directo. El redistributable de VC++ instala DLLs de sistema y **siempre** requiere elevación; con `/quiet` y sin UAC, en una sesión normal falla — por eso al usuario "se lo arregló" ejecutar toda la app como administrador. La UI incluso prometía "te pedirá permisos de administrador", pero ese aviso nunca aparecía.

**Corrección:** el instalador del redistributable se lanza con `Start-Process -Verb RunAs` (aviso UAC puntual, solo para ese proceso). Código 1223 = usuario canceló el UAC, reportado con mensaje claro. La app ya no necesita ejecutarse como administrador.

### 4.4 Trabajo pesado restante en la interfaz principal

Los tres puntos donde `render.js` clonaba `manualCuesDB` completo (decenas de miles de claves) con spread en el hilo de la UI —incluido el camino caliente justo antes de salir al aire— ahora mezclan en sitio con `Object.assign` (también en libreria.js, 4 sitios).

## 5. Integración de la 0.9.15 y rediseño del buscador principal (2026-06-11, noche)

Por decisión del operador, la rama `codex/respaldo-auditoria-eventos` (v0.9.15) se integró a `main` (merge e4a710b). Con eso el buscador de la interfaz principal ya vive en `main`, y se corrigió de raíz:

- **Búsqueda**: `performSearch` ya NO pide 3000 filas con `query:''` ni ejecuta Fuse/Levenshtein en el hilo de la UI. La consulta real viaja al backend y la búsqueda difusa corre en `library_worker` sobre una sesión cacheada (firma = conteo + último `updated_at` del índice; el índice Fuse solo se reconstruye cuando el índice cambia). La UI solo pinta los 150 resultados finales, con protección contra respuestas tardías.
- **Sincronización**: `library-index-sync-all` / `sync-root` ya NO corren en el proceso main (readdirSync recursivo + lectura de tags ID3 por archivo bloqueaban todo). Corren en `library_worker`, con transacciones por lotes de 500 (el lock de escritura de SQLite se libera entre tandas) y **progreso real**: el worker emite mensajes `{progress}`, main los retransmite (`library-index-sync-progress`) y el cuadro de estado muestra `Sincronizando índice (carpeta 1/3)... 42% (810/1938)`.
- **Botón ↻**: conserva el orden pedido — primero refresca el explorador de archivos, después sincroniza el índice — ahora con porcentaje visible y sin reentradas.
- **Arranque**: nuevo canal ligero `library-index-status` (solo conteos, jamás escanea). Al abrir el software el cuadro muestra p. ej. `Índice listo: 1938 pistas · 15 pendientes · últ. sync 09/06/2026`. No hay ningún análisis automático al arrancar.

Verificado bajo Electron con la base real de esta máquina: estado (1938 pistas, 3 raíces), búsqueda con query, y sync completo con 9 eventos de progreso. Suite completa: 245 tests, 0 fallos (los 3 que fallaban antes del merge eran de módulos de esta rama y ya pasan).

## 6. Telemetría real y lectura acotada de tags (2026-06-11, tarde)

Tras el reporte del operador ("la segunda carpeta avanza más lento de 50 en 50"), se corrió una telemetría instrumentada sobre el código real con las dos carpetas reales (`D:\Music`, 1,911 pistas; `D:\Mis musicas`, 15,252 pistas), midiendo por lote de 50: tiempo total, tiempo de `stat`, tiempo y **bytes** de lectura de tags.

### Hallazgo (medido, no estimado)

`node-id3.read(ruta)` hace `fs.readFileSync` del **archivo completo** solo para parsear la cabecera ID3v2, que declara su propio tamaño en los primeros 10 bytes. Telemetría "antes": **~470–630 MB leídos por cada lote de 50 canciones** (~10–12 MB por archivo), con `tagMs` ≈ 98% del tiempo del lote. Indexar era, literalmente, leer toda la biblioteca byte a byte (~22 GB para 1,911 pistas).

Esto también explica la diferencia entre carpetas que percibió el operador: la velocidad por lote es proporcional al tamaño de los archivos y a si Windows ya los tenía en caché (D:\Music se había leído en pruebas anteriores; D:\Mis musicas estaba fría). En el banco limpio, ambas carpetas iban igual de lento.

### Corrección de raíz

`readTags` en `backend/services/library_index.js` ahora localiza la cabecera ID3v2 con la misma validación que node-id3 (marca, versión, tamaño syncsafe) y lee **únicamente el tag declarado**: camino rápido de 10 bytes si la cabecera está al inicio (el caso estándar), escaneo del primer MB como respaldo. Diferencia aceptada: tags incrustados más allá del primer MB (p. ej. al final de un wav) ya no se detectan — ese caso era el que obligaba a leer archivos gigantes completos.

### Resultados (mismas carpetas, configuración limpia, mismo disco)

| Métrica | Antes | Después |
|---|---|---|
| D:\Music (1,911) primera indexación | 292 s | **3.1 s** |
| D:\Mis musicas (15,252) primera indexación | no terminó en 5.5 min (~300) | **224 s completa** |
| Biblioteca completa (17,163) | ~35–40 min estimados | **3 min 47 s** |
| I/O por lote de 50 | ~470–630 MB | ~0.2–30 MB |
| Refrescar (sin cambios) | igual que primera vez | 0 lecturas de tags (corrección previa: reutiliza metadatos del índice si tamaño+fecha no cambiaron) |

## 7. INVESTIGACIÓN (sin implementar): bucle de audio de 1–3 s con disco saturado

### Problema
Cuando el disco se satura (antivirus, Windows Update, cualquier I/O pesado), el audio al aire se "congela" repitiendo un bucle de 1–3 segundos (efecto metralleta/disco rayado corto); a veces se recupera solo, a veces no.

### Causa raíz (verificada en código, audio-engine-rust/src/main.rs)
`load_audio_player` (línea ~2845) usa rodio con decodificación perezosa: `Decoder::try_from(File)` + `player.append`. El decoder lee del disco A MEDIDA que el mezclador le pide muestras, y el grafo del mezclador corre **dentro del callback de render de WASAPI** (confirmado por el propio código, línea ~580: el TapSource del bus FX "corre en el thread de audio"). Consecuencia: cuando el disco se bloquea, `File::read` bloquea el callback de WASAPI; el motor de audio de Windows se queda sin datos nuevos y repite el último buffer → el bucle audible. El manejo de underrun existente (línea ~2156: "buffer vacío → silencio") no aplica: cubre el caso "fuente vacía que responde", no el caso "hilo bloqueado en disco".

Regla violada (la misma de toda esta investigación): el hilo de audio en tiempo real es como el hilo de UI — **jamás debe tocar el disco**.

### Solución de raíz propuesta (plan de trabajo)
1. **Precarga a RAM en `load`** (cambio principal, acotado): leer el archivo completo a memoria (~10 MB típico) y decodificar desde `Cursor<Vec<u8>>`. Tras el load, el disco puede morir y la pista al aire no se entera. La app ya precarga la siguiente pista con anticipación, así que el costo de lectura ocurre fuera del aire.
2. **Tope de tamaño + camino streaming** para archivos gigantes (programas grabados de cientos de MB): hilo decodificador dedicado que llena un ring buffer rtrb (misma técnica que ya usa el encoder tap) con 5–10 s de PCM; el callback solo hace pop. Underrun → silencio (mecanismo existente) en vez de bucle.
3. **Prioridades Windows** (10/11 Home/Pro/LTSC, sin diferencias por edición): subir la clase de prioridad del proceso del motor (ABOVE_NORMAL) y registrar el hilo de audio en MMCSS ("Pro Audio") para que el scheduler lo proteja cuando el sistema está cargado. No requiere admin.
4. **Verificación**: telemetría como la de la sección 6 — reproducir con saturación de disco artificial (lecturas masivas concurrentes) y confirmar cero bucles; medir latencia de load antes/después.

Orden sugerido: 1 → 4 → 3 → 2 (el 1 elimina el síntoma para el 99% de los casos; el 2 es el cierre completo).

### RESULTADO (2026-06-12) — plan ejecutado COMPLETO
- **Fase 1 (precarga a RAM):** implementada en los 3 caminos de reproducción; tope 200 MB.
- **Fase 2 (verificación real):** pista al aire mientras 3 procesos leían la biblioteca completa en paralelo → avance del reloj de reproducción 1.0008× el reloj de pared, **stall máximo 19 ms** (antes: bucles de 1–3 s).
- **Fase 3 (prioridades):** MMCSS "Pro Audio" (Windows) / RtKit (Linux) vía feature de cpal + proceso en ABOVE_NORMAL; `libdbus-1-dev` en CI y `libdbus-1-3` en el .deb.
- **Fase 4 (archivos >200 MB):** `StreamedFileSource` — hilo decodificador dedicado + ring rtrb de 10 s; ring vacío → silencio, jamás bloqueo; limitación documentada: sin seek en ese caso raro. 7 tests Rust en total (4 del motor de audio).
- Regresión colateral corregida: la ingesta de metadatos del índice escribía con autocommit por archivo (~136k commits) y devolvió la indexación a minutos; ahora va por lotes dentro de la transacción → biblioteca completa con metadatos en 38.6 s.

### Estado de compilación (¿listo para compilar en GitHub?)
**Lo bueno:** el workflow CI está sólido y probado (builds verdes en los 3 pushes anteriores y el actual en progreso): tests, cargo test/check, rebuild nativo de better-sqlite3, checksums con atestación, instalador por-usuario sin admin, sin configuraciones personales, versión semver correcta.
**Lo malo / pendiente:** (a) hay trabajo a medias sin commitear en el árbol local (paneles "DockManager": render.js, style.css, index.html, locales) cuya mitad de main.js sí viajó en un commit anterior — en el build publicado esos dos ítems de menú de orden de paneles no hacen nada y sus etiquetas pueden verse sin traducir; conviene terminar/commitear ese trabajo antes de taggear v0.9.16; (b) la firma de código solo se aplica en tags (correcto, pero el .exe de pushes normales queda sin firmar); (c) los tests no viajan al repo (tests/ git-ignorado) — CI los ejecuta como no-op, decisión consciente pero significa que el CI no corre la suite de regresión real.

## 8. Pendiente / recomendaciones

- ~~Rama 0.9.15~~: integrada y corregida (ver sección 5).
- **Contención HDD (amplificador real)**: si tras estas correcciones persisten incidencias en discos mecánicos, el siguiente paso de raíz es priorizar I/O: pausar precargas de auxiliares/pre-escucha mientras el deck al aire llena su búfer inicial. No se implementó aquí porque el mecanismo dominante verificado era el bloqueo del main.
- El fallo de test "Rust stdin EPIPE during stop" es preexistente en `main` y merece revisión aparte.
