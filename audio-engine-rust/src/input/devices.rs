use std::io::{self, Write};

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, SupportedStreamConfigRange};

use crate::protocol::{emit_error, escape_json, now_ms, request_id_field};

use super::config::{join_json_objects, stable_index_id};

pub(crate) fn input_device_id(device: &Device, fallback_index: usize) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| stable_index_id("input", fallback_index))
}

pub(crate) fn input_device_name(device: &Device, fallback_index: usize) -> String {
    device
        .description()
        .map(|description| description.to_string())
        .unwrap_or_else(|_| format!("Entrada {}", fallback_index + 1))
}

fn supported_config_json(config: &SupportedStreamConfigRange) -> String {
    format!(
        "{{\"channels\":{},\"sampleFormat\":\"{}\",\"minSampleRate\":{},\"maxSampleRate\":{},\"bufferSize\":\"{}\"}}",
        config.channels(),
        escape_json(&config.sample_format().to_string()),
        config.min_sample_rate(),
        config.max_sample_rate(),
        escape_json(&format!("{:?}", config.buffer_size()))
    )
}

fn input_device_json(device: &Device, index: usize, default_id: &str) -> String {
    let id = input_device_id(device, index);
    let index_id = stable_index_id("input", index);
    let name = input_device_name(device, index);
    let configs = device
        .supported_input_configs()
        .map(|configs| {
            configs
                .map(|config| supported_config_json(&config))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    format!(
        "{{\"id\":\"{}\",\"indexId\":\"{}\",\"name\":\"{}\",\"isDefault\":{},\"configs\":[{}]}}",
        escape_json(&id),
        escape_json(&index_id),
        escape_json(&name),
        id == default_id,
        join_json_objects(&configs)
    )
}

fn collect_input_devices() -> Result<(String, String, String, String, Vec<String>), String> {
    let host = cpal::default_host();
    let host_name = host.id().name().to_string();
    let available_hosts = cpal::available_hosts()
        .iter()
        .map(|host_id| host_id.name().to_string())
        .collect::<Vec<String>>()
        .join(",");
    let default_device = host.default_input_device();
    let default_id = default_device
        .as_ref()
        .map(|device| input_device_id(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let default_name = default_device
        .as_ref()
        .map(|device| input_device_name(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let devices = host
        .input_devices()
        .map_err(|err| format!("No se pudieron listar entradas de audio: {}", err))?;
    let inputs = devices
        .enumerate()
        .map(|(index, device)| input_device_json(&device, index, &default_id))
        .collect::<Vec<_>>();
    Ok((host_name, available_hosts, default_id, default_name, inputs))
}

pub(crate) fn find_input_device(requested_id: &str) -> Result<(Device, String, String), String> {
    let host = cpal::default_host();
    let requested = requested_id.trim();
    if requested.is_empty() || requested == "default" {
        let device = host
            .default_input_device()
            .ok_or_else(|| "No hay entrada de audio default.".to_string())?;
        let id = input_device_id(&device, 0);
        let name = input_device_name(&device, 0);
        return Ok((device, id, name));
    }

    let requested_index = requested
        .strip_prefix("input:")
        .and_then(|value| value.parse::<usize>().ok());
    let devices = host
        .input_devices()
        .map_err(|err| format!("No se pudieron leer entradas de audio: {}", err))?;
    for (index, device) in devices.enumerate() {
        let id = input_device_id(&device, index);
        let name = input_device_name(&device, index);
        if requested_index == Some(index) || requested == id || requested == name {
            return Ok((device, id, name));
        }
    }
    Err(format!("Entrada Rust no encontrada: {}", requested))
}

pub(crate) fn emit_input_devices(request_id: &str) {
    match collect_input_devices() {
        Ok((host_name, available_hosts, default_input_id, default_input, inputs)) => {
            println!(
                "{{{}\"type\":\"inputDevices\",\"engine\":\"rustAudio\",\"module\":\"input\",\"version\":\"0.1.0\",\"updatedAt\":{},\"host\":\"{}\",\"availableHosts\":\"{}\",\"defaultInput\":\"{}\",\"defaultInputId\":\"{}\",\"inputs\":[{}]}}",
                request_id_field(request_id),
                now_ms(),
                escape_json(&host_name),
                escape_json(&available_hosts),
                escape_json(&default_input),
                escape_json(&default_input_id),
                inputs.join(",")
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, request_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_ids_use_input_prefix() {
        assert_eq!(stable_index_id("input", 2), "input:2");
    }

    #[test]
    fn joins_empty_config_list() {
        assert_eq!(join_json_objects(&[]), "");
    }
}
