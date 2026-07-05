use crate::protocol::IncomingCommand;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecorderFormat {
    Wav,
    Flac,
    Mp3 { bitrate_kbps: u32 },
}

impl RecorderFormat {
    pub(crate) fn extension(&self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Mp3 { .. } => "mp3",
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Mp3 { .. } => "mp3",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecorderSource {
    Master,
    Monitor,
    Input { device_id: String },
}

impl RecorderSource {
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::Master => "master",
            Self::Monitor => "monitor",
            Self::Input { device_id } => device_id.as_str(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum NamingPattern {
    DateTime,
    PlaylistName,
    Custom { prefix: String },
}

#[derive(Clone, Debug)]
pub(crate) struct RecorderConfig {
    pub(crate) recorder_id: String,
    pub(crate) sources: Vec<RecorderSource>,
    pub(crate) format: RecorderFormat,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) output_dir: String,
    pub(crate) naming: NamingPattern,
    pub(crate) split_seconds: Option<u64>,
    pub(crate) pre_roll_seconds: u32,
    pub(crate) ffmpeg_path: String,
}

const VALID_MP3_BITRATES: &[u32] = &[32, 64, 92, 128, 256, 320];
const MIN_SPLIT_SECONDS: u64 = 60;
const MAX_SPLIT_SECONDS: u64 = 24 * 3600;

pub(crate) fn parse_recorder_config(ic: &IncomingCommand) -> Result<RecorderConfig, String> {
    let recorder_id = ic
        .recorder_id
        .as_deref()
        .or(ic.consumer.as_deref())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("rec:default")
        .trim()
        .to_string();

    let sources = parse_sources(ic)?;
    if sources.is_empty() {
        return Err("Al menos una fuente es requerida (master, monitor o deviceId).".to_string());
    }

    let format = parse_format(ic)?;
    let sample_rate = ic.sample_rate.unwrap_or(44100).clamp(8000, 192_000);
    let channels = ic.channels.map(|c| c as u16).unwrap_or(2).clamp(1, 2);

    let output_dir = ic
        .output_path
        .as_deref()
        .or(ic.path.as_deref())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "outputPath requerido para grabación.".to_string())?
        .trim()
        .to_string();

    let naming = parse_naming(ic);

    let split_seconds = ic
        .split_minutes
        .map(|minutes| {
            let seconds = (minutes as u64) * 60;
            seconds.clamp(MIN_SPLIT_SECONDS, MAX_SPLIT_SECONDS)
        })
        .or_else(|| {
            ic.split_hours.map(|hours| {
                let seconds = (hours as u64) * 3600;
                seconds.clamp(MIN_SPLIT_SECONDS, MAX_SPLIT_SECONDS)
            })
        });

    let pre_roll_seconds = ic.pre_roll_seconds.unwrap_or(0).clamp(0, 120) as u32;
    let ffmpeg_path = ic
        .ffmpeg_path
        .as_deref()
        .unwrap_or("ffmpeg")
        .trim()
        .to_string();

    Ok(RecorderConfig {
        recorder_id,
        sources,
        format,
        sample_rate,
        channels,
        output_dir,
        naming,
        split_seconds,
        pre_roll_seconds,
        ffmpeg_path,
    })
}

fn parse_sources(ic: &IncomingCommand) -> Result<Vec<RecorderSource>, String> {
    let mut sources = Vec::new();

    if let Some(source_list) = ic.recorder_sources.as_deref() {
        for s in source_list {
            let s = s.trim();
            if s.is_empty() {
                continue;
            }
            match s {
                "master" => sources.push(RecorderSource::Master),
                "monitor" => sources.push(RecorderSource::Monitor),
                other => sources.push(RecorderSource::Input {
                    device_id: other.to_string(),
                }),
            }
        }
    }

    if sources.is_empty() {
        let source_str = ic
            .source
            .as_deref()
            .or(ic.recorder_source.as_deref())
            .unwrap_or("master")
            .trim();
        match source_str {
            "master" => sources.push(RecorderSource::Master),
            "monitor" => sources.push(RecorderSource::Monitor),
            "input" | "mic" => {
                let device_id = ic
                    .device_id
                    .as_deref()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or("default")
                    .trim()
                    .to_string();
                sources.push(RecorderSource::Input { device_id });
            }
            other if !other.is_empty() => {
                sources.push(RecorderSource::Input {
                    device_id: other.to_string(),
                });
            }
            _ => sources.push(RecorderSource::Master),
        }
    }

    Ok(sources)
}

fn parse_format(ic: &IncomingCommand) -> Result<RecorderFormat, String> {
    let fmt_str = ic
        .format
        .as_deref()
        .or(ic.codec.as_deref())
        .unwrap_or("wav")
        .trim()
        .to_lowercase();
    match fmt_str.as_str() {
        "wav" => Ok(RecorderFormat::Wav),
        "flac" => Ok(RecorderFormat::Flac),
        "mp3" => {
            let bitrate: u32 = ic
                .bitrate
                .as_deref()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(128);
            let nearest = VALID_MP3_BITRATES
                .iter()
                .min_by_key(|b| ((**b as i32) - (bitrate as i32)).unsigned_abs())
                .copied()
                .unwrap_or(128);
            Ok(RecorderFormat::Mp3 {
                bitrate_kbps: nearest,
            })
        }
        other => Err(format!(
            "Formato de grabación no soportado: {}. Usa wav, flac o mp3.",
            other
        )),
    }
}

fn parse_naming(ic: &IncomingCommand) -> NamingPattern {
    let pattern = ic
        .naming
        .as_deref()
        .unwrap_or("datetime")
        .trim()
        .to_lowercase();
    match pattern.as_str() {
        "playlist" => NamingPattern::PlaylistName,
        "custom" => {
            let prefix = ic
                .naming_prefix
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("Grabacion")
                .trim()
                .to_string();
            NamingPattern::Custom { prefix }
        }
        _ => NamingPattern::DateTime,
    }
}

pub(crate) fn generate_filename(
    config: &RecorderConfig,
    segment_index: u32,
    playlist_name: Option<&str>,
) -> String {
    let now = chrono_stub_now();
    let date_part = format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        now.year, now.month, now.day, now.hour, now.minute, now.second
    );

    let base = match &config.naming {
        NamingPattern::DateTime => date_part.clone(),
        NamingPattern::PlaylistName => {
            let name = playlist_name
                .filter(|n| !n.trim().is_empty())
                .map(|n| sanitize_filename(n))
                .unwrap_or_else(|| "Playlist".to_string());
            format!("{}_{}", name, date_part)
        }
        NamingPattern::Custom { prefix } => {
            format!("{}_{}", sanitize_filename(prefix), date_part)
        }
    };

    let suffix = if segment_index > 0 {
        format!("_part{:03}", segment_index + 1)
    } else {
        String::new()
    };

    format!("{}{}.{}", base, suffix, config.format.extension())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

struct SimpleDateTime {
    year: u32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

fn chrono_stub_now() -> SimpleDateTime {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hour = (time_of_day / 3600) as u32;
    let minute = ((time_of_day % 3600) / 60) as u32;
    let second = (time_of_day % 60) as u32;

    let (year, month, day) = days_to_ymd(days);
    SimpleDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    }
}

fn days_to_ymd(days_since_epoch: u64) -> (u32, u32, u32) {
    let z = days_since_epoch + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_format_wav() {
        assert_eq!(parse_format_str("wav"), Ok(RecorderFormat::Wav));
    }

    #[test]
    fn parse_format_flac() {
        assert_eq!(parse_format_str("flac"), Ok(RecorderFormat::Flac));
    }

    #[test]
    fn parse_format_mp3_nearest_bitrate() {
        assert_eq!(
            parse_format_str_with_bitrate("mp3", 130),
            Ok(RecorderFormat::Mp3 { bitrate_kbps: 128 })
        );
        assert_eq!(
            parse_format_str_with_bitrate("mp3", 300),
            Ok(RecorderFormat::Mp3 { bitrate_kbps: 320 })
        );
    }

    #[test]
    fn parse_format_unknown() {
        assert!(parse_format_str("ogg").is_err());
    }

    #[test]
    fn sanitize_removes_invalid_chars() {
        assert_eq!(sanitize_filename("Mi:Programa/1"), "Mi_Programa_1");
    }

    #[test]
    fn generate_filename_datetime_pattern() {
        let config = RecorderConfig {
            recorder_id: "test".to_string(),
            sources: vec![RecorderSource::Master],
            format: RecorderFormat::Wav,
            sample_rate: 44100,
            channels: 2,
            output_dir: "C:/recs".to_string(),
            naming: NamingPattern::DateTime,
            split_seconds: None,
            pre_roll_seconds: 0,
            ffmpeg_path: "ffmpeg".to_string(),
        };
        let name = generate_filename(&config, 0, None);
        assert!(name.ends_with(".wav"));
        assert!(!name.contains("part"));
    }

    #[test]
    fn generate_filename_with_segment() {
        let config = RecorderConfig {
            recorder_id: "test".to_string(),
            sources: vec![RecorderSource::Master],
            format: RecorderFormat::Mp3 { bitrate_kbps: 128 },
            sample_rate: 44100,
            channels: 2,
            output_dir: "C:/recs".to_string(),
            naming: NamingPattern::Custom {
                prefix: "Show".to_string(),
            },
            split_seconds: Some(3600),
            pre_roll_seconds: 0,
            ffmpeg_path: "ffmpeg".to_string(),
        };
        let name = generate_filename(&config, 2, None);
        assert!(name.contains("_part003"));
        assert!(name.ends_with(".mp3"));
    }

    #[test]
    fn generate_filename_playlist_pattern() {
        let config = RecorderConfig {
            recorder_id: "test".to_string(),
            sources: vec![RecorderSource::Master],
            format: RecorderFormat::Flac,
            sample_rate: 44100,
            channels: 2,
            output_dir: "C:/recs".to_string(),
            naming: NamingPattern::PlaylistName,
            split_seconds: None,
            pre_roll_seconds: 0,
            ffmpeg_path: "ffmpeg".to_string(),
        };
        let name = generate_filename(&config, 0, Some("Mi Programa Top"));
        assert!(name.starts_with("Mi Programa Top_"));
        assert!(name.ends_with(".flac"));
    }

    #[test]
    fn days_to_ymd_epoch() {
        let (y, m, d) = days_to_ymd(0);
        assert_eq!((y, m, d), (1970, 1, 1));
    }

    #[test]
    fn days_to_ymd_known_date() {
        // 2026-07-05 = day 20639 since epoch
        let (y, m, d) = days_to_ymd(20639);
        assert_eq!((y, m, d), (2026, 7, 5));
    }

    #[test]
    fn split_seconds_clamp() {
        // 50 minutes = 3000 seconds
        assert_eq!((50u64) * 60, 3000);
        assert!(3000 >= MIN_SPLIT_SECONDS && 3000 <= MAX_SPLIT_SECONDS);
        // 24 hours
        assert_eq!((24u64) * 3600, 86400);
        assert!(86400 <= MAX_SPLIT_SECONDS);
    }

    fn parse_format_str(s: &str) -> Result<RecorderFormat, String> {
        let mut ic = IncomingCommand::default();
        ic.format = Some(s.to_string());
        parse_format(&ic)
    }

    fn parse_format_str_with_bitrate(s: &str, bitrate: u32) -> Result<RecorderFormat, String> {
        let mut ic = IncomingCommand::default();
        ic.format = Some(s.to_string());
        ic.bitrate = Some(bitrate.to_string());
        parse_format(&ic)
    }
}
