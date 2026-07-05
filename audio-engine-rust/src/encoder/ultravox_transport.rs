use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use super::codec_frames::{CodecFrameAccumulator, CodecFrameKind};
use super::config::{EncoderCodec, EncoderServerConfig};
use super::error::{EncoderError, EncoderErrorCategory};
use super::ultravox::{
    encode_control_frame, encode_uvox_frame, encrypt_xtea_hex, UltravoxFrame, UltravoxParser,
    AACP_DATA, AAC_LC_DATA, AUTHENTICATE, ICY_GENRE, ICY_NAME, ICY_PUBLIC, ICY_URL,
    MAX_UVOX_PAYLOAD, MP3_DATA, NEGOTIATE_BUFFER, NEGOTIATE_PAYLOAD, REQUEST_CIPHER, SETUP,
    SET_MIME, STANDBY, TERMINATE,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug)]
pub(crate) struct UltravoxTransport {
    stream: TcpStream,
    audio: CodecFrameAccumulator,
    data_type: u16,
    max_payload: usize,
    bytes_sent: u64,
}

impl UltravoxTransport {
    pub(crate) fn connect(config: &EncoderServerConfig) -> Result<Self, EncoderError> {
        let mut stream = connect_tcp(config)?;
        let mut parser = UltravoxParser::default();
        stream
            .write_all(&encode_control_frame(REQUEST_CIPHER, "2.1"))
            .map_err(write_error)?;
        let cipher = expect_ack(&mut stream, &mut parser, REQUEST_CIPHER)?
            .first()
            .cloned()
            .unwrap_or_default();
        let sid = config.mount.trim();
        let sid = if sid.is_empty() { "1" } else { sid };
        let user = encrypt_xtea_hex(&config.user.chars().take(8).collect::<String>(), &cipher);
        let password = encrypt_xtea_hex(&config.password, &cipher);
        stream
            .write_all(&encode_control_frame(
                AUTHENTICATE,
                &format!("2.1:{}:{}:{}", sid, user, password),
            ))
            .map_err(write_error)?;
        let auth_parts = expect_ack(&mut stream, &mut parser, AUTHENTICATE)?;
        if !auth_parts.iter().any(|part| part == "Allow") {
            return Err(EncoderError::new(
                "SHOUTcast2 Ultravox autenticacion rechazada.",
                EncoderErrorCategory::Auth,
                false,
            ));
        }
        let (mime, data_type, frame_kind) = codec_details(config);
        let mut max_payload = MAX_UVOX_PAYLOAD;
        let bitrate = config.bitrate_kbps.saturating_mul(1000);
        let messages = [
            (SET_MIME, mime.to_string()),
            (SETUP, format!("{}:{}", bitrate, bitrate)),
            (NEGOTIATE_BUFFER, "32768:8192".to_string()),
            (NEGOTIATE_PAYLOAD, format!("{}:1024", MAX_UVOX_PAYLOAD)),
            (ICY_NAME, config.icy_name.clone()),
            (ICY_GENRE, config.icy_genre.clone()),
            (ICY_URL, config.icy_url.clone()),
            (
                ICY_PUBLIC,
                if config.icy_public { "1" } else { "0" }.to_string(),
            ),
        ];
        for (frame_type, text) in messages {
            stream
                .write_all(&encode_control_frame(frame_type, &text))
                .map_err(write_error)?;
            let parts = expect_ack(&mut stream, &mut parser, frame_type)?;
            if frame_type == NEGOTIATE_PAYLOAD {
                if let Some(value) = parts.first().and_then(|part| part.parse::<usize>().ok()) {
                    max_payload = value.clamp(1, MAX_UVOX_PAYLOAD);
                }
            }
        }
        stream
            .write_all(&encode_uvox_frame(STANDBY, &[]))
            .map_err(write_error)?;
        let standby = expect_frame(&mut stream, &mut parser, STANDBY)?;
        if !standby
            .text
            .to_ascii_lowercase()
            .contains("data transfer mode")
        {
            return Err(EncoderError::new(
                "SHOUTcast2 Ultravox no entro en modo transferencia.",
                EncoderErrorCategory::Server,
                false,
            ));
        }
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
        Ok(Self {
            stream,
            audio: CodecFrameAccumulator::new(frame_kind),
            data_type,
            max_payload,
            bytes_sent: 0,
        })
    }

    pub(crate) fn write_encoded(&mut self, bytes: &[u8]) -> Result<usize, EncoderError> {
        let frames = self.audio.push(bytes);
        let mut payload = Vec::new();
        let mut sent = 0usize;
        for frame in frames {
            if frame.len() > self.max_payload {
                return Err(EncoderError::new(
                    "SHOUTcast2 Ultravox: frame de audio excede payload negociado.",
                    EncoderErrorCategory::Codec,
                    false,
                ));
            }
            if !payload.is_empty() && payload.len() + frame.len() > self.max_payload {
                self.write_payload(&payload)?;
                sent = sent.saturating_add(payload.len());
                payload.clear();
            }
            payload.extend_from_slice(&frame);
        }
        if !payload.is_empty() {
            self.write_payload(&payload)?;
            sent = sent.saturating_add(payload.len());
        }
        self.bytes_sent = self.bytes_sent.saturating_add(sent as u64);
        Ok(sent)
    }

    pub(crate) fn terminate(&mut self) {
        let _ = self.stream.write_all(&encode_uvox_frame(TERMINATE, &[]));
    }

