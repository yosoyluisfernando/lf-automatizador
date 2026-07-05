use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use base64::Engine;

use crate::protocol::escape_json;

use super::source::InputSource;

const DEFAULT_MAX_BUFFER_FRAMES: usize = 44_100 * 2;

#[derive(Clone, Default)]
pub(crate) struct InputRouter {
    inner: Arc<Mutex<InputRouterState>>,
}

#[derive(Default)]
struct InputRouterState {
    sources: HashMap<String, InputSource>,
    consumers: HashMap<String, InputConsumer>,
}

struct InputConsumer {
    consumer_id: String,
    source_id: String,
    target: String,
    frames: u64,
    callbacks: u64,
    dropped_frames: u64,
    source_channels: usize,
    max_samples: usize,
    buffer: VecDeque<f32>,
}

impl InputRouter {
    pub(crate) fn add_source(&self, source: InputSource) {
        if let Ok(mut state) = self.inner.lock() {
            state.sources.insert(source.source_id.clone(), source);
        }
    }

    pub(crate) fn remove_source(&self, source_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Router de entrada bloqueado.".to_string())?;
        if state
            .consumers
            .values()
            .any(|consumer| consumer.source_id == source_id)
        {
            return Err(format!(
                "Fuente {} tiene consumidores activos; elimina consumidores antes de borrarla.",
                source_id
            ));
        }
        if state.sources.remove(source_id).is_none() {
            return Err(format!("Fuente de entrada no activa: {}", source_id));
        }
        Ok(())
    }

