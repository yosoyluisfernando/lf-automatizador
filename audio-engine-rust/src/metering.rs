// Medición de picos en tiempo real, lock-free.
//
// PlayerMeter almacena picos L/R como AtomicU32 (f32 en bits). El hilo de audio
// escribe con Relaxed; el hilo de dispatch lee con Relaxed. Sin mutex ni alloc
// en el hot path.
//
// MeteredSource es un adaptador de rodio::Source que mide el peak cada 1024
// samples y lo publica en el PlayerMeter asociado.
//
// PcmRingSource lee samples desde un rtrb SPSC ring buffer (usado para streams
// externos como la entrada de línea).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

/// Medidor de picos L/R atómico. Cero locks en el callback de audio.
#[derive(Default)]
pub(crate) struct PlayerMeter {
    left_peak_bits: AtomicU32,
    right_peak_bits: AtomicU32,
}

impl PlayerMeter {
    pub(crate) fn reset(&self) {
        self.left_peak_bits
            .store(0.0f32.to_bits(), Ordering::Relaxed);
        self.right_peak_bits
            .store(0.0f32.to_bits(), Ordering::Relaxed);
    }

    pub(crate) fn set_peaks(&self, left: f32, right: f32) {
        self.left_peak_bits
            .store(left.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.right_peak_bits
            .store(right.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub(crate) fn read(&self) -> (f32, f32) {
        (
            f32::from_bits(self.left_peak_bits.load(Ordering::Relaxed)),
            f32::from_bits(self.right_peak_bits.load(Ordering::Relaxed)),
        )
    }
}

/// Adaptador Source que mide peak absoluto por ventana de 1024 samples.
/// Se inserta entre el decoder y el mixer para alimentar los VU-meters del frontend.
pub(crate) struct MeteredSource<S>
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
    pub(crate) fn new(source: S, meter: Arc<PlayerMeter>) -> Self {
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
            self.meter
                .set_peaks(self.window_left_peak, self.window_right_peak);
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

/// Source que consume samples de un rtrb ring buffer SPSC.
/// Entrega silencio si el ring está vacío y aún no terminó el productor.
pub(crate) struct PcmRingSource {
    pub(crate) consumer: rtrb::Consumer<f32>,
    pub(crate) finished: Arc<AtomicBool>,
    pub(crate) channels: ChannelCount,
    pub(crate) sample_rate: SampleRate,
}

impl Iterator for PcmRingSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        match self.consumer.pop() {
            Ok(sample) => Some(sample),
            Err(_) => {
                if self.finished.load(Ordering::Relaxed) {
                    None
                } else {
                    Some(0.0)
                }
            }
        }
    }
}

impl Source for PcmRingSource {
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
    fn try_seek(&mut self, _pos: Duration) -> Result<(), SeekError> {
        Ok(())
    }
}
