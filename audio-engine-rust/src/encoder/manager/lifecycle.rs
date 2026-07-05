use super::super::error::{EncoderError, EncoderErrorCategory};
use super::super::process::FfmpegProcessSpec;
use super::super::shoutcast_transport::EncoderTransport;
use super::super::telemetry::parse_ffmpeg_telemetry;
use super::{normalize_server_id, EncoderManager};

impl EncoderManager {
    pub(crate) fn start_process(
        &mut self,
        server_id: &str,
        mode: &str,
        spec: &FfmpegProcessSpec,
    ) -> Result<u32, EncoderError> {
        let server_id = normalize_server_id(server_id);
        let _ = self.stop_process(&server_id);
        let process = spec
            .spawn()
            .map_err(|message| EncoderError::new(&message, EncoderErrorCategory::Server, false))?;
        let pid = process.id();
        self.processes.insert(server_id.clone(), process);
        self.set_status(&server_id, "connecting", mode, "")?;
        Ok(pid)
    }

    pub(crate) fn start_shoutcast_process(
        &mut self,
        server_id: &str,
        spec: &FfmpegProcessSpec,
        transport: EncoderTransport,
    ) -> Result<u32, EncoderError> {
        let server_id = normalize_server_id(server_id);
        let _ = self.stop_process(&server_id);
        let mode = transport.mode();
        let process = spec
            .spawn()
            .map_err(|message| EncoderError::new(&message, EncoderErrorCategory::Server, false))?;
        let pid = process.id();
        self.processes.insert(server_id.clone(), process);
        self.encoder_transports.insert(server_id.clone(), transport);
        self.set_status(&server_id, "connecting", mode, "")?;
        Ok(pid)
    }

    pub(crate) fn stop_process(&mut self, server_id: &str) -> Result<(), EncoderError> {
        let server_id = normalize_server_id(server_id);
        if let Some(mut process) = self.processes.remove(&server_id) {
            if process
                .try_wait_code()
                .map_err(|message| {
                    EncoderError::new(&message, EncoderErrorCategory::Server, false)
                })?
                .is_none()
            {
                process.kill().map_err(|message| {
                    EncoderError::new(&message, EncoderErrorCategory::Server, false)
                })?;
            }
        }
        if let Some(mut transport) = self.encoder_transports.remove(&server_id) {
            transport.terminate();
        }
        self.set_status(&server_id, "disconnected", "", "")
    }

    pub(crate) fn poll_process(&mut self, server_id: &str) -> Result<Option<i32>, EncoderError> {
        let server_id = normalize_server_id(server_id);
        let Some(process) = self.processes.get_mut(&server_id) else {
            return Ok(None);
        };
        let telemetry_lines = process.drain_stderr_lines();
        let code = process
            .try_wait_code()
            .map_err(|message| EncoderError::new(&message, EncoderErrorCategory::Server, false))?;
        for line in telemetry_lines {
            if let Some(telemetry) = parse_ffmpeg_telemetry(&line) {
                self.apply_telemetry(&server_id, telemetry);
            }
        }
        self.flush_shoutcast_stdout(&server_id)?;
        if code.is_some() {
            self.processes.remove(&server_id);
            if let Some(mut transport) = self.encoder_transports.remove(&server_id) {
                transport.terminate();
            }
            self.set_status(&server_id, "disconnected", "", "")?;
        }
        Ok(code)
    }

