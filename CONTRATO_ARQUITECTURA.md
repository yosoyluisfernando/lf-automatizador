# Contrato de Arquitectura — Roles por Lenguaje + Metodología + Hoja de Ruta

## Contexto

LF Automatizador v1.0 tiene un problema de diseño: la lógica de negocio está dispersa entre frontend JS (render.js: 16,500 líneas), backend JS (185+ canales IPC), y un motor Rust de audio (3,852 líneas bien diseñadas). El objetivo es migrar TODO el cerebro a Rust, dejando JavaScript exclusivamente como puente de comunicación y HTML/CSS como capa de presentación. Esto prepara el camino para una futura migración a Tauri.

## Decisiones tomadas
- **Rama larga**: todo en rama `rust-core-migration`, merge a main cuando el conjunto funcione
- **serde_json**: reemplaza el parser JSON manual del motor Rust
- **Sin fallback/shimming**: cuando un módulo se traduce a Rust, el JS se borra
- **Documento permanente**: este archivo es referencia del equipo

---

## 1. Contrato de roles por lenguaje

### Rust — EL CEREBRO (calcula, decide, persiste)

Todo lo que piensa, calcula, decide, valida, persiste o procesa se escribe en Rust.

| Responsabilidad | Detalle |
|---|---|
| Audio | Playback, DSP, metering, routing, gapless, fades (ya existe) |
| Datos | SQLite via rusqlite — único punto de lectura/escritura |
| Scheduler | Eventos, modos playlist, cues, pisadores |
| Biblioteca | Indexado, búsqueda fuzzy, metadata ID3, artistas, géneros |
| Encoder | FFmpeg spawn, Icecast/Shoutcast, multi-servidor, PCM tap |
| Estado | State store central — playlists, config, cola eventos, incidentes |
| Validación | Toda validación de datos (fechas, rangos, formatos) |
| Plugins | Weather, metadata net, locuciones, futuros (TTS, RDS) |
| Archivos | Lectura/escritura de configs, escaneo de directorios |

**Reglas Rust:**
- `Result<T, E>` para todo error handling, nunca `unwrap()` en paths de producción
- Structs con ownership claro, enums para máquinas de estado
- serde para toda serialización/deserialización
- Tests unitarios por módulo
- Sin estado global mutable (state detrás de Arc<Mutex> o canales mpsc)

### JavaScript (Main Process) — EL PUENTE (pasa mensajes, no piensa)

| Puede hacer | NO puede hacer |
|---|---|
| Crear/cerrar ventanas Electron | Calcular nada |
| Mostrar diálogos nativos (open file, save, confirm) | Acceder a la DB |
| Reenviar mensajes renderer ↔ Rust | Tomar decisiones de negocio |
| Gestionar el ciclo de vida de la app | Leer/escribir archivos de datos |
| Spawnar el proceso Rust | Validar datos |
| Menús nativos y tray | Mantener estado propio |

**Reglas JS Main:**
- Máximo ~500 líneas en total (window lifecycle + message forwarding)
- Cero `require('fs')` para datos de la app
- Cero `db.prepare()` — la DB no existe para JS
- Cada IPC del renderer se reenvía al proceso Rust tal cual
- Los diálogos nativos (Electron dialog API) sí viven aquí porque son API de plataforma

### JavaScript (Renderer) — LA PINTURA (dibuja, no piensa)

| Puede hacer | NO puede hacer |
|---|---|
| Renderizar DOM/HTML | Calcular status, cues, timing |
| Dibujar canvas (waveforms, VU meters) | Acceder a fs, DB, o cualquier dato |
| Capturar eventos de usuario (click, drag, key) | Decidir qué pista sigue |
| Mostrar traducciones (i18n) | Filtrar o transformar datos |
| Animaciones CSS | Persistir estado a disco |
| Enviar comandos al Núcleo via bridge | Validar reglas de negocio |

**Reglas JS Renderer:**
- Recibe snapshots de estado completos desde Rust → actualiza DOM
- Envía comandos atómicos: `{module: "scheduler", cmd: "nextTrack"}`
- Cero `require('fs')`, cero `require('path')` para lógica
- Cero cálculos de fechas, duración, status
- Si necesita un dato derivado, lo pide a Rust (Rust lo calcula y lo incluye en el snapshot)

### HTML/CSS — LA PIEL (estructura y estilo)

- Sin cambios conceptuales — sigue siendo la capa visual
- CSS variables para temas
- Sin lógica inline (no onclick="...", no style="..." computado)

---

## 2. Protocolo de comunicación Rust ↔ JS

