use super::super::error::{EncoderError, EncoderErrorCategory};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EncoderServerStatus {
    Disconnected,
    Connecting,
    Live,
    Error,
}

impl EncoderServerStatus {
    pub(crate) fn parse(value: &str) -> Result<Self, EncoderError> {
        match value {
            "disconnected" => Ok(Self::Disconnected),
            "connecting" => Ok(Self::Connecting),
            "live" => Ok(Self::Live),
            "error" => Ok(Self::Error),
            _ => Err(EncoderError::new(
                "Estado de servidor encoder no reconocido.",
                EncoderErrorCategory::Config,
                false,
            )),
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Live => "live",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EncoderServerRuntime {
    pub(crate) server_id: String,
    pub(crate) status: EncoderServerStatus,
    pub(crate) mode: String,
    pub(crate) message: String,
    pub(crate) pcm_bytes: u64,
    pub(crate) pcm_chunks: u64,
    pub(crate) bitrate_kbps: f32,
    pub(crate) speed: f32,
    pub(crate) ffmpeg_time: String,
    pub(crate) updated_at: u128,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_all_valid_statuses() {
        assert_eq!(
            EncoderServerStatus::parse("disconnected").unwrap(),
            EncoderServerStatus::Disconnected
        );
        assert_eq!(
            EncoderServerStatus::parse("connecting").unwrap(),
            EncoderServerStatus::Connecting
        );
        assert_eq!(
            EncoderServerStatus::parse("live").unwrap(),
            EncoderServerStatus::Live
        );
        assert_eq!(
            EncoderServerStatus::parse("error").unwrap(),
            EncoderServerStatus::Error
        );
    }

    #[test]
    fn parse_unknown_status_is_error() {
        assert!(EncoderServerStatus::parse("unknown").is_err());
        assert!(EncoderServerStatus::parse("").is_err());
    }

    #[test]
    fn roundtrip_as_str() {
        for s in &["disconnected", "connecting", "live", "error"] {
            let parsed = EncoderServerStatus::parse(s).unwrap();
            assert_eq!(parsed.as_str(), *s);
        }
    }
}
