// Emisión de JSON por stdout para IPC con el proceso Electron.
//
// Cada función emite una línea JSON completa seguida de flush. El protocolo es
// newline-delimited JSON: el proceso Node lee líneas y las parsea. Las funciones
// principales son:
//
// - `emit_status`  — snapshot completo del engine (players, meters, buses, encoder)
//                    enviado cada PUSH_TICK_MS (~100ms) al frontend.
// - `emit_encoder_pcm_chunk` — chunk de PCM s16le en base64 para el encoder FFmpeg.
// - `emit_devices`           — lista de salidas de audio disponibles (delegado a output.rs).
//
// Funciones auxiliares:
// - `default_bus_for_player` — asigna bus por convención de nombre de player.
// - `is_diagnostic_player`   — true para players que no se cuentan como audio activo.
// - `resolve_output_for_bus` — busca la ruta configurada o devuelve fallback.

use std::io::{self, Write};
use std::sync::atomic::Ordering;

use crate::protocol::{escape_json, now_ms, request_id_field};
use crate::state::EngineState;

/// Devuelve el bus por defecto según la convención de nombre del player.
pub(crate) fn default_bus_for_player(player_id: &str) -> &'static str {
    match player_id {
        "player-a" | "player-b" | "player-c" => "master",
        "jingle-player" | "jingle" => "jingle",
        "cue-player" | "preview-player" | "editor-player" => "cue",
        "audio-editor" | "jingle-editor-a" | "jingle-editor-j" | "jingle-editor-b"
        | "trans-editor-a" | "trans-editor-b" => "cue",
        "cartwall" | "cartwall-player" => "cartwall",
        "pl1" | "playlist-1" => "pl1",
        "pl2" | "playlist-2" => "pl2",
        "pl3" | "playlist-3" => "pl3",
        "pl4" | "playlist-4" => "pl4",
        "aux1" | "auxiliary-1" | "aux-playlist-1" => "aux1",
        "aux2" | "auxiliary-2" | "aux-playlist-2" => "aux2",
        id if id.starts_with("aux1-") || id.starts_with("auxiliary-1-") => "aux1",
        id if id.starts_with("aux2-") || id.starts_with("auxiliary-2-") => "aux2",
        _ => "",
    }
}

/// Players de diagnóstico/preview: no cuentan como "audio activo" para el frontend.
pub(crate) fn is_diagnostic_player(player_id: &str) -> bool {
    matches!(
        player_id,
        "preview-player"
            | "lab"
            | "jingle-player"
            | "jingle"
            | "cartwall-player"
            | "cue-player"
            | "pl1"
            | "pl2"
            | "pl3"
            | "pl4"
            | "audio-editor"
            | "jingle-editor-a"
            | "jingle-editor-j"
            | "jingle-editor-b"
            | "trans-editor-a"
            | "trans-editor-b"
    ) || player_id.starts_with("route-map-")
}

/// True si algún player tiene audio cargado y no está detenido.
pub(crate) fn has_active_audio(state: &EngineState) -> bool {
    state.players.values().any(|runtime| {
        runtime.player.is_some()
            && matches!(
                runtime.state.status.as_str(),
                "playing" | "paused" | "loaded"
            )
    })
}

/// Resuelve el output_id para un bus: primero busca en las rutas configuradas,
/// si no encuentra usa el fallback, y si está vacío devuelve "default".
pub(crate) fn resolve_output_for_bus(
    state: &EngineState,
    bus_id: &str,
    fallback_output_id: &str,
) -> String {
    if let Some(route) = state.routes.get(bus_id) {
        if !route.output_device_id.is_empty() {
            return route.output_device_id.clone();
        }
    }
    if fallback_output_id.trim().is_empty() {
        "default".to_string()
    } else {
        fallback_output_id.to_string()
    }
}