### Transporte actual (Electron)
```
Renderer → ipcRenderer.invoke('bridge', cmd) → Main Process → stdin JSON → Rust
Rust → stdout JSON → Main Process → webContents.send('state', snapshot) → Renderer
```

### Transporte futuro (Tauri)
```
Renderer → invoke('audio_play', {player: 'a'}) → Rust directamente
Rust → emit('state', snapshot) → Renderer directamente
```

### Formato de comandos (JS → Rust)
```json
{"module": "audio",     "cmd": "play",          "player": "a", "requestId": "r1"}
{"module": "scheduler", "cmd": "advancePlaylist","tab": 0,      "requestId": "r2"}
{"module": "library",   "cmd": "search",        "query": "bachata", "requestId": "r3"}
{"module": "encoder",   "cmd": "startServer",   "serverId": "s1", "config": {...}}
{"module": "core",      "cmd": "getState",       "requestId": "r4"}
```

### Formato de eventos (Rust → JS)
```json
{"type": "state",    "module": "core",    "data": {/* snapshot completo */}}
{"type": "meters",   "module": "audio",   "data": {/* VU levels */}}
{"type": "progress", "module": "library", "data": {"scanned": 450, "total": 1200}}
{"type": "error",    "module": "encoder", "message": "Connection refused"}
{"type": "response", "requestId": "r3",   "data": {/* search results */}}
```

### Regla de diseño del protocolo
Cada par `module:cmd` mapea 1:1 a una función Rust. Cuando migremos a Tauri, cada función se decora con `#[tauri::command]` y el transporte cambia pero la lógica no.

---

## 3. Estructura Rust expandida

```
audio-engine-rust/src/
├── main.rs              ← Entry point: stdin loop, module router
├── protocol.rs          ← serde structs: Command, Event, todos los tipos
│
├── audio/               ← Motor Audio (código actual reorganizado)
│   ├── mod.rs           ← API pública del módulo
│   ├── engine.rs        ← Core del engine (extraído de main.rs actual)
│   ├── player.rs        ← Player state machine
│   ├── metering.rs      ← VU meters (actual metering.rs)
│   ├── streaming.rs     ← PCM ring buffer (actual streaming.rs)
│   └── dsp/             ← DSP chain (actual dsp/)
│
├── core/                ← Núcleo: state store + command dispatch
│   ├── mod.rs
│   ├── state.rs         ← State store central (playlists, config, cola)
│   └── commands.rs      ← Command validation + dispatch
│
├── scheduler/           ← Motor Scheduler
│   ├── mod.rs
│   ├── events.rs        ← Event timing + triggers
│   ├── playlist.rs      ← Playlist modes + advancement
│   ├── cues.rs          ← Cue/mix point resolution
│   └── pisador.rs       ← Pisador timing
│   (commercials.rs se diseña desde cero en fase posterior)
│
├── db/                  ← DB Gateway (rusqlite)
│   ├── mod.rs           ← Connection, migrations
│   ├── schema.rs        ← CREATE TABLE + migrations
│   ├── tracks.rs        ← CRUD tracks
│   ├── events.rs        ← CRUD events
│   ├── artists.rs       ← CRUD artist profiles
│   └── genres.rs        ← CRUD genre profiles
│
├── encoder/             ← Motor Encoder
│   ├── mod.rs
│   ├── manager.rs       ← Multi-server lifecycle
│   ├── ffmpeg.rs        ← FFmpeg process spawn + pipe
│   └── icecast.rs       ← Icecast/Shoutcast protocol
│
├── library/             ← Motor Biblioteca
│   ├── mod.rs
│   ├── indexer.rs       ← File scanning + indexing
│   ├── search.rs        ← Fuzzy search
│   ├── metadata.rs      ← ID3/lofty tag reading
│   └── profiles.rs      ← Artist/genre profile logic
│
└── plugins/             ← Plugins opcionales
    ├── mod.rs           ← Plugin trait + registry
    ├── weather.rs       ← Weather fetch + cache
    └── metadata_net.rs  ← Online metadata enrichment
```

### Dependencias Rust a añadir

| Crate | Propósito | Reemplaza |
|---|---|---|
| `serde` + `serde_json` | Serialización tipada | json.rs manual |
| `rusqlite` (bundled) | Base de datos | better-sqlite3 (Node) |
| `lofty` | Tags de audio | node-id3 (Node) |
| `nucleo-matcher` | Búsqueda fuzzy | Fuse.js (Node) |
| `reqwest` (blocking) | HTTP requests | fetch en Node |
| `walkdir` | Escaneo recursivo de dirs | fs.readdirSync (Node) |
| `chrono` | Fechas y scheduling | Date en JS |

