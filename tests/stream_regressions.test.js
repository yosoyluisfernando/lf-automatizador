'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');
const {
    StreamProxy,
    PCM_BYTES_PER_SECOND,
    normalizePrebufferSeconds,
    ringBufferSecondsForPrebuffer,
} = require('../backend/stream_proxy');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `No se encontro function ${name}`);
    // Primero encontrar el cierre de la lista de parámetros para no confundir
    // llaves de desestructuración (p.ej. { fadeSeconds = 0 } = {}) con la
    // llave de apertura del cuerpo de la función.
    let parenDepth = 0;
    let afterParams = -1;
    for (let i = source.indexOf('(', start); i < source.length; i++) {
        if (source[i] === '(') parenDepth++;
        else if (source[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { afterParams = i + 1; break; }
        }
    }
    if (afterParams < 0) throw new Error(`No se pudo encontrar los parámetros de function ${name}`);
    const braceStart = source.indexOf('{', afterParams);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        if (depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`No se pudo extraer function ${name}`);
}

function runPlayNextWithSelfQueuedStream(modeLoopPlaylist) {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const playNextSource = extractFunction(source, 'playNext');
    const nextRow = { id: 'next-track', dataset: {}, parentNode: {}, closest: () => tbody };
    const streamRow = {
        id: 'active-stream',
        parentNode: {},
        nextElementSibling: nextRow,
        closest: () => tbody,
    };
    const tbody = { firstElementChild: streamRow };
    let played = null;
    let stopped = false;
    const context = {
        console,
        crossfadeTriggered: true,
        crossfadeTriggeredForRow: streamRow,
        playbackFatalHalt: false,
        getUpcomingEventWithinPreHold: () => null,
        queuedNextRow: streamRow,
        currentPlayingRow: streamRow,
        document: { body: { contains: row => row === streamRow || row === nextRow } },
        generalPrefs: { modeLoopPlaylist, playbackMode: modeLoopPlaylist ? 'infinite' : 'normal' },
        getPlaybackMode: () => modeLoopPlaylist ? 'infinite' : 'normal',
        isInfinitePlaybackMode: () => modeLoopPlaylist === true,
        isRowAfterAnchor: (row, anchor) => row === nextRow && anchor === streamRow,
        resolveNextOperationalRow: row => row,
        resolvePriorityNextRow: row => row,
        tbodys: [tbody],
        pgmTab: 0,
        playRow: row => { played = row; },
        stopAll: () => { stopped = true; },
    };
    vm.createContext(context);
    vm.runInContext(`${playNextSource}; playNext(false);`, context);

    return { played, stopped, nextRow };
}

function runPlayNextWithManualBackwardSelection() {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const playNextSource = extractFunction(source, 'playNext');
    const previousRow = { id: 'previous-track', dataset: { manualNext: 'true' }, parentNode: {}, closest: () => tbody };
    const nextRow = { id: 'next-track', dataset: {}, parentNode: {}, closest: () => tbody };
    const streamRow = { id: 'active-stream', dataset: {}, parentNode: {}, nextElementSibling: nextRow, closest: () => tbody };
    const tbody = { firstElementChild: previousRow };
    let played = null;
    const context = {
        console,
        crossfadeTriggered: false,
        crossfadeTriggeredForRow: null,
        playbackFatalHalt: false,
        getUpcomingEventWithinPreHold: () => null,
        queuedNextRow: previousRow,
        currentPlayingRow: streamRow,
        document: { body: { contains: row => [previousRow, streamRow, nextRow].includes(row) } },
        generalPrefs: { modeLoopPlaylist: false, playbackMode: 'normal' },
        getPlaybackMode: () => 'normal',
        isInfinitePlaybackMode: () => false,
        isRowAfterAnchor: row => row === nextRow,
        resolveNextOperationalRow: row => row,
        resolvePriorityNextRow: row => row,
        tbodys: [tbody],
        pgmTab: 0,
        playRow: row => { played = row; },
        stopAll: () => {},
    };
    vm.createContext(context);
    vm.runInContext(`${playNextSource}; playNext(false);`, context);
    return { played, previousRow };
}

