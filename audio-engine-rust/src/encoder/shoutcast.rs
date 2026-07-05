use super::config::{EncoderCodec, EncoderServerConfig, ServerType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShoutcastHandshakeMode {
    IcyLegacy,
    HttpSource,
}

impl ShoutcastHandshakeMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::IcyLegacy => "icy-legacy",
            Self::HttpSource => "http-source",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ShoutcastHandshakePlan {
    pub(crate) mode: ShoutcastHandshakeMode,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) sid: String,
    pub(crate) initial_bytes: Vec<u8>,
    pub(crate) post_ok_bytes: Vec<u8>,
}

impl ShoutcastHandshakePlan {
    pub(crate) fn from_config(config: &EncoderServerConfig) -> Self {
        let mode = resolve_handshake_mode(config);
        let sid = resolve_sid(config);
        let post_ok = icy_headers(config);
        let initial = match mode {
            ShoutcastHandshakeMode::IcyLegacy => {
                let password = if config.server_type == ServerType::Shoutcast2 {
                    format!("{}:#{}", config.password, sid)
                } else {
                    config.password.clone()
                };
                format!("{}\r\n", password).into_bytes()
            }
            ShoutcastHandshakeMode::HttpSource => http_source_request(config, &sid).into_bytes(),
        };
        Self {
            mode,
            host: config.host.clone(),
            port: config.port,
            sid,
            initial_bytes: initial,
            post_ok_bytes: post_ok.into_bytes(),
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShoutcastHandshakeResult {
    Pending,
    Accepted,
    Rejected(String),
}

#[allow(dead_code)]
pub(crate) fn parse_handshake_response(
    mode: ShoutcastHandshakeMode,
    response: &str,
) -> ShoutcastHandshakeResult {
    match mode {
        ShoutcastHandshakeMode::IcyLegacy => {
            if !response.contains('\n') {
                return ShoutcastHandshakeResult::Pending;
            }
            if response
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("ok2")
            {
                ShoutcastHandshakeResult::Accepted
            } else {
                ShoutcastHandshakeResult::Rejected(first_line(response))
            }
        }
        ShoutcastHandshakeMode::HttpSource => {
            let has_end = response.contains("\r\n\r\n") || response.contains("\n\n");
            let accepted = response.to_ascii_lowercase().contains("icy 200")
                || response.to_ascii_lowercase().contains("200 ok");
            if accepted {
                ShoutcastHandshakeResult::Accepted
            } else if has_end {
                ShoutcastHandshakeResult::Rejected(first_line(response))
            } else {
                ShoutcastHandshakeResult::Pending
            }
        }
    }
}

fn resolve_handshake_mode(config: &EncoderServerConfig) -> ShoutcastHandshakeMode {
    if config.server_type == ServerType::Shoutcast
        || (config.server_type == ServerType::Shoutcast2 && config.legacy)
    {
        ShoutcastHandshakeMode::IcyLegacy
    } else {
        ShoutcastHandshakeMode::HttpSource
    }
}

fn resolve_sid(config: &EncoderServerConfig) -> String {
    if config.server_type == ServerType::Shoutcast2 {
        let sid = config
            .mount
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>();
        if sid.is_empty() {
            "1".to_string()
        } else {
            sid
        }
    } else {
        "1".to_string()
    }
}

fn http_source_request(config: &EncoderServerConfig, sid: &str) -> String {
    let br = config.bitrate_kbps;
    let auth = base64_basic_auth("source", &config.password);
    format!(
        "SOURCE /{} HTTP/1.0\r\nAuthorization: Basic {}\r\nicy-password: {}\r\nUser-Agent: LF-Radio/1.0\r\nContent-Type: {}\r\nice-audio-info: ice-samplerate=44100;ice-bitrate={};ice-channels=2\r\nicy-name: {}\r\nicy-genre: {}\r\nicy-pub: {}\r\nicy-br: {}\r\n\r\n",
        sid,
        auth,
        config.password,
        content_type(config),
        br,
        config.icy_name,
        config.icy_genre,
        if config.icy_public { 1 } else { 0 },
        br
    )
}

fn icy_headers(config: &EncoderServerConfig) -> String {
    let br = config.bitrate_kbps;
    format!(
        "icy-name:{}\r\nicy-genre:{}\r\nicy-pub:{}\r\nicy-br:{}\r\nicy-url:{}\r\ncontent-type:{}\r\n\r\n",
        config.icy_name,
        config.icy_genre,
        if config.icy_public { 1 } else { 0 },
        br,
        config.icy_url,
        content_type(config)
    )
}

fn content_type(config: &EncoderServerConfig) -> &'static str {
    match config.codec {
        EncoderCodec::Mp3 => "audio/mpeg",
        EncoderCodec::Aac | EncoderCodec::AacHe => "audio/aacp",
    }
}

#[allow(dead_code)]
fn first_line(value: &str) -> String {
    value
        .lines()
        .next()
        .unwrap_or(value)
        .trim()
        .chars()
        .take(200)
        .collect()
}

fn base64_basic_auth(user: &str, password: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = format!("{}:{}", user, password).into_bytes();
    let mut out = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = bytes.get(index + 1).copied().unwrap_or(0);
        let b2 = bytes.get(index + 2).copied().unwrap_or(0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if index + 2 < bytes.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        index += 3;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::config::EncoderServerConfig;
    use crate::protocol::IncomingCommand;

    fn config(json: &str) -> EncoderServerConfig {
        let cmd = IncomingCommand::parse(json).unwrap();
        EncoderServerConfig::from_command(&cmd).unwrap()
    }

    #[test]
    fn classic_shoutcast_uses_icy_password_then_headers() {
        let cfg = config(
            r#"{"serverType":"shoutcast","ip":"host","port":"8000","password":"secret","codec":"mp3","bitrate":"128","icyName":"Radio","icyGenre":"Salsa"}"#,
        );
        let plan = ShoutcastHandshakePlan::from_config(&cfg);
        assert_eq!(plan.mode, ShoutcastHandshakeMode::IcyLegacy);
        assert_eq!(String::from_utf8(plan.initial_bytes).unwrap(), "secret\r\n");
        let headers = String::from_utf8(plan.post_ok_bytes).unwrap();
        assert!(headers.contains("icy-name:Radio\r\n"));
        assert!(headers.contains("content-type:audio/mpeg\r\n"));
    }

    #[test]
    fn shoutcast2_legacy_password_includes_sid() {
        let cfg = config(
            r#"{"serverType":"shoutcast2","legacy":true,"ip":"host","port":"8000","password":"secret","mount":"2","codec":"mp3","bitrate":"128"}"#,
        );
        let plan = ShoutcastHandshakePlan::from_config(&cfg);
        assert_eq!(plan.mode, ShoutcastHandshakeMode::IcyLegacy);
        assert_eq!(
            String::from_utf8(plan.initial_bytes).unwrap(),
            "secret:#2\r\n"
        );
    }

    #[test]
    fn shoutcast2_http_source_builds_authorized_request() {
        let cfg = config(
            r#"{"serverType":"shoutcast2","ip":"host","port":"8000","password":"secret","mount":"3","codec":"aac","bitrate":"96","icyName":"Radio"}"#,
        );
        let plan = ShoutcastHandshakePlan::from_config(&cfg);
        assert_eq!(plan.mode, ShoutcastHandshakeMode::HttpSource);
        let request = String::from_utf8(plan.initial_bytes).unwrap();
        assert!(request.starts_with("SOURCE /3 HTTP/1.0\r\n"));
        assert!(request.contains("Authorization: Basic c291cmNlOnNlY3JldA==\r\n"));
        assert!(request.contains("Content-Type: audio/aacp\r\n"));
    }

    #[test]
    fn parses_icy_and_http_responses() {
        assert_eq!(
            parse_handshake_response(ShoutcastHandshakeMode::IcyLegacy, "OK2\r\n"),
            ShoutcastHandshakeResult::Accepted
        );
        assert_eq!(
            parse_handshake_response(ShoutcastHandshakeMode::HttpSource, "ICY 200 OK\r\n\r\n"),
            ShoutcastHandshakeResult::Accepted
        );
        assert_eq!(
            parse_handshake_response(
                ShoutcastHandshakeMode::HttpSource,
                "HTTP/1.0 403 Forbidden\r\n\r\n"
            ),
            ShoutcastHandshakeResult::Rejected("HTTP/1.0 403 Forbidden".to_string())
        );
    }
}
