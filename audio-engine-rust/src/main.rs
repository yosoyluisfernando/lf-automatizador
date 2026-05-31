use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::Device;
use rodio::mixer::Mixer;
use rodio::source::{SeekError, Zero};
use rodio::{ChannelCount, Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Sample, SampleRate, Source};

#[derive(Clone, Debug)]
struct PlayerState {
    path: String,
    status: String,
    position_ms: u64,
    duration_ms: u64,
    gain: f32,
    bus_id: String,
    output_device_id: String,
    output_device_name: String,
    repeat_active: bool,
    repeat_start_ms: u64,
    repeat_count: u64,
    fade_active: bool,
    fade_start_gain: f32,
    fade_target_gain: f32,
    fade_started_at_ms: u128,
    fade_duration_ms: u64,
    fade_stop_after: bool,
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

/// Spec de un player a reanudar tras un reset del program_mixer.
/// `reset_program_mixer` la puebla antes de detener los players;
/// `resume_pending_players` la drena justo después de `ensure_program_mixer`.
#[derive(Clone, Debug)]
struct PendingResumeSpec {
    player_id: String,
    path: String,
    position_ms: u64,
    gain: f32,
    bus_id: String,
    was_playing: bool,
}

struct EngineState {
    players: HashMap<String, RuntimePlayer>,
    outputs: HashMap<String, OutputRuntime>,
    routes: HashMap<String, RouteState>,
    now_playing: Option<NowPlayingState>,
    transport: Option<TransportState>,
    playlist_rows: Vec<PlaylistRowState>,
    playlist_mode: PlaylistModeState,
    playlist_context: PlaylistPlaybackContext,
    encoder: EncoderState,
    /// Ganancia del fader master (0.0–2.0). Multiplicador global aplicado a
    /// players de programa (master, jingle, cartwall, pl1–pl4) al llamar
    /// player.set_volume(). NO afecta CUE ni editores.
    master_gain: f32,
    /// Ganancia del fader monitor (0.0–2.0). Reservado para uso futuro cuando
    /// el motor Rust tenga una salida monitor dedicada. Hoy se almacena por
    /// consistencia con el contrato de comandos del frontend.
    monitor_gain: f32,
    /// Estado del bus FX (EQ/Comp/Limitador). Hoy se recibe del frontend y
    /// se almacena, pero el motor rodio actual NO aplica DSP propio — los
    /// efectos siguen aplicándose en WebAudio. Recibirlo evita errores
    /// "Comando no soportado: fx" en la consola de JS.
    fx: FxState,
    /// Modo de fuente del encoder ("postFx" o "preFx"). Se actualiza por el
    /// comando route { bus: "encoder", sourceMode: ... } para diagnóstico.
    encoder_source_mode: String,
    /// Generación de la locución horaria activa. Cada llamada a `timeLocution`
    /// (o un `stop` sobre el player que la sostiene) incrementa este contador.
    /// Se conserva como token de invalidez para cualquier cierre tardío de una
    /// locución reemplazada o cancelada.
    time_locution_counter: Arc<AtomicU64>,
    /// ID del player que actualmente sostiene la locución horaria (puede ser
    /// "time-locucion" cuando se lanza desde la botonera o "player-a"/"player-b"
    /// cuando se lanza desde la playlist). Sirve para que el handler de `stop`
    /// invalide la generación SOLO si están parando este player, no otros.
    time_locution_player: String,
    /// Instante en que arrancó la locución horaria activa. La posición que se
    /// reporta al frontend se calcula como `now - started_at` saturada a
    /// `time_locution_total_ms`, en lugar de usar `Player::get_pos()` que se
    /// resetea al cambiar entre los dos archivos encolados (HRS + MIN) y
    /// provocaba que la barra de progreso "rebotara" a cero a mitad de pista.
    /// Tratamos los dos archivos como UNA SOLA PISTA hacia afuera.
    time_locution_started_at: Option<Instant>,
    /// Duración total (HRS + MIN, o solo HRS en punto) de la locución horaria
    /// activa. Se reporta como `durationMs` del player y se usa como cota
    /// superior del reloj acumulativo de la pista virtual.
    time_locution_total_ms: u64,
    /// FASE D — sub-mixer del bus de programa (pl1-4 + jingle + cartwall).
    /// Se instancia lazy la primera vez que `route_bus` recibe `bus="master"`.
    /// Su `MixerSource` se conecta al sink físico del output PGM. En sub-paso
    /// 7.3 está vivo pero sin entradas reales: solo el `Zero` infinito que
    /// lo mantiene "vivo" en el sink. Los players de programa se redirigen
    /// a este mixer en el sub-paso 7.4.
    program_mixer_input: Option<Mixer>,
    /// ID del output device asignado al sub-mixer de programa (el del bus
    /// `master`). Vacío hasta que `route_bus` enrute master por primera vez.
    program_mixer_sink_id: String,
    /// FASE D · sub-paso 7.6: meter post-fader del bus master. El
    /// `MeteredSource` entre `FaderSource` y el sink PGM lo escribe; el
    /// `emit_status` lo lee y emite como meter id="master". Es la fuente
    /// definitiva del MASTER (refleja exactamente lo que sale al sink físico).
    master_bus_meter: Arc<PlayerMeter>,
    /// FASE D · sub-paso 11.3: consumers Pre-FX y Post-FX del tap monitor.
    /// Se llenan desde dos MultiTeeSource distintos (uno antes y otro después
    /// de la cadena DSP). Cuando `route_bus("monitor", ...)` llega,
    /// `ensure_monitor_chain` mueve AMBOS al `DualTapConsumerSource` y el
    /// atómico `monitor_tap_mode` decide cuál se consume en caliente.
    monitor_tap_pre_consumer: Option<rtrb::Consumer<Sample>>,
    monitor_tap_post_consumer: Option<rtrb::Consumer<Sample>>,
    /// FASE D · sub-paso 8.1: meter del tap monitor. Escrito por el
    /// `MeteredSource` del sink monitor, leído por `emit_status` como meter
    /// id="monitor".
    monitor_bus_meter: Arc<PlayerMeter>,
    /// ID del output device asignado al sink monitor. Vacío hasta que
    /// `route_bus` enrute "monitor" por primera vez.
    monitor_sink_id: String,
    /// FASE D · sub-paso 11.3: consumers Pre-FX y Post-FX del tap encoder.
    /// Permanecen en `state` (NO se mueven a otro thread): el push tick los
    /// lee desde el main loop y elige según `encoder_tap_mode`.
    encoder_tap_pre_consumer: Option<rtrb::Consumer<Sample>>,
    encoder_tap_post_consumer: Option<rtrb::Consumer<Sample>>,
    /// FASE D — parámetros DSP compartidos. Se clona el Arc al thread de audio
    /// cuando se construya la cadena DSP (sub-pasos 9-11). El handler `fx`
    /// escribirá acá en sub-pasos 9+.
    #[allow(dead_code)]
    dsp_params: Arc<DspParams>,
    /// Players a reanudar automáticamente tras un reset del program_mixer.
    pending_resume: Vec<PendingResumeSpec>,
    /// Productores de ring buffers para streams PCM activos (key = player_id).
    /// El hilo IPC escribe samples f32; el thread de audio los consume via
    /// PcmRingSource. Cuando se llama `stream_stop`, el productor se retira aquí
    /// y el flag `finished` le indica al Source que ya no habrá más datos.
    stream_producers: HashMap<String, rtrb::Producer<f32>>,
    /// Flags de fin de stream por player. `true` → el PcmRingSource drena el
    /// buffer restante y devuelve None al vaciarse, deteniendo el Source.
    stream_finished_flags: HashMap<String, Arc<AtomicBool>>,
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
            dsp_params: Arc::new(DspParams::default()),
            pending_resume: Vec::new(),
            stream_producers: HashMap::new(),
            stream_finished_flags: HashMap::new(),
        }
    }
}

/// Estado del bus FX (sólo almacenamiento — el DSP real corre en WebAudio).
#[derive(Clone, Debug, Default)]
struct FxState {
    eq: bool,
    comp: bool,
    limiter: bool,
    preamp_db: f32,
    pan: f32,
    mono: bool,
    /// 8 bandas de EQ (gain en dB por banda).
    bands: Vec<f32>,
}

/// Devuelve true si el bus contribuye a la salida "master/aire".
/// El master fader debe multiplicar la ganancia de estos players.
/// CUE y editores quedan excluidos para que la pre-escucha sea independiente.
fn is_program_bus(bus_id: &str) -> bool {
    matches!(
        bus_id,
        "master" | "jingle" | "cartwall" | "pl1" | "pl2" | "pl3" | "pl4"
    )
}

// `effective_gain_for` ELIMINADO en sub-paso 7.5. El master fader ya no se
// aplica componiéndolo con el gain individual del player; ahora vive como
// `FaderSource` único entre el `program_mixer` y el sink físico PGM, leyendo
// `dsp_params.master_gain_bits`. Los players solo aplican su gain propio.

struct OutputRuntime {
    name: String,
    sink: MixerDeviceSink,
}

#[derive(Clone, Debug, Default)]
struct RouteState {
    output_device_id: String,
    output_device_name: String,
}

#[derive(Clone, Debug, Default)]
struct NowPlayingState {
    title: String,
    artist: String,
    path: String,
    player: String,
    source: String,
    updated_at: u128,
}

#[derive(Clone, Debug, Default)]
struct TransportState {
    player: String,
    status: String,
    position_ms: u64,
    duration_ms: u64,
    start_cause: String,
    mix_active: bool,
    mix_phase: String,
    mix_direction: String,
    mix_reference_player: String,
    updated_at: u128,
}

#[derive(Clone, Debug, Default)]
struct PlaylistRowState {
    row_id: String,
    tab: u64,
    order: u64,
    row_type: String,
    path: String,
    title: String,
}

#[derive(Clone, Debug)]
struct PlaylistModeState {
    repeat_track: bool,
    remove_played: bool,
    loop_playlist: bool,
    repeat_forget_protection_enabled: bool,
    repeat_forget_protection_max: u64,
    repeat_disable_on_manual_next: bool,
    remove_played_protection_enabled: bool,
    remove_played_protection_min_remaining: u64,
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

#[derive(Clone, Debug, Default)]
struct PlaylistPlaybackContext {
    current_row_id: String,
    current_player: String,
    queued_row_id: String,
    pgm_tab: u64,
    last_finished_key: String,
}

#[derive(Clone, Debug)]
struct EncoderState {
    active: bool,
    source_bus: String,
    owner: String,
    requested_owner: String,
    capture_provider: String,
    encoder_provider: String,
    rust_pcm_ready: bool,
    pcm_bridge_ready: bool,
    pcm_bridge_mode: String,
    pcm_bridge_reason: String,
    fallback_reason: String,
    capture_format: String,
    sample_rate: u64,
    transport: String,
    bitrate_kbps: f32,
    speed: f32,
    ffmpeg_time: String,
    max_gap_ms: f32,
    gap_warnings: u64,
    updated_at: u128,
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
            updated_at: 0,
        }
    }
}

// ============================================================================
// FASE D — Bitácora de API de `rodio::mixer` 0.22.2 (sub-paso 7.2)
// ============================================================================
// Investigado leyendo rodio-0.22.2/src/mixer.rs, player.rs y source/zero.rs.
//
// Construir un sub-mixer:
//   use rodio::mixer::{mixer, Mixer, MixerSource};
//   let (input, output) = mixer(channels, sample_rate);   // input: Mixer, output: MixerSource
//
// `Mixer` es el handle de entrada (Clone). Método `input.add(source)` recibe
// cualquier `Source + Send + 'static` y lo convierte al (channels, sample_rate)
// del mixer mediante `UniformSourceIterator` (resampling automático).
//
// `MixerSource` es el iterador de salida (implementa `Source`). Se entrega
// como fuente a un sink/player consumidor.
//
// ⚠️  Trampa documentada en el código fuente:
//   "mixer without any input source behaves like an `Empty` (not: `Zero`)
//    source, and thus, just after appending to a player, the mixer is
//    removed from the player. As a result, input sources added to the
//    mixer later might not be forwarded to the player. Add `Zero` source
//    to prevent detaching the mixer from player."
//
// Conclusión: ANTES de entregar el `MixerSource` al sink PGM, hay que añadir
// una `Zero` source infinita al input. Eso mantiene vivo el mixer aunque no
// haya pistas reproduciéndose:
//   input.add(rodio::source::Zero::new(channels, sample_rate));
//   output_sink.mixer().add(output);
//
// Para conectar un Player al sub-mixer en vez del sink físico:
//   let player = Player::connect_new(&program_mixer_input);
//   player.append(metered_source);
//
// (En el código actual se usa `Player::connect_new(output.sink.mixer())` que
// conecta directo al sink del output device. En FASE D pasamos a usar el
// sub-mixer como destino para los buses de programa, y el sub-mixer es quien
// alimenta el sink físico.)
//
// ============================================================================
// FASE D — Estructuras del Bus FX intermedio (sub-paso 7.1)
// ============================================================================
// Estas estructuras quedan DECLARADAS sin cablear todavía. El objetivo del
// sub-paso 7.1 es validar que el binario sigue compilando limpio con la
// dependencia `rtrb` y las nuevas atomics. El cableado real al EngineState y
// el grafo de audio se hace en sub-pasos 7.3+.
//
// Regla 2 codificada en el diseño: los efectos DSP NO tienen flags
// "enabled/disabled". Tienen `*_wet_target` (0.0 → bypass total / 1.0 → efecto
// pleno). El DSP siempre procesa cada sample. La rampa interna de wet_actual
// hacia wet_target evita clics al activar/desactivar desde la UI.

/// Parámetros DSP compartidos entre el thread de audio y los handlers IPC.
/// Todos los valores f32 viajan como bits en AtomicU32 (no hay AtomicF32 en
/// std). El thread de audio los lee con `Ordering::Relaxed` en el hot path;
/// los handlers de comando los escriben con `Relaxed`. Cero locks.
#[allow(dead_code)]
struct DspParams {
    // Faders únicos (reemplazan a `state.master_gain` per-player).
    master_gain_bits: AtomicU32,
    monitor_gain_bits: AtomicU32,

    // Pre-procesamiento lineal (sin wet/dry: son pasos transparentes en 0).
    preamp_db_bits: AtomicU32,
    pan_bits: AtomicU32,

    // Wet/dry targets (regla 2). Rango 0.0–1.0. Los nodos DSP corren siempre.
    mono_wet_target_bits: AtomicU32,
    eq_wet_target_bits: AtomicU32,
    comp_wet_target_bits: AtomicU32,
    limiter_wet_target_bits: AtomicU32,

    // EQ paramétrico de 8 bandas.
    eq_bands: [EqBandAtomic; 8],

    // Compresor.
    comp_threshold_db_bits: AtomicU32,
    comp_ratio_bits: AtomicU32,
    comp_attack_ms_bits: AtomicU32,
    comp_release_ms_bits: AtomicU32,
    comp_knee_db_bits: AtomicU32,
    comp_makeup_db_bits: AtomicU32,

    // Limitador.
    limiter_ceiling_db_bits: AtomicU32,
    limiter_release_ms_bits: AtomicU32,

    // Modos de tap del encoder y monitor (0=preFx, 1=postFx). Atómicos para
    // permitir conmutar pre/post FX en caliente sin reconstruir el grafo.
    encoder_tap_mode: AtomicU8,
    monitor_tap_mode: AtomicU8,

    // FASE D · sub-paso 11.4 — Orden dinámico de bloques DSP.
    //
    // Empaquetado: 3 índices de 2 bits cada uno (6 bits totales en el LSB).
    //   bits 0-1: primer bloque procesado (entrada de señal)
    //   bits 2-3: segundo bloque procesado
    //   bits 4-5: tercer bloque procesado (salida hacia master fader)
    //
    // Códigos de bloque:
    //   0 = EQ-meta (engloba PreAmp + Pan + Mono + 8 bandas peaking)
    //   1 = Compressor (AGC)
    //   2 = Limiter
    //
    // Default = 0 | (1<<2) | (2<<4) = 0 + 4 + 32 = 36 → EQ → Comp → Limiter
    // (orden histórico de WebAudio API y cascada cableada original).
    //
    // El frontend envía `order: ['eq', 'comp', 'limiter']` (3 strings) que el
    // handler `"fx"` parsea y empaqueta en este atómico. `DynamicDspSource`
    // lo lee cada par estéreo (~22 µs @ 44.1 kHz) y aplica los bloques en
    // el orden indicado. Reordenamiento en caliente, lock-free, sin clic.
    fx_order: AtomicU32,

    // Flag global de "motor DSP listo" (lo flipea el sub-paso 7.5 al cablear
    // el FaderSource). Mientras esté en false, el frontend sigue usando el
    // path actual de fader per-player.
    dsp_ready: AtomicBool,
    /// FASE D · sub-paso 8.2: cuando es true, el push tick drena el
    /// `encoder_tap_consumer` y emite chunks PCM s16le base64 por stdout.
    /// El comando IPC `encoderTap { enable: bool }` lo prende/apaga.
    encoder_tap_active: AtomicBool,
}

/// Banda EQ peaking biquad. Frecuencia central (Hz), Q, ganancia (dB).
#[allow(dead_code)]
struct EqBandAtomic {
    freq_hz_bits: AtomicU32,
    q_bits: AtomicU32,
    gain_db_bits: AtomicU32,
}

impl EqBandAtomic {
    /// Construye una banda con freq central, Q y gain a 0 dB (transparente).
    fn new(freq_hz: f32, q: f32) -> Self {
        Self {
            freq_hz_bits: AtomicU32::new(freq_hz.to_bits()),
            q_bits: AtomicU32::new(q.to_bits()),
            gain_db_bits: AtomicU32::new(0.0_f32.to_bits()),
        }
    }
}

impl Default for DspParams {
    fn default() -> Self {
        // Frecuencias broadcast estándar de 8 bandas (octavas). Alineadas con
        // las labels de la UI en frontend/render.js:5676 ('63','125','250',
        // '500','1K','2K','4K','8K') para que cada slider de la consola FX
        // controle visualmente la misma banda que procesa el motor.
        let eq_bands = [
            EqBandAtomic::new(63.0, 1.0),
            EqBandAtomic::new(125.0, 1.0),
            EqBandAtomic::new(250.0, 1.0),
            EqBandAtomic::new(500.0, 1.0),
            EqBandAtomic::new(1000.0, 1.0),
            EqBandAtomic::new(2000.0, 1.0),
            EqBandAtomic::new(4000.0, 1.0),
            EqBandAtomic::new(8000.0, 1.0),
        ];
        Self {
            master_gain_bits: AtomicU32::new(1.0_f32.to_bits()),
            monitor_gain_bits: AtomicU32::new(1.0_f32.to_bits()),
            preamp_db_bits: AtomicU32::new(0.0_f32.to_bits()),
            pan_bits: AtomicU32::new(0.0_f32.to_bits()),
            // wet_target default = 1.0: el efecto está aplicado por defecto.
            // La UI baja a 0.0 cuando el usuario "desactiva" desde consola.
            mono_wet_target_bits: AtomicU32::new(0.0_f32.to_bits()),
            eq_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            comp_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            limiter_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            eq_bands,
            // Parámetros AGC broadcast. El objetivo es que la música salga
            // estable con picos alrededor de -2 dBFS, evitando la saturación
            // que causaba un makeup gain excesivo.
            //
            // Matemática con música típica (RMS a -14 dBFS):
            //   Exceso sobre threshold (-20): 6 dB
            //   Reducción (ratio 3:1):        6 × (2/3) = 4 dB de atenuación
            //   Post-comp:                    -18 dBFS (RMS)
            //   Makeup +9 dB:                 -9 dBFS (RMS)
            //   Picos (crest factor ~7dB):    -2 dBFS (Perfecto, toca el limitador suavemente)
            //
            // Con música fuerte/saturada (RMS a -10 dBFS):
            //   Exceso sobre threshold (-20): 10 dB
            //   Reducción (ratio 3:1):        10 × (2/3) = 6.66 dB
            //   Post-comp:                    -16.66 dBFS (RMS)
            //   Makeup +9 dB:                 -7.66 dBFS (RMS)
            //   Limitador ataja picos fuertes en -2.0 dBFS para proteger la salida.
            comp_threshold_db_bits: AtomicU32::new((-20.0_f32).to_bits()),
            comp_ratio_bits: AtomicU32::new(3.0_f32.to_bits()),
            comp_attack_ms_bits: AtomicU32::new(30.0_f32.to_bits()),
            comp_release_ms_bits: AtomicU32::new(800.0_f32.to_bits()),
            comp_knee_db_bits: AtomicU32::new(6.0_f32.to_bits()),
            comp_makeup_db_bits: AtomicU32::new(9.0_f32.to_bits()),
            limiter_ceiling_db_bits: AtomicU32::new((-2.0_f32).to_bits()),
            limiter_release_ms_bits: AtomicU32::new(100.0_f32.to_bits()),
            // postFx por defecto (consistente con state.encoder_source_mode).
            encoder_tap_mode: AtomicU8::new(1),
            monitor_tap_mode: AtomicU8::new(1),
            // Default = EQ(0) → Comp(1) → Limiter(2): 0|(1<<2)|(2<<4) = 36.
            fx_order: AtomicU32::new(0 | (1 << 2) | (2 << 4)),
            dsp_ready: AtomicBool::new(false),
            encoder_tap_active: AtomicBool::new(false),
        }
    }
}

/// Puente PCM Rust → JS para el encoder. SPSC lock-free.
/// Productor único: el TapSource del bus FX (corre en el thread de audio).
/// Consumidor único: el handler IPC `encoderRead` que vacía a demanda.
///
/// Capacidad inicial: 4 segundos de PCM stereo a 44.1 kHz = ~350 KB. Suficiente
/// para absorber jitter del lado JS sin overflow.
#[allow(dead_code)]
struct EncoderTapBuffer {
    producer: Option<rtrb::Producer<f32>>,
    consumer: Option<rtrb::Consumer<f32>>,
    sample_rate: AtomicU32,
    channels: AtomicU8,
}

