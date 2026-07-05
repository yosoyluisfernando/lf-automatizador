mod dsp;
mod emit;
mod encoder;
mod input;
mod locution;
mod metering;
mod output;
mod peaks;
mod playback;
mod player;
mod playlist;
mod protocol;
mod recorder;
mod routing;
mod state;

use std::io::{self, BufRead, Write};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use emit::{
    default_bus_for_player, emit_encoder_pcm_chunk, emit_status, is_diagnostic_player,
    resolve_output_for_bus, take_encoder_pcm_chunk,
};
use encoder::{
    feed_input_encoder_routes, handle_encoder_command, update_encoder_status,
    write_master_pcm_to_encoder_servers,
};
use input::{feed_input_meter_routes, feed_ptt_route, handle_input_command, process_ptt_duck};
use locution::{finish_time_locution_if_drained, start_time_locution};
use output::emit_devices;
use peaks::{cached_audio_duration_ms, compute_waveform_peaks, floats_to_json};
use playback::{load_audio_player, load_audio_player_sequence, start_pcm_stream_player};
use player::{
    play_existing_or_rebuild_player, process_player_fades, process_repeat_players,
    release_runtime_player,
};
use playlist::*;
use protocol::{emit_error, escape_json, now_ms, request_id_field};
use recorder::{feed_recorder_routes, handle_recorder_command};
use routing::route_bus;
use state::*;

enum EngineEvent {
    StdinLine(String),
    StdinError,
    StdinClosed,
    PushTick,
}

/// Intervalo del bucle push de telemetría. 20 ms = 50 Hz. Suficiente para
/// VU meters ultra fluidos a 50 FPS y posición de cabezal precisa, sin lag.
const PUSH_TICK_MS: u64 = 20;

/// Sube la clase de prioridad del PROCESO del motor (complemento del MMCSS del
/// hilo de audio, que activa cpal vía el feature `audio_thread_priority`).
/// Con el sistema cargado (antivirus, Windows Update), el scheduler atiende
/// antes al motor que a los procesos normales. No requiere administrador en
/// ninguna edición de Windows (10/11 Home/Pro/LTSC); en Linux la prioridad
/// negativa puede no estar permitida y se ignora en silencio.
fn raise_process_priority() {
    #[cfg(windows)]
    unsafe {
        // ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000 (kernel32, linkeado por defecto).
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut core::ffi::c_void;
            fn SetPriorityClass(handle: *mut core::ffi::c_void, class: u32) -> i32;
        }
        const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;
        if SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) == 0 {
            eprintln!(
                "[priority] No se pudo subir la prioridad del proceso (se continúa en Normal)."
            );
        }
    }
    #[cfg(unix)]
    unsafe {
        // nice -5 para el proceso; sin privilegios falla con EACCES y se ignora.
        let _ = libc::setpriority(libc::PRIO_PROCESS, 0, -5);
    }
}