test('playNext falls back to the natural sibling when queuedNextRow still points at the active stream', () => {
    const { played, stopped, nextRow } = runPlayNextWithSelfQueuedStream(false);
    assert.strictEqual(played, nextRow);
    assert.strictEqual(stopped, false);
});

test('playNext does not restart an active stream that still points at itself when playlist loop is enabled', () => {
    const { played, stopped, nextRow } = runPlayNextWithSelfQueuedStream(true);
    assert.strictEqual(played, nextRow);
    assert.strictEqual(stopped, false);
});

test('playNext preserves an intentional manual selection behind the active stream', () => {
    const { played, previousRow } = runPlayNextWithManualBackwardSelection();
    assert.strictEqual(played, previousRow);
});

test('resolvePriorityNextRow keeps an immediate critical event ahead of a manual backward selection', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const resolvePriorityNextRowSource = extractFunction(source, 'resolvePriorityNextRow');
    const manualPrevious = { dataset: { manualNext: 'true' }, closest: () => tbody };
    const criticalEvent = { dataset: { eventId: 'legal' } };
    const activeStream = { nextElementSibling: criticalEvent, closest: () => tbody };
    const tbody = {};
    const context = {
        currentPlayingRow: activeStream,
        document: { body: { contains: row => row === activeStream || row === criticalEvent } },
        isRowAfterAnchor: () => false,
        getPlaylistRowEventRank: row => row === criticalEvent ? 3 : 0,
        resolveNextOperationalRow: row => row,
    };
    vm.createContext(context);
    vm.runInContext(resolvePriorityNextRowSource, context);

    assert.strictEqual(context.resolvePriorityNextRow(manualPrevious), criticalEvent);
});

test('playNextAfterFailedStream skips the failed URL instead of selecting it again', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const helperSource = extractFunction(source, 'playNextAfterFailedStream');
    const nextRow = { id: 'next-track' };
    const failedStream = {
        dataset: { manualNext: 'true' },
        nextElementSibling: nextRow,
        classList: { remove: () => {} },
    };
    let advanced = false;
    const context = {
        queuedNextRow: failedStream,
        currentPlayingRow: failedStream,
        failedStream,
        generalPrefs: { modeLoopPlaylist: false },
        isInfinitePlaybackMode: () => false,
        resolveNextOperationalRow: row => row,
        playNext: () => { advanced = true; },
        stopAll: () => {},
    };
    vm.createContext(context);
    vm.runInContext(`${helperSource}; playNextAfterFailedStream(failedStream);`, context);

    assert.strictEqual(context.queuedNextRow, nextRow);
    assert.strictEqual(context.currentPlayingRow, null);
    assert.strictEqual(advanced, true);
});

test('playNextAfterFailedStream stops cleanly when loop resolves back to the only failed URL', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const helperSource = extractFunction(source, 'playNextAfterFailedStream');
    const failedStream = {
        dataset: { manualNext: 'true' },
        nextElementSibling: null,
        classList: { remove: () => {} },
    };
    let advanced = false;
    let stopped = false;
    const context = {
        queuedNextRow: failedStream,
        currentPlayingRow: failedStream,
        failedStream,
        generalPrefs: { modeLoopPlaylist: true },
        isInfinitePlaybackMode: () => true,
        resolveNextOperationalRow: () => failedStream,
        playNext: () => { advanced = true; },
        stopAll: () => { stopped = true; },
    };
    vm.createContext(context);
    vm.runInContext(`${helperSource}; playNextAfterFailedStream(failedStream);`, context);

    assert.strictEqual(context.queuedNextRow, null);
    assert.strictEqual(advanced, false);
    assert.strictEqual(stopped, true);
});

test('stream prebuffer defaults to three seconds and clamps the supported range', () => {
    assert.strictEqual(normalizePrebufferSeconds(), 3);
    assert.strictEqual(normalizePrebufferSeconds('8'), 8);
    assert.strictEqual(normalizePrebufferSeconds(0), 1);
    assert.strictEqual(normalizePrebufferSeconds(20), 15);
    assert.strictEqual(normalizePrebufferSeconds('not-a-number'), 3);
});

test('Rust ring capacity adds fixed headroom to absorb FFmpeg burst', () => {
    assert.strictEqual(ringBufferSecondsForPrebuffer(1), 6);
    assert.strictEqual(ringBufferSecondsForPrebuffer(3), 8);
    assert.strictEqual(ringBufferSecondsForPrebuffer(5), 10);
    assert.strictEqual(ringBufferSecondsForPrebuffer(15), 20);
});

