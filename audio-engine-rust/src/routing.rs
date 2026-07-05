// Enrutamiento de buses y construcción del program_mixer.
//
// La cadena de señal del bus "master" (y todos los buses de programa) es:
//
//   sub-mixer → tee Pre-FX → DSP (EQ/Comp/Limiter) → tee Post-FX → master fader → metered → sink
//
// Los taps Pre-FX y Post-FX alimentan via rtrb ring buffers al monitor y al
// encoder, que pueden conmutar en caliente entre pre y post FX.
//
// - `route_bus`            — asigna un bus a un output y reconstruye la cadena si cambió.
// - `ensure_program_mixer` — construye la cadena completa si no existe.
// - `ensure_monitor_chain` — conecta el DualTapConsumerSource al output de monitor.
// - `reset_program_mixer`  — desmonta todo, guarda pending_resume para reanudar players.
// - `resume_pending_players` — recarga y reanuda los players guardados tras un reset.
// - `cleanup_unused_outputs` — cierra outputs que ya no están referenciados por ninguna ruta.

use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use rodio::source::Zero;
use rodio::{ChannelCount, Sample, SampleRate};

use crate::dsp::{
    DualTapConsumerSource, DynamicDspSource, FaderGainField, FaderSource, MultiTeeSource, TeeTap,
};
use crate::metering::{MeteredSource, PlayerMeter};
use crate::output::ensure_output;
use crate::playback::load_audio_player;
use crate::state::{is_program_bus, EngineState, PendingResumeSpec, RouteState};

/// Asigna un bus a un dispositivo de salida. Si el output cambió, reconstruye
/// la cadena del program_mixer (master) o monitor según corresponda.
pub(crate) fn route_bus(
    state: &mut EngineState,
    bus_id: &str,
    output_id: &str,
) -> Result<(), String> {
    let (resolved_output_id, resolved_output_name) = ensure_output(state, output_id)?;

    let old_output_id = state
        .routes
        .get(bus_id)
        .map(|r| r.output_device_id.clone())
        .unwrap_or_default();
    let output_changed = !old_output_id.is_empty() && old_output_id != resolved_output_id;

    state.routes.insert(
        bus_id.to_string(),
        RouteState {
            output_device_id: resolved_output_id.clone(),
            output_device_name: resolved_output_name,
        },
    );

    if bus_id == "master" {
        if output_changed && state.program_mixer_input.is_some() {
            reset_program_mixer(state);
        }
        if let Err(err) = ensure_program_mixer(state, &resolved_output_id) {
            eprintln!("[FASE D] No se pudo inicializar program_mixer: {}", err);
        } else {
            resume_pending_players(state);
        }
    }
    if bus_id == "monitor" {
        if output_changed && !state.monitor_sink_id.is_empty() {
            reset_monitor_chain(state);
            let master_output_id = state
                .routes
                .get("master")
                .map(|r| r.output_device_id.clone())
                .unwrap_or_else(|| "default".to_string());
            if let Err(err) = ensure_program_mixer(state, &master_output_id) {
                eprintln!(
                    "[FASE D] No se pudo reconstruir program_mixer tras reset monitor: {}",
                    err
                );
            }
        }
        if let Err(err) = ensure_monitor_chain(state, &resolved_output_id) {
            eprintln!("[FASE D] No se pudo inicializar monitor_chain: {}", err);
        } else if !state.pending_resume.is_empty() {
            resume_pending_players(state);
        }
    }

    if output_changed {
        cleanup_unused_outputs(state);
    }
    Ok(())
}

