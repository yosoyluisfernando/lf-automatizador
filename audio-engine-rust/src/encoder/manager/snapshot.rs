use crate::protocol::{escape_json, now_ms};

use super::super::error::EncoderError;
use super::super::telemetry::FfmpegTelemetry;
use super::status::{EncoderServerRuntime, EncoderServerStatus};
use super::{normalize_server_id, EncoderManager};

impl EncoderManager {
    pub(crate) fn set_status(
        &mut self,
        server_id: &str,
        status: &str,
        mode: &str,
        message: &str,
    ) -> Result<(), EncoderError> {
        let server_id = normalize_server_id(server_id);
        let parsed = EncoderServerStatus::parse(status)?;
        if parsed == EncoderServerStatus::Disconnected {
            self.servers.remove(&server_id);
            return Ok(());
        }
        self.servers.insert(
            server_id.clone(),
            EncoderServerRuntime {
                server_id,
                status: parsed,
                mode: mode.trim().to_string(),
                message: message.trim().to_string(),
                pcm_bytes: 0,
                pcm_chunks: 0,
                bitrate_kbps: 0.0,
                speed: 0.0,
                ffmpeg_time: String::new(),
                updated_at: now_ms(),
            },
        );
        Ok(())
    }

    pub(super) fn apply_telemetry(&mut self, server_id: &str, telemetry: FfmpegTelemetry) {
        if let Some(server) = self.servers.get_mut(server_id) {
            if server.status == EncoderServerStatus::Connecting
                && (telemetry.bitrate_kbps.is_some()
                    || telemetry.speed.is_some()
                    || telemetry.ffmpeg_time.is_some())
            {
                server.status = EncoderServerStatus::Live;
            }
            if let Some(value) = telemetry.bitrate_kbps {
                server.bitrate_kbps = value;
            }
            if let Some(value) = telemetry.speed {
                server.speed = value;
            }
            if let Some(value) = telemetry.ffmpeg_time {
                server.ffmpeg_time = value;
            }
            server.updated_at = now_ms();
        }
    }

    pub(crate) fn snapshot_json(&self) -> String {
        let mut servers = self.servers.values().collect::<Vec<_>>();
        servers.sort_by(|a, b| a.server_id.cmp(&b.server_id));
        servers
            .into_iter()
            .map(|server| {
                format!(
                    "{{\"serverId\":\"{}\",\"status\":\"{}\",\"mode\":\"{}\",\"message\":\"{}\",\"pcmBytes\":{},\"pcmChunks\":{},\"bitrateKbps\":{},\"speed\":{},\"ffmpegTime\":\"{}\",\"updatedAt\":{}}}",
                    escape_json(&server.server_id),
                    server.status.as_str(),
                    escape_json(&server.mode),
                    escape_json(&server.message),
                    server.pcm_bytes,
                    server.pcm_chunks,
                    server.bitrate_kbps,
                    server.speed,
                    escape_json(&server.ffmpeg_time),
                    server.updated_at
                )
            })
            .collect::<Vec<_>>()
            .join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnected_removes_server_from_snapshot() {
        let mut manager = EncoderManager::default();
        manager
            .set_status("a", "connecting", "icecast", "")
            .unwrap();
        assert!(manager.snapshot_json().contains("\"serverId\":\"a\""));
        manager.set_status("a", "disconnected", "", "").unwrap();
        assert_eq!(manager.snapshot_json(), "");
    }

    #[test]
    fn rejects_unknown_status() {
        let mut manager = EncoderManager::default();
        let err = manager.set_status("a", "sleeping", "", "").unwrap_err();
        assert_eq!(err.category.as_str(), "config");
    }

    #[test]
    fn telemetry_updates_snapshot() {
        let mut manager = EncoderManager::default();
        manager
            .set_status("srv", "connecting", "local-null", "")
            .unwrap();
        manager.apply_telemetry(
            "srv",
            FfmpegTelemetry {
                bitrate_kbps: Some(127.8),
                speed: Some(1.02),
                ffmpeg_time: Some("00:00:03.12".to_string()),
            },
        );
        let snapshot = manager.snapshot_json();
        assert!(snapshot.contains("\"bitrateKbps\":127.8"));
        assert!(snapshot.contains("\"speed\":1.02"));
        assert!(snapshot.contains("\"ffmpegTime\":\"00:00:03.12\""));
        assert!(snapshot.contains("\"status\":\"live\""));
    }
}
