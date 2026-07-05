// `FaderSource` aplica una ganancia atómica a cada sample. Es el único punto
// de aplicación del master/monitor fader, insertado entre la salida del
// program_mixer (o el tap monitor) y el sink físico correspondiente.
//
// La ganancia vive en `DspParams.master_gain_bits` / `monitor_gain_bits`
// (f32 en bits). Los handlers IPC la escriben con `Ordering::Relaxed`; este
// adapter la lee también con `Relaxed`. Cero locks en el hot path de audio.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

use super::DspParams;

pub(crate) struct FaderSource<S>
where
    S: Source<Item = Sample>,
{
    source: S,
    params: Arc<DspParams>,
    gain_field: FaderGainField,
}

/// Selector de qué atómico de `DspParams` consume este FaderSource.
#[derive(Clone, Copy)]
pub(crate) enum FaderGainField {
    Master,
    Monitor,
}

impl<S> FaderSource<S>
where
    S: Source<Item = Sample>,
{
    pub(crate) fn new(source: S, params: Arc<DspParams>, gain_field: FaderGainField) -> Self {
        Self {
            source,
            params,
            gain_field,
        }
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
