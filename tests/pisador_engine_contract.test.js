'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
    AUDIO_ENGINE_COMMANDS,
    RustAudioEngineAdapter
} = require('../frontend/audio_engine_client');

const rustSource = fs.readFileSync(
    path.join(__dirname, '..', 'audio-engine-rust', 'src', 'main.rs'),
    'utf8'
);

test('audio engine exposes cache warmup, cartwall sequence and paused sequence preload commands', () => {
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('cacheDuration'));
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('cartwallSequence'));
    assert.ok(AUDIO_ENGINE_COMMANDS.includes('loadSequence'));
});

test('Rust adapter maps loadSequence without autoplay by default', () => {
    const adapter = new RustAudioEngineAdapter();
    assert.deepStrictEqual(adapter.toRustCommand('loadSequence', {
        player: 'pisador-p1',
        bus: 'jingle',
        paths: ['intro.mp3', 'humidity.mp3'],
        gain: 0.75,
        cacheDir: 'cache'
    }), {
        cmd: 'loadSequence',
        player: 'pisador-p1',
        bus: 'jingle',
        paths: ['intro.mp3', 'humidity.mp3'],
        outputId: 'default',
        gain: 0.75,
        autoplay: false,
        cacheDir: 'cache'
    });
});

test('Rust sequence loader can pause preloaded overlays while cartwall sequences still autoplay', () => {
    assert.match(rustSource, /fn load_audio_player_sequence\([\s\S]*paused: bool/);
    assert.match(rustSource, /if paused \{\s*player\.pause\(\);/);
    assert.match(rustSource, /runtime\.state\.status = if paused \{ "loaded"\.to_string\(\) \} else \{ "playing"\.to_string\(\) \};/);
    assert.match(rustSource, /"loadSequence" => \{/);
    assert.match(rustSource, /load_audio_player_sequence\(&mut state, &player_id, &paths, gain, !autoplay,/);
    assert.match(rustSource, /load_audio_player_sequence\(&mut state, &player_id, &paths, gain, false,/);
});
