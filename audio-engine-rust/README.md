# LF Audio Engine — Rust

Motor de audio nativo para LF Automatizador. Recibe comandos JSON por `stdin`,
reproduce/procesa audio con rodio/cpal (WASAPI), y emite estado por `stdout`
como newline-delimited JSON hacia el proceso Electron.

---

## Arquitectura de la cadena de señal

```
                 ┌─────────────────────────────────────────────────────────────────┐
                 │                      program_mixer                             │
                 │                                                                 │
  player-a ─┐   │   ┌─────────┐   ┌──────────┐   ┌─────┐   ┌──────────┐          │
  player-b ─┤   │   │ tee     │   │          │   │ tee │   │  master  │  ┌─────┐ │
  player-c ─┤───┼──▶│ Pre-FX  │──▶│   DSP    │──▶│Post │──▶│  fader   │─▶│meter│─┼──▶ SINK master
  jingle   ─┤   │   │         │   │EQ/Comp/  │   │ -FX │   └──────────┘  └─────┘ │
  cartwall ─┤   │   │  ┌──┐   │   │Limiter   │   │┌──┐ │                          │
  pl1..pl4 ─┤   │   │  │mo│   │   └──────────┘   ││mo│ │                          │
  aux1/aux2─┘   │   │  │ni│   │                   ││ni│ │                          │
                │   │  │to│   │                   ││to│ │                          │
                │   │  │r │   │                   ││r │ │                          │
                │   │  └──┘   │                   │└──┘ │                          │
                │   │  ┌──┐   │                   │┌──┐ │                          │
                │   │  │en│   │                   ││en│ │                          │
                │   │  │co│   │                   ││co│ │                          │
                │   │  │de│   │                   ││de│ │                          │
                │   │  │r │   │                   ││r │ │                          │
                │   │  └──┘   │                   │└──┘ │                          │
                │   └─────────┘                   └─────┘                          │
                └─────────────────────────────────────────────────────────────────┘

  monitor taps (Pre + Post FX)                encoder taps (Pre + Post FX)
       │                                            │
       ▼                                            ▼
  DualTapConsumer                             emit_encoder_pcm_chunk
  (conmuta pre/post)                          (s16le base64 → FFmpeg)
       │
  ┌──────────┐  ┌─────┐
  │ monitor  │─▶│meter│──▶ SINK monitor
  │  fader   │  └─────┘
  └──────────┘

  cue/preview ──────────────────────────────────────────────────▶ SINK directo
```

Los taps Pre-FX y Post-FX usan ring buffers SPSC (`rtrb`). El hilo de audio
nunca bloquea: si el ring está lleno, el sample se descarta.

---

## Glosario de módulos

### `main.rs` — Entry point y dispatch loop

Punto de entrada del binario. Lee comandos JSON de stdin línea por línea,
los deserializa con `protocol::IncomingCommand`, y despacha según
`ic.effective_module()` + `ic.cmd`. Contiene el tick loop (~100ms) que
emite `emit_status`, procesa fades, repeats, locuciones y PCM del encoder.

**Dependencias:** todos los módulos.

---

### `protocol.rs` — Protocolo IPC (stdin → struct)

Deserialización de comandos JSON entrantes. `IncomingCommand` es una struct
plana con 49 campos `Option<T>` que cubre todos los comandos posibles del
frontend. Se deserializa con `serde_json`; los campos ausentes quedan `None`.

| Función | Descripción |
|---|---|
| `IncomingCommand` | Struct plana: `cmd`, `player`, `path`, `gain`, `module`, ... |
| `effective_module()` | Devuelve el módulo destino (`"audio"` por defecto) |
| `now_ms()` | Timestamp epoch en milisegundos |
| `escape_json(value)` | Escapa caracteres especiales para JSON manual |
| `request_id_field(id)` | Genera `"requestId":"xxx",` o vacío si no hay id |
| `emit_error(msg, id)` | Emite `{"type":"error",...}` por stdout |

---

### `state.rs` — Estado global del engine

Todas las structs que componen el estado mutable. Un solo `EngineState` existe
durante toda la vida del proceso; los módulos lo reciben como `&mut EngineState`.

