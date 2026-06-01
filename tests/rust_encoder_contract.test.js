'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const windowsSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'windows.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
const rustSource = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'main.rs'), 'utf8');

test('master encoder starts FFmpeg only after Rust PCM readiness succeeds', () => {
    assert.match(
        windowsSource,
        /async function connectEncoderServer\(id, config, attempt\) \{\s*const input = await ensureEncoderInput\(config\);[\s\S]*if \(!isEncoderConnectCurrent\(id, attempt\)\)[\s\S]*const started = startServerFfmpeg\(id, config\);\s*if \(!started\.success\) maybeStopEncoderInput\(\);\s*return started;/
    );
});

test('shared Rust PCM wrapper follows the active tap session after engine recovery', () => {
    assert.match(windowsSource, /isRunning:\s*\(\)\s*=>\s*!!engine\.isRunning\(\)\s*&&\s*engine\.isPcmConsumerAttached\?\.\(\)/);
    assert.doesNotMatch(windowsSource, /isPcmConsumerAttached\?\.\(attached\.sessionId\)/);
});

test('microphone capture no longer launches a duplicate legacy FFmpeg process with id zero', () => {
    assert.doesNotMatch(renderSource, /ipcRenderer\.send\('init-ffmpeg', config\)/);
    assert.match(windowsSource, /const started = startServerFfmpeg\(sid, rendererCapture\);/);
});

test('Rust encoder graph preserves pre-FX and post-FX taps before the master fader', () => {
    const pre = rustSource.indexOf('let tee_pre = MultiTeeSource::new(program_output');
    const dsp = rustSource.indexOf('let dsp = DynamicDspSource::new(tee_pre');
    const post = rustSource.indexOf('let tee_post = MultiTeeSource::new(dsp');
    const fader = rustSource.indexOf('let faded = FaderSource::new(tee_post');
    assert.ok(pre >= 0 && pre < dsp && dsp < post && post < fader);
});

test('Rust encoder rings count drops lock-free and expose readiness telemetry', () => {
    assert.match(rustSource, /counter\.fetch_add\(1, Ordering::Relaxed\)/);
    assert.match(rustSource, /\\"tap\\":\{\{\\"active\\":\{\},\\"ready\\":\{\},\\"mode\\":\\"\{\}\\",\\"droppedSamples\\":\{\}\}\}/);
    assert.match(rustSource, /state\.encoder_tap_pre_drops\.store\(0, Ordering::Relaxed\)/);
    assert.match(rustSource, /state\.encoder_tap_post_drops\.store\(0, Ordering::Relaxed\)/);
    assert.match(rustSource, /encoder_tap_active\.load\(Ordering::Relaxed\)/);
    assert.match(rustSource, /tap\.enabled\.as_ref\(\)\.is_some_and\(\|params\|[\s\S]*!params\.encoder_tap_active\.load\(Ordering::Relaxed\)/);
});