impl EncoderTapBuffer {
    #[allow(dead_code)]
    fn new(capacity: usize) -> Self {
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(capacity);
        Self {
            producer: Some(producer),
            consumer: Some(consumer),
            sample_rate: AtomicU32::new(44100),
            channels: AtomicU8::new(2),
        }
    }
}

/// Orquestador del bus FX intermedio. Se instancia lazy en `ensure_output`
/// cuando se crea el output del bus `master` (sub-paso 7.3).
///
/// Topología:
///   program_mixer (suma pl1-4 + jingle + cartwall)
///     → DSP chain (PreAmp → Pan → Mono → EQ8 → Comp → Limiter)
///     → BusFan { Pre-FX tap, Post-FX tap }
///         ├─ Encoder tap (selector pre/post → ring buffer rtrb)
///         ├─ Monitor chain (selector pre/post → MonitorFader → sink Booth)
///         └─ Master chain (Post-FX → MasterFader → sink PGM)
///
/// CUE queda 100% por fuera de este grafo.
#[allow(dead_code)]
struct BusGraph {
    /// ID del output device asignado al bus master (PGM).
    pgm_sink_id: String,
    /// ID del output device asignado al monitor. None si no se enrutó.
    monitor_sink_id: Option<String>,
    /// Buffer del tap encoder. Productor en thread de audio; consumidor en IPC.
    encoder_tap: Arc<EncoderTapBuffer>,
    /// Parámetros DSP compartidos. Se clona el Arc al thread de audio.
    dsp_params: Arc<DspParams>,
}

// ============================================================================
// Fin de estructuras FASE D
// ============================================================================

// ============================================================================
// FASE D · Source adapters
// ============================================================================
// `FaderSource` aplica una ganancia atómica a cada sample. Es el único punto
// de aplicación del master fader (sub-paso 7.5), reemplazando al esquema
// per-player de `effective_gain_for`. Se inserta entre la salida del
// `program_mixer` y el sink físico del bus master.
//
// La ganancia vive en `DspParams.master_gain_bits` (f32 en bits). El handler
// IPC `masterGain` la escribe con `Ordering::Relaxed`; este adapter la lee
// también con `Relaxed`. Cero locks en el hot path de audio.
struct FaderSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    gain_field: FaderGainField,
}

/// Selector de qué atómico de `DspParams` consume este FaderSource.
/// Hoy solo lo usa el master; sub-paso 8.1 agregará el monitor.
#[derive(Clone, Copy)]
enum FaderGainField {
    Master,
    #[allow(dead_code)]
    Monitor,
}

impl<S> FaderSource<S>
where
    S: Source<Item = Sample>,
{
    fn new(source: S, params: Arc<DspParams>, gain_field: FaderGainField) -> Self {
        Self { source, params, gain_field }
    }

    #[inline]
    fn read_gain(&self) -> f32 {
        let bits = match self.gain_field {
            FaderGainField::Master => self.params.master_gain_bits.load(Ordering::Relaxed),
            FaderGainField::Monitor => self.params.monitor_gain_bits.load(Ordering::Relaxed),
        };
        f32::from_bits(bits).clamp(0.0, 2.0)
    }
}

impl<S> Iterator for FaderSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        Some(sample * self.read_gain())
    }
}

impl<S> Source for FaderSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

// ============================================================================
// FASE D · sub-pasos 9.1 / 9.2 / 9.3 — Cadena DSP lineal (PreAmp / Pan / Mono)
// ============================================================================
//
// Tres Source adapters que se cablean en serie después del MultiTee Pre-FX y
// antes del FaderSource Master. Todos respetan la regla 2 (DSP siempre activo):
//   - PreAmp: lineal, 0 dB = transparente. Sin wet/dry.
//   - Pan:    equal-power, pan=0 = transparente. Sin wet/dry.
//   - Mono:   suma L+R y duplica. Wet/dry rampa para activar/desactivar sin clic.
//
// Cada adapter lee sus parámetros desde DspParams con `Ordering::Relaxed`.
// Cero locks en el hot path de audio. El handler IPC `fx` (extendido en 11.1)
// escribe en los atómicos.

/// Constante de rampa común al módulo EQ (PreAmp + Pan + Mono + 8 bandas).
/// 256 samples ≈ 5.8 ms @ 44.1 kHz — imperceptible al oído pero suficiente
/// para evitar clic al activar/desactivar.
const EQ_MODULE_RAMP_INCREMENT: f32 = 1.0 / 256.0;

/// Lee el wet target maestro del módulo EQ y avanza `wet_actual` hacia él
/// con paso `EQ_MODULE_RAMP_INCREMENT`. Devuelve el valor `wet_actual` ya
/// actualizado para usar en la mezcla wet/dry del sample actual.
#[inline]
fn advance_eq_module_wet(wet_actual: &mut f32, params: &DspParams) -> f32 {
    let target = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
        .clamp(0.0, 1.0);
    if *wet_actual < target {
        *wet_actual = (*wet_actual + EQ_MODULE_RAMP_INCREMENT).min(target);
    } else if *wet_actual > target {
        *wet_actual = (*wet_actual - EQ_MODULE_RAMP_INCREMENT).max(target);
    }
    *wet_actual
}

/// Pre-amp del módulo EQ. Cuando el switch EQ está ON (wet=1), aplica
/// `10^(preamp_db/20)`. Cuando está OFF (wet=0), pass-through total —
/// el operador no escucha NI siquiera la ganancia del preamp.
///
/// Regla broadcast: el PreAmp pertenece conceptualmente al módulo EQ.
/// El switch del EQ controla todo el grupo (preamp + pan + mono + bandas).
///
/// FASE D · sub-paso 11.4: la cadena de producción ahora usa `DynamicDspSource`
/// que absorbe estas 6 Source adapters (PreAmp, Pan, Mono, EqChain, Compressor,
/// Limiter) como 3 bloques atómicos reordenables. Las structs siguientes se
/// conservan inertes como referencia (allow(dead_code)) hasta que validemos
/// auditivamente la nueva cadena dinámica en producción.
#[allow(dead_code)]
struct PreAmpSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    wet_actual: f32,
}

impl<S> PreAmpSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let initial_wet = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        Self { source, params, wet_actual: initial_wet }
    }

    #[inline]
    fn read_gain_linear(&self) -> f32 {
        let db = f32::from_bits(self.params.preamp_db_bits.load(Ordering::Relaxed));
        let clamped = db.clamp(-24.0, 24.0);
        10f32.powf(clamped / 20.0)
    }
}

impl<S> Iterator for PreAmpSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        let wet = advance_eq_module_wet(&mut self.wet_actual, &self.params);
        // wet=0 → output = sample (sin preamp aplicado)
        // wet=1 → output = sample * gain_linear (preamp pleno)
        // wet=k → mezcla lineal entre ambos
        let gain = self.read_gain_linear();
        let factor = (1.0 - wet) + wet * gain;
        Some(sample * factor)
    }
}

impl<S> Source for PreAmpSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

/// Pan estéreo con ley equal-power. Pertenece al módulo EQ → bypassed con el
/// switch global del EQ. Cuando wet=0, pass-through total; cuando wet=1,
/// aplica la atenuación equal-power según pan_bits.
#[allow(dead_code)]
struct PanSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    sample_index: u64,
    channels: usize,
    wet_actual: f32,
}

impl<S> PanSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let channels = source.channels().get() as usize;
        let initial_wet = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        Self { source, params, sample_index: 0, channels: channels.max(1), wet_actual: initial_wet }
    }

    /// Devuelve (gain_L, gain_R) según el pan actual.
    /// FIX BUG (cambio de volumen al activar EQ con pan=0): cambiamos de
    /// ley equal-power (cos/sin) a BALANCE LINEAL. Con equal-power, pan=0
    /// daba (0.707, 0.707) → caída de -3 dB en cada canal aun en el centro,
    /// lo cual el operador notaba como una atenuación al activar el EQ.
    /// El balance lineal mantiene pan=0 → (1.0, 1.0) unity perfecto, y
    /// solo atenúa el canal opuesto al desplazar. Es la convención usada
    /// por consolas broadcast y DAWs como ProTools en su "Stereo Balance".
    #[inline]
    fn read_pan_gains(&self) -> (f32, f32) {
        let pan = f32::from_bits(self.params.pan_bits.load(Ordering::Relaxed))
            .clamp(-1.0, 1.0);
        let gain_l = if pan <= 0.0 { 1.0 } else { 1.0 - pan };
        let gain_r = if pan >= 0.0 { 1.0 } else { 1.0 + pan };
        (gain_l, gain_r)
    }
}

impl<S> Iterator for PanSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        // Mono fuente: pass-through.
        if self.channels < 2 {
            self.sample_index = self.sample_index.wrapping_add(1);
            return Some(sample);
        }
        let wet = advance_eq_module_wet(&mut self.wet_actual, &self.params);
        let (gl, gr) = self.read_pan_gains();
        // Canal L (índice par) o R (impar). wet=0 → sample crudo; wet=1 →
        // sample * gain_canal. Interpolación lineal entre ambos.
        let channel_gain = if self.sample_index % 2 == 0 { gl } else { gr };
        let factor = (1.0 - wet) + wet * channel_gain;
        let out = sample * factor;
        self.sample_index = self.sample_index.wrapping_add(1);
        Some(out)
    }
}

impl<S> Source for PanSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

/// Mono pertenece al módulo EQ. El switch maestro del EQ tiene veto: si está
/// OFF, el mono no se aplica aunque el operador haya marcado el toggle Mono.
///
/// Su wet efectivo es: `eq_wet_actual * mono_intent` donde:
///   - eq_wet_actual: rampa hacia `eq_wet_target_bits` (switch global del EQ).
///   - mono_intent:   0.0 ó 1.0 según `mono_wet_target_bits` (toggle Mono).
///
/// Cuando el operador desactiva el EQ desde la UI, este adapter cae a wet=0
/// con rampa de 5.8 ms — sin clic. Cuando reactiva el EQ, el wet sube a
/// `mono_intent` (1.0 si Mono estaba marcado, 0.0 si no).
#[allow(dead_code)]
struct MonoSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    channels: usize,
    wet_actual: f32,
    pending_right: Option<Sample>,
}

impl<S> MonoSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let channels = source.channels().get() as usize;
        let eq_wet = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let mono_intent = f32::from_bits(params.mono_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        Self {
            source,
            params,
            channels: channels.max(1),
            wet_actual: eq_wet * mono_intent,
            pending_right: None,
        }
    }

    #[inline]
    fn advance_wet(&mut self) {
        let eq_wet = f32::from_bits(self.params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let mono_intent = f32::from_bits(self.params.mono_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let target = eq_wet * mono_intent;
        if self.wet_actual < target {
            self.wet_actual = (self.wet_actual + EQ_MODULE_RAMP_INCREMENT).min(target);
        } else if self.wet_actual > target {
            self.wet_actual = (self.wet_actual - EQ_MODULE_RAMP_INCREMENT).max(target);
        }
    }
}

impl<S> Iterator for MonoSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(right) = self.pending_right.take() {
            return Some(right);
        }
        if self.channels < 2 {
            return self.source.next();
        }
        let l = self.source.next()?;
        let r = self.source.next()?;
        self.advance_wet();
        let mixed = (l + r) * 0.5;
        let wet = self.wet_actual;
        let dry = 1.0 - wet;
        let out_l = l * dry + mixed * wet;
        let out_r = r * dry + mixed * wet;
        self.pending_right = Some(out_r);
        Some(out_l)
    }
}

impl<S> Source for MonoSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

// ============================================================================
// FASE D · sub-paso 11.1 — EqChainSource (8 biquads peaking en cascada)
// ============================================================================
//
// EQ paramétrico broadcast de 8 bandas. Cada banda es un biquad peaking
// (Robert Bristow-Johnson cookbook) con freq centro, Q y gain en dB ajustables
// en vivo desde la UI (atómicos en DspParams).
//
// Topología por sample:
//   x[n] → band0 → band1 → ... → band7 → y[n]
// Estado separado por canal L y R (los biquads tienen memoria de x[n-1],
// x[n-2], y[n-1], y[n-2] que debe mantenerse alineada por canal).
//
// Optimización: los coeficientes del biquad se recalculan cada ~12 ms
// (LIMITER_REFRESH_SAMPLES = 1024), no por sample, porque las trig functions
// (sin/cos) y powf son caras relativas a la suma del biquad.
//
// Wet/dry rampa con `eq_wet_target` para activar/desactivar sin clic. La regla 2
// del usuario: el EQ SIEMPRE procesa, lo que se ramea es el mix entre dry y wet.

/// Estado de un biquad peaking single-band, single-channel.
#[derive(Default, Clone)]
struct BiquadChannel {
    x1: f32, x2: f32,
    y1: f32, y2: f32,
}

impl BiquadChannel {
    #[inline]
    fn process(&mut self, x: f32, b0: f32, b1: f32, b2: f32, a1: f32, a2: f32) -> f32 {
        // Direct Form I
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Una banda EQ paramétrica con su par de estado L/R y coeficientes cached.
struct EqBand {
    l: BiquadChannel,
    r: BiquadChannel,
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
}

impl EqBand {
    fn new() -> Self {
        // Coeficientes neutros (pass-through): y = x
        Self {
            l: BiquadChannel::default(),
            r: BiquadChannel::default(),
            b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0,
        }
    }

    /// Recalcula los coeficientes del biquad peaking RBJ a partir de
    /// (freq_hz, q, gain_db, sample_rate). Comparte coeficientes entre L y R.
    fn update_coeffs(&mut self, freq_hz: f32, q: f32, gain_db: f32, sample_rate: f32) {
        let freq = freq_hz.clamp(20.0, 20000.0);
        let q_clamped = q.clamp(0.1, 10.0);
        let gain_clamped = gain_db.clamp(-24.0, 24.0);

        let a = 10f32.powf(gain_clamped / 40.0);
        let omega = 2.0 * std::f32::consts::PI * freq / sample_rate.max(1.0);
        let alpha = omega.sin() / (2.0 * q_clamped);
        let cos_omega = omega.cos();

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_omega;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_omega;
        let a2 = 1.0 - alpha / a;

        // Normalización por a0 (estándar biquad)
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }
}

#[allow(dead_code)]
struct EqChainSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    bands: [EqBand; 8],
    wet_actual: f32,
    sample_counter: u32,
    channel_index: u32, // 0 = L, 1 = R (alterna por sample en stereo)
    sample_rate: f32,
    channels: usize,
}

const EQ_RAMP_INCREMENT: f32 = 1.0 / 256.0; // ~5.8 ms @ 44.1 kHz
const EQ_COEFFS_REFRESH_SAMPLES: u32 = 1024; // ~12 ms

impl<S> EqChainSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let initial_wet = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let sample_rate = source.sample_rate().get() as f32;
        let channels = source.channels().get() as usize;
        let mut me = Self {
            source,
            params,
            bands: [
                EqBand::new(), EqBand::new(), EqBand::new(), EqBand::new(),
                EqBand::new(), EqBand::new(), EqBand::new(), EqBand::new(),
            ],
            wet_actual: initial_wet,
            sample_counter: 0,
            channel_index: 0,
            sample_rate,
            channels: channels.max(1),
        };
        me.refresh_all_coeffs();
        me
    }

    fn refresh_all_coeffs(&mut self) {
        for i in 0..8 {
            let freq = f32::from_bits(self.params.eq_bands[i].freq_hz_bits.load(Ordering::Relaxed));
            let q = f32::from_bits(self.params.eq_bands[i].q_bits.load(Ordering::Relaxed));
            let gain_db = f32::from_bits(self.params.eq_bands[i].gain_db_bits.load(Ordering::Relaxed));
            self.bands[i].update_coeffs(freq, q, gain_db, self.sample_rate);
        }
    }

    #[inline]
    fn advance_wet(&mut self) {
        let target = f32::from_bits(self.params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.wet_actual < target {
            self.wet_actual = (self.wet_actual + EQ_RAMP_INCREMENT).min(target);
        } else if self.wet_actual > target {
            self.wet_actual = (self.wet_actual - EQ_RAMP_INCREMENT).max(target);
        }
    }
}

impl<S> Iterator for EqChainSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        if self.sample_counter % EQ_COEFFS_REFRESH_SAMPLES == 0 {
            self.refresh_all_coeffs();
        }
        self.advance_wet();

        // Procesar a través de los 8 biquads en cascada en el canal correcto.
        let mut processed = sample;
        let use_left = self.channels < 2 || self.channel_index == 0;
        for band in self.bands.iter_mut() {
            let b0 = band.b0; let b1 = band.b1; let b2 = band.b2;
            let a1 = band.a1; let a2 = band.a2;
            processed = if use_left {
                band.l.process(processed, b0, b1, b2, a1, a2)
            } else {
                band.r.process(processed, b0, b1, b2, a1, a2)
            };
        }

        // Wet/dry mix
        let wet = self.wet_actual;
        let out = sample * (1.0 - wet) + processed * wet;

        if self.channels >= 2 {
            self.channel_index = (self.channel_index + 1) % 2;
        }
        self.sample_counter = self.sample_counter.wrapping_add(1);
        Some(out)
    }
}

impl<S> Source for EqChainSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

// ============================================================================
// FASE D · sub-paso 11.2 — CompressorSource (envelope follower + ratio)
// ============================================================================
//
// Compresor broadcast clásico:
//   1. Envelope follower con attack/release exponencial (one-pole).
//   2. Comparación contra threshold; cuando la envelope la supera, aplica
//      reducción según `ratio` (4:1 default).
//   3. Makeup gain final.
//
// Versión inicial: HARD KNEE (transición abrupta en el threshold). El
// `knee_db` queda almacenado pero no se usa hasta una iteración futura que
// agregue soft knee cuadrático (interpolación suave alrededor del threshold).
//
// Parámetros amortizados (refresh cada ~12 ms para no llamar exp/log por
// sample). La envelope sí se actualiza por sample para precisión temporal.
// Wet/dry rampa para activar/desactivar sin clic (regla 2).
#[allow(dead_code)]
struct CompressorSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    envelope_linear: f32,
    wet_actual: f32,
    sample_counter: u32,
    sample_rate: f32,
    // Cache de parámetros (recalculado cada COMPRESSOR_REFRESH_SAMPLES)
    cached_threshold_linear: f32,
    cached_threshold_db: f32,
    cached_ratio: f32,
    cached_attack_coef: f32,
    cached_release_coef: f32,
    cached_makeup_linear: f32,
}

const COMPRESSOR_RAMP_INCREMENT: f32 = 1.0 / 256.0; // ~5.8 ms @ 44.1 kHz
const COMPRESSOR_REFRESH_SAMPLES: u32 = 1024;        // ~12 ms

impl<S> CompressorSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let initial_wet = f32::from_bits(params.comp_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let sample_rate = source.sample_rate().get() as f32;
        let mut me = Self {
            source,
            params,
            envelope_linear: 0.0,
            wet_actual: initial_wet,
            sample_counter: 0,
            sample_rate,
            cached_threshold_linear: 1.0,
            cached_threshold_db: 0.0,
            cached_ratio: 1.0,
            cached_attack_coef: 0.01,
            cached_release_coef: 0.001,
            cached_makeup_linear: 1.0,
        };
        me.refresh_cached_params();
        me
    }

    fn refresh_cached_params(&mut self) {
        let threshold_db = f32::from_bits(self.params.comp_threshold_db_bits.load(Ordering::Relaxed))
            .clamp(-60.0, 0.0);
        let ratio = f32::from_bits(self.params.comp_ratio_bits.load(Ordering::Relaxed))
            .clamp(1.0, 20.0);
        let attack_ms = f32::from_bits(self.params.comp_attack_ms_bits.load(Ordering::Relaxed))
            .clamp(0.1, 500.0);
        let release_ms = f32::from_bits(self.params.comp_release_ms_bits.load(Ordering::Relaxed))
            .clamp(1.0, 5000.0);
        let makeup_db = f32::from_bits(self.params.comp_makeup_db_bits.load(Ordering::Relaxed))
            .clamp(-24.0, 24.0);
        // One-pole filter coefficients: α = 1 - exp(-1 / (time_seg * fs))
        let sr_safe = self.sample_rate.max(1.0);
        self.cached_threshold_db = threshold_db;
        self.cached_threshold_linear = 10f32.powf(threshold_db / 20.0);
        self.cached_ratio = ratio;
        self.cached_attack_coef = 1.0 - (-1.0 / (attack_ms * 0.001 * sr_safe)).exp();
        self.cached_release_coef = 1.0 - (-1.0 / (release_ms * 0.001 * sr_safe)).exp();
        self.cached_makeup_linear = 10f32.powf(makeup_db / 20.0);
    }

    #[inline]
    fn advance_wet(&mut self) {
        let target = f32::from_bits(self.params.comp_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.wet_actual < target {
            self.wet_actual = (self.wet_actual + COMPRESSOR_RAMP_INCREMENT).min(target);
        } else if self.wet_actual > target {
            self.wet_actual = (self.wet_actual - COMPRESSOR_RAMP_INCREMENT).max(target);
        }
    }
}

impl<S> Iterator for CompressorSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let x = self.source.next()?;
        if self.sample_counter % COMPRESSOR_REFRESH_SAMPLES == 0 {
            self.refresh_cached_params();
        }
        self.advance_wet();

        // Envelope follower (peak con attack/release exponential)
        let abs_x = x.abs();
        let coef = if abs_x > self.envelope_linear {
            self.cached_attack_coef
        } else {
            self.cached_release_coef
        };
        self.envelope_linear += (abs_x - self.envelope_linear) * coef;

        // Hard knee gain computer
        let gain_linear = if self.envelope_linear > self.cached_threshold_linear {
            // En dB: reduction = over_db * (1 - 1/ratio)
            // Lo calculamos en lineal directo:
            //   gain = (threshold / envelope)^((ratio - 1) / ratio)
            let exponent = (self.cached_ratio - 1.0) / self.cached_ratio;
            (self.cached_threshold_linear / self.envelope_linear).powf(exponent)
        } else {
            1.0
        };

        let compressed = x * gain_linear * self.cached_makeup_linear;

        // Wet/dry mix
        let wet = self.wet_actual;
        let out = x * (1.0 - wet) + compressed * wet;

        self.sample_counter = self.sample_counter.wrapping_add(1);
        Some(out)
    }
}