| Struct | Descripción |
|---|---|
| `EngineState` | Estado global: players, outputs, routes, playlist, encoder, DSP, mixer |
| `PlayerState` | Estado persistente de un player (path, posición, gain, fade, repeat) |
| `RuntimePlayer` | Player en runtime: `PlayerState` + handle rodio + meter |
| `OutputRuntime` | Salida de audio abierta: nombre + `MixerDeviceSink` |
| `RouteState` | Asociación bus → dispositivo de salida |
| `FxState` | Snapshot de EQ/compresor/limiter recibido del frontend |
| `EncoderState` | Estado del encoder de streaming (FFmpeg, buses, PCM bridge) |
| `NowPlayingState` | Metadatos del track en emisión |
| `TransportState` | Estado de transporte (posición, duración, mezcla) |
| `PlaylistRowState` | Fila del snapshot de playlist |
| `PlaylistModeState` | Modos: repeat, remove-played, loop + protecciones |
| `PlaylistPlaybackContext` | Fila activa, encolada, tab activo |
| `PendingResumeSpec` | Datos para reanudar un player tras reset del mixer |
| `is_program_bus(id)` | `true` si el bus pasa por el program_mixer |

---

### `playback.rs` — Carga y decodificación de audio

Dos caminos según tamaño del archivo:

| Camino | Condición | Mecanismo |
|---|---|---|
| **RAM** | ≤ 200 MB | Lee todo a `Vec<u8>`, decodifica con rodio. Seekable. |
| **Streaming** | > 200 MB | Hilo decodificador → ring buffer 10s → `StreamedFileSource`. No seekable. |

| Función/Tipo | Descripción |
|---|---|
| `PlaybackSource` | Enum unificado: `Ram(Decoder)` o `Streamed(StreamedFileSource)` |
| `StreamedFileSource` | Source que consume un rtrb ring llenado por un hilo |
| `open_playback_decoder(path)` | Decide RAM vs streaming según tamaño |
| `spawn_streamed_file_source(path, len)` | Lanza el hilo decodificador + ring |
| `load_audio_player(state, ...)` | Decodifica → metering → conecta al mixer → registra en state |
| `load_audio_player_sequence(state, ...)` | Carga múltiples archivos para gapless |

---

### `player.rs` — Ciclo de vida de players

Opera sobre `RuntimePlayer` ya existentes en `EngineState`.

| Función | Descripción |
|---|---|
| `release_runtime_player(rt)` | Detiene audio, resetea fade/posición/meter |
| `play_existing_or_rebuild_player(state, id)` | Reanuda o reconstruye desde el path guardado |
| `process_repeat_players(state)` | Detecta repeat activo → reinicia desde `repeat_start_ms` |
| `process_player_fades(state)` | Curva smoothstep (3t²−2t³), auto-stop si `fade_stop_after` |

---

### `routing.rs` — Enrutamiento de buses y program_mixer

Construye y gestiona la cadena de señal del program_mixer (ver diagrama arriba).

| Función | Descripción |
|---|---|
| `route_bus(state, bus, output)` | Asigna bus → output, reconstruye cadena si cambió |
| `ensure_program_mixer(state, output)` | Construye mixer → tee Pre → DSP → tee Post → fader → meter → sink |
| `ensure_monitor_chain(state, output)` | Conecta DualTapConsumer al output de monitor |
| `reset_program_mixer(state)` | Desmonta todo, guarda pending_resume |
| `resume_pending_players(state)` | Recarga y reanuda players tras un reset |
| `cleanup_unused_outputs(state)` | Cierra outputs sin rutas asignadas |

---

### `emit.rs` — Emisión de JSON por stdout

Todas las funciones que envían datos al proceso Electron.

| Función | Descripción |
|---|---|
| `emit_status(state, request_id)` | Snapshot completo: players, meters, buses, encoder (~100ms) |
| `emit_encoder_pcm_chunk(state)` | Chunk PCM s16le en base64 para FFmpeg |
| `default_bus_for_player(id)` | Bus por defecto según nombre del player |
| `is_diagnostic_player(id)` | `true` para preview/editor (no cuentan como audio activo) |
| `has_active_audio(state)` | `true` si algún player tiene audio cargado |
| `resolve_output_for_bus(state, bus, fallback)` | Busca ruta configurada o devuelve fallback |

---

### `output.rs` — Dispositivos de salida de audio

Gestión de dispositivos WASAPI via cpal/rodio.

| Función | Descripción |
|---|---|
| `emit_devices(request_id)` | Enumera salidas y las emite como JSON |
| `find_output_device(id)` | Busca por id nativo, índice (`output:N`) o nombre |
| `ensure_output(state, id)` | Abre el dispositivo si no está abierto, lo registra en state |

---

### `metering.rs` — Medición de picos en tiempo real

Lock-free: el hilo de audio escribe con `Relaxed`, el dispatch lee con `Relaxed`.

| Tipo | Descripción |
|---|---|
| `PlayerMeter` | Par de `AtomicU32` (f32 en bits) para picos L/R |
| `MeteredSource<S>` | Adaptador Source que mide peak cada 1024 samples |
| `PcmRingSource` | Source desde rtrb ring buffer (streams externos) |

---

### `peaks.rs` — Análisis de waveform y duración