Decisión: `reqwest` con feature `blocking` — sin tokio. El motor sigue siendo un loop síncrono. Las requests HTTP (weather, metadata) son infrecuentes y corren en threads dedicados con `std::thread::spawn`.

---

## 4. Hoja de ruta (fases)

### Fase 0 — Cimientos (2-3 sesiones)

**Objetivo:** Preparar el binario Rust para recibir módulos nuevos sin romper el audio.

1. Añadir `serde` + `serde_json` a Cargo.toml
2. Crear `protocol.rs` con los tipos Command/Event en serde
3. Migrar el parser de `json.rs` manual a serde (comando por comando)
4. Reorganizar el código actual de audio en submódulo `audio/`
5. Crear el router de módulos en `main.rs`: `match cmd.module { "audio" => ..., _ => ... }`
6. Crear el puente JS delgado en main.js (reenvío puro renderer ↔ Rust)
7. Verificar: la app funciona exactamente igual con el nuevo parser

**Resultado:** Binario Rust listo para crecer. JS bridge listo. Audio intacto.

### Fase 1 — Motor Encoder (2-3 sesiones)

**Objetivo:** Primera traducción real. Sacar el encoder de windows.js y ponerlo en Rust.

1. Crear `encoder/` en Rust: manager.rs, ffmpeg.rs, icecast.rs
2. Traducir la lógica de spawn FFmpeg con pipes stdin/stdout
3. Traducir handshake SHOUTcast nativo (socket)
4. Traducir multi-server lifecycle (start, stop, health monitoring)
5. Traducir metering de input (peak/RMS desde PCM)
6. Conectar al protocolo: `{module: "encoder", cmd: "startServer", ...}`
7. Borrar las 1,600 líneas de encoder en windows.js
8. Borrar las 8 variables de estado encoder del context JS
9. Verificar: streaming a Icecast/SHOUTcast funciona desde Rust

**Resultado:** Encoder 100% Rust. windows.js baja de 1,643 a ~400 líneas.

### Fase 2 — DB Gateway (3-4 sesiones)

**Objetivo:** Mover toda la persistencia a Rust. SQLite deja de existir para JS.