    pub(crate) fn poll_all_processes(&mut self) {
        let ids = self.processes.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let _ = self.poll_process(&id);
        }
    }

    pub(crate) fn write_pcm(
        &mut self,
        server_id: &str,
        bytes: &[u8],
    ) -> Result<usize, EncoderError> {
        let server_id = normalize_server_id(server_id);
        let Some(process) = self.processes.get_mut(&server_id) else {
            return Err(EncoderError::new(
                "No hay proceso encoder activo para este servidor.",
                EncoderErrorCategory::Server,
                false,
            ));
        };
        let written = process
            .write_stdin(bytes)
            .map_err(|message| EncoderError::new(&message, EncoderErrorCategory::Server, true))?;
        if let Some(server) = self.servers.get_mut(&server_id) {
            server.pcm_bytes = server.pcm_bytes.saturating_add(written as u64);
            server.pcm_chunks = server.pcm_chunks.saturating_add(1);
            server.updated_at = crate::protocol::now_ms();
        }
        Ok(written)
    }

    pub(crate) fn active_server_ids(&self) -> Vec<String> {
        self.processes.keys().cloned().collect()
    }

    fn flush_shoutcast_stdout(&mut self, server_id: &str) -> Result<(), EncoderError> {
        if !self.encoder_transports.contains_key(server_id) {
            return Ok(());
        }
        let chunks = self
            .processes
            .get_mut(server_id)
            .map(|process| process.drain_stdout_chunks())
            .unwrap_or_default();
        if chunks.is_empty() {
            return Ok(());
        }
        let mut sent_total = 0usize;
        let write_result = {
            let Some(transport) = self.encoder_transports.get_mut(server_id) else {
                return Ok(());
            };
            let mut result = Ok(());
            for chunk in chunks {
                match transport.write_encoded(&chunk) {
                    Ok(sent) => sent_total = sent_total.saturating_add(sent),
                    Err(err) => {
                        result = Err(err);
                        break;
                    }
                }
            }
            result
        };
        if let Err(err) = write_result {
            if let Some(mut transport) = self.encoder_transports.remove(server_id) {
                transport.terminate();
            }
            self.set_status(
                server_id,
                "error",
                "encoder-transport",
                &err.to_operator_message(),
            )?;
            return Err(err);
        }
        if let Some(server) = self.servers.get_mut(server_id) {
            if server.status == super::status::EncoderServerStatus::Connecting {
                server.status = super::status::EncoderServerStatus::Live;
            }
            server.bitrate_kbps = server.bitrate_kbps.max(0.0);
            server.updated_at = crate::protocol::now_ms();
            server.message = if sent_total > 0 {
                String::new()
            } else {
                server.message.clone()
            };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::process::ProcessStream;

    #[test]
    fn starts_and_polls_short_lived_process() {
        let current_exe = std::env::current_exe().unwrap();
        let spec = FfmpegProcessSpec::test_process(current_exe.to_string_lossy().as_ref());
        let mut manager = EncoderManager::default();
        let pid = manager.start_process("srv", "test", &spec).unwrap();
        assert!(pid > 0);
        assert!(manager
            .snapshot_json()
            .contains("\"status\":\"connecting\""));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if manager.poll_process("srv").unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "proceso de prueba no termino"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(manager.snapshot_json(), "");
    }

    #[test]
    fn writes_pcm_to_process_stdin() {
        let spec = stdin_sink_process();
        let mut manager = EncoderManager::default();
        manager.start_process("srv", "test", &spec).unwrap();
        let written = manager.write_pcm("srv", &[1, 2, 3, 4, 5, 6]).unwrap();
        assert_eq!(written, 6);
        let snapshot = manager.snapshot_json();
        assert!(snapshot.contains("\"pcmBytes\":6"));
        assert!(snapshot.contains("\"pcmChunks\":1"));
        manager.stop_process("srv").unwrap();
    }

    #[cfg(windows)]
    fn stdin_sink_process() -> FfmpegProcessSpec {
        FfmpegProcessSpec {
            program: "cmd".to_string(),
            args: vec!["/C".to_string(), "more > NUL".to_string()],
            stdin: ProcessStream::Pipe,
            stdout: ProcessStream::Ignore,
            stderr: ProcessStream::Ignore,
        }
    }

    #[cfg(not(windows))]
    fn stdin_sink_process() -> FfmpegProcessSpec {
        FfmpegProcessSpec {
            program: "sh".to_string(),
            args: vec!["-c".to_string(), "cat >/dev/null".to_string()],
            stdin: ProcessStream::Pipe,
            stdout: ProcessStream::Ignore,
            stderr: ProcessStream::Ignore,
        }
    }
}