impl<S> Source for CompressorSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

// ============================================================================
// FASE D · sub-paso 11.1 — EqChainSource (8 biquads peaking en cascada)
// ============================================================================
//
// Limitador de protección: clipea cada sample que excede `limiter_ceiling_db`
// (default -0.3 dBFS). Es la última línea de defensa contra overshoot del
// compresor o picos no anticipados. Wet/dry rampa para activar/desactivar
// sin clic (regla 2).
//
// Versión inicial: HARD CLIP. Sin lookahead, sin release envelope. Es
// agresivo pero protege el sink físico de samples fuera de rango. Una versión
// pro futura puede agregar lookahead + soft knee, pero hard clip a -0.3 dB
// alcanza para garantizar que nunca llegue +1.0 al DAC.
#[allow(dead_code)]
struct LimiterSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    wet_actual: f32,
    sample_counter: u32,
    cached_ceiling: f32,
}

const LIMITER_RAMP_INCREMENT: f32 = 1.0 / 256.0; // ~5.8 ms @ 44.1 kHz
const LIMITER_CEILING_REFRESH_SAMPLES: u32 = 1024; // recálculo cada ~12 ms

impl<S> LimiterSource<S>
where
    S: Source<Item = Sample>,
{
    #[allow(dead_code)]
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let initial_wet = f32::from_bits(params.limiter_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        Self {
            source,
            params,
            wet_actual: initial_wet,
            sample_counter: 0,
            cached_ceiling: 1.0,
        }
    }

    #[inline]
    fn advance_wet(&mut self) {
        let target = f32::from_bits(self.params.limiter_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.wet_actual < target {
            self.wet_actual = (self.wet_actual + LIMITER_RAMP_INCREMENT).min(target);
        } else if self.wet_actual > target {
            self.wet_actual = (self.wet_actual - LIMITER_RAMP_INCREMENT).max(target);
        }
    }

    #[inline]
    fn read_ceiling_linear(&mut self) -> f32 {
        // Recalculamos el ceiling cada N samples para amortizar el costo de
        // powf (caro relativo a multiplicar). En 12 ms el ceiling no cambia
        // perceptiblemente, así que el cache es seguro.
        if self.sample_counter % LIMITER_CEILING_REFRESH_SAMPLES == 0 {
            let db = f32::from_bits(self.params.limiter_ceiling_db_bits.load(Ordering::Relaxed))
                .clamp(-12.0, 0.0);
            self.cached_ceiling = 10f32.powf(db / 20.0);
        }
        self.cached_ceiling
    }
}

impl<S> Iterator for LimiterSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        self.advance_wet();
        let ceiling = self.read_ceiling_linear();
        let limited = sample.clamp(-ceiling, ceiling);
        let wet = self.wet_actual;
        let out = sample * (1.0 - wet) + limited * wet;
        self.sample_counter = self.sample_counter.wrapping_add(1);
        Some(out)
    }
}

impl<S> Source for LimiterSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

// ============================================================================
// FASE D · sub-paso 11.4 — DynamicDspSource (orden dinámico de bloques DSP)
// ============================================================================
//
// Reemplaza la cascada cableada PreAmp→Pan→Mono→EQ→Comp→Limiter por una única
// Source que procesa por par estéreo (L, R) y aplica 3 bloques atómicos en el
// orden que dicta `params.fx_order`:
//
//   Bloque 0 — EQ-meta: PreAmp + Pan + Mono + 8 biquads peaking (atrapados en
//              el switch global `eq_wet_target_bits`, con sub-rampa para Mono).
//   Bloque 1 — Compressor (AGC) con envelope follower + ratio + makeup.
//   Bloque 2 — Limiter de protección hard clip (-0.3 dBFS default).
//
// Topología por par estéreo:
//   (L_in, R_in) → block[order[0]] → block[order[1]] → block[order[2]] → (L_out, R_out)
//
// El atómico `fx_order` se lee UNA vez por par estéreo (no por sample) para
// garantizar que ambos canales pasen por los mismos bloques en el mismo orden
// — sin esto, un reorder a mitad de un par dejaría L y R en bloques distintos.
//
// El Iterator emite samples uno a uno (L, R, L, R, ...). El estado `pending_r`
// guarda el R ya procesado entre llamadas consecutivas. Cero locks, cero
// alocaciones — listo para hot path.
//
// Conserva el comportamiento de wet/dry rampa de cada bloque y AGC↔Limiter
// excluyentes (ya forzado por el handler "fx" y el frontend).

struct DynamicDspSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    sample_rate: f32,
    channels: usize,
    pending_r: Option<Sample>,

    // ── Bloque EQ-meta: estado interno ───────────────────────────────────
    // Wet del módulo EQ entero (rampa hacia eq_wet_target_bits).
    eq_meta_wet_actual: f32,
    // Wet específico de Mono (rampa hacia eq_wet_actual * mono_intent).
    mono_wet_actual: f32,
    // 8 bandas EQ con estado L/R independiente.
    eq_bands: [EqBand; 8],
    eq_sample_counter: u32,

    // ── Bloque Compressor: estado interno ────────────────────────────────
    comp_envelope: f32,
    comp_wet_actual: f32,
    comp_sample_counter: u32,
    comp_cached_threshold_linear: f32,
    comp_cached_ratio: f32,
    comp_cached_attack_coef: f32,
    comp_cached_release_coef: f32,
    comp_cached_makeup_linear: f32,

    // ── Bloque Limiter: estado interno ───────────────────────────────────
    lim_wet_actual: f32,
    lim_sample_counter: u32,
    lim_cached_ceiling: f32,
}

impl<S> DynamicDspSource<S>
where
    S: Source<Item = Sample>,
{
    fn new(source: S, params: Arc<DspParams>) -> Self {
        let sample_rate = source.sample_rate().get() as f32;
        let channels = source.channels().get() as usize;

        let initial_eq_wet = f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let initial_mono_intent = f32::from_bits(params.mono_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let initial_comp_wet = f32::from_bits(params.comp_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let initial_lim_wet = f32::from_bits(params.limiter_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);

        let mut me = Self {
            source,
            params,
            sample_rate,
            channels: channels.max(1),
            pending_r: None,
            eq_meta_wet_actual: initial_eq_wet,
            mono_wet_actual: initial_eq_wet * initial_mono_intent,
            eq_bands: [
                EqBand::new(), EqBand::new(), EqBand::new(), EqBand::new(),
                EqBand::new(), EqBand::new(), EqBand::new(), EqBand::new(),
            ],
            eq_sample_counter: 0,
            comp_envelope: 0.0,
            comp_wet_actual: initial_comp_wet,
            comp_sample_counter: 0,
            comp_cached_threshold_linear: 1.0,
            comp_cached_ratio: 1.0,
            comp_cached_attack_coef: 0.01,
            comp_cached_release_coef: 0.001,
            comp_cached_makeup_linear: 1.0,
            lim_wet_actual: initial_lim_wet,
            lim_sample_counter: 0,
            lim_cached_ceiling: 1.0,
        };
        me.refresh_eq_coeffs();
        me.refresh_comp_params();
        me.refresh_lim_ceiling();
        me
    }

    // ── EQ-meta helpers ──────────────────────────────────────────────────

    fn refresh_eq_coeffs(&mut self) {
        for i in 0..8 {
            let freq = f32::from_bits(self.params.eq_bands[i].freq_hz_bits.load(Ordering::Relaxed));
            let q = f32::from_bits(self.params.eq_bands[i].q_bits.load(Ordering::Relaxed));
            let gain_db = f32::from_bits(self.params.eq_bands[i].gain_db_bits.load(Ordering::Relaxed));
            self.eq_bands[i].update_coeffs(freq, q, gain_db, self.sample_rate);
        }
    }

    #[inline]
    fn advance_eq_wet(&mut self) {
        let target = f32::from_bits(self.params.eq_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.eq_meta_wet_actual < target {
            self.eq_meta_wet_actual = (self.eq_meta_wet_actual + EQ_MODULE_RAMP_INCREMENT).min(target);
        } else if self.eq_meta_wet_actual > target {
            self.eq_meta_wet_actual = (self.eq_meta_wet_actual - EQ_MODULE_RAMP_INCREMENT).max(target);
        }
        let mono_intent = f32::from_bits(self.params.mono_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let mono_target = self.eq_meta_wet_actual * mono_intent;
        if self.mono_wet_actual < mono_target {
            self.mono_wet_actual = (self.mono_wet_actual + EQ_MODULE_RAMP_INCREMENT).min(mono_target);
        } else if self.mono_wet_actual > mono_target {
            self.mono_wet_actual = (self.mono_wet_actual - EQ_MODULE_RAMP_INCREMENT).max(mono_target);
        }
    }

    #[inline]
    fn read_preamp_linear(&self) -> f32 {
        let db = f32::from_bits(self.params.preamp_db_bits.load(Ordering::Relaxed))
            .clamp(-24.0, 24.0);
        10f32.powf(db / 20.0)
    }

    #[inline]
    fn read_pan_gains(&self) -> (f32, f32) {
        // Ley balance lineal: pan=0 → (1.0, 1.0) unity perfecto.
        let pan = f32::from_bits(self.params.pan_bits.load(Ordering::Relaxed))
            .clamp(-1.0, 1.0);
        let gain_l = if pan <= 0.0 { 1.0 } else { 1.0 - pan };
        let gain_r = if pan >= 0.0 { 1.0 } else { 1.0 + pan };
        (gain_l, gain_r)
    }

    /// Procesa un par (L, R) por el bloque EQ-meta entero: PreAmp → Pan →
    /// Mono → 8 biquads. Todo bypasseado con `eq_meta_wet_actual` salvo Mono
    /// que usa su rampa propia.
    #[inline]
    fn process_eq_block(&mut self, l_in: Sample, r_in: Sample) -> (Sample, Sample) {
        if self.eq_sample_counter % EQ_COEFFS_REFRESH_SAMPLES == 0 {
            self.refresh_eq_coeffs();
        }
        self.advance_eq_wet();
        self.eq_sample_counter = self.eq_sample_counter.wrapping_add(2);

        let wet = self.eq_meta_wet_actual;
        let dry = 1.0 - wet;

        // PreAmp (escalado lineal por wet).
        let gain = self.read_preamp_linear();
        let pre_factor = dry + wet * gain;
        let mut l = l_in * pre_factor;
        let mut r = r_in * pre_factor;

        // Pan (gana cada canal según ley balance lineal).
        if self.channels >= 2 {
            let (gl, gr) = self.read_pan_gains();
            l *= dry + wet * gl;
            r *= dry + wet * gr;
        }

        // Mono (suma y duplica). Mezcla controlada por mono_wet_actual.
        if self.channels >= 2 {
            let mixed = (l + r) * 0.5;
            let mwet = self.mono_wet_actual;
            let mdry = 1.0 - mwet;
            l = l * mdry + mixed * mwet;
            r = r * mdry + mixed * mwet;
        }

        // 8 biquads peaking en cascada por canal.
        let mut l_eq = l;
        let mut r_eq = r;
        for band in self.eq_bands.iter_mut() {
            let b0 = band.b0; let b1 = band.b1; let b2 = band.b2;
            let a1 = band.a1; let a2 = band.a2;
            l_eq = band.l.process(l_eq, b0, b1, b2, a1, a2);
            r_eq = band.r.process(r_eq, b0, b1, b2, a1, a2);
        }
        let out_l = l * dry + l_eq * wet;
        let out_r = r * dry + r_eq * wet;
        (out_l, out_r)
    }

    // ── Compressor helpers ───────────────────────────────────────────────

    fn refresh_comp_params(&mut self) {
        let threshold_db = f32::from_bits(self.params.comp_threshold_db_bits.load(Ordering::Relaxed))
            .clamp(-60.0, 0.0);
        let ratio = f32::from_bits(self.params.comp_ratio_bits.load(Ordering::Relaxed))
            .clamp(1.0, 20.0);
        let attack_ms = f32::from_bits(self.params.comp_attack_ms_bits.load(Ordering::Relaxed))
            .clamp(0.1, 500.0);
        let release_ms = f32::from_bits(self.params.comp_release_ms_bits.load(Ordering::Relaxed))
            .clamp(1.0, 5000.0);
        let makeup_db = f32::from_bits(self.params.comp_makeup_db_bits.load(Ordering::Relaxed))
            .clamp(-24.0, 24.0);
        let sr_safe = self.sample_rate.max(1.0);
        self.comp_cached_threshold_linear = 10f32.powf(threshold_db / 20.0);
        self.comp_cached_ratio = ratio;
        self.comp_cached_attack_coef = 1.0 - (-1.0 / (attack_ms * 0.001 * sr_safe)).exp();
        self.comp_cached_release_coef = 1.0 - (-1.0 / (release_ms * 0.001 * sr_safe)).exp();
        self.comp_cached_makeup_linear = 10f32.powf(makeup_db / 20.0);
    }

    #[inline]
    fn advance_comp_wet(&mut self) {
        let target = f32::from_bits(self.params.comp_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.comp_wet_actual < target {
            self.comp_wet_actual = (self.comp_wet_actual + COMPRESSOR_RAMP_INCREMENT).min(target);
        } else if self.comp_wet_actual > target {
            self.comp_wet_actual = (self.comp_wet_actual - COMPRESSOR_RAMP_INCREMENT).max(target);
        }
    }

    /// Procesa un par (L, R) por el compresor. Mantiene un solo envelope
    /// compartido (peak del mayor entre |L| y |R|) para que la reducción de
    /// ganancia sea idéntica en ambos canales (estándar broadcast).
    #[inline]
    fn process_comp_block(&mut self, l_in: Sample, r_in: Sample) -> (Sample, Sample) {
        if self.comp_sample_counter % COMPRESSOR_REFRESH_SAMPLES == 0 {
            self.refresh_comp_params();
        }
        self.advance_comp_wet();
        self.comp_sample_counter = self.comp_sample_counter.wrapping_add(2);

        let peak = l_in.abs().max(r_in.abs());
        let coef = if peak > self.comp_envelope {
            self.comp_cached_attack_coef
        } else {
            self.comp_cached_release_coef
        };
        self.comp_envelope += (peak - self.comp_envelope) * coef;

        let gain_linear = if self.comp_envelope > self.comp_cached_threshold_linear {
            let exponent = (self.comp_cached_ratio - 1.0) / self.comp_cached_ratio;
            (self.comp_cached_threshold_linear / self.comp_envelope).powf(exponent)
        } else {
            1.0
        };

        let mu = self.comp_cached_makeup_linear;
        let comp_l = l_in * gain_linear * mu;
        let comp_r = r_in * gain_linear * mu;

        let wet = self.comp_wet_actual;
        let dry = 1.0 - wet;
        (l_in * dry + comp_l * wet, r_in * dry + comp_r * wet)
    }

    // ── Limiter helpers ──────────────────────────────────────────────────

    fn refresh_lim_ceiling(&mut self) {
        let db = f32::from_bits(self.params.limiter_ceiling_db_bits.load(Ordering::Relaxed))
            .clamp(-12.0, 0.0);
        self.lim_cached_ceiling = 10f32.powf(db / 20.0);
    }

    #[inline]
    fn advance_lim_wet(&mut self) {
        let target = f32::from_bits(self.params.limiter_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        if self.lim_wet_actual < target {
            self.lim_wet_actual = (self.lim_wet_actual + LIMITER_RAMP_INCREMENT).min(target);
        } else if self.lim_wet_actual > target {
            self.lim_wet_actual = (self.lim_wet_actual - LIMITER_RAMP_INCREMENT).max(target);
        }
    }

    #[inline]
    fn process_lim_block(&mut self, l_in: Sample, r_in: Sample) -> (Sample, Sample) {
        if self.lim_sample_counter % LIMITER_CEILING_REFRESH_SAMPLES == 0 {
            self.refresh_lim_ceiling();
        }
        self.advance_lim_wet();
        self.lim_sample_counter = self.lim_sample_counter.wrapping_add(2);
        let ceil = self.lim_cached_ceiling;
        let lim_l = l_in.clamp(-ceil, ceil);
        let lim_r = r_in.clamp(-ceil, ceil);
        let wet = self.lim_wet_actual;
        let dry = 1.0 - wet;
        (l_in * dry + lim_l * wet, r_in * dry + lim_r * wet)
    }

    /// Aplica los 3 bloques en el orden indicado por el atómico `fx_order`.
    /// Lee el atómico UNA vez por par estéreo: ambos canales pasan por el
    /// mismo orden de bloques (anti-reorder a mitad de par).
    #[inline]
    fn process_stereo_pair(&mut self, l_in: Sample, r_in: Sample) -> (Sample, Sample) {
        let order = self.params.fx_order.load(Ordering::Relaxed);
        let mut l = l_in;
        let mut r = r_in;
        for i in 0..3_u32 {
            let idx = (order >> (i * 2)) & 0b11;
            match idx {
                0 => { let (nl, nr) = self.process_eq_block(l, r); l = nl; r = nr; }
                1 => { let (nl, nr) = self.process_comp_block(l, r); l = nl; r = nr; }
                2 => { let (nl, nr) = self.process_lim_block(l, r); l = nl; r = nr; }
                _ => {}
            }
        }
        (l, r)
    }
}

impl<S> Iterator for DynamicDspSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        // Emisión alternada L → R → L → R. Cuando ya tenemos R buffereada
        // por la llamada anterior, la entregamos sin procesar de nuevo.
        if let Some(r) = self.pending_r.take() {
            return Some(r);
        }
        // Mono fuente: pass-through 1:1 sin pareado.
        if self.channels < 2 {
            return self.source.next().map(|s| {
                let (out, _) = self.process_stereo_pair(s, s);
                out
            });
        }
        let l_in = self.source.next()?;
        let r_in = self.source.next()?;
        let (l_out, r_out) = self.process_stereo_pair(l_in, r_in);
        self.pending_r = Some(r_out);
        Some(l_out)
    }
}

impl<S> Source for DynamicDspSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

// ============================================================================
// FASE D · sub-paso 8.1 — Bifurcación de señal (MultiTee + TapConsumer)
// ============================================================================
// `MultiTeeSource` se inserta en la cadena del program_mixer ANTES del fader
// master. Para cada sample que pasa, lo replica en N ring buffers `rtrb` SPSC
// (uno por consumidor secundario: monitor, encoder, futuros). El passthrough
// principal sigue alimentando al sink PGM como siempre.
//
// `TapConsumerSource` es el otro extremo: consume del ring y entrega los
// samples como `Source` a otro sink (monitor) o consumidor (encoder). Si el
// ring está vacío (productor más lento), entrega silencio en vez de bloquear.
// Si el ring está lleno (consumidor más lento), el productor dropea el sample
// más viejo silenciosamente (filosofía: jamás bloquear el thread de audio).
struct MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    taps: Vec<rtrb::Producer<Sample>>,
}

impl<S> MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    fn new(source: S, taps: Vec<rtrb::Producer<Sample>>) -> Self {
        Self { source, taps }
    }
}

impl<S> Iterator for MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        for tap in self.taps.iter_mut() {
            // push() retorna Err si el ring está lleno. Silencioso: el audio
            // del PGM no se ve afectado. El consumidor lento simplemente
            // pierde samples (mejor que bloquear el thread de audio).
            let _ = tap.push(sample);
        }
        Some(sample)
    }
}

impl<S> Source for MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

/// Umbral por encima del cual el TapConsumerSource entiende que el productor
/// "se adelantó" (típicamente al arranque cuando los dos sinks físicos no
/// comenzaron al mismo tiempo) y dropea samples viejos para alinear la
/// latencia al objetivo. Sin este drenado, el ring se enclava a su capacidad
/// máxima y produce delays perceptibles (1-2 seg en la queja del operador).
///
/// Subido de 256 (~3 ms) a 2048 (~23 ms estéreo @ 44.1 kHz) para tolerar
/// jitter del resampler implícito de rodio cuando el sink físico del monitor
/// opera a un sample-rate distinto del program_mixer (típico: 48 kHz nativo
/// vs 44.1 kHz interno). Con target demasiado bajo el ring se vaciaba a 0
/// entre samples y el `DualTapConsumerSource` entregaba ceros → distorsión
/// audible. 23 ms cubre el peak-to-peak observado en máquinas Windows con
/// WASAPI y aún es indetectable como latencia (consola física tolera 30-50 ms
/// de delay entre PGM y Booth sin ser molesto al operador).
const TAP_DRAIN_TARGET_SAMPLES: usize = 2_048;   // ~23 ms estéreo @ 44.1 kHz

/// Helper: dropea samples del ring en pares (preserva fase L-R) hasta
/// dejar a lo sumo `target` samples disponibles.
#[inline]
fn drain_to_target(consumer: &mut rtrb::Consumer<Sample>, target: usize) {
    let available = consumer.slots();
    if available <= target { return; }
    let mut to_drop = (available - target) & !1;
    while to_drop > 0 {
        if consumer.pop().is_err() { break; }
        to_drop -= 1;
    }
}

/// FASE D · sub-paso 11.3 — Dual tap consumer.
/// Lee de DOS ring buffers (Pre-FX y Post-FX) y entrega samples del que
/// el atómico `mode_atom` indique (0 = preFx, 1 = postFx). El otro ring se
/// drena agresivamente para que no acumule memoria si está inactivo.
/// La conmutación es en caliente, sample-by-sample, sin reconstruir el grafo.
struct DualTapConsumerSource {
    pre_consumer: rtrb::Consumer<Sample>,
    post_consumer: rtrb::Consumer<Sample>,
    mode_atom: Arc<DspParams>, // contiene el atómico que decide pre/post
    is_monitor: bool,           // true = lee monitor_tap_mode; false = encoder_tap_mode
    channels: ChannelCount,
    sample_rate: SampleRate,
}

