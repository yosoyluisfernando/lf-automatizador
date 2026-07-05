use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use super::ffmpeg::{FfmpegMode, FfmpegPlan};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProcessStream {
    Ignore,
    Pipe,
}

impl ProcessStream {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Ignore => "ignore",
            Self::Pipe => "pipe",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FfmpegProcessSpec {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) stdin: ProcessStream,
    pub(crate) stdout: ProcessStream,
    pub(crate) stderr: ProcessStream,
}

impl FfmpegProcessSpec {
    pub(crate) fn from_plan(ffmpeg_path: &str, plan: FfmpegPlan) -> Self {
        let stdout = match plan.mode {
            FfmpegMode::Icecast | FfmpegMode::LocalNull => ProcessStream::Ignore,
            FfmpegMode::ShoutcastPipe | FfmpegMode::UltravoxPipe => ProcessStream::Pipe,
        };
        Self {
            program: if ffmpeg_path.trim().is_empty() {
                "ffmpeg".to_string()
            } else {
                ffmpeg_path.to_string()
            },
            args: plan.args,
            stdin: ProcessStream::Pipe,
            stdout,
            stderr: ProcessStream::Pipe,
        }
    }

    pub(crate) fn spawn(&self) -> Result<ManagedProcess, String> {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        command.stdin(to_stdio(&self.stdin));
        command.stdout(to_stdio(&self.stdout));
        command.stderr(to_stdio(&self.stderr));
        command
            .spawn()
            .map(|mut child| {
                let stdout_rx = child.stdout.take().map(spawn_stdout_reader);
                let stderr_rx = child.stderr.take().map(spawn_stderr_reader);
                ManagedProcess {
                    child,
                    stdout_rx,
                    stderr_rx,
                }
            })
            .map_err(|err| format!("No se pudo iniciar proceso encoder: {}", err))
    }

