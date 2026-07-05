mod codec_frames;
mod config;
mod error;
mod ffmpeg;
mod manager;
mod metadata;
mod pcm;
mod process;
mod shoutcast;
mod shoutcast_transport;
mod status;
mod telemetry;
mod ultravox;
mod ultravox_transport;

use std::io::{self, Write};

pub(crate) use manager::EncoderManager;
pub(crate) use status::update_encoder_status;

use crate::protocol::{emit_error, escape_json, now_ms, request_id_field, IncomingCommand};
use crate::state::EngineState;

use config::{EncoderServerConfig, ServerType};
use error::{EncoderError, EncoderErrorCategory};
use ffmpeg::FfmpegPlan;
use metadata::{write_now_playing_file, MetadataUpdatePlan};
use pcm::sine_pcm_s16le;
use process::FfmpegProcessSpec;
use shoutcast::ShoutcastHandshakePlan;
use shoutcast_transport::{EncoderTransport, ShoutcastTransport};
use ultravox_transport::UltravoxTransport;

pub(crate) fn handle_encoder_command(_state: &mut EngineState, ic: &IncomingCommand) {
    match ic.cmd.as_str() {
        "validateConfig" => emit_validate_config(ic),
        "planFfmpeg" => emit_ffmpeg_plan(ic),
        "planShoutcastHandshake" => emit_shoutcast_handshake_plan(ic),
        "processSpec" => emit_process_spec(ic),
        "setServerStatus" => emit_set_server_status(_state, ic),
        "serverSnapshot" => emit_server_snapshot(_state, ic),
        "startIcecast" => emit_start_icecast(_state, ic),
        "startShoutcast" => emit_start_shoutcast(_state, ic),
        "startLocalNull" => emit_start_local_null(_state, ic),
        "stopServer" => emit_stop_server(_state, ic),
        "writeSyntheticPcm" => emit_write_synthetic_pcm(_state, ic),
        "updateMetadata" => emit_update_metadata(ic),
        "" => emit_error("encoder: comando vacio.", &ic.request_id),
        other => emit_error(
            &format!("encoder: comando no soportado: {}", other),
            &ic.request_id,
        ),
    }
}

