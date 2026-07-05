mod config;
mod ffmpeg_output;
mod manager;
mod wav;

use std::io::{self, Write};

use crate::input::InputConsumerRoute;
use crate::protocol::{emit_error, escape_json, now_ms, request_id_field, IncomingCommand};
use crate::state::EngineState;

pub(crate) use manager::RecorderManager;

use config::{parse_recorder_config, RecorderSource};

pub(crate) fn handle_recorder_command(state: &mut EngineState, ic: &IncomingCommand) {
    match ic.cmd.as_str() {
        "start" => emit_start(state, ic),
        "stop" => emit_stop(state, ic),
        "snapshot" => emit_snapshot(state, ic),
        "list" => emit_list(state, ic),
        "" => emit_error("recorder: comando vacio.", &ic.request_id),
        other => emit_error(
            &format!("recorder: comando no soportado: {}", other),
            &ic.request_id,
        ),
    }
}

pub(crate) fn feed_recorder_routes(state: &mut EngineState) {
    let active_ids = state.recorder.active_ids();
    for recorder_id in active_ids {
        feed_one_recorder(state, &recorder_id);
    }
}

fn feed_one_recorder(state: &mut EngineState, recorder_id: &str) {
    let mut mixed_pcm: Vec<u8> = Vec::new();
    let mut total_frames: u64 = 0;
    let channels = state
        .recorder
        .sessions
        .get(recorder_id)
        .map(|s| s.config.channels)
        .unwrap_or(2);

    let needs_master = state.recorder.needs_master_tap(recorder_id);
    let needs_monitor = state.recorder.needs_monitor_tap(recorder_id);
    let input_routes = state.recorder.get_input_routes(recorder_id);

    if needs_master {
        let chunk = drain_bus_tap(state, "master", 4096);
        if !chunk.is_empty() {
            mix_into(&mut mixed_pcm, &chunk, channels);
            total_frames = total_frames.max((chunk.len() / (2 * channels as usize)) as u64);
        }
    }

    if needs_monitor {
        let chunk = drain_bus_tap(state, "monitor", 4096);
        if !chunk.is_empty() {
            mix_into(&mut mixed_pcm, &chunk, channels);
            total_frames = total_frames.max((chunk.len() / (2 * channels as usize)) as u64);
        }
    }

    for route in &input_routes {
        let drained = state.input.drain_consumer_id(&route.consumer_id, 4096);
        if let Ok(pcm) = drained {
            if pcm.frames > 0 {
                let bytes = pcm.to_s16le_stereo_bytes();
                if channels == 1 {
                    let mono = stereo_to_mono_s16le(&bytes);
                    mix_into(&mut mixed_pcm, &mono, channels);
                } else {
                    mix_into(&mut mixed_pcm, &bytes, channels);
                }
                total_frames = total_frames.max(pcm.frames as u64);
            }
        }
    }

    if total_frames > 0 && !mixed_pcm.is_empty() {
        let _ = state
            .recorder
            .write_pcm(recorder_id, &mixed_pcm, total_frames);
    }
}

