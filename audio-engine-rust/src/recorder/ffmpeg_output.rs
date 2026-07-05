use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use super::config::RecorderFormat;

pub(crate) struct FfmpegRecorderProcess {
    child: Child,
    bytes_written: u64,
}

impl FfmpegRecorderProcess {
    pub(crate) fn spawn(
        ffmpeg_path: &str,
        format: &RecorderFormat,
        sample_rate: u32,
        channels: u16,
        output_path: &Path,
    ) -> Result<Self, String> {
        let program = if ffmpeg_path.trim().is_empty() {
            "ffmpeg"
        } else {
            ffmpeg_path.trim()
        };

        let args = build_args(format, sample_rate, channels, output_path);

        let child = Command::new(program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo iniciar FFmpeg para grabación: {}", e))?;

        Ok(Self {
            child,
            bytes_written: 0,
        })
    }

    pub(crate) fn write_pcm(&mut self, data: &[u8]) -> Result<(), String> {
        let Some(stdin) = self.child.stdin.as_mut() else {
            return Err("FFmpeg recorder no tiene stdin.".to_string());
        };
        stdin
            .write_all(data)
            .map_err(|e| format!("Error escribiendo PCM a FFmpeg recorder: {}", e))?;
        self.bytes_written += data.len() as u64;
        Ok(())
    }

    pub(crate) fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    pub(crate) fn finalize(mut self) -> Result<u64, String> {
        let written = self.bytes_written;
        drop(self.child.stdin.take());
        let _ = self.child.wait();
        Ok(written)
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for FfmpegRecorderProcess {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

fn build_args(
    format: &RecorderFormat,
    sample_rate: u32,
    channels: u16,
    output_path: &Path,
) -> Vec<String> {
    let mut args = Vec::new();

    // Global flags
    args.push("-y".to_string());
    args.push("-hide_banner".to_string());
    args.push("-loglevel".to_string());
    args.push("warning".to_string());

    // Input: raw PCM from stdin
    args.push("-f".to_string());
    args.push("s16le".to_string());
    args.push("-ar".to_string());
    args.push(sample_rate.to_string());
    args.push("-ac".to_string());
    args.push(channels.to_string());
    args.push("-i".to_string());
    args.push("pipe:0".to_string());

    // Output codec
    match format {
        RecorderFormat::Mp3 { bitrate_kbps } => {
            args.push("-codec:a".to_string());
            args.push("libmp3lame".to_string());
            args.push("-b:a".to_string());
            args.push(format!("{}k", bitrate_kbps));
            args.push("-id3v2_version".to_string());
            args.push("3".to_string());
        }
        RecorderFormat::Flac => {
            args.push("-codec:a".to_string());
            args.push("flac".to_string());
            args.push("-sample_fmt".to_string());
            args.push("s16".to_string());
            args.push("-compression_level".to_string());
            args.push("5".to_string());
        }
        RecorderFormat::Wav => {
            args.push("-codec:a".to_string());
            args.push("pcm_s16le".to_string());
        }
    }

    // Output file
    let path_str = output_path.to_string_lossy().to_string();
    args.push(path_str);

    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn build_mp3_args() {
        let format = RecorderFormat::Mp3 { bitrate_kbps: 128 };
        let path = PathBuf::from("C:/recs/test.mp3");
        let args = build_args(&format, 44100, 2, &path);
        assert!(args.contains(&"libmp3lame".to_string()));
        assert!(args.contains(&"128k".to_string()));
        assert!(args.contains(&"pipe:0".to_string()));
        assert!(args.contains(&"44100".to_string()));
    }

    #[test]
    fn build_flac_args() {
        let format = RecorderFormat::Flac;
        let path = PathBuf::from("C:/recs/test.flac");
        let args = build_args(&format, 48000, 2, &path);
        assert!(args.contains(&"flac".to_string()));
        assert!(args.contains(&"48000".to_string()));
        assert!(args.contains(&"s16".to_string()));
    }

    #[test]
    fn build_wav_args() {
        let format = RecorderFormat::Wav;
        let path = PathBuf::from("C:/recs/test.wav");
        let args = build_args(&format, 44100, 1, &path);
        assert!(args.contains(&"pcm_s16le".to_string()));
        assert!(args.contains(&"1".to_string()));
    }
}