test('stream IPC stops a terminal proxy before removing it from active streams', async () => {
    const streamProxyPath = require.resolve('../backend/stream_proxy');
    const ipcPath = require.resolve('../backend/ipc/stream');
    const originalStreamProxy = require.cache[streamProxyPath];

    class FakeStreamProxy extends EventEmitter {
        constructor() {
            super();
            this.playerId = null;
            this.stopped = false;
            FakeStreamProxy.instances.push(this);
        }

        start(_url, playerId, maxRetries, prebufferSeconds) {
            this.playerId = playerId;
            this.maxRetries = maxRetries;
            this.prebufferSeconds = prebufferSeconds;
        }

        stop() {
            this.stopped = true;
            this.emit('status', 'stopped');
        }
    }
    FakeStreamProxy.instances = [];

    require.cache[streamProxyPath] = {
        id: streamProxyPath,
        filename: streamProxyPath,
        loaded: true,
        exports: { StreamProxy: FakeStreamProxy, normalizePrebufferSeconds },
    };
    delete require.cache[ipcPath];

    try {
        const handlers = new Map();
        const app = new EventEmitter();
        const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
        require('../backend/ipc/stream')({
            ipcMain,
            app,
            ffmpegPath: 'ffmpeg',
            writeLog: () => {},
            rustAudioEngine: {},
        });

        const result = await handlers.get('stream-url-start')(null, {
            url: 'https://example.invalid/radio',
            playerId: 'stream-live',
            displayName: 'Radio test',
            prebufferSeconds: 12,
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(result.success, true);
        const proxy = FakeStreamProxy.instances[0];
        assert.strictEqual(proxy.prebufferSeconds, 12);

        proxy.emit('status', 'error');

        assert.strictEqual(proxy.stopped, true);
        const stopResult = await handlers.get('stream-url-stop')(null, { streamId: result.streamId });
        assert.strictEqual(stopResult.success, false);
    } finally {
        delete require.cache[ipcPath];
        if (originalStreamProxy) require.cache[streamProxyPath] = originalStreamProxy;
        else delete require.cache[streamProxyPath];
    }
});

test('stream IPC starts only the newest proxy when two requests reserve the same player immediately', async () => {
    const streamProxyPath = require.resolve('../backend/stream_proxy');
    const ipcPath = require.resolve('../backend/ipc/stream');
    const originalStreamProxy = require.cache[streamProxyPath];

    class FakeStreamProxy extends EventEmitter {
        constructor() {
            super();
            this.playerId = null;
            this.starts = 0;
            this.stops = 0;
            FakeStreamProxy.instances.push(this);
        }

        start(_url, playerId) {
            this.playerId = playerId;
            this.starts++;
        }

        stop() {
            this.stops++;
            this.emit('status', 'stopped');
        }
    }
    FakeStreamProxy.instances = [];

    require.cache[streamProxyPath] = {
        id: streamProxyPath,
        filename: streamProxyPath,
        loaded: true,
        exports: { StreamProxy: FakeStreamProxy, normalizePrebufferSeconds },
    };
    delete require.cache[ipcPath];

    try {
        const handlers = new Map();
        const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
        require('../backend/ipc/stream')({
            ipcMain,
            app: new EventEmitter(),
            ffmpegPath: 'ffmpeg',
            writeLog: () => {},
            rustAudioEngine: {},
        });

        await handlers.get('stream-url-start')(null, {
            url: 'https://example.invalid/one',
            playerId: 'stream-live',
        });
        await handlers.get('stream-url-start')(null, {
            url: 'https://example.invalid/two',
            playerId: 'stream-live',
        });
        await new Promise(resolve => setImmediate(resolve));

        const [first, second] = FakeStreamProxy.instances;
        assert.strictEqual(first.starts, 0);
        assert.strictEqual(first.stops, 1);
        assert.strictEqual(second.starts, 1);
    } finally {
        delete require.cache[ipcPath];
        if (originalStreamProxy) require.cache[streamProxyPath] = originalStreamProxy;
        else delete require.cache[streamProxyPath];
    }
});

function makeProcess() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.killCount = 0;
    proc.killSignals = [];
    proc.kill = signal => {
        proc.killed = true;
        proc.killCount++;
        proc.killSignals.push(signal);
        return true;
    };
    return proc;
}

function makeProxyHarness() {
    const processes = [];
    const commands = [];
    const sends = [];
    const proxy = new StreamProxy({
        ffmpegPath: 'ffmpeg',
        cp: {
            spawn: () => {
                const proc = makeProcess();
                processes.push(proc);
                return proc;
            },
        },
        engine: {
            command: command => {
                commands.push(command);
                return Promise.resolve({ success: true });
            },
            send: command => {
                sends.push(command);
                return true;
            },
        },
        writeLog: () => {},
    });
    return { proxy, processes, commands, sends };
}

test('StreamProxy ignores PCM that arrives after stop', () => {
    const { proxy, processes, commands, sends } = makeProxyHarness();
    proxy.start('https://example.invalid/radio', 'stream-live');
    proxy.stop();

    processes[0].stdout.emit('data', Buffer.alloc(300000));

    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(sends, [{ cmd: 'stream_stop', player: 'stream-live' }]);
});

test('StreamProxy waits for the configured prebuffer and tells Rust its proportional capacity', () => {
    const { proxy, processes, commands, sends } = makeProxyHarness();
    proxy.start('https://example.invalid/radio', 'stream-live', 3, 5);
    processes[0].stdout.emit('data', Buffer.alloc((PCM_BYTES_PER_SECOND * 5) - 1));

    assert.deepStrictEqual(commands, []);

    processes[0].stdout.emit('data', Buffer.alloc(1));

    assert.deepStrictEqual(commands, [{
        cmd: 'stream_start',
        player: 'stream-live',
        bus: 'master',
        sampleRate: 44100,
        channels: 2,
        gain: 1.0,
        ringBufferSeconds: 10,  // 5 (prebuffer) + 5 (headroom fijo)
    }]);
    assert.strictEqual(sends.at(-1)?.cmd, 'stream_play');
    proxy.stop();
});

test('Rust prepares a URL stream paused and only plays after Node primes the ring buffer', () => {
    const source = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'main.rs'), 'utf8');
    assert.match(source, /"stream_start"[\s\S]*player\.pause\(\)/);
    assert.match(source, /"stream_play"\s*=>[\s\S]*player\.play\(\)/);
});