Calcula picos para waveforms del frontend y cachea duraciones en disco.

| Función | Descripción |
|---|---|
| `compute_waveform_peaks(path, bins, cache_dir)` | Decodifica → bins min/max + silencios + caché |
| `cached_audio_duration_ms(path, cache_dir)` | Duración en ms con caché `.dur` en disco |
| `measure_audio_duration_full(path)` | Decodificación completa (fallback sin metadata) |
| `fnv_hash(s)` | Hash FNV-1a 64-bit para nombres de caché |
| `floats_to_json(v)` | Serializa `&[f32]` como array JSON |

---

### `playlist.rs` — Lógica de playlist y auto-advance

Gestiona el avance automático entre pistas, repeat con protección anti-olvido,
y remove-played con protección de mínimo restante.

| Función | Descripción |
|---|---|
| `update_now_playing(state, ic)` | Actualiza metadatos "ahora suena" |
| `update_transport(state, ic)` | Actualiza estado de transporte |
| `update_playlist_snapshot(state, ic)` | Reemplaza snapshot de filas |
| `update_playlist_mode(state, ic)` | Actualiza modos (repeat, loop, remove-played) |
| `update_playlist_playback_context(state, ic)` | Sincroniza fila activa/encolada |
| `process_playlist_finished(state, player, force)` | Player terminó → repeat o auto-advance |
| `process_playlist_manual_next(state, player)` | Siguiente manual → desactiva repeat si aplica |
| `emit_playlist_mode_changed(state, reason)` | Notifica cambio de modos al frontend |
| `update_encoder(state, ic)` | Actualiza estado del encoder de streaming |

---

### `locution.rs` — Locución automática de hora

Reproduce archivos de audio que anuncian la hora actual.

Convención de archivos en la carpeta configurada:
- `HRSxx_O.*` → hora en punto ("son las XX en punto")
- `HRSxx.*` → hora (sin "en punto")
- `MINxx.*` → minutos

Si es `:00` usa el archivo `_O`. Si no, concatena hora + minutos en gapless.

| Función | Descripción |
|---|---|
| `local_hour_minute()` | Hora y minuto locales (plataforma: Windows/Unix) |
| `start_time_locution(state, ...)` | Resuelve archivos, carga secuencia, registra player |
| `finish_time_locution_if_drained(state)` | Detecta fin → emite `timeLocutionEnded` |

---

### `dsp/` — Cadena DSP del program_mixer (4 archivos, 824 líneas)

Procesamiento de audio en tiempo real. Todos los parámetros se controlan via
`DspParams` (AtomicU32 con f32-in-bits). Cero locks en el hot path.

| Archivo | Contenido |
|---|---|
| `mod.rs` | `DspParams` (parámetros atómicos compartidos), `EqBandAtomic`, `BusGraph` |
| `dynamic.rs` | `DynamicDspSource`: EQ 8 bandas biquad + compresor + limiter. Orden dinámico via atómico `fx_order`. |
| `fader.rs` | `FaderSource`: ganancia atómica para master/monitor. |
| `tee.rs` | `MultiTeeSource` (bifurca señal a N rings) + `DualTapConsumerSource` (lee de 2 rings, conmuta pre/post FX). |

---

## Flujo de un comando típico

```
1. Node (main.js) escribe por stdin:
   {"cmd":"load","player":"player-a","path":"C:\\Audio\\tema.mp3","gain":1.0}

2. main.rs lee la línea, deserializa con serde_json → IncomingCommand

3. Dispatch: match ic.cmd.as_str() → "load"
   → playback::load_audio_player(state, "player-a", path, gain, ...)

4. playback.rs:
   a. output::ensure_output(state, output_id)     — abre WASAPI si necesario
   b. routing::ensure_program_mixer(state, ...)    — construye la cadena si no existe
   c. open_playback_decoder(path)                  — RAM o streaming según tamaño
   d. MeteredSource::new(decoder, meter)           — envuelve con metering
   e. player.append(metered)                       — conecta al mixer de rodio
   f. Registra en state.players["player-a"]

5. Tick loop (~100ms):
   → emit::emit_status(state, "")
   → stdout: {"type":"status","players":[{"id":"player-a","status":"loaded",...}],...}

6. Node lee stdout, parsea JSON, envía al renderer via IPC
```

---

## Compilación

```powershell
cd audio-engine-rust
cargo build --release
```

El binario final va a `../bin/`. Limpiar artefactos con `cargo clean` después
de compilar — `target/` puede crecer cientos de MB.

## Tests

```powershell
cargo test
```

15 tests: 11 de protocolo (parsing de comandos) + 4 de playback (precarga RAM,
decodificación, streaming, seek).
