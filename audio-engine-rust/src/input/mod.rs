mod capture;
mod config;
mod devices;
mod manager;
mod metering;
mod router;
mod source;

use std::io::{self, Write};
use std::sync::atomic::Ordering;

use crate::playback::start_pcm_stream_player;
use crate::protocol::{emit_error, escape_json, now_ms, request_id_field, IncomingCommand};
use crate::state::{EngineState, InputMeterRouteState};

pub(crate) use devices::emit_input_devices;
pub(crate) use manager::{InputConsumerRoute, InputManager};

pub(crate) fn handle_input_command(state: &mut EngineState, ic: &IncomingCommand) {
    match ic.cmd.as_str() {
        "devices" | "inputDevices" => emit_input_devices(&ic.request_id),
        "startDevice" => manager::emit_start_device(&mut state.input, ic),
        "stopDevice" => manager::emit_stop_device(&mut state.input, ic),
        "createSource" => manager::emit_create_source(&mut state.input, ic),
        "deleteSource" | "removeSource" => manager::emit_delete_source(&mut state.input, ic),
        "subscribe" => manager::emit_subscribe(&mut state.input, ic),
        "unsubscribe" => manager::emit_unsubscribe(&mut state.input, ic),
        "drainConsumer" => manager::emit_drain_consumer(&mut state.input, ic),
        "meterStart" | "previewStart" => emit_meter_start(state, ic),
        "meterStop" | "previewStop" => emit_meter_stop(state, ic),
        "pttStart" => emit_ptt_start(state, ic),
        "pttStop" => emit_ptt_stop(state, ic),
        "snapshot" | "inputSnapshot" => manager::emit_input_snapshot(&state.input, &ic.request_id),
        "" => emit_error("input: comando vacio.", &ic.request_id),
        other => emit_error(
            &format!("input: comando no soportado: {}", other),
            &ic.request_id,
        ),
    }
}

pub(crate) fn feed_input_meter_routes(state: &mut EngineState) {
    let meter_ids = state.input_meter_routes.keys().cloned().collect::<Vec<_>>();
    for meter_id in meter_ids {
        let Some(route) = state
            .input_meter_routes
            .get(&meter_id)
            .map(|meter| meter.route.clone())
        else {
            continue;
        };
        let drained = match state.input.drain_consumer_id(&route.consumer_id, 4096) {
            Ok(drained) => drained,
            Err(_) => continue,
        };
        if drained.frames == 0 {
            continue;
        }
        if let Some(meter) = state.input_meter_routes.get_mut(&meter_id) {
            meter.peak_db = amp_to_db(drained.peak());
            meter.rms_db = amp_to_db(drained.rms());
            meter.updated_at = now_ms();
        }
    }
}

pub(crate) fn process_ptt_duck(state: &mut EngineState) {
    if !state.ptt_duck.active {
        return;
    }
    let duration = state.ptt_duck.duration_ms.max(1) as f32;
    let elapsed = now_ms().saturating_sub(state.ptt_duck.started_at_ms) as f32;
    let t = (elapsed / duration).clamp(0.0, 1.0);
    let curved = t * t * (3.0 - (2.0 * t));
    let gain = state.ptt_duck.start_gain
        + ((state.ptt_duck.target_gain - state.ptt_duck.start_gain) * curved);
    set_master_gain(state, gain);
    if t >= 1.0 {
        state.ptt_duck.active = false;
        set_master_gain(state, state.ptt_duck.target_gain);
    }
}

fn amp_to_db(value: f32) -> f32 {
    if value <= 0.000001 {
        -120.0
    } else {
        (20.0 * value.log10()).max(-120.0)
    }
}

pub(crate) fn feed_ptt_route(state: &mut EngineState) {
    let Some(route) = state.ptt_input_route.clone() else {
        return;
    };
    let player_id = state.ptt_player_id.clone();
    let Some(producer) = state.stream_producers.get_mut(&player_id) else {
        return;
    };
    let drained = match state.input.drain_consumer_id(&route.consumer_id, 4096) {
        Ok(drained) => drained,
        Err(_) => return,
    };
    if drained.frames == 0 {
        return;
    }
    for sample in drained.to_f32_stereo_samples() {
        if producer.push(sample).is_err() {
            break;
        }
    }
}

