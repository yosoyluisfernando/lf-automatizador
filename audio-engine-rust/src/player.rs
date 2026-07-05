// Ciclo de vida de players: liberar, reconstruir, repetir y fades.
//
// Funciones que operan sobre RuntimePlayer ya existentes en EngineState:
//
// - `release_runtime_player` — detiene el audio y resetea el estado del player.
// - `play_existing_or_rebuild_player` — si el player tiene audio válido lo reanuda;
//   si se agotó (empty()) o no tiene handle, lo reconstruye desde el path guardado.
// - `process_repeat_players` — detecta players con repeat activo que están por
//   terminar y los reinicia desde repeat_start_ms.
// - `process_player_fades` — procesa los fades activos (curva smoothstep) y
//   detiene el player al finalizar si fade_stop_after está activado.

use std::time::Duration;

use crate::emit::{default_bus_for_player, resolve_output_for_bus};
use crate::playback::load_audio_player;
use crate::playlist::emit_playlist_mode_changed;
use crate::protocol::{emit_error, now_ms};
use crate::state::{EngineState, RuntimePlayer};

/// Detiene la reproducción y resetea fade/posición/meter del player.
pub(crate) fn release_runtime_player(runtime: &mut RuntimePlayer) {
    runtime.state.fade_active = false;
    runtime.state.fade_stop_after = false;
    runtime.state.fade_duration_ms = 0;
    runtime.state.position_ms = 0;
    runtime.meter.reset();
    if let Some(player) = runtime.player.take() {
        player.stop();
    }
}

fn player_needs_rebuild(runtime: &RuntimePlayer) -> bool {
    match runtime.player.as_ref() {
        Some(player) => player.empty(),
        None => !runtime.state.path.trim().is_empty(),
    }
}

/// Reanuda un player existente o lo reconstruye si se agotó.
/// Si la posición está al final del track, reinicia desde el principio.
pub(crate) fn play_existing_or_rebuild_player(
    state: &mut EngineState,
    player_id: &str,
) -> Result<(), String> {
    let Some(runtime) = state.players.get(player_id) else {
        return Err(format!("Player '{}' no existe.", player_id));
    };

    if !player_needs_rebuild(runtime) {
        if let Some(runtime) = state.players.get_mut(player_id) {
            runtime.state.status = "playing".to_string();
            if let Some(player) = &runtime.player {
                player.play();
            }
        }
        return Ok(());
    }

    let path = runtime.state.path.clone();
    if path.trim().is_empty() || path == "<time-locution>" {
        return Err(format!("Player '{}' no tiene audio cargado.", player_id));
    }
    let gain = runtime.state.gain;
    let bus_id = if runtime.state.bus_id.trim().is_empty() {
        default_bus_for_player(player_id).to_string()
    } else {
        runtime.state.bus_id.clone()
    };
    let fallback_output_id = runtime.state.output_device_id.clone();
    let requested_pos_ms = runtime.state.position_ms;
    let duration_ms = runtime.state.duration_ms;
    let seek_ms = if duration_ms > 0 && requested_pos_ms.saturating_add(250) >= duration_ms {
        0
    } else {
        requested_pos_ms
    };
    let output_id = resolve_output_for_bus(state, &bus_id, &fallback_output_id);

    load_audio_player(state, player_id, &path, gain, true, &output_id, &bus_id, "")?;
    if let Some(runtime) = state.players.get_mut(player_id) {
        runtime.state.status = "playing".to_string();
        runtime.state.position_ms = seek_ms;
        if let Some(player) = &runtime.player {
            if seek_ms > 0 {
                let _ = player.try_seek(Duration::from_millis(seek_ms));
            }
            player.play();
        }
    }
    Ok(())
}

