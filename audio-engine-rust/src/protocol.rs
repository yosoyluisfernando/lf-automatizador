// Protocolo IPC: parsing de comandos JSON entrantes (stdin) y helpers de emisión.
//
// IncomingCommand es la struct plana con campos Option<T> que cubre todos
// los comandos posibles del frontend. Se deserializa con serde_json; los campos
// ausentes quedan como None. El dispatch en main.rs usa `ic.effective_module()`
// para decidir qué módulo maneja el comando.
//
// Helpers compartidos: `now_ms`, `escape_json`, `request_id_field`, `emit_error`.

use serde::Deserialize;
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn request_id_field(request_id: &str) -> String {
    if request_id.is_empty() {
        String::new()
    } else {
        format!("\"requestId\":\"{}\",", escape_json(request_id))
    }
}

pub(crate) fn emit_error(message: &str, request_id: &str) {
    println!(
        "{{{}\"type\":\"error\",\"engine\":\"rustAudio\",\"message\":\"{}\",\"updatedAt\":{}}}",
        request_id_field(request_id),
        escape_json(message),
        now_ms()
    );
    let _ = io::stdout().flush();
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IncomingCommand {
    #[serde(default)]
    pub module: String,
    #[serde(default)]
    pub cmd: String,
    #[serde(default)]
    pub request_id: String,
    #[serde(default = "default_player")]
    pub player: String,

    // ── Audio load/play ──
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub gain: Option<f32>,
    #[serde(default)]
    pub output_id: Option<String>,
    #[serde(default)]
    pub bus: Option<String>,
    #[serde(default)]
    pub cache_dir: Option<String>,
    #[serde(default)]
    pub autoplay: Option<bool>,

    // ── Sequences (cartwallSequence, loadSequence, cacheDuration) ──
    #[serde(default)]
    pub paths: Option<Vec<String>>,

    // ── Seek / repeat ──
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub start_ms: Option<u64>,
    #[serde(default)]
    pub enabled: Option<bool>,

    // ── Fade ──
    #[serde(default)]
    pub from_gain: Option<f32>,
    #[serde(default)]
    pub to_gain: Option<f32>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub seconds: Option<f32>,
    #[serde(default)]
    pub stop_after: Option<bool>,

    // ── Route ──
    #[serde(default)]
    pub source_mode: Option<String>,

    // ── FX (EQ/Comp/Limiter) ──
    #[serde(default)]
    pub eq: Option<bool>,
    #[serde(default)]
    pub comp: Option<bool>,
    #[serde(default)]
    pub limiter: Option<bool>,
    #[serde(default)]
    pub preamp_db: Option<f32>,
    #[serde(default)]
    pub pan: Option<f32>,
    #[serde(default)]
    pub mono: Option<bool>,
    #[serde(default)]
    pub bands: Option<Vec<f32>>,
    #[serde(default)]
    pub order: Option<Vec<String>>,

    // ── Encoder tap ──
    #[serde(default)]
    pub enable: Option<bool>,

    // ── getPeaks ──
    #[serde(default)]
    pub bins: Option<u64>,

    // ── Time locution ──
    #[serde(default)]
    pub folder: Option<String>,

    // ── Stream (PCM injection) ──
    #[serde(default)]
    pub channels: Option<u16>,
    #[serde(default)]
    pub channel_map: Option<Vec<u16>>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub ring_buffer_seconds: Option<f32>,
    #[serde(default)]
    pub frames: Option<u64>,
    #[serde(default)]
    pub data: Option<String>,

    // ── Input engine ──
    #[serde(default)]
    pub device_id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub source_id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub consumer: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub target: Option<String>,

    // ── nowPlaying ──
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub source: Option<String>,

    // ── transport ──
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub start_cause: Option<String>,
    #[serde(default)]
    pub mix_active: Option<bool>,
    #[serde(default)]
    pub mix_phase: Option<String>,
    #[serde(default)]
    pub mix_direction: Option<String>,
    #[serde(default)]
    pub mix_reference_player: Option<String>,

    // ── playlistSnapshot ──
    #[serde(default)]
    pub rows: Option<Vec<PlaylistRowIn>>,

    // ── playlistMode ──
    #[serde(default)]
    pub repeat_track: Option<bool>,
    #[serde(default)]
    pub remove_played: Option<bool>,
    #[serde(default)]
    pub loop_playlist: Option<bool>,
    #[serde(default)]
    pub repeat_forget_protection_enabled: Option<bool>,
    #[serde(default)]
    pub repeat_forget_protection_max: Option<u64>,
    #[serde(default)]
    pub repeat_disable_on_manual_next: Option<bool>,
    #[serde(default)]
    pub remove_played_protection_enabled: Option<bool>,
    #[serde(default)]
    pub remove_played_protection_min_remaining: Option<u64>,

    // ── playlistPlaybackContext ──
    #[serde(default)]
    pub current_row_id: Option<String>,
    #[serde(default)]
    pub current_player: Option<String>,
    #[serde(default)]
    pub queued_row_id: Option<String>,
    #[serde(default)]
    pub pgm_tab: Option<u64>,

    // ── encoder ──
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub capture_provider: Option<String>,

    // ── encoder sync (campos adicionales del comando "encoder") ──
    #[serde(default)]
    pub source_bus: Option<String>,
    #[serde(default)]
    pub requested_owner: Option<String>,
    #[serde(default)]
    pub encoder_provider: Option<String>,
    #[serde(default)]
    pub rust_pcm_ready: Option<bool>,
    #[serde(default)]
    pub pcm_bridge_ready: Option<bool>,
    #[serde(default)]
    pub pcm_bridge_mode: Option<String>,
    #[serde(default)]
    pub pcm_bridge_reason: Option<String>,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub capture_format: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub bitrate_kbps: Option<f32>,
    #[serde(default)]
    pub speed: Option<f32>,
    #[serde(default)]
    pub ffmpeg_time: Option<String>,
    #[serde(default)]
    pub max_gap_ms: Option<f32>,
    #[serde(default)]
    pub gap_warnings: Option<u64>,

    // ── encoder module (Fase 1) ──
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server_type: Option<String>,
    #[serde(default, rename = "type")]
    pub encoder_type: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<String>,
    #[serde(default)]
    pub admin_port: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub pass: Option<String>,
    #[serde(default)]
    pub mount: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub bitrate: Option<String>,
    #[serde(default)]
    pub legacy: Option<bool>,
    #[serde(default)]
    pub icy_name: Option<String>,
    #[serde(default)]
    pub icy_genre: Option<String>,
    #[serde(default)]
    pub icy_url: Option<String>,
    #[serde(default)]
    pub icy_public: Option<bool>,
    #[serde(default)]
    pub fdk_available: Option<bool>,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub local_null: Option<bool>,

    // ── recorder module ──
    #[serde(default)]
    pub recorder_id: Option<String>,
    #[serde(default)]
    pub recorder_sources: Option<Vec<String>>,
    #[serde(default)]
    pub recorder_source: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub naming: Option<String>,
    #[serde(default)]
    pub naming_prefix: Option<String>,
    #[serde(default)]
    pub split_minutes: Option<u32>,
    #[serde(default)]
    pub split_hours: Option<u32>,
    #[serde(default)]
    pub pre_roll_seconds: Option<u32>,
    #[serde(default)]
    pub playlist_name: Option<String>,
}

fn default_player() -> String {
    "probe".to_string()
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistRowIn {
    #[serde(default)]
    pub row_id: String,
    #[serde(default)]
    pub tab: u64,
    #[serde(default)]
    pub order: u64,
    #[serde(default, rename = "type")]
    pub row_type: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub title: String,
}

impl IncomingCommand {
    pub fn parse(line: &str) -> Result<Self, String> {
        serde_json::from_str(line).map_err(|e| format!("JSON parse error: {}", e))
    }

    pub fn path_or(&self, fallback: &str) -> String {
        self.path.as_deref().unwrap_or(fallback).to_string()
    }

    pub fn gain_or(&self, fallback: f32) -> f32 {
        self.gain.unwrap_or(fallback)
    }

    pub fn output_id_or(&self, fallback: &str) -> String {
        self.output_id.as_deref().unwrap_or(fallback).to_string()
    }

    pub fn bus_or(&self, fallback: &str) -> String {
        self.bus.as_deref().unwrap_or(fallback).to_string()
    }

    pub fn cache_dir_or_empty(&self) -> String {
        self.cache_dir.as_deref().unwrap_or("").to_string()
    }

    pub fn effective_module(&self) -> &str {
        if self.module.is_empty() {
            "audio"
        } else {
            &self.module
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_play_command() {
        let json = r#"{"cmd":"play","player":"player-a","requestId":"r1"}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.cmd, "play");
        assert_eq!(cmd.player, "player-a");
        assert_eq!(cmd.request_id, "r1");
        assert_eq!(cmd.effective_module(), "audio");
    }

    #[test]
    fn parse_load_audio_command() {
        let json = r#"{"cmd":"loadAudio","player":"player-a","path":"C:\\Music\\track.mp3","gain":0.8,"bus":"master","outputId":"default","autoplay":true}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.cmd, "loadAudio");
        assert_eq!(cmd.path.as_deref(), Some("C:\\Music\\track.mp3"));
        assert_eq!(cmd.gain, Some(0.8));
        assert_eq!(cmd.bus.as_deref(), Some("master"));
        assert_eq!(cmd.autoplay, Some(true));
    }

    #[test]
    fn parse_fx_command() {
        let json = r#"{"cmd":"fx","eq":true,"comp":false,"limiter":true,"preampDb":3.0,"pan":-0.5,"mono":false,"bands":[0,1.5,-2,0,0,3,-1,0],"order":["eq","comp","limiter"]}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.eq, Some(true));
        assert_eq!(cmd.comp, Some(false));
        assert_eq!(cmd.limiter, Some(true));
        assert_eq!(cmd.preamp_db, Some(3.0));
        assert_eq!(cmd.bands.as_ref().map(|b| b.len()), Some(8));
        assert_eq!(cmd.order.as_ref().map(|o| o.len()), Some(3));
    }

    #[test]
    fn parse_playlist_snapshot() {
        let json = r#"{"cmd":"playlistSnapshot","rows":[{"rowId":"r1","tab":0,"order":0,"type":"normal","path":"/a.mp3","title":"A"},{"rowId":"r2","tab":0,"order":1,"type":"normal","path":"/b.mp3","title":"B"}]}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        let rows = cmd.rows.as_ref().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].row_id, "r1");
        assert_eq!(rows[1].path, "/b.mp3");
    }

    #[test]
    fn parse_with_module_field() {
        let json = r#"{"module":"encoder","cmd":"startServer","serverId":"s1"}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.effective_module(), "encoder");
        assert_eq!(cmd.cmd, "startServer");
    }

    #[test]
    fn parse_missing_player_defaults_to_probe() {
        let json = r#"{"cmd":"status"}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.player, "probe");
    }

    #[test]
    fn parse_stream_start() {
        let json = r#"{"cmd":"stream_start","bus":"master","gain":1.0,"outputId":"default","channels":2,"sampleRate":44100,"ringBufferSeconds":5.0}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.channels, Some(2));
        assert_eq!(cmd.sample_rate, Some(44100));
        assert_eq!(cmd.ring_buffer_seconds, Some(5.0));
    }

    #[test]
    fn parse_encoder_config_fields() {
        let json = r#"{"module":"encoder","cmd":"validateConfig","serverId":"s1","serverType":"icecast","ip":"radio.example.com","port":"8000","user":"source","password":"secret","mount":"/live","codec":"mp3","bitrate":"128"}"#;
        let cmd = IncomingCommand::parse(json).unwrap();
        assert_eq!(cmd.effective_module(), "encoder");
        assert_eq!(cmd.server_id.as_deref(), Some("s1"));
        assert_eq!(cmd.server_type.as_deref(), Some("icecast"));
        assert_eq!(cmd.ip.as_deref(), Some("radio.example.com"));
        assert_eq!(cmd.mount.as_deref(), Some("/live"));
    }

    #[test]
    fn malformed_json_returns_error() {
        let result = IncomingCommand::parse("{broken");
        assert!(result.is_err());
    }

    #[test]
    fn escape_json_handles_special_chars() {
        assert_eq!(escape_json(r#"hello "world""#), r#"hello \"world\""#);
        assert_eq!(escape_json("back\\slash"), "back\\\\slash");
        assert_eq!(escape_json("new\nline"), "new\\nline");
    }

    #[test]
    fn request_id_field_empty() {
        assert_eq!(request_id_field(""), "");
    }

    #[test]
    fn request_id_field_present() {
        assert_eq!(request_id_field("r1"), "\"requestId\":\"r1\",");
    }
}
