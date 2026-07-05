// Carga y decodificación de audio.
//
// Estrategia de dos caminos según tamaño del archivo:
//
// 1. RAM (≤ PRELOAD_MAX_BYTES = 200 MB):
//    Se lee el archivo completo a un Vec<u8>, se envuelve en Cursor y se pasa a
//    rodio::Decoder. El audio queda inmune a saturación de disco durante la
//    reproducción.
//
// 2. Streaming (> 200 MB):
//    Se lanza un hilo decodificador que llena un rtrb ring buffer de 10s.
//    StreamedFileSource consume el ring como un rodio::Source normal.
//    No soporta seek.
//
// `load_audio_player` y `load_audio_player_sequence` son los puntos de entrada
// que conectan el decoder al program_mixer (o al sink directo) y registran el
// RuntimePlayer en EngineState.

use std::fs::File;
use std::io;
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Decoder, Player, Sample, SampleRate, Source};

use crate::metering::{MeteredSource, PlayerMeter};
use crate::peaks::cached_audio_duration_ms;
use crate::routing::ensure_program_mixer;
use crate::state::{is_program_bus, EngineState, RouteState};
use crate::{emit::resolve_output_for_bus, output::ensure_output};

/// Archivos por debajo de este tamaño se precargan completos en RAM.
const PRELOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;

pub(crate) trait PreloadedRead: io::Read + io::Seek + Send + Sync {}
impl<T: io::Read + io::Seek + Send + Sync> PreloadedRead for T {}

const STREAM_FILE_BUFFER_SECONDS: usize = 10;

pub(crate) struct PcmStreamRuntime {
    pub(crate) producer: rtrb::Producer<f32>,
    pub(crate) finished: Arc<AtomicBool>,
}

/// Source que consume audio desde un ring buffer llenado por un hilo decodificador.
/// Usado para archivos > 200 MB que no caben en RAM.
pub(crate) struct StreamedFileSource {
    consumer: rtrb::Consumer<f32>,
    finished: Arc<AtomicBool>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    total_duration: Option<Duration>,
}

impl Iterator for StreamedFileSource {
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        match self.consumer.pop() {
            Ok(sample) => Some(sample),
            Err(_) => {
                if self.finished.load(Ordering::Acquire) && self.consumer.is_empty() {
                    None
                } else {
                    Some(0.0)
                }
            }
        }
    }
}

impl Source for StreamedFileSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }
    fn try_seek(&mut self, _pos: Duration) -> Result<(), SeekError> {
        Err(SeekError::NotSupported {
            underlying_source: std::any::type_name::<Self>(),
        })
    }
}