fn main() {
    raise_process_priority();
    let mut state = EngineState::default();
    println!(
        "{{\"type\":\"ready\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"updatedAt\":{}}}",
        now_ms()
    );
    let _ = io::stdout().flush();

    let (tx, rx) = mpsc::channel::<EngineEvent>();

    // Hilo lector de stdin: bloquea en `lines()` y reenvía cada línea al
    // canal. Cuando stdin se cierra (parent process termina) emite StdinClosed
    // y muere limpio.
    let tx_stdin = tx.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx_stdin.send(EngineEvent::StdinLine(l)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx_stdin.send(EngineEvent::StdinError);
                }
            }
        }
        let _ = tx_stdin.send(EngineEvent::StdinClosed);
    });

    // Hilo timer push: cada PUSH_TICK_MS dispara un PushTick que el loop
    // principal traduce en `emit_status(state, "")`. Sin pedido, sin
    // requestId — el frontend se suscribe vía `audio-engine-rust-event`.
    let tx_tick = tx.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(PUSH_TICK_MS));
        if tx_tick.send(EngineEvent::PushTick).is_err() {
            break;
        }
    });

    'main_loop: loop {
        let event = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => break,
        };

        let line = match event {
            EngineEvent::StdinLine(l) => l,
            EngineEvent::PushTick => {
                process_player_fades(&mut state);
                process_ptt_duck(&mut state);
                process_repeat_players(&mut state);
                finish_time_locution_if_drained(&mut state);
                state.encoder_servers.poll_all_processes();
                feed_input_encoder_routes(&mut state);
                feed_input_meter_routes(&mut state);
                feed_ptt_route(&mut state);
                feed_recorder_routes(&mut state);
                // Push automático de status. request_id vacío → el campo no se
                // emite y el Node probe lo trata como mensaje espontáneo.
                emit_status(&state, "");
                // FASE D · sub-paso 8.2: si el encoder está activo, drenar
                // los samples acumulados en el tap y emitir un chunk PCM
                // base64 por stdout. El probe Node lo recibe en handleLine
                // (type === "pcmChunk") y lo pipea al stdin de FFmpeg.
                if state.dsp_params.encoder_tap_active.load(Ordering::Relaxed) {
                    if let Some(chunk) = take_encoder_pcm_chunk(&mut state) {
                        let _ = write_master_pcm_to_encoder_servers(&mut state, &chunk.bytes);
                        emit_encoder_pcm_chunk(&chunk);
                    }
                }
                continue 'main_loop;
            }
            EngineEvent::StdinError => {
                emit_error("No se pudo leer comando.", "");
                continue 'main_loop;
            }
            EngineEvent::StdinClosed => break 'main_loop,
        };

        let ic = match protocol::IncomingCommand::parse(&line) {
            Ok(c) => c,
            Err(e) => {
                emit_error(&e, "");
                emit_status(&state, "");
                continue 'main_loop;
            }
        };
        let request_id = ic.request_id.clone();
        let player_id = ic.player.clone();

        match ic.effective_module() {
            "audio" | "" => match ic.cmd.as_str() {
                "status" => {}
                "devices" => emit_devices(&request_id),
                "load" => {
                    let runtime = state.players.entry(player_id.clone()).or_default();
                    runtime.state.path = ic.path.clone().unwrap_or_default();
                    runtime.state.status = "loaded".to_string();
                    runtime.state.position_ms = 0;
                }
                "route" => {
                    let bus_id = ic.bus.clone().unwrap_or_else(|| player_id.clone());
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    // Para el bus encoder almacenamos el modo de fuente (pre/post FX)
                    // pero NO abrimos stream cpal (el encoder vive en el lado JS).
                    if bus_id == "encoder" {
                        // FIX BUG ENCODER PRE-FX: defensiva contra `sourceMode: ""`.
                        // El adapter JS envía `sourceMode || ''` cuando el campo no
                        // está presente. Antes interpretábamos string vacío como
                        // "postFx" (porque `"" == "preFx"` es false) y SIEMPRE
                        // bajábamos a postFx en cada route reemitido — eso
                        // sobreescribía el valor recién seleccionado por el operador.
                        // Ahora si llega vacío o desconocido, mantenemos el valor
                        // actual de `state.encoder_source_mode`.
                        let source_mode_raw = ic.source_mode.clone().unwrap_or_default();
                        let source_mode = match source_mode_raw.as_str() {
                            "preFx" => "preFx".to_string(),
                            "postFx" => "postFx".to_string(),
                            _ => state.encoder_source_mode.clone(),
                        };
                        let is_pre = source_mode == "preFx";
                        state.encoder_source_mode = source_mode;
                        // FASE D · sub-paso 11.3: propagar al atómico que lee
                        // emit_encoder_pcm_chunk para elegir cuál ring drenar.
                        state
                            .dsp_params
                            .encoder_tap_mode
                            .store(if is_pre { 0 } else { 1 }, Ordering::Relaxed);
                        // Registramos la ruta virtual (sin abrir output cpal).
                        state.routes.insert(
                            "encoder".to_string(),
                            RouteState {
                                output_device_id: output_id.clone(),
                                output_device_name: "encoder (virtual)".to_string(),
                            },
                        );
                    } else if bus_id == "monitor" {
                        // FASE D · sub-paso 11.3: el bus monitor también acepta
                        // sourceMode preFx|postFx para alternar su tap.
                        if let Some(ref source_mode) = ic.source_mode {
                            let is_pre = source_mode == "preFx";
                            state
                                .dsp_params
                                .monitor_tap_mode
                                .store(if is_pre { 0 } else { 1 }, Ordering::Relaxed);
                        }
                        if let Err(err) = route_bus(&mut state, &bus_id, &output_id) {
                            emit_error(&err, &request_id);
                        }
                    } else if let Err(err) = route_bus(&mut state, &bus_id, &output_id) {
                        emit_error(&err, &request_id);
                    }
                }
                // ── Fader master: punto único de aplicación (FaderSource) ──────
                // FASE D · sub-paso 7.5: el valor viaja al atómico de DspParams
                // y el FaderSource entre el program_mixer y el sink PGM lo lee
                // sample-by-sample con Ordering::Relaxed. Sin locks, sin per-player.
                "masterGain" => {
                    let gain = ic.gain.unwrap_or(state.master_gain).clamp(0.0, 2.0);
                    state.master_gain = gain; // cache legacy para `status`
                    state
                        .dsp_params
                        .master_gain_bits
                        .store(gain.to_bits(), Ordering::Relaxed);
                }
                // ── Fader monitor: atómico DspParams, listo para el MonitorChain ──
                // del sub-paso 8.1. Hoy se almacena en el atómico (todavía sin
                // sink monitor dedicado) y en el campo legacy.
                "monitorGain" => {
                    let gain = ic.gain.unwrap_or(state.monitor_gain).clamp(0.0, 2.0);
                    state.monitor_gain = gain;
                    state
                        .dsp_params
                        .monitor_gain_bits
                        .store(gain.to_bits(), Ordering::Relaxed);
                }
                // ── FASE D · sub-paso 8.2: activar/desactivar el tap del encoder.
                // Cuando `enable=true`, cada PushTick (cada 20 ms) drena el ring
                // del encoder_tap y emite un mensaje `pcmChunk` por stdout. El
                // probe Node lo recibe y lo pipea al stdin de FFmpeg.
                "encoderTap" => {
                    let enable = ic.enable.unwrap_or(false);
                    state
                        .dsp_params
                        .encoder_tap_active
                        .store(enable, Ordering::Relaxed);
                    // Drenamos AMBOS rings al cambiar de estado para que una nueva
                    // sesión nunca reciba audio acumulado de una sesión anterior.
                    if let Some(c) = state.encoder_tap_pre_consumer.as_mut() {
                        while c.pop().is_ok() {}
                    }
                    if let Some(c) = state.encoder_tap_post_consumer.as_mut() {
                        while c.pop().is_ok() {}
                    }
                    if enable {
                        state.encoder_tap_pre_drops.store(0, Ordering::Relaxed);
                        state.encoder_tap_post_drops.store(0, Ordering::Relaxed);
                    }
                }
                // ── Bus FX: parámetros DSP del bus de programa ──────────────────
                // FASE D · sub-pasos 9.1-11.2 + 11.1-bis: además de los campos
                // legacy (compatibilidad con `status`), propagamos cada valor al
                // atómico correspondiente de DspParams. Los Source adapters leen
                // sample-por-sample con Ordering::Relaxed (sin locks).
                //
                // Reglas de negocio aplicadas:
                //
                // 1) AGC ⟷ Limiter MUTUAMENTE EXCLUSIVOS. Ambos son compresores —
                //    no tiene sentido encenderlos simultáneamente. El frontend ya
                //    aplica `enforceExclusiveDynamics` en cada toggle; esta es la
                //    salvaguarda en el motor: si llegan ambos en true, dejamos
                //    sólo el Limiter activo (es la última barrera de protección
                //    del sink físico).
                //
                // 2) Las bandas EQ vienen como `bands: [g0, g1, ..., g7]` (8 gains
                //    en dB). El parser `json_get_f32_array` los extrae y se
                //    escriben en `dsp_params.eq_bands[i].gain_db_bits`. El
                //    `EqChainSource` recalcula sus coeficientes biquad cada
                //    ~12 ms — el operador percibe el cambio "en tiempo real".
                //
                // 3) Los flags eq/comp/limiter/mono se traducen a wet_target ∈
                //    {0.0, 1.0}. Los adapters interpolan internamente con rampa
                //    de ~5.8 ms para evitar clic (regla 2: DSP siempre encendido,
                //    el switch UI sólo cambia el wet/dry).
                "fx" => {
                    state.fx.eq = ic.eq.unwrap_or(state.fx.eq);
                    let comp_requested = ic.comp.unwrap_or(state.fx.comp);
                    let lim_requested = ic.limiter.unwrap_or(state.fx.limiter);
                    // Regla 1: AGC ⟷ Limiter exclusión mutua. Si ambos en true,
                    // gana limiter (última línea de defensa del sink físico).
                    let (comp_final, lim_final) = if comp_requested && lim_requested {
                        (false, true)
                    } else {
                        (comp_requested, lim_requested)
                    };
                    state.fx.comp = comp_final;
                    state.fx.limiter = lim_final;
                    state.fx.preamp_db = ic.preamp_db.unwrap_or(state.fx.preamp_db);
                    state.fx.pan = ic.pan.unwrap_or(state.fx.pan);
                    state.fx.mono = ic.mono.unwrap_or(state.fx.mono);
                    // Propagación a los atómicos del DSP en vivo.
                    state
                        .dsp_params
                        .preamp_db_bits
                        .store(state.fx.preamp_db.to_bits(), Ordering::Relaxed);
                    state
                        .dsp_params
                        .pan_bits
                        .store(state.fx.pan.to_bits(), Ordering::Relaxed);
                    let bool_to_wet =
                        |b: bool| -> u32 { (if b { 1.0_f32 } else { 0.0_f32 }).to_bits() };
                    state
                        .dsp_params
                        .mono_wet_target_bits
                        .store(bool_to_wet(state.fx.mono), Ordering::Relaxed);
                    state
                        .dsp_params
                        .eq_wet_target_bits
                        .store(bool_to_wet(state.fx.eq), Ordering::Relaxed);
                    state
                        .dsp_params
                        .comp_wet_target_bits
                        .store(bool_to_wet(state.fx.comp), Ordering::Relaxed);
                    state
                        .dsp_params
                        .limiter_wet_target_bits
                        .store(bool_to_wet(state.fx.limiter), Ordering::Relaxed);
                    // Regla 2: aplicar las 8 bandas EQ (gain en dB por banda).
                    // Frecuencia y Q quedan en los defaults broadcast (63/125/...).
                    if let Some(ref bands) = ic.bands {
                        for (i, gain_db) in bands.iter().enumerate().take(8) {
                            state.dsp_params.eq_bands[i]
                                .gain_db_bits
                                .store(gain_db.to_bits(), Ordering::Relaxed);
                        }
                    }
                    // FASE D · sub-paso 11.4: orden dinámico de bloques DSP.
                    // El frontend envía `order: ["<a>","<b>","<c>"]` con los IDs
                    // de cada bloque en orden de procesamiento (entrada→salida).
                    // Si vienen menos de 3 o llegan IDs desconocidos, completamos
                    // con la cascada por defecto EQ→Comp→Limiter para garantizar
                    // que los 3 bloques siempre estén presentes una sola vez.
                    if let Some(ref order_strs) = ic.order {
                        let mut packed: u32 = 0;
                        let mut used = [false; 3]; // 0=eq, 1=comp, 2=lim
                        let mut slot = 0_u32;
                        for id in order_strs.iter() {
                            if slot >= 3 {
                                break;
                            }
                            let idx_opt: Option<u32> = match id.as_str() {
                                "eq" => Some(0),
                                "comp" => Some(1),
                                "limiter" => Some(2),
                                _ => None,
                            };
                            if let Some(idx) = idx_opt {
                                let i = idx as usize;
                                if !used[i] {
                                    used[i] = true;
                                    packed |= idx << (slot * 2);
                                    slot += 1;
                                }
                            }
                        }
                        // Completa los bloques faltantes en su orden natural para
                        // que la cadena nunca pierda un módulo (paranoia anti-bug).
                        for i in 0..3_u32 {
                            if slot >= 3 {
                                break;
                            }
                            if !used[i as usize] {
                                used[i as usize] = true;
                                packed |= i << (slot * 2);
                                slot += 1;
                            }
                        }
                        state.dsp_params.fx_order.store(packed, Ordering::Relaxed);
                    }
                }
                "nowPlaying" => update_now_playing(&mut state, &ic),
                "transport" => update_transport(&mut state, &ic),
                "playlistSnapshot" => update_playlist_snapshot(&mut state, &ic),
                "playlistMode" => update_playlist_mode(&mut state, &ic),
                "playlistPlaybackContext" => update_playlist_playback_context(&mut state, &ic),
                "playlistFinished" => {
                    update_playlist_playback_context(&mut state, &ic);
                    let current_player = state.playlist_context.current_player.clone();
                    process_playlist_finished(&mut state, &current_player, true);
                }
                "playlistManualNext" => {
                    update_playlist_playback_context(&mut state, &ic);
                    let current_player = state.playlist_context.current_player.clone();
                    process_playlist_manual_next(&mut state, &current_player);
                }
                "encoder" => update_encoder_status(&mut state, &ic),
                "loadAudio" => {
                    let current_gain = state
                        .players
                        .get(&player_id)
                        .map(|runtime| runtime.state.gain)
                        .unwrap_or(1.0);
                    let path = ic.path.clone().unwrap_or_default();
                    let gain = ic.gain.unwrap_or(current_gain);
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let bus_id = ic
                        .bus
                        .clone()
                        .unwrap_or_else(|| default_bus_for_player(&player_id).to_string());
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    let autoplay = ic.autoplay.unwrap_or(false);
                    let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                    if let Err(err) = load_audio_player(
                        &mut state,
                        &player_id,
                        &path,
                        gain,
                        !autoplay,
                        &resolved_output_id,
                        &bus_id,
                        &cache_dir,
                    ) {
                        emit_error(&err, &request_id);
                    }
                }
                // Warm-up del caché de duración de LOCUCIONES (hora/clima). Mide y
                // persiste el `.dur` de cada archivo SIN reproducir, en un hilo
                // aparte para NO bloquear el loop de comandos: la emisión en vivo
                // nunca debe esperar a que se precalienten locuciones. Idempotente
                // (los .dur ya presentes son lectura instantánea), así que correrlo
                // en cada arranque es barato y cubre a usuarios nuevos y existentes.
                "cacheDuration" => {
                    let paths = ic.paths.clone().unwrap_or_default();
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    if !cache_dir.trim().is_empty() && !paths.is_empty() {
                        std::thread::spawn(move || {
                            for p in &paths {
                                let _ = cached_audio_duration_ms(p, &cache_dir);
                            }
                        });
                    }
                }
                // Reproducción gapless de una secuencia de archivos en un player
                // normal (cartwall: locución de hora HORAS+MINUTOS sin micro-pausa).
                // No toca la maquinaria time_locution; el fin se detecta por 'ended'.
                "cartwallSequence" => {
                    let paths = ic.paths.clone().unwrap_or_default();
                    let gain = ic.gain.unwrap_or(1.0);
                    let bus_id = ic.bus.clone().unwrap_or_else(|| "cartwall".to_string());
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                    if paths.is_empty() {
                        emit_error("cartwallSequence: 'paths' vacio.", &request_id);
                    } else if let Err(err) = load_audio_player_sequence(
                        &mut state,
                        &player_id,
                        &paths,
                        gain,
                        false,
                        &resolved_output_id,
                        &bus_id,
                        &cache_dir,
                    ) {
                        emit_error(&err, &request_id);
                    }
                }
                // Precarga pausada de una secuencia gapless. Los pisadores usan
                // autoplay=false para abrir y decodificar antes del disparo exacto.
                "loadSequence" => {
                    let paths = ic.paths.clone().unwrap_or_default();
                    let gain = ic.gain.unwrap_or(1.0);
                    let bus_id = ic.bus.clone().unwrap_or_else(|| "jingle".to_string());
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    let autoplay = ic.autoplay.unwrap_or(false);
                    let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                    if paths.is_empty() {
                        emit_error("loadSequence: 'paths' vacio.", &request_id);
                    } else if let Err(err) = load_audio_player_sequence(
                        &mut state,
                        &player_id,
                        &paths,
                        gain,
                        !autoplay,
                        &resolved_output_id,
                        &bus_id,
                        &cache_dir,
                    ) {
                        emit_error(&err, &request_id);
                    }
                }
                "labPlay" => {
                    let current = state
                        .players
                        .get(&player_id)
                        .map(|runtime| (runtime.state.path.clone(), runtime.state.gain))
                        .unwrap_or_else(|| (String::new(), 1.0));
                    let path = ic.path.clone().unwrap_or(current.0);
                    let gain = ic.gain.unwrap_or(current.1);
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let bus_id = ic
                        .bus
                        .clone()
                        .unwrap_or_else(|| default_bus_for_player(&player_id).to_string());
                    let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                    if let Err(err) = load_audio_player(
                        &mut state,
                        &player_id,
                        &path,
                        gain,
                        false,
                        &resolved_output_id,
                        &bus_id,
                        "",
                    ) {
                        emit_error(&err, &request_id);
                    }
                }
                "play" => {
                    if let Err(err) = play_existing_or_rebuild_player(&mut state, &player_id) {
                        emit_error(&err, &request_id);
                    }
                }
                "pause" => {
                    let runtime = state.players.entry(player_id.clone()).or_default();
                    runtime.state.status = "paused".to_string();
                    if let Some(player) = &runtime.player {
                        player.pause();
                    }
                }
                "repeat" => {
                    let runtime = state.players.entry(player_id.clone()).or_default();
                    let enabled = ic.enabled.unwrap_or(false);
                    runtime.state.repeat_active = enabled;
                    runtime.state.repeat_start_ms = ic
                        .start_ms
                        .or(ic.position_ms)
                        .unwrap_or(runtime.state.repeat_start_ms);
                    runtime.state.repeat_count = 0;
                }
                "stop" => {
                    if let Some(runtime) = state.players.get_mut(&player_id) {
                        runtime.state.status = "stopped".to_string();
                        release_runtime_player(runtime);
                    }
                    if is_diagnostic_player(&player_id) {
                        state.players.remove(&player_id);
                    }
                    // Si paran el player que actualmente sostiene la locución
                    // horaria, invalidamos la generación y limpiamos el
                    // reloj acumulativo de la pista virtual (HRS+MIN unificados).
                    if !state.time_locution_player.is_empty()
                        && player_id == state.time_locution_player
                    {
                        state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
                        state.time_locution_player.clear();
                        state.time_locution_started_at = None;
                        state.time_locution_total_ms = 0;
                    }
                }
                "timeLocution" => {
                    // Locución de hora 100% gestionada por el motor: resuelve archivos
                    // según el reloj local, encola en un único Player con `append`
                    // (rodio toca secuencial sin gap). El tick principal emite
                    // `timeLocutionEnded` cuando el Player realmente queda vacío.
                    let folder = ic.folder.clone().unwrap_or_default();
                    let gain = ic.gain.unwrap_or(1.0);
                    let bus_id = ic.bus.clone().unwrap_or_else(|| "jingle".to_string());
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    if folder.is_empty() {
                        emit_error("timeLocution: falta el campo 'folder'.", &request_id);
                    } else {
                        // player_id viene del JSON ("player"). Default: "time-locucion"
                        // (uso histórico del bus jingle como pisador). Cuando se lanza
                        // desde la playlist el renderer pasa "player-a"/"player-b" para
                        // que la locución se trate como una pista normal del programa.
                        let time_player_id = if player_id == "probe" {
                            "time-locucion".to_string()
                        } else {
                            player_id.clone()
                        };
                        match start_time_locution(
                            &mut state,
                            &time_player_id,
                            &folder,
                            gain,
                            &output_id,
                            &bus_id,
                            &request_id,
                            &cache_dir,
                        ) {
                            Ok((duration_ms, files)) => {
                                let files_json = files
                                    .iter()
                                    .map(|f| format!("\"{}\"", escape_json(f)))
                                    .collect::<Vec<_>>()
                                    .join(",");
                                println!(
                                "{{{}\"type\":\"timeLocutionStarted\",\"engine\":\"rustAudio\",\"player\":\"{}\",\"bus\":\"{}\",\"durationMs\":{},\"segments\":{},\"files\":[{}],\"updatedAt\":{}}}",
                                request_id_field(&request_id),
                                escape_json(&time_player_id),
                                escape_json(&bus_id),
                                duration_ms,
                                files.len(),
                                files_json,
                                now_ms()
                            );
                                let _ = io::stdout().flush();
                                continue;
                            }
                            Err(err) => emit_error(&err, &request_id),
                        }
                    }
                }
                "seek" => {
                    if let Some(runtime) = state.players.get_mut(&player_id) {
                        runtime.state.position_ms =
                            ic.position_ms.unwrap_or(runtime.state.position_ms);
                        if let Some(player) = &runtime.player {
                            if let Err(err) =
                                player.try_seek(Duration::from_millis(runtime.state.position_ms))
                            {
                                emit_error(
                                    &format!(
                                        "seek '{}' a {} ms fallo: {:?}",
                                        player_id, runtime.state.position_ms, err
                                    ),
                                    &request_id,
                                );
                            }
                        }
                    }
                }
                "setGain" => {
                    let new_gain = {
                        let runtime = state.players.entry(player_id.clone()).or_default();
                        runtime.state.fade_active = false;
                        runtime.state.fade_stop_after = false;
                        runtime.state.fade_duration_ms = 0;
                        runtime.state.gain = ic.gain.unwrap_or(runtime.state.gain).clamp(0.0, 2.0);
                        runtime.state.gain
                    };
                    // FASE D · sub-paso 7.5: solo aplicamos gain individual del
                    // player. El master_gain se aplica en el FaderSource único
                    // entre program_mixer y sink PGM.
                    if let Some(runtime) = state.players.get(&player_id) {
                        if let Some(player) = &runtime.player {
                            player.set_volume(new_gain.clamp(0.0, 2.0));
                        }
                    }
                }
                "fade" => {
                    let runtime = state.players.entry(player_id.clone()).or_default();
                    let from_gain = ic.from_gain.unwrap_or(runtime.state.gain).clamp(0.0, 2.0);
                    let target_gain = ic
                        .to_gain
                        .or(ic.gain)
                        .unwrap_or(runtime.state.gain)
                        .clamp(0.0, 2.0);
                    let duration_ms = ic
                        .duration_ms
                        .or_else(|| ic.seconds.map(|s| (s.max(0.0) * 1000.0).round() as u64))
                        .unwrap_or(0);
                    let stop_after = ic.stop_after.unwrap_or(false);
                    runtime.state.gain = from_gain;
                    if let Some(player) = &runtime.player {
                        player.set_volume(from_gain);
                    }
                    if duration_ms <= 25 || (!stop_after && (from_gain - target_gain).abs() < 0.001)
                    {
                        runtime.state.fade_active = false;
                        runtime.state.gain = target_gain;
                        if let Some(player) = &runtime.player {
                            player.set_volume(target_gain);
                        }
                        if stop_after {
                            runtime.state.status = "stopped".to_string();
                            release_runtime_player(runtime);
                        }
                    } else {
                        runtime.state.fade_active = true;
                        runtime.state.fade_start_gain = from_gain;
                        runtime.state.fade_target_gain = target_gain;
                        runtime.state.fade_started_at_ms = now_ms();
                        runtime.state.fade_duration_ms = duration_ms;
                        runtime.state.fade_stop_after = stop_after;
                    }
                }
                "getPeaks" => {
                    // FIX BUG (pausas de vúmetros): antes este comando se procesaba
                    // SÍNCRONO en el main loop. `compute_waveform_peaks` decodifica
                    // el archivo completo (1-5 s para canciones largas sin caché),
                    // tiempo durante el cual el main loop NO procesa los `PushTick`
                    // → los meters de la consola se "congelan" hasta que termina.
                    //
                    // Solución: spawn un thread worker dedicado por cada getPeaks.
                    // El main loop responde inmediato y sigue procesando ticks. El
                    // worker emite el `peaks` por stdout cuando termina. Para
                    // proteger contra entrelazado de bytes en stdout (cada `println!`
                    // ya es line-atómico, pero el formato grande de peaks se
                    // serializa antes de un solo write), usamos `stdout().lock()`
                    // antes del print.
                    let path = ic.path.clone().unwrap_or_default();
                    let target_bins = ic.bins.unwrap_or(4096) as usize;
                    let cache_dir = ic.cache_dir.clone().unwrap_or_default();
                    let req_id_owned = request_id.clone();
                    thread::spawn(move || {
                        match compute_waveform_peaks(&path, target_bins, &cache_dir) {
                            Ok((
                                min_peaks,
                                max_peaks,
                                duration_ms,
                                sample_rate,
                                silence_start,
                                silence_end,
                            )) => {
                                let min_json = floats_to_json(&min_peaks);
                                let max_json = floats_to_json(&max_peaks);
                                // Pre-formatear como un solo String y luego escribir
                                // atómicamente (un solo `write_all` bajo el lock de
                                // stdout) para garantizar que no se entrelace con
                                // otros writes de status push.
                                let payload = format!(
                                "{{{}\"type\":\"peaks\",\"bins\":{},\"durationMs\":{},\"sampleRate\":{},\"silenceStart\":{:.4},\"silenceEnd\":{:.4},\"min\":{},\"max\":{}}}\n",
                                request_id_field(&req_id_owned),
                                min_peaks.len(),
                                duration_ms,
                                sample_rate,
                                silence_start,
                                silence_end,
                                min_json,
                                max_json,
                            );
                                let stdout = io::stdout();
                                let mut lock = stdout.lock();
                                let _ = lock.write_all(payload.as_bytes());
                                let _ = lock.flush();
                            }
                            Err(err) => {
                                emit_error(&format!("getPeaks: {}", err), &req_id_owned);
                            }
                        }
                    });
                    // No llamamos emit_status acá: el thread responderá asíncrono.
                    // Saltamos el emit_status al final del bloque con continue.
                    continue 'main_loop;
                }
                // ================================================================
                // stream_start / stream_chunk / stream_stop — inyección PCM vivo
                // ================================================================
                // Permiten retransmitir una URL de radio (o cualquier fuente PCM
                // externa) a través del program_mixer. El backend Node lanza FFmpeg
                // apuntando a la URL, lee el stdout PCM s16le y lo envía en chunks
                // base64 via `stream_chunk`. El audio fluye por el mismo camino DSP
                // que cualquier pista local (EQ/Comp/Limiter → encoder tap).
                "stream_start" => {
                    let bus_id = ic.bus.clone().unwrap_or_else(|| "master".to_string());
                    let gain = ic.gain.unwrap_or(1.0);
                    let output_id = ic
                        .output_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let channels_raw = ic.channels.unwrap_or(2);
                    let sample_rate_raw = ic.sample_rate.unwrap_or(44100);
                    let ring_buffer_seconds = ic
                        .ring_buffer_seconds
                        .map(|v| (v as u32).clamp(2, 20))
                        .unwrap_or(2);

                    match start_pcm_stream_player(
                        &mut state,
                        &player_id,
                        &bus_id,
                        &output_id,
                        gain,
                        channels_raw,
                        sample_rate_raw,
                        ring_buffer_seconds,
                        false,
                    ) {
                        Ok(runtime) => {
                            state
                                .stream_producers
                                .insert(player_id.clone(), runtime.producer);
                            state
                                .stream_finished_flags
                                .insert(player_id.clone(), runtime.finished);
                        }
                        Err(err) => {
                            emit_error(&err, &request_id);
                            emit_status(&state, &request_id);
                            continue 'main_loop;
                        }
                    }

                    println!(
                        "{{\"type\":\"stream_ready\",\"player\":\"{}\",\"updatedAt\":{}}}",
                        player_id,
                        now_ms()
                    );
                    let _ = io::stdout().flush();
                }

                "stream_play" => {
                    if let Some(runtime) = state.players.get_mut(&player_id) {
                        if let Some(player) = runtime.player.as_ref() {
                            player.play();
                            runtime.state.status = "playing".to_string();
                        }
                    }
                    continue 'main_loop;
                }

                "stream_chunk" => {
                    use base64::Engine;
                    let data_b64 = match &ic.data {
                        Some(d) => d,
                        None => {
                            emit_status(&state, &request_id);
                            continue 'main_loop;
                        }
                    };

                    if let Some(producer) = state.stream_producers.get_mut(&player_id) {
                        match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                            Ok(bytes) => {
                                let mut i = 0usize;
                                while i + 1 < bytes.len() {
                                    let sample_i16 = i16::from_le_bytes([bytes[i], bytes[i + 1]]);
                                    let sample_f32 = sample_i16 as f32 / 32768.0;
                                    if producer.push(sample_f32).is_err() {
                                        // Ring lleno (overrun): descartar el resto del chunk.
                                        // El overrun en streams vivos es preferible al lag.
                                        break;
                                    }
                                    i += 2;
                                }
                            }
                            Err(_) => {
                                // Base64 inválido: ignorar sin crashear (puede ocurrir en
                                // el arranque/cierre del proceso FFmpeg).
                            }
                        }
                    }
                    // stream_chunk no emite status push (muy frecuente: 50/s).
                    continue 'main_loop;
                }

                "stream_stop" => {
                    // Señalar al PcmRingSource que ya no habrá más datos.
                    if let Some(finished) = state.stream_finished_flags.remove(&player_id) {
                        finished.store(true, Ordering::Relaxed);
                    }
                    // Retirar el productor → ningún hilo puede escribir más.
                    state.stream_producers.remove(&player_id);

                    // Actualizar estado del player.
                    if let Some(runtime) = state.players.get_mut(&player_id) {
                        runtime.state.status = "stopped".to_string();
                    }

                    println!(
                        "{{\"type\":\"stream_stopped\",\"player\":\"{}\",\"updatedAt\":{}}}",
                        player_id,
                        now_ms()
                    );
                    let _ = io::stdout().flush();
                }

                "" => emit_error("Comando sin campo cmd.", &request_id),
                other => emit_error(&format!("Comando no soportado: {}", other), &request_id),
            }, // match cmd (audio)

            "encoder" => handle_encoder_command(&mut state, &ic),
            "input" => handle_input_command(&mut state, &ic),
            "recorder" => handle_recorder_command(&mut state, &ic),
            other_module => {
                emit_error(
                    &format!("Módulo no soportado: {}", other_module),
                    &request_id,
                );
            }
        } // match module

        emit_status(&state, &request_id);
    }
}