impl DualTapConsumerSource {
    fn new(
        pre_consumer: rtrb::Consumer<Sample>,
        post_consumer: rtrb::Consumer<Sample>,
        params: Arc<DspParams>,
        is_monitor: bool,
        channels: ChannelCount,
        sample_rate: SampleRate,
    ) -> Self {
        Self { pre_consumer, post_consumer, mode_atom: params, is_monitor, channels, sample_rate }
    }

    #[inline]
    fn current_mode(&self) -> u8 {
        if self.is_monitor {
            self.mode_atom.monitor_tap_mode.load(Ordering::Relaxed)
        } else {
            self.mode_atom.encoder_tap_mode.load(Ordering::Relaxed)
        }
    }
}

impl Iterator for DualTapConsumerSource {
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let mode = self.current_mode();
        // Anti-acumulación en AMBOS rings. El activo se mantiene en ~3 ms
        // (target); el inactivo se drena por completo (target=0) para no
        // dejar memoria muerta acumulando samples.
        if mode == 0 {
            drain_to_target(&mut self.pre_consumer, TAP_DRAIN_TARGET_SAMPLES);
            drain_to_target(&mut self.post_consumer, 0);
            Some(self.pre_consumer.pop().unwrap_or(0.0))
        } else {
            drain_to_target(&mut self.post_consumer, TAP_DRAIN_TARGET_SAMPLES);
            drain_to_target(&mut self.pre_consumer, 0);
            Some(self.post_consumer.pop().unwrap_or(0.0))
        }
    }
}

impl Source for DualTapConsumerSource {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> ChannelCount { self.channels }
    fn sample_rate(&self) -> SampleRate { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { None }
    fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> {
        Err(SeekError::NotSupported { underlying_source: "DualTapConsumerSource" })
    }
}

// ============================================================================

struct RuntimePlayer {
    state: PlayerState,
    player: Option<Player>,
    meter: Arc<PlayerMeter>,
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

#[derive(Default)]
struct PlayerMeter {
    left_peak_bits: AtomicU32,
    right_peak_bits: AtomicU32,
}

impl PlayerMeter {
    fn reset(&self) {
        self.left_peak_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
        self.right_peak_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
    }

    fn set_peaks(&self, left: f32, right: f32) {
        self.left_peak_bits.store(left.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.right_peak_bits.store(right.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    fn read(&self) -> (f32, f32) {
        (
            f32::from_bits(self.left_peak_bits.load(Ordering::Relaxed)),
            f32::from_bits(self.right_peak_bits.load(Ordering::Relaxed)),
        )
    }
}

struct MeteredSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    meter: Arc<PlayerMeter>,
    channels: usize,
    sample_index: usize,
    window_samples: usize,
    window_left_peak: f32,
    window_right_peak: f32,
}

impl<S> MeteredSource<S>
where
    S: Source<Item = Sample>,
{
    fn new(source: S, meter: Arc<PlayerMeter>) -> Self {
        let channels = source.channels().get() as usize;
        meter.reset();
        Self {
            source,
            meter,
            channels: channels.max(1),
            sample_index: 0,
            window_samples: 0,
            window_left_peak: 0.0,
            window_right_peak: 0.0,
        }
    }
}

impl<S> Iterator for MeteredSource<S>
where
    S: Source<Item = Sample>,
{
    type Item = Sample;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        let channel = self.sample_index % self.channels;
        let amplitude = sample.abs().min(1.0);
        if self.channels == 1 {
            self.window_left_peak = self.window_left_peak.max(amplitude);
            self.window_right_peak = self.window_right_peak.max(amplitude);
        } else if channel == 0 {
            self.window_left_peak = self.window_left_peak.max(amplitude);
        } else if channel == 1 {
            self.window_right_peak = self.window_right_peak.max(amplitude);
        }

        self.sample_index = self.sample_index.wrapping_add(1);
        self.window_samples += 1;
        if self.window_samples >= 1024 {
            self.meter.set_peaks(self.window_left_peak, self.window_right_peak);
            self.window_samples = 0;
            self.window_left_peak = 0.0;
            self.window_right_peak = 0.0;
        }
        Some(sample)
    }
}

impl<S> Source for MeteredSource<S>
where
    S: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }

    // Delegar `try_seek` al decoder interno. Sin este override, rodio usaba
    // la implementación por defecto del trait `Source::try_seek` (que devuelve
    // `Err(SeekError::NotSupported)`), y por eso ningún `player.try_seek(...)`
    // movía el cabezal: el wrapper ocultaba la capacidad del decoder.
    // Reseteamos también el estado interno del medidor para que los picos
    // empiecen limpios desde la nueva posición.
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let result = self.source.try_seek(pos);
        if result.is_ok() {
            self.meter.reset();
            self.sample_index = 0;
            self.window_samples = 0;
            self.window_left_peak = 0.0;
            self.window_right_peak = 0.0;
        }
        result
    }
}

// ============================================================================
// PcmRingSource — fuente de audio desde ring buffer rtrb (streams en vivo)
// ============================================================================
// Permite inyectar audio PCM de una fuente externa (p.ej. FFmpeg leyendo una
// URL de radio) directamente en el program_mixer. El hilo IPC escribe f32 en
// el ring buffer via `stream_chunk`; el hilo de audio (rodio) los consume aquí.
//
// Comportamiento:
//   - Buffer vacío + finished=false → silencio (underrun sin parar la cadena).
//   - Buffer vacío + finished=true  → devuelve None (fin de stream, rodio
//     descarta este Source del Player y pasa al siguiente, si hay).
//
// Capacidad típica: 2 s de audio stereo a 44100 Hz = 176 400 muestras f32.
// El hilo IPC descarta el chunk si el ring está lleno (overrun), evitando
// que el stream se adelante en el tiempo respecto a la reproducción en vivo.

struct PcmRingSource {
    consumer: rtrb::Consumer<f32>,
    finished: Arc<AtomicBool>,
    channels: ChannelCount,
    sample_rate: SampleRate,
}

impl Iterator for PcmRingSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        match self.consumer.pop() {
            Ok(sample) => Some(sample),
            Err(_) => {
                if self.finished.load(Ordering::Relaxed) {
                    None     // stream terminado y buffer drenado → fin de Source
                } else {
                    Some(0.0) // underrun temporal → silencio sin cortar la cadena
                }
            }
        }
    }
}

impl Source for PcmRingSource {
    fn current_span_len(&self) -> Option<usize> {
        None // continuo (rodio no puede optimizar chunks)
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None // duración desconocida (stream vivo)
    }
    fn try_seek(&mut self, _pos: Duration) -> Result<(), SeekError> {
        Ok(()) // seek no aplicable a streams en vivo
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn json_get_string(input: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in after_colon[1..].chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

fn json_get_u64(input: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let value = after_key[colon + 1..]
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    value.parse().ok()
}

fn json_get_f32(input: &str, key: &str) -> Option<f32> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let value = after_key[colon + 1..]
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
        .collect::<String>();
    value.parse().ok()
}

/// Parser minimal de array de f32 dentro de JSON. Hecho a mano para no
/// arrastrar serde_json. Soporta sólo arrays planos como `[1.5, -3, 0, 2.1]`
/// — suficiente para el campo `bands` del comando `fx`.
fn json_get_f32_array(input: &str, key: &str) -> Option<Vec<f32>> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    if !after_colon.starts_with('[') {
        return None;
    }
    let close = after_colon.find(']')?;
    let inner = &after_colon[1..close];
    let values: Vec<f32> = inner
        .split(',')
        .filter_map(|s| s.trim().parse::<f32>().ok())
        .collect();
    Some(values)
}

/// Parser minimal de array de strings JSON. Hecho a mano para no arrastrar
/// serde_json. Soporta sólo arrays planos como `["eq", "comp", "limiter"]`
/// — suficiente para el campo `order` del comando `fx`. No interpreta
/// escapes en las cadenas (los IDs internos del frontend son ASCII puros).
fn json_get_string_array(input: &str, key: &str) -> Option<Vec<String>> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    if !after_colon.starts_with('[') {
        return None;
    }
    let close = after_colon.find(']')?;
    let inner = &after_colon[1..close];
    let values: Vec<String> = inner
        .split(',')
        .map(|s| s.trim())
        .filter_map(|s| {
            // Cada elemento debe venir entre comillas: "eq", "comp"...
            if s.len() < 2 || !s.starts_with('"') || !s.ends_with('"') {
                return None;
            }
            Some(s[1..s.len() - 1].to_string())
        })
        .collect();
    Some(values)
}

fn json_get_bool(input: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let value = after_key[colon + 1..].trim_start();
    if value.starts_with("true") {
        Some(true)
    } else if value.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn json_get_array_body<'a>(input: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\"", key);
    let start = input.find(&needle)?;
    let after_key = &input[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    if !after_colon.starts_with('[') {
        return None;
    }
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut body_start = None;
    for (idx, ch) in after_colon.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '[' {
            depth += 1;
            if depth == 1 {
                body_start = Some(idx + 1);
            }
        } else if ch == ']' {
            depth -= 1;
            if depth == 0 {
                return body_start.map(|s| &after_colon[s..idx]);
            }
        }
    }
    None
}

fn split_json_objects(input: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut start_idx = None;
    for (idx, ch) in input.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start_idx = Some(idx);
            }
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start_idx.take() {
                    objects.push(&input[start..=idx]);
                }
            }
        }
    }
    objects
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn request_id_field(request_id: &str) -> String {
    if request_id.is_empty() {
        String::new()
    } else {
        format!("\"requestId\":\"{}\",", escape_json(request_id))
    }
}

