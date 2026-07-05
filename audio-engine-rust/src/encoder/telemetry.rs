#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FfmpegTelemetry {
    pub(crate) bitrate_kbps: Option<f32>,
    pub(crate) speed: Option<f32>,
    pub(crate) ffmpeg_time: Option<String>,
}

pub(crate) fn parse_ffmpeg_telemetry(line: &str) -> Option<FfmpegTelemetry> {
    let bitrate_kbps = parse_number_after(line, "bitrate=", "kbits/s");
    let speed = parse_number_after(line, "speed=", "x");
    let ffmpeg_time = parse_token_after(line, "time=");
    if bitrate_kbps.is_none() && speed.is_none() && ffmpeg_time.is_none() {
        return None;
    }
    Some(FfmpegTelemetry {
        bitrate_kbps,
        speed,
        ffmpeg_time,
    })
}

fn parse_number_after(line: &str, prefix: &str, suffix: &str) -> Option<f32> {
    let rest = line.split_once(prefix)?.1.trim_start();
    let raw = rest
        .split_once(suffix)
        .map(|(v, _)| v)
        .unwrap_or(rest)
        .trim();
    raw.parse::<f32>().ok()
}

fn parse_token_after(line: &str, prefix: &str) -> Option<String> {
    let rest = line.split_once(prefix)?.1.trim_start();
    rest.split_whitespace().next().map(|v| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_line() {
        let telemetry = parse_ffmpeg_telemetry(
            "size=  512kB time=00:00:03.12 bitrate= 127.8kbits/s speed=1.02x",
        )
        .unwrap();
        assert_eq!(telemetry.ffmpeg_time.as_deref(), Some("00:00:03.12"));
        assert_eq!(telemetry.bitrate_kbps, Some(127.8));
        assert_eq!(telemetry.speed, Some(1.02));
    }

    #[test]
    fn ignores_non_progress_line() {
        assert!(parse_ffmpeg_telemetry("Input #0, s16le").is_none());
    }
}
