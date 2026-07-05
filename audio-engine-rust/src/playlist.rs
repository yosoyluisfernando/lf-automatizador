// Lógica de playlist: auto-advance, repeat, remove-played y protecciones.
//
// El frontend envía snapshots de la playlist (filas con row_id, tab, orden, tipo)
// y los modos activos (repeat, remove-played, loop). El engine evalúa qué hacer
// cuando un player termina:
//
// 1. Si repeat_track está activo → replay de la misma fila (con protección anti-olvido).
// 2. Si no → decide_next_playlist_row busca la siguiente fila operacional en el
//    mismo tab, respetando queued_row_id si hay una encolada.
// 3. Si remove_played → emite acción para eliminar la fila terminada (con
//    protección de mínimo restante).
// 4. Emite playlistAction al frontend (playRow, resolveRandom, stop, removeRow).
//
// También gestiona now_playing, transport, y el estado del encoder de streaming.

use std::io::{self, Write};

use crate::protocol::{escape_json, now_ms, IncomingCommand};
use crate::state::{EngineState, NowPlayingState, PlaylistRowState, TransportState};

/// Actualiza los metadatos de "ahora suena" (título, artista, path).
pub(crate) fn update_now_playing(state: &mut EngineState, ic: &IncomingCommand) {
    state.now_playing = Some(NowPlayingState {
        title: ic.title.clone().unwrap_or_default(),
        artist: ic.artist.clone().unwrap_or_default(),
        path: ic.path.clone().unwrap_or_default(),
        player: ic.player.clone(),
        source: ic.source.clone().unwrap_or_else(|| "renderer".to_string()),
        updated_at: now_ms(),
    });
}

/// Actualiza el estado de transporte del player (posición, duración, estado de mezcla).
pub(crate) fn update_transport(state: &mut EngineState, ic: &IncomingCommand) {
    state.transport = Some(TransportState {
        player: ic.player.clone(),
        status: ic.status.clone().unwrap_or_else(|| "unknown".to_string()),
        position_ms: ic.position_ms.unwrap_or(0),
        duration_ms: ic.duration_ms.unwrap_or(0),
        start_cause: ic.start_cause.clone().unwrap_or_default(),
        mix_active: ic.mix_active.unwrap_or(false),
        mix_phase: ic.mix_phase.clone().unwrap_or_default(),
        mix_direction: ic.mix_direction.clone().unwrap_or_default(),
        mix_reference_player: ic.mix_reference_player.clone().unwrap_or_default(),
        updated_at: now_ms(),
    });
}

