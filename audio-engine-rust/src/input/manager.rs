use std::collections::HashMap;
use std::io::{self, Write};

use crate::protocol::{emit_error, escape_json, now_ms, request_id_field, IncomingCommand};

use super::capture::InputCapture;
use super::router::InputRouter;
use super::source::InputSource;

#[derive(Default)]
pub(crate) struct InputManager {
    captures: HashMap<String, InputCapture>,
    router: InputRouter,
}

#[derive(Clone, Debug)]
pub(crate) struct InputConsumerRoute {
    pub(crate) server_id: String,
    pub(crate) device_id: String,
    pub(crate) source_id: String,
    pub(crate) consumer_id: String,
}

impl InputManager {
    pub(crate) fn start_device(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let requested = ic.device_id.as_deref().unwrap_or("default");
        let capture = InputCapture::start(
            requested,
            ic.sample_rate,
            ic.channels.map(|value| value as u16),
            self.router.clone(),
        )?;
        let device_id = capture.device_id.clone();
        self.captures.insert(device_id.clone(), capture);
        Ok(device_id)
    }

    pub(crate) fn stop_device(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let requested = ic.device_id.as_deref().unwrap_or("default");
        let key = self.resolve_active_device_id(requested).unwrap_or_default();
        if key.is_empty() || !self.captures.contains_key(&key) {
            return Err(format!("Entrada no activa: {}", requested));
        }
        if self.router.has_sources_for_device(&key) {
            return Err(format!(
                "Entrada {} tiene fuentes virtuales activas; elimina las fuentes antes de cerrarla.",
                requested
            ));
        }
        self.captures.remove(&key);
        Ok(key)
    }

    pub(crate) fn create_source(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let source_id = ic
            .source_id
            .as_deref()
            .ok_or_else(|| "sourceId requerido para createSource.".to_string())?;
        let requested_device = ic.device_id.as_deref().unwrap_or("default");
        let device_id = self
            .resolve_active_device_id(requested_device)
            .ok_or_else(|| format!("Entrada no activa para fuente: {}", requested_device))?;
        let capture_channels = self
            .captures
            .get(&device_id)
            .map(|capture| capture.channels)
            .ok_or_else(|| format!("Entrada no activa para fuente: {}", requested_device))?;
        let source = InputSource::create(
            source_id,
            &device_id,
            capture_channels,
            ic.channel_map.as_deref(),
            ic.gain,
        )?;
        let source_id = source.source_id.clone();
        self.router.add_source(source);
        Ok(source_id)
    }

    pub(crate) fn delete_source(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let source_id = ic
            .source_id
            .as_deref()
            .ok_or_else(|| "sourceId requerido para deleteSource.".to_string())?;
        self.router.remove_source(source_id)?;
        Ok(source_id.to_string())
    }

    pub(crate) fn subscribe(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let source_id = ic
            .source_id
            .as_deref()
            .ok_or_else(|| "sourceId requerido para subscribe.".to_string())?;
        let consumer = ic
            .consumer
            .as_deref()
            .ok_or_else(|| "consumer requerido para subscribe.".to_string())?;
        self.router
            .subscribe(source_id, consumer, ic.target.as_deref())?;
        Ok(consumer.to_string())
    }

    pub(crate) fn unsubscribe(&mut self, ic: &IncomingCommand) -> Result<String, String> {
        let consumer = ic
            .consumer
            .as_deref()
            .ok_or_else(|| "consumer requerido para unsubscribe.".to_string())?;
        self.router.unsubscribe(consumer)?;
        Ok(consumer.to_string())
    }

    pub(crate) fn drain_consumer(
        &mut self,
        ic: &IncomingCommand,
    ) -> Result<super::router::DrainedInputPcm, String> {
        let consumer = ic
            .consumer
            .as_deref()
            .ok_or_else(|| "consumer requerido para drainConsumer.".to_string())?;
        let frames = ic.frames.unwrap_or(2048).clamp(1, 48_000) as usize;
        self.router.drain_consumer(consumer, frames)
    }

    pub(crate) fn start_encoder_route(
        &mut self,
        server_id: &str,
        requested_device: &str,
        sample_rate: Option<u32>,
        channel_map: Option<&[u16]>,
    ) -> Result<InputConsumerRoute, String> {
        let server_id = server_id.trim();
        if server_id.is_empty() {
            return Err("serverId requerido para ruta encoder input.".to_string());
        }
        self.start_consumer_route(
            server_id,
            &format!("encoder:{}:input", server_id),
            &format!("encoder:{}:ffmpeg", server_id),
            "encoder",
            requested_device,
            sample_rate,
            channel_map,
            Some(1.0),
        )
    }

