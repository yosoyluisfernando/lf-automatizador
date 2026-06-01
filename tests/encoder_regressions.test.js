'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');
const windowsSource = fs.readFileSync(path.join(rootDir, 'backend', 'ipc', 'windows.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(rootDir, 'frontend', 'render.js'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `No se encontro function ${name}`);
    const paramsStart = source.indexOf('(', start);
    let paramsDepth = 0;
    let braceStart = -1;
    for (let i = paramsStart; i < source.length; i++) {
        if (source[i] === '(') paramsDepth++;
        if (source[i] === ')') paramsDepth--;
        if (paramsDepth === 0) {
            braceStart = source.indexOf('{', i);
            break;
        }
    }
    assert.notStrictEqual(braceStart, -1, `No se encontro cuerpo de function ${name}`);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        if (depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`No se pudo extraer function ${name}`);
}

function runExtracted(functionNames, context, invocation) {
    vm.createContext(context);
    const definitions = functionNames.map(name => extractFunction(windowsSource, name)).join('\n');
    return vm.runInContext(`${definitions}\n${invocation}`, context);
}

function makeProc() {
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.destroyCalls = 0;
    stdin.destroy = () => {
        stdin.destroyCalls++;
        stdin.destroyed = true;
    };
    return {
        stdin,
        killCalls: [],
        kill(signal) {
            this.killCalls.push(signal);
        },
    };
}

test('killAllEncoderServers closes native SHOUTcast sockets as well as FFmpeg processes', () => {
    const proc = makeProc();
    const socket = {
        destroyed: false,
        destroyCalls: 0,
        destroy() {
            this.destroyCalls++;
            this.destroyed = true;
        },
    };
    const server = { id: 'radio', proc, scSocket: socket };
    const context = {
        context: { encoderServers: new Map([['radio', server]]) },
        getEncoderServer: id => context.context.encoderServers.get(String(id)),
        maybeStopEncoderInput: () => {},
        setServerStatus: () => {},
    };

    runExtracted(['cancelEncoderConnect', 'killAllEncoderServers'], context, 'killAllEncoderServers();');

    assert.strictEqual(server.proc, null);
    assert.strictEqual(server.scSocket, null);
    assert.strictEqual(socket.destroyCalls, 1);
    assert.strictEqual(socket._lfIntentionalClose, true);
    assert.deepStrictEqual(proc.killCalls, ['SIGKILL']);
});

test('killAllEncoderServers terminates native Ultravox sessions before cleanup', () => {
    const proc = makeProc();
    const ultravox = { terminateCalls: 0, terminate() { this.terminateCalls++; } };
    const server = { id: 'radio', proc, scSocket: null, ultravox };
    const context = {
        context: { encoderServers: new Map([['radio', server]]) },
        getEncoderServer: id => context.context.encoderServers.get(String(id)),
        maybeStopEncoderInput: () => {},
        setServerStatus: () => {},
    };

    runExtracted(['cancelEncoderConnect', 'killAllEncoderServers'], context, 'killAllEncoderServers();');

    assert.strictEqual(ultravox.terminateCalls, 1);
    assert.strictEqual(server.ultravox, null);
});

test('writeEncoderAudioChunk skips a slow destination until drain without starving healthy servers', () => {
    const slowStdin = new EventEmitter();
    slowStdin.destroyed = false;
    slowStdin.writeCalls = 0;
    slowStdin.write = () => {
        slowStdin.writeCalls++;
        return false;
    };
    const healthyStdin = new EventEmitter();
    healthyStdin.destroyed = false;
    healthyStdin.writeCalls = 0;
    healthyStdin.write = () => {
        healthyStdin.writeCalls++;
        return true;
    };
    const slow = { id: 'slow', proc: { stdin: slowStdin }, waitingDrain: false };
    const healthy = { id: 'healthy', proc: { stdin: healthyStdin }, waitingDrain: false };
    const encoderServers = new Map([['slow', slow], ['healthy', healthy]]);
    const context = {
        Buffer,
        Date,
        context: {
            encoderServers,
            encoderWriteStats: {
                chunks: 0,
                bytes: 0,
                backpressure: 0,
                flowControlEvents: 0,
                drainEvents: 0,
                maxDrainMs: 0,
                slowDrainEvents: 0,
                lastSummaryAt: Date.now(),
                errors: 0,
            },
        },
        countLiveServers: () => 2,
        updateEncoderInputMeter: () => {},
        reportRustPcmSilence: () => {},
        logEncoderWriteStats: () => {},
        writeLog: () => {},
    };

    runExtracted(['writeEncoderAudioChunk'], context, "writeEncoderAudioChunk(Buffer.from([1, 2]), 'rust-pcm'); writeEncoderAudioChunk(Buffer.from([3, 4]), 'rust-pcm');");

    assert.strictEqual(slowStdin.writeCalls, 1);
    assert.strictEqual(healthyStdin.writeCalls, 2);
    assert.strictEqual(slow.waitingDrain, true);
});

test('intentional SHOUTcast socket closure does not report a transmission failure', () => {
    class FakeSocket extends EventEmitter {
        setTimeout() {}
        connect() {}
        destroy() {
            this.destroyed = true;
            this.emit('close');
        }
    }

    let failures = 0;
    const context = {
        Buffer,
        require: name => {
            assert.strictEqual(name, 'net');
            return { Socket: FakeSocket };
        },
        writeLog: () => {},
        setServerStatus: () => {},
        context: {},
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(windowsSource, 'openShoutcastSocket'), context);
    const socket = context.openShoutcastSocket(
        { serverType: 'shoutcast', ip: '127.0.0.1', port: '8000', password: 'secret', codec: 'mp3' },
        'radio',
        () => {},
        () => { failures++; }
    );
    socket._lfIntentionalClose = true;
    socket.destroy();

    assert.strictEqual(failures, 0);
});

test('application shutdown helper disconnects all encoder servers quietly', () => {
    const calls = [];
    const context = {
        context: { activeEncoderConfig: { source: 'master' } },
        killAllEncoderServers: (reason, options) => calls.push({ reason, options }),
    };

    runExtracted(['shutdownEncoderOnAppQuit'], context, 'shutdownEncoderOnAppQuit();');

    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [{
        reason: '',
        options: { suppressStatus: true, suppressError: true, suppressStopCapture: true },
    }]);
    assert.strictEqual(context.context.activeEncoderConfig, null);
});