/// Detecta players con repeat activo que están por terminar y los reinicia.
/// Incluye protección contra olvido: tras N repeticiones desactiva el repeat.
pub(crate) fn process_repeat_players(state: &mut EngineState) {
    const REPEAT_PREROLL_MS: u64 = 200;
    const MIN_REPEAT_WINDOW_MS: u64 = 500;

    #[derive(Clone)]
    struct RepeatSpec {
        player_id: String,
        path: String,
        gain: f32,
        bus_id: String,
        output_device_id: String,
        start_ms: u64,
        next_count: u64,
        deactivate_after_repeat: bool,
    }

    let mut repeats = Vec::new();
    for (player_id, runtime) in state.players.iter() {
        if !runtime.state.repeat_active || runtime.state.status != "playing" {
            continue;
        }
        if runtime.state.path.trim().is_empty() || runtime.state.path == "<time-locution>" {
            continue;
        }
        let duration_ms = runtime.state.duration_ms;
        let start_ms = runtime
            .state
            .repeat_start_ms
            .min(duration_ms.saturating_sub(1));
        if duration_ms <= start_ms + MIN_REPEAT_WINDOW_MS {
            continue;
        }
        let Some(player) = runtime.player.as_ref() else {
            continue;
        };
        let position_ms = player.get_pos().as_millis() as u64;
        if player.empty() || position_ms.saturating_add(REPEAT_PREROLL_MS) >= duration_ms {
            let next_count = runtime.state.repeat_count.saturating_add(1);
            let deactivate_after_repeat = state.playlist_mode.repeat_forget_protection_enabled
                && next_count >= state.playlist_mode.repeat_forget_protection_max.max(1);
            repeats.push(RepeatSpec {
                player_id: player_id.clone(),
                path: runtime.state.path.clone(),
                gain: runtime.state.gain,
                bus_id: if runtime.state.bus_id.trim().is_empty() {
                    default_bus_for_player(player_id).to_string()
                } else {
                    runtime.state.bus_id.clone()
                },
                output_device_id: runtime.state.output_device_id.clone(),
                start_ms,
                next_count,
                deactivate_after_repeat,
            });
        }
    }

    for spec in repeats {
        let output_id = resolve_output_for_bus(state, &spec.bus_id, &spec.output_device_id);
        match load_audio_player(
            state,
            &spec.player_id,
            &spec.path,
            spec.gain,
            true,
            &output_id,
            &spec.bus_id,
            "",
        ) {
            Ok(()) => {
                if let Some(runtime) = state.players.get_mut(&spec.player_id) {
                    runtime.state.repeat_active = !spec.deactivate_after_repeat;
                    runtime.state.repeat_start_ms = spec.start_ms;
                    runtime.state.repeat_count = spec.next_count;
                    runtime.state.position_ms = spec.start_ms;
                    runtime.state.status = "playing".to_string();
                    if let Some(player) = &runtime.player {
                        let _ = player.try_seek(Duration::from_millis(spec.start_ms));
                        player.play();
                    }
                }
                if spec.deactivate_after_repeat {
                    state.playlist_mode.repeat_track = false;
                    emit_playlist_mode_changed(state, "repeat-limit");
                }
            }
            Err(err) => emit_error(&format!("repeat '{}': {}", spec.player_id, err), ""),
        }
    }
}

/// Procesa fades activos: curva smoothstep (3t²-2t³), actualiza gain en tiempo real.
/// Si fade_stop_after está activado, detiene el player al terminar el fade.
pub(crate) fn process_player_fades(state: &mut EngineState) {
    let now = now_ms();
    let mut stop_after = Vec::new();
    for (player_id, runtime) in state.players.iter_mut() {
        if !runtime.state.fade_active {
            continue;
        }
        let duration = runtime.state.fade_duration_ms.max(1) as f32;
        let elapsed = now.saturating_sub(runtime.state.fade_started_at_ms) as f32;
        let t = (elapsed / duration).clamp(0.0, 1.0);
        let curved = t * t * (3.0 - 2.0 * t);
        let gain = runtime.state.fade_start_gain
            + ((runtime.state.fade_target_gain - runtime.state.fade_start_gain) * curved);
        runtime.state.gain = gain.clamp(0.0, 2.0);
        if let Some(player) = &runtime.player {
            player.set_volume(runtime.state.gain);
        }
        if t >= 1.0 {
            runtime.state.fade_active = false;
            runtime.state.gain = runtime.state.fade_target_gain.clamp(0.0, 2.0);
            if let Some(player) = &runtime.player {
                player.set_volume(runtime.state.gain);
            }
            if runtime.state.fade_stop_after {
                stop_after.push(player_id.clone());
            }
        }
    }
    for player_id in stop_after {
        if let Some(runtime) = state.players.get_mut(&player_id) {
            runtime.state.status = "stopped".to_string();
            release_runtime_player(runtime);
        }
    }
}
