'use strict';

const assert = require('assert');
const test = require('node:test');

const { AUDIO_PREFS_DEFAULTS, normalizeAudioPrefs } = require('../frontend/audio_prefs');

test('song separation defaults to 12 hours and is hours-only', () => {
    const prefs = normalizeAudioPrefs({});
    assert.strictEqual(prefs.musicRandomProtectionUnit, 'hours');
    assert.strictEqual(prefs.musicRandomProtectionValue, 12);
    assert.strictEqual(AUDIO_PREFS_DEFAULTS.musicRandomProtectionValue, 12);
});

test('legacy days value migrates to hours capped at 48', () => {
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionUnit: 'days', musicRandomProtectionValue: 1 }).musicRandomProtectionValue, 24);
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionUnit: 'days', musicRandomProtectionValue: 7 }).musicRandomProtectionValue, 48);
    // Esquema mas viejo todavia: musicRandomProtectionDays.
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionDays: 2 }).musicRandomProtectionValue, 48);
});

test('already-migrated hours values are preserved within 1..48', () => {
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionUnit: 'hours', musicRandomProtectionValue: 6 }).musicRandomProtectionValue, 6);
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionUnit: 'hours', musicRandomProtectionValue: 1 }).musicRandomProtectionValue, 1);
    assert.strictEqual(normalizeAudioPrefs({ musicRandomProtectionUnit: 'hours', musicRandomProtectionValue: 99 }).musicRandomProtectionValue, 48);
});

test('migration is idempotent (re-normalizing a migrated object is stable)', () => {
    const once = normalizeAudioPrefs({ musicRandomProtectionUnit: 'days', musicRandomProtectionValue: 1 });
    const twice = normalizeAudioPrefs(once);
    assert.strictEqual(twice.musicRandomProtectionUnit, 'hours');
    assert.strictEqual(twice.musicRandomProtectionValue, 24);
});

test('artist separation is opt-in and clamped to 1..48 hours', () => {
    const def = normalizeAudioPrefs({});
    assert.strictEqual(def.musicArtistSeparationEnabled, false);
    assert.strictEqual(def.musicArtistSeparationHours, 1);
    assert.strictEqual(normalizeAudioPrefs({ musicArtistSeparationEnabled: true, musicArtistSeparationHours: 99 }).musicArtistSeparationHours, 48);
});

test('subfolder policy is one of ask/always/never (default ask)', () => {
    assert.strictEqual(normalizeAudioPrefs({}).randomIncludeSubfolders, 'ask');
    assert.strictEqual(normalizeAudioPrefs({ randomIncludeSubfolders: 'always' }).randomIncludeSubfolders, 'always');
    assert.strictEqual(normalizeAudioPrefs({ randomIncludeSubfolders: 'never' }).randomIncludeSubfolders, 'never');
    assert.strictEqual(normalizeAudioPrefs({ randomIncludeSubfolders: 'garbage' }).randomIncludeSubfolders, 'ask');
});

test('physical memory retention has a 30-day floor', () => {
    assert.strictEqual(normalizeAudioPrefs({ historyRetentionDays: 1 }).historyRetentionDays, 30);
    assert.strictEqual(normalizeAudioPrefs({ historyRetentionDays: 45 }).historyRetentionDays, 45);
    assert.strictEqual(normalizeAudioPrefs({ historyRetentionDays: 999 }).historyRetentionDays, 366);
});
