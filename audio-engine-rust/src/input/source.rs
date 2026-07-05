use crate::protocol::escape_json;

#[derive(Clone, Debug)]
pub(crate) struct InputSource {
    pub(crate) source_id: String,
    pub(crate) device_id: String,
    pub(crate) channel_map: Vec<u16>,
    pub(crate) gain: f32,
}

impl InputSource {
    pub(crate) fn create(
        source_id: &str,
        device_id: &str,
        capture_channels: u16,
        requested_channel_map: Option<&[u16]>,
        gain: Option<f32>,
    ) -> Result<Self, String> {
        let source_id = source_id.trim();
        if source_id.is_empty() {
            return Err("sourceId requerido para fuente de entrada.".to_string());
        }
        let channel_map = normalize_channel_map(capture_channels, requested_channel_map)?;
        Ok(Self {
            source_id: source_id.to_string(),
            device_id: device_id.to_string(),
            channel_map,
            gain: gain.unwrap_or(1.0).clamp(0.0, 4.0),
        })
    }

    pub(crate) fn snapshot_json(&self) -> String {
        let channels = self
            .channel_map
            .iter()
            .map(|channel| channel.to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"sourceId\":\"{}\",\"deviceId\":\"{}\",\"channelMap\":[{}],\"gain\":{}}}",
            escape_json(&self.source_id),
            escape_json(&self.device_id),
            channels,
            self.gain
        )
    }
}

fn normalize_channel_map(
    capture_channels: u16,
    requested_channel_map: Option<&[u16]>,
) -> Result<Vec<u16>, String> {
    let capture_channels = capture_channels.max(1);
    let channels = requested_channel_map
        .filter(|channels| !channels.is_empty())
        .map(|channels| channels.to_vec())
        .unwrap_or_else(|| (0..capture_channels).collect::<Vec<_>>());
    for channel in &channels {
        if *channel >= capture_channels {
            return Err(format!(
                "Canal de entrada fuera de rango: {} (dispositivo tiene {} canales).",
                channel, capture_channels
            ));
        }
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_all_capture_channels() {
        let source = InputSource::create("mic", "input:0", 2, None, None).unwrap();
        assert_eq!(source.channel_map, vec![0, 1]);
        assert_eq!(source.gain, 1.0);
    }

    #[test]
    fn rejects_out_of_range_channel() {
        let err = InputSource::create("mic", "input:0", 1, Some(&[1]), None).unwrap_err();
        assert!(err.contains("fuera de rango"));
    }

    #[test]
    fn clamps_gain() {
        let source = InputSource::create("mic", "input:0", 2, Some(&[0]), Some(9.0)).unwrap();
        assert_eq!(source.gain, 4.0);
    }
}
