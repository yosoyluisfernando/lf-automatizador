use crate::protocol::IncomingCommand;

use super::error::{EncoderError, EncoderErrorCategory};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ServerType {
    Icecast,
    Shoutcast,
    Shoutcast2,
}

impl ServerType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Icecast => "icecast",
            Self::Shoutcast => "shoutcast",
            Self::Shoutcast2 => "shoutcast2",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EncoderCodec {
    Mp3,
    Aac,
    AacHe,
}

impl EncoderCodec {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Aac => "aac",
            Self::AacHe => "aac_he",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EncoderServerConfig {
    pub(crate) server_id: String,
    pub(crate) server_type: ServerType,
    pub(crate) legacy: bool,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) admin_port: Option<u16>,
    pub(crate) user: String,
    pub(crate) password: String,
    pub(crate) mount: String,
    pub(crate) codec: EncoderCodec,
    pub(crate) bitrate_kbps: u16,
    pub(crate) icy_name: String,
    pub(crate) icy_genre: String,
    pub(crate) icy_url: String,
    pub(crate) icy_public: bool,
    pub(crate) capture_format: String,
    pub(crate) sample_rate: u32,
}

impl EncoderServerConfig {
    pub(crate) fn from_command(ic: &IncomingCommand) -> Result<Self, EncoderError> {
        let requested_type = first_non_empty(&[ic.server_type.as_ref(), ic.encoder_type.as_ref()]);
        let legacy = ic.legacy.unwrap_or(false) || requested_type == "shoutcast2_legacy";
        let server_type = parse_server_type(&requested_type)?;
        let host = required_trimmed(ic.ip.as_ref(), "IP o host invalido.")?;
        if host.contains("://") || host.chars().any(char::is_whitespace) {
            return Err(EncoderError::config("IP o host invalido."));
        }
        let port = parse_port(ic.port.as_ref(), "Puerto invalido.")?;
        let admin_port = match trim_opt(ic.admin_port.as_ref()) {
            Some(value) => Some(parse_port(Some(&value), "Puerto administrativo invalido.")?),
            None => None,
        };
        let password = first_non_empty(&[ic.password.as_ref(), ic.pass.as_ref()]);
        if password.is_empty() {
            return Err(EncoderError::new(
                "Falta la contrasena del servidor.",
                EncoderErrorCategory::Auth,
                false,
            ));
        }
        let codec = parse_codec(
            &first_non_empty(&[ic.codec.as_ref()]),
            ic.fdk_available.unwrap_or(false),
        )?;
        let bitrate_kbps = parse_bitrate(ic.bitrate.as_ref())?;
        let mut mount = trim_opt(ic.mount.as_ref()).unwrap_or_default();
        if server_type == ServerType::Icecast {
            mount = normalize_mount(&mount);
            if mount.is_empty() || mount == "/" {
                return Err(EncoderError::config(
                    "Falta el punto de montaje para Icecast.",
                ));
            }
        }
        if server_type == ServerType::Shoutcast2 && !is_positive_integer(&mount) {
            return Err(EncoderError::config(
                "El Stream ID (SID) debe ser un entero positivo.",
            ));
        }
        Ok(Self {
            server_id: trim_opt(ic.server_id.as_ref()).unwrap_or_else(|| "0".to_string()),
            server_type,
            legacy,
            host,
            port,
            admin_port,
            user: first_non_empty(&[ic.user.as_ref(), ic.username.as_ref()]).if_empty("source"),
            password,
            mount,
            codec,
            bitrate_kbps,
            icy_name: first_non_empty(&[ic.icy_name.as_ref()]).if_empty("Radio"),
            icy_genre: first_non_empty(&[ic.icy_genre.as_ref()]).if_empty("Variado"),
            icy_url: first_non_empty(&[ic.icy_url.as_ref()]).if_empty("http://"),
            icy_public: ic.icy_public.unwrap_or(true),
            capture_format: first_non_empty(&[ic.capture_format.as_ref()]).if_empty("pcm_s16le"),
            sample_rate: ic.sample_rate.unwrap_or(44100).clamp(8000, 192000),
        })
    }
}

fn parse_server_type(value: &str) -> Result<ServerType, EncoderError> {
    match value {
        "icecast" => Ok(ServerType::Icecast),
        "shoutcast" => Ok(ServerType::Shoutcast),
        "shoutcast2" | "shoutcast2_legacy" => Ok(ServerType::Shoutcast2),
        _ => Err(EncoderError::config("Tipo de servidor no reconocido.")),
    }
}

fn parse_codec(value: &str, fdk_available: bool) -> Result<EncoderCodec, EncoderError> {
    match value {
        "mp3" => Ok(EncoderCodec::Mp3),
        "aac" => Ok(EncoderCodec::Aac),
        "aac_he" if fdk_available => Ok(EncoderCodec::AacHe),
        "aac_he" => Err(EncoderError::new(
            "AAC+ / HE-AAC requiere un FFmpeg externo autorizado con libfdk_aac.",
            EncoderErrorCategory::Codec,
            false,
        )),
        _ => Err(EncoderError::new(
            "Codec no reconocido.",
            EncoderErrorCategory::Codec,
            false,
        )),
    }
}

fn parse_port(value: Option<&String>, message: &str) -> Result<u16, EncoderError> {
    let raw = required_trimmed(value, message)?;
    raw.parse::<u16>()
        .map_err(|_| EncoderError::config(message))
}

fn parse_bitrate(value: Option<&String>) -> Result<u16, EncoderError> {
    let raw = trim_opt(value).unwrap_or_else(|| "128".to_string());
    let bitrate = raw
        .parse::<u16>()
        .map_err(|_| EncoderError::config("Bitrate invalido."))?;
    if !(8..=512).contains(&bitrate) {
        return Err(EncoderError::config("Bitrate invalido."));
    }
    Ok(bitrate)
}

fn required_trimmed(value: Option<&String>, message: &str) -> Result<String, EncoderError> {
    trim_opt(value)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| EncoderError::config(message))
}

fn trim_opt(value: Option<&String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn first_non_empty(values: &[Option<&String>]) -> String {
    values.iter().find_map(|v| trim_opt(*v)).unwrap_or_default()
}

fn normalize_mount(value: &str) -> String {
    let mount = value.trim();
    if mount.is_empty() {
        String::new()
    } else if mount.starts_with('/') {
        mount.to_string()
    } else {
        format!("/{}", mount)
    }
}

pub(crate) fn percent_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn is_positive_integer(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) && value != "0"
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mount() {
        assert_eq!(normalize_mount("live"), "/live");
        assert_eq!(normalize_mount("/live"), "/live");
    }

    #[test]
    fn rejects_he_aac_without_fdk() {
        let err = parse_codec("aac_he", false).unwrap_err();
        assert_eq!(err.category, EncoderErrorCategory::Codec);
    }
}