// ============================================================================
// Tests unitarios (cargo test corre en CI). Cubren la precarga a RAM del
// plan "audio inmune a saturación de disco": el decoder de reproducción no
// debe depender del disco una vez cargado.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use playback::{open_playback_decoder, spawn_streamed_file_source, PlaybackSource};
    use rodio::Source;
    use std::time::Instant;

    /// WAV PCM 16-bit mono 44.1 kHz mínimo y válido (100 muestras).
    fn write_test_wav(path: &std::path::Path) {
        let samples: u32 = 100;
        let data_len = samples * 2;
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&44100u32.to_le_bytes());
        bytes.extend_from_slice(&(44100u32 * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            bytes.extend_from_slice(&((i % 64) as i16 * 100).to_le_bytes());
        }
        std::fs::write(path, bytes).expect("escribir wav de prueba");
    }

    fn test_wav_path(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("lf_engine_test_{}.wav", name));
        write_test_wav(&path);
        path
    }

    #[test]
    fn precarga_a_ram_cuando_cabe_en_el_tope() {
        let path = test_wav_path("ram");
        let (source, preloaded) = open_playback_decoder(path.to_str().unwrap()).unwrap();
        assert!(preloaded, "archivo pequeño debe precargarse a RAM");
        assert!(matches!(source, PlaybackSource::Ram(_)));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn decoder_precargado_decodifica_y_reporta_duracion() {
        let path = test_wav_path("decode");
        let (source, preloaded) = open_playback_decoder(path.to_str().unwrap()).unwrap();
        assert!(preloaded);
        assert!(
            source.total_duration().is_some(),
            "with_byte_len debe permitir total_duration"
        );
        let count = source.count();
        assert!(count > 0, "el decoder debe producir muestras desde RAM");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn streaming_con_ring_decodifica_completo_para_archivos_grandes() {
        let path = test_wav_path("stream");
        let byte_len = std::fs::metadata(&path).unwrap().len();
        // Llamada directa al camino streaming (el que usan los archivos que
        // superan PRELOAD_MAX_BYTES): el hilo decodificador llena el ring y la
        // fuente entrega todas las muestras reales antes de terminar.
        let source = spawn_streamed_file_source(path.to_str().unwrap(), byte_len).unwrap();
        assert!(source.total_duration().is_some());
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut real_samples = 0usize;
        let mut source = source;
        loop {
            match source.next() {
                None => break, // fin: decodificado y drenado
                Some(sample) => {
                    if sample != 0.0 {
                        real_samples += 1;
                    }
                }
            }
            if Instant::now() > deadline {
                panic!("la fuente streaming no terminó a tiempo");
            }
        }
        assert!(
            real_samples > 0,
            "deben llegar muestras reales a través del ring"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn streaming_no_soporta_seek_y_lo_reporta() {
        let path = test_wav_path("seek");
        let byte_len = std::fs::metadata(&path).unwrap().len();
        let mut source = spawn_streamed_file_source(path.to_str().unwrap(), byte_len).unwrap();
        assert!(source.try_seek(Duration::from_secs(1)).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