/// Emite el snapshot completo de estado como JSON por stdout.
/// Incluye players, meters (picos L/R + dB), buses, now_playing, transport y encoder.
pub(crate) fn emit_status(state: &EngineState, request_id: &str) {
    let mut active_outputs = Vec::new();
    for (id, output) in &state.outputs {
        active_outputs.push(format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            escape_json(id),
            escape_json(&output.name)
        ));
    }

    let mut players = Vec::new();
    let mut meters = Vec::new();
    let is_time_locution_active =
        state.time_locution_started_at.is_some() && !state.time_locution_player.is_empty();
    for (id, runtime) in &state.players {
        let audio_ready = runtime.player.is_some();
        let is_this_time_locution = is_time_locution_active && *id == state.time_locution_player;
        let raw_pos_ms = runtime
            .player
            .as_ref()
            .map(|player| player.get_pos().as_millis() as u64)
            .unwrap_or(runtime.state.position_ms);
        let position_ms = if is_this_time_locution {
            let elapsed = state
                .time_locution_started_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            elapsed.min(state.time_locution_total_ms)
        } else {
            raw_pos_ms
        };
        let duration_ms: u64 = if is_this_time_locution {
            state.time_locution_total_ms
        } else {
            runtime.state.duration_ms
        };
        let status = runtime
            .player
            .as_ref()
            .map(|player| {
                if player.empty() && runtime.state.status == "playing" {
                    "ended".to_string()
                } else if player.is_paused() {
                    "paused".to_string()
                } else {
                    runtime.state.status.clone()
                }
            })
            .unwrap_or_else(|| runtime.state.status.clone());
        players.push(format!(
            "{{\"id\":\"{}\",\"status\":\"{}\",\"path\":\"{}\",\"positionMs\":{},\"durationMs\":{},\"gain\":{},\"audioReady\":{},\"outputDeviceId\":\"{}\",\"outputDeviceName\":\"{}\"}}",
            escape_json(id),
            escape_json(&status),
            escape_json(&runtime.state.path),
            position_ms,
            duration_ms,
            runtime.state.gain,
            audio_ready,
            escape_json(&runtime.state.output_device_id),
            escape_json(&runtime.state.output_device_name)
        ));
        let bus = if runtime.state.bus_id.trim().is_empty() {
            default_bus_for_player(id).to_string()
        } else {
            runtime.state.bus_id.clone()
        };
        let (meter_left, meter_right) = runtime.meter.read();
        let gain = runtime.state.gain.clamp(0.0, 2.0);
        let left_percent = if audio_ready && status == "playing" && gain > 0.0 {
            (meter_left * gain * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let right_percent = if audio_ready && status == "playing" && gain > 0.0 {
            (meter_right * gain * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let peak_percent = left_percent.max(right_percent);
        let meter_db = if peak_percent <= 0.0 {
            -120.0
        } else {
            20.0 * (peak_percent / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"{}\",\"bus\":\"{}\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"{}\",\"source\":\"player\"}}",
            escape_json(id),
            escape_json(&bus),
            left_percent,
            right_percent,
            meter_db,
            escape_json(&status)
        ));
    }

    if state.program_mixer_input.is_some() {
        let (m_left, m_right) = state.master_bus_meter.read();
        let m_left_pct = (m_left * 100.0).clamp(0.0, 100.0);
        let m_right_pct = (m_right * 100.0).clamp(0.0, 100.0);
        let m_peak_pct = m_left_pct.max(m_right_pct);
        let m_db = if m_peak_pct <= 0.0 {
            -120.0
        } else {
            20.0 * (m_peak_pct / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"master\",\"bus\":\"master\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"playing\",\"source\":\"bus\"}}",
            m_left_pct, m_right_pct, m_db
        ));
    }

    if !state.monitor_sink_id.is_empty() {
        let (m_left, m_right) = state.monitor_bus_meter.read();
        let m_left_pct = (m_left * 100.0).clamp(0.0, 100.0);
        let m_right_pct = (m_right * 100.0).clamp(0.0, 100.0);
        let m_peak_pct = m_left_pct.max(m_right_pct);
        let m_db = if m_peak_pct <= 0.0 {
            -120.0
        } else {
            20.0 * (m_peak_pct / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"monitor\",\"bus\":\"monitor\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"playing\",\"source\":\"bus\"}}",
            m_left_pct, m_right_pct, m_db
        ));
    }

    let mut input_meters = Vec::new();
    let mut input_meter_ids = state.input_meter_routes.keys().cloned().collect::<Vec<_>>();
    input_meter_ids.sort();
    for id in input_meter_ids {
        if let Some(meter) = state.input_meter_routes.get(&id) {
            input_meters.push(format!(
                "{{\"id\":\"{}\",\"label\":\"{}\",\"deviceId\":\"{}\",\"sourceId\":\"{}\",\"consumer\":\"{}\",\"peakDb\":{},\"rmsDb\":{},\"updatedAt\":{}}}",
                escape_json(&meter.id),
                escape_json(&meter.label),
                escape_json(&meter.route.device_id),
                escape_json(&meter.route.source_id),
                escape_json(&meter.route.consumer_id),
                meter.peak_db,
                meter.rms_db,
                meter.updated_at
            ));
        }
    }

    let mut buses = Vec::new();
    for (bus, route) in &state.routes {
        buses.push(format!(
            "{{\"id\":\"{}\",\"outputDeviceId\":\"{}\",\"outputDeviceName\":\"{}\"}}",
            escape_json(bus),
            escape_json(&route.output_device_id),
            escape_json(&route.output_device_name)
        ));
    }
    let now_playing = state.now_playing.as_ref().map(|item| {
        format!(
            "{{\"title\":\"{}\",\"artist\":\"{}\",\"path\":\"{}\",\"player\":\"{}\",\"source\":\"{}\",\"updatedAt\":{}}}",
            escape_json(&item.title),
            escape_json(&item.artist),
            escape_json(&item.path),
            escape_json(&item.player),
            escape_json(&item.source),
            item.updated_at
        )
    }).unwrap_or_else(|| "null".to_string());
    let transport = state.transport.as_ref().map(|item| {
        format!(
            "{{\"player\":\"{}\",\"status\":\"{}\",\"positionMs\":{},\"durationMs\":{},\"startCause\":\"{}\",\"mixActive\":{},\"mixPhase\":\"{}\",\"mixDirection\":\"{}\",\"mixReferencePlayer\":\"{}\",\"updatedAt\":{}}}",
            escape_json(&item.player),
            escape_json(&item.status),
            item.position_ms,
            item.duration_ms,
            escape_json(&item.start_cause),
            item.mix_active,
            escape_json(&item.mix_phase),
            escape_json(&item.mix_direction),
            escape_json(&item.mix_reference_player),
            item.updated_at
        )
    }).unwrap_or_else(|| "null".to_string());
    let encoder_tap_active = state.dsp_params.encoder_tap_active.load(Ordering::Relaxed);
    let encoder_tap_ready = encoder_tap_active
        && state.encoder_tap_pre_consumer.is_some()
        && state.encoder_tap_post_consumer.is_some();
    let encoder_tap_mode = if state.dsp_params.encoder_tap_mode.load(Ordering::Relaxed) == 0 {
        "preFx"
    } else {
        "postFx"
    };
    let encoder_tap_dropped = state.encoder_tap_pre_drops.load(Ordering::Relaxed)
        + state.encoder_tap_post_drops.load(Ordering::Relaxed);
    let encoder = format!(
        "{{\"active\":{},\"source\":\"{}\",\"owner\":\"{}\",\"requestedOwner\":\"{}\",\"captureProvider\":\"{}\",\"encoderProvider\":\"{}\",\"rustPcmReady\":{},\"pcmBridgeReady\":{},\"pcmBridgeMode\":\"{}\",\"pcmBridgeReason\":\"{}\",\"fallbackReason\":\"{}\",\"captureFormat\":\"{}\",\"sampleRate\":{},\"transport\":\"{}\",\"bitrateKbps\":{},\"speed\":{},\"ffmpegTime\":\"{}\",\"maxGapMs\":{},\"gapWarnings\":{},\"inputPeakDb\":{},\"inputRmsDb\":{},\"inputMeterUpdatedAt\":{},\"tap\":{{\"active\":{},\"ready\":{},\"mode\":\"{}\",\"droppedSamples\":{}}},\"updatedAt\":{}}}",
        state.encoder.active,
        escape_json(&state.encoder.source_bus),
        escape_json(&state.encoder.owner),
        escape_json(&state.encoder.requested_owner),
        escape_json(&state.encoder.capture_provider),
        escape_json(&state.encoder.encoder_provider),
        state.encoder.rust_pcm_ready,
        state.encoder.pcm_bridge_ready,
        escape_json(&state.encoder.pcm_bridge_mode),
        escape_json(&state.encoder.pcm_bridge_reason),
        escape_json(&state.encoder.fallback_reason),
        escape_json(&state.encoder.capture_format),
        state.encoder.sample_rate,
        escape_json(&state.encoder.transport),
        state.encoder.bitrate_kbps,
        state.encoder.speed,
        escape_json(&state.encoder.ffmpeg_time),
        state.encoder.max_gap_ms,
        state.encoder.gap_warnings,
        state.encoder.input_peak_db,
        state.encoder.input_rms_db,
        state.encoder.input_meter_updated_at,
        encoder_tap_active,
        encoder_tap_ready,
        encoder_tap_mode,
        encoder_tap_dropped,
        state.encoder.updated_at
    );
    let encoder_servers = state.encoder_servers.snapshot_json();
    let ptt = format!(
        "{{\"active\":{},\"routeToMaster\":{},\"duckActive\":{},\"duckEngaged\":{},\"masterGain\":{},\"targetGain\":{},\"restoreGain\":{}}}",
        state.ptt_input_route.is_some(),
        state.stream_producers.contains_key(&state.ptt_player_id),
        state.ptt_duck.active,
        state.ptt_duck.engaged,
        state.master_gain,
        state.ptt_duck.target_gain,
        state.ptt_duck.restore_gain
    );
    println!(
        "{{{}\"type\":\"status\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"labPlayback\":{},\"updatedAt\":{},\"activeOutputs\":[{}],\"buses\":[{}],\"nowPlaying\":{},\"transport\":{},\"encoder\":{},\"encoderServers\":[{}],\"ptt\":{},\"players\":[{}],\"meters\":[{}],\"inputMeters\":[{}]}}",
        request_id_field(request_id),
        has_active_audio(state),
        now_ms(),
        active_outputs.join(","),
        buses.join(","),
        now_playing,
        transport,
        encoder,
        encoder_servers,
        ptt,
        players.join(","),
        meters.join(","),
        input_meters.join(",")
    );
    let _ = io::stdout().flush();
}

/// Lee samples del tap activo (pre/post FX) y emite un chunk PCM s16le en base64.
/// El idle tap se drena sin emitir para evitar acumulación.
pub(crate) struct EncoderPcmChunk {
    pub(crate) tap_label: &'static str,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) samples: usize,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn take_encoder_pcm_chunk(state: &mut EngineState) -> Option<EncoderPcmChunk> {
    let mode = state.dsp_params.encoder_tap_mode.load(Ordering::Relaxed);
    let (active_consumer, idle_consumer) = if mode == 0 {
        (
            state.encoder_tap_pre_consumer.as_mut(),
            state.encoder_tap_post_consumer.as_mut(),
        )
    } else {
        (
            state.encoder_tap_post_consumer.as_mut(),
            state.encoder_tap_pre_consumer.as_mut(),
        )
    };
    if let Some(idle) = idle_consumer {
        while idle.pop().is_ok() {}
    }
    let consumer = match active_consumer {
        Some(c) => c,
        None => return None,
    };
    let available = consumer.slots();
    if available == 0 {
        return None;
    }
    const MAX_SAMPLES_PER_CHUNK: usize = 17_640;
    let to_read = available.min(MAX_SAMPLES_PER_CHUNK);
    let mut pcm_bytes: Vec<u8> = Vec::with_capacity(to_read * 2);
    let mut read = 0;
    while read < to_read {
        match consumer.pop() {
            Ok(f) => {
                let clipped = f.clamp(-1.0, 1.0);
                let i = (clipped * 32767.0) as i16;
                pcm_bytes.extend_from_slice(&i.to_le_bytes());
                read += 1;
            }
            Err(_) => break,
        }
    }
    if read == 0 {
        return None;
    }
    let tap_label = if mode == 0 { "preFx" } else { "postFx" };
    Some(EncoderPcmChunk {
        tap_label,
        sample_rate: 44100,
        channels: 2,
        samples: read,
        bytes: pcm_bytes,
    })
}

pub(crate) fn emit_encoder_pcm_chunk(chunk: &EncoderPcmChunk) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&chunk.bytes);
    println!(
        "{{\"type\":\"pcmChunk\",\"engine\":\"rustAudio\",\"tap\":\"{}\",\"sampleRate\":{},\"channels\":{},\"samples\":{},\"pcm\":\"{}\"}}",
        chunk.tap_label, chunk.sample_rate, chunk.channels, chunk.samples, b64
    );
    let _ = io::stdout().flush();
}
