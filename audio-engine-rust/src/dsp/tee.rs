// Bifurcación de señal del bus FX (MultiTee + dual TapConsumer).
//
// `MultiTeeSource` se inserta en la cadena del program_mixer. Para cada sample
// que pasa, lo replica en N ring buffers `rtrb` SPSC (uno por consumidor
// secundario: monitor, encoder). El passthrough principal sigue alimentando al
// sink PGM como siempre.
//
// `DualTapConsumerSource` es el otro extremo: lee de DOS rings (Pre-FX y
// Post-FX) y entrega el que indique el atómico de modo, conmutando en caliente.
// Si el ring está vacío entrega silencio; si está lleno el productor dropea el
// sample más viejo. Filosofía: jamás bloquear el thread de audio.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

use super::DspParams;

pub(crate) struct MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    taps: Vec<TeeTap>,
}

pub(crate) struct TeeTap {
    producer: rtrb::Producer<Sample>,
    dropped: Option<Arc<AtomicU64>>,
    enabled: Option<Arc<DspParams>>,
}

impl TeeTap {
    pub(crate) fn new(
        producer: rtrb::Producer<Sample>,
        dropped: Option<Arc<AtomicU64>>,
        enabled: Option<Arc<DspParams>>,
    ) -> Self {
        Self {
            producer,
            dropped,
            enabled,
        }
    }
}

impl<S> MultiTeeSource<S>
where
    S: Source<Item = Sample>,
{
    pub(crate) fn new(source: S, taps: Vec<TeeTap>) -> Self {
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
            if tap
                .enabled
                .as_ref()
                .is_some_and(|params| !params.encoder_tap_active.load(Ordering::Relaxed))
            {
                continue;
            }
            // push() retorna Err si el ring está lleno. Silencioso: el audio
            // del PGM no se ve afectado. El consumidor lento simplemente
            // pierde samples (mejor que bloquear el thread de audio).
            if tap.producer.push(sample).is_err() {
                if let Some(counter) = tap.dropped.as_ref() {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        Some(sample)
    }
}

impl<S> Source for MultiTeeSource<S>
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

/// Umbral por encima del cual el TapConsumer entiende que el productor "se
/// adelantó" (típicamente al arranque cuando los dos sinks físicos no comenzaron
/// al mismo tiempo) y dropea samples viejos para alinear la latencia al objetivo.
/// Sin este drenado, el ring se enclava a su capacidad máxima y produce delays
/// perceptibles (1-2 seg).
///
/// 2048 (~23 ms estéreo @ 44.1 kHz) tolera el jitter del resampler implícito de
/// rodio cuando el sink físico del monitor opera a un sample-rate distinto del
/// program_mixer (típico: 48 kHz nativo vs 44.1 kHz interno). Con target
/// demasiado bajo el ring se vaciaba a 0 entre samples y el consumer entregaba
/// ceros → distorsión audible. 23 ms cubre el peak-to-peak observado en Windows
/// con WASAPI y sigue siendo indetectable como latencia.
const TAP_DRAIN_TARGET_SAMPLES: usize = 2_048;

/// Helper: dropea samples del ring en pares (preserva fase L-R) hasta dejar a
/// lo sumo `target` samples disponibles.
#[inline]
fn drain_to_target(consumer: &mut rtrb::Consumer<Sample>, target: usize) {
    let available = consumer.slots();
    if available <= target {
        return;
    }
    let mut to_drop = (available - target) & !1;
    while to_drop > 0 {
        if consumer.pop().is_err() {
            break;
        }
        to_drop -= 1;
    }
}

/// Dual tap consumer. Lee de DOS ring buffers (Pre-FX y Post-FX) y entrega
/// samples del que el atómico de modo indique (0 = preFx, 1 = postFx). El otro
/// ring se drena agresivamente para que no acumule memoria si está inactivo.
/// La conmutación es en caliente, sample-by-sample, sin reconstruir el grafo.
pub(crate) struct DualTapConsumerSource {
    pre_consumer: rtrb::Consumer<Sample>,
    post_consumer: rtrb::Consumer<Sample>,
    mode_atom: Arc<DspParams>, // contiene el atómico que decide pre/post
    is_monitor: bool,          // true = lee monitor_tap_mode; false = encoder_tap_mode
    channels: ChannelCount,
    sample_rate: SampleRate,
}

impl DualTapConsumerSource {
    pub(crate) fn new(
        pre_consumer: rtrb::Consumer<Sample>,
        post_consumer: rtrb::Consumer<Sample>,
        params: Arc<DspParams>,
        is_monitor: bool,
        channels: ChannelCount,
        sample_rate: SampleRate,
    ) -> Self {
        Self {
            pre_consumer,
            post_consumer,
            mode_atom: params,
            is_monitor,
            channels,
            sample_rate,
        }
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
        // Anti-acumulación en AMBOS rings. El activo se mantiene en ~23 ms
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
        None
    }
    fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> {
        Err(SeekError::NotSupported {
            underlying_source: "DualTapConsumerSource",
        })
    }
}
