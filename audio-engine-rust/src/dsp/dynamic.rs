// DynamicDspSource — orden dinámico de bloques DSP.
//
// Una única Source que procesa por par estéreo (L, R) y aplica 3 bloques
// atómicos en el orden que dicta `params.fx_order`:
//
//   Bloque 0 — EQ-meta: PreAmp + Pan + Mono + 8 biquads peaking (atrapados en
//              el switch global `eq_wet_target_bits`, con sub-rampa para Mono).
//   Bloque 1 — Compressor (AGC) con envelope follower + ratio + makeup.
//   Bloque 2 — Limiter de protección hard clip.
//
// El atómico `fx_order` se lee UNA vez por par estéreo (no por sample) para
// garantizar que ambos canales pasen por los mismos bloques en el mismo orden
// — sin esto, un reorder a mitad de un par dejaría L y R en bloques distintos.
//
// El Iterator emite samples uno a uno (L, R, L, R, ...). El estado `pending_r`
// guarda el R ya procesado entre llamadas consecutivas. Cero locks, cero
// alocaciones — listo para hot path.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, Sample, SampleRate, Source};

use super::{DspParams, EqBand};

/// Paso de rampa wet/dry del módulo EQ. 256 samples ≈ 5.8 ms @ 44.1 kHz —
/// imperceptible al oído pero suficiente para evitar clic al activar/desactivar.
const EQ_MODULE_RAMP_INCREMENT: f32 = 1.0 / 256.0;
const EQ_COEFFS_REFRESH_SAMPLES: u32 = 1024; // ~12 ms
const COMPRESSOR_RAMP_INCREMENT: f32 = 1.0 / 256.0;
const COMPRESSOR_REFRESH_SAMPLES: u32 = 1024; // ~12 ms
const LIMITER_RAMP_INCREMENT: f32 = 1.0 / 256.0;
const LIMITER_CEILING_REFRESH_SAMPLES: u32 = 1024; // ~12 ms

pub(crate) struct DynamicDspSource<S>
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
    pub(crate) fn new(source: S, params: Arc<DspParams>) -> Self {
        let sample_rate = source.sample_rate().get() as f32;
        let channels = source.channels().get() as usize;

        let initial_eq_wet =
            f32::from_bits(params.eq_wet_target_bits.load(Ordering::Relaxed)).clamp(0.0, 1.0);
        let initial_mono_intent =
            f32::from_bits(params.mono_wet_target_bits.load(Ordering::Relaxed)).clamp(0.0, 1.0);
        let initial_comp_wet =
            f32::from_bits(params.comp_wet_target_bits.load(Ordering::Relaxed)).clamp(0.0, 1.0);
        let initial_lim_wet =
            f32::from_bits(params.limiter_wet_target_bits.load(Ordering::Relaxed)).clamp(0.0, 1.0);

        let mut me = Self {
            source,
            params,
            sample_rate,
            channels: channels.max(1),
            pending_r: None,
            eq_meta_wet_actual: initial_eq_wet,
            mono_wet_actual: initial_eq_wet * initial_mono_intent,
            eq_bands: [
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
                EqBand::new(),
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
            let gain_db =
                f32::from_bits(self.params.eq_bands[i].gain_db_bits.load(Ordering::Relaxed));
            self.eq_bands[i].update_coeffs(freq, q, gain_db, self.sample_rate);
        }
    }

    #[inline]
    fn advance_eq_wet(&mut self) {
        let target =
            f32::from_bits(self.params.eq_wet_target_bits.load(Ordering::Relaxed)).clamp(0.0, 1.0);
        if self.eq_meta_wet_actual < target {
            self.eq_meta_wet_actual =
                (self.eq_meta_wet_actual + EQ_MODULE_RAMP_INCREMENT).min(target);
        } else if self.eq_meta_wet_actual > target {
            self.eq_meta_wet_actual =
                (self.eq_meta_wet_actual - EQ_MODULE_RAMP_INCREMENT).max(target);
        }
        let mono_intent = f32::from_bits(self.params.mono_wet_target_bits.load(Ordering::Relaxed))
            .clamp(0.0, 1.0);
        let mono_target = self.eq_meta_wet_actual * mono_intent;
        if self.mono_wet_actual < mono_target {
            self.mono_wet_actual =
                (self.mono_wet_actual + EQ_MODULE_RAMP_INCREMENT).min(mono_target);
        } else if self.mono_wet_actual > mono_target {
            self.mono_wet_actual =
                (self.mono_wet_actual - EQ_MODULE_RAMP_INCREMENT).max(mono_target);
        }
    }

    #[inline]
    fn read_preamp_linear(&self) -> f32 {
        let db =
            f32::from_bits(self.params.preamp_db_bits.load(Ordering::Relaxed)).clamp(-24.0, 24.0);
        10f32.powf(db / 20.0)
    }

    #[inline]
    fn read_pan_gains(&self) -> (f32, f32) {
        // Ley balance lineal: pan=0 → (1.0, 1.0) unity perfecto.
        let pan = f32::from_bits(self.params.pan_bits.load(Ordering::Relaxed)).clamp(-1.0, 1.0);
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
            let b0 = band.b0;
            let b1 = band.b1;
            let b2 = band.b2;
            let a1 = band.a1;
            let a2 = band.a2;
            l_eq = band.l.process(l_eq, b0, b1, b2, a1, a2);
            r_eq = band.r.process(r_eq, b0, b1, b2, a1, a2);
        }
        let out_l = l * dry + l_eq * wet;
        let out_r = r * dry + r_eq * wet;
        (out_l, out_r)
    }

    // ── Compressor helpers ───────────────────────────────────────────────

    fn refresh_comp_params(&mut self) {
        let threshold_db =
            f32::from_bits(self.params.comp_threshold_db_bits.load(Ordering::Relaxed))
                .clamp(-60.0, 0.0);
        let ratio =
            f32::from_bits(self.params.comp_ratio_bits.load(Ordering::Relaxed)).clamp(1.0, 20.0);
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
                0 => {
                    let (nl, nr) = self.process_eq_block(l, r);
                    l = nl;
                    r = nr;
                }
                1 => {
                    let (nl, nr) = self.process_comp_block(l, r);
                    l = nl;
                    r = nr;
                }
                2 => {
                    let (nl, nr) = self.process_lim_block(l, r);
                    l = nl;
                    r = nr;
                }
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
