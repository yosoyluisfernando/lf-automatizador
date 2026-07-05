use crate::protocol::{now_ms, IncomingCommand};
use crate::state::EngineState;

pub(crate) fn update_encoder_status(state: &mut EngineState, ic: &IncomingCommand) {
    let action = ic.action.as_deref().unwrap_or("status");
    if action == "stop" {
        state.encoder.active = false;
        state.encoder.bitrate_kbps = 0.0;
        state.encoder.speed = 0.0;
        state.encoder.ffmpeg_time.clear();
        state.encoder.max_gap_ms = 0.0;
        state.encoder.gap_warnings = 0;
        state.encoder.input_peak_db = -120.0;
        state.encoder.input_rms_db = -120.0;
        state.encoder.input_meter_updated_at = 0;
    } else if action == "start" {
        state.encoder.active = true;
    }
    state.encoder.source_bus = ic
        .source
        .clone()
        .or_else(|| ic.source_bus.clone())
        .unwrap_or_else(|| state.encoder.source_bus.clone());
    state.encoder.owner = ic
        .owner
        .clone()
        .unwrap_or_else(|| state.encoder.owner.clone());
    state.encoder.requested_owner = ic
        .requested_owner
        .clone()
        .unwrap_or_else(|| state.encoder.requested_owner.clone());
    state.encoder.capture_provider = ic
        .capture_provider
        .clone()
        .unwrap_or_else(|| state.encoder.capture_provider.clone());
    state.encoder.encoder_provider = ic
        .encoder_provider
        .clone()
        .unwrap_or_else(|| state.encoder.encoder_provider.clone());
    state.encoder.rust_pcm_ready = ic.rust_pcm_ready.unwrap_or(state.encoder.rust_pcm_ready);
    state.encoder.pcm_bridge_ready = ic
        .pcm_bridge_ready
        .unwrap_or(state.encoder.pcm_bridge_ready);
    state.encoder.pcm_bridge_mode = ic
        .pcm_bridge_mode
        .clone()
        .unwrap_or_else(|| state.encoder.pcm_bridge_mode.clone());
    state.encoder.pcm_bridge_reason = ic
        .pcm_bridge_reason
        .clone()
        .unwrap_or_else(|| state.encoder.pcm_bridge_reason.clone());
    state.encoder.fallback_reason = ic
        .fallback_reason
        .clone()
        .unwrap_or_else(|| state.encoder.fallback_reason.clone());
    state.encoder.capture_format = ic
        .capture_format
        .clone()
        .unwrap_or_else(|| state.encoder.capture_format.clone());
    state.encoder.sample_rate = ic
        .sample_rate
        .map(|v| v as u64)
        .unwrap_or(state.encoder.sample_rate);
    state.encoder.transport = ic
        .transport
        .clone()
        .unwrap_or_else(|| state.encoder.transport.clone());
    state.encoder.bitrate_kbps = ic.bitrate_kbps.unwrap_or(state.encoder.bitrate_kbps);
    state.encoder.speed = ic.speed.unwrap_or(state.encoder.speed);
    state.encoder.ffmpeg_time = ic
        .ffmpeg_time
        .clone()
        .unwrap_or_else(|| state.encoder.ffmpeg_time.clone());
    state.encoder.max_gap_ms = ic.max_gap_ms.unwrap_or(state.encoder.max_gap_ms);
    state.encoder.gap_warnings = ic.gap_warnings.unwrap_or(state.encoder.gap_warnings);
    state.encoder.updated_at = now_ms();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_clears_encoder_state() {
        let mut state = EngineState::default();
        state.encoder.active = true;
        state.encoder.bitrate_kbps = 128.0;
        state.encoder.speed = 1.0;
        state.encoder.ffmpeg_time = "00:05:00".to_string();
        let ic = IncomingCommand {
            action: Some("stop".to_string()),
            ..Default::default()
        };
        update_encoder_status(&mut state, &ic);
        assert!(!state.encoder.active);
        assert_eq!(state.encoder.bitrate_kbps, 0.0);
        assert_eq!(state.encoder.speed, 0.0);
        assert!(state.encoder.ffmpeg_time.is_empty());
        assert_eq!(state.encoder.input_peak_db, -120.0);
    }

    #[test]
    fn start_activates_encoder() {
        let mut state = EngineState::default();
        assert!(!state.encoder.active);
        let ic = IncomingCommand {
            action: Some("start".to_string()),
            owner: Some("rustAudioEngine".to_string()),
            ..Default::default()
        };
        update_encoder_status(&mut state, &ic);
        assert!(state.encoder.active);
        assert_eq!(state.encoder.owner, "rustAudioEngine");
    }

    #[test]
    fn none_fields_preserve_existing_values() {
        let mut state = EngineState::default();
        state.encoder.owner = "rustAudioEngine".to_string();
        state.encoder.sample_rate = 48000;
        let ic = IncomingCommand::default();
        update_encoder_status(&mut state, &ic);
        assert_eq!(state.encoder.owner, "rustAudioEngine");
        assert_eq!(state.encoder.sample_rate, 48000);
    }
}
