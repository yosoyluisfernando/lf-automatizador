'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const windowsSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'windows.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
const rustSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'main.rs'), 'utf8');
const rustBridgeSource = fs.readFileSync(path.join(rootDir, 'backend', 'encoder', 'rust_bridge.js'), 'utf8');
const rustRoutingSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'routing.rs'), 'utf8');
const rustEmitSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'emit.rs'), 'utf8');
const rustTeeSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'dsp', 'tee.rs'), 'utf8');
const rustEncoderSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'encoder', 'mod.rs'), 'utf8');
const rustInputManagerSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'input', 'manager.rs'), 'utf8');

test('master encoder starts Rust FFmpeg only after the native tap is ready', () => {
    assert.match(rustBridgeSource, /async function ensureInput\(config\)/);
    assert.match(rustBridgeSource, /const tapAck = await engine\.command\(\{ cmd: 'encoderTap', enable: true \}, 5000\);/);
    assert.match(rustBridgeSource, /if \(!tap\?\.active \|\| !tap\?\.ready\) \{/);
    assert.match(rustBridgeSource, /const input = await ensureInput\(config\);[\s\S]*context\.rustAudioEngine\.command\(buildCommand\(sid, input\.config \|\| config\)/);
    assert.doesNotMatch(windowsSource, /startServerFfmpeg\(id, config\)/);
});

test('microphone encoder uses Rust input routes instead of renderer PCM sync', () => {
    assert.match(rustBridgeSource, /if \(resolved\.source === 'mic'\) \{/);
    assert.match(rustBridgeSource, /resolved\.sourceId = deviceId;/);
    assert.match(rustBridgeSource, /resolved\.deviceId = deviceId;/);
    assert.match(rustBridgeSource, /sourceId: config\.sourceId \|\| config\.deviceId \|\| config\.micId \|\| config\.mic \|\| ''/);
    assert.match(rustBridgeSource, /deviceId: config\.deviceId \|\| config\.sourceId \|\| config\.micId \|\| config\.mic \|\| ''/);
    assert.match(rustEncoderSource, /fn start_input_route_if_requested/);
    assert.match(rustInputManagerSource, /pub\(crate\) fn start_encoder_route/);
    assert.doesNotMatch(windowsSource, /Fallback JS\/FFmpeg bloqueado/);
});

test('encoder shutdown notification cannot lazy-start the Rust engine while app is quitting', () => {
    assert.match(windowsSource, /if \(context\.isAppQuitting\) \{\s*if \(context\.rustAudioEngine\?\.isRunning\?\.\(\) && context\.rustAudioEngine\?\.send\) \{\s*context\.rustAudioEngine\.send\(encoderCommand\);/);
    assert.match(windowsSource, /context\.rustAudioEngine\.command\(encoderCommand\)/);
});

test('microphone capture no longer launches a duplicate legacy FFmpeg process with id zero', () => {
    assert.doesNotMatch(renderSource, /ipcRenderer\.send\('init-ffmpeg', config\)/);
    assert.doesNotMatch(windowsSource, /startServerFfmpeg\(sid, rendererCapture\)/);
    const micReady = rustBridgeSource.indexOf('return { success: true, config: resolved };');
    const rendererSync = rustBridgeSource.indexOf("start-rust-pcm-encoder-sync");
    assert.ok(micReady >= 0 && rendererSync >= 0 && micReady < rendererSync);
});

test('Rust encoder graph preserves pre-FX and post-FX taps before the master fader', () => {
    const pre = rustRoutingSource.indexOf('let tee_pre = MultiTeeSource::new(');
    const dsp = rustRoutingSource.indexOf('let dsp = DynamicDspSource::new(tee_pre');
    const post = rustRoutingSource.indexOf('let tee_post = MultiTeeSource::new(', dsp);
    const fader = rustRoutingSource.indexOf('let faded = FaderSource::new(', post);
    assert.ok(pre >= 0 && pre < dsp && dsp < post && post < fader);
});

test('Rust encoder rings count drops lock-free and expose readiness telemetry', () => {
    assert.match(rustTeeSource, /counter\.fetch_add\(1, Ordering::Relaxed\)/);
    assert.match(rustEmitSource, /\\"tap\\":\{\{\\"active\\":\{\},\\"ready\\":\{\},\\"mode\\":\\"\{\}\\",\\"droppedSamples\\":\{\}\}\}/);
    assert.match(rustSource, /state\.encoder_tap_pre_drops\.store\(0, Ordering::Relaxed\)/);
    assert.match(rustSource, /state\.encoder_tap_post_drops\.store\(0, Ordering::Relaxed\)/);
    assert.match(rustSource, /encoder_tap_active\.load\(Ordering::Relaxed\)/);
    assert.match(rustTeeSource, /\.is_some_and\(\|params\| !params\.encoder_tap_active\.load\(Ordering::Relaxed\)\)/);
});

test('input encoder routes are isolated from master PCM fanout', () => {
    assert.match(rustSource, /feed_input_encoder_routes\(&mut state\);/);
    assert.match(rustSource, /write_master_pcm_to_encoder_servers\(&mut state, &chunk\.bytes\)/);
    assert.match(rustEncoderSource, /if state\.encoder_input_routes\.contains_key\(&server_id\) \{\s*continue;/);
    assert.match(rustEncoderSource, /state\.input\.drain_consumer_id\(&route\.consumer_id, 4096\)/);
    assert.match(rustEncoderSource, /drained\.to_s16le_stereo_bytes\(\)/);
});
