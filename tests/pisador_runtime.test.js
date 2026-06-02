'use strict';

const assert = require('assert');
const test = require('node:test');

const { prepareOverlaySession } = require('../frontend/pisador_runtime');

function deps(overrides = {}) {
    return {
        listFolderFiles: async () => ['short.mp3', 'long.mp3'],
        getDuration: async file => file.includes('short') ? 3 : 10,
        chooseRandom: values => values[0],
        resolveBuiltin: async source => source.name === 'time' ? ['hrs.mp3', 'min.mp3'] : ['weather.mp3'],
        preloadFile: async plan => ({ ok: true, playerId: plan.playerId }),
        preloadSequence: async plan => ({ ok: true, playerId: plan.playerId }),
        ...overrides
    };
}

test('folder end-at-intro chooses and measures the same fitting file', async () => {
    const session = await prepareOverlaySession({
        sessionId: 7,
        trackPath: '/music/song.mp3',
        startOffset: 0,
        markers: { intro: 5, outro: 30 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'skip' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].resolvedPaths[0], 'short.mp3');
    assert.strictEqual(session.plans[0].duration, 3);
    assert.strictEqual(session.plans[0].triggerTime, 2);
});

test('folder manual end chooses and measures the same fitting file', async () => {
    const session = await prepareOverlaySession({
        sessionId: 14, startOffset: 0, markers: {},
        advanced: [{
            id: 'p2', active: true, mode: 'end', time: '6',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'skip' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].resolvedPaths[0], 'short.mp3');
    assert.strictEqual(session.plans[0].duration, 3);
    assert.strictEqual(session.plans[0].triggerTime, 3);
});

test('respect omits quick rule when an advanced pisador is active', async () => {
    const session = await prepareOverlaySession({
        sessionId: 8, startOffset: 0, markers: {},
        advanced: [{ id: 'p1', active: true, mode: 'start', time: '4', source: { kind: 'file', path: 'id.mp3' } }],
        quickRule: { source: { kind: 'file', path: 'quick.mp3' }, startSeconds: 2, advancedPolicy: 'respect' }
    }, deps({ getDuration: async () => 1 }));
    assert.deepStrictEqual(session.plans.map(plan => plan.id), ['p1']);
});

test('ignore uses quick rule instead of advanced pisadores', async () => {
    const session = await prepareOverlaySession({
        sessionId: 9, startOffset: 0, markers: {},
        advanced: [{ id: 'p1', active: true, mode: 'start', time: '4', source: { kind: 'file', path: 'id.mp3' } }],
        quickRule: { source: { kind: 'file', path: 'quick.mp3' }, startSeconds: 2, advancedPolicy: 'ignore' }
    }, deps({ getDuration: async () => 1 }));
    assert.deepStrictEqual(session.plans.map(plan => plan.id), ['quick']);
});

test('overflow skip cancels a folder when no file fits', async () => {
    const session = await prepareOverlaySession({
        sessionId: 10, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'skip' }
        }]
    }, deps());
    assert.strictEqual(session.plans.length, 0);
    assert.match(session.warnings[0], /no cabe/i);
});

test('overflow truncate starts at the effective beginning and stops at Intro', async () => {
    const session = await prepareOverlaySession({
        sessionId: 12, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'truncate-at-intro' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].triggerTime, 0);
    assert.strictEqual(session.plans[0].stopAt, 2);
});

test('overflow allow-overlap starts at the effective beginning without truncation', async () => {
    const session = await prepareOverlaySession({
        sessionId: 13, startOffset: 0, markers: { intro: 2 },
        advanced: [{
            id: 'p1', active: true, mode: 'end', time: 'intro',
            source: { kind: 'folder', path: '/ids' },
            options: { overflowPolicy: 'allow-overlap' }
        }]
    }, deps());
    assert.strictEqual(session.plans[0].triggerTime, 0);
    assert.strictEqual(session.plans[0].stopAt, null);
});

test('builtin time preloads its exact measured sequence', async () => {
    const session = await prepareOverlaySession({
        sessionId: 11, startOffset: 0, markers: {},
        advanced: [{ id: 'p4', active: true, mode: 'end', time: '10', source: { kind: 'builtin', name: 'time' } }]
    }, deps({ getDuration: async () => 2 }));
    assert.deepStrictEqual(session.plans[0].resolvedPaths, ['hrs.mp3', 'min.mp3']);
    assert.strictEqual(session.plans[0].duration, 4);
    assert.strictEqual(session.plans[0].triggerTime, 6);
});

test('preload failures cancel the affected overlay and preserve a warning', async () => {
    const session = await prepareOverlaySession({
        sessionId: 15, startOffset: 0, markers: {},
        advanced: [{ id: 'p1', active: true, mode: 'start', time: '2', source: { kind: 'file', path: 'id.mp3' } }]
    }, deps({ getDuration: async () => 1, preloadFile: async () => ({ ok: false }) }));
    assert.strictEqual(session.plans.length, 0);
    assert.match(session.warnings[0], /precarga/i);
});