fn emit_status(state: &EngineState, request_id: &str) {
    let mut active_outputs = Vec::new();
    for (id, output) in &state.outputs {
        active_outputs.push(format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            escape_json(id),
            escape_json(&output.name)
        ));
    }

    let mut players = Vec::new();
    let mut meters = Vec::new();
    let is_time_locution_active = state.time_locution_started_at.is_some()
        && !state.time_locution_player.is_empty();
    for (id, runtime) in &state.players {
        let audio_ready = runtime.player.is_some();
        // Si este player sostiene la locución horaria activa, reportamos el
        // reloj acumulativo de la pista virtual unificada (HRS+MIN) en lugar
        // del `Player::get_pos()` interno de rodio (que se resetea al cambiar
        // de archivo encolado y producía rebote en la barra del frontend).
        let is_this_time_locution = is_time_locution_active && *id == state.time_locution_player;
        let raw_pos_ms = runtime
            .player
            .as_ref()
            .map(|player| player.get_pos().as_millis() as u64)
            .unwrap_or(runtime.state.position_ms);
        let position_ms = if is_this_time_locution {
            let elapsed = state.time_locution_started_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            elapsed.min(state.time_locution_total_ms)
        } else {
            raw_pos_ms
        };
        // `durationMs`: para la locución horaria activa emitimos la suma
        // HRS+MIN como pista unificada. Para el resto usamos la duración
        // leída del decoder al cargar (`runtime.state.duration_ms`), que
        // permite que el frontend pinte la barra de progreso del cartwall
        // y otros players sin depender del HTMLMediaElement.
        let duration_ms: u64 = if is_this_time_locution {
            state.time_locution_total_ms
        } else {
            runtime.state.duration_ms
        };
        let status = runtime
            .player
            .as_ref()
            .map(|player| {
                if player.empty() && runtime.state.status == "playing" {
                    "ended".to_string()
                } else if player.is_paused() {
                    "paused".to_string()
                } else {
                    runtime.state.status.clone()
                }
            })
            .unwrap_or_else(|| runtime.state.status.clone());
        players.push(format!(
            "{{\"id\":\"{}\",\"status\":\"{}\",\"path\":\"{}\",\"positionMs\":{},\"durationMs\":{},\"gain\":{},\"audioReady\":{},\"outputDeviceId\":\"{}\",\"outputDeviceName\":\"{}\"}}",
            escape_json(id),
            escape_json(&status),
            escape_json(&runtime.state.path),
            position_ms,
            duration_ms,
            runtime.state.gain,
            audio_ready,
            escape_json(&runtime.state.output_device_id),
            escape_json(&runtime.state.output_device_name)
        ));
        let bus = if runtime.state.bus_id.trim().is_empty() {
            default_bus_for_player(id).to_string()
        } else {
            runtime.state.bus_id.clone()
        };
        let (meter_left, meter_right) = runtime.meter.read();
        let gain = runtime.state.gain.clamp(0.0, 2.0);
        let left_percent = if audio_ready && status == "playing" && gain > 0.0 {
            (meter_left * gain * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let right_percent = if audio_ready && status == "playing" && gain > 0.0 {
            (meter_right * gain * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let peak_percent = left_percent.max(right_percent);
        let meter_db = if peak_percent <= 0.0 {
            -120.0
        } else {
            20.0 * (peak_percent / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"{}\",\"bus\":\"{}\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"{}\",\"source\":\"player\"}}",
            escape_json(id),
            escape_json(&bus),
            left_percent,
            right_percent,
            meter_db,
            escape_json(&status)
        ));
    }

    // FASE D · sub-paso 7.6: meter MASTER post-fader (la señal real que sale
    // al sink físico PGM, ya con master_gain aplicado). source="bus" lo
    // distingue de los meters per-player; el frontend puede preferirlo sobre
    // la suma calculada cuando esté disponible.
    if state.program_mixer_input.is_some() {
        let (m_left, m_right) = state.master_bus_meter.read();
        let m_left_pct = (m_left * 100.0).clamp(0.0, 100.0);
        let m_right_pct = (m_right * 100.0).clamp(0.0, 100.0);
        let m_peak_pct = m_left_pct.max(m_right_pct);
        let m_db = if m_peak_pct <= 0.0 {
            -120.0
        } else {
            20.0 * (m_peak_pct / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"master\",\"bus\":\"master\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"playing\",\"source\":\"bus\"}}",
            m_left_pct, m_right_pct, m_db
        ));
    }

    // FASE D · sub-paso 8.1: meter MONITOR post-fader (la señal real que sale
    // al sink físico de Booth, ya con monitor_gain aplicado). Solo se emite
    // si la cadena monitor está cableada (route_bus("monitor", ...)).
    if !state.monitor_sink_id.is_empty() {
        let (m_left, m_right) = state.monitor_bus_meter.read();
        let m_left_pct = (m_left * 100.0).clamp(0.0, 100.0);
        let m_right_pct = (m_right * 100.0).clamp(0.0, 100.0);
        let m_peak_pct = m_left_pct.max(m_right_pct);
        let m_db = if m_peak_pct <= 0.0 {
            -120.0
        } else {
            20.0 * (m_peak_pct / 100.0).log10()
        };
        meters.push(format!(
            "{{\"id\":\"monitor\",\"bus\":\"monitor\",\"left\":{},\"right\":{},\"db\":{},\"status\":\"playing\",\"source\":\"bus\"}}",
            m_left_pct, m_right_pct, m_db
        ));
    }

    let mut buses = Vec::new();
    for (bus, route) in &state.routes {
        buses.push(format!(
            "{{\"id\":\"{}\",\"outputDeviceId\":\"{}\",\"outputDeviceName\":\"{}\"}}",
            escape_json(bus),
            escape_json(&route.output_device_id),
            escape_json(&route.output_device_name)
        ));
    }
    let now_playing = state.now_playing.as_ref().map(|item| {
        format!(
            "{{\"title\":\"{}\",\"artist\":\"{}\",\"path\":\"{}\",\"player\":\"{}\",\"source\":\"{}\",\"updatedAt\":{}}}",
            escape_json(&item.title),
            escape_json(&item.artist),
            escape_json(&item.path),
            escape_json(&item.player),
            escape_json(&item.source),
            item.updated_at
        )
    }).unwrap_or_else(|| "null".to_string());
    let transport = state.transport.as_ref().map(|item| {
        format!(
            "{{\"player\":\"{}\",\"status\":\"{}\",\"positionMs\":{},\"durationMs\":{},\"startCause\":\"{}\",\"mixActive\":{},\"mixPhase\":\"{}\",\"mixDirection\":\"{}\",\"mixReferencePlayer\":\"{}\",\"updatedAt\":{}}}",
            escape_json(&item.player),
            escape_json(&item.status),
            item.position_ms,
            item.duration_ms,
            escape_json(&item.start_cause),
            item.mix_active,
            escape_json(&item.mix_phase),
            escape_json(&item.mix_direction),
            escape_json(&item.mix_reference_player),
            item.updated_at
        )
    }).unwrap_or_else(|| "null".to_string());
    let encoder = format!(
        "{{\"active\":{},\"source\":\"{}\",\"owner\":\"{}\",\"requestedOwner\":\"{}\",\"captureProvider\":\"{}\",\"encoderProvider\":\"{}\",\"rustPcmReady\":{},\"pcmBridgeReady\":{},\"pcmBridgeMode\":\"{}\",\"pcmBridgeReason\":\"{}\",\"fallbackReason\":\"{}\",\"captureFormat\":\"{}\",\"sampleRate\":{},\"transport\":\"{}\",\"bitrateKbps\":{},\"speed\":{},\"ffmpegTime\":\"{}\",\"maxGapMs\":{},\"gapWarnings\":{},\"updatedAt\":{}}}",
        state.encoder.active,
        escape_json(&state.encoder.source_bus),
        escape_json(&state.encoder.owner),
        escape_json(&state.encoder.requested_owner),
        escape_json(&state.encoder.capture_provider),
        escape_json(&state.encoder.encoder_provider),
        state.encoder.rust_pcm_ready,
        state.encoder.pcm_bridge_ready,
        escape_json(&state.encoder.pcm_bridge_mode),
        escape_json(&state.encoder.pcm_bridge_reason),
        escape_json(&state.encoder.fallback_reason),
        escape_json(&state.encoder.capture_format),
        state.encoder.sample_rate,
        escape_json(&state.encoder.transport),
        state.encoder.bitrate_kbps,
        state.encoder.speed,
        escape_json(&state.encoder.ffmpeg_time),
        state.encoder.max_gap_ms,
        state.encoder.gap_warnings,
        state.encoder.updated_at
    );
    println!(
        "{{{}\"type\":\"status\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"labPlayback\":{},\"updatedAt\":{},\"activeOutputs\":[{}],\"buses\":[{}],\"nowPlaying\":{},\"transport\":{},\"encoder\":{},\"players\":[{}],\"meters\":[{}]}}",
        request_id_field(request_id),
        has_active_audio(state),
        now_ms(),
        active_outputs.join(","),
        buses.join(","),
        now_playing,
        transport,
        encoder,
        players.join(","),
        meters.join(",")
    );
    let _ = io::stdout().flush();
}

/// FASE D · sub-paso 8.2 — Drena el `encoder_tap_consumer` y emite un chunk
/// PCM s16le base64 por stdout (mensaje `pcmChunk`). El probe Node lo recibe
/// y lo pipea al stdin de FFmpeg.
///
/// Convierte cada f32 del ring a i16 con clipping en [-1.0, +1.0]. El audio
/// del PGM YA pasó por el limiter (cuando esté implementado en 10.1), pero
/// hasta entonces clippeamos defensivamente para no entregar samples fuera de
/// rango.
fn emit_encoder_pcm_chunk(state: &mut EngineState) {
    use base64::Engine;
    // FASE D · sub-paso 11.3: elegir entre los dos consumers (Pre-FX o Post-FX)
    // según el atómico encoder_tap_mode (0=preFx, 1=postFx). Drenamos el ring
    // NO seleccionado para que no acumule memoria si el modo permanece fijo.
    let mode = state.dsp_params.encoder_tap_mode.load(Ordering::Relaxed);
    let (active_consumer, idle_consumer) = if mode == 0 {
        (state.encoder_tap_pre_consumer.as_mut(), state.encoder_tap_post_consumer.as_mut())
    } else {
        (state.encoder_tap_post_consumer.as_mut(), state.encoder_tap_pre_consumer.as_mut())
    };
    // Drenar el ring inactivo (puede ser None si todavía no se enrutó master).
    if let Some(idle) = idle_consumer {
        while idle.pop().is_ok() {}
    }
    let consumer = match active_consumer {
        Some(c) => c,
        None => return,
    };
    let available = consumer.slots();
    if available == 0 {
        return;
    }
    // Cap por chunk: ~200 ms @ 44.1 kHz stereo = 17640 samples.
    const MAX_SAMPLES_PER_CHUNK: usize = 17_640;
    let to_read = available.min(MAX_SAMPLES_PER_CHUNK);
    let mut pcm_bytes: Vec<u8> = Vec::with_capacity(to_read * 2);
    let mut read = 0;
    while read < to_read {
        match consumer.pop() {
            Ok(f) => {
                let clipped = f.clamp(-1.0, 1.0);
                let i = (clipped * 32767.0) as i16;
                pcm_bytes.extend_from_slice(&i.to_le_bytes());
                read += 1;
            }
            Err(_) => break,
        }
    }
    if read == 0 {
        return;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm_bytes);
    let tap_label = if mode == 0 { "preFx" } else { "postFx" };
    println!(
        "{{\"type\":\"pcmChunk\",\"engine\":\"rustAudio\",\"tap\":\"{}\",\"sampleRate\":44100,\"channels\":2,\"samples\":{},\"pcm\":\"{}\"}}",
        tap_label, read, b64
    );
    let _ = io::stdout().flush();
}

fn device_id(device: &Device, fallback_index: usize) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| format!("output:{}", fallback_index))
}

fn device_name(device: &Device, fallback_index: usize) -> String {
    device
        .description()
        .map(|description| description.to_string())
        .unwrap_or_else(|_| format!("Salida {}", fallback_index + 1))
}

fn collect_output_devices() -> Result<(String, String, String, String, Vec<String>), String> {
    let host = cpal::default_host();
    let host_name = host.id().name().to_string();
    let available_hosts = cpal::available_hosts()
        .iter()
        .map(|host_id| host_id.name().to_string())
        .collect::<Vec<String>>()
        .join(",");
    let default_device = host.default_output_device();
    let default_id = default_device
        .as_ref()
        .map(|device| device_id(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let default_name = default_device
        .as_ref()
        .map(|device| device_name(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let devices = host
        .output_devices()
        .map_err(|err| format!("No se pudieron listar salidas de audio: {}", err))?;
    let mut outputs = Vec::new();
    for (index, device) in devices.enumerate() {
        let id = device_id(&device, index);
        let name = device_name(&device, index);
        let index_id = format!("output:{}", index);
        let is_default = id == default_id;
        outputs.push(format!(
            "{{\"id\":\"{}\",\"indexId\":\"{}\",\"name\":\"{}\",\"isDefault\":{}}}",
            escape_json(&id),
            escape_json(&index_id),
            escape_json(&name),
            is_default
        ));
    }
    Ok((host_name, available_hosts, default_id, default_name, outputs))
}

fn emit_devices(request_id: &str) {
    match collect_output_devices() {
        Ok((host_name, available_hosts, default_output_id, default_output, outputs)) => {
            println!(
                "{{{}\"type\":\"devices\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"updatedAt\":{},\"host\":\"{}\",\"availableHosts\":\"{}\",\"defaultOutput\":\"{}\",\"defaultOutputId\":\"{}\",\"outputs\":[{}]}}",
                request_id_field(request_id),
                now_ms(),
                escape_json(&host_name),
                escape_json(&available_hosts),
                escape_json(&default_output),
                escape_json(&default_output_id),
                outputs.join(",")
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, request_id),
    }
}

fn find_output_device(requested_id: &str) -> Result<(Device, String, String), String> {
    let host = cpal::default_host();
    let requested = requested_id.trim();
    if requested.is_empty() || requested == "default" {
        let device = host.default_output_device().ok_or_else(|| "No hay salida de audio default.".to_string())?;
        let id = device_id(&device, 0);
        let name = device_name(&device, 0);
        return Ok((device, id, name));
    }

    let requested_index = requested
        .strip_prefix("output:")
        .and_then(|value| value.parse::<usize>().ok());
    let devices = host
        .output_devices()
        .map_err(|err| format!("No se pudieron leer salidas de audio: {}", err))?;
    for (index, device) in devices.enumerate() {
        let id = device_id(&device, index);
        let name = device_name(&device, index);
        if requested_index == Some(index) || requested == id || requested == name {
            return Ok((device, id, name));
        }
    }
    Err(format!("Salida Rust no encontrada: {}", requested))
}

fn ensure_output(state: &mut EngineState, requested_id: &str) -> Result<(String, String), String> {
    let requested = if requested_id.trim().is_empty() { "default" } else { requested_id.trim() };
    let (device, id, name) = find_output_device(requested)?;
    if state.outputs.contains_key(&id) {
        return Ok((id, name));
    }

    let mut output = DeviceSinkBuilder::from_device(device)
        .map_err(|err| format!("No se pudo preparar salida {}: {}", name, err))?
        .open_sink_or_fallback()
        .map_err(|err| format!("No se pudo abrir salida {}: {}", name, err))?;
    output.log_on_drop(false);
    state.outputs.insert(id.clone(), OutputRuntime { name: name.clone(), sink: output });
    Ok((id, name))
}

fn load_audio_player(state: &mut EngineState, player_id: &str, file_path: &str, gain: f32, paused: bool, output_id: &str, bus_id: &str, cache_dir: &str) -> Result<(), String> {
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state.routes.get("master")
            .map(|r| r.output_device_id.clone())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| resolved_output_id.clone());
        ensure_program_mixer(state, &master_output_id)?;
    }
    // FASE D · sub-paso 7.4: decidir destino del player ANTES de pedir el
    // output (evita conflicto de borrows). `Mixer` es Clone barato (Arc
    // interno). Si el bus es de programa y el sub-mixer ya existe, el player
    // se conecta al sub-mixer en vez del sink físico. CUE y resto siguen
    // yendo directo al sink (regla de oro: CUE intocable).
    let use_program_mixer = is_program_bus(bus_id) && state.program_mixer_input.is_some();
    let program_mixer_clone = if use_program_mixer {
        state.program_mixer_input.as_ref().map(|m| m.clone())
    } else {
        None
    };
    let file = File::open(file_path).map_err(|err| format!("No se pudo abrir archivo: {}", err))?;
    let decoder = Decoder::try_from(file).map_err(|err| format!("No se pudo decodificar audio: {}", err))?;
    // Duración: para pistas normales (cache_dir vacío) usamos el decoder ya
    // abierto con `total_duration()` — barato, y su duración real vive en el
    // SQLite del frontend. Para LOCUCIONES (cache_dir presente: clima/hora
    // manual) usamos el caché en disco, que escanea una sola vez los VBR sin
    // header y persiste el resultado (archivos que suenan cientos de veces/día).
    let duration_ms = if cache_dir.trim().is_empty() {
        decoder.total_duration().map(|d| d.as_millis() as u64).unwrap_or(0)
    } else {
        cached_audio_duration_ms(file_path, cache_dir)
    };
    let player = match program_mixer_clone.as_ref() {
        Some(mixer) => Player::connect_new(mixer),
        None => {
            let output = state.outputs.get(&resolved_output_id).ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    // FASE D · sub-paso 7.5: solo aplicamos el gain individual del player.
    // El master_gain ya NO se compone aquí — vive en el FaderSource entre el
    // program_mixer y el sink físico PGM.
    let _ = bus_id; // (silencia warning: bus_id sigue usándose arriba)
    player.set_volume(gain.clamp(0.0, 2.0));
    if paused {
        player.pause();
    }

    let runtime = state.players.entry(player_id.to_string()).or_default();
    if let Some(old_player) = runtime.player.take() {
        old_player.stop();
    }
    runtime.meter = Arc::new(PlayerMeter::default());
    let metered_source = MeteredSource::new(decoder, Arc::clone(&runtime.meter));
    player.append(metered_source);
    runtime.state.path = file_path.to_string();
    runtime.state.status = if paused { "loaded".to_string() } else { "playing".to_string() };
    runtime.state.position_ms = 0;
    runtime.state.duration_ms = duration_ms;
    runtime.state.gain = gain.clamp(0.0, 2.0);
    runtime.state.fade_active = false;
    runtime.state.fade_start_gain = runtime.state.gain;
    runtime.state.fade_target_gain = runtime.state.gain;
    runtime.state.fade_started_at_ms = 0;
    runtime.state.fade_duration_ms = 0;
    runtime.state.fade_stop_after = false;
    runtime.state.bus_id = bus_id.to_string();
    runtime.state.output_device_id = resolved_output_id;
    runtime.state.output_device_name = resolved_output_name;
    runtime.player = Some(player);
    Ok(())
}

/// Como `load_audio_player` pero encadena VARIOS archivos en UN solo player con
/// `append` (rodio los reproduce gapless, sin micro-pausa entre ellos). Pensado
/// para el cartwall (locución de hora HORAS+MINUTOS). A diferencia de
/// `start_time_locution`, NO usa la maquinaria global `time_locution_*` (que es
/// de instancia única), por lo que cartwall y playlist pueden sonar a la vez sin
/// pisarse. El fin se detecta por la vía normal: `emit_status` marca 'ended'
/// cuando `player.empty()` tras el último archivo. Se duplica a propósito parte
/// del setup de `load_audio_player` para dejar ese camino crítico (música) intacto.
fn load_audio_player_sequence(state: &mut EngineState, player_id: &str, file_paths: &[String], gain: f32, output_id: &str, bus_id: &str, cache_dir: &str) -> Result<(), String> {
    if file_paths.is_empty() {
        return Err("Secuencia de audio vacia.".to_string());
    }
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state.routes.get("master")
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
            let output = state.outputs.get(&resolved_output_id).ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    player.set_volume(gain.clamp(0.0, 2.0));

    let meter = Arc::new(PlayerMeter::default());
    // Duración total (cacheada) ANTES de encolar.
    let mut total_ms: u64 = 0;
    for path in file_paths {
        total_ms = total_ms.saturating_add(cached_audio_duration_ms(path, cache_dir));
    }
    // Encolar todos los archivos en el mismo player → reproducción gapless.
    for path in file_paths {
        let file = File::open(path).map_err(|e| format!("No se pudo abrir {}: {}", path, e))?;
        let decoder = Decoder::try_from(file).map_err(|e| format!("No se pudo decodificar {}: {}", path, e))?;
        let metered = MeteredSource::new(decoder, Arc::clone(&meter));
        player.append(metered);
    }

    let runtime = state.players.entry(player_id.to_string()).or_default();
    if let Some(old_player) = runtime.player.take() {
        old_player.stop();
    }
    runtime.meter = Arc::clone(&meter);
    runtime.state.path = file_paths.join("|");
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
    runtime.state.output_device_name = resolved_output_name;
    runtime.player = Some(player);
    Ok(())
}

fn release_runtime_player(runtime: &mut RuntimePlayer) {
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

fn play_existing_or_rebuild_player(state: &mut EngineState, player_id: &str) -> Result<(), String> {
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

fn process_repeat_players(state: &mut EngineState) {
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
        let start_ms = runtime.state.repeat_start_ms.min(duration_ms.saturating_sub(1));
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
        match load_audio_player(state, &spec.player_id, &spec.path, spec.gain, true, &output_id, &spec.bus_id, "") {
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

fn process_player_fades(state: &mut EngineState) {
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

fn route_bus(state: &mut EngineState, bus_id: &str, output_id: &str) -> Result<(), String> {
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;

    // FASE 3 (cambio de tarjeta determinista): detectar si el bus YA estaba
    // enrutado a un output distinto. Si cambió, hay que reconstruir el grafo
    // del sub-mixer (para master) o de la cadena monitor (para monitor) y
    // cerrar el output viejo si nadie más lo usa.
    let old_output_id = state.routes.get(bus_id)
        .map(|r| r.output_device_id.clone())
        .unwrap_or_default();
    let output_changed = !old_output_id.is_empty() && old_output_id != resolved_output_id;

    state.routes.insert(bus_id.to_string(), RouteState {
        output_device_id: resolved_output_id.clone(),
        output_device_name: resolved_output_name,
    });

    // FASE D · sub-paso 7.3 + FASE 3: master cambió de tarjeta → reconstruir
    // sub-mixer entero apuntando al nuevo sink. Los players activos pierden
    // audio (igual que en una consola física al cambiar la salida del bus
    // PGM). El próximo `loadAudio` se reconectará al nuevo program_mixer.
    if bus_id == "master" {
        if output_changed && state.program_mixer_input.is_some() {
            reset_program_mixer(state);
        }
        if let Err(err) = ensure_program_mixer(state, &resolved_output_id) {
            eprintln!("[FASE D] No se pudo inicializar program_mixer: {}", err);
        } else {
            // Auto-reanudar pistas que estaban sonando antes del reset
            resume_pending_players(state);
        }
    }
    if bus_id == "monitor" {
        // FASE 3: si el monitor ya estaba cableado a otro sink, desarmar la
        // cadena vieja antes de armar la nueva.
        if output_changed && !state.monitor_sink_id.is_empty() {
            reset_monitor_chain(state);
            // reset_monitor_chain destruye el program_mixer (sus tap-consumers
            // quedan liberados). Hay que reconstruirlo en la misma tarjeta
            // master para que ensure_monitor_chain encuentre los consumers
            // disponibles y los players puedan reanudarse.
            let master_output_id = state.routes.get("master")
                .map(|r| r.output_device_id.clone())
                .unwrap_or_else(|| "default".to_string());
            if let Err(err) = ensure_program_mixer(state, &master_output_id) {
                eprintln!("[FASE D] No se pudo reconstruir program_mixer tras reset monitor: {}", err);
            }
        }
        if let Err(err) = ensure_monitor_chain(state, &resolved_output_id) {
            eprintln!("[FASE D] No se pudo inicializar monitor_chain: {}", err);
        } else if !state.pending_resume.is_empty() {
            // Si reset_monitor_chain destruyó players activos, reanudarlos
            resume_pending_players(state);
        }
    }

    // FASE 3: cerrar sinks físicos que ya no están enrutados a ningún bus.
    if output_changed {
        cleanup_unused_outputs(state);
    }
    Ok(())
}

/// FASE 3 — Limpia el sub-mixer de programa entero (master) y todas sus
/// dependencias (taps, consumers, monitor). Se llama cuando el operador
/// cambia el output del bus master. Los players activos pierden audio en
/// el sink físico viejo y deberán reconectarse en el próximo `loadAudio`.
fn reset_program_mixer(state: &mut EngineState) {
    // Guardar estado de los players activos del bus de programa para
    // reanudarlos automáticamente en `resume_pending_players` después de
    // que `ensure_program_mixer` construya el nuevo sub-mixer en la nueva
    // tarjeta. Solo se guardan los que están sonando o pausados y tienen
    // un archivo cargado en un bus de programa (no CUE/editores).
    state.pending_resume = state.players.iter()
        .filter(|(_, r)| {
            (r.state.status == "playing" || r.state.status == "paused")
                && !r.state.path.is_empty()
                && is_program_bus(&r.state.bus_id)
        })
        .map(|(id, r)| PendingResumeSpec {
            player_id: id.clone(),
            path: r.state.path.clone(),
            // La posición real viene del rodio Player, no del state (que se
            // fija en 0 al cargar y no se actualiza en tiempo real por Rust).
            position_ms: r.player
                .as_ref()
                .map(|p| p.get_pos().as_millis() as u64)
                .unwrap_or(r.state.position_ms),
            gain: r.state.gain,
            bus_id: r.state.bus_id.clone(),
            was_playing: r.state.status == "playing",
        })
        .collect();
    // Detener todos los players (sin removerlos del state — el frontend los
    // recargará al cambiar de pista). El `take()` consume el Player que al
    // hacer drop se desconecta del mixer.
    for (_, runtime) in state.players.iter_mut() {
        if let Some(p) = runtime.player.take() {
            p.stop();
        }
    }
    state.program_mixer_input = None;
    state.program_mixer_sink_id.clear();
    state.monitor_tap_pre_consumer = None;
    state.monitor_tap_post_consumer = None;
    state.encoder_tap_pre_consumer = None;
    state.encoder_tap_post_consumer = None;
    // Si había monitor cableado, también colapsa porque sus consumers se fueron.
    state.monitor_sink_id.clear();
    // Recrear los Arcs de metros para que el MeteredSource viejo (que puede
    // seguir vivo en el sink de rodio hasta que el thread de audio lo drene)
    // escriba en Arcs muertos en lugar de contaminar las lecturas del nuevo
    // MeteredSource que `ensure_program_mixer` creará. Sin este reset, dos
    // MeteredSources escriben al mismo Arc con Ordering::Relaxed → lecturas
    // corruptas en emit_status → vúmetros que se rompen al cambiar tarjeta.
    state.master_bus_meter = Arc::new(PlayerMeter::default());
    state.monitor_bus_meter = Arc::new(PlayerMeter::default());
    // El reloj de la pista virtual de locución horaria queda invalidado: si
    // estaba sonando, su Player se acaba de detener y emit_status no debe
    // seguir reportando posición fantasma.
    if !state.time_locution_player.is_empty() {
        state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
        state.time_locution_player.clear();
        state.time_locution_started_at = None;
        state.time_locution_total_ms = 0;
    }
    state.dsp_params.dsp_ready.store(false, Ordering::Relaxed);
}

/// Reanuda automáticamente los players que estaban activos antes de
/// `reset_program_mixer`. Se llama desde `route_bus("master")` justo después
/// de que `ensure_program_mixer` construye el nuevo sub-mixer. El gap de audio
/// se reduce a los milisegundos que tarda abrir la nueva tarjeta y decodificar.
fn resume_pending_players(state: &mut EngineState) {
    let to_resume = std::mem::take(&mut state.pending_resume);
    let master_output_id = state.routes.get("master")
        .map(|r| r.output_device_id.clone())
        .unwrap_or_else(|| "default".to_string());
    for spec in to_resume {
        let resume_pos = spec.position_ms;
        // Cargar siempre en pausa: evita que el decoder emita muestras desde
        // el inicio (pos 0) durante el instante que tarda en procesar el seek.
        match load_audio_player(state, &spec.player_id, &spec.path, spec.gain, true, &master_output_id, &spec.bus_id, "") {
            Ok(()) => {
                if let Some(runtime) = state.players.get_mut(&spec.player_id) {
                    if let Some(player) = &runtime.player {
                        if resume_pos > 200 {
                            let _ = player.try_seek(Duration::from_millis(resume_pos));
                        }
                        if spec.was_playing {
                            player.play();
                        }
                    }
                    runtime.state.status = if spec.was_playing {
                        "playing".to_string()
                    } else {
                        "loaded".to_string()
                    };
                    runtime.state.position_ms = resume_pos;
                }
            }
            Err(e) => {
                eprintln!("[auto-resume] No se pudo recargar {}: {}", spec.player_id, e);
            }
        }
    }
}

/// FASE 3 — Resetea solo la cadena monitor (no toca el program_mixer ni los
/// players). Se invoca cuando el operador cambia la tarjeta del monitor.
fn reset_monitor_chain(state: &mut EngineState) {
    // Nota: los consumers monitor_tap_pre/post se consumieron al armar la
    // cadena anterior (`ensure_monitor_chain` hizo `.take()`). El sink físico
    // del monitor sigue vivo dentro del MeteredSource interno. Para "soltar"
    // ese sink hay que reconstruir el `program_mixer` (porque los rings vivos
    // siguen escribiendo allá). Simplificación: ante cambio de monitor,
    // también reseteamos el program_mixer entero — el costo es interrumpir
    // el audio del PGM por un instante, pero garantiza que no quede el sink
    // viejo del monitor recibiendo señal en paralelo (la duplicación que
    // reportó el operador).
    state.monitor_sink_id.clear();
    if state.program_mixer_input.is_some() {
        reset_program_mixer(state);
    }
}

/// FASE 3 — Elimina del HashMap de outputs los devices que ya no son
/// referenciados por ningún bus. Drop del `MixerDeviceSink` cierra el stream
/// cpal y libera la tarjeta física.
fn cleanup_unused_outputs(state: &mut EngineState) {
    let mut referenced: std::collections::HashSet<String> = state.routes.values()
        .map(|r| r.output_device_id.clone())
        .collect();
    if !state.program_mixer_sink_id.is_empty() {
        referenced.insert(state.program_mixer_sink_id.clone());
    }
    if !state.monitor_sink_id.is_empty() {
        referenced.insert(state.monitor_sink_id.clone());
    }
    state.outputs.retain(|id, _| referenced.contains(id));
}

/// Crea el sub-mixer del bus de programa la primera vez que se solicita y lo
/// conecta al sink físico del output PGM. Idempotente: en llamadas siguientes
/// retorna sin tocar nada.
///
/// Trampa documentada de rodio 0.22.2 (ver bitácora del sub-paso 7.2): un
/// mixer sin entradas se considera `Empty` y se detacha del consumidor en el
/// primer poll. Para evitarlo agregamos un `Zero` infinito que aporta silencio
/// puro y mantiene vivo al mixer en el sink.
fn ensure_program_mixer(state: &mut EngineState, output_id: &str) -> Result<(), String> {
    if state.program_mixer_input.is_some() {
        return Ok(());
    }
    let stereo: ChannelCount = NonZeroU16::new(2).ok_or("ChannelCount inválido")?;
    let rate: SampleRate = NonZeroU32::new(44100).ok_or("SampleRate inválido")?;
    let (program_input, program_output) = rodio::mixer::mixer(stereo, rate);
    program_input.add(Zero::new(stereo, rate));
    // FASE D · sub-paso 11.3: bifurcación dual de la señal — Pre-FX y Post-FX.
    //
    // Ring MONITOR (4 096 samples / ~46 ms): chico para mantener latencia
    // baja entre monitor y PGM (anti-acumulación drena a ~3 ms). Es lo que
    // hace que el monitor suene "al unísono" con el PGM como en consola
    // física.
    //
    // Ring ENCODER (16 384 samples / ~186 ms): más grande porque se drena
    // sólo cada 20 ms en el PushTick. No queremos perder samples para el
    // aire en internet.
    //
    // 4 rings totales: monitor_pre, monitor_post, encoder_pre, encoder_post.
    // El DualTapConsumerSource del monitor y el handler emit_encoder_pcm_chunk
    // del encoder eligen en caliente entre Pre y Post según los atómicos
    // `monitor_tap_mode` / `encoder_tap_mode` (0=preFx, 1=postFx).
    // Ring monitor subido de 4 096 (~46 ms) a 16 384 (~186 ms). El target de
    // drenado se mantiene en TAP_DRAIN_TARGET_SAMPLES (~23 ms), de modo que el
    // ring NUNCA se va a "lleno" ni a "vacío": flota alrededor del target.
    // El margen extra absorbe el jitter del resampler implícito de rodio
    // cuando el sink físico del monitor opera a un sample-rate distinto
    // (típico Windows: device nativo 48 kHz vs program_mixer 44.1 kHz). Antes,
    // con 4 096, los burst del resampler provocaban underrun → distorsión.
    const MONITOR_RING_CAPACITY: usize = 16_384;
    const ENCODER_RING_CAPACITY: usize = 16_384;
    let (mon_pre_prod, mon_pre_cons) = rtrb::RingBuffer::<Sample>::new(MONITOR_RING_CAPACITY);
    let (mon_post_prod, mon_post_cons) = rtrb::RingBuffer::<Sample>::new(MONITOR_RING_CAPACITY);
    let (enc_pre_prod, enc_pre_cons) = rtrb::RingBuffer::<Sample>::new(ENCODER_RING_CAPACITY);
    let (enc_post_prod, enc_post_cons) = rtrb::RingBuffer::<Sample>::new(ENCODER_RING_CAPACITY);
    state.monitor_tap_pre_consumer = Some(mon_pre_cons);
    state.monitor_tap_post_consumer = Some(mon_post_cons);
    state.encoder_tap_pre_consumer = Some(enc_pre_cons);
    state.encoder_tap_post_consumer = Some(enc_post_cons);

    // Primer MultiTee: PRE-FX. Justo después del program_mixer, antes de DSP.
    let tee_pre = MultiTeeSource::new(program_output, vec![mon_pre_prod, enc_pre_prod]);

    // FASE D · sub-paso 11.4 — Cascada DSP con orden dinámico.
    // Un solo Source (`DynamicDspSource`) absorbe PreAmp+Pan+Mono+EQ+Comp+Limiter
    // como 3 bloques atómicos (EQ-meta, Comp, Limiter) y los aplica por par
    // estéreo en el orden que dicta `dsp_params.fx_order`. El handler IPC
    // `fx` actualiza ese atómico cuando el operador reordena visualmente la
    // pila FX desde el sidebar — sin reconstruir el grafo de audio.
    let dsp = DynamicDspSource::new(tee_pre, Arc::clone(&state.dsp_params));

    // Segundo MultiTee: POST-FX. Después de toda la cadena DSP, antes del
    // master fader. Aquí los taps escuchan exactamente lo mismo que va a
    // salir al sink (sin master_gain todavía).
    let tee_post = MultiTeeSource::new(dsp, vec![mon_post_prod, enc_post_prod]);

    // FASE D · sub-paso 7.5: master fader único entre la cadena DSP y el sink.
    let faded = FaderSource::new(tee_post, Arc::clone(&state.dsp_params), FaderGainField::Master);
    // FASE D · sub-paso 7.6: tap post-fader que mide la suma real saliendo al
    // sink. Reutilizamos `MeteredSource` (mismo adapter que cada player usa
    // individualmente) escribiendo en el `master_bus_meter` del state.
    let metered = MeteredSource::new(faded, Arc::clone(&state.master_bus_meter));
    let output = state.outputs.get(output_id)
        .ok_or_else(|| format!("Sin output {} para program_mixer", output_id))?;
    output.sink.mixer().add(metered);
    state.program_mixer_input = Some(program_input);
    state.program_mixer_sink_id = output_id.to_string();
    state.dsp_params.dsp_ready.store(true, Ordering::Relaxed);
    Ok(())
}

/// FASE D · sub-paso 8.1: arma la cadena del bus monitor (Booth).
///   monitor_tap_consumer → TapConsumerSource → FaderSource Monitor
///   → MeteredSource(monitor_bus_meter) → sink Booth
/// Se llama una sola vez desde `route_bus("monitor", ...)`. Si el program_mixer
/// aún no se creó (no hubo route master previo), retorna error: la cadena
/// monitor depende de su tap.
fn ensure_monitor_chain(state: &mut EngineState, output_id: &str) -> Result<(), String> {
    if !state.monitor_sink_id.is_empty() {
        return Ok(()); // ya cableado
    }
    // FASE D · sub-paso 11.3: requerimos AMBOS consumers (Pre y Post FX).
    // El DualTapConsumerSource elige sample-por-sample según el atómico
    // `monitor_tap_mode` (0=preFx, 1=postFx). Conmutación en caliente.
    let pre_consumer = state.monitor_tap_pre_consumer.take()
        .ok_or_else(|| "Monitor tap Pre-FX no disponible (program_mixer no inicializado)".to_string())?;
    let post_consumer = state.monitor_tap_post_consumer.take()
        .ok_or_else(|| "Monitor tap Post-FX no disponible (program_mixer no inicializado)".to_string())?;
    let stereo: ChannelCount = NonZeroU16::new(2).ok_or("ChannelCount inválido")?;
    let rate: SampleRate = NonZeroU32::new(44100).ok_or("SampleRate inválido")?;
    let dual = DualTapConsumerSource::new(
        pre_consumer,
        post_consumer,
        Arc::clone(&state.dsp_params),
        true, // is_monitor
        stereo,
        rate,
    );
    let faded = FaderSource::new(dual, Arc::clone(&state.dsp_params), FaderGainField::Monitor);
    let metered = MeteredSource::new(faded, Arc::clone(&state.monitor_bus_meter));
    let output = state.outputs.get(output_id)
        .ok_or_else(|| format!("Sin output {} para monitor", output_id))?;
    output.sink.mixer().add(metered);
    state.monitor_sink_id = output_id.to_string();
    Ok(())
}

fn update_now_playing(state: &mut EngineState, line: &str) {
    state.now_playing = Some(NowPlayingState {
        title: json_get_string(line, "title").unwrap_or_default(),
        artist: json_get_string(line, "artist").unwrap_or_default(),
        path: json_get_string(line, "path").unwrap_or_default(),
        player: json_get_string(line, "player").unwrap_or_default(),
        source: json_get_string(line, "source").unwrap_or_else(|| "renderer".to_string()),
        updated_at: now_ms(),
    });
}

fn update_transport(state: &mut EngineState, line: &str) {
    state.transport = Some(TransportState {
        player: json_get_string(line, "player").unwrap_or_default(),
        status: json_get_string(line, "status").unwrap_or_else(|| "unknown".to_string()),
        position_ms: json_get_u64(line, "positionMs").unwrap_or(0),
        duration_ms: json_get_u64(line, "durationMs").unwrap_or(0),
        start_cause: json_get_string(line, "startCause").unwrap_or_default(),
        mix_active: json_get_bool(line, "mixActive").unwrap_or(false),
        mix_phase: json_get_string(line, "mixPhase").unwrap_or_default(),
        mix_direction: json_get_string(line, "mixDirection").unwrap_or_default(),
        mix_reference_player: json_get_string(line, "mixReferencePlayer").unwrap_or_default(),
        updated_at: now_ms(),
    });
}

fn update_playlist_snapshot(state: &mut EngineState, line: &str) {
    let rows_body = json_get_array_body(line, "rows").unwrap_or("");
    let mut rows = split_json_objects(rows_body)
        .into_iter()
        .filter_map(|obj| {
            let row_id = json_get_string(obj, "rowId").unwrap_or_default();
            if row_id.is_empty() {
                return None;
            }
            Some(PlaylistRowState {
                row_id,
                tab: json_get_u64(obj, "tab").unwrap_or(0),
                order: json_get_u64(obj, "order").unwrap_or(0),
                row_type: json_get_string(obj, "type").unwrap_or_else(|| "normal".to_string()),
                path: json_get_string(obj, "path").unwrap_or_default(),
                title: json_get_string(obj, "title").unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| (row.tab, row.order));
    state.playlist_rows = rows;
}

fn update_playlist_mode(state: &mut EngineState, line: &str) {
    state.playlist_mode.repeat_track = json_get_bool(line, "repeatTrack").unwrap_or(false);
    state.playlist_mode.remove_played = json_get_bool(line, "removePlayed").unwrap_or(false);
    state.playlist_mode.loop_playlist = json_get_bool(line, "loopPlaylist").unwrap_or(false);
    state.playlist_mode.repeat_forget_protection_enabled = json_get_bool(line, "repeatForgetProtectionEnabled").unwrap_or(false);
    state.playlist_mode.repeat_forget_protection_max = json_get_u64(line, "repeatForgetProtectionMax").unwrap_or(10).clamp(1, 999);
    state.playlist_mode.repeat_disable_on_manual_next = json_get_bool(line, "repeatDisableOnManualNext").unwrap_or(true);
    state.playlist_mode.remove_played_protection_enabled = json_get_bool(line, "removePlayedProtectionEnabled").unwrap_or(false);
    state.playlist_mode.remove_played_protection_min_remaining = json_get_u64(line, "removePlayedProtectionMinRemaining").unwrap_or(2).clamp(1, 999);
}

fn update_playlist_playback_context(state: &mut EngineState, line: &str) {
    let current_row_id = json_get_string(line, "currentRowId").unwrap_or_default();
    let current_player = json_get_string(line, "currentPlayer").unwrap_or_default();
    if state.playlist_context.current_row_id != current_row_id
        || state.playlist_context.current_player != current_player {
        state.playlist_context.last_finished_key.clear();
    }
    state.playlist_context.current_row_id = current_row_id;
    state.playlist_context.current_player = current_player;
    state.playlist_context.queued_row_id = json_get_string(line, "queuedRowId").unwrap_or_default();
    state.playlist_context.pgm_tab = json_get_u64(line, "pgmTab").unwrap_or(0);
}

fn is_operational_playlist_row(row: &PlaylistRowState) -> bool {
    row.row_type != "note"
}

fn decide_next_playlist_row(state: &EngineState, current_row_id: &str) -> Option<PlaylistRowState> {
    if !state.playlist_context.queued_row_id.is_empty() {
        if let Some(row) = state.playlist_rows.iter().find(|row| row.row_id == state.playlist_context.queued_row_id) {
            return Some(row.clone());
        }
    }
    let current = state.playlist_rows.iter().find(|row| row.row_id == current_row_id)?;
    let mut same_tab = state.playlist_rows
        .iter()
        .filter(|row| row.tab == current.tab)
        .cloned()
        .collect::<Vec<_>>();
    same_tab.sort_by_key(|row| row.order);
    if let Some(row) = same_tab
        .iter()
        .find(|row| row.order > current.order && is_operational_playlist_row(row)) {
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

fn emit_playlist_mode_changed(state: &EngineState, reason: &str) {
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
    state.playlist_rows
        .iter()
        .filter(|row| row.tab == tab && is_operational_playlist_row(row))
        .count() as u64
}

fn emit_remove_played_if_allowed(state: &mut EngineState, current_row_id: &str, current_player: &str) {
    if !state.playlist_mode.remove_played {
        return;
    }
    let current_tab = state.playlist_rows
        .iter()
        .find(|row| row.row_id == current_row_id)
        .map(|row| row.tab)
        .unwrap_or(state.playlist_context.pgm_tab);
    let operational_count = operational_rows_in_tab(state, current_tab);
    let min_remaining = state.playlist_mode.remove_played_protection_min_remaining.max(1);
    let protected = state.playlist_mode.remove_played_protection_enabled
        && operational_count <= min_remaining;
    if protected {
        state.playlist_mode.remove_played = false;
        emit_playlist_mode_changed(state, "remove-protection");
        return;
    }
    emit_playlist_action("removeRow", current_row_id, current_player);
    state.playlist_rows.retain(|row| row.row_id != current_row_id);
    if state.playlist_mode.remove_played_protection_enabled
        && operational_count.saturating_sub(1) <= min_remaining {
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

fn process_playlist_finished(state: &mut EngineState, player_id: &str, force: bool) {
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
        && state.playlist_context.current_player != current_player {
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

fn process_playlist_manual_next(state: &mut EngineState, player_id: &str) {
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

fn update_encoder(state: &mut EngineState, line: &str) {
    let action = json_get_string(line, "action").unwrap_or_else(|| "status".to_string());
    if action == "stop" {
        state.encoder.active = false;
        state.encoder.bitrate_kbps = 0.0;
        state.encoder.speed = 0.0;
        state.encoder.ffmpeg_time.clear();
        state.encoder.max_gap_ms = 0.0;
        state.encoder.gap_warnings = 0;
    } else if action == "start" {
        state.encoder.active = true;
    }
    state.encoder.source_bus = json_get_string(line, "source")
        .or_else(|| json_get_string(line, "sourceBus"))
        .unwrap_or_else(|| state.encoder.source_bus.clone());
    state.encoder.owner = json_get_string(line, "owner").unwrap_or_else(|| state.encoder.owner.clone());
    state.encoder.requested_owner = json_get_string(line, "requestedOwner").unwrap_or_else(|| state.encoder.requested_owner.clone());
    state.encoder.capture_provider = json_get_string(line, "captureProvider").unwrap_or_else(|| state.encoder.capture_provider.clone());
    state.encoder.encoder_provider = json_get_string(line, "encoderProvider").unwrap_or_else(|| state.encoder.encoder_provider.clone());
    state.encoder.rust_pcm_ready = json_get_bool(line, "rustPcmReady").unwrap_or(state.encoder.rust_pcm_ready);
    state.encoder.pcm_bridge_ready = json_get_bool(line, "pcmBridgeReady").unwrap_or(state.encoder.pcm_bridge_ready);
    state.encoder.pcm_bridge_mode = json_get_string(line, "pcmBridgeMode").unwrap_or_else(|| state.encoder.pcm_bridge_mode.clone());
    state.encoder.pcm_bridge_reason = json_get_string(line, "pcmBridgeReason").unwrap_or_else(|| state.encoder.pcm_bridge_reason.clone());
    state.encoder.fallback_reason = json_get_string(line, "fallbackReason").unwrap_or_else(|| state.encoder.fallback_reason.clone());
    state.encoder.capture_format = json_get_string(line, "captureFormat").unwrap_or_else(|| state.encoder.capture_format.clone());
    state.encoder.sample_rate = json_get_u64(line, "sampleRate").unwrap_or(state.encoder.sample_rate);
    state.encoder.transport = json_get_string(line, "transport").unwrap_or_else(|| state.encoder.transport.clone());
    state.encoder.bitrate_kbps = json_get_f32(line, "bitrateKbps").unwrap_or(state.encoder.bitrate_kbps);
    state.encoder.speed = json_get_f32(line, "speed").unwrap_or(state.encoder.speed);
    state.encoder.ffmpeg_time = json_get_string(line, "ffmpegTime").unwrap_or_else(|| state.encoder.ffmpeg_time.clone());
    state.encoder.max_gap_ms = json_get_f32(line, "maxGapMs").unwrap_or(state.encoder.max_gap_ms);
    state.encoder.gap_warnings = json_get_u64(line, "gapWarnings").unwrap_or(state.encoder.gap_warnings);
    state.encoder.updated_at = now_ms();
}

fn resolve_output_for_bus(state: &EngineState, bus_id: &str, fallback_output_id: &str) -> String {
    if let Some(route) = state.routes.get(bus_id) {
        if !route.output_device_id.is_empty() {
            return route.output_device_id.clone();
        }
    }
    if fallback_output_id.trim().is_empty() {
        "default".to_string()
    } else {
        fallback_output_id.to_string()
    }
}

fn default_bus_for_player(player_id: &str) -> &'static str {
    match player_id {
        "player-a" | "player-b" | "player-c" => "master",
        "jingle-player" | "jingle" => "jingle",
        "cue-player" | "preview-player" | "editor-player" => "cue",
        // Editores avanzados — siempre van al bus de pre-escucha (cue),
        // completamente independientes del master, encoder, monitor y efectos.
        "audio-editor"
        | "jingle-editor-a"
        | "jingle-editor-j"
        | "jingle-editor-b"
        | "trans-editor-a"
        | "trans-editor-b" => "cue",
        "cartwall" | "cartwall-player" => "cartwall",
        "pl1" | "playlist-1" => "pl1",
        "pl2" | "playlist-2" => "pl2",
        "pl3" | "playlist-3" => "pl3",
        "pl4" | "playlist-4" => "pl4",
        _ => "",
    }
}

fn is_diagnostic_player(player_id: &str) -> bool {
    matches!(
        player_id,
        "preview-player"
            | "lab"
            | "jingle-player"
            | "jingle"
            | "cartwall-player"
            | "cue-player"
            | "pl1"
            | "pl2"
            | "pl3"
            | "pl4"
            // Editores avanzados — tratados como reproductores de diagnóstico/transitorios
            // (no actualizan el estado de transporte ni el "now playing" de la emisión)
            | "audio-editor"
            | "jingle-editor-a"
            | "jingle-editor-j"
            | "jingle-editor-b"
            | "trans-editor-a"
            | "trans-editor-b"
    ) || player_id.starts_with("route-map-")
}

fn has_active_audio(state: &EngineState) -> bool {
    state.players.values().any(|runtime| {
        runtime.player.is_some()
            && matches!(runtime.state.status.as_str(), "playing" | "paused" | "loaded")
    })
}

fn emit_error(message: &str, request_id: &str) {
    println!(
        "{{{}\"type\":\"error\",\"engine\":\"rustAudio\",\"message\":\"{}\",\"updatedAt\":{}}}",
        request_id_field(request_id),
        escape_json(message),
        now_ms()
    );
    let _ = io::stdout().flush();
}

// ─── Waveform Peaks ──────────────────────────────────────────────────────────

fn fnv_hash(s: &str) -> u64 {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h = h.wrapping_mul(1099511628211);
        h ^= b as u64;
    }
    h
}

fn floats_to_json(v: &[f32]) -> String {
    let mut s = String::with_capacity(v.len() * 9);
    s.push('[');
    for (i, val) in v.iter().enumerate() {
        if i > 0 { s.push(','); }
        s.push_str(&format!("{:.5}", val));
    }
    s.push(']');
    s
}

fn save_peaks_cache(
    cache_path: &str,
    min: &[f32],
    max: &[f32],
    duration_ms: u64,
    sample_rate: u32,
    silence_start: f32,
    silence_end: f32,
) {
    if let Some(parent) = std::path::Path::new(cache_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut f) = std::fs::File::create(cache_path) else { return; };
    let _ = writeln!(f, "v1 {} {} {:.4} {:.4} {}", sample_rate, duration_ms, silence_start, silence_end, min.len());
    let min_str: Vec<String> = min.iter().map(|v| format!("{:.5}", v)).collect();
    let _ = writeln!(f, "{}", min_str.join(" "));
    let max_str: Vec<String> = max.iter().map(|v| format!("{:.5}", v)).collect();
    let _ = writeln!(f, "{}", max_str.join(" "));
}

fn load_peaks_cache(cache_path: &str) -> Option<(Vec<f32>, Vec<f32>, u64, u32, f32, f32)> {
    let content = std::fs::read_to_string(cache_path).ok()?;
    let mut lines = content.lines();
    let header = lines.next()?;
    let parts: Vec<&str> = header.split_whitespace().collect();
    if parts.len() < 6 || parts[0] != "v1" { return None; }
    let sample_rate: u32 = parts[1].parse().ok()?;
    let duration_ms: u64 = parts[2].parse().ok()?;
    let silence_start: f32 = parts[3].parse().ok()?;
    let silence_end: f32 = parts[4].parse().ok()?;
    let bins: usize = parts[5].parse().ok()?;
    let min_line = lines.next()?;
    let max_line = lines.next()?;
    let min: Vec<f32> = min_line.split_whitespace().filter_map(|s| s.parse().ok()).collect();
    let max: Vec<f32> = max_line.split_whitespace().filter_map(|s| s.parse().ok()).collect();
    if min.len() != bins || max.len() != bins { return None; }
    Some((min, max, duration_ms, sample_rate, silence_start, silence_end))
}

/// mtime del archivo en segundos UNIX (0 si no se puede leer). Mismo criterio
/// de invalidación que el caché de peaks: si el archivo cambia, cambia el mtime.
fn file_mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mide la duración REAL de un archivo. `total_duration()` es confiable para
/// WAV/FLAC y MP3 con header Xing/VBRI; para MP3 VBR sin header devuelve None
/// y entonces escaneamos el archivo (decodificar y contar samples interleaved).
fn measure_audio_duration_full(path: &str) -> u64 {
    let Ok(file) = File::open(path) else { return 0; };
    let Ok(decoder) = Decoder::try_from(file) else { return 0; };
    match decoder.total_duration() {
        Some(d) => d.as_millis() as u64,
        None => {
            // sample_rate()/channels() se leen ANTES de count() (que consume).
            let sr = decoder.sample_rate().get() as u64;
            let ch = decoder.channels().get() as u64;
            let samples = decoder.count() as u64;
            if sr > 0 && ch > 0 { (samples / ch) * 1000 / sr } else { 0 }
        }
    }
}

fn save_duration_cache(cache_path: &str, duration_ms: u64) {
    if let Some(parent) = std::path::Path::new(cache_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::File::create(cache_path) {
        let _ = writeln!(f, "v1 {}", duration_ms);
    }
}

fn load_duration_cache(cache_path: &str) -> Option<u64> {
    let content = std::fs::read_to_string(cache_path).ok()?;
    let line = content.lines().next()?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 2 || parts[0] != "v1" { return None; }
    parts[1].parse().ok()
}

/// Duración de un archivo con caché en disco. Pensado para LOCUCIONES (hora,
/// clima): archivos pregrabados, fijos, que suenan cientos de veces al día.
/// El nombre del caché incluye el mtime → auto-invalida si el archivo cambia
/// (mismo patrón que `compute_waveform_peaks`). Si `cache_dir` viene vacío
/// (pistas normales de música: su duración vive en el SQLite del frontend),
/// mide directo sin escanear ni cachear, preservando el comportamiento previo.
fn cached_audio_duration_ms(path: &str, cache_dir: &str) -> u64 {
    let cache_dir_clean = cache_dir.trim_end_matches(['/', '\\']);
    if cache_dir_clean.is_empty() {
        return measure_audio_duration_full(path);
    }
    let cache_path = format!("{}/{:016x}_{}.dur", cache_dir_clean, fnv_hash(path), file_mtime_secs(path));
    if let Some(ms) = load_duration_cache(&cache_path) {
        return ms;
    }
    let measured = measure_audio_duration_full(path);
    if measured > 0 {
        save_duration_cache(&cache_path, measured);
    }
    measured
}

fn compute_waveform_peaks(
    path: &str,
    target_bins: usize,
    cache_dir: &str,
) -> Result<(Vec<f32>, Vec<f32>, u64, u32, f32, f32), String> {
    // Cache path incluye mtime del archivo para auto-invalidar si cambia
    let cache_path = if !cache_dir.is_empty() {
        let hash = fnv_hash(path);
        let mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let cache_dir_clean = cache_dir.trim_end_matches(['/', '\\']);
        // El nombre incluye bins para que distintas resoluciones no colisionen
        Some(format!("{}/{:016x}_{}_b{}.peaks", cache_dir_clean, hash, mtime, target_bins))
    } else {
        None
    };

    if let Some(ref cp) = cache_path {
        if let Some(cached) = load_peaks_cache(cp) {
            return Ok(cached);
        }
    }

    let file = File::open(path).map_err(|e| format!("Error abriendo: {}", e))?;
    let decoder = Decoder::try_from(file).map_err(|e| format!("Error decodificando: {}", e))?;
    // .get() extrae el u32 primitivo de NonZero<u32> (tipo de retorno en rodio 0.22)
    let sample_rate: u32 = decoder.sample_rate().get();
    let channels = decoder.channels().get() as usize;

    // Lectura en streaming por chunks (bajo uso de RAM)
    const CHUNK_FRAMES: usize = 1024;
    let mut chunk_mins: Vec<f32> = Vec::with_capacity(8192);
    let mut chunk_maxs: Vec<f32> = Vec::with_capacity(8192);
    let mut cur_min = 1.0f32;
    let mut cur_max = -1.0f32;
    let mut frames_in_chunk = 0usize;
    let mut total_frames = 0u64;
    let mut sample_idx = 0usize;

    for sample in decoder {
        if sample_idx % channels.max(1) == 0 {
            if sample < cur_min { cur_min = sample; }
            if sample > cur_max { cur_max = sample; }
            frames_in_chunk += 1;
            total_frames += 1;
            if frames_in_chunk >= CHUNK_FRAMES {
                chunk_mins.push(cur_min);
                chunk_maxs.push(cur_max);
                cur_min = 1.0;
                cur_max = -1.0;
                frames_in_chunk = 0;
            }
        }
        sample_idx += 1;
    }
    if frames_in_chunk > 0 {
        chunk_mins.push(cur_min);
        chunk_maxs.push(cur_max);
    }

    let duration_ms = if sample_rate > 0 { (total_frames * 1000) / sample_rate as u64 } else { 0 };
    let total_chunks = chunk_mins.len();

    // Reducir chunks a target_bins
    let actual_bins = target_bins.min(total_chunks).max(1);
    let mut min_peaks = vec![1.0f32; actual_bins];
    let mut max_peaks = vec![-1.0f32; actual_bins];
    for bin in 0..actual_bins {
        let start_c = (bin * total_chunks) / actual_bins;
        let end_c = (((bin + 1) * total_chunks) / actual_bins).min(total_chunks).max(start_c + 1);
        for c in start_c..end_c {
            if c < total_chunks {
                if chunk_mins[c] < min_peaks[bin] { min_peaks[bin] = chunk_mins[c]; }
                if chunk_maxs[c] > max_peaks[bin] { max_peaks[bin] = chunk_maxs[c]; }
            }
        }
    }

    // Detección de silencios (inicio y fin del audio real)
    let thresh_start = 10.0f32.powf(-38.0 / 20.0);
    let thresh_end   = 10.0f32.powf(-30.0 / 20.0);
    let guard_chunks = ((sample_rate as usize * 50) / 1000 / CHUNK_FRAMES).max(1);

    let mut silence_start_frames = 0u64;
    for (i, (&mn, &mx)) in chunk_mins.iter().zip(chunk_maxs.iter()).enumerate() {
        if mx.max(-mn) > thresh_start {
            let guard = (i as i64 - guard_chunks as i64).max(0) as u64;
            silence_start_frames = guard * CHUNK_FRAMES as u64;
            break;
        }
    }
    let mut silence_end_frames = total_frames;
    for (i, (&mn, &mx)) in chunk_mins.iter().zip(chunk_maxs.iter()).enumerate().rev() {
        if mx.max(-mn) > thresh_end {
            silence_end_frames = ((i as u64 + 1 + guard_chunks as u64) * CHUNK_FRAMES as u64).min(total_frames);
            break;
        }
    }
    let silence_start_s = if sample_rate > 0 { silence_start_frames as f32 / sample_rate as f32 } else { 0.0 };
    let silence_end_s   = if sample_rate > 0 { silence_end_frames   as f32 / sample_rate as f32 } else { 0.0 };

    if let Some(ref cp) = cache_path {
        save_peaks_cache(cp, &min_peaks, &max_peaks, duration_ms, sample_rate, silence_start_s, silence_end_s);
    }

    Ok((min_peaks, max_peaks, duration_ms, sample_rate, silence_start_s, silence_end_s))
}

// ─── Locución horaria ────────────────────────────────────────────────────────
//
// Toda la lógica del say-time vive aquí: el motor lee la hora local, resuelve
// los archivos correspondientes en la carpeta provista, los encola en un único
// `Player` (rodio reproduce los `append` consecutivamente sin gap) y emite un
// evento `timeLocutionEnded` cuando termina. El renderer queda como simple
// control remoto: envía el comando, escucha el evento, avanza la playlist.

/// Hora local actual (hora 0–23, minuto 0–59).
/// Cross-platform: en Windows libc expone solo `localtime_s` (Microsoft, escribe
/// en *mut tm pasado por el caller); en Unix usamos `localtime_r` (POSIX), que
/// también escribe en buffer del caller y es thread-safe.
#[cfg(windows)]
fn local_hour_minute() -> (u32, u32) {
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
fn local_hour_minute() -> (u32, u32) {
    unsafe {
        let now: libc::time_t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return (0, 0);
        }
        (tm.tm_hour.max(0) as u32, tm.tm_min.max(0) as u32)
    }
}

/// Resuelve los archivos de la locución de hora siguiendo la convención del
/// proyecto (misma que usaba `resolveTimeLocutionFiles` en JS):
///   - Minuto exacto (mm == "00"): un solo archivo `HRSHH_O*` (versión "en punto").
///   - Resto: dos archivos — `HRSHH*` (sin `_O`) + `MINMM*`.
/// Devuelve rutas absolutas. Vacío si la carpeta no existe o falta material.
fn resolve_time_locution_files(folder: &str) -> Vec<String> {
    let (h, m) = local_hour_minute();
    let hh = format!("{:02}", h);
    let mm = format!("{:02}", m);
    let folder_path = std::path::Path::new(folder);
    if !folder_path.is_dir() { return Vec::new(); }
    let entries: Vec<(String, std::path::PathBuf)> = match std::fs::read_dir(folder_path) {
        Ok(rd) => rd.flatten()
            .filter_map(|e| e.file_name().into_string().ok().map(|n| (n, e.path())))
            .collect(),
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if mm == "00" {
        let prefix = format!("HRS{}_O", hh);
        if let Some((_, p)) = entries.iter().find(|(n, _)| n.to_uppercase().starts_with(&prefix)) {
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
        if let Some((_, p)) = entries.iter().find(|(n, _)| n.to_uppercase().starts_with(&prefix_m)) {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out
}

/// Emite el fin de locución usando el estado real del `Player`. No depende de
/// la duración reportada por metadata, porque algunos audios VBR/recortados
/// pueden subestimar justo el segundo segmento (MINxx) y provocar avance antes
/// de que termine de sonar.
fn finish_time_locution_if_drained(state: &mut EngineState) {
    let player_id = state.time_locution_player.clone();
    if player_id.is_empty() {
        return;
    }
    let drained = state.players
        .get(&player_id)
        .and_then(|runtime| runtime.player.as_ref())
        .map(|player| player.empty())
        .unwrap_or(false);
    if !drained {
        return;
    }

    let duration_ms = state.time_locution_total_ms;
    let segments = state.players
        .get(&player_id)
        .map(|runtime| runtime.state.path.split('|').filter(|part| !part.trim().is_empty()).count())
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

/// Lanza la locución horaria: crea un único `Player` en el bus indicado y
/// encadena todos los archivos con `Player::append` (rodio los reproduce
/// secuencialmente sin gap, garantizando orden estricto). Devuelve duración
/// total estimada en ms y la lista de archivos efectivamente encolados.
/// El evento `timeLocutionEnded` se emite desde el tick principal cuando el
/// `Player` realmente queda vacío.
fn start_time_locution(
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
        return Err("No se encontraron archivos de locucion de hora para la hora actual.".to_string());
    }
    // Resolver el output respetando el routing del bus (mismo patrón que loadAudio).
    // Cuando el renderer pasa bus="pl1"/"pl2" para una locución de playlist, la
    // salida debe ser la del routing de ese bus, no la del default.
    let routed_output_id = resolve_output_for_bus(state, bus_id, output_id);
    let (resolved_output_id, _) = ensure_output(state, &routed_output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state.routes.get("master")
            .map(|r| r.output_device_id.clone())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| resolved_output_id.clone());
        ensure_program_mixer(state, &master_output_id)?;
    }

    // FASE D · sub-paso 7.5: si la locución va a un bus de programa y el
    // sub-mixer está vivo, conectamos al sub-mixer (mismo path que las
    // pistas normales). Si no, fallback al sink físico directo. CUE no
    // aplica acá (la locución horaria nunca va a CUE).
    let use_program_mixer = is_program_bus(bus_id) && state.program_mixer_input.is_some();
    let program_mixer_clone = if use_program_mixer {
        state.program_mixer_input.as_ref().map(|m| m.clone())
    } else {
        None
    };
    let player = match program_mixer_clone.as_ref() {
        Some(mixer) => Player::connect_new(mixer),
        None => {
            let output = state.outputs.get(&resolved_output_id)
                .ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    // Solo aplicamos el gain individual; el master vive en FaderSource único.
    player.set_volume(gain.clamp(0.0, 2.0));

    let meter = Arc::new(PlayerMeter::default());

    // ── Fase 1: medir la duración TOTAL real de la pista virtual (HRS+MIN)
    // ANTES de encolar nada, vía caché en disco. La primera vez escanea los
    // VBR sin header (que antes subestimaban total_ms → el frontend adelantaba
    // el avance cortando MINxx, o esperaba el `timeLocutionEnded` real → bache);
    // las siguientes lee del caché. Si cache_dir viene vacío mide sin cachear.
    let mut total_ms: u64 = 0;
    for path in &files {
        total_ms = total_ms.saturating_add(cached_audio_duration_ms(path, cache_dir));
    }
    if total_ms == 0 {
        return Err("La locucion de hora dura 0 ms (decoders sin metadata de duracion).".to_string());
    }

    // ── Fase 2: encolar los archivos en el Player. rodio empieza a reproducir
    // en cuanto se hace el primer `append`, por eso esto va DESPUÉS de medir:
    // así `time_locution_started_at` (más abajo) coincide con el inicio real
    // del audio y el reloj acumulativo no arranca desfasado.
    for path in &files {
        let file = File::open(path)
            .map_err(|e| format!("No se pudo abrir {}: {}", path, e))?;
        let decoder = Decoder::try_from(file)
            .map_err(|e| format!("No se pudo decodificar {}: {}", path, e))?;
        let metered = MeteredSource::new(decoder, Arc::clone(&meter));
        player.append(metered);
    }

    // Reemplazar player previo (si quedaba uno colgado de una locución anterior).
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

    // Generación: cualquier stop sobre este player o nueva locución invalida
    // cierres tardíos de una reproducción anterior.
    state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
    state.time_locution_player = player_id.to_string();
    // Reloj acumulativo de la pista virtual unificada (HRS + MIN).
    // El frontend recibe `positionMs = now - started_at` saturado a
    // `time_locution_total_ms`. Esto evita el "rebote" a cero al cambiar
    // del primer archivo al segundo dentro del mismo Player.
    state.time_locution_started_at = Some(Instant::now());
    state.time_locution_total_ms = total_ms;

    Ok((total_ms, files))
}

/// Eventos que recibe el loop principal del motor. Reemplaza al `for line in
/// stdin` original por un selector basado en `mpsc::channel` que intercala
/// comandos entrantes con ticks periódicos del timer push (filosofía
/// "humilde control remoto": Rust EMITE estado sin esperar pedido).
enum EngineEvent {
    StdinLine(String),
    StdinError,
    StdinClosed,
    PushTick,
}

/// Intervalo del bucle push de telemetría. 20 ms = 50 Hz. Suficiente para
/// VU meters ultra fluidos a 50 FPS y posición de cabezal precisa, sin lag.
const PUSH_TICK_MS: u64 = 20;

fn main() {
    let mut state = EngineState::default();
    println!(
        "{{\"type\":\"ready\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"updatedAt\":{}}}",
        now_ms()
    );
    let _ = io::stdout().flush();

    let (tx, rx) = mpsc::channel::<EngineEvent>();

    // Hilo lector de stdin: bloquea en `lines()` y reenvía cada línea al
    // canal. Cuando stdin se cierra (parent process termina) emite StdinClosed
    // y muere limpio.
    let tx_stdin = tx.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx_stdin.send(EngineEvent::StdinLine(l)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx_stdin.send(EngineEvent::StdinError);
                }
            }
        }
        let _ = tx_stdin.send(EngineEvent::StdinClosed);
    });

    // Hilo timer push: cada PUSH_TICK_MS dispara un PushTick que el loop
    // principal traduce en `emit_status(state, "")`. Sin pedido, sin
    // requestId — el frontend se suscribe vía `audio-engine-rust-event`.
    let tx_tick = tx.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(PUSH_TICK_MS));
        if tx_tick.send(EngineEvent::PushTick).is_err() {
            break;
        }
    });

    'main_loop: loop {
        let event = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => break,
        };

        let line = match event {
            EngineEvent::StdinLine(l) => l,
            EngineEvent::PushTick => {
                process_player_fades(&mut state);
                process_repeat_players(&mut state);
                finish_time_locution_if_drained(&mut state);
                // Push automático de status. request_id vacío → el campo no se
                // emite y el Node probe lo trata como mensaje espontáneo.
                emit_status(&state, "");
                // FASE D · sub-paso 8.2: si el encoder está activo, drenar
                // los samples acumulados en el tap y emitir un chunk PCM
                // base64 por stdout. El probe Node lo recibe en handleLine
                // (type === "pcmChunk") y lo pipea al stdin de FFmpeg.
                if state.dsp_params.encoder_tap_active.load(Ordering::Relaxed) {
                    emit_encoder_pcm_chunk(&mut state);
                }
                continue 'main_loop;
            }
            EngineEvent::StdinError => {
                emit_error("No se pudo leer comando.", "");
                continue 'main_loop;
            }
            EngineEvent::StdinClosed => break 'main_loop,
        };

        let cmd = json_get_string(&line, "cmd").unwrap_or_default();
        let request_id = json_get_string(&line, "requestId").unwrap_or_default();
        let player_id = json_get_string(&line, "player").unwrap_or_else(|| "probe".to_string());

        match cmd.as_str() {
            "status" => {}
            "devices" => emit_devices(&request_id),
            "load" => {
                let runtime = state.players.entry(player_id.clone()).or_default();
                runtime.state.path = json_get_string(&line, "path").unwrap_or_default();
                runtime.state.status = "loaded".to_string();
                runtime.state.position_ms = 0;
            }
            "route" => {
                let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| player_id.clone());
                let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
                // Para el bus encoder almacenamos el modo de fuente (pre/post FX)
                // pero NO abrimos stream cpal (el encoder vive en el lado JS).
                if bus_id == "encoder" {
                    // FIX BUG ENCODER PRE-FX: defensiva contra `sourceMode: ""`.
                    // El adapter JS envía `sourceMode || ''` cuando el campo no
                    // está presente. Antes interpretábamos string vacío como
                    // "postFx" (porque `"" == "preFx"` es false) y SIEMPRE
                    // bajábamos a postFx en cada route reemitido — eso
                    // sobreescribía el valor recién seleccionado por el operador.
                    // Ahora si llega vacío o desconocido, mantenemos el valor
                    // actual de `state.encoder_source_mode`.
                    let source_mode_raw = json_get_string(&line, "sourceMode")
                        .unwrap_or_default();
                    let source_mode = match source_mode_raw.as_str() {
                        "preFx" => "preFx".to_string(),
                        "postFx" => "postFx".to_string(),
                        _ => state.encoder_source_mode.clone(),
                    };
                    let is_pre = source_mode == "preFx";
                    state.encoder_source_mode = source_mode;
                    // FASE D · sub-paso 11.3: propagar al atómico que lee
                    // emit_encoder_pcm_chunk para elegir cuál ring drenar.
                    state.dsp_params.encoder_tap_mode
                        .store(if is_pre { 0 } else { 1 }, Ordering::Relaxed);
                    // Registramos la ruta virtual (sin abrir output cpal).
                    state.routes.insert(
                        "encoder".to_string(),
                        RouteState {
                            output_device_id: output_id.clone(),
                            output_device_name: "encoder (virtual)".to_string(),
                        },
                    );
                } else if bus_id == "monitor" {
                    // FASE D · sub-paso 11.3: el bus monitor también acepta
                    // sourceMode preFx|postFx para alternar su tap.
                    if let Some(source_mode) = json_get_string(&line, "sourceMode") {
                        let is_pre = source_mode == "preFx";
                        state.dsp_params.monitor_tap_mode
                            .store(if is_pre { 0 } else { 1 }, Ordering::Relaxed);
                    }
                    if let Err(err) = route_bus(&mut state, &bus_id, &output_id) {
                        emit_error(&err, &request_id);
                    }
                } else if let Err(err) = route_bus(&mut state, &bus_id, &output_id) {
                    emit_error(&err, &request_id);
                }
            }
            // ── Fader master: punto único de aplicación (FaderSource) ──────
            // FASE D · sub-paso 7.5: el valor viaja al atómico de DspParams
            // y el FaderSource entre el program_mixer y el sink PGM lo lee
            // sample-by-sample con Ordering::Relaxed. Sin locks, sin per-player.
            "masterGain" => {
                let gain = json_get_f32(&line, "gain")
                    .unwrap_or(state.master_gain)
                    .clamp(0.0, 2.0);
                state.master_gain = gain; // cache legacy para `status`
                state.dsp_params.master_gain_bits.store(gain.to_bits(), Ordering::Relaxed);
            }
            // ── Fader monitor: atómico DspParams, listo para el MonitorChain ──
            // del sub-paso 8.1. Hoy se almacena en el atómico (todavía sin
            // sink monitor dedicado) y en el campo legacy.
            "monitorGain" => {
                let gain = json_get_f32(&line, "gain")
                    .unwrap_or(state.monitor_gain)
                    .clamp(0.0, 2.0);
                state.monitor_gain = gain;
                state.dsp_params.monitor_gain_bits.store(gain.to_bits(), Ordering::Relaxed);
            }
            // ── FASE D · sub-paso 8.2: activar/desactivar el tap del encoder.
            // Cuando `enable=true`, cada PushTick (cada 20 ms) drena el ring
            // del encoder_tap y emite un mensaje `pcmChunk` por stdout. El
            // probe Node lo recibe y lo pipea al stdin de FFmpeg.
            "encoderTap" => {
                let enable = json_get_bool(&line, "enable").unwrap_or(false);
                state.dsp_params.encoder_tap_active.store(enable, Ordering::Relaxed);
                // Drenamos AMBOS rings (Pre y Post FX) al desactivar para que
                // la próxima activación arranque limpia.
                if !enable {
                    if let Some(c) = state.encoder_tap_pre_consumer.as_mut() {
                        while c.pop().is_ok() {}
                    }
                    if let Some(c) = state.encoder_tap_post_consumer.as_mut() {
                        while c.pop().is_ok() {}
                    }
                }
            }
            // ── Bus FX: parámetros DSP del bus de programa ──────────────────
            // FASE D · sub-pasos 9.1-11.2 + 11.1-bis: además de los campos
            // legacy (compatibilidad con `status`), propagamos cada valor al
            // atómico correspondiente de DspParams. Los Source adapters leen
            // sample-por-sample con Ordering::Relaxed (sin locks).
            //
            // Reglas de negocio aplicadas:
            //
            // 1) AGC ⟷ Limiter MUTUAMENTE EXCLUSIVOS. Ambos son compresores —
            //    no tiene sentido encenderlos simultáneamente. El frontend ya
            //    aplica `enforceExclusiveDynamics` en cada toggle; esta es la
            //    salvaguarda en el motor: si llegan ambos en true, dejamos
            //    sólo el Limiter activo (es la última barrera de protección
            //    del sink físico).
            //
            // 2) Las bandas EQ vienen como `bands: [g0, g1, ..., g7]` (8 gains
            //    en dB). El parser `json_get_f32_array` los extrae y se
            //    escriben en `dsp_params.eq_bands[i].gain_db_bits`. El
            //    `EqChainSource` recalcula sus coeficientes biquad cada
            //    ~12 ms — el operador percibe el cambio "en tiempo real".
            //
            // 3) Los flags eq/comp/limiter/mono se traducen a wet_target ∈
            //    {0.0, 1.0}. Los adapters interpolan internamente con rampa
            //    de ~5.8 ms para evitar clic (regla 2: DSP siempre encendido,
            //    el switch UI sólo cambia el wet/dry).
            "fx" => {
                state.fx.eq = json_get_bool(&line, "eq").unwrap_or(state.fx.eq);
                let comp_requested = json_get_bool(&line, "comp").unwrap_or(state.fx.comp);
                let lim_requested = json_get_bool(&line, "limiter").unwrap_or(state.fx.limiter);
                // Regla 1: AGC ⟷ Limiter exclusión mutua. Si ambos en true,
                // gana limiter (última línea de defensa del sink físico).
                let (comp_final, lim_final) = if comp_requested && lim_requested {
                    (false, true)
                } else {
                    (comp_requested, lim_requested)
                };
                state.fx.comp = comp_final;
                state.fx.limiter = lim_final;
                state.fx.preamp_db = json_get_f32(&line, "preampDb").unwrap_or(state.fx.preamp_db);
                state.fx.pan = json_get_f32(&line, "pan").unwrap_or(state.fx.pan);
                state.fx.mono = json_get_bool(&line, "mono").unwrap_or(state.fx.mono);
                // Propagación a los atómicos del DSP en vivo.
                state.dsp_params.preamp_db_bits
                    .store(state.fx.preamp_db.to_bits(), Ordering::Relaxed);
                state.dsp_params.pan_bits
                    .store(state.fx.pan.to_bits(), Ordering::Relaxed);
                let bool_to_wet = |b: bool| -> u32 { (if b { 1.0_f32 } else { 0.0_f32 }).to_bits() };
                state.dsp_params.mono_wet_target_bits
                    .store(bool_to_wet(state.fx.mono), Ordering::Relaxed);
                state.dsp_params.eq_wet_target_bits
                    .store(bool_to_wet(state.fx.eq), Ordering::Relaxed);
                state.dsp_params.comp_wet_target_bits
                    .store(bool_to_wet(state.fx.comp), Ordering::Relaxed);
                state.dsp_params.limiter_wet_target_bits
                    .store(bool_to_wet(state.fx.limiter), Ordering::Relaxed);
                // Regla 2: aplicar las 8 bandas EQ (gain en dB por banda).
                // Frecuencia y Q quedan en los defaults broadcast (63/125/...).
                if let Some(bands) = json_get_f32_array(&line, "bands") {
                    for (i, gain_db) in bands.iter().enumerate().take(8) {
                        state.dsp_params.eq_bands[i].gain_db_bits
                            .store(gain_db.to_bits(), Ordering::Relaxed);
                    }
                }
                // FASE D · sub-paso 11.4: orden dinámico de bloques DSP.
                // El frontend envía `order: ["<a>","<b>","<c>"]` con los IDs
                // de cada bloque en orden de procesamiento (entrada→salida).
                // Si vienen menos de 3 o llegan IDs desconocidos, completamos
                // con la cascada por defecto EQ→Comp→Limiter para garantizar
                // que los 3 bloques siempre estén presentes una sola vez.
                if let Some(order_strs) = json_get_string_array(&line, "order") {
                    let mut packed: u32 = 0;
                    let mut used = [false; 3]; // 0=eq, 1=comp, 2=lim
                    let mut slot = 0_u32;
                    for id in order_strs.iter() {
                        if slot >= 3 { break; }
                        let idx_opt: Option<u32> = match id.as_str() {
                            "eq" => Some(0),
                            "comp" => Some(1),
                            "limiter" => Some(2),
                            _ => None,
                        };
                        if let Some(idx) = idx_opt {
                            let i = idx as usize;
                            if !used[i] {
                                used[i] = true;
                                packed |= idx << (slot * 2);
                                slot += 1;
                            }
                        }
                    }
                    // Completa los bloques faltantes en su orden natural para
                    // que la cadena nunca pierda un módulo (paranoia anti-bug).
                    for i in 0..3_u32 {
                        if slot >= 3 { break; }
                        if !used[i as usize] {
                            used[i as usize] = true;
                            packed |= i << (slot * 2);
                            slot += 1;
                        }
                    }
                    state.dsp_params.fx_order.store(packed, Ordering::Relaxed);
                }
            }
            "nowPlaying" => update_now_playing(&mut state, &line),
            "transport" => update_transport(&mut state, &line),
            "playlistSnapshot" => update_playlist_snapshot(&mut state, &line),
            "playlistMode" => update_playlist_mode(&mut state, &line),
            "playlistPlaybackContext" => update_playlist_playback_context(&mut state, &line),
            "playlistFinished" => {
                update_playlist_playback_context(&mut state, &line);
                let current_player = state.playlist_context.current_player.clone();
                process_playlist_finished(&mut state, &current_player, true);
            }
            "playlistManualNext" => {
                update_playlist_playback_context(&mut state, &line);
                let current_player = state.playlist_context.current_player.clone();
                process_playlist_manual_next(&mut state, &current_player);
            }
            "encoder" => update_encoder(&mut state, &line),
            "loadAudio" => {
                let current_gain = state.players.get(&player_id).map(|runtime| runtime.state.gain).unwrap_or(1.0);
                let path = json_get_string(&line, "path").unwrap_or_default();
                let gain = json_get_f32(&line, "gain").unwrap_or(current_gain);
                let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
                let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| default_bus_for_player(&player_id).to_string());
                // cacheDir presente solo en LOCUCIONES (clima): habilita el caché de
                // duración en disco. Ausente/vacío en música → medición directa.
                let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
                // `autoplay: true` → el player arranca inmediatamente (cartwall, overlays).
                // `autoplay: false` (default) → carga en pausa; un `play` posterior lo inicia
                // (playlist, editores). Si el campo está ausente, se comporta como false.
                let autoplay = json_get_bool(&line, "autoplay").unwrap_or(false);
                let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                if let Err(err) = load_audio_player(&mut state, &player_id, &path, gain, !autoplay, &resolved_output_id, &bus_id, &cache_dir) {
                    emit_error(&err, &request_id);
                }
            }
            // Warm-up del caché de duración de LOCUCIONES (hora/clima). Mide y
            // persiste el `.dur` de cada archivo SIN reproducir, en un hilo
            // aparte para NO bloquear el loop de comandos: la emisión en vivo
            // nunca debe esperar a que se precalienten locuciones. Idempotente
            // (los .dur ya presentes son lectura instantánea), así que correrlo
            // en cada arranque es barato y cubre a usuarios nuevos y existentes.
            "cacheDuration" => {
                let paths = json_get_string_array(&line, "paths").unwrap_or_default();
                let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
                if !cache_dir.trim().is_empty() && !paths.is_empty() {
                    std::thread::spawn(move || {
                        for p in &paths {
                            let _ = cached_audio_duration_ms(p, &cache_dir);
                        }
                    });
                }
            }
            // Reproducción gapless de una secuencia de archivos en un player
            // normal (cartwall: locución de hora HORAS+MINUTOS sin micro-pausa).
            // No toca la maquinaria time_locution; el fin se detecta por 'ended'.
            "cartwallSequence" => {
                let paths = json_get_string_array(&line, "paths").unwrap_or_default();
                let gain = json_get_f32(&line, "gain").unwrap_or(1.0);
                let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| "cartwall".to_string());
                let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
                let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
                let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                if paths.is_empty() {
                    emit_error("cartwallSequence: 'paths' vacio.", &request_id);
                } else if let Err(err) = load_audio_player_sequence(&mut state, &player_id, &paths, gain, &resolved_output_id, &bus_id, &cache_dir) {
                    emit_error(&err, &request_id);
                }
            }
            "labPlay" => {
                let current = state.players.get(&player_id).map(|runtime| (runtime.state.path.clone(), runtime.state.gain)).unwrap_or_else(|| (String::new(), 1.0));
                let path = json_get_string(&line, "path").unwrap_or(current.0);
                let gain = json_get_f32(&line, "gain").unwrap_or(current.1);
                let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
                let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| default_bus_for_player(&player_id).to_string());
                let resolved_output_id = resolve_output_for_bus(&state, &bus_id, &output_id);
                if let Err(err) = load_audio_player(&mut state, &player_id, &path, gain, false, &resolved_output_id, &bus_id, "") {
                    emit_error(&err, &request_id);
                }
            }
            "play" => {
                if let Err(err) = play_existing_or_rebuild_player(&mut state, &player_id) {
                    emit_error(&err, &request_id);
                }
            }
            "pause" => {
                let runtime = state.players.entry(player_id.clone()).or_default();
                runtime.state.status = "paused".to_string();
                if let Some(player) = &runtime.player {
                    player.pause();
                }
            }
            "repeat" => {
                let runtime = state.players.entry(player_id.clone()).or_default();
                let enabled = json_get_bool(&line, "enabled").unwrap_or(false);
                runtime.state.repeat_active = enabled;
                runtime.state.repeat_start_ms = json_get_u64(&line, "startMs")
                    .or_else(|| json_get_u64(&line, "positionMs"))
                    .unwrap_or(runtime.state.repeat_start_ms);
                runtime.state.repeat_count = 0;
            }
            "stop" => {
                if let Some(runtime) = state.players.get_mut(&player_id) {
                    runtime.state.status = "stopped".to_string();
                    release_runtime_player(runtime);
                }
                if is_diagnostic_player(&player_id) {
                    state.players.remove(&player_id);
                }
                // Si paran el player que actualmente sostiene la locución
                // horaria, invalidamos la generación y limpiamos el
                // reloj acumulativo de la pista virtual (HRS+MIN unificados).
                if !state.time_locution_player.is_empty() && player_id == state.time_locution_player {
                    state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
                    state.time_locution_player.clear();
                    state.time_locution_started_at = None;
                    state.time_locution_total_ms = 0;
                }
            }
            "timeLocution" => {
                // Locución de hora 100% gestionada por el motor: resuelve archivos
                // según el reloj local, encola en un único Player con `append`
                // (rodio toca secuencial sin gap). El tick principal emite
                // `timeLocutionEnded` cuando el Player realmente queda vacío.
                let folder = json_get_string(&line, "folder").unwrap_or_default();
                let gain = json_get_f32(&line, "gain").unwrap_or(1.0);
                let bus_id = json_get_string(&line, "bus").unwrap_or_else(|| "jingle".to_string());
                let output_id = json_get_string(&line, "outputId").unwrap_or_else(|| "default".to_string());
                // cacheDir habilita el caché de duración en disco para los
                // segmentos (HRS/MIN) de la locución horaria.
                let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
                if folder.is_empty() {
                    emit_error("timeLocution: falta el campo 'folder'.", &request_id);
                } else {
                    // player_id viene del JSON ("player"). Default: "time-locucion"
                    // (uso histórico del bus jingle como pisador). Cuando se lanza
                    // desde la playlist el renderer pasa "player-a"/"player-b" para
                    // que la locución se trate como una pista normal del programa.
                    let time_player_id = if player_id == "probe" { "time-locucion".to_string() } else { player_id.clone() };
                    match start_time_locution(&mut state, &time_player_id, &folder, gain, &output_id, &bus_id, &request_id, &cache_dir) {
                        Ok((duration_ms, files)) => {
                            let files_json = files
                                .iter()
                                .map(|f| format!("\"{}\"", escape_json(f)))
                                .collect::<Vec<_>>()
                                .join(",");
                            println!(
                                "{{{}\"type\":\"timeLocutionStarted\",\"engine\":\"rustAudio\",\"player\":\"{}\",\"bus\":\"{}\",\"durationMs\":{},\"segments\":{},\"files\":[{}],\"updatedAt\":{}}}",
                                request_id_field(&request_id),
                                escape_json(&time_player_id),
                                escape_json(&bus_id),
                                duration_ms,
                                files.len(),
                                files_json,
                                now_ms()
                            );
                            let _ = io::stdout().flush();
                            continue;
                        }
                        Err(err) => emit_error(&err, &request_id),
                    }
                }
            }
            "seek" => {
                if let Some(runtime) = state.players.get_mut(&player_id) {
                    runtime.state.position_ms = json_get_u64(&line, "positionMs").unwrap_or(runtime.state.position_ms);
                    if let Some(player) = &runtime.player {
                        if let Err(err) = player.try_seek(Duration::from_millis(runtime.state.position_ms)) {
                            emit_error(&format!("seek '{}' a {} ms fallo: {:?}", player_id, runtime.state.position_ms, err), &request_id);
                        }
                    }
                }
            }
            "setGain" => {
                let new_gain = {
                    let runtime = state.players.entry(player_id.clone()).or_default();
                    runtime.state.fade_active = false;
                    runtime.state.fade_stop_after = false;
                    runtime.state.fade_duration_ms = 0;
                    runtime.state.gain = json_get_f32(&line, "gain")
                        .unwrap_or(runtime.state.gain)
                        .clamp(0.0, 2.0);
                    runtime.state.gain
                };
                // FASE D · sub-paso 7.5: solo aplicamos gain individual del
                // player. El master_gain se aplica en el FaderSource único
                // entre program_mixer y sink PGM.
                if let Some(runtime) = state.players.get(&player_id) {
                    if let Some(player) = &runtime.player {
                        player.set_volume(new_gain.clamp(0.0, 2.0));
                    }
                }
            }
            "fade" => {
                let runtime = state.players.entry(player_id.clone()).or_default();
                let from_gain = json_get_f32(&line, "fromGain")
                    .unwrap_or(runtime.state.gain)
                    .clamp(0.0, 2.0);
                let target_gain = json_get_f32(&line, "toGain")
                    .or_else(|| json_get_f32(&line, "gain"))
                    .unwrap_or(runtime.state.gain)
                    .clamp(0.0, 2.0);
                let duration_ms = json_get_u64(&line, "durationMs")
                    .or_else(|| json_get_f32(&line, "seconds").map(|s| (s.max(0.0) * 1000.0).round() as u64))
                    .unwrap_or(0);
                let stop_after = json_get_bool(&line, "stopAfter").unwrap_or(false);
                runtime.state.gain = from_gain;
                if let Some(player) = &runtime.player {
                    player.set_volume(from_gain);
                }
                if duration_ms <= 25 || (!stop_after && (from_gain - target_gain).abs() < 0.001) {
                    runtime.state.fade_active = false;
                    runtime.state.gain = target_gain;
                    if let Some(player) = &runtime.player {
                        player.set_volume(target_gain);
                    }
                    if stop_after {
                        runtime.state.status = "stopped".to_string();
                        release_runtime_player(runtime);
                    }
                } else {
                    runtime.state.fade_active = true;
                    runtime.state.fade_start_gain = from_gain;
                    runtime.state.fade_target_gain = target_gain;
                    runtime.state.fade_started_at_ms = now_ms();
                    runtime.state.fade_duration_ms = duration_ms;
                    runtime.state.fade_stop_after = stop_after;
                }
            }
            "getPeaks" => {
                // FIX BUG (pausas de vúmetros): antes este comando se procesaba
                // SÍNCRONO en el main loop. `compute_waveform_peaks` decodifica
                // el archivo completo (1-5 s para canciones largas sin caché),
                // tiempo durante el cual el main loop NO procesa los `PushTick`
                // → los meters de la consola se "congelan" hasta que termina.
                //
                // Solución: spawn un thread worker dedicado por cada getPeaks.
                // El main loop responde inmediato y sigue procesando ticks. El
                // worker emite el `peaks` por stdout cuando termina. Para
                // proteger contra entrelazado de bytes en stdout (cada `println!`
                // ya es line-atómico, pero el formato grande de peaks se
                // serializa antes de un solo write), usamos `stdout().lock()`
                // antes del print.
                let path = json_get_string(&line, "path").unwrap_or_default();
                let target_bins = json_get_u64(&line, "bins").unwrap_or(4096) as usize;
                let cache_dir = json_get_string(&line, "cacheDir").unwrap_or_default();
                let req_id_owned = request_id.clone();
                thread::spawn(move || {
                    match compute_waveform_peaks(&path, target_bins, &cache_dir) {
                        Ok((min_peaks, max_peaks, duration_ms, sample_rate, silence_start, silence_end)) => {
                            let min_json = floats_to_json(&min_peaks);
                            let max_json = floats_to_json(&max_peaks);
                            // Pre-formatear como un solo String y luego escribir
                            // atómicamente (un solo `write_all` bajo el lock de
                            // stdout) para garantizar que no se entrelace con
                            // otros writes de status push.
                            let payload = format!(
                                "{{{}\"type\":\"peaks\",\"bins\":{},\"durationMs\":{},\"sampleRate\":{},\"silenceStart\":{:.4},\"silenceEnd\":{:.4},\"min\":{},\"max\":{}}}\n",
                                request_id_field(&req_id_owned),
                                min_peaks.len(),
                                duration_ms,
                                sample_rate,
                                silence_start,
                                silence_end,
                                min_json,
                                max_json,
                            );
                            let stdout = io::stdout();
                            let mut lock = stdout.lock();
                            let _ = lock.write_all(payload.as_bytes());
                            let _ = lock.flush();
                        }
                        Err(err) => {
                            emit_error(&format!("getPeaks: {}", err), &req_id_owned);
                        }
                    }
                });
                // No llamamos emit_status acá: el thread responderá asíncrono.
                // Saltamos el emit_status al final del bloque con continue.
                continue 'main_loop;
            }
            // ================================================================
            // stream_start / stream_chunk / stream_stop — inyección PCM vivo
            // ================================================================
            // Permiten retransmitir una URL de radio (o cualquier fuente PCM
            // externa) a través del program_mixer. El backend Node lanza FFmpeg
            // apuntando a la URL, lee el stdout PCM s16le y lo envía en chunks
            // base64 via `stream_chunk`. El audio fluye por el mismo camino DSP
            // que cualquier pista local (EQ/Comp/Limiter → encoder tap).

            "stream_start" => {
                let bus_id = json_get_string(&line, "bus")
                    .unwrap_or_else(|| "master".to_string());
                let gain = json_get_f32(&line, "gain").unwrap_or(1.0);
                let output_id = json_get_string(&line, "outputId")
                    .unwrap_or_else(|| "default".to_string());
                let channels_raw = json_get_u64(&line, "channels").unwrap_or(2) as u16;
                let sample_rate_raw = json_get_u64(&line, "sampleRate").unwrap_or(44100) as u32;

                // Garantizar program_mixer si el bus es de programa.
                if is_program_bus(&bus_id) && state.program_mixer_input.is_none() {
                    let master_out = state.routes.get("master")
                        .map(|r| r.output_device_id.clone())
                        .filter(|id| !id.trim().is_empty())
                        .unwrap_or_else(|| output_id.clone());
                    if let Err(err) = ensure_program_mixer(&mut state, &master_out) {
                        emit_error(&err, &request_id);
                        emit_status(&state, &request_id);
                        continue 'main_loop;
                    }
                }

                // Buffer de ~2 s para absorber jitter del IPC.
                let capacity = (sample_rate_raw as usize) * (channels_raw as usize) * 2;
                let (producer, consumer) = rtrb::RingBuffer::<f32>::new(capacity);
                let finished = Arc::new(AtomicBool::new(false));

                let source = PcmRingSource {
                    consumer,
                    finished: Arc::clone(&finished),
                    channels: NonZeroU16::new(channels_raw.max(1)).unwrap(),
                    sample_rate: NonZeroU32::new(sample_rate_raw.max(1)).unwrap(),
                };

                // Conectar al program_mixer o al sink directo.
                let use_program_mixer = is_program_bus(&bus_id)
                    && state.program_mixer_input.is_some();
                let player = if use_program_mixer {
                    let mixer = state.program_mixer_input.as_ref().unwrap().clone();
                    Player::connect_new(&mixer)
                } else {
                    let resolved = resolve_output_for_bus(&state, &bus_id, &output_id);
                    match state.outputs.get(&resolved) {
                        Some(output) => Player::connect_new(output.sink.mixer()),
                        None => {
                            emit_error("stream_start: output no disponible.", &request_id);
                            emit_status(&state, &request_id);
                            continue 'main_loop;
                        }
                    }
                };

                player.set_volume(gain.clamp(0.0, 2.0));

                let runtime = state.players.entry(player_id.clone()).or_default();
                if let Some(old_player) = runtime.player.take() {
                    old_player.stop();
                }
                // Limpiar stream anterior si existía en este player.
                state.stream_producers.remove(&player_id);
                if let Some(old_flag) = state.stream_finished_flags.remove(&player_id) {
                    old_flag.store(true, Ordering::Relaxed);
                }

                let runtime = state.players.entry(player_id.clone()).or_default();
                runtime.meter = Arc::new(PlayerMeter::default());
                let metered = MeteredSource::new(source, Arc::clone(&runtime.meter));
                player.append(metered);
                runtime.state.path = format!("stream://{}", player_id);
                runtime.state.status = "playing".to_string();
                runtime.state.position_ms = 0;
                runtime.state.duration_ms = 0; // duración desconocida
                runtime.state.gain = gain.clamp(0.0, 2.0);
                runtime.state.bus_id = bus_id.clone();
                runtime.state.fade_active = false;
                runtime.state.repeat_active = false;
                runtime.player = Some(player);

                state.stream_producers.insert(player_id.clone(), producer);
                state.stream_finished_flags.insert(player_id.clone(), finished);

                println!(
                    "{{\"type\":\"stream_ready\",\"player\":\"{}\",\"updatedAt\":{}}}",
                    player_id,
                    now_ms()
                );
                let _ = io::stdout().flush();
            }

            "stream_chunk" => {
                use base64::Engine;
                let data_b64 = match json_get_string(&line, "data") {
                    Some(d) => d,
                    None => {
                        // chunk sin datos: ignorar silenciosamente (no emitir error
                        // para no saturar el log cuando hay underruns frecuentes).
                        emit_status(&state, &request_id);
                        continue 'main_loop;
                    }
                };

                if let Some(producer) = state.stream_producers.get_mut(&player_id) {
                    match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                        Ok(bytes) => {
                            let mut i = 0usize;
                            while i + 1 < bytes.len() {
                                let sample_i16 = i16::from_le_bytes([bytes[i], bytes[i + 1]]);
                                let sample_f32 = sample_i16 as f32 / 32768.0;
                                if producer.push(sample_f32).is_err() {
                                    // Ring lleno (overrun): descartar el resto del chunk.
                                    // El overrun en streams vivos es preferible al lag.
                                    break;
                                }
                                i += 2;
                            }
                        }
                        Err(_) => {
                            // Base64 inválido: ignorar sin crashear (puede ocurrir en
                            // el arranque/cierre del proceso FFmpeg).
                        }
                    }
                }
                // stream_chunk no emite status push (muy frecuente: 50/s).
                continue 'main_loop;
            }

            "stream_stop" => {
                // Señalar al PcmRingSource que ya no habrá más datos.
                if let Some(finished) = state.stream_finished_flags.remove(&player_id) {
                    finished.store(true, Ordering::Relaxed);
                }
                // Retirar el productor → ningún hilo puede escribir más.
                state.stream_producers.remove(&player_id);

                // Actualizar estado del player.
                if let Some(runtime) = state.players.get_mut(&player_id) {
                    runtime.state.status = "stopped".to_string();
                }

                println!(
                    "{{\"type\":\"stream_stopped\",\"player\":\"{}\",\"updatedAt\":{}}}",
                    player_id,
                    now_ms()
                );
                let _ = io::stdout().flush();
            }

            "" => emit_error("Comando sin campo cmd.", &request_id),
            other => emit_error(&format!("Comando no soportado: {}", other), &request_id),
        }

        emit_status(&state, &request_id);
    }
}
