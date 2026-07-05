use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::protocol::escape_json;

#[derive(Clone)]
pub(crate) struct InputMeter {
    frames: Arc<AtomicU64>,
    callbacks: Arc<AtomicU64>,
    peak_bits: Arc<AtomicU32>,
    rms_bits: Arc<AtomicU32>,
    last_error: Arc<Mutex<String>>,
}

impl Default for InputMeter {
    fn default() -> Self {
        Self {
            frames: Arc::new(AtomicU64::new(0)),
            callbacks: Arc::new(AtomicU64::new(0)),
            peak_bits: Arc::new(AtomicU32::new(0.0_f32.to_bits())),
            rms_bits: Arc::new(AtomicU32::new(0.0_f32.to_bits())),
            last_error: Arc::new(Mutex::new(String::new())),
        }
    }
}

impl InputMeter {
    pub(crate) fn observe_f32(&self, data: &[f32], channels: u16) {
        let channels = usize::from(channels.max(1));
        let frames = (data.len() / channels) as u64;
        let mut peak = 0.0_f32;
        let mut sum = 0.0_f64;
        for sample in data {
            let value = sample.clamp(-1.0, 1.0);
            let abs = value.abs();
            peak = peak.max(abs);
            sum += f64::from(value * value);
        }
        let rms = if data.is_empty() {
            0.0
        } else {
            (sum / data.len() as f64).sqrt() as f32
        };
        self.frames.fetch_add(frames, Ordering::Relaxed);
        self.callbacks.fetch_add(1, Ordering::Relaxed);
        self.peak_bits.store(peak.to_bits(), Ordering::Relaxed);
        self.rms_bits.store(rms.to_bits(), Ordering::Relaxed);
    }

    pub(crate) fn set_error(&self, message: &str) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = message.to_string();
        }
    }

    pub(crate) fn snapshot_json(&self) -> String {
        let peak = f32::from_bits(self.peak_bits.load(Ordering::Relaxed));
        let rms = f32::from_bits(self.rms_bits.load(Ordering::Relaxed));
        let last_error = self
            .last_error
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        format!(
            "\"frames\":{},\"callbacks\":{},\"peak\":{},\"rms\":{},\"peakDb\":{},\"rmsDb\":{},\"lastError\":\"{}\"",
            self.frames.load(Ordering::Relaxed),
            self.callbacks.load(Ordering::Relaxed),
            peak,
            rms,
            amp_to_db(peak),
            amp_to_db(rms),
            escape_json(&last_error)
        )
    }
}

fn amp_to_db(value: f32) -> f32 {
    if value <= 0.000_001 {
        -120.0
    } else {
        (20.0 * value.log10()).max(-120.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_peak_and_frames() {
        let meter = InputMeter::default();
        meter.observe_f32(&[0.0, 0.5, -0.25, 0.25], 2);
        let json = meter.snapshot_json();
        assert!(json.contains("\"frames\":2"));
        assert!(json.contains("\"callbacks\":1"));
        assert!(json.contains("\"peak\":0.5"));
    }
}