    pub(crate) fn subscribe(
        &self,
        source_id: &str,
        consumer_id: &str,
        target: Option<&str>,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Router de entrada bloqueado.".to_string())?;
        let source = state
            .sources
            .get(source_id)
            .ok_or_else(|| format!("Fuente de entrada no activa: {}", source_id))?;
        let source_channels = source.channel_map.len().max(1);
        let consumer_id = consumer_id.trim();
        if consumer_id.is_empty() {
            return Err("consumer requerido para subscribe.".to_string());
        }
        state.consumers.insert(
            consumer_id.to_string(),
            InputConsumer {
                consumer_id: consumer_id.to_string(),
                source_id: source_id.to_string(),
                target: target.unwrap_or(consumer_id).to_string(),
                frames: 0,
                callbacks: 0,
                dropped_frames: 0,
                source_channels,
                max_samples: DEFAULT_MAX_BUFFER_FRAMES * source_channels,
                buffer: VecDeque::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn unsubscribe(&self, consumer_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Router de entrada bloqueado.".to_string())?;
        if state.consumers.remove(consumer_id).is_none() {
            return Err(format!("Consumidor de entrada no activo: {}", consumer_id));
        }
        Ok(())
    }

    pub(crate) fn drain_consumer(
        &self,
        consumer_id: &str,
        max_frames: usize,
    ) -> Result<DrainedInputPcm, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Router de entrada bloqueado.".to_string())?;
        let consumer = state
            .consumers
            .get_mut(consumer_id)
            .ok_or_else(|| format!("Consumidor de entrada no activo: {}", consumer_id))?;
        let channels = consumer.source_channels.max(1);
        let available_frames = consumer.buffer.len() / channels;
        let frames = available_frames.min(max_frames.max(1));
        let samples_to_drain = frames * channels;
        let mut samples = Vec::with_capacity(samples_to_drain);
        for _ in 0..samples_to_drain {
            if let Some(sample) = consumer.buffer.pop_front() {
                samples.push(sample);
            }
        }
        Ok(DrainedInputPcm {
            consumer: consumer.consumer_id.clone(),
            source_id: consumer.source_id.clone(),
            channels,
            frames,
            remaining_frames: consumer.buffer.len() / channels,
            samples,
        })
    }

    pub(crate) fn has_sources_for_device(&self, device_id: &str) -> bool {
        self.inner
            .lock()
            .map(|state| {
                state
                    .sources
                    .values()
                    .any(|source| source.device_id == device_id)
            })
            .unwrap_or(false)
    }

    pub(crate) fn observe_device(&self, device_id: &str, data: &[f32], capture_channels: u16) {
        let capture_channels = usize::from(capture_channels.max(1));
        let frames = data.len() / capture_channels;
        if frames == 0 {
            return;
        }
        if let Ok(mut state) = self.inner.lock() {
            let sources = state
                .sources
                .values()
                .filter(|source| source.device_id == device_id)
                .cloned()
                .collect::<Vec<_>>();
            for source in sources {
                let source_channels = source.channel_map.len().max(1);
                let mapped = map_source_samples(&source, data, capture_channels, frames);
                for consumer in state
                    .consumers
                    .values_mut()
                    .filter(|consumer| consumer.source_id == source.source_id)
                {
                    consumer.source_channels = source_channels;
                    consumer.callbacks = consumer.callbacks.saturating_add(1);
                    consumer.frames = consumer.frames.saturating_add(frames as u64);
                    push_samples(consumer, &mapped);
                }
            }
        }
    }

    pub(crate) fn sources_json(&self) -> String {
        self.inner
            .lock()
            .map(|state| {
                let mut sources = state.sources.values().collect::<Vec<_>>();
                sources.sort_by(|a, b| a.source_id.cmp(&b.source_id));
                sources
                    .into_iter()
                    .map(|source| source.snapshot_json())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default()
    }

    pub(crate) fn consumers_json(&self) -> String {
        self.inner
            .lock()
            .map(|state| {
                let mut consumers = state.consumers.values().collect::<Vec<_>>();
                consumers.sort_by(|a, b| a.consumer_id.cmp(&b.consumer_id));
                consumers
                    .into_iter()
                    .map(|consumer| consumer.snapshot_json())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default()
    }
}

pub(crate) struct DrainedInputPcm {
    pub(crate) consumer: String,
    pub(crate) source_id: String,
    pub(crate) channels: usize,
    pub(crate) frames: usize,
    pub(crate) remaining_frames: usize,
    samples: Vec<f32>,
}

impl DrainedInputPcm {
    pub(crate) fn data_base64_f32le(&self) -> String {
        let mut bytes = Vec::with_capacity(self.samples.len() * 4);
        for sample in &self.samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    pub(crate) fn peak(&self) -> f32 {
        self.samples
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
    }

    pub(crate) fn rms(&self) -> f32 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let sum = self
            .samples
            .iter()
            .map(|sample| sample * sample)
            .sum::<f32>();
        (sum / self.samples.len() as f32).sqrt()
    }

    pub(crate) fn to_s16le_stereo_bytes(&self) -> Vec<u8> {
        if self.frames == 0 {
            return Vec::new();
        }
        let channels = self.channels.max(1);
        let mut bytes = Vec::with_capacity(self.frames * 2 * 2);
        for frame in 0..self.frames {
            let base = frame * channels;
            let left = self.samples.get(base).copied().unwrap_or_default();
            let right = if channels > 1 {
                self.samples.get(base + 1).copied().unwrap_or(left)
            } else {
                left
            };
            push_s16le(&mut bytes, left);
            push_s16le(&mut bytes, right);
        }
        bytes
    }

    pub(crate) fn to_f32_stereo_samples(&self) -> Vec<f32> {
        if self.frames == 0 {
            return Vec::new();
        }
        let channels = self.channels.max(1);
        let mut samples = Vec::with_capacity(self.frames * 2);
        for frame in 0..self.frames {
            let base = frame * channels;
            let left = self.samples.get(base).copied().unwrap_or_default();
            let right = if channels > 1 {
                self.samples.get(base + 1).copied().unwrap_or(left)
            } else {
                left
            };
            samples.push(left);
            samples.push(right);
        }
        samples
    }
}

fn push_s16le(bytes: &mut Vec<u8>, sample: f32) {
    let clipped = sample.clamp(-1.0, 1.0);
    let value = (clipped * 32767.0) as i16;
    bytes.extend_from_slice(&value.to_le_bytes());
}

impl InputConsumer {
    fn snapshot_json(&self) -> String {
        let buffered_frames = self.buffer.len() / self.source_channels.max(1);
        format!(
            "{{\"consumer\":\"{}\",\"sourceId\":\"{}\",\"target\":\"{}\",\"frames\":{},\"callbacks\":{},\"bufferedFrames\":{},\"droppedFrames\":{}}}",
            escape_json(&self.consumer_id),
            escape_json(&self.source_id),
            escape_json(&self.target),
            self.frames,
            self.callbacks,
            buffered_frames,
            self.dropped_frames
        )
    }
}

fn map_source_samples(
    source: &InputSource,
    data: &[f32],
    capture_channels: usize,
    frames: usize,
) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames * source.channel_map.len().max(1));
    for frame in 0..frames {
        let base = frame * capture_channels;
        for channel in &source.channel_map {
            let sample = data
                .get(base + usize::from(*channel))
                .copied()
                .unwrap_or_default();
            out.push((sample * source.gain).clamp(-1.0, 1.0));
        }
    }
    out
}

fn push_samples(consumer: &mut InputConsumer, samples: &[f32]) {
    consumer.buffer.extend(samples.iter().copied());
    let overflow = consumer.buffer.len().saturating_sub(consumer.max_samples);
    if overflow > 0 {
        for _ in 0..overflow {
            consumer.buffer.pop_front();
        }
        consumer.dropped_frames = consumer
            .dropped_frames
            .saturating_add((overflow / consumer.source_channels.max(1)) as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_pcm_to_subscribed_consumer() {
        let router = InputRouter::default();
        router.add_source(InputSource::create("mic", "input:0", 2, Some(&[0]), Some(2.0)).unwrap());
        router
            .subscribe("mic", "encoder:s1", Some("encoder"))
            .unwrap();
        router.observe_device("input:0", &[0.25, -0.5, 0.5, -0.25], 2);
        let json = router.consumers_json();
        assert!(json.contains("\"frames\":2"));
        assert!(json.contains("\"bufferedFrames\":2"));
        assert!(json.contains("\"callbacks\":1"));
    }

    #[test]
    fn blocks_source_removal_when_consumer_exists() {
        let router = InputRouter::default();
        router.add_source(InputSource::create("mic", "input:0", 1, Some(&[0]), None).unwrap());
        router.subscribe("mic", "recorder:1", None).unwrap();
        let err = router.remove_source("mic").unwrap_err();
        assert!(err.contains("consumidores activos"));
    }

    #[test]
    fn drains_pcm_from_consumer_buffer() {
        let router = InputRouter::default();
        router.add_source(InputSource::create("mic", "input:0", 2, Some(&[0]), None).unwrap());
        router.subscribe("mic", "lab:1", Some("lab")).unwrap();
        router.observe_device("input:0", &[0.25, -0.5, 0.5, -0.25], 2);
        let drained = router.drain_consumer("lab:1", 1).unwrap();
        assert_eq!(drained.frames, 1);
        assert_eq!(drained.channels, 1);
        assert_eq!(drained.remaining_frames, 1);
        assert!(drained.peak() > 0.0);
        assert!(drained.rms() > 0.0);
        assert!(!drained.data_base64_f32le().is_empty());
    }

    #[test]
    fn converts_drained_mono_to_stereo_s16le() {
        let router = InputRouter::default();
        router.add_source(InputSource::create("mic", "input:0", 1, Some(&[0]), None).unwrap());
        router
            .subscribe("mic", "encoder:1", Some("encoder"))
            .unwrap();
        router.observe_device("input:0", &[0.5, -0.5], 1);
        let drained = router.drain_consumer("encoder:1", 2).unwrap();
        let bytes = drained.to_s16le_stereo_bytes();
        assert_eq!(bytes.len(), 8);
        assert_eq!(&bytes[0..2], &bytes[2..4]);
        let samples = drained.to_f32_stereo_samples();
        assert_eq!(samples.len(), 4);
        assert_eq!(samples[0], samples[1]);
    }
}
