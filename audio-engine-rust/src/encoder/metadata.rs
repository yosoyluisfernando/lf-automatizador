use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use base64::Engine;

use super::config::{percent_encode_component, EncoderServerConfig, ServerType};
use super::error::{EncoderError, EncoderErrorCategory};

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MetadataUpdatePlan {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) path: String,
    pub(crate) authorization: Option<String>,
}

impl MetadataUpdatePlan {
    pub(crate) fn from_config(config: &EncoderServerConfig, text: &str) -> Self {
        let song = percent_encode_component(&text.chars().take(255).collect::<String>());
        match &config.server_type {
            ServerType::Icecast => {
                let mount = percent_encode_component(&config.mount);
                let auth = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", config.user, config.password).as_bytes());
                Self {
                    host: config.host.clone(),
                    port: config.admin_port.unwrap_or(config.port),
                    path: format!("/admin/metadata?mount={}&mode=updinfo&song={}", mount, song),
                    authorization: Some(format!("Basic {}", auth)),
                }
            }
            ServerType::Shoutcast | ServerType::Shoutcast2 => {
                let sid = if config.server_type == ServerType::Shoutcast2 {
                    config.mount.clone()
                } else {
                    "1".to_string()
                };
                Self {
                    host: config.host.clone(),
                    port: config.admin_port.unwrap_or(config.port),
                    path: format!(
                        "/admin.cgi?pass={}&mode=updinfo&sid={}&song={}",
                        percent_encode_component(&config.password),
                        percent_encode_component(&sid),
                        song
                    ),
                    authorization: None,
                }
            }
        }
    }

    pub(crate) fn send(&self) -> Result<u16, EncoderError> {
        let socket_addr = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map_err(|err| {
                EncoderError::new(
                    &format!("DNS metadata: {}", err),
                    EncoderErrorCategory::Network,
                    true,
                )
            })?
            .next()
            .ok_or_else(|| {
                EncoderError::new(
                    "No se pudo resolver host de metadata.",
                    EncoderErrorCategory::Network,
                    true,
                )
            })?;
        let mut stream = TcpStream::connect_timeout(&socket_addr, HTTP_TIMEOUT).map_err(|err| {
            EncoderError::new(
                &format!("No se pudo conectar metadata: {}", err),
                EncoderErrorCategory::Network,
                true,
            )
        })?;
        let _ = stream.set_read_timeout(Some(HTTP_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HTTP_TIMEOUT));

        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: LF-Automatizador-Rust/1.0\r\nConnection: close\r\n",
            self.path, self.host
        );
        if let Some(auth) = &self.authorization {
            request.push_str(&format!("Authorization: {}\r\n", auth));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).map_err(|err| {
            EncoderError::new(
                &format!("No se pudo enviar metadata: {}", err),
                EncoderErrorCategory::Network,
                true,
            )
        })?;

        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        let status = parse_http_status(&response).ok_or_else(|| {
            EncoderError::new(
                "Respuesta de metadata invalida.",
                EncoderErrorCategory::Server,
                false,
            )
        })?;
        if !(200..300).contains(&status) {
            return Err(EncoderError::new(
                &format!("Metadata remota respondio HTTP {}", status),
                if status == 401 || status == 403 {
                    EncoderErrorCategory::Auth
                } else {
                    EncoderErrorCategory::Server
                },
                false,
            ));
        }
        Ok(status)
    }
}

pub(crate) fn write_now_playing_file(path: &str, text: &str) -> Result<(), EncoderError> {
    if path.trim().is_empty() {
        return Ok(());
    }
    fs::write(path, text).map_err(|err| {
        EncoderError::new(
            &format!("No se pudo escribir NowPlaying.txt: {}", err),
            EncoderErrorCategory::Config,
            false,
        )
    })
}

fn parse_http_status(response: &str) -> Option<u16> {
    let line = response.lines().next()?.trim();
    let mut parts = line.split_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::IncomingCommand;

    fn config(json: &str) -> EncoderServerConfig {
        let cmd = IncomingCommand::parse(json).unwrap();
        EncoderServerConfig::from_command(&cmd).unwrap()
    }

    #[test]
    fn icecast_metadata_uses_admin_endpoint_and_basic_auth() {
        let config = config(
            r#"{"serverType":"icecast","ip":"radio.local","port":"8000","user":"source","password":"secret pass","mount":"/live","codec":"mp3","bitrate":"128"}"#,
        );
        let plan = MetadataUpdatePlan::from_config(&config, "Tema con acento");
        assert_eq!(
            plan.path,
            "/admin/metadata?mount=%2Flive&mode=updinfo&song=Tema%20con%20acento"
        );
        assert!(plan.authorization.unwrap().starts_with("Basic "));
    }

    #[test]
    fn shoutcast_metadata_uses_admin_cgi_sid() {
        let config = config(
            r#"{"serverType":"shoutcast2","ip":"radio.local","port":"8000","adminPort":"9000","password":"sec ret","mount":"2","codec":"mp3","bitrate":"128"}"#,
        );
        let plan = MetadataUpdatePlan::from_config(&config, "A&B");
        assert_eq!(plan.port, 9000);
        assert_eq!(
            plan.path,
            "/admin.cgi?pass=sec%20ret&mode=updinfo&sid=2&song=A%26B"
        );
        assert_eq!(plan.authorization, None);
    }

    #[test]
    fn parses_http_status_line() {
        assert_eq!(parse_http_status("HTTP/1.1 200 OK\r\n\r\n"), Some(200));
        assert_eq!(parse_http_status("ICY 200 OK\r\n\r\n"), None);
    }
}