fn emit_ptt_start(state: &mut EngineState, ic: &IncomingCommand) {
    stop_ptt(state);
    let player_id = state.ptt_player_id.clone();
    let route_to_master = ic.enable.unwrap_or(true)
        && ic
            .target
            .as_deref()
            .map(|value| value != "preview" && value != "meter")
            .unwrap_or(true);
    let requested_device = ic
        .device_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("default");
    let source_id = ic
        .source_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("ptt:input");
    let gain = ic.gain.unwrap_or(1.0).clamp(0.0, 2.0);
    let route = match state.input.start_consumer_route(
        "ptt",
        source_id,
        "ptt:program",
        "ptt",
        requested_device,
        ic.sample_rate.or(Some(44100)),
        ic.channel_map.as_deref(),
        Some(gain),
    ) {
        Ok(route) => route,
        Err(err) => {
            emit_error(&err, &ic.request_id);
            return;
        }
    };
    if route_to_master {
        let runtime = match start_pcm_stream_player(
            state,
            &player_id,
            "master",
            ic.output_id.as_deref().unwrap_or("default"),
            1.0,
            2,
            ic.sample_rate.unwrap_or(44100),
            ic.ring_buffer_seconds
                .map(|value| value as u32)
                .unwrap_or(2),
            true,
        ) {
            Ok(runtime) => runtime,
            Err(err) => {
                state.input.stop_consumer_route(&route);
                emit_error(&err, &ic.request_id);
                return;
            }
        };
        state
            .stream_producers
            .insert(player_id.clone(), runtime.producer);
        state
            .stream_finished_flags
            .insert(player_id.clone(), runtime.finished);
        if ic.to_gain.is_some() {
            start_ptt_duck(state, ic);
        }
    }
    state.ptt_input_route = Some(route.clone());
    println!(
        "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"pttStart\",\"ok\":true,\"player\":\"{}\",\"routeToMaster\":{},\"sourceId\":\"{}\",\"consumer\":\"{}\",\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        escape_json(&player_id),
        route_to_master,
        escape_json(&route.source_id),
        escape_json(&route.consumer_id),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn emit_meter_start(state: &mut EngineState, ic: &IncomingCommand) {
    let meter_id = ic
        .consumer
        .as_deref()
        .or(ic.target.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("input:preview")
        .trim()
        .to_string();
    stop_meter(state, &meter_id);
    let requested_device = ic
        .device_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("default");
    let source_id = format!("meter:{}:source", meter_id);
    let consumer_id = format!("meter:{}:consumer", meter_id);
    let route = match state.input.start_consumer_route(
        &meter_id,
        &source_id,
        &consumer_id,
        "meter",
        requested_device,
        ic.sample_rate.or(Some(44100)),
        ic.channel_map.as_deref(),
        ic.gain.or(Some(1.0)),
    ) {
        Ok(route) => route,
        Err(err) => {
            emit_error(&err, &ic.request_id);
            return;
        }
    };
    let label = ic
        .source_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&meter_id)
        .to_string();
    state.input_meter_routes.insert(
        meter_id.clone(),
        InputMeterRouteState::new(meter_id.clone(), label, route.clone()),
    );
    println!(
        "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"meterStart\",\"ok\":true,\"meterId\":\"{}\",\"sourceId\":\"{}\",\"consumer\":\"{}\",\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        escape_json(&meter_id),
        escape_json(&route.source_id),
        escape_json(&route.consumer_id),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn emit_meter_stop(state: &mut EngineState, ic: &IncomingCommand) {
    let meter_id = ic
        .consumer
        .as_deref()
        .or(ic.target.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("input:preview")
        .trim()
        .to_string();
    stop_meter(state, &meter_id);
    println!(
        "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"meterStop\",\"ok\":true,\"meterId\":\"{}\",\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        escape_json(&meter_id),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn emit_ptt_stop(state: &mut EngineState, ic: &IncomingCommand) {
    stop_ptt(state);
    println!(
        "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"pttStop\",\"ok\":true,\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn stop_meter(state: &mut EngineState, meter_id: &str) {
    if let Some(meter) = state.input_meter_routes.remove(meter_id) {
        state.input.stop_consumer_route(&meter.route);
    }
}

fn stop_ptt(state: &mut EngineState) {
    stop_ptt_duck(state);
    if let Some(route) = state.ptt_input_route.take() {
        state.input.stop_consumer_route(&route);
    }
    let player_id = state.ptt_player_id.clone();
    if let Some(finished) = state.stream_finished_flags.remove(&player_id) {
        finished.store(true, Ordering::Relaxed);
    }
    state.stream_producers.remove(&player_id);
    if let Some(runtime) = state.players.get_mut(&player_id) {
        if let Some(player) = runtime.player.take() {
            player.stop();
        }
        runtime.state.status = "stopped".to_string();
    }
}

fn start_ptt_duck(state: &mut EngineState, ic: &IncomingCommand) {
    let current = state.master_gain.clamp(0.0, 2.0);
    let target = ic.to_gain.unwrap_or(current).clamp(0.0, 2.0);
    let duration = ic.duration_ms.unwrap_or(500).clamp(0, 10_000);
    state.ptt_duck.active = true;
    state.ptt_duck.engaged = true;
    state.ptt_duck.restore_gain = current;
    state.ptt_duck.start_gain = current;
    state.ptt_duck.target_gain = target;
    state.ptt_duck.started_at_ms = now_ms();
    state.ptt_duck.duration_ms = duration;
}

fn stop_ptt_duck(state: &mut EngineState) {
    if !state.ptt_duck.engaged {
        return;
    }
    let restore = state.ptt_duck.restore_gain.clamp(0.0, 2.0);
    let current = state.master_gain.clamp(0.0, 2.0);
    let duration = state.ptt_duck.duration_ms;
    state.ptt_duck.engaged = false;
    state.ptt_duck.active = true;
    state.ptt_duck.start_gain = current;
    state.ptt_duck.target_gain = restore;
    state.ptt_duck.started_at_ms = now_ms();
    state.ptt_duck.duration_ms = duration;
}

fn set_master_gain(state: &mut EngineState, gain: f32) {
    let gain = gain.clamp(0.0, 2.0);
    state.master_gain = gain;
    state
        .dsp_params
        .master_gain_bits
        .store(gain.to_bits(), Ordering::Relaxed);
}
