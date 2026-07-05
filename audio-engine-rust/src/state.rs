// Estado global del motor de audio.
//
// Contiene todas las structs que componen el estado mutable del engine:
// players activos, salidas de audio, rutas de buses, playlist, encoder,
// FX y el program_mixer. Cada módulo recibe `&mut EngineState` para
// leer y mutar el estado sin necesidad de locks (todo corre en el hilo
// principal del dispatch loop).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::Instant;

use rodio::mixer::Mixer;
use rodio::{MixerDeviceSink, Player, Sample};

use crate::dsp::DspParams;
use crate::encoder::EncoderManager;
use crate::input::{InputConsumerRoute, InputManager};
use crate::metering::PlayerMeter;
use crate::recorder::RecorderManager;

/// Estado persistente de un player individual (path, posición, gain, fade, repeat).
#[derive(Clone, Debug)]
pub(crate) struct PlayerState {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: u64,
    pub(crate) gain: f32,
    pub(crate) bus_id: String,
    pub(crate) output_device_id: String,
    pub(crate) output_device_name: String,
    pub(crate) repeat_active: bool,
    pub(crate) repeat_start_ms: u64,
    pub(crate) repeat_count: u64,
    pub(crate) fade_active: bool,
    pub(crate) fade_start_gain: f32,
    pub(crate) fade_target_gain: f32,
    pub(crate) fade_started_at_ms: u128,
    pub(crate) fade_duration_ms: u64,
    pub(crate) fade_stop_after: bool,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            path: String::new(),
            status: "stopped".to_string(),
            position_ms: 0,
            duration_ms: 0,
            gain: 1.0,
            bus_id: String::new(),
            output_device_id: String::new(),
            output_device_name: String::new(),
            repeat_active: false,
            repeat_start_ms: 0,
            repeat_count: 0,
            fade_active: false,
            fade_start_gain: 1.0,
            fade_target_gain: 1.0,
            fade_started_at_ms: 0,
            fade_duration_ms: 0,
            fade_stop_after: false,
        }
    }
}

/// Datos para reanudar un player tras un cambio de output (reset del program_mixer).
#[derive(Clone, Debug)]
pub(crate) struct PendingResumeSpec {
    pub(crate) player_id: String,
    pub(crate) path: String,
    pub(crate) position_ms: u64,
    pub(crate) gain: f32,
    pub(crate) bus_id: String,
    pub(crate) was_playing: bool,
}

/// Player en runtime: su estado lógico, el handle de rodio y su medidor de picos.
pub(crate) struct RuntimePlayer {
    pub(crate) state: PlayerState,
    pub(crate) player: Option<Player>,
    pub(crate) meter: Arc<PlayerMeter>,
}

impl Default for RuntimePlayer {
    fn default() -> Self {
        Self {
            state: PlayerState::default(),
            player: None,
            meter: Arc::new(PlayerMeter::default()),
        }
    }
}