    pub(crate) fn start_consumer_route(
        &mut self,
        owner_id: &str,
        source_id: &str,
        consumer_id: &str,
        target: &str,
        requested_device: &str,
        sample_rate: Option<u32>,
        channel_map: Option<&[u16]>,
        gain: Option<f32>,
    ) -> Result<InputConsumerRoute, String> {
        let owner_id = owner_id.trim();
        if owner_id.is_empty() {
            return Err("owner requerido para ruta input.".to_string());
        }
        let requested_device = if requested_device.trim().is_empty() {
            "default"
        } else {
            requested_device.trim()
        };
        let device_id = match self.resolve_active_device_id(requested_device) {
            Some(device_id) => device_id,
            None => {
                let capture =
                    InputCapture::start(requested_device, sample_rate, None, self.router.clone())?;
                let device_id = capture.device_id.clone();
                self.captures.insert(device_id.clone(), capture);
                device_id
            }
        };
        let capture_channels = self
            .captures
            .get(&device_id)
            .map(|capture| capture.channels)
            .ok_or_else(|| format!("Entrada no activa para encoder: {}", requested_device))?;
        let _ = self.router.unsubscribe(consumer_id);
        let _ = self.router.remove_source(source_id);
        let source =
            InputSource::create(source_id, &device_id, capture_channels, channel_map, gain)?;
        self.router.add_source(source);
        self.router
            .subscribe(source_id, consumer_id, Some(target))?;
        Ok(InputConsumerRoute {
            server_id: owner_id.to_string(),
            device_id,
            source_id: source_id.to_string(),
            consumer_id: consumer_id.to_string(),
        })
    }

    pub(crate) fn stop_consumer_route(&mut self, route: &InputConsumerRoute) {
        let _ = self.router.unsubscribe(&route.consumer_id);
        let _ = self.router.remove_source(&route.source_id);
        if !self.router.has_sources_for_device(&route.device_id) {
            self.captures.remove(&route.device_id);
        }
    }

    pub(crate) fn drain_consumer_id(
        &mut self,
        consumer_id: &str,
        frames: usize,
    ) -> Result<super::router::DrainedInputPcm, String> {
        self.router.drain_consumer(consumer_id, frames)
    }

    pub(crate) fn captures_json(&self) -> String {
        let mut captures = self.captures.values().collect::<Vec<_>>();
        captures.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        captures
            .into_iter()
            .map(|capture| capture.snapshot_json())
            .collect::<Vec<_>>()
            .join(",")
    }

    pub(crate) fn sources_json(&self) -> String {
        self.router.sources_json()
    }

    pub(crate) fn consumers_json(&self) -> String {
        self.router.consumers_json()
    }

    fn resolve_active_device_id(&self, requested: &str) -> Option<String> {
        let requested = requested.trim();
        if requested.is_empty() || requested == "default" {
            let mut keys = self.captures.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            return keys.into_iter().next();
        }
        if self.captures.contains_key(requested) {
            return Some(requested.to_string());
        }
        None
    }
}

pub(crate) fn emit_input_snapshot(manager: &InputManager, request_id: &str) {
    println!(
        "{{{}\"type\":\"inputSnapshot\",\"engine\":\"rustAudio\",\"module\":\"input\",\"updatedAt\":{},\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}]}}",
        request_id_field(request_id),
        now_ms(),
        manager.captures_json(),
        manager.sources_json(),
        manager.consumers_json()
    );
    let _ = io::stdout().flush();
}

pub(crate) fn emit_start_device(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.start_device(ic) {
        Ok(device_id) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"startDevice\",\"ok\":true,\"deviceId\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&device_id),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_stop_device(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.stop_device(ic) {
        Ok(device_id) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"stopDevice\",\"ok\":true,\"deviceId\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&device_id),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_create_source(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.create_source(ic) {
        Ok(source_id) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"createSource\",\"ok\":true,\"sourceId\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&source_id),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_delete_source(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.delete_source(ic) {
        Ok(source_id) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"deleteSource\",\"ok\":true,\"sourceId\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&source_id),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_subscribe(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.subscribe(ic) {
        Ok(consumer) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"subscribe\",\"ok\":true,\"consumer\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&consumer),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_unsubscribe(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.unsubscribe(ic) {
        Ok(consumer) => {
            println!(
                "{{{}\"type\":\"response\",\"module\":\"input\",\"cmd\":\"unsubscribe\",\"ok\":true,\"consumer\":\"{}\",\"captures\":[{}],\"sources\":[{}],\"consumers\":[{}],\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&consumer),
                manager.captures_json(),
                manager.sources_json(),
                manager.consumers_json(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

pub(crate) fn emit_drain_consumer(manager: &mut InputManager, ic: &IncomingCommand) {
    match manager.drain_consumer(ic) {
        Ok(drained) => {
            println!(
                "{{{}\"type\":\"inputPcm\",\"engine\":\"rustAudio\",\"module\":\"input\",\"cmd\":\"drainConsumer\",\"ok\":true,\"consumer\":\"{}\",\"sourceId\":\"{}\",\"format\":\"f32le\",\"channels\":{},\"frames\":{},\"remainingFrames\":{},\"peak\":{},\"data\":\"{}\",\"updatedAt\":{}}}",
                request_id_field(&ic.request_id),
                escape_json(&drained.consumer),
                escape_json(&drained.source_id),
                drained.channels,
                drained.frames,
                drained.remaining_frames,
                drained.peak(),
                drained.data_base64_f32le(),
                now_ms()
            );
            let _ = io::stdout().flush();
        }
        Err(err) => emit_error(&err, &ic.request_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_is_array_body() {
        assert_eq!(InputManager::default().captures_json(), "");
        assert_eq!(InputManager::default().sources_json(), "");
        assert_eq!(InputManager::default().consumers_json(), "");
    }
}
