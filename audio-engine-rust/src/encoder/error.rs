#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EncoderErrorCategory {
    Auth,
    Codec,
    Config,
    Network,
    Server,
}

impl EncoderErrorCategory {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Codec => "codec",
            Self::Config => "config",
            Self::Network => "network",
            Self::Server => "server",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EncoderError {
    pub(crate) message: String,
    pub(crate) category: EncoderErrorCategory,
    pub(crate) retryable: bool,
}

impl EncoderError {
    pub(crate) fn new(message: &str, category: EncoderErrorCategory, retryable: bool) -> Self {
        Self {
            message: message.to_string(),
            category,
            retryable,
        }
    }

    pub(crate) fn config(message: &str) -> Self {
        Self::new(message, EncoderErrorCategory::Config, false)
    }

    pub(crate) fn to_operator_message(&self) -> String {
        format!("{} ({})", self.message, self.category.as_str())
    }
}

pub(crate) fn classify_encoder_error(value: &str) -> EncoderError {
    let text = value.to_lowercase();
    if text.contains("401")
        || text.contains("403")
        || text.contains("unauthorized")
        || text.contains("unauthorised")
        || text.contains("forbidden")
        || text.contains("bad password")
        || text.contains("invalid password")
        || text.contains("authentication")
        || text.contains("auth failed")
        || text.contains("cipher")
    {
        return EncoderError::new(value, EncoderErrorCategory::Auth, false);
    }
    if text.contains("stream in use")
        || text.contains("already connected")
        || text.contains("invalid sid")
        || text.contains("bad sid")
        || text.contains("nak")
        || (text.contains("mountpoint") && text.contains("in use"))
    {
        return EncoderError::new(value, EncoderErrorCategory::Server, false);
    }
    if text.contains("unknown encoder")
        || text.contains("libfdk_aac")
        || text.contains("invalid data")
        || text.contains("unsupported codec")
        || text.contains("codec")
    {
        return EncoderError::new(value, EncoderErrorCategory::Codec, false);
    }
    if text.contains("econnrefused")
        || text.contains("econnreset")
        || text.contains("enotfound")
        || text.contains("etimedout")
        || text.contains("timeout")
        || text.contains("socket")
        || text.contains("network")
        || text.contains("temporar")
        || text.contains("closed by")
        || text.contains("cerro la conexion")
        || text.contains("cerrado por el servidor")
    {
        return EncoderError::new(value, EncoderErrorCategory::Network, true);
    }
    EncoderError::new(value, EncoderErrorCategory::Server, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_auth_errors() {
        let err = classify_encoder_error("401 unauthorized");
        assert_eq!(err.category, EncoderErrorCategory::Auth);
        assert!(!err.retryable);
    }

    #[test]
    fn classifies_network_errors_as_retryable() {
        let err = classify_encoder_error("ETIMEDOUT socket");
        assert_eq!(err.category, EncoderErrorCategory::Network);
        assert!(err.retryable);
    }
}