/// Estado global del engine. Un solo EngineState existe durante toda la vida
/// del proceso; los módulos lo reciben como `&mut EngineState`.
pub(crate) struct EngineState {
    pub(crate) players: HashMap<String, RuntimePlayer>,
    pub(crate) outputs: HashMap<String, OutputRuntime>,
    pub(crate) routes: HashMap<String, RouteState>,
    pub(crate) now_playing: Option<NowPlayingState>,
    pub(crate) transport: Option<TransportState>,
    pub(crate) playlist_rows: Vec<PlaylistRowState>,
    pub(crate) playlist_mode: PlaylistModeState,
    pub(crate) playlist_context: PlaylistPlaybackContext,
    pub(crate) encoder: EncoderState,
    pub(crate) encoder_servers: EncoderManager,
    pub(crate) encoder_input_routes: HashMap<String, InputConsumerRoute>,
    pub(crate) ptt_input_route: Option<InputConsumerRoute>,
    pub(crate) ptt_player_id: String,
    pub(crate) input_meter_routes: HashMap<String, InputMeterRouteState>,
    pub(crate) ptt_duck: PttDuckState,
    pub(crate) input: InputManager,
    pub(crate) recorder: RecorderManager,
    pub(crate) master_gain: f32,
    pub(crate) monitor_gain: f32,
    pub(crate) fx: FxState,
    pub(crate) encoder_source_mode: String,
    pub(crate) time_locution_counter: Arc<AtomicU64>,
    pub(crate) time_locution_player: String,
    pub(crate) time_locution_started_at: Option<Instant>,
    pub(crate) time_locution_total_ms: u64,
    pub(crate) program_mixer_input: Option<Mixer>,
    pub(crate) program_mixer_sink_id: String,
    pub(crate) master_bus_meter: Arc<PlayerMeter>,
    pub(crate) monitor_tap_pre_consumer: Option<rtrb::Consumer<Sample>>,
    pub(crate) monitor_tap_post_consumer: Option<rtrb::Consumer<Sample>>,
    pub(crate) monitor_bus_meter: Arc<PlayerMeter>,
    pub(crate) monitor_sink_id: String,
    pub(crate) encoder_tap_pre_consumer: Option<rtrb::Consumer<Sample>>,
    pub(crate) encoder_tap_post_consumer: Option<rtrb::Consumer<Sample>>,
    pub(crate) encoder_tap_pre_drops: Arc<AtomicU64>,
    pub(crate) encoder_tap_post_drops: Arc<AtomicU64>,
    pub(crate) recorder_master_tap: Option<rtrb::Consumer<Sample>>,
    pub(crate) recorder_monitor_tap: Option<rtrb::Consumer<Sample>>,
    #[allow(dead_code)]
    pub(crate) dsp_params: Arc<DspParams>,
    pub(crate) pending_resume: Vec<PendingResumeSpec>,
    pub(crate) stream_producers: HashMap<String, rtrb::Producer<f32>>,
    pub(crate) stream_finished_flags: HashMap<String, Arc<AtomicBool>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            players: HashMap::new(),
            outputs: HashMap::new(),
            routes: HashMap::new(),
            now_playing: None,
            transport: None,
            playlist_rows: Vec::new(),
            playlist_mode: PlaylistModeState::default(),
            playlist_context: PlaylistPlaybackContext::default(),
            encoder: EncoderState::default(),
            encoder_servers: EncoderManager::default(),
            encoder_input_routes: HashMap::new(),
            ptt_input_route: None,
            ptt_player_id: "ptt:program".to_string(),
            input_meter_routes: HashMap::new(),
            ptt_duck: PttDuckState::default(),
            input: InputManager::default(),
            recorder: RecorderManager::default(),
            master_gain: 1.0,
            monitor_gain: 1.0,
            fx: FxState::default(),
            encoder_source_mode: "postFx".to_string(),
            time_locution_counter: Arc::new(AtomicU64::new(0)),
            time_locution_player: String::new(),
            time_locution_started_at: None,
            time_locution_total_ms: 0,
            program_mixer_input: None,
            program_mixer_sink_id: String::new(),
            master_bus_meter: Arc::new(PlayerMeter::default()),
            monitor_tap_pre_consumer: None,
            monitor_tap_post_consumer: None,
            monitor_bus_meter: Arc::new(PlayerMeter::default()),
            monitor_sink_id: String::new(),
            encoder_tap_pre_consumer: None,
            encoder_tap_post_consumer: None,
            encoder_tap_pre_drops: Arc::new(AtomicU64::new(0)),
            encoder_tap_post_drops: Arc::new(AtomicU64::new(0)),
            recorder_master_tap: None,
            recorder_monitor_tap: None,
            dsp_params: Arc::new(DspParams::default()),
            pending_resume: Vec::new(),
            stream_producers: HashMap::new(),
            stream_finished_flags: HashMap::new(),
        }
    }
}

/// Snapshot de la configuración de efectos (EQ, compresor, limiter) recibida del frontend.
/// Ruta de medicion/preview de entrada. Consume PCM desde `InputRouter` sin
/// transmitir ni mezclar; la UI la usa para probar microfonos antes de salir al aire.
#[derive(Clone, Debug)]
pub(crate) struct PttDuckState {
    pub(crate) active: bool,
    pub(crate) engaged: bool,
    pub(crate) restore_gain: f32,
    pub(crate) start_gain: f32,
    pub(crate) target_gain: f32,
    pub(crate) started_at_ms: u128,
    pub(crate) duration_ms: u64,
}

