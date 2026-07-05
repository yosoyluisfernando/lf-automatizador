// Gestión de dispositivos de salida de audio (WASAPI en Windows).
//
// Funciones principales:
// - `emit_devices`      — enumera todas las salidas y las emite como JSON al frontend.
// - `find_output_device` — busca un dispositivo por id, índice o nombre.
// - `ensure_output`     — abre el dispositivo si no está abierto y lo registra en EngineState.
//
// Los dispositivos se identifican por su id nativo (WASAPI endpoint id), con
// fallback a "output:<índice>" si el driver no expone id. El frontend puede
// pedir "default" para usar la salida del sistema.

use std::io::{self, Write};

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::Device;
use rodio::DeviceSinkBuilder;

use crate::protocol::{emit_error, escape_json, now_ms, request_id_field};
use crate::state::{EngineState, OutputRuntime};

fn device_id(device: &Device, fallback_index: usize) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| format!("output:{}", fallback_index))
}

fn device_name(device: &Device, fallback_index: usize) -> String {
    device
        .description()
        .map(|description| description.to_string())
        .unwrap_or_else(|_| format!("Salida {}", fallback_index + 1))
}

fn collect_output_devices() -> Result<(String, String, String, String, Vec<String>), String> {
    let host = cpal::default_host();
    let host_name = host.id().name().to_string();
    let available_hosts = cpal::available_hosts()
        .iter()
        .map(|host_id| host_id.name().to_string())
        .collect::<Vec<String>>()
        .join(",");
    let default_device = host.default_output_device();
    let default_id = default_device
        .as_ref()
        .map(|device| device_id(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let default_name = default_device
        .as_ref()
        .map(|device| device_name(device, 0))
        .unwrap_or_else(|| "default".to_string());
    let devices = host
        .output_devices()
        .map_err(|err| format!("No se pudieron listar salidas de audio: {}", err))?;
    let mut outputs = Vec::new();
    for (index, device) in devices.enumerate() {
        let id = device_id(&device, index);
        let name = device_name(&device, index);
        let index_id = format!("output:{}", index);
        let is_default = id == default_id;
        outputs.push(format!(
            "{{\"id\":\"{}\",\"indexId\":\"{}\",\"name\":\"{}\",\"isDefault\":{}}}",
            escape_json(&id),
            escape_json(&index_id),
            escape_json(&name),
            is_default
        ));
    }
    Ok((
        host_name,
        available_hosts,
        default_id,
        default_name,
        outputs,
    ))
}

/// Enumera las salidas de audio del host y las emite como JSON por stdout.
pub(crate) fn emit_devices(request_id: &str) {
    match collect_output_devices() {
        Ok((host_name, available_hosts, default_output_id, default_output, outputs)) => {
            println!(
                "{{{}\"type\":\"devices\",\"engine\":\"rustAudio\",\"version\":\"0.2.13\",\"updatedAt\":{},\"host\":\"{}\",\"availableHosts\":\"{}\",\"defaultOutput\":\"{}\",\"defaultOutputId\":\"{}\",\"outputs\":[{}]}}",
                request_id_field(request_id),
                now_ms(),
                escape_json(&host_name),
                escape_json(&available_hosts),
                escape_json(&default_output),
                escape_json(&default_output_id),
                outputs.join(",")
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, request_id),
    }
}

/// Busca un dispositivo de salida por id nativo, índice ("output:N") o nombre.
/// Devuelve (Device, id, nombre) o error si no se encuentra.
pub(crate) fn find_output_device(requested_id: &str) -> Result<(Device, String, String), String> {
    let host = cpal::default_host();
    let requested = requested_id.trim();
    if requested.is_empty() || requested == "default" {
        let device = host
            .default_output_device()
            .ok_or_else(|| "No hay salida de audio default.".to_string())?;
        let id = device_id(&device, 0);
        let name = device_name(&device, 0);
        return Ok((device, id, name));
    }

    let requested_index = requested
        .strip_prefix("output:")
        .and_then(|value| value.parse::<usize>().ok());
    let devices = host
        .output_devices()
        .map_err(|err| format!("No se pudieron leer salidas de audio: {}", err))?;
    for (index, device) in devices.enumerate() {
        let id = device_id(&device, index);
        let name = device_name(&device, index);
        if requested_index == Some(index) || requested == id || requested == name {
            return Ok((device, id, name));
        }
    }
    Err(format!("Salida Rust no encontrada: {}", requested))
}

/// Garantiza que el output esté abierto: si ya existe en state.outputs lo reutiliza,
/// si no lo abre con rodio y lo registra. Devuelve (id, nombre).
pub(crate) fn ensure_output(
    state: &mut EngineState,
    requested_id: &str,
) -> Result<(String, String), String> {
    let requested = if requested_id.trim().is_empty() {
        "default"
    } else {
        requested_id.trim()
    };
    let (device, id, name) = find_output_device(requested)?;
    if state.outputs.contains_key(&id) {
        return Ok((id, name));
    }

    let mut output = DeviceSinkBuilder::from_device(device)
        .map_err(|err| format!("No se pudo preparar salida {}: {}", name, err))?
        .open_sink_or_fallback()
        .map_err(|err| format!("No se pudo abrir salida {}: {}", name, err))?;
    output.log_on_drop(false);
    state.outputs.insert(
        id.clone(),
        OutputRuntime {
            name: name.clone(),
            sink: output,
        },
    );
    Ok((id, name))
}
