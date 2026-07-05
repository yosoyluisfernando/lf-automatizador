// Análisis de picos de forma de onda y caché de duración de audio.
//
// El frontend necesita dos cosas antes de mostrar un waveform:
// 1. La duración del archivo (para calcular la escala temporal).
// 2. Los picos min/max en N bins (para pintar la onda).
//
// Ambos cálculos requieren decodificar el archivo completo, así que se cachean
// en disco con FNV hash + mtime como clave de invalidación.
//
// - `compute_waveform_peaks` — decodifica, agrupa en chunks de 1024 frames,
//   reduce a `target_bins` bins, detecta silencios de inicio/fin, y cachea.
// - `cached_audio_duration_ms` — devuelve la duración en ms, con caché .dur.
// - `measure_audio_duration_full` — decodificación completa si no hay metadata.

use std::fs::File;
use std::io::Write;

use rodio::Decoder;
use rodio::Source;

/// Hash FNV-1a de 64 bits (rápido, no criptográfico). Usado para nombres de caché.
pub(crate) fn fnv_hash(s: &str) -> u64 {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h = h.wrapping_mul(1099511628211);
        h ^= b as u64;
    }
    h
}

/// Serializa un slice de f32 como array JSON con 5 decimales.
pub(crate) fn floats_to_json(v: &[f32]) -> String {
    let mut s = String::with_capacity(v.len() * 9);
    s.push('[');
    for (i, val) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
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
    let Ok(mut f) = std::fs::File::create(cache_path) else {
        return;
    };
    let _ = writeln!(
        f,
        "v1 {} {} {:.4} {:.4} {}",
        sample_rate,
        duration_ms,
        silence_start,
        silence_end,
        min.len()
    );
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
    if parts.len() < 6 || parts[0] != "v1" {
        return None;
    }
    let sample_rate: u32 = parts[1].parse().ok()?;
    let duration_ms: u64 = parts[2].parse().ok()?;
    let silence_start: f32 = parts[3].parse().ok()?;
    let silence_end: f32 = parts[4].parse().ok()?;
    let bins: usize = parts[5].parse().ok()?;
    let min_line = lines.next()?;
    let max_line = lines.next()?;
    let min: Vec<f32> = min_line
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    let max: Vec<f32> = max_line
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    if min.len() != bins || max.len() != bins {
        return None;
    }
    Some((
        min,
        max,
        duration_ms,
        sample_rate,
        silence_start,
        silence_end,
    ))
}

/// Devuelve el mtime del archivo en segundos UNIX (0 si falla).
pub(crate) fn file_mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mide la duración decodificando el archivo completo (fallback si no hay metadata).
pub(crate) fn measure_audio_duration_full(path: &str) -> u64 {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    let Ok(decoder) = Decoder::try_from(file) else {
        return 0;
    };
    match decoder.total_duration() {
        Some(d) => d.as_millis() as u64,
        None => {
            let sr = decoder.sample_rate().get() as u64;
            let ch = decoder.channels().get() as u64;
            let samples = decoder.count() as u64;
            if sr > 0 && ch > 0 {
                (samples / ch) * 1000 / sr
            } else {
                0
            }
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
    if parts.len() < 2 || parts[0] != "v1" {
        return None;
    }
    parts[1].parse().ok()
}

/// Devuelve la duración en ms, usando caché en disco si cache_dir no está vacío.
pub(crate) fn cached_audio_duration_ms(path: &str, cache_dir: &str) -> u64 {
    let cache_dir_clean = cache_dir.trim_end_matches(['/', '\\']);
    if cache_dir_clean.is_empty() {
        return measure_audio_duration_full(path);
    }
    let cache_path = format!(
        "{}/{:016x}_{}.dur",
        cache_dir_clean,
        fnv_hash(path),
        file_mtime_secs(path)
    );
    if let Some(ms) = load_duration_cache(&cache_path) {
        return ms;
    }
    let measured = measure_audio_duration_full(path);
    if measured > 0 {
        save_duration_cache(&cache_path, measured);
    }
    measured
}

/// Calcula picos min/max en `target_bins` bins, con detección de silencios
/// de inicio/fin y caché en disco. Devuelve (min, max, duration_ms, sample_rate,
/// silence_start_s, silence_end_s).
pub(crate) fn compute_waveform_peaks(
    path: &str,
    target_bins: usize,
    cache_dir: &str,
) -> Result<(Vec<f32>, Vec<f32>, u64, u32, f32, f32), String> {
    let cache_path = if !cache_dir.is_empty() {
        let hash = fnv_hash(path);
        let mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let cache_dir_clean = cache_dir.trim_end_matches(['/', '\\']);
        Some(format!(
            "{}/{:016x}_{}_b{}.peaks",
            cache_dir_clean, hash, mtime, target_bins
        ))
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
    let sample_rate: u32 = decoder.sample_rate().get();
    let channels = decoder.channels().get() as usize;

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
            if sample < cur_min {
                cur_min = sample;
            }
            if sample > cur_max {
                cur_max = sample;
            }
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

    let duration_ms = if sample_rate > 0 {
        (total_frames * 1000) / sample_rate as u64
    } else {
        0
    };
    let total_chunks = chunk_mins.len();

    let actual_bins = target_bins.min(total_chunks).max(1);
    let mut min_peaks = vec![1.0f32; actual_bins];
    let mut max_peaks = vec![-1.0f32; actual_bins];
    for bin in 0..actual_bins {
        let start_c = (bin * total_chunks) / actual_bins;
        let end_c = (((bin + 1) * total_chunks) / actual_bins)
            .min(total_chunks)
            .max(start_c + 1);
        for c in start_c..end_c {
            if c < total_chunks {
                if chunk_mins[c] < min_peaks[bin] {
                    min_peaks[bin] = chunk_mins[c];
                }
                if chunk_maxs[c] > max_peaks[bin] {
                    max_peaks[bin] = chunk_maxs[c];
                }
            }
        }
    }

    let thresh_start = 10.0f32.powf(-38.0 / 20.0);
    let thresh_end = 10.0f32.powf(-30.0 / 20.0);
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
            silence_end_frames =
                ((i as u64 + 1 + guard_chunks as u64) * CHUNK_FRAMES as u64).min(total_frames);
            break;
        }
    }
    let silence_start_s = if sample_rate > 0 {
        silence_start_frames as f32 / sample_rate as f32
    } else {
        0.0
    };
    let silence_end_s = if sample_rate > 0 {
        silence_end_frames as f32 / sample_rate as f32
    } else {
        0.0
    };

    if let Some(ref cp) = cache_path {
        save_peaks_cache(
            cp,
            &min_peaks,
            &max_peaks,
            duration_ms,
            sample_rate,
            silence_start_s,
            silence_end_s,
        );
    }

    Ok((
        min_peaks,
        max_peaks,
        duration_ms,
        sample_rate,
        silence_start_s,
        silence_end_s,
    ))
}
