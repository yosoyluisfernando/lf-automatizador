// Cadena DSP del program_mixer: procesamiento de audio en tiempo real.
//
// Submódulos:
// - dynamic.rs — DynamicDspSource: EQ (8 bandas biquad) + compresor + limiter,
//                con orden dinámico configurable en caliente via atómicos.
// - fader.rs   — FaderSource: ganancia atómica para master/monitor, cero locks.
// - tee.rs     — MultiTeeSource + DualTapConsumerSource: bifurcación de señal
//                via rtrb rings para monitor y encoder.
//
// Todos los parámetros se controlan via DspParams (AtomicU32 con f32-in-bits).
// El hilo de audio lee con Relaxed; el dispatch IPC escribe con Relaxed.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8};

mod dynamic;
mod fader;
mod tee;

pub(crate) use dynamic::DynamicDspSource;
pub(crate) use fader::{FaderGainField, FaderSource};
pub(crate) use tee::{DualTapConsumerSource, MultiTeeSource, TeeTap};

/// Parámetros atómicos del DSP, compartidos entre el hilo de audio y el dispatch.
/// Cada campo es un AtomicU32 que almacena un f32 codificado como bits.
pub(crate) struct DspParams {
    pub(crate) master_gain_bits: AtomicU32,
    pub(crate) monitor_gain_bits: AtomicU32,
    pub(crate) preamp_db_bits: AtomicU32,
    pub(crate) pan_bits: AtomicU32,
    pub(crate) mono_wet_target_bits: AtomicU32,
    pub(crate) eq_wet_target_bits: AtomicU32,
    pub(crate) comp_wet_target_bits: AtomicU32,
    pub(crate) limiter_wet_target_bits: AtomicU32,
    pub(crate) eq_bands: [EqBandAtomic; 8],
    pub(crate) comp_threshold_db_bits: AtomicU32,
    pub(crate) comp_ratio_bits: AtomicU32,
    pub(crate) comp_attack_ms_bits: AtomicU32,
    pub(crate) comp_release_ms_bits: AtomicU32,
    pub(crate) comp_knee_db_bits: AtomicU32,
    pub(crate) comp_makeup_db_bits: AtomicU32,
    pub(crate) limiter_ceiling_db_bits: AtomicU32,
    pub(crate) limiter_release_ms_bits: AtomicU32,
    pub(crate) encoder_tap_mode: AtomicU8,
    pub(crate) monitor_tap_mode: AtomicU8,
    pub(crate) fx_order: AtomicU32,
    pub(crate) dsp_ready: AtomicBool,
    pub(crate) encoder_tap_active: AtomicBool,
}

pub(crate) struct EqBandAtomic {
    pub(crate) freq_hz_bits: AtomicU32,
    pub(crate) q_bits: AtomicU32,
    pub(crate) gain_db_bits: AtomicU32,
}

impl EqBandAtomic {
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
            mono_wet_target_bits: AtomicU32::new(0.0_f32.to_bits()),
            eq_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            comp_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            limiter_wet_target_bits: AtomicU32::new(1.0_f32.to_bits()),
            eq_bands,
            comp_threshold_db_bits: AtomicU32::new((-20.0_f32).to_bits()),
            comp_ratio_bits: AtomicU32::new(3.0_f32.to_bits()),
            comp_attack_ms_bits: AtomicU32::new(30.0_f32.to_bits()),
            comp_release_ms_bits: AtomicU32::new(800.0_f32.to_bits()),
            comp_knee_db_bits: AtomicU32::new(6.0_f32.to_bits()),
            comp_makeup_db_bits: AtomicU32::new(9.0_f32.to_bits()),
            limiter_ceiling_db_bits: AtomicU32::new((-2.0_f32).to_bits()),
            limiter_release_ms_bits: AtomicU32::new(100.0_f32.to_bits()),
            encoder_tap_mode: AtomicU8::new(1),
            monitor_tap_mode: AtomicU8::new(1),
            fx_order: AtomicU32::new(0 | (1 << 2) | (2 << 4)),
            dsp_ready: AtomicBool::new(false),
            encoder_tap_active: AtomicBool::new(false),
        }
    }
}

#[allow(dead_code)]
pub(super) struct EncoderTapBuffer {
    pub(super) producer: Option<rtrb::Producer<f32>>,
    pub(super) consumer: Option<rtrb::Consumer<f32>>,
    pub(super) sample_rate: AtomicU32,
    pub(super) channels: AtomicU8,
}

impl EncoderTapBuffer {
    #[allow(dead_code)]
    pub(super) fn new(capacity: usize) -> Self {
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(capacity);
        Self {
            producer: Some(producer),
            consumer: Some(consumer),
            sample_rate: AtomicU32::new(44100),
            channels: AtomicU8::new(2),
        }
    }
}

#[allow(dead_code)]
pub(super) struct BusGraph {
    pub(super) pgm_sink_id: String,
    pub(super) monitor_sink_id: Option<String>,
    pub(super) encoder_tap: std::sync::Arc<EncoderTapBuffer>,
    pub(super) dsp_params: std::sync::Arc<DspParams>,
}

#[derive(Default, Clone)]
pub(super) struct BiquadChannel {
    pub(super) x1: f32,
    pub(super) x2: f32,
    pub(super) y1: f32,
    pub(super) y2: f32,
}

impl BiquadChannel {
    #[inline]
    pub(super) fn process(&mut self, x: f32, b0: f32, b1: f32, b2: f32, a1: f32, a2: f32) -> f32 {
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

pub(super) struct EqBand {
    pub(super) l: BiquadChannel,
    pub(super) r: BiquadChannel,
    pub(super) b0: f32,
    pub(super) b1: f32,
    pub(super) b2: f32,
    pub(super) a1: f32,
    pub(super) a2: f32,
}

impl EqBand {
    pub(super) fn new() -> Self {
        Self {
            l: BiquadChannel::default(),
            r: BiquadChannel::default(),
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    pub(super) fn update_coeffs(&mut self, freq_hz: f32, q: f32, gain_db: f32, sample_rate: f32) {
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
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }
}