/// Desmonta el program_mixer: guarda los players activos en pending_resume,
/// detiene todo el audio, limpia taps y meters. Los players se reanudan
/// cuando se llame resume_pending_players tras reconstruir el mixer.
pub(crate) fn reset_program_mixer(state: &mut EngineState) {
    state.pending_resume = state
        .players
        .iter()
        .filter(|(_, r)| {
            (r.state.status == "playing" || r.state.status == "paused")
                && !r.state.path.is_empty()
                && is_program_bus(&r.state.bus_id)
        })
        .map(|(id, r)| PendingResumeSpec {
            player_id: id.clone(),
            path: r.state.path.clone(),
            position_ms: r
                .player
                .as_ref()
                .map(|p| p.get_pos().as_millis() as u64)
                .unwrap_or(r.state.position_ms),
            gain: r.state.gain,
            bus_id: r.state.bus_id.clone(),
            was_playing: r.state.status == "playing",
        })
        .collect();
    for (_, runtime) in state.players.iter_mut() {
        if let Some(p) = runtime.player.take() {
            p.stop();
        }
    }
    state.program_mixer_input = None;
    state.program_mixer_sink_id.clear();
    state.monitor_tap_pre_consumer = None;
    state.monitor_tap_post_consumer = None;
    state.encoder_tap_pre_consumer = None;
    state.encoder_tap_post_consumer = None;
    state.recorder_master_tap = None;
    state.recorder_monitor_tap = None;
    state.monitor_sink_id.clear();
    state.master_bus_meter = Arc::new(PlayerMeter::default());
    state.monitor_bus_meter = Arc::new(PlayerMeter::default());
    if !state.time_locution_player.is_empty() {
        state.time_locution_counter.fetch_add(1, Ordering::SeqCst);
        state.time_locution_player.clear();
        state.time_locution_started_at = None;
        state.time_locution_total_ms = 0;
    }
    state.dsp_params.dsp_ready.store(false, Ordering::Relaxed);
}

/// Recarga y reanuda los players que se guardaron en pending_resume durante
/// un reset del program_mixer. Restaura posición y estado play/pause.
pub(crate) fn resume_pending_players(state: &mut EngineState) {
    let to_resume = std::mem::take(&mut state.pending_resume);
    let master_output_id = state
        .routes
        .get("master")
        .map(|r| r.output_device_id.clone())
        .unwrap_or_else(|| "default".to_string());
    for spec in to_resume {
        let resume_pos = spec.position_ms;
        match load_audio_player(
            state,
            &spec.player_id,
            &spec.path,
            spec.gain,
            true,
            &master_output_id,
            &spec.bus_id,
            "",
        ) {
            Ok(()) => {
                if let Some(runtime) = state.players.get_mut(&spec.player_id) {
                    if let Some(player) = &runtime.player {
                        if resume_pos > 200 {
                            let _ = player.try_seek(Duration::from_millis(resume_pos));
                        }
                        if spec.was_playing {
                            player.play();
                        }
                    }
                    runtime.state.status = if spec.was_playing {
                        "playing".to_string()
                    } else {
                        "loaded".to_string()
                    };
                    runtime.state.position_ms = resume_pos;
                }
            }
            Err(e) => {
                eprintln!(
                    "[auto-resume] No se pudo recargar {}: {}",
                    spec.player_id, e
                );
            }
        }
    }
}

fn reset_monitor_chain(state: &mut EngineState) {
    state.monitor_sink_id.clear();
    if state.program_mixer_input.is_some() {
        reset_program_mixer(state);
    }
}

/// Cierra los outputs que ya no están referenciados por ninguna ruta ni por
/// el program_mixer/monitor activos.
pub(crate) fn cleanup_unused_outputs(state: &mut EngineState) {
    let mut referenced: std::collections::HashSet<String> = state
        .routes
        .values()
        .map(|r| r.output_device_id.clone())
        .collect();
    if !state.program_mixer_sink_id.is_empty() {
        referenced.insert(state.program_mixer_sink_id.clone());
    }
    if !state.monitor_sink_id.is_empty() {
        referenced.insert(state.monitor_sink_id.clone());
    }
    state.outputs.retain(|id, _| referenced.contains(id));
}