/// Reemplaza el snapshot completo de la playlist con las filas recibidas del frontend.
pub(crate) fn update_playlist_snapshot(state: &mut EngineState, ic: &IncomingCommand) {
    let mut rows: Vec<PlaylistRowState> = ic
        .rows
        .as_ref()
        .map(|parsed_rows| {
            parsed_rows
                .iter()
                .filter(|r| !r.row_id.is_empty())
                .map(|r| PlaylistRowState {
                    row_id: r.row_id.clone(),
                    tab: r.tab,
                    order: r.order,
                    row_type: if r.row_type.is_empty() {
                        "normal".to_string()
                    } else {
                        r.row_type.clone()
                    },
                    path: r.path.clone(),
                    title: r.title.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by_key(|row| (row.tab, row.order));
    state.playlist_rows = rows;
}

/// Actualiza los modos de playlist (repeat, remove-played, loop y protecciones).
pub(crate) fn update_playlist_mode(state: &mut EngineState, ic: &IncomingCommand) {
    state.playlist_mode.repeat_track = ic.repeat_track.unwrap_or(false);
    state.playlist_mode.remove_played = ic.remove_played.unwrap_or(false);
    state.playlist_mode.loop_playlist = ic.loop_playlist.unwrap_or(false);
    state.playlist_mode.repeat_forget_protection_enabled =
        ic.repeat_forget_protection_enabled.unwrap_or(false);
    state.playlist_mode.repeat_forget_protection_max =
        ic.repeat_forget_protection_max.unwrap_or(10).clamp(1, 999);
    state.playlist_mode.repeat_disable_on_manual_next =
        ic.repeat_disable_on_manual_next.unwrap_or(true);
    state.playlist_mode.remove_played_protection_enabled =
        ic.remove_played_protection_enabled.unwrap_or(false);
    state.playlist_mode.remove_played_protection_min_remaining = ic
        .remove_played_protection_min_remaining
        .unwrap_or(2)
        .clamp(1, 999);
}

/// Sincroniza el contexto de reproducción (fila activa, encolada, tab activo).
pub(crate) fn update_playlist_playback_context(state: &mut EngineState, ic: &IncomingCommand) {
    let current_row_id = ic.current_row_id.clone().unwrap_or_default();
    let current_player = ic.current_player.clone().unwrap_or_default();
    if state.playlist_context.current_row_id != current_row_id
        || state.playlist_context.current_player != current_player
    {
        state.playlist_context.last_finished_key.clear();
    }
    state.playlist_context.current_row_id = current_row_id;
    state.playlist_context.current_player = current_player;
    state.playlist_context.queued_row_id = ic.queued_row_id.clone().unwrap_or_default();
    state.playlist_context.pgm_tab = ic.pgm_tab.unwrap_or(0);
}

fn is_operational_playlist_row(row: &PlaylistRowState) -> bool {
    row.row_type != "note"
}

fn decide_next_playlist_row(state: &EngineState, current_row_id: &str) -> Option<PlaylistRowState> {
    if !state.playlist_context.queued_row_id.is_empty() {
        if let Some(row) = state
            .playlist_rows
            .iter()
            .find(|row| row.row_id == state.playlist_context.queued_row_id)
        {
            return Some(row.clone());
        }
    }
    let current = state
        .playlist_rows
        .iter()
        .find(|row| row.row_id == current_row_id)?;
    let mut same_tab = state
        .playlist_rows
        .iter()
        .filter(|row| row.tab == current.tab)
        .cloned()
        .collect::<Vec<_>>();
    same_tab.sort_by_key(|row| row.order);
    if let Some(row) = same_tab
        .iter()
        .find(|row| row.order > current.order && is_operational_playlist_row(row))
    {
        return Some(row.clone());
    }
    if state.playlist_mode.loop_playlist {
        return same_tab
            .into_iter()
            .find(|row| is_operational_playlist_row(row));
    }
    None
}

fn emit_playlist_action(action: &str, row_id: &str, player: &str) {
    println!(
        "{{\"type\":\"playlistAction\",\"engine\":\"rustAudio\",\"action\":\"{}\",\"rowId\":\"{}\",\"player\":\"{}\",\"updatedAt\":{}}}",
        escape_json(action),
        escape_json(row_id),
        escape_json(player),
        now_ms()
    );
    let _ = io::stdout().flush();
}

/// Notifica al frontend que los modos de playlist cambiaron (repeat/remove-played + motivo).
pub(crate) fn emit_playlist_mode_changed(state: &EngineState, reason: &str) {
    println!(
        "{{\"type\":\"playlistModeChanged\",\"engine\":\"rustAudio\",\"repeatTrack\":{},\"removePlayed\":{},\"reason\":\"{}\",\"updatedAt\":{}}}",
        if state.playlist_mode.repeat_track { "true" } else { "false" },
        if state.playlist_mode.remove_played { "true" } else { "false" },
        escape_json(reason),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn operational_rows_in_tab(state: &EngineState, tab: u64) -> u64 {
    state
        .playlist_rows
        .iter()
        .filter(|row| row.tab == tab && is_operational_playlist_row(row))
        .count() as u64
}

fn emit_remove_played_if_allowed(
    state: &mut EngineState,
    current_row_id: &str,
    current_player: &str,
) {
    if !state.playlist_mode.remove_played {
        return;
    }
    let current_tab = state
        .playlist_rows
        .iter()
        .find(|row| row.row_id == current_row_id)
        .map(|row| row.tab)
        .unwrap_or(state.playlist_context.pgm_tab);
    let operational_count = operational_rows_in_tab(state, current_tab);
    let min_remaining = state
        .playlist_mode
        .remove_played_protection_min_remaining
        .max(1);
    let protected =
        state.playlist_mode.remove_played_protection_enabled && operational_count <= min_remaining;
    if protected {
        state.playlist_mode.remove_played = false;
        emit_playlist_mode_changed(state, "remove-protection");
        return;
    }
    emit_playlist_action("removeRow", current_row_id, current_player);
    state
        .playlist_rows
        .retain(|row| row.row_id != current_row_id);
    if state.playlist_mode.remove_played_protection_enabled
        && operational_count.saturating_sub(1) <= min_remaining
    {
        state.playlist_mode.remove_played = false;
        emit_playlist_mode_changed(state, "remove-protection");
    }
}

fn dispatch_playlist_destination(row: Option<PlaylistRowState>, current_player: &str) {
    if let Some(row) = row {
        if row.row_type == "random" {
            emit_playlist_action("resolveRandom", &row.row_id, current_player);
        } else if row.row_type == "stop" {
            emit_playlist_action("stop", &row.row_id, current_player);
        } else {
            emit_playlist_action("playRow", &row.row_id, current_player);
        }
    } else {
        emit_playlist_action("stop", "", current_player);
    }
}

/// Procesa la finalización de un player en la playlist: decide repeat, auto-advance
/// o stop según los modos activos. Emite las acciones correspondientes al frontend.
pub(crate) fn process_playlist_finished(state: &mut EngineState, player_id: &str, force: bool) {
    let current_row_id = state.playlist_context.current_row_id.clone();
    if current_row_id.is_empty() {
        return;
    }
    let current_player = if player_id.is_empty() {
        state.playlist_context.current_player.clone()
    } else {
        player_id.to_string()
    };
    if !state.playlist_context.current_player.is_empty()
        && !current_player.is_empty()
        && state.playlist_context.current_player != current_player
    {
        return;
    }
    let finish_key = format!("{}|{}", current_row_id, current_player);
    if !force && state.playlist_context.last_finished_key == finish_key {
        return;
    }
    state.playlist_context.last_finished_key = finish_key;

    if state.playlist_mode.repeat_track {
        let mut deactivate_after_repeat = false;
        if let Some(runtime) = state.players.get_mut(&current_player) {
            let next_count = runtime.state.repeat_count.saturating_add(1);
            runtime.state.repeat_count = next_count;
            deactivate_after_repeat = state.playlist_mode.repeat_forget_protection_enabled
                && next_count >= state.playlist_mode.repeat_forget_protection_max.max(1);
            if deactivate_after_repeat {
                runtime.state.repeat_active = false;
            }
        }
        emit_playlist_action("playRow", &current_row_id, &current_player);
        if deactivate_after_repeat {
            state.playlist_mode.repeat_track = false;
            emit_playlist_mode_changed(state, "repeat-limit");
        }
        return;
    }

    let next_row = decide_next_playlist_row(state, &current_row_id);
    emit_remove_played_if_allowed(state, &current_row_id, &current_player);
    dispatch_playlist_destination(next_row, &current_player);
}

/// Procesa un "siguiente manual" del operador: desactiva repeat si aplica,
/// elimina la fila si remove-played, y avanza a la siguiente.
pub(crate) fn process_playlist_manual_next(state: &mut EngineState, player_id: &str) {
    let current_row_id = state.playlist_context.current_row_id.clone();
    if current_row_id.is_empty() {
        return;
    }
    let current_player = if player_id.is_empty() {
        state.playlist_context.current_player.clone()
    } else {
        player_id.to_string()
    };
    emit_remove_played_if_allowed(state, &current_row_id, &current_player);
    if state.playlist_mode.repeat_track && state.playlist_mode.repeat_disable_on_manual_next {
        state.playlist_mode.repeat_track = false;
        for runtime in state.players.values_mut() {
            runtime.state.repeat_active = false;
            runtime.state.repeat_count = 0;
        }
        emit_playlist_mode_changed(state, "manual-next");
    }
    let next_row = decide_next_playlist_row(state, &current_row_id);
    state.playlist_context.last_finished_key.clear();
    dispatch_playlist_destination(next_row, &current_player);
}
