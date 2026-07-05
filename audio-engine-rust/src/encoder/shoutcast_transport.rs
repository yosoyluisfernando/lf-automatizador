use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use super::config::EncoderServerConfig;
use super::error::{EncoderError, EncoderErrorCategory};
use super::shoutcast::{
    parse_handshake_response, ShoutcastHandshakePlan, ShoutcastHandshakeResult,
};
use super::ultravox_transport::UltravoxTransport;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const IO_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug)]
pub(crate) struct ShoutcastTransport {
    stream: TcpStream,
    bytes_sent: u64,
}

#[derive(Debug)]
pub(crate) enum EncoderTransport {
    Shoutcast(ShoutcastTransport),
    Ultravox(UltravoxTransport),
}

impl EncoderTransport {
    pub(crate) fn mode(&self) -> &'static str {
        match self {
            Self::Shoutcast(_) => "shoutcast-native",
            Self::Ultravox(_) => "ultravox-native",
        }
    }

    pub(crate) fn write_encoded(&mut self, bytes: &[u8]) -> Result<usize, EncoderError> {
        match self {
            Self::Shoutcast(transport) => transport.write_encoded(bytes),
            Self::Ultravox(transport) => transport.write_encoded(bytes),
        }
    }

    pub(crate) fn terminate(&mut self) {
        if let Self::Ultravox(transport) = self {
            transport.terminate();
        }
    }
}

impl ShoutcastTransport {
    pub(crate) fn connect(config: &EncoderServerConfig) -> Result<Self, EncoderError> {
        let plan = ShoutcastHandshakePlan::from_config(config);
        Self::connect_plan(&plan)
    }

    fn connect_plan(plan: &ShoutcastHandshakePlan) -> Result<Self, EncoderError> {
        let address = format!("{}:{}", plan.host, plan.port);
        let socket_addr = address
            .to_socket_addrs()
            .map_err(|_| EncoderError::config("Host o puerto SHOUTcast invalido."))?
            .next()
            .ok_or_else(|| EncoderError::config("Host o puerto SHOUTcast invalido."))?;
        let mut stream =
            TcpStream::connect_timeout(&socket_addr, CONNECT_TIMEOUT).map_err(|err| {
                EncoderError::new(
                    &format!("No se pudo conectar al servidor SHOUTcast: {}", err),
                    EncoderErrorCategory::Server,
                    false,
                )
            })?;
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
        stream.write_all(&plan.initial_bytes).map_err(write_error)?;
        wait_for_acceptance(&mut stream, plan)?;
        if !plan.post_ok_bytes.is_empty() {
            stream.write_all(&plan.post_ok_bytes).map_err(write_error)?;
        }
        Ok(Self {
            stream,
            bytes_sent: 0,
        })
    }

    pub(crate) fn write_encoded(&mut self, bytes: &[u8]) -> Result<usize, EncoderError> {
        self.stream.write_all(bytes).map_err(write_error)?;
        self.bytes_sent = self.bytes_sent.saturating_add(bytes.len() as u64);
        Ok(bytes.len())
    }
}

fn wait_for_acceptance(
    stream: &mut TcpStream,
    plan: &ShoutcastHandshakePlan,
) -> Result<(), EncoderError> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut response = String::new();
    let mut buffer = [0u8; 512];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => {
                return Err(EncoderError::new(
                    "El servidor SHOUTcast cerro la conexion durante el handshake.",
                    EncoderErrorCategory::Server,
                    true,
                ));
            }
            Ok(read) => {
                response.push_str(&String::from_utf8_lossy(&buffer[..read]));
                match parse_handshake_response(plan.mode, &response) {
                    ShoutcastHandshakeResult::Accepted => return Ok(()),
                    ShoutcastHandshakeResult::Rejected(message) => {
                        return Err(EncoderError::new(
                            &format!("Servidor SHOUTcast rechazo la transmision: {}", message),
                            EncoderErrorCategory::Auth,
                            false,
                        ));
                    }
                    ShoutcastHandshakeResult::Pending => {}
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(err) => {
                return Err(EncoderError::new(
                    &format!("Error leyendo respuesta SHOUTcast: {}", err),
                    EncoderErrorCategory::Server,
                    true,
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(EncoderError::new(
                "Timeout esperando aceptacion SHOUTcast.",
                EncoderErrorCategory::Server,
                true,
            ));
        }
    }
}

fn write_error(err: std::io::Error) -> EncoderError {
    EncoderError::new(
        &format!("No se pudo escribir al servidor SHOUTcast: {}", err),
        EncoderErrorCategory::Server,
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::config::EncoderServerConfig;
    use crate::protocol::IncomingCommand;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn config(port: u16) -> EncoderServerConfig {
        let json = format!(
            r#"{{"serverType":"shoutcast","ip":"127.0.0.1","port":"{}","password":"secret","codec":"mp3","bitrate":"96","icyName":"Radio"}}"#,
            port
        );
        let cmd = IncomingCommand::parse(&json).unwrap();
        EncoderServerConfig::from_command(&cmd).unwrap()
    }

    #[test]
    fn icy_legacy_transport_sends_headers_then_audio() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut first = [0u8; 8];
            socket.read_exact(&mut first).unwrap();
            socket.write_all(b"OK2\r\n").unwrap();
            let mut buffer = [0u8; 256];
            let mut received = Vec::new();
            while !String::from_utf8_lossy(&received).contains("audio-bytes") {
                let read = socket.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
            }
            tx.send(String::from_utf8_lossy(&received).to_string())
                .unwrap();
        });

        let cfg = config(port);
        let mut transport = ShoutcastTransport::connect(&cfg).unwrap();
        transport.write_encoded(b"audio-bytes").unwrap();
        let received = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(received.contains("icy-name:Radio"));
        assert!(received.contains("audio-bytes"));
    }
}