/// Construye la cadena completa del program_mixer si no existe:
/// mixer → tee Pre-FX (monitor+encoder) → DSP → tee Post-FX → fader master → metered → sink.
pub(crate) fn ensure_program_mixer(state: &mut EngineState, output_id: &str) -> Result<(), String> {
    if state.program_mixer_input.is_some() {
        return Ok(());
    }
    let stereo: ChannelCount = NonZeroU16::new(2).ok_or("ChannelCount inválido")?;
    let rate: SampleRate = NonZeroU32::new(44100).ok_or("SampleRate inválido")?;
    let (program_input, program_output) = rodio::mixer::mixer(stereo, rate);
    program_input.add(Zero::new(stereo, rate));
    const MONITOR_RING_CAPACITY: usize = 16_384;
    const ENCODER_RING_CAPACITY: usize = 16_384;
    const RECORDER_RING_CAPACITY: usize = 32_768;
    let (mon_pre_prod, mon_pre_cons) = rtrb::RingBuffer::<Sample>::new(MONITOR_RING_CAPACITY);
    let (mon_post_prod, mon_post_cons) = rtrb::RingBuffer::<Sample>::new(MONITOR_RING_CAPACITY);
    let (enc_pre_prod, enc_pre_cons) = rtrb::RingBuffer::<Sample>::new(ENCODER_RING_CAPACITY);
    let (enc_post_prod, enc_post_cons) = rtrb::RingBuffer::<Sample>::new(ENCODER_RING_CAPACITY);
    let (rec_master_prod, rec_master_cons) =
        rtrb::RingBuffer::<Sample>::new(RECORDER_RING_CAPACITY);
    let (rec_monitor_prod, rec_monitor_cons) =
        rtrb::RingBuffer::<Sample>::new(RECORDER_RING_CAPACITY);
    state.monitor_tap_pre_consumer = Some(mon_pre_cons);
    state.monitor_tap_post_consumer = Some(mon_post_cons);
    state.encoder_tap_pre_consumer = Some(enc_pre_cons);
    state.encoder_tap_post_consumer = Some(enc_post_cons);
    state.recorder_master_tap = Some(rec_master_cons);
    state.recorder_monitor_tap = Some(rec_monitor_cons);

    let tee_pre = MultiTeeSource::new(
        program_output,
        vec![
            TeeTap::new(mon_pre_prod, None, None),
            TeeTap::new(
                enc_pre_prod,
                Some(Arc::clone(&state.encoder_tap_pre_drops)),
                Some(Arc::clone(&state.dsp_params)),
            ),
            TeeTap::new(rec_monitor_prod, None, None),
        ],
    );

    let dsp = DynamicDspSource::new(tee_pre, Arc::clone(&state.dsp_params));

    let tee_post = MultiTeeSource::new(
        dsp,
        vec![
            TeeTap::new(mon_post_prod, None, None),
            TeeTap::new(
                enc_post_prod,
                Some(Arc::clone(&state.encoder_tap_post_drops)),
                Some(Arc::clone(&state.dsp_params)),
            ),
            TeeTap::new(rec_master_prod, None, None),
        ],
    );

    let faded = FaderSource::new(
        tee_post,
        Arc::clone(&state.dsp_params),
        FaderGainField::Master,
    );
    let metered = MeteredSource::new(faded, Arc::clone(&state.master_bus_meter));
    let output = state
        .outputs
        .get(output_id)
        .ok_or_else(|| format!("Sin output {} para program_mixer", output_id))?;
    output.sink.mixer().add(metered);
    state.program_mixer_input = Some(program_input);
    state.program_mixer_sink_id = output_id.to_string();
    state.dsp_params.dsp_ready.store(true, Ordering::Relaxed);
    Ok(())
}

/// Conecta el monitor al output indicado: toma los consumers Pre/Post-FX del
/// program_mixer, los combina con DualTapConsumerSource, aplica fader + metering.
pub(crate) fn ensure_monitor_chain(state: &mut EngineState, output_id: &str) -> Result<(), String> {
    if !state.monitor_sink_id.is_empty() {
        return Ok(());
    }
    let pre_consumer = state.monitor_tap_pre_consumer.take().ok_or_else(|| {
        "Monitor tap Pre-FX no disponible (program_mixer no inicializado)".to_string()
    })?;
    let post_consumer = state.monitor_tap_post_consumer.take().ok_or_else(|| {
        "Monitor tap Post-FX no disponible (program_mixer no inicializado)".to_string()
    })?;
    let stereo: ChannelCount = NonZeroU16::new(2).ok_or("ChannelCount inválido")?;
    let rate: SampleRate = NonZeroU32::new(44100).ok_or("SampleRate inválido")?;
    let dual = DualTapConsumerSource::new(
        pre_consumer,
        post_consumer,
        Arc::clone(&state.dsp_params),
        true,
        stereo,
        rate,
    );
    let faded = FaderSource::new(dual, Arc::clone(&state.dsp_params), FaderGainField::Monitor);
    let metered = MeteredSource::new(faded, Arc::clone(&state.monitor_bus_meter));
    let output = state
        .outputs
        .get(output_id)
        .ok_or_else(|| format!("Sin output {} para monitor", output_id))?;
    output.sink.mixer().add(metered);
    state.monitor_sink_id = output_id.to_string();
    Ok(())
}
