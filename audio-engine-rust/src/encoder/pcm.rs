pub(crate) fn sine_pcm_s16le(
    sample_rate: u32,
    channels: u16,
    duration_ms: u64,
    frequency_hz: f32,
    amplitude: f32,
) -> Vec<u8> {
    let sample_rate = sample_rate.max(1);
    let channels = channels.max(1) as usize;
    let frames = ((sample_rate as u64).saturating_mul(duration_ms) / 1000) as usize;
    let mut bytes = Vec::with_capacity(frames * channels * 2);
    let amp = amplitude.clamp(0.0, 1.0);
    for frame in 0..frames {
        let phase = (frame as f32 * frequency_hz * std::f32::consts::TAU) / sample_rate as f32;
        let sample = (phase.sin() * amp * i16::MAX as f32) as i16;
        for _ in 0..channels {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_expected_byte_count() {
        let pcm = sine_pcm_s16le(44_100, 2, 100, 440.0, 0.1);
        assert_eq!(pcm.len(), 44_100 / 10 * 2 * 2);
    }

    #[test]
    fn clamps_amplitude() {
        let pcm = sine_pcm_s16le(8_000, 1, 10, 440.0, 9.0);
        assert!(!pcm.is_empty());
    }
}