    fn write_payload(&mut self, payload: &[u8]) -> Result<(), EncoderError> {
        self.stream
            .write_all(&encode_uvox_frame(self.data_type, payload))
            .map_err(write_error)
    }
}

fn connect_tcp(config: &EncoderServerConfig) -> Result<TcpStream, EncoderError> {
    let address = format!("{}:{}", config.host, config.port);
    let socket_addr = address
        .to_socket_addrs()
        .map_err(|_| EncoderError::config("Host o puerto SHOUTcast2 invalido."))?
        .next()
        .ok_or_else(|| EncoderError::config("Host o puerto SHOUTcast2 invalido."))?;
    let stream = TcpStream::connect_timeout(&socket_addr, CONNECT_TIMEOUT).map_err(|err| {
        EncoderError::new(
            &format!("No se pudo conectar al servidor SHOUTcast2: {}", err),
            EncoderErrorCategory::Server,
            false,
        )
    })?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
    Ok(stream)
}

fn expect_ack(
    stream: &mut TcpStream,
    parser: &mut UltravoxParser,
    expected_type: u16,
) -> Result<Vec<String>, EncoderError> {
    let frame = expect_frame(stream, parser, expected_type)?;
    if frame.text.to_ascii_uppercase().starts_with("NAK") {
        return Err(EncoderError::new(
            &format!("SHOUTcast2 Ultravox rechazo: {}", frame.text),
            EncoderErrorCategory::Auth,
            false,
        ));
    }
    if !frame.text.to_ascii_uppercase().starts_with("ACK") {
        return Err(EncoderError::new(
            "SHOUTcast2 Ultravox: ACK invalido.",
            EncoderErrorCategory::Server,
            false,
        ));
    }
    Ok(frame
        .text
        .split(':')
        .skip(1)
        .map(str::to_string)
        .collect::<Vec<_>>())
}

fn expect_frame(
    stream: &mut TcpStream,
    parser: &mut UltravoxParser,
    expected_type: u16,
) -> Result<UltravoxFrame, EncoderError> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut buffer = [0u8; 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => {
                return Err(EncoderError::new(
                    "SHOUTcast2 Ultravox: servidor cerro conexion durante handshake.",
                    EncoderErrorCategory::Server,
                    true,
                ));
            }
            Ok(read) => {
                for frame in parser.push(&buffer[..read]) {
                    if frame.frame_type != expected_type {
                        return Err(EncoderError::new(
                            "SHOUTcast2 Ultravox: respuesta fuera de secuencia.",
                            EncoderErrorCategory::Server,
                            false,
                        ));
                    }
                    return Ok(frame);
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(err) => {
                return Err(EncoderError::new(
                    &format!("Error leyendo respuesta Ultravox: {}", err),
                    EncoderErrorCategory::Server,
                    true,
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(EncoderError::new(
                "Timeout esperando respuesta SHOUTcast2 Ultravox.",
                EncoderErrorCategory::Server,
                true,
            ));
        }
    }
}

fn codec_details(config: &EncoderServerConfig) -> (&'static str, u16, CodecFrameKind) {
    match config.codec {
        EncoderCodec::Mp3 => ("audio/mpeg", MP3_DATA, CodecFrameKind::Mp3),
        EncoderCodec::Aac => ("audio/aac", AAC_LC_DATA, CodecFrameKind::Aac),
        EncoderCodec::AacHe => ("audio/aacp", AACP_DATA, CodecFrameKind::Aac),
    }
}

fn write_error(err: std::io::Error) -> EncoderError {
    EncoderError::new(
        &format!("No se pudo escribir al servidor SHOUTcast2: {}", err),
        EncoderErrorCategory::Server,
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(codec: EncoderCodec) -> EncoderServerConfig {
        EncoderServerConfig {
            server_id: "1".to_string(),
            server_type: super::super::config::ServerType::Shoutcast2,
            host: "127.0.0.1".to_string(),
            port: 8000,
            admin_port: None,
            user: "source".to_string(),
            password: "pass".to_string(),
            mount: "1".to_string(),
            codec,
            bitrate_kbps: 128,
            legacy: false,
            icy_name: "Test".to_string(),
            icy_genre: "Variado".to_string(),
            icy_url: String::new(),
            icy_public: false,
            capture_format: "pcm_s16le".to_string(),
            sample_rate: 44100,
        }
    }

    #[test]
    fn codec_details_mp3() {
        let cfg = test_config(EncoderCodec::Mp3);
        let (mime, data_type, _) = codec_details(&cfg);
        assert_eq!(mime, "audio/mpeg");
        assert_eq!(data_type, MP3_DATA);
    }

    #[test]
    fn codec_details_aac() {
        let cfg = test_config(EncoderCodec::Aac);
        let (mime, data_type, _) = codec_details(&cfg);
        assert_eq!(mime, "audio/aac");
        assert_eq!(data_type, AAC_LC_DATA);
    }

    #[test]
    fn codec_details_aac_he() {
        let cfg = test_config(EncoderCodec::AacHe);
        let (mime, data_type, _) = codec_details(&cfg);
        assert_eq!(mime, "audio/aacp");
        assert_eq!(data_type, AACP_DATA);
    }

    #[test]
    fn write_error_is_retryable() {
        let err = write_error(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "broken",
        ));
        assert_eq!(err.category, EncoderErrorCategory::Server);
        assert!(err.retryable);
    }
}