1. Añadir `rusqlite` (feature bundled) a Cargo.toml
2. Crear `db/schema.rs` — traducir las 846 líneas de database.js
3. Crear módulos CRUD: tracks, events, artists, genres
4. Migrar las queries de los 11 módulos IPC a funciones Rust
5. Conectar al protocolo (o los módulos las usan internamente)
6. Borrar database.js, quitar better-sqlite3 de package.json
7. Borrar todo `db.prepare()` de backend/ipc/*.js
8. Verificar: datos se leen/escriben correctamente desde Rust

**Resultado:** Un solo punto de acceso a datos. Escrituras serializadas. Sin contención multi-hilo.

### Fase 3 — Motor Scheduler (4-5 sesiones)

**Objetivo:** Extraer el cerebro de render.js. La pieza más grande y valiosa.

1. Crear `scheduler/events.rs` — traducir event filtering (día/hora/semana/validez)
2. Crear `scheduler/playlist.rs` — traducir modos (normal/random/infinite/manual)
3. Crear `scheduler/cues.rs` — traducir resolveTrackPlaybackWindow()
4. Crear `scheduler/pisador.rs` — traducir pisador_runtime.js (156 líneas limpias)
5. Crear `core/state.rs` — state store central (playlists, cola eventos, config activa)
6. Rust emite snapshots de estado al UI cada ~100ms (o on-change)
7. Borrar toda la lógica de scheduling de render.js (~12,000 líneas)
8. Borrar event execution logic del frontend
9. Verificar: eventos se disparan en hora, playlists avanzan, cues se resuelven

**Resultado:** render.js baja de 16,500 a ~2,500 líneas de puro renderizado. El Scheduler vive en Rust.

**Nota sobre comerciales:** El sistema de comerciales actual está poco trabajado. NO se traduce — se deja fuera del scheduler por ahora. Cuando todo lo demás esté terminado y estable, se rediseña el módulo de comerciales desde cero con una arquitectura limpia. Traducir código mal diseñado es trasladar problemas.

### Fase 4 — Motor Biblioteca (3-4 sesiones)

**Objetivo:** Consolidar los 6 puntos de acceso a biblioteca en un motor Rust.

1. Crear `library/indexer.rs` — traducir file_scan_worker + library_index service
2. Crear `library/search.rs` — nucleo-matcher reemplaza Fuse.js
3. Crear `library/metadata.rs` — lofty reemplaza node-id3
4. Crear `library/profiles.rs` — traducir artists.js (2,800 líneas) + genres.js (2,200 líneas)
5. Conectar al protocolo: search, scan, getArtistCard, etc.
6. Borrar library_worker.js, ipc/library.js, services/artists.js, services/genres.js, etc.
7. Borrar Fuse.js y node-id3 de package.json
8. Verificar: búsqueda funciona, metadata se lee, perfiles se gestionan

**Resultado:** 6 fuentes de biblioteca consolidadas en 1 motor Rust.

### Fase 5 — Plugins + Limpieza (2-3 sesiones)

**Objetivo:** Pluginizar extensiones y eliminar todo JS residual.

1. Crear trait Plugin en Rust (init, on_tick, destroy)
2. Traducir weather (reqwest blocking + cache)
3. Traducir metadata_net (reqwest + parsing)
4. Limpiar todo JS residual: borrar servicios, workers, utils no usados
5. main.js queda en ~300-500 líneas (solo window lifecycle + bridge)
6. render.js queda en ~2,000 líneas (solo DOM rendering)
7. Verificar: app completa funciona 100% desde Rust

**Resultado final:** JS = pintura + puente. Rust = todo lo demás. Listo para Tauri.

---

## 5. Metodología de trabajo

### Reglas de desarrollo

1. **Sin parches — solo soluciones de raíz.** Si algo no funciona, no se parchea, se investiga la causa real y se arregla desde la raíz. Los parches están prohibidos. Un parche es deuda técnica disfrazada de solución.
2. **Un módulo a la vez.** No empezar el siguiente hasta que el actual funcione y el JS viejo esté borrado.
3. **Traducir, no copiar.** Repensar cada pieza en Rust idiomático. Aprovechar el compilador para eliminar bugs.
4. **Sin shimming.** Cuando Rust asume una responsabilidad, el JS se borra. Una sola fuente de verdad.
5. **Tests automatizados obligatorios.** Cada módulo tiene `#[cfg(test)] mod tests` con casos reales. Los tests se corren antes de cada commit. Un módulo sin tests no se considera terminado. Esto incluye tests de integración que verifican la comunicación entre módulos.
6. **Verificación funcional.** Después de cada fase, la app se prueba manualmente end-to-end además de los tests automatizados.
7. **Commits atómicos.** Cada commit hace UNA cosa: "traducir event filtering a Rust", no "avances varios".
8. **No traducir código mal diseñado.** Si el código JS original está mal planteado (como comerciales), no se traduce — se rediseña desde cero cuando llegue su turno.

### Regla de decisión: ¿esto va en Rust o en JS?

```
¿Calcula algo?          → Rust
¿Decide algo?           → Rust
¿Valida datos?          → Rust
¿Lee/escribe datos?     → Rust
¿Mantiene estado?       → Rust
¿Habla con la red?      → Rust
¿Toca el filesystem?    → Rust
¿Es API de Electron?    → JS (diálogos, menús, ventanas)
¿Es renderizado DOM?    → JS renderer
¿Es estilo visual?      → CSS
```

### Convención de nombres en el protocolo

- Módulos: `audio`, `core`, `scheduler`, `library`, `encoder`, `db`, `plugin`
- Comandos: camelCase (`startServer`, `advancePlaylist`, `searchTracks`)
- Eventos: camelCase con prefijo tipo (`state`, `meters`, `progress`, `error`, `response`)

---

## 6. Verificación por fase

| Fase | Test crítico |
|---|---|
| 0 - Cimientos | App funciona igual con serde. Audio no regresiona. |
| 1 - Encoder | Streaming a Icecast funciona. Multi-server arranca/para. |
| 2 - DB | Datos se leen/escriben. Migración preserva datos existentes. |
| 3 - Scheduler | Eventos disparan en hora. Playlist avanza. Cues correctos. (Sin comerciales) |
| 4 - Biblioteca | Búsqueda devuelve resultados. Metadata se lee. Perfiles funcionan. |
| 5 - Limpieza | App completa funciona. Solo quedan ~3,000 líneas de JS total. |
| Futuro - Comerciales | Rediseño desde cero en Rust. No se traduce el JS actual. |

---

## 7. Decisiones técnicas consolidadas

| Decisión | Elegido | Alternativa descartada |
|---|---|---|
| Rama | `rust-core-migration` (larga, merge al final) | Integración continua a main |
| Serialización | serde_json | Parser JSON manual |
| Async runtime | Sin tokio — reqwest blocking en threads | tokio async runtime |
| Fallback JS | Sin shimming — JS se borra al traducir | Mantener JS como fallback |
| Documento | CONTRATO_ARQUITECTURA.md en el proyecto | Solo en memoria de Claude |
| Binario Rust | Single crate con módulos (mod) | Workspace multi-crate |