    #[cfg(test)]
    pub(crate) fn test_process(program: &str) -> Self {
        Self {
            program: program.to_string(),
            args: vec!["--help".to_string()],
            stdin: ProcessStream::Ignore,
            stdout: ProcessStream::Ignore,
            stderr: ProcessStream::Ignore,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ManagedProcess {
    child: Child,
    #[allow(dead_code)]
    stdout_rx: Option<Receiver<Vec<u8>>>,
    stderr_rx: Option<Receiver<String>>,
}

impl ManagedProcess {
    pub(crate) fn id(&self) -> u32 {
        self.child.id()
    }

    pub(crate) fn try_wait_code(&mut self) -> Result<Option<i32>, String> {
        self.child
            .try_wait()
            .map(|status| status.map(|s| s.code().unwrap_or(-1)))
            .map_err(|err| format!("No se pudo consultar proceso encoder: {}", err))
    }

    pub(crate) fn kill(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .map_err(|err| format!("No se pudo detener proceso encoder: {}", err))
    }

    pub(crate) fn write_stdin(&mut self, bytes: &[u8]) -> Result<usize, String> {
        let Some(stdin) = self.child.stdin.as_mut() else {
            return Err("Proceso encoder no tiene stdin disponible.".to_string());
        };
        stdin
            .write_all(bytes)
            .map_err(|err| format!("No se pudo escribir PCM al encoder: {}", err))?;
        Ok(bytes.len())
    }

    pub(crate) fn drain_stderr_lines(&mut self) -> Vec<String> {
        let Some(rx) = self.stderr_rx.as_ref() else {
            return Vec::new();
        };
        let mut lines = Vec::new();
        while let Ok(line) = rx.try_recv() {
            lines.push(line);
        }
        lines
    }

    #[allow(dead_code)]
    pub(crate) fn drain_stdout_chunks(&mut self) -> Vec<Vec<u8>> {
        let Some(rx) = self.stdout_rx.as_ref() else {
            return Vec::new();
        };
        let mut chunks = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            chunks.push(chunk);
        }
        chunks
    }
}

fn spawn_stdout_reader(mut stdout: std::process::ChildStdout) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            match stdout.read(&mut bytes) {
                Ok(0) => break,
                Ok(read) => {
                    if tx.send(bytes[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    rx
}

fn spawn_stderr_reader(stderr: std::process::ChildStderr) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = [0u8; 4096];
        let mut pending = String::new();
        loop {
            match stderr.read(&mut bytes) {
                Ok(0) => break,
                Ok(read) => {
                    pending.push_str(&String::from_utf8_lossy(&bytes[..read]));
                    for line in drain_complete_stderr_segments(&mut pending) {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let tail = pending.trim();
        if !tail.is_empty() {
            let _ = tx.send(tail.to_string());
        }
    });
    rx
}

fn drain_complete_stderr_segments(buffer: &mut String) -> Vec<String> {
    let mut segments = Vec::new();
    while let Some((idx, separator_len)) = buffer
        .char_indices()
        .find_map(|(idx, ch)| (ch == '\r' || ch == '\n').then_some((idx, ch.len_utf8())))
    {
        let segment = buffer[..idx].trim();
        if !segment.is_empty() {
            segments.push(segment.to_string());
        }
        buffer.drain(..idx + separator_len);
    }
    segments
}

fn to_stdio(stream: &ProcessStream) -> Stdio {
    match stream {
        ProcessStream::Ignore => Stdio::null(),
        ProcessStream::Pipe => Stdio::piped(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::config::EncoderServerConfig;
    use crate::encoder::ffmpeg::FfmpegPlan;
    use crate::protocol::IncomingCommand;

    fn spec(json: &str) -> FfmpegProcessSpec {
        let cmd = IncomingCommand::parse(json).unwrap();
        let config = EncoderServerConfig::from_command(&cmd).unwrap();
        FfmpegProcessSpec::from_plan("ffmpeg", FfmpegPlan::from_config(&config))
    }

    #[test]
    fn icecast_ignores_stdout() {
        let spec = spec(
            r#"{"serverType":"icecast","ip":"host","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        );
        assert_eq!(spec.stdout, ProcessStream::Ignore);
        assert_eq!(spec.stdin, ProcessStream::Pipe);
        assert_eq!(spec.stderr, ProcessStream::Pipe);
    }

    #[test]
    fn ultravox_pipes_stdout() {
        let spec = spec(
            r#"{"serverType":"shoutcast2","ip":"host","port":"8000","password":"secret","mount":"1","codec":"aac","bitrate":"128"}"#,
        );
        assert_eq!(spec.stdout, ProcessStream::Pipe);
        assert!(spec.args.contains(&"pipe:1".to_string()));
    }

    #[test]
    fn can_spawn_and_observe_short_lived_process() {
        let current_exe = std::env::current_exe().unwrap();
        let spec = FfmpegProcessSpec::test_process(current_exe.to_string_lossy().as_ref());
        let mut process = spec.spawn().unwrap();
        assert!(process.id() > 0);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if process.try_wait_code().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "proceso de prueba no termino"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn drains_stdout_chunks_when_stream_is_piped() {
        let spec = stdout_test_process();
        let mut process = spec.spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut output = Vec::new();
        loop {
            for chunk in process.drain_stdout_chunks() {
                output.extend(chunk);
            }
            if process.try_wait_code().unwrap().is_some() {
                for chunk in process.drain_stdout_chunks() {
                    output.extend(chunk);
                }
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "proceso stdout de prueba no termino"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(String::from_utf8_lossy(&output).contains("lf-stdout-ok"));
    }

    #[cfg(windows)]
    fn stdout_test_process() -> FfmpegProcessSpec {
        FfmpegProcessSpec {
            program: "cmd".to_string(),
            args: vec!["/C".to_string(), "echo lf-stdout-ok".to_string()],
            stdin: ProcessStream::Ignore,
            stdout: ProcessStream::Pipe,
            stderr: ProcessStream::Ignore,
        }
    }

    #[cfg(not(windows))]
    fn stdout_test_process() -> FfmpegProcessSpec {
        FfmpegProcessSpec {
            program: "sh".to_string(),
            args: vec!["-c".to_string(), "printf lf-stdout-ok".to_string()],
            stdin: ProcessStream::Ignore,
            stdout: ProcessStream::Pipe,
            stderr: ProcessStream::Ignore,
        }
    }

    #[test]
    fn stderr_segments_split_on_carriage_return_progress() {
        let mut buffer = String::from(
            "size=0kB time=N/A speed=N/A\rsize=15kB time=00:00:00.91 bitrate=131.9kbits/s speed=1.7x\rpartial",
        );
        let segments = drain_complete_stderr_segments(&mut buffer);
        assert_eq!(segments.len(), 2);
        assert!(segments[1].contains("time=00:00:00.91"));
        assert_eq!(buffer, "partial");
    }
}
