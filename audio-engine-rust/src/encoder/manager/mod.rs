mod lifecycle;
mod snapshot;
mod status;

use std::collections::HashMap;

use super::process::ManagedProcess;
use super::shoutcast_transport::EncoderTransport;

pub(crate) use status::EncoderServerRuntime;

#[derive(Debug, Default)]
pub(crate) struct EncoderManager {
    pub(super) servers: HashMap<String, EncoderServerRuntime>,
    pub(super) processes: HashMap<String, ManagedProcess>,
    pub(super) encoder_transports: HashMap<String, EncoderTransport>,
}

pub(super) fn normalize_server_id(server_id: &str) -> String {
    if server_id.trim().is_empty() {
        "0".to_string()
    } else {
        server_id.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_empty_id_defaults_to_zero() {
        assert_eq!(normalize_server_id(""), "0");
        assert_eq!(normalize_server_id("   "), "0");
    }

    #[test]
    fn normalize_trims_whitespace() {
        assert_eq!(normalize_server_id("  srv1  "), "srv1");
    }

    #[test]
    fn normalize_preserves_valid_id() {
        assert_eq!(normalize_server_id("42"), "42");
    }

    #[test]
    fn manager_default_has_empty_maps() {
        let mgr = EncoderManager::default();
        assert!(mgr.servers.is_empty());
        assert!(mgr.processes.is_empty());
        assert!(mgr.encoder_transports.is_empty());
    }
}
