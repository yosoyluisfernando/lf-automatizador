use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig, StreamError, SupportedStreamConfig};

use super::devices::find_input_device;
use super::metering::InputMeter;
use super::router::InputRouter;

pub(crate) struct InputCapture {
    pub(crate) device_id: String,
    pub(crate) device_name: String,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) sample_format: String,
    pub(crate) meter: InputMeter,
    _stream: Stream,
}

impl InputCapture {
    pub(crate) fn start(
        requested_device_id: &str,
        requested_sample_rate: Option<u32>,
        requested_channels: Option<u16>,
        router: InputRouter,
    ) -> Result<Self, String> {
        let (device, device_id, device_name) = find_input_device(requested_device_id)?;
        let supported = select_input_config(&device, requested_sample_rate, requested_channels)?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let meter = InputMeter::default();
        let stream = build_stream(
            &device,
            &config,
            sample_format,
            meter.clone(),
            router,
            device_id.clone(),
        )?;
        stream
            .play()
            .map_err(|err| format!("No se pudo iniciar entrada {}: {}", device_name, err))?;
        Ok(Self {
            device_id,
            device_name,
            sample_rate,
            channels,
            sample_format: sample_format.to_string(),
            meter,
            _stream: stream,
        })
    }

    pub(crate) fn snapshot_json(&self) -> String {
        format!(
            "{{\"deviceId\":\"{}\",\"deviceName\":\"{}\",\"sampleRate\":{},\"channels\":{},\"sampleFormat\":\"{}\",{}}}",
            crate::protocol::escape_json(&self.device_id),
            crate::protocol::escape_json(&self.device_name),
            self.sample_rate,
            self.channels,
            crate::protocol::escape_json(&self.sample_format),
            self.meter.snapshot_json()
        )
    }
}

fn select_input_config(
    device: &cpal::Device,
    requested_sample_rate: Option<u32>,
    requested_channels: Option<u16>,
) -> Result<SupportedStreamConfig, String> {
    let mut configs = device
        .supported_input_configs()
        .map_err(|err| format!("No se pudieron leer formatos de entrada: {}", err))?
        .collect::<Vec<_>>();
    configs.sort_by_key(|config| sample_format_rank(config.sample_format()));
    let matching = configs.iter().find(|config| {
        requested_channels.map_or(true, |channels| config.channels() == channels)
            && requested_sample_rate.map_or(true, |rate| {
                config.min_sample_rate() <= rate && rate <= config.max_sample_rate()
            })
    });
    let selected = matching
        .or_else(|| configs.first())
        .ok_or_else(|| "La entrada no reporta formatos soportados.".to_string())?;
    let sample_rate = requested_sample_rate
        .filter(|rate| selected.min_sample_rate() <= *rate && *rate <= selected.max_sample_rate())
        .unwrap_or_else(|| selected.with_max_sample_rate().sample_rate());
    Ok(selected.with_sample_rate(sample_rate))
}

fn sample_format_rank(format: SampleFormat) -> u8 {
    match format {
        SampleFormat::F32 => 0,
        SampleFormat::I16 => 1,
        SampleFormat::I32 => 2,
        _ => 3,
    }
}

fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    meter: InputMeter,
    router: InputRouter,
    device_id: String,
) -> Result<Stream, String> {
    let channels = config.channels;
    let err_meter = meter.clone();
    let error_callback = move |err: StreamError| err_meter.set_error(&err.to_string());
    match sample_format {
        SampleFormat::F32 => {
            let stream_router = router.clone();
            let stream_device_id = device_id.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        meter.observe_f32(data, channels);
                        stream_router.observe_device(&stream_device_id, data, channels);
                    },
                    error_callback,
                    None,
                )
                .map_err(|err| format!("No se pudo abrir stream f32: {}", err))
        }
        SampleFormat::I16 => {
            let stream_router = router.clone();
            let stream_device_id = device_id.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        let converted = data
                            .iter()
                            .map(|sample| f32::from(*sample) / 32768.0)
                            .collect::<Vec<_>>();
                        meter.observe_f32(&converted, channels);
                        stream_router.observe_device(&stream_device_id, &converted, channels);
                    },
                    error_callback,
                    None,
                )
                .map_err(|err| format!("No se pudo abrir stream i16: {}", err))
        }
        SampleFormat::U16 => {
            let stream_router = router.clone();
            let stream_device_id = device_id.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        let converted = data
                            .iter()
                            .map(|sample| (*sample as f32 - 32768.0) / 32768.0)
                            .collect::<Vec<_>>();
                        meter.observe_f32(&converted, channels);
                        stream_router.observe_device(&stream_device_id, &converted, channels);
                    },
                    error_callback,
                    None,
                )
                .map_err(|err| format!("No se pudo abrir stream u16: {}", err))
        }
        other => Err(format!(
            "Formato de entrada no soportado todavia: {}",
            other
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_rank_prefers_f32() {
        assert!(sample_format_rank(SampleFormat::F32) < sample_format_rank(SampleFormat::I16));
    }
}