test('StreamProxy ignores close from an obsolete FFmpeg process', () => {
    const { proxy, processes } = makeProxyHarness();
    proxy.start('https://example.invalid/one', 'stream-live');
    proxy.start('https://example.invalid/two', 'stream-live');
    const [oldProcess, currentProcess] = processes;

    oldProcess.emit('close', 0);
    proxy.stop();

    assert.strictEqual(currentProcess.killCount, 1);
});

test('StreamProxy does not report live after FFmpeg closes during prebuffer startup', async () => {
    const { proxy, processes } = makeProxyHarness();
    const statuses = [];
    proxy.on('status', status => statuses.push(status));
    proxy.start('https://example.invalid/radio', 'stream-live');
    processes[0].stdout.emit('data', Buffer.alloc(300000));
    processes[0].emit('close', 1);

    await new Promise(resolve => setTimeout(resolve, 160));
    proxy.stop();

    assert.strictEqual(statuses.includes('live'), false);
});

test('StreamProxy cancels an obsolete reconnect timer when started again', async () => {
    const { proxy, processes } = makeProxyHarness();
    proxy.start('https://example.invalid/one', 'stream-live');
    processes[0].emit('close', 1);
    proxy.start('https://example.invalid/two', 'stream-live');

    await new Promise(resolve => setTimeout(resolve, 3100));
    proxy.stop();

    assert.strictEqual(processes.length, 2);
});

test('StreamProxy discards buffered PCM before reconnecting', async () => {
    const { proxy, processes, commands } = makeProxyHarness();
    proxy.start('https://example.invalid/radio', 'stream-live');
    processes[0].stdout.emit('data', Buffer.alloc(300000));
    processes[0].emit('close', 1);
    commands.length = 0;
    proxy._spawn();
    processes[1].stdout.emit('data', Buffer.alloc(1));

    await new Promise(resolve => setTimeout(resolve, 160));
    proxy.stop();

    assert.deepStrictEqual(commands, []);
});

