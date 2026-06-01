'use strict';

const assert = require('assert');
const path = require('path');
const test = require('node:test');

const rules = require('../frontend/pisador_rules');

test('pisador ids expose four frozen portable slots', () => {
    assert.deepStrictEqual(rules.PISADOR_IDS, ['p1', 'p2', 'p3', 'p4']);
    assert.strictEqual(Object.isFrozen(rules.PISADOR_IDS), true);
});

test('legacy file paths remain file sources and serialize as raw paths', () => {
    const filePath = 'C:\\Radio\\id.mp3';
    assert.deepStrictEqual(rules.parsePisadorSource(filePath), {
        v: 1, kind: 'file', path: filePath
    });
    assert.strictEqual(rules.serializePisadorSource({ kind: 'file', path: filePath }), filePath);
});

test('folder and builtin sources round-trip as portable JSON', () => {
    const folder = { v: 1, kind: 'folder', path: '/home/radio/pisadores' };
    assert.deepStrictEqual(rules.parsePisadorSource(rules.serializePisadorSource(folder)), folder);
    assert.deepStrictEqual(
        rules.parsePisadorSource(rules.serializePisadorSource({ v: 1, kind: 'builtin', name: 'temperature' })),
        { v: 1, kind: 'builtin', name: 'temperature' }
    );
});

test('source normalization rejects unknown kinds and builtin names', () => {
    assert.strictEqual(rules.normalizePisadorSource({ kind: 'stream', path: '/radio/live' }), null);
    assert.strictEqual(rules.normalizePisadorSource({ kind: 'builtin', name: 'wind' }), null);
});

test('legacy source strings are trimmed and blank strings are rejected', () => {
    assert.deepStrictEqual(rules.normalizePisadorSource('  C:\\Radio\\id.mp3  '), {
        v: 1, kind: 'file', path: 'C:\\Radio\\id.mp3'
    });
    assert.strictEqual(rules.normalizePisadorSource('   '), null);
});

test('source normalization rejects unsupported explicit versions', () => {
    const versionTwo = { v: 2, kind: 'folder', path: '/radio/ids' };
    assert.strictEqual(rules.normalizePisadorSource(versionTwo), null);
    assert.strictEqual(rules.parsePisadorSource(JSON.stringify(versionTwo)), null);
});

test('pisador options normalize and serialize approved overflow policies', () => {
    assert.deepStrictEqual(rules.normalizePisadorOptions(null), { v: 1, overflowPolicy: 'skip' });
    assert.deepStrictEqual(
        rules.normalizePisadorOptions({ overflowPolicy: 'truncate-at-intro' }),
        { v: 1, overflowPolicy: 'truncate-at-intro' }
    );
    assert.deepStrictEqual(
        JSON.parse(rules.serializePisadorOptions({ overflowPolicy: 'allow-overlap' })),
        { v: 1, overflowPolicy: 'allow-overlap' }
    );
    assert.deepStrictEqual(
        rules.normalizePisadorOptions({ overflowPolicy: 'unexpected' }),
        { v: 1, overflowPolicy: 'skip' }
    );
});

test('dynamic anchors map to the approved mode and symbolic time', () => {
    assert.deepStrictEqual(rules.conditionToStorage('intro'), { mode: 'end', time: 'intro' });
    assert.deepStrictEqual(rules.conditionToStorage('outro'), { mode: 'start', time: 'outro' });
    assert.strictEqual(rules.storageToCondition('end', 'intro'), 'intro');
    assert.strictEqual(rules.storageToCondition('start', 'outro'), 'outro');
});

test('manual anchors preserve their time and default to start mode', () => {
    assert.deepStrictEqual(rules.conditionToStorage('end', 7.5), { mode: 'end', time: 7.5 });
    assert.deepStrictEqual(rules.conditionToStorage('unexpected', 3), { mode: 'start', time: 3 });
    assert.strictEqual(rules.storageToCondition('end', 7.5), 'end');
    assert.strictEqual(rules.storageToCondition('unexpected', 3), 'start');
});

test('missing, non-numeric and non-positive dynamic markers are rejected', () => {
    assert.deepStrictEqual(rules.validateDynamicAnchor('intro', { intro: 0, outro: 9 }), {
        ok: false, marker: 'intro'
    });
    assert.deepStrictEqual(rules.validateDynamicAnchor('intro', { intro: 'not-a-number' }), {
        ok: false, marker: 'intro'
    });
    assert.deepStrictEqual(rules.validateDynamicAnchor('intro'), {
        ok: false, marker: 'intro'
    });
    assert.deepStrictEqual(rules.validateDynamicAnchor('outro', { intro: 4, outro: 12 }), {
        ok: true, marker: 'outro', seconds: 12
    });
});

test('quick rules normalize folder source, scope, priority and start time', () => {
    assert.deepStrictEqual(rules.normalizeQuickRule({
        source: { kind: 'folder', path: '/radio/ids' },
        startSeconds: '8.25',
        advancedPolicy: 'ignore',
        scope: 'path'
    }), {
        v: 1,
        source: { v: 1, kind: 'folder', path: '/radio/ids' },
        startSeconds: 8.25,
        advancedPolicy: 'ignore',
        scope: 'path'
    });
});

test('quick rules apply defaults and reject invalid sources or start times', () => {
    assert.deepStrictEqual(rules.normalizeQuickRule({
        source: { kind: 'builtin', name: 'humidity' },
        startSeconds: 0
    }), {
        v: 1,
        source: { v: 1, kind: 'builtin', name: 'humidity' },
        startSeconds: 0,
        advancedPolicy: 'respect',
        scope: 'row'
    });
    assert.deepStrictEqual(rules.normalizeQuickRule({
        source: { kind: 'builtin', name: 'time' },
        startSeconds: '0'
    }), {
        v: 1,
        source: { v: 1, kind: 'builtin', name: 'time' },
        startSeconds: 0,
        advancedPolicy: 'respect',
        scope: 'row'
    });
    assert.strictEqual(rules.normalizeQuickRule({ source: { kind: 'builtin', name: 'wind' }, startSeconds: 1 }), null);
    assert.strictEqual(rules.normalizeQuickRule({ source: '/radio/id.mp3', startSeconds: -1 }), null);
    for (const startSeconds of [null, undefined, '', '   ', true, false]) {
        assert.strictEqual(rules.normalizeQuickRule({ source: '/radio/id.mp3', startSeconds }), null);
    }
});

test('path keys use platform-specific resolution and are case-insensitive only on Windows', () => {
    const win = rules.normalizeRulePathKey('C:\\Radio\\IDS', 'win32');
    const winLower = rules.normalizeRulePathKey('c:\\radio\\ids', 'win32');
    assert.strictEqual(win, path.win32.resolve('C:\\Radio\\IDS').toLowerCase());
    assert.strictEqual(win, winLower);
    assert.strictEqual(
        rules.normalizeRulePathKey('/Radio/IDS', 'linux') === rules.normalizeRulePathKey('/radio/ids', 'linux'),
        false
    );
    assert.strictEqual(rules.normalizeRulePathKey('/Radio/IDS', 'linux'), path.posix.resolve('/Radio/IDS'));
    assert.strictEqual(rules.normalizeRulePathKey('Folder\\Child', 'darwin'), path.posix.resolve('Folder\\Child'));
});