fn drain_bus_tap(state: &mut EngineState, bus: &str, max_samples: usize) -> Vec<u8> {
    let consumer = match bus {
        "master" => state.recorder_master_tap.as_mut(),
        "monitor" => state.recorder_monitor_tap.as_mut(),
        _ => None,
    };
    let Some(consumer) = consumer else {
        return Vec::new();
    };
    let available = consumer.slots().min(max_samples);
    if available == 0 {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity(available * 2);
    let mut read = 0;
    while read < available {
        match consumer.pop() {
            Ok(sample) => {
                let clipped = sample.clamp(-1.0, 1.0);
                let i = (clipped * 32767.0) as i16;
                bytes.extend_from_slice(&i.to_le_bytes());
                read += 1;
            }
            Err(_) => break,
        }
    }
    bytes
}

fn mix_into(target: &mut Vec<u8>, source: &[u8], channels: u16) {
    let sample_bytes = 2usize;
    let frame_bytes = sample_bytes * channels as usize;

    if target.is_empty() {
        target.extend_from_slice(source);
        return;
    }

    let target_frames = target.len() / frame_bytes;
    let source_frames = source.len() / frame_bytes;
    let max_frames = target_frames.max(source_frames);

    if target.len() < max_frames * frame_bytes {
        target.resize(max_frames * frame_bytes, 0);
    }

    for i in 0..source.len().min(target.len()) / 2 {
        let offset = i * 2;
        if offset + 1 >= target.len() || offset + 1 >= source.len() {
            break;
        }
        let existing = i16::from_le_bytes([target[offset], target[offset + 1]]);
        let incoming = i16::from_le_bytes([source[offset], source[offset + 1]]);
        let mixed = (existing as i32 + incoming as i32).clamp(-32768, 32767) as i16;
        target[offset..offset + 2].copy_from_slice(&mixed.to_le_bytes());
    }
}

fn stereo_to_mono_s16le(stereo: &[u8]) -> Vec<u8> {
    let mut mono = Vec::with_capacity(stereo.len() / 2);
    let mut i = 0;
    while i + 3 < stereo.len() {
        let left = i16::from_le_bytes([stereo[i], stereo[i + 1]]);
        let right = i16::from_le_bytes([stereo[i + 2], stereo[i + 3]]);
        let mixed = ((left as i32 + right as i32) / 2).clamp(-32768, 32767) as i16;
        mono.extend_from_slice(&mixed.to_le_bytes());
        i += 4;
    }
    mono
}

fn emit_start(state: &mut EngineState, ic: &IncomingCommand) {
    let config = match parse_recorder_config(ic) {
        Ok(c) => c,
        Err(e) => {
            emit_error(&e, &ic.request_id);
            return;
        }
    };

    let recorder_id = config.recorder_id.clone();
    let sources = config.sources.clone();
    let playlist_name = ic.playlist_name.as_deref();

    let mut input_routes: Vec<InputConsumerRoute> = Vec::new();
    for source in &sources {
        if let RecorderSource::Input { device_id } = source {
            let source_id = format!("recorder:{}:input:{}", recorder_id, device_id);
            let consumer_id = format!("recorder:{}:consumer:{}", recorder_id, device_id);
            match state.input.start_consumer_route(
                &recorder_id,
                &source_id,
                &consumer_id,
                "recorder",
                device_id,
                Some(config.sample_rate),
                None,
                Some(1.0),
            ) {
                Ok(route) => input_routes.push(route),
                Err(e) => {
                    for r in &input_routes {
                        state.input.stop_consumer_route(r);
                    }
                    emit_error(&e, &ic.request_id);
                    return;
                }
            }
        }
    }

    match state.recorder.start(config, playlist_name) {
        Ok(id) => {
            if !input_routes.is_empty() {
                state.recorder.set_input_routes(&id, input_routes);
            }
            let snap = state.recorder.snapshot(&id);
            let current_file = snap
                .as_ref()
                .and_then(|s| s.current_file.as_deref())
                .unwrap_or("");
            let sources_json: Vec<String> = sources
                .iter()
                .map(|s| format!("\"{}\"", escape_json(s.label())))
                .collect();
            println!(
                "{{{}\"type\":\"response\",\"module\":\"recorder\",\"cmd\":\"start\",\"ok\":true,\"recorderId\":\"{}\",\"currentFile\":\"{}\",\"sources\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&id),
                escape_json(current_file),
                sources_json.join(","),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(e) => {
            for r in &input_routes {
                state.input.stop_consumer_route(r);
            }
            emit_error(&e, &ic.request_id);
        }
    }
}

fn emit_stop(state: &mut EngineState, ic: &IncomingCommand) {
    let recorder_id = ic
        .recorder_id
        .as_deref()
        .or(ic.consumer.as_deref())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("rec:default")
        .trim();

    let routes = state.recorder.get_input_routes(recorder_id);
    for r in &routes {
        state.input.stop_consumer_route(r);
    }

    match state.recorder.stop(recorder_id) {
        Ok(result) => {
            let last_file = result
                .last_file
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            println!(
                "{{{}\"type\":\"response\",\"module\":\"recorder\",\"cmd\":\"stop\",\"ok\":true,\"recorderId\":\"{}\",\"lastFile\":\"{}\",\"totalBytes\":{},\"totalFrames\":{},\"segments\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&result.recorder_id),
                escape_json(&last_file),
                result.total_bytes,
                result.total_frames,
                result.segments,
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(e) => emit_error(&e, &ic.request_id),
    }
}

fn emit_snapshot(state: &mut EngineState, ic: &IncomingCommand) {
    let recorder_id = ic
        .recorder_id
        .as_deref()
        .or(ic.consumer.as_deref())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("rec:default")
        .trim();

    match state.recorder.snapshot(recorder_id) {
        Some(snap) => {
            let sources_json: Vec<String> = snap
                .sources
                .iter()
                .map(|s| format!("\"{}\"", escape_json(s)))
                .collect();
            let file_str = snap.current_file.as_deref().unwrap_or("");
            println!(
                "{{{}\"type\":\"response\",\"module\":\"recorder\",\"cmd\":\"snapshot\",\"ok\":true,\"recorderId\":\"{}\",\"status\":\"{}\",\"format\":\"{}\",\"sources\":[{}],\"currentFile\":\"{}\",\"totalBytes\":{},\"totalFrames\":{},\"durationMs\":{},\"segmentIndex\":{},\"segmentDurationMs\":{},\"splitSeconds\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&snap.recorder_id),
                escape_json(&snap.status),
                escape_json(&snap.format),
                sources_json.join(","),
                escape_json(file_str),
                snap.total_bytes,
                snap.total_frames,
                snap.duration_ms,
                snap.segment_index,
                snap.segment_duration_ms,
                snap.split_seconds.map(|s| s.to_string()).unwrap_or_else(|| "null".to_string()),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        None => emit_error(
            &format!("Grabación no activa: {}", recorder_id),
            &ic.request_id,
        ),
    }
}

fn emit_list(state: &mut EngineState, ic: &IncomingCommand) {
    let snapshots = state.recorder.all_snapshots();
    let items: Vec<String> = snapshots
        .iter()
        .map(|s| {
            let sources_json: Vec<String> = s
                .sources
                .iter()
                .map(|src| format!("\"{}\"", escape_json(src)))
                .collect();
            format!(
                "{{\"recorderId\":\"{}\",\"status\":\"{}\",\"format\":\"{}\",\"sources\":[{}],\"durationMs\":{},\"totalBytes\":{}}}",
                escape_json(&s.recorder_id),
                escape_json(&s.status),
                escape_json(&s.format),
                sources_json.join(","),
                s.duration_ms,
                s.total_bytes
            )
        })
        .collect();
    println!(
        "{{{}\"type\":\"response\",\"module\":\"recorder\",\"cmd\":\"list\",\"ok\":true,\"recorders\":[{}],\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        items.join(","),
        now_ms()
    );
    let _ = io::stdout().flush();
}
