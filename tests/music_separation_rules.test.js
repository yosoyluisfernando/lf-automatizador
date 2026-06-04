'use strict';

const assert = require('assert');
const path = require('path');
const test = require('node:test');

const rules = require('../frontend/music_separation_rules');

test('normalizeArtist strips accents, case and redundant spaces', () => {
    assert.strictEqual(rules.normalizeArtist('  Soda   Stéreo '), 'soda stereo');
    assert.strictEqual(rules.normalizeArtist('CAFÉ Tacvba'), 'cafe tacvba');
    assert.strictEqual(rules.normalizeArtist(null), '');
});

test('normalizeFolderKey is platform-aware and trims trailing separators', () => {
    const a = rules.normalizeFolderKey('/music/rock/');
    const b = rules.normalizeFolderKey('/music/rock');
    assert.strictEqual(a, b);
    if (process.platform === 'win32') {
        assert.strictEqual(rules.normalizeFolderKey('C:\\Music\\Rock'), rules.normalizeFolderKey('c:\\music\\rock'));
    }
});

test('global rules come from normalized prefs (song 12h default, artist off)', () => {
    const g = rules.getGlobalRules({});
    assert.strictEqual(g.songHours, 12);
    assert.strictEqual(g.artistEnabled, false);
    assert.strictEqual(g.artistHours, 1);
    assert.strictEqual(g.includeSubfolders, 'ask');
});

test('folder-specific rules override the global ones', () => {
    const folder = path.resolve('/music/rock');
    const folderRules = { [rules.normalizeFolderKey(folder)]: { songHours: 6, artistEnabled: true, artistHours: 3 } };
    const eff = rules.getEffectiveRules(folder, { musicRandomProtectionValue: 12 }, folderRules);
    assert.strictEqual(eff.songHours, 6);
    assert.strictEqual(eff.artistEnabled, true);
    assert.strictEqual(eff.artistHours, 3);
    assert.strictEqual(eff.source.song, 'folder');
    assert.strictEqual(eff.source.artist, 'folder');
});

test('unset folder fields inherit from global', () => {
    const folder = path.resolve('/music/pop');
    const folderRules = { [rules.normalizeFolderKey(folder)]: { songHours: 4 } };
    const eff = rules.getEffectiveRules(folder, { musicArtistSeparationEnabled: true, musicArtistSeparationHours: 2 }, folderRules);
    assert.strictEqual(eff.songHours, 4);          // de la carpeta
    assert.strictEqual(eff.artistEnabled, true);   // heredado del global
    assert.strictEqual(eff.artistHours, 2);        // heredado del global
    assert.strictEqual(eff.source.artist, 'global');
});

test('out-of-range folder values are clamped to the 1..48 range', () => {
    const folder = path.resolve('/music/jazz');
    const high = { [rules.normalizeFolderKey(folder)]: { songHours: 999 } };
    assert.strictEqual(rules.getEffectiveRules(folder, {}, high).songHours, 48);
    const low = { [rules.normalizeFolderKey(folder)]: { songHours: 0 } };
    assert.strictEqual(rules.getEffectiveRules(folder, {}, low).songHours, 1);
    // Valor no numerico -> se descarta y hereda el global (12).
    const bad = { [rules.normalizeFolderKey(folder)]: { songHours: 'x' } };
    assert.strictEqual(rules.getEffectiveRules(folder, {}, bad).songHours, 12);
});
