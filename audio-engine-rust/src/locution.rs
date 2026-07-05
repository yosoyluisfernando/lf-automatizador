// Locución de hora: reproducción automática de archivos de audio que anuncian
// la hora actual.
//
// Los archivos se buscan en una carpeta configurada por el operador, con
// convención de nombres:
//   - HRSxx_O.* → hora en punto ("son las XX en punto")
//   - HRSxx.*   → hora (sin la parte "en punto")
//   - MINxx.*   → minutos
//
// Si la hora es :00, se usa el archivo _O. Si no, se concatenan hora + minutos
// en reproducción gapless.
//
// `start_time_locution` resuelve los archivos, los carga como secuencia y
// registra el player. `finish_time_locution_if_drained` detecta cuando terminó
// y emite el evento timeLocutionEnded.

use std::io::{self, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use rodio::Player;

use crate::emit::resolve_output_for_bus;
use crate::metering::{MeteredSource, PlayerMeter};
use crate::output::ensure_output;
use crate::peaks::cached_audio_duration_ms;
use crate::playback::open_playback_decoder;
use crate::protocol::{escape_json, now_ms};
use crate::routing::ensure_program_mixer;
use crate::state::{is_program_bus, EngineState};

#[cfg(windows)]
pub(crate) fn local_hour_minute() -> (u32, u32) {
    unsafe {
        let now: libc::time_t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_s(&mut tm, &now) != 0 {
            return (0, 0);
        }
        (tm.tm_hour.max(0) as u32, tm.tm_min.max(0) as u32)
    }
}

#[cfg(not(windows))]
pub(crate) fn local_hour_minute() -> (u32, u32) {
    unsafe {
        let now: libc::time_t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return (0, 0);
        }
        (tm.tm_hour.max(0) as u32, tm.tm_min.max(0) as u32)
    }
}

fn resolve_time_locution_files(folder: &str) -> Vec<String> {
    let (h, m) = local_hour_minute();
    let hh = format!("{:02}", h);
    let mm = format!("{:02}", m);
    let folder_path = std::path::Path::new(folder);
    if !folder_path.is_dir() {
        return Vec::new();
    }
    let entries: Vec<(String, std::path::PathBuf)> = match std::fs::read_dir(folder_path) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok().map(|n| (n, e.path())))
            .collect(),
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if mm == "00" {
        let prefix = format!("HRS{}_O", hh);
        if let Some((_, p)) = entries
            .iter()
            .find(|(n, _)| n.to_uppercase().starts_with(&prefix))
        {
            out.push(p.to_string_lossy().to_string());
        }
    } else {
        let prefix_h = format!("HRS{}", hh);
        if let Some((_, p)) = entries.iter().find(|(n, _)| {
            let up = n.to_uppercase();
            up.starts_with(&prefix_h) && !up.contains("_O")
        }) {
            out.push(p.to_string_lossy().to_string());
        }
        let prefix_m = format!("MIN{}", mm);
        if let Some((_, p)) = entries
            .iter()
            .find(|(n, _)| n.to_uppercase().starts_with(&prefix_m))
        {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out
}

/// Detecta si el player de locución terminó (drained) y emite timeLocutionEnded.
pub(crate) fn finish_time_locution_if_drained(state: &mut EngineState) {
    let player_id = state.time_locution_player.clone();
    if player_id.is_empty() {
        return;
    }
    let drained = state
        .players
        .get(&player_id)
        .and_then(|runtime| runtime.player.as_ref())
        .map(|player| player.empty())
        .unwrap_or(false);
    if !drained {
        return;
    }

    let duration_ms = state.time_locution_total_ms;
    let segments = state
        .players
        .get(&player_id)
        .map(|runtime| {
            runtime
                .state
                .path
                .split('|')
                .filter(|part| !part.trim().is_empty())
                .count()
        })
        .unwrap_or(0);

    if let Some(runtime) = state.players.get_mut(&player_id) {
        runtime.state.status = "ended".to_string();
        runtime.state.position_ms = duration_ms;
    }

    state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
    state.time_locution_player.clear();
    state.time_locution_started_at = None;
    state.time_locution_total_ms = 0;

    println!(
        "{{\"type\":\"timeLocutionEnded\",\"engine\":\"rustAudio\",\"player\":\"{}\",\"durationMs\":{},\"segments\":{},\"updatedAt\":{}}}",
        escape_json(&player_id),
        duration_ms,
        segments,
        now_ms()
    );
    let _ = io::stdout().flush();
}

/// Inicia la reproducción de la locución de hora: resuelve los archivos
/// según la hora local, los carga como secuencia gapless y registra el player.
pub(crate) fn start_time_locution(
    state: &mut EngineState,
    player_id: &str,
    folder: &str,
    gain: f32,
    output_id: &str,
    bus_id: &str,
    _request_id: &str,
    cache_dir: &str,
) -> Result<(u64, Vec<String>), String> {
    let files = resolve_time_locution_files(folder);
    if files.is_empty() {
        return Err(
            "No se encontraron archivos de locucion de hora para la hora actual.".to_string(),
        );
    }
    let routed_output_id = resolve_output_for_bus(state, bus_id, output_id);
    let (resolved_output_id, _) = ensure_output(state, &routed_output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state
            .routes
            .get("master")
            .map(|r| r.output_device_id.clone())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| resolved_output_id.clone());
        ensure_program_mixer(state, &master_output_id)?;
    }

    let use_program_mixer = is_program_bus(bus_id) && state.program_mixer_input.is_some();
    let program_mixer_clone = if use_program_mixer {
        state.program_mixer_input.as_ref().map(|m| m.clone())
    } else {
        None
    };
    let player = match program_mixer_clone.as_ref() {
        Some(mixer) => Player::connect_new(mixer),
        None => {
            let output = state
                .outputs
                .get(&resolved_output_id)
                .ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    player.set_volume(gain.clamp(0.0, 2.0));

    let meter = Arc::new(PlayerMeter::default());

    let mut total_ms: u64 = 0;
    for path in &files {
        total_ms = total_ms.saturating_add(cached_audio_duration_ms(path, cache_dir));
    }
    if total_ms == 0 {
        return Err(
            "La locucion de hora dura 0 ms (decoders sin metadata de duracion).".to_string(),
        );
    }

    for path in &files {
        let (decoder, _preloaded) =
            open_playback_decoder(path).map_err(|e| format!("{} ({})", e, path))?;
        let metered = MeteredSource::new(decoder, Arc::clone(&meter));
        player.append(metered);
    }

    let runtime = state.players.entry(player_id.to_string()).or_default();
    if let Some(old) = runtime.player.take() {
        old.stop();
    }
    runtime.meter = Arc::clone(&meter);
    runtime.state.path = files.join("|");
    runtime.state.status = "playing".to_string();
    runtime.state.position_ms = 0;
    runtime.state.duration_ms = total_ms;
    runtime.state.gain = gain.clamp(0.0, 2.0);
    runtime.state.fade_active = false;
    runtime.state.fade_start_gain = runtime.state.gain;
    runtime.state.fade_target_gain = runtime.state.gain;
    runtime.state.fade_started_at_ms = 0;
    runtime.state.fade_duration_ms = 0;
    runtime.state.fade_stop_after = false;
    runtime.state.bus_id = bus_id.to_string();
    runtime.state.output_device_id = resolved_output_id;
    runtime.state.output_device_name = String::new();
    runtime.player = Some(player);

    state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
    state.time_locution_player = player_id.to_string();
    state.time_locution_started_at = Some(Instant::now());
    state.time_locution_total_ms = total_ms;

    Ok((total_ms, files))
}