test('encoder module registers shutdown cleanup before Electron closes windows', () => {
    assert.match(windowsSource, /context\.app\?\.once\?\.\('before-quit', shutdownEncoderOnAppQuit\)/);
});

test('SHOUTcast handshake timeout stays enabled until ICY authentication succeeds', () => {
    class FakeSocket extends EventEmitter {
        constructor() {
            super();
            this.timeoutCalls = [];
        }
        setTimeout(value) {
            this.timeoutCalls.push(value);
        }
        connect(_port, _host, callback) {
            callback();
        }
        write() {}
    }

    const context = {
        Buffer,
        require: name => {
            assert.strictEqual(name, 'net');
            return { Socket: FakeSocket };
        },
        writeLog: () => {},
        setServerStatus: () => {},
        context: {},
        setTimeout: () => {},
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(windowsSource, 'openShoutcastSocket'), context);
    const socket = context.openShoutcastSocket(
        { serverType: 'shoutcast', ip: '127.0.0.1', port: '8000', password: 'secret', codec: 'mp3' },
        'radio',
        () => {},
        () => {}
    );

    assert.deepStrictEqual(socket.timeoutCalls, [10000]);
    socket.emit('data', Buffer.from('OK2\r\n'));
    assert.deepStrictEqual(socket.timeoutCalls, [10000, 0]);
});

test('SHOUTcast2 ICY compatibility writes password:#SID and then AAC headers after OK2', () => {
    class FakeSocket extends EventEmitter {
        constructor() {
            super();
            this.writes = [];
        }
        setTimeout() {}
        connect(_port, _host, callback) { callback(); }
        write(value) { this.writes.push(String(value)); }
    }
    const context = {
        Buffer,
        require: name => {
            assert.strictEqual(name, 'net');
            return { Socket: FakeSocket };
        },
        writeLog: () => {},
        setServerStatus: () => {},
        context: {},
        setTimeout: () => {},
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(windowsSource, 'openShoutcastSocket'), context);
    const socket = context.openShoutcastSocket(
        {
            serverType: 'shoutcast2', legacy: true, ip: '127.0.0.1', port: '8001',
            password: 'secret', mount: '7', codec: 'aac', bitrate: '64',
        },
        'radio',
        () => {},
        error => assert.fail(error)
    );

    assert.strictEqual(socket.writes[0], 'secret:#7\r\n');
    socket.emit('data', Buffer.from('OK2\r\n'));
    assert.match(socket.writes[1], /content-type:audio\/aacp/);
    assert.match(socket.writes[1], /icy-br:64/);
});

