use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::input::InputConsumerRoute;
use crate::protocol::now_ms;

use super::config::{generate_filename, RecorderConfig, RecorderFormat, RecorderSource};
use super::ffmpeg_output::FfmpegRecorderProcess;
use super::wav::WavWriter;

enum RecorderOutput {
    Wav(WavWriter),
    Ffmpeg(FfmpegRecorderProcess),
}

impl RecorderOutput {
    fn write_pcm(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Wav(w) => w
                .write_pcm_bytes(data)
                .map_err(|e| format!("Error escribiendo WAV: {}", e)),
            Self::Ffmpeg(p) => p.write_pcm(data),
        }
    }

    fn finalize(self) -> Result<u64, String> {
        match self {
            Self::Wav(w) => w
                .finalize()
                .map_err(|e| format!("Error finalizando WAV: {}", e)),
            Self::Ffmpeg(p) => p.finalize(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecorderStatus {
    Recording,
    Stopped,
    Error(String),
}

impl RecorderStatus {
    pub(crate) fn as_str(&self) -> &str {
        match self {
            Self::Recording => "recording",
            Self::Stopped => "stopped",
            Self::Error(_) => "error",
        }
    }
}

pub(crate) struct RecorderSession {
    pub(crate) config: RecorderConfig,
    pub(crate) status: RecorderStatus,
    pub(crate) started_at: u128,
    pub(crate) segment_index: u32,
    pub(crate) segment_started_at: u128,
    pub(crate) total_bytes: u64,
    pub(crate) total_frames: u64,
    pub(crate) current_file: Option<PathBuf>,
    pub(crate) input_routes: Vec<InputConsumerRoute>,
    output: Option<RecorderOutput>,
    playlist_name: Option<String>,
}

#[derive(Default)]
pub(crate) struct RecorderManager {
    pub(crate) sessions: HashMap<String, RecorderSession>,
}

impl RecorderManager {
    pub(crate) fn start(
        &mut self,
        config: RecorderConfig,
        playlist_name: Option<&str>,
    ) -> Result<String, String> {
        let recorder_id = config.recorder_id.clone();

        if self.sessions.contains_key(&recorder_id) {
            self.stop(&recorder_id)?;
        }

        let dir = Path::new(&config.output_dir);
        fs::create_dir_all(dir)
            .map_err(|e| format!("No se pudo crear directorio de grabación: {}", e))?;

        let filename = generate_filename(&config, 0, playlist_name);
        let file_path = dir.join(&filename);

        let output = create_output(&config, &file_path)?;

        let now = now_ms();
        let session = RecorderSession {
            config,
            status: RecorderStatus::Recording,
            started_at: now,
            segment_index: 0,
            segment_started_at: now,
            total_bytes: 0,
            total_frames: 0,
            current_file: Some(file_path),
            input_routes: Vec::new(),
            output: Some(output),
            playlist_name: playlist_name.map(|s| s.to_string()),
        };

        self.sessions.insert(recorder_id.clone(), session);
        Ok(recorder_id)
    }

    pub(crate) fn stop(&mut self, recorder_id: &str) -> Result<RecorderStopResult, String> {
        let session = self
            .sessions
            .remove(recorder_id)
            .ok_or_else(|| format!("Grabación no activa: {}", recorder_id))?;

        let last_file = session.current_file.clone();
        let total_bytes = session.total_bytes;
        let total_frames = session.total_frames;
        let segments = session.segment_index + 1;

        if let Some(output) = session.output {
            let _ = output.finalize();
        }

        Ok(RecorderStopResult {
            recorder_id: recorder_id.to_string(),
            last_file,
            total_bytes,
            total_frames,
            segments,
        })
    }

    pub(crate) fn write_pcm(
        &mut self,
        recorder_id: &str,
        pcm_bytes: &[u8],
        frames: u64,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(recorder_id)
            .ok_or_else(|| format!("Grabación no activa: {}", recorder_id))?;

        if !matches!(session.status, RecorderStatus::Recording) {
            return Ok(());
        }

        if should_split(session) {
            split_segment(session)?;
        }

        if let Some(output) = session.output.as_mut() {
            output.write_pcm(pcm_bytes)?;
        }

        session.total_bytes += pcm_bytes.len() as u64;
        session.total_frames += frames;
        Ok(())
    }

    pub(crate) fn snapshot(&self, recorder_id: &str) -> Option<RecorderSnapshot> {
        let session = self.sessions.get(recorder_id)?;
        let duration_ms = now_ms().saturating_sub(session.started_at) as u64;
        let segment_duration_ms = now_ms().saturating_sub(session.segment_started_at) as u64;
        Some(RecorderSnapshot {
            recorder_id: recorder_id.to_string(),
            status: session.status.as_str().to_string(),
            format: session.config.format.as_str().to_string(),
            sources: session
                .config
                .sources
                .iter()
                .map(|s| s.label().to_string())
                .collect(),
            current_file: session
                .current_file
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            total_bytes: session.total_bytes,
            total_frames: session.total_frames,
            duration_ms,
            segment_index: session.segment_index,
            segment_duration_ms,
            split_seconds: session.config.split_seconds,
        })
    }

    pub(crate) fn all_snapshots(&self) -> Vec<RecorderSnapshot> {
        self.sessions
            .keys()
            .filter_map(|id| self.snapshot(id))
            .collect()
    }

    pub(crate) fn active_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    pub(crate) fn is_active(&self, recorder_id: &str) -> bool {
        self.sessions.contains_key(recorder_id)
    }

    pub(crate) fn set_input_routes(&mut self, recorder_id: &str, routes: Vec<InputConsumerRoute>) {
        if let Some(session) = self.sessions.get_mut(recorder_id) {
            session.input_routes = routes;
        }
    }

    pub(crate) fn get_input_routes(&self, recorder_id: &str) -> Vec<InputConsumerRoute> {
        self.sessions
            .get(recorder_id)
            .map(|s| s.input_routes.clone())
            .unwrap_or_default()
    }

    pub(crate) fn needs_master_tap(&self, recorder_id: &str) -> bool {
        self.sessions
            .get(recorder_id)
            .map(|s| s.config.sources.contains(&RecorderSource::Master))
            .unwrap_or(false)
    }

    pub(crate) fn needs_monitor_tap(&self, recorder_id: &str) -> bool {
        self.sessions
            .get(recorder_id)
            .map(|s| s.config.sources.contains(&RecorderSource::Monitor))
            .unwrap_or(false)
    }

    pub(crate) fn input_device_ids(&self, recorder_id: &str) -> Vec<String> {
        self.sessions
            .get(recorder_id)
            .map(|s| {
                s.config
                    .sources
                    .iter()
                    .filter_map(|source| match source {
                        RecorderSource::Input { device_id } => Some(device_id.clone()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

pub(crate) struct RecorderStopResult {
    pub(crate) recorder_id: String,
    pub(crate) last_file: Option<PathBuf>,
    pub(crate) total_bytes: u64,
    pub(crate) total_frames: u64,
    pub(crate) segments: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct RecorderSnapshot {
    pub(crate) recorder_id: String,
    pub(crate) status: String,
    pub(crate) format: String,
    pub(crate) sources: Vec<String>,
    pub(crate) current_file: Option<String>,
    pub(crate) total_bytes: u64,
    pub(crate) total_frames: u64,
    pub(crate) duration_ms: u64,
    pub(crate) segment_index: u32,
    pub(crate) segment_duration_ms: u64,
    pub(crate) split_seconds: Option<u64>,
}

fn should_split(session: &RecorderSession) -> bool {
    let Some(split_secs) = session.config.split_seconds else {
        return false;
    };
    let elapsed_ms = now_ms().saturating_sub(session.segment_started_at);
    elapsed_ms >= (split_secs as u128) * 1000
}

fn split_segment(session: &mut RecorderSession) -> Result<(), String> {
    if let Some(output) = session.output.take() {
        let _ = output.finalize();
    }

    session.segment_index += 1;
    session.segment_started_at = now_ms();

    let filename = generate_filename(
        &session.config,
        session.segment_index,
        session.playlist_name.as_deref(),
    );
    let file_path = Path::new(&session.config.output_dir).join(&filename);

    let output = create_output(&session.config, &file_path)?;
    session.output = Some(output);
    session.current_file = Some(file_path);
    Ok(())
}

fn create_output(config: &RecorderConfig, path: &Path) -> Result<RecorderOutput, String> {
    match &config.format {
        RecorderFormat::Wav => {
            let writer = WavWriter::create(path, config.sample_rate, config.channels, 16)
                .map_err(|e| format!("No se pudo crear archivo WAV: {}", e))?;
            Ok(RecorderOutput::Wav(writer))
        }
        RecorderFormat::Mp3 { .. } | RecorderFormat::Flac => {
            let proc = FfmpegRecorderProcess::spawn(
                &config.ffmpeg_path,
                &config.format,
                config.sample_rate,
                config.channels,
                path,
            )?;
            Ok(RecorderOutput::Ffmpeg(proc))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::config::{NamingPattern, RecorderFormat, RecorderSource};

    fn test_config(dir: &str) -> RecorderConfig {
        RecorderConfig {
            recorder_id: "test:rec".to_string(),
            sources: vec![RecorderSource::Master],
            format: RecorderFormat::Wav,
            sample_rate: 44100,
            channels: 2,
            output_dir: dir.to_string(),
            naming: NamingPattern::DateTime,
            split_seconds: None,
            pre_roll_seconds: 0,
            ffmpeg_path: "ffmpeg".to_string(),
        }
    }

    #[test]
    fn start_and_stop() {
        let dir = std::env::temp_dir().join("recorder_test_start_stop");
        let _ = fs::remove_dir_all(&dir);
        let mut mgr = RecorderManager::default();
        let id = mgr.start(test_config(dir.to_str().unwrap()), None).unwrap();
        assert_eq!(id, "test:rec");
        assert!(mgr.is_active("test:rec"));

        let result = mgr.stop("test:rec").unwrap();
        assert_eq!(result.recorder_id, "test:rec");
        assert!(!mgr.is_active("test:rec"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pcm_accumulates() {
        let dir = std::env::temp_dir().join("recorder_test_write");
        let _ = fs::remove_dir_all(&dir);
        let mut mgr = RecorderManager::default();
        mgr.start(test_config(dir.to_str().unwrap()), None).unwrap();

        let pcm = vec![0u8; 1764]; // ~10ms at 44100/stereo/16bit
        mgr.write_pcm("test:rec", &pcm, 441).unwrap();
        mgr.write_pcm("test:rec", &pcm, 441).unwrap();

        let snap = mgr.snapshot("test:rec").unwrap();
        assert_eq!(snap.total_bytes, 3528);
        assert_eq!(snap.total_frames, 882);

        mgr.stop("test:rec").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn needs_source_detection() {
        let dir = std::env::temp_dir().join("recorder_test_sources");
        let _ = fs::remove_dir_all(&dir);
        let mut config = test_config(dir.to_str().unwrap());
        config.sources = vec![
            RecorderSource::Master,
            RecorderSource::Monitor,
            RecorderSource::Input {
                device_id: "mic1".to_string(),
            },
        ];
        let mut mgr = RecorderManager::default();
        mgr.start(config, None).unwrap();

        assert!(mgr.needs_master_tap("test:rec"));
        assert!(mgr.needs_monitor_tap("test:rec"));
        assert_eq!(mgr.input_device_ids("test:rec"), vec!["mic1".to_string()]);

        mgr.stop("test:rec").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