test('StreamProxy escalates to SIGKILL when FFmpeg does not close after SIGTERM', async () => {
    const { proxy, processes } = makeProxyHarness();
    proxy.start('https://example.invalid/radio', 'stream-live');
    proxy.stop();

    await new Promise(resolve => setTimeout(resolve, 650));

    assert.deepStrictEqual(processes[0].killSignals, ['SIGTERM', 'SIGKILL']);
});

test('stopActiveStream clears the pending connection timeout from the active row', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const stopActiveStreamSource = extractFunction(source, 'stopActiveStream');
    const clearedTimers = [];
    const row = { dataset: { _streamConnectTimeoutId: '41' } };
    const context = {
        streamStopTimer: null,
        currentStreamId: 'stream-1',
        currentPlayingRow: row,
        currentStreamIcyTitle: 'Song',
        streamLiveStartAt: 100,
        streamTimerStopSecs: 20,
        streamMetaMode: 'icy',
        streamCustomMeta: '',
        uiPrefs: {},
        clearTimeout: timer => clearedTimers.push(timer),
        ipcRenderer: { invoke: () => Promise.resolve({ success: true }) },
        document: { getElementById: () => null },
    };
    vm.createContext(context);
    vm.runInContext(`${stopActiveStreamSource}; stopActiveStream();`, context);

    assert.deepStrictEqual(clearedTimers, [41]);
    assert.strictEqual(row.dataset._streamConnectTimeoutId, undefined);
});

test('renderer treats RustAudio timeouts as infrastructure incidents instead of skipping playlist rows', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    assert.match(source, /function isRustInfrastructureFailure\(/);
    assert.match(source, /function recoverRustAudioAfterInfrastructureFailure\(/);
    assert.match(source, /if \(isRustInfrastructureFailure\(err\)\) \{\s*recoverRustAudioAfterInfrastructureFailure\(tr, err\);/);
    assert.match(source, /text\.includes\('proceso rustaudio detenido'\)/);
    assert.match(source, /if \(!result\?\.ok\) \{\s*if \(isRustInfrastructureFailure\(result\?\.error\)\) \{\s*recoverRustAudioAfterInfrastructureFailure\(tr, result\.error\);/);
    assert.ok((source.match(/recoverRustAudioAfterInfrastructureFailure\(tr, result\.error\);/g) || []).length >= 2);
});

test('stream URL modal does not expose manual prebuffer control (fixed default)', () => {
    const html = fs.readFileSync(path.join(rootDir, 'frontend', 'index.html'), 'utf8');
    // El control manual de prebuffer fue eliminado: el valor óptimo lo gestiona
    // el backend automáticamente con rate limiting para evitar glitches.
    assert.doesNotMatch(html, /id="add-stream-prebuffer"/);
});

test('renderer persists and forwards the stream URL prebuffer setting', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    assert.match(source, /prebufferSeconds:\s*row\.dataset\.prebufferSeconds/);
    assert.match(source, /prebufferSeconds:\s*item\.prebufferSeconds/);
    assert.match(source, /const prebufferSeconds\s*=\s*Math\.min\(15,\s*Math\.max\(1,/);
    assert.match(source, /prebufferSeconds\s*\n?\s*\}\);/);
});

test('renderer preserves zero stream retries instead of replacing it with the default', () => {
    const source = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');
    const helperSource = extractFunction(source, 'normalizeStreamRetries');
    const context = {};
    vm.createContext(context);
    vm.runInContext(helperSource, context);

    assert.strictEqual(context.normalizeStreamRetries(0), 0);
    assert.strictEqual(context.normalizeStreamRetries('20'), 20);
    assert.strictEqual(context.normalizeStreamRetries('invalid'), 3);
});

test('Rust sizes the live PCM ring from the capacity requested by Node', () => {
    const source = fs.readFileSync(path.join(rootDir, 'audio-engine-rust', 'src', 'main.rs'), 'utf8');
    assert.match(source, /json_get_u64\(&line,\s*"ringBufferSeconds"\)/);
    assert.match(source, /ring_buffer_seconds/);
    assert.match(source, /\*\s*\(ring_buffer_seconds as usize\)/);
});
