'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { RustAudioEngineProbe } = require('../backend/audio_engine_process');

function makeProbe(writeLog = () => {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rust-probe-'));
    fs.mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'bin', process.platform === 'win32' ? 'lf-audio-engine.exe' : 'lf-audio-engine'), '');
    const probe = new RustAudioEngineProbe({ rootDir, writeLog });
    probe.processGeneration = 1;
    probe.command = async () => ({
        success: true,
        message: { type: 'status', encoder: { tap: { active: true, ready: true } } },
    });
    return probe;
}

test('attachPcmConsumer resolves only after Rust ACK and first PCM chunk', async () => {
    const probe = makeProbe();
    const received = [];
    const attaching = probe.attachPcmConsumer(chunk => received.push(chunk), { firstChunkTimeoutMs: 100 });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(probe.isPcmConsumerAttached(), false);

    probe.handleLine(JSON.stringify({ type: 'pcmChunk', pcm: Buffer.from([1, 2, 3]).toString('base64') }));
    const result = await attaching;

    assert.strictEqual(result.success, true);
    assert.ok(result.sessionId);
    assert.strictEqual(probe.isPcmConsumerAttached(result.sessionId), true);
    assert.deepStrictEqual(received, [Buffer.from([1, 2, 3])]);
});

test('attachPcmConsumer fails when Rust does not ACK readiness', async () => {
    const probe = makeProbe();
    const commands = [];
    probe.command = async command => {
        commands.push(command);
        return ({
        success: true,
        message: { type: 'status', encoder: { tap: { active: true, ready: false } } },
        });
    };

    const result = await probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 20 });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /tap PCM no esta listo/i);
    assert.strictEqual(probe.isPcmConsumerAttached(), false);
    assert.ok(commands.some(command => command.cmd === 'encoderTap' && command.enable === false));
});

test('attachPcmConsumer fails explicitly when no first PCM chunk arrives', async () => {
    const probe = makeProbe();
    const commands = [];
    probe.command = async command => {
        commands.push(command);
        return {
            success: true,
            message: { type: 'status', encoder: { tap: { active: true, ready: true } } },
        };
    };
    const result = await probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 20 });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /primer bloque PCM/i);
    assert.strictEqual(probe.isPcmConsumerAttached(), false);
    assert.ok(commands.some(command => command.cmd === 'encoderTap' && command.enable === false));
});

test('detachPcmConsumer resolves an attach cancelled after ACK but before first PCM chunk', async () => {
    const probe = makeProbe();
    const attaching = probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 1000 });
    await new Promise(resolve => setImmediate(resolve));

    probe.detachPcmConsumer();
    const result = await attaching;

    assert.strictEqual(result.success, false);
    assert.match(result.error, /cancelad/i);
});

test('detachPcmConsumer invalidates a confirmed PCM session', async () => {
    const probe = makeProbe();
    const attaching = probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 100 });
    await new Promise(resolve => setImmediate(resolve));
    probe.handleLine(JSON.stringify({ type: 'pcmChunk', pcm: Buffer.from([0, 0]).toString('base64') }));
    const result = await attaching;
    assert.strictEqual(result.success, true);

    probe.detachPcmConsumer();

    assert.strictEqual(probe.isPcmConsumerAttached(result.sessionId), false);
    assert.strictEqual(probe.isPcmTapMode(), false);
});

test('Rust status logs an explicit warning when encoder tap dropped samples increase', () => {
    const logs = [];
    const probe = makeProbe(message => logs.push(message));
    probe.handleLine(JSON.stringify({ type: 'status', encoder: { tap: { droppedSamples: 0 } } }));
    probe.handleLine(JSON.stringify({ type: 'status', encoder: { tap: { droppedSamples: 12 } } }));

    assert.ok(logs.some(message => /perdio 12 muestras PCM/i.test(message)));
});

test('Rust command timeout is classified as an engine-wide unresponsive incident with diagnostics', async () => {
    const logs = [];
    const probe = makeProbe(message => logs.push(message));
    probe.start = () => ({ success: true });
    probe.process = {
        pid: 77,
        killed: false,
        exitCode: null,
        stdin: { write: () => true },
    };
    probe.lastStatusAt = Date.now() - 9000;

    const result = await RustAudioEngineProbe.prototype.command.call(probe, { cmd: 'seek', player: 'player-a' }, 5);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.engineUnresponsive, true);
    assert.strictEqual(result.diagnostics.command, 'seek');
    assert.strictEqual(result.diagnostics.player, 'player-a');
    assert.ok(result.diagnostics.lastStatusAgeMs >= 9000);
});

test('waitForFreshStatus resolves only after a newer Rust heartbeat arrives', async () => {
    const probe = makeProbe();
    const since = Date.now();
    const waiting = probe.waitForFreshStatus(since, 100);
    setTimeout(() => {
        probe.handleLine(JSON.stringify({ type: 'status', updatedAt: Date.now(), players: [] }));
    }, 5);

    assert.strictEqual(await waiting, true);
});

test('stale PCM attach ACK does not cancel a newer PCM session', async () => {
    const probe = makeProbe();
    const resolvers = [];
    probe.command = () => new Promise(resolve => resolvers.push(resolve));
    const first = probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 100 });
    await new Promise(resolve => setImmediate(resolve));
    const second = probe.attachPcmConsumer(() => {}, { firstChunkTimeoutMs: 100 });
    await new Promise(resolve => setImmediate(resolve));

    resolvers[0]({ success: true, message: { encoder: { tap: { active: true, ready: true } } } });
    const firstResult = await first;

    assert.strictEqual(firstResult.success, false);
    assert.ok(probe.pcmSession, 'la sesion nueva debe permanecer activa');
    assert.strictEqual(probe.pcmSession.id, 'pcm-1-2');

    resolvers[1]({ success: true, message: { encoder: { tap: { active: true, ready: true } } } });
    await new Promise(resolve => setImmediate(resolve));
    probe.handleLine(JSON.stringify({ type: 'pcmChunk', pcm: Buffer.from([7, 8]).toString('base64') }));
    assert.strictEqual((await second).success, true);
});

test('recover reattaches an active PCM consumer before reporting success', async () => {
    const probe = makeProbe();
    const consumer = () => {};
    probe.pcmConsumer = consumer;
    probe.pcmSession = { ready: true, generation: 1 };
    let attachedConsumer = null;
    probe.stop = () => { probe.pcmConsumer = null; probe.pcmSession = null; return { success: true }; };
    probe.start = () => ({ success: true });
    probe.command = async () => ({ success: true, message: { type: 'status' } });
    probe.attachPcmConsumer = async callback => { attachedConsumer = callback; return { success: true, sessionId: 'pcm-restored' }; };

    const result = await probe.recover('test');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pcmRestored, true);
    assert.strictEqual(attachedConsumer, consumer);
});