impl Default for PttDuckState {
    fn default() -> Self {
        Self {
            active: false,
            engaged: false,
            restore_gain: 1.0,
            start_gain: 1.0,
            target_gain: 1.0,
            started_at_ms: 0,
            duration_ms: 0,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct InputMeterRouteState {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) route: InputConsumerRoute,
    pub(crate) peak_db: f32,
    pub(crate) rms_db: f32,
    pub(crate) updated_at: u128,
}

impl InputMeterRouteState {
    pub(crate) fn new(id: String, label: String, route: InputConsumerRoute) -> Self {
        Self {
            id,
            label,
            route,
            peak_db: -120.0,
            rms_db: -120.0,
            updated_at: 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct FxState {
    pub(crate) eq: bool,
    pub(crate) comp: bool,
    pub(crate) limiter: bool,
    pub(crate) preamp_db: f32,
    pub(crate) pan: f32,
    pub(crate) mono: bool,
    pub(crate) bands: Vec<f32>,
}

/// Devuelve `true` si el bus pasa por el program_mixer (master, jingle, cartwall, playlists, aux).
pub(crate) fn is_program_bus(bus_id: &str) -> bool {
    matches!(
        bus_id,
        "master" | "jingle" | "cartwall" | "pl1" | "pl2" | "pl3" | "pl4" | "aux1" | "aux2"
    )
}

/// Salida de audio física abierta (nombre legible + sink de rodio).
pub(crate) struct OutputRuntime {
    pub(crate) name: String,
    pub(crate) sink: MixerDeviceSink,
}

/// Asociación bus → dispositivo de salida asignado.
#[derive(Clone, Debug, Default)]
pub(crate) struct RouteState {
    pub(crate) output_device_id: String,
    pub(crate) output_device_name: String,
}

/// Metadatos del track en emisión (enviados desde el renderer JS).
#[derive(Clone, Debug, Default)]
pub(crate) struct NowPlayingState {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) path: String,
    pub(crate) player: String,
    pub(crate) source: String,
    pub(crate) updated_at: u128,
}

/// Estado de transporte del player activo (posición, duración, mezcla).
#[derive(Clone, Debug, Default)]
pub(crate) struct TransportState {
    pub(crate) player: String,
    pub(crate) status: String,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: u64,
    pub(crate) start_cause: String,
    pub(crate) mix_active: bool,
    pub(crate) mix_phase: String,
    pub(crate) mix_direction: String,
    pub(crate) mix_reference_player: String,
    pub(crate) updated_at: u128,
}

/// Fila del snapshot de playlist recibido desde el renderer.
#[derive(Clone, Debug, Default)]
pub(crate) struct PlaylistRowState {
    pub(crate) row_id: String,
    pub(crate) tab: u64,
    pub(crate) order: u64,
    pub(crate) row_type: String,
    pub(crate) path: String,
    pub(crate) title: String,
}

/// Modos de playlist: repeat, remove-played, loop y sus protecciones contra olvido.
#[derive(Clone, Debug)]
pub(crate) struct PlaylistModeState {
    pub(crate) repeat_track: bool,
    pub(crate) remove_played: bool,
    pub(crate) loop_playlist: bool,
    pub(crate) repeat_forget_protection_enabled: bool,
    pub(crate) repeat_forget_protection_max: u64,
    pub(crate) repeat_disable_on_manual_next: bool,
    pub(crate) remove_played_protection_enabled: bool,
    pub(crate) remove_played_protection_min_remaining: u64,
}

impl Default for PlaylistModeState {
    fn default() -> Self {
        Self {
            repeat_track: false,
            remove_played: false,
            loop_playlist: false,
            repeat_forget_protection_enabled: false,
            repeat_forget_protection_max: 10,
            repeat_disable_on_manual_next: true,
            remove_played_protection_enabled: false,
            remove_played_protection_min_remaining: 2,
        }
    }
}

/// Contexto de reproducción de playlist: qué fila está sonando, cuál está encolada.
#[derive(Clone, Debug, Default)]
pub(crate) struct PlaylistPlaybackContext {
    pub(crate) current_row_id: String,
    pub(crate) current_player: String,
    pub(crate) queued_row_id: String,
    pub(crate) pgm_tab: u64,
    pub(crate) last_finished_key: String,
}

/// Estado del encoder de streaming (FFmpeg): buses, PCM bridge, bitrate, gaps.
#[derive(Clone, Debug)]
pub(crate) struct EncoderState {
    pub(crate) active: bool,
    pub(crate) source_bus: String,
    pub(crate) owner: String,
    pub(crate) requested_owner: String,
    pub(crate) capture_provider: String,
    pub(crate) encoder_provider: String,
    pub(crate) rust_pcm_ready: bool,
    pub(crate) pcm_bridge_ready: bool,
    pub(crate) pcm_bridge_mode: String,
    pub(crate) pcm_bridge_reason: String,
    pub(crate) fallback_reason: String,
    pub(crate) capture_format: String,
    pub(crate) sample_rate: u64,
    pub(crate) transport: String,
    pub(crate) bitrate_kbps: f32,
    pub(crate) speed: f32,
    pub(crate) ffmpeg_time: String,
    pub(crate) max_gap_ms: f32,
    pub(crate) gap_warnings: u64,
    pub(crate) input_peak_db: f32,
    pub(crate) input_rms_db: f32,
    pub(crate) input_meter_updated_at: u128,
    pub(crate) updated_at: u128,
}

impl Default for EncoderState {
    fn default() -> Self {
        Self {
            active: false,
            source_bus: "master".to_string(),
            owner: "none".to_string(),
            requested_owner: "none".to_string(),
            capture_provider: "none".to_string(),
            encoder_provider: "auto".to_string(),
            rust_pcm_ready: false,
            pcm_bridge_ready: false,
            pcm_bridge_mode: "planned".to_string(),
            pcm_bridge_reason: "rust-master-mix-not-yet-exported".to_string(),
            fallback_reason: String::new(),
            capture_format: String::new(),
            sample_rate: 0,
            transport: String::new(),
            bitrate_kbps: 0.0,
            speed: 0.0,
            ffmpeg_time: String::new(),
            max_gap_ms: 0.0,
            gap_warnings: 0,
            input_peak_db: -120.0,
            input_rms_db: -120.0,
            input_meter_updated_at: 0,
            updated_at: 0,
        }
    }
}