test('Icecast URL preserves configured source user and encodes credentials and mount', () => {
    const context = {};
    const url = runExtracted(
        ['normalizeMount', 'buildStreamUrl'],
        context,
        "buildStreamUrl({ serverType: 'icecast', user: 'custom user', password: 'p@ss word', ip: 'ice.test', port: '8000', mount: 'live feed' });"
    );
    assert.strictEqual(url, 'icecast://custom%20user:p%40ss%20word@ice.test:8000/live%20feed');
});

test('Rust stop notification is emitted only from shared input shutdown', () => {
    assert.strictEqual((windowsSource.match(/notifyRustEncoder\('stop'/g) || []).length, 1);
    assert.match(windowsSource, /if \(!started\.success\) maybeStopEncoderInput\(\);/);
});

test('server replacement marks an existing SHOUTcast socket intentional before destroying it', () => {
    assert.match(
        windowsSource,
        /if \(existing\.scSocket\) \{\s*existing\.scSocket\._lfIntentionalClose = true;\s*try \{ existing\.scSocket\.destroy\(\); \}/
    );
});

test('pre-handshake SHOUTcast audio buffering has an explicit byte limit and failure path', () => {
    assert.match(windowsSource, /const MAX_PRE_HANDSHAKE_AUDIO_BYTES = 2 \* 1024 \* 1024;/);
    assert.match(windowsSource, /if \(audioBufferBytes > MAX_PRE_HANDSHAKE_AUDIO_BYTES\) \{\s*onScFail\('SHOUTcast: el handshake excedio el limite de audio en espera\.'\);/);
});

test('pending encoder attempts are invalidated when the operator disconnects during PCM attach', () => {
    assert.match(windowsSource, /function beginEncoderConnect\(id, config\)/);
    assert.match(windowsSource, /function cancelEncoderConnect\(id\)/);
    assert.match(windowsSource, /if \(!isEncoderConnectCurrent\(id, attempt\)\) \{\s*maybeStopEncoderInput\(\);\s*return \{ success: false, cancelled: true/);
    assert.match(windowsSource, /function killEncoderServer\(id, reason = '', options = \{\}\) \{\s*cancelEncoderConnect\(id\);/);
});

test('shared encoder input remains attached while another server connection is pending', () => {
    assert.match(windowsSource, /if \(countLiveServers\(\) > 0 \|\| context\.pendingEncoderConnects\.size > 0\) return;/);
});

test('renderer microphone capture is explicitly restricted to one destination', () => {
    assert.match(windowsSource, /La entrada externa solo admite un servidor a la vez/);
});

test('native Ultravox errors preserve category and retryability through IPC', () => {
    assert.match(windowsSource, /const onScFail = \(reason, details = \{\}\) =>/);
    assert.match(windowsSource, /onError: error => onScFail\(error\.message \|\| String\(error\), error\)/);
    assert.match(windowsSource, /killEncoderServer\(sid, reason, \{ details \}\)/);
});

test('renderer microphone chunks disconnect a slow WebM destination instead of silently dropping container bytes', () => {
    assert.match(windowsSource, /source === 'renderer' && server\.waitingDrain/);
    assert.match(windowsSource, /WebM/i);
    assert.match(windowsSource, /killEncoderServer\(\s*server\.id/);
});

test('renderer microphone capture uses a generation guard around asynchronous getUserMedia', () => {
    assert.match(renderSource, /liveEncoderCaptureGeneration/);
    assert.match(renderSource, /captureStream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
    assert.match(renderSource, /catch \(err\) \{\s*if \(captureGeneration && captureGeneration !== liveEncoderCaptureGeneration\) return;/);
    assert.match(windowsSource, /rendererEncoderCaptureGeneration/);
    assert.match(windowsSource, /payload\.generation !== context\.rendererEncoderCaptureGeneration/);
});

test('legacy init-ffmpeg IPC no longer bypasses encoder lifecycle validation', () => {
    assert.doesNotMatch(windowsSource, /ipcMain\.on\('init-ffmpeg'/);
});