fn emit_update_metadata(ic: &IncomingCommand) {
    let text = ic.message.as_deref().unwrap_or("");
    let file_result = write_now_playing_file(ic.path.as_deref().unwrap_or(""), text);
    if ic.server_type.as_deref().unwrap_or("").trim().is_empty()
        && ic.encoder_type.as_deref().unwrap_or("").trim().is_empty()
    {
        match file_result {
            Ok(()) => {
                println!(
                    "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"updateMetadata\",\"ok\":true,\"status\":0,\"localOnly\":true,\"updatedAt\":{}}}",
                    request_id_field(&ic.request_id),
                    now_ms()
                );
                let _ = io::stdout().flush();
            }
            Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
        }
        return;
    }
    let remote_result = EncoderServerConfig::from_command(ic)
        .map(|config| MetadataUpdatePlan::from_config(&config, text))
        .and_then(|plan| plan.send());
    match file_result.and(remote_result) {
        Ok(status) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"updateMetadata\",\"ok\":true,\"status\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                status,
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_write_synthetic_pcm(state: &mut EngineState, ic: &IncomingCommand) {
    let server_id = ic.server_id.as_deref().unwrap_or("0");
    let sample_rate = ic.sample_rate.unwrap_or(44100).clamp(8000, 192000);
    let duration_ms = ic.duration_ms.unwrap_or(100).clamp(1, 10_000);
    let pcm = sine_pcm_s16le(sample_rate, 2, duration_ms, 440.0, 0.1);
    match state.encoder_servers.write_pcm(server_id, &pcm) {
        Ok(bytes) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"writeSyntheticPcm\",\"ok\":true,\"serverId\":\"{}\",\"bytes\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(server_id),
                bytes,
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_start_icecast(state: &mut EngineState, ic: &IncomingCommand) {
    let result = build_icecast_process_spec(ic).and_then(|(server_id, spec)| {
        let pid = state
            .encoder_servers
            .start_process(&server_id, "icecast", &spec)?;
        if let Err(err) = start_input_route_if_requested(state, ic, &server_id) {
            let _ = state.encoder_servers.stop_process(&server_id);
            return Err(err);
        }
        Ok((server_id, pid))
    });
    match result {
        Ok((server_id, pid)) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"startIcecast\",\"ok\":true,\"serverId\":\"{}\",\"pid\":{},\"servers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&server_id),
                pid,
                state.encoder_servers.snapshot_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn build_icecast_process_spec(
    ic: &IncomingCommand,
) -> Result<(String, FfmpegProcessSpec), EncoderError> {
    let ffmpeg_path = ic.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    let config = EncoderServerConfig::from_command(ic)?;
    if config.server_type != ServerType::Icecast {
        return Err(EncoderError::config(
            "startIcecast requiere serverType icecast.",
        ));
    }
    let server_id = config.server_id.clone();
    let plan = FfmpegPlan::from_config(&config);
    Ok((server_id, FfmpegProcessSpec::from_plan(ffmpeg_path, plan)))
}

fn emit_start_shoutcast(state: &mut EngineState, ic: &IncomingCommand) {
    let result = build_shoutcast_process_spec(ic).and_then(|(server_id, spec, transport)| {
        let pid = state
            .encoder_servers
            .start_shoutcast_process(&server_id, &spec, transport)?;
        if let Err(err) = start_input_route_if_requested(state, ic, &server_id) {
            let _ = state.encoder_servers.stop_process(&server_id);
            return Err(err);
        }
        Ok((server_id, pid))
    });
    match result {
        Ok((server_id, pid)) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"startShoutcast\",\"ok\":true,\"serverId\":\"{}\",\"pid\":{},\"servers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&server_id),
                pid,
                state.encoder_servers.snapshot_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn build_shoutcast_process_spec(
    ic: &IncomingCommand,
) -> Result<(String, FfmpegProcessSpec, EncoderTransport), EncoderError> {
    let ffmpeg_path = ic.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    let config = EncoderServerConfig::from_command(ic)?;
    if config.server_type == ServerType::Icecast {
        return Err(EncoderError::config(
            "startShoutcast requiere serverType shoutcast o shoutcast2.",
        ));
    }
    let server_id = config.server_id.clone();
    let plan = FfmpegPlan::from_config(&config);
    let spec = FfmpegProcessSpec::from_plan(ffmpeg_path, plan);
    let transport = if config.server_type == ServerType::Shoutcast2 && !config.legacy {
        EncoderTransport::Ultravox(UltravoxTransport::connect(&config)?)
    } else {
        EncoderTransport::Shoutcast(ShoutcastTransport::connect(&config)?)
    };
    Ok((server_id, spec, transport))
}

fn emit_start_local_null(state: &mut EngineState, ic: &IncomingCommand) {
    let server_id = ic.server_id.as_deref().unwrap_or("0");
    let ffmpeg_path = ic.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    let result = EncoderServerConfig::from_command(ic)
        .map(|config| FfmpegPlan::from_config_with_local_null(&config, true))
        .map(|plan| FfmpegProcessSpec::from_plan(ffmpeg_path, plan))
        .and_then(|spec| {
            let pid = state
                .encoder_servers
                .start_process(server_id, "local-null", &spec)?;
            if let Err(err) = start_input_route_if_requested(state, ic, server_id) {
                let _ = state.encoder_servers.stop_process(server_id);
                return Err(err);
            }
            Ok(pid)
        });
    match result {
        Ok(pid) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"startLocalNull\",\"ok\":true,\"serverId\":\"{}\",\"pid\":{},\"servers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(server_id),
                pid,
                state.encoder_servers.snapshot_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_stop_server(state: &mut EngineState, ic: &IncomingCommand) {
    let server_id = ic.server_id.as_deref().unwrap_or("0");
    stop_input_route_for_server(state, server_id);
    match state.encoder_servers.stop_process(server_id) {
        Ok(()) => emit_server_snapshot(state, ic),
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

pub(crate) fn write_master_pcm_to_encoder_servers(
    state: &mut EngineState,
    bytes: &[u8],
) -> Result<usize, EncoderError> {
    let mut written_total = 0usize;
    for server_id in state.encoder_servers.active_server_ids() {
        if state.encoder_input_routes.contains_key(&server_id) {
            continue;
        }
        written_total =
            written_total.saturating_add(state.encoder_servers.write_pcm(&server_id, bytes)?);
    }
    Ok(written_total)
}

pub(crate) fn feed_input_encoder_routes(state: &mut EngineState) {
    prune_input_encoder_routes(state);
    let routes = state
        .encoder_input_routes
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for route in routes {
        let drained = match state.input.drain_consumer_id(&route.consumer_id, 4096) {
            Ok(drained) => drained,
            Err(_) => continue,
        };
        if drained.frames == 0 {
            continue;
        }
        state.encoder.input_peak_db = amp_to_db(drained.peak());
        state.encoder.input_rms_db = amp_to_db(drained.rms());
        state.encoder.input_meter_updated_at = now_ms();
        let bytes = drained.to_s16le_stereo_bytes();
        if bytes.is_empty() {
            continue;
        }
        if state
            .encoder_servers
            .write_pcm(&route.server_id, &bytes)
            .is_err()
        {
            stop_input_route_for_server(state, &route.server_id);
            let _ = state.encoder_servers.stop_process(&route.server_id);
        }
    }
}

fn start_input_route_if_requested(
    state: &mut EngineState,
    ic: &IncomingCommand,
    server_id: &str,
) -> Result<(), EncoderError> {
    let Some(device_id) = requested_input_device(ic) else {
        stop_input_route_for_server(state, server_id);
        return Ok(());
    };
    stop_input_route_for_server(state, server_id);
    let route = state
        .input
        .start_encoder_route(
            server_id,
            &device_id,
            ic.sample_rate,
            ic.channel_map.as_deref(),
        )
        .map_err(|message| EncoderError::new(&message, EncoderErrorCategory::Config, false))?;
    state
        .encoder_input_routes
        .insert(server_id.to_string(), route);
    Ok(())
}

fn requested_input_device(ic: &IncomingCommand) -> Option<String> {
    if ic.source.as_deref().unwrap_or("master") != "mic" {
        return None;
    }
    let value = ic
        .source_id
        .as_deref()
        .or(ic.device_id.as_deref())
        .unwrap_or("default")
        .trim();
    Some(if value.is_empty() {
        "default".to_string()
    } else {
        value.to_string()
    })
}

fn stop_input_route_for_server(state: &mut EngineState, server_id: &str) {
    if let Some(route) = state.encoder_input_routes.remove(server_id) {
        state.input.stop_consumer_route(&route);
    }
}

fn prune_input_encoder_routes(state: &mut EngineState) {
    let active = state.encoder_servers.active_server_ids();
    let stale = state
        .encoder_input_routes
        .keys()
        .filter(|server_id| !active.iter().any(|active_id| active_id == *server_id))
        .cloned()
        .collect::<Vec<_>>();
    for server_id in stale {
        stop_input_route_for_server(state, &server_id);
    }
}

fn amp_to_db(value: f32) -> f32 {
    let amp = value.abs().max(0.0);
    if amp <= 0.000_001 {
        -120.0
    } else {
        (20.0 * amp.log10()).max(-120.0)
    }
}

fn emit_set_server_status(state: &mut EngineState, ic: &IncomingCommand) {
    let server_id = ic.server_id.as_deref().unwrap_or("0");
    let status = ic.status.as_deref().unwrap_or("disconnected");
    let message = ic.message.as_deref().unwrap_or("");
    let mode = ic.transport.as_deref().unwrap_or("");
    match state
        .encoder_servers
        .set_status(server_id, status, mode, message)
    {
        Ok(()) => emit_server_snapshot(state, ic),
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_server_snapshot(state: &EngineState, ic: &IncomingCommand) {
    println!(
        "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"serverSnapshot\",\"servers\":[{}],\"updatedAt\":{}}}",
        request_id_field(&ic.request_id),
        state.encoder_servers.snapshot_json(),
        now_ms()
    );
    let _ = io::stdout().flush();
}

fn emit_ffmpeg_plan(ic: &IncomingCommand) {
    match EncoderServerConfig::from_command(ic).map(|config| {
        FfmpegPlan::from_config_with_local_null(&config, ic.local_null.unwrap_or(false))
    }) {
        Ok(plan) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"planFfmpeg\",\"ok\":true,\"mode\":\"{}\",\"ffmpegArgs\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                plan.mode.as_str(),
                strings_json(&plan.args),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_process_spec(ic: &IncomingCommand) {
    let ffmpeg_path = ic.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    let result = EncoderServerConfig::from_command(ic)
        .map(|config| {
            FfmpegPlan::from_config_with_local_null(&config, ic.local_null.unwrap_or(false))
        })
        .map(|plan| FfmpegProcessSpec::from_plan(ffmpeg_path, plan));
    match result {
        Ok(spec) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"processSpec\",\"ok\":true,\"program\":\"{}\",\"args\":[{}],\"stdin\":\"{}\",\"stdout\":\"{}\",\"stderr\":\"{}\",\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&spec.program),
                strings_json(&spec.args),
                spec.stdin.as_str(),
                spec.stdout.as_str(),
                spec.stderr.as_str(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn emit_shoutcast_handshake_plan(ic: &IncomingCommand) {
    match EncoderServerConfig::from_command(ic)
        .map(|config| ShoutcastHandshakePlan::from_config(&config))
    {
        Ok(plan) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"planShoutcastHandshake\",\"ok\":true,\"mode\":\"{}\",\"host\":\"{}\",\"port\":{},\"sid\":\"{}\",\"initialBytes\":{},\"postOkBytes\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                plan.mode.as_str(),
                escape_json(&plan.host),
                plan.port,
                escape_json(&plan.sid),
                plan.initial_bytes.len(),
                plan.post_ok_bytes.len(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

fn strings_json(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("\"{}\"", escape_json(value)))
        .collect::<Vec<_>>()
        .join(",")
}

fn emit_validate_config(ic: &IncomingCommand) {
    match EncoderServerConfig::from_command(ic) {
        Ok(config) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"encoder\",\"cmd\":\"validateConfig\",\"ok\":true,\"serverId\":\"{}\",\"serverType\":\"{}\",\"codec\":\"{}\",\"bitrate\":{},\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&config.server_id),
                config.server_type.as_str(),
                config.codec.as_str(),
                config.bitrate_kbps,
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err.to_operator_message(), &ic.request_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::IncomingCommand;

    #[test]
    fn validate_config_accepts_icecast() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"validateConfig","serverId":"main","serverType":"icecast","ip":"radio.example.com","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let config = EncoderServerConfig::from_command(&cmd).unwrap();
        assert_eq!(config.server_id, "main");
        assert_eq!(config.mount, "/live");
        assert_eq!(config.bitrate_kbps, 128);
    }

    #[test]
    fn validate_config_rejects_bad_sid() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"validateConfig","serverType":"shoutcast2","ip":"radio.example.com","port":"8000","password":"secret","mount":"abc","codec":"aac","bitrate":"96"}"#,
        ).unwrap();
        let err = EncoderServerConfig::from_command(&cmd).unwrap_err();
        assert_eq!(err.category.as_str(), "config");
        assert!(err.message.contains("Stream ID"));
    }

    #[test]
    fn ffmpeg_plan_for_icecast_includes_stream_url() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"planFfmpeg","serverType":"icecast","ip":"radio.example.com","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let config = EncoderServerConfig::from_command(&cmd).unwrap();
        let plan = FfmpegPlan::from_config(&config);
        assert_eq!(plan.mode.as_str(), "icecast");
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "icecast://source:secret@radio.example.com:8000/live"));
    }

    #[test]
    fn process_spec_uses_stdout_pipe_for_shoutcast() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"processSpec","ffmpegPath":"C:\\ffmpeg\\ffmpeg.exe","serverType":"shoutcast","ip":"radio.example.com","port":"8000","password":"secret","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let config = EncoderServerConfig::from_command(&cmd).unwrap();
        let plan = FfmpegPlan::from_config(&config);
        let spec = FfmpegProcessSpec::from_plan(cmd.ffmpeg_path.as_deref().unwrap(), plan);
        assert_eq!(spec.program, "C:\\ffmpeg\\ffmpeg.exe");
        assert_eq!(spec.stdout.as_str(), "pipe");
        assert_eq!(spec.stdin.as_str(), "pipe");
    }

    #[test]
    fn shoutcast_handshake_plan_uses_icy_legacy_for_classic() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"planShoutcastHandshake","serverType":"shoutcast","ip":"radio.example.com","port":"8000","password":"secret","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let config = EncoderServerConfig::from_command(&cmd).unwrap();
        let plan = ShoutcastHandshakePlan::from_config(&config);
        assert_eq!(plan.mode.as_str(), "icy-legacy");
        assert_eq!(plan.sid, "1");
        assert_eq!(plan.host, "radio.example.com");
    }

    #[test]
    fn start_icecast_builds_direct_process_spec() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"startIcecast","ffmpegPath":"C:\\ffmpeg\\ffmpeg.exe","serverId":"main","serverType":"icecast","ip":"radio.example.com","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let (server_id, spec) = build_icecast_process_spec(&cmd).unwrap();
        assert_eq!(server_id, "main");
        assert_eq!(spec.program, "C:\\ffmpeg\\ffmpeg.exe");
        assert_eq!(spec.stdout.as_str(), "ignore");
        assert!(spec
            .args
            .iter()
            .any(|arg| arg == "icecast://source:secret@radio.example.com:8000/live"));
    }

    #[test]
    fn start_icecast_rejects_shoutcast() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"startIcecast","serverType":"shoutcast","ip":"radio.example.com","port":"8000","password":"secret","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let err = build_icecast_process_spec(&cmd).unwrap_err();
        assert_eq!(err.category.as_str(), "config");
        assert!(err.message.contains("serverType icecast"));
    }

    #[test]
    fn start_shoutcast_rejects_icecast_before_network() {
        let cmd = IncomingCommand::parse(
            r#"{"module":"encoder","cmd":"startShoutcast","serverType":"icecast","ip":"radio.example.com","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        ).unwrap();
        let err = build_shoutcast_process_spec(&cmd).unwrap_err();
        assert_eq!(err.category.as_str(), "config");
        assert!(err.message.contains("serverType shoutcast"));
    }

    #[test]
    fn manager_snapshot_tracks_server_status() {
        let mut state = EngineState::default();
        state
            .encoder_servers
            .set_status("srv-1", "connecting", "icecast", "")
            .unwrap();
        state
            .encoder_servers
            .set_status("srv-1", "error", "icecast", "timeout")
            .unwrap();
        let snapshot = state.encoder_servers.snapshot_json();
        assert!(snapshot.contains("\"serverId\":\"srv-1\""));
        assert!(snapshot.contains("\"status\":\"error\""));
        assert!(snapshot.contains("\"message\":\"timeout\""));
    }
}
