'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
    replaceAsar,
    resolveBaselineFfmpegPath,
    resolveFfmpegRuntime,
} = require('../backend/utils/ffmpeg_resolver');

const rootDir = path.join(__dirname, '..');
const windowsSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'windows.js'), 'utf8');
const packageJson = require('../package.json');

function makeProbe(capabilities = {}) {
    return executable => ({
        available: capabilities[executable]?.available !== false,
        libfdkAac: capabilities[executable]?.libfdkAac === true,
        libmp3lame: capabilities[executable]?.libmp3lame === true,
    });
}

test('resolveBaselineFfmpegPath gives LF_FFMPEG_PATH precedence', () => {
    const result = resolveBaselineFfmpegPath({
        env: { LF_FFMPEG_PATH: 'C:\\tools\\ffmpeg-custom.exe', FFMPEG_BIN: 'ignored.exe' },
        platform: 'win32',
        existsSync: () => true,
        requireFfmpegStatic: () => 'static.exe',
    });
    assert.strictEqual(result.path, 'C:\\tools\\ffmpeg-custom.exe');
    assert.strictEqual(result.source, 'LF_FFMPEG_PATH');
});

test('replaceAsar does not duplicate an existing unpacked suffix', () => {
    assert.strictEqual(
        replaceAsar('C:\\app\\resources\\app.asar.unpacked\\node_modules\\ffmpeg.exe'),
        'C:\\app\\resources\\app.asar.unpacked\\node_modules\\ffmpeg.exe'
    );
});

test('resolveBaselineFfmpegPath prefers system ffmpeg on Linux public packages', () => {
    const result = resolveBaselineFfmpegPath({
        env: {},
        platform: 'linux',
        existsSync: () => false,
        requireFfmpegStatic: () => '/npm/ffmpeg-static',
    });
    assert.strictEqual(result.path, 'ffmpeg');
    assert.strictEqual(result.source, 'system-path');
});

test('resolveFfmpegRuntime accepts an external FDK override only when it exposes libfdk_aac', () => {
    const accepted = resolveFfmpegRuntime({
        env: { LF_FFMPEG_FDK_PATH: 'ffmpeg-fdk' },
        platform: 'win32',
        existsSync: () => true,
        requireFfmpegStatic: () => 'ffmpeg-base',
        probeCapabilities: makeProbe({
            'ffmpeg-base': { available: true, libmp3lame: true },
            'ffmpeg-fdk': { available: true, libfdkAac: true },
        }),
    });
    assert.strictEqual(accepted.fdk.path, 'ffmpeg-fdk');
    assert.strictEqual(accepted.fdk.capabilities.libfdkAac, true);

    const rejected = resolveFfmpegRuntime({
        env: { LF_FFMPEG_FDK_PATH: 'ffmpeg-no-fdk' },
        platform: 'win32',
        existsSync: () => true,
        requireFfmpegStatic: () => 'ffmpeg-base',
        probeCapabilities: makeProbe({
            'ffmpeg-base': { available: true },
            'ffmpeg-no-fdk': { available: true, libfdkAac: false },
        }),
    });
    assert.strictEqual(rejected.fdk, null);
});

test('resolveFfmpegRuntime reuses the baseline binary for HE-AAC only when it exposes libfdk_aac', () => {
    const runtime = resolveFfmpegRuntime({
        env: {},
        platform: 'win32',
        existsSync: () => true,
        requireFfmpegStatic: () => 'ffmpeg-base',
        probeCapabilities: makeProbe({
            'ffmpeg-base': { available: true, libfdkAac: true, libmp3lame: true },
        }),
    });
    assert.strictEqual(runtime.fdk.path, 'ffmpeg-base');
    assert.strictEqual(runtime.fdk.source, 'baseline-with-libfdk_aac');
});

test('resolveFfmpegRuntime falls back to bundled ffmpeg-static on Linux when system ffmpeg is unavailable', () => {
    const runtime = resolveFfmpegRuntime({
        env: {},
        platform: 'linux',
        existsSync: () => false,
        requireFfmpegStatic: () => '/bundle/ffmpeg',
        probeCapabilities: makeProbe({
            ffmpeg: { available: false },
            '/bundle/ffmpeg': { available: true, libmp3lame: true },
        }),
    });
    assert.strictEqual(runtime.baseline.path, '/bundle/ffmpeg');
    assert.strictEqual(runtime.baseline.source, 'ffmpeg-static-fallback');
    assert.strictEqual(runtime.baseline.capabilities.libmp3lame, true);
});

test('encoder HE-AAC path is strict and never falls back to the native AAC-LC encoder', () => {
    assert.match(windowsSource, /config\.codec === 'aac_he' && !_fdkAacAvailable/);
    assert.match(windowsSource, /const selectedFfmpegPath = config\.codec === 'aac_he' \? ffmpegFdkPath : ffmpegPath;/);
    assert.doesNotMatch(windowsSource, /fallback de AAC\+/);
    assert.doesNotMatch(windowsSource, /transmitiendo como AAC-LC por ahora/);
});

test('public package metadata declares GPL and Linux deb depends on system ffmpeg', () => {
    assert.strictEqual(packageJson.license, 'GPL-3.0-only');
    assert.ok(packageJson.build.deb.depends.includes('ffmpeg'));
});

test('FFmpeg workers use the same runtime resolver as the main process', () => {
    const analysis = fs.readFileSync(path.join(rootDir, 'backend', 'audio_analysis_worker.js'), 'utf8');
    const waveform = fs.readFileSync(path.join(rootDir, 'backend', 'waveform_worker.js'), 'utf8');
    assert.match(analysis, /resolveFfmpegRuntime\(\)\.baseline\.path/);
    assert.match(waveform, /resolveFfmpegRuntime\(\)\.baseline\.path/);
});