/// Abre un archivo de audio en modo streaming: lanza un hilo que decodifica y
/// llena un ring de 10 s. Devuelve el extremo consumidor como Source.
pub(crate) fn spawn_streamed_file_source(
    file_path: &str,
    byte_len: u64,
) -> Result<StreamedFileSource, String> {
    let file = File::open(file_path).map_err(|err| format!("No se pudo abrir archivo: {}", err))?;
    let decoder = Decoder::builder()
        .with_data(io::BufReader::new(file))
        .with_byte_len(byte_len)
        .with_seekable(false)
        .build()
        .map_err(|err| format!("No se pudo decodificar audio: {}", err))?;
    let channels = decoder.channels();
    let sample_rate = decoder.sample_rate();
    let total_duration = decoder.total_duration();
    let ring_capacity = (sample_rate.get() as usize)
        .saturating_mul(channels.get() as usize)
        .saturating_mul(STREAM_FILE_BUFFER_SECONDS)
        .max(44_100);
    let (mut producer, consumer) = rtrb::RingBuffer::<f32>::new(ring_capacity);
    let finished = Arc::new(AtomicBool::new(false));
    let finished_for_thread = Arc::clone(&finished);
    thread::spawn(move || {
        for sample in decoder {
            let mut pending = sample;
            loop {
                match producer.push(pending) {
                    Ok(()) => break,
                    Err(rtrb::PushError::Full(returned)) => {
                        pending = returned;
                        if producer.is_abandoned() {
                            return;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        finished_for_thread.store(true, Ordering::Release);
    });
    Ok(StreamedFileSource {
        consumer,
        finished,
        channels,
        sample_rate,
        total_duration,
    })
}

/// Fuente de audio unificada: RAM (seekable) o Streaming (no seekable).
pub(crate) enum PlaybackSource {
    Ram(Decoder<Box<dyn PreloadedRead>>),
    Streamed(StreamedFileSource),
}

pub(crate) fn start_pcm_stream_player(
    state: &mut EngineState,
    player_id: &str,
    bus_id: &str,
    output_id: &str,
    gain: f32,
    channels: u16,
    sample_rate: u32,
    ring_buffer_seconds: u32,
    autoplay: bool,
) -> Result<PcmStreamRuntime, String> {
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let requested_master_out = state
            .routes
            .get("master")
            .map(|r| r.output_device_id.clone())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| output_id.to_string());
        let (master_out, master_name) = ensure_output(state, &requested_master_out)?;
        state.routes.insert(
            "master".to_string(),
            RouteState {
                output_device_id: master_out.clone(),
                output_device_name: master_name,
            },
        );
        ensure_program_mixer(state, &master_out)?;
    }

    let channels = channels.max(1);
    let sample_rate = sample_rate.max(1);
    let capacity = (sample_rate as usize)
        .saturating_mul(channels as usize)
        .saturating_mul(ring_buffer_seconds.clamp(2, 20) as usize)
        .max(44_100);
    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(capacity);
    let finished = Arc::new(AtomicBool::new(false));
    let source = crate::metering::PcmRingSource {
        consumer,
        finished: Arc::clone(&finished),
        channels: NonZeroU16::new(channels).unwrap(),
        sample_rate: NonZeroU32::new(sample_rate).unwrap(),
    };

    let use_program_mixer = is_program_bus(bus_id) && state.program_mixer_input.is_some();
    let player = if use_program_mixer {
        let mixer = state.program_mixer_input.as_ref().unwrap().clone();
        Player::connect_new(&mixer)
    } else {
        let resolved = resolve_output_for_bus(state, bus_id, output_id);
        match state.outputs.get(&resolved) {
            Some(output) => Player::connect_new(output.sink.mixer()),
            None => return Err("stream_start: output no disponible.".to_string()),
        }
    };

    player.set_volume(gain.clamp(0.0, 2.0));
    player.pause();

    let runtime = state.players.entry(player_id.to_string()).or_default();
    if let Some(old_player) = runtime.player.take() {
        old_player.stop();
    }
    state.stream_producers.remove(player_id);
    if let Some(old_flag) = state.stream_finished_flags.remove(player_id) {
        old_flag.store(true, Ordering::Relaxed);
    }

    let runtime = state.players.entry(player_id.to_string()).or_default();
    runtime.meter = Arc::new(PlayerMeter::default());
    let metered = MeteredSource::new(source, Arc::clone(&runtime.meter));
    player.append(metered);
    if autoplay {
        player.play();
    }
    runtime.state.path = format!("stream://{}", player_id);
    runtime.state.status = "playing".to_string();
    runtime.state.position_ms = 0;
    runtime.state.duration_ms = 0;
    runtime.state.gain = gain.clamp(0.0, 2.0);
    runtime.state.bus_id = bus_id.to_string();
    runtime.state.fade_active = false;
    runtime.state.repeat_active = false;
    runtime.player = Some(player);

    Ok(PcmStreamRuntime { producer, finished })
}

impl Iterator for PlaybackSource {
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        match self {
            PlaybackSource::Ram(inner) => inner.next(),
            PlaybackSource::Streamed(inner) => inner.next(),
        }
    }
}

impl Source for PlaybackSource {
    fn current_span_len(&self) -> Option<usize> {
        match self {
            PlaybackSource::Ram(inner) => inner.current_span_len(),
            PlaybackSource::Streamed(inner) => inner.current_span_len(),
        }
    }
    fn channels(&self) -> ChannelCount {
        match self {
            PlaybackSource::Ram(inner) => inner.channels(),
            PlaybackSource::Streamed(inner) => inner.channels(),
        }
    }
    fn sample_rate(&self) -> SampleRate {
        match self {
            PlaybackSource::Ram(inner) => inner.sample_rate(),
            PlaybackSource::Streamed(inner) => inner.sample_rate(),
        }
    }
    fn total_duration(&self) -> Option<Duration> {
        match self {
            PlaybackSource::Ram(inner) => inner.total_duration(),
            PlaybackSource::Streamed(inner) => inner.total_duration(),
        }
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        match self {
            PlaybackSource::Ram(inner) => inner.try_seek(pos),
            PlaybackSource::Streamed(inner) => inner.try_seek(pos),
        }
    }
}

/// Abre un archivo de audio y decide el camino (RAM vs streaming) según su tamaño.
/// Devuelve (source, true si fue precargado a RAM).
pub(crate) fn open_playback_decoder(file_path: &str) -> Result<(PlaybackSource, bool), String> {
    let byte_len = std::fs::metadata(file_path)
        .map_err(|err| format!("No se pudo abrir archivo: {}", err))?
        .len();
    if byte_len <= PRELOAD_MAX_BYTES {
        let bytes =
            std::fs::read(file_path).map_err(|err| format!("No se pudo abrir archivo: {}", err))?;
        let reader: Box<dyn PreloadedRead> = Box::new(io::Cursor::new(bytes));
        let decoder = Decoder::builder()
            .with_data(reader)
            .with_byte_len(byte_len)
            .with_seekable(true)
            .build()
            .map_err(|err| format!("No se pudo decodificar audio: {}", err))?;
        Ok((PlaybackSource::Ram(decoder), true))
    } else {
        eprintln!(
            "[preload] Archivo supera el tope de precarga ({} bytes): streaming con ring de {} s. {}",
            byte_len, STREAM_FILE_BUFFER_SECONDS, file_path
        );
        let source = spawn_streamed_file_source(file_path, byte_len)?;
        Ok((PlaybackSource::Streamed(source), false))
    }
}

/// Carga un archivo de audio en un player: decodifica, aplica metering, lo conecta
/// al program_mixer (si es bus de programa) o al sink directo, y registra el
/// RuntimePlayer en EngineState. Si el player ya existía, detiene el anterior.
pub(crate) fn load_audio_player(
    state: &mut EngineState,
    player_id: &str,
    file_path: &str,
    gain: f32,
    paused: bool,
    output_id: &str,
    bus_id: &str,
    cache_dir: &str,
) -> Result<(), String> {
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state
            .routes
            .get("master")
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
    let (decoder, _preloaded) = open_playback_decoder(file_path)?;
    let duration_ms = if cache_dir.trim().is_empty() {
        decoder
            .total_duration()
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    } else {
        cached_audio_duration_ms(file_path, cache_dir)
    };
    let player = match program_mixer_clone.as_ref() {
        Some(mixer) => Player::connect_new(mixer),
        None => {
            let output = state
                .outputs
                .get(&resolved_output_id)
                .ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    let _ = bus_id;
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
    runtime.state.status = if paused {
        "loaded".to_string()
    } else {
        "playing".to_string()
    };
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

/// Carga una secuencia de archivos en un player para reproducción gapless.
/// Cada archivo se decodifica y se encola con `player.append()`.
pub(crate) fn load_audio_player_sequence(
    state: &mut EngineState,
    player_id: &str,
    file_paths: &[String],
    gain: f32,
    paused: bool,
    output_id: &str,
    bus_id: &str,
    cache_dir: &str,
) -> Result<(), String> {
    if file_paths.is_empty() {
        return Err("Secuencia de audio vacia.".to_string());
    }
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;
    if is_program_bus(bus_id) && state.program_mixer_input.is_none() {
        let master_output_id = state
            .routes
            .get("master")
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
            let output = state
                .outputs
                .get(&resolved_output_id)
                .ok_or_else(|| "Salida Rust no disponible.".to_string())?;
            Player::connect_new(output.sink.mixer())
        }
    };
    player.set_volume(gain.clamp(0.0, 2.0));
    if paused {
        player.pause();
    }

    let meter = Arc::new(PlayerMeter::default());
    let mut total_ms: u64 = 0;
    for path in file_paths {
        total_ms = total_ms.saturating_add(cached_audio_duration_ms(path, cache_dir));
    }
    for path in file_paths {
        let (decoder, _preloaded) =
            open_playback_decoder(path).map_err(|e| format!("{} ({})", e, path))?;
        let metered = MeteredSource::new(decoder, Arc::clone(&meter));
        player.append(metered);
    }

    let runtime = state.players.entry(player_id.to_string()).or_default();
    if let Some(old_player) = runtime.player.take() {
        old_player.stop();
    }
    runtime.meter = Arc::clone(&meter);
    runtime.state.path = file_paths.join("|");
    runtime.state.status = if paused {
        "loaded".to_string()
    } else {
        "playing".to_string()
    };
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
