'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { TYPES, UltravoxParser, encodeControlFrame } = require('./ultravox-fixture-lib');

const rootDir = path.resolve(__dirname, '..');
const enginePath = path.join(rootDir, 'bin', 'lf-audio-engine.exe');
const ffmpegPath = process.env.LF_FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function redact(value) {
    return String(value || '').replace(/"password":"[^"]*"/g, '"password":"***"');
}

class RustEngineProbe {
    constructor() {
        this.messages = [];
        this.stdout = '';
        this.stderr = '';
        this.child = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout.on('data', chunk => this.onStdout(chunk));
        this.child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    }

    onStdout(chunk) {
        this.stdout += chunk.toString();
        for (;;) {
            const idx = this.stdout.indexOf('\n');
            if (idx < 0) return;
            const line = this.stdout.slice(0, idx).trim();
            this.stdout = this.stdout.slice(idx + 1);
            if (!line) continue;
            try {
                this.messages.push(JSON.parse(line));
            } catch {
                this.messages.push({ raw: line });
            }
        }
    }

    send(command) {
        this.child.stdin.write(`${JSON.stringify(command)}\n`);
    }

    waitFor(predicate, timeoutMs, label) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const found = this.messages.find(predicate);
                if (found) {
                    clearInterval(timer);
                    resolve(found);
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Timeout esperando ${label}`));
                }
            }, 25);
        });
    }

    async close() {
        try { this.child.stdin.end(); } catch {}
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                try { this.child.kill(); } catch {}
                resolve();
            }, 1000);
            this.child.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

async function startIcecastFixture({ password, mount }) {
    const state = { requests: [], metadataRequests: [], audioBytes: 0 };
    const server = net.createServer(socket => {
        let header = Buffer.alloc(0);
        let accepted = false;
        socket.on('error', () => {});
        socket.on('data', chunk => {
            if (!accepted) {
                header = Buffer.concat([header, chunk]);
                const headerText = header.toString('latin1');
                const end = headerText.indexOf('\r\n\r\n');
                if (end < 0) return;
                const request = headerText.slice(0, end + 4);
                if (request.startsWith('GET /admin/metadata?')) {
                    const expectedAuth = Buffer.from(`source:${password}`).toString('base64');
                    assert(request.includes(`Authorization: Basic ${expectedAuth}`), request);
                    state.metadataRequests.push(request);
                    socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nOK');
                    accepted = true;
                    return;
                }
                state.requests.push(request);
                const expectedAuth = Buffer.from(`source:${password}`).toString('base64');
                assert(request.startsWith(`SOURCE ${mount} `) || request.startsWith(`PUT ${mount} `), request);
                assert(request.includes(`Authorization: Basic ${expectedAuth}`), request);
                socket.write('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n');
                const rest = header.subarray(Buffer.byteLength(request, 'latin1'));
                state.audioBytes += rest.length;
                accepted = true;
                return;
            }
            state.audioBytes += chunk.length;
        });
    });
    await listen(server);
    return { server, state, port: server.address().port };
}

async function startShoutcastFixture({ password }) {
    const state = { handshakes: [], headers: [], metadataRequests: [], audioBytes: 0 };
    const server = net.createServer(socket => {
        let stage = 'password';
        let buffer = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'password' && buffer.toString('latin1').startsWith('GET /admin.cgi?')) {
                const text = buffer.toString('latin1');
                const end = text.indexOf('\r\n\r\n');
                if (end < 0) return;
                state.metadataRequests.push(text.slice(0, end + 4));
                socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nOK');
                return;
            }
            if (stage === 'password') {
                const text = buffer.toString('latin1');
                const idx = text.indexOf('\r\n');
                if (idx < 0) return;
                const received = text.slice(0, idx);
                state.handshakes.push(received);
                if (received !== password) {
                    socket.write('invalid password\r\n');
                    socket.destroy();
                    return;
                }
                socket.write('OK2\r\n');
                buffer = buffer.subarray(idx + 2);
                stage = 'headers';
            }
            if (stage === 'headers') {
                const text = buffer.toString('latin1');
                const idx = text.indexOf('\r\n\r\n');
                if (idx < 0) return;
                state.headers.push(text.slice(0, idx + 4));
                buffer = buffer.subarray(idx + 4);
                state.audioBytes += buffer.length;
                buffer = Buffer.alloc(0);
                stage = 'audio';
            } else if (stage === 'audio') {
                state.audioBytes += buffer.length;
                buffer = Buffer.alloc(0);
            }
        });
    });
    await listen(server);
    return { server, state, port: server.address().port };
}

async function startUltravoxFixture({ sid = '1' } = {}) {
    const state = { controls: [], metadataRequests: [], audioBytes: 0, audioFrames: 0 };
    const server = net.createServer(socket => {
        const parser = new UltravoxParser();
        let httpBuffer = null;
        socket.on('error', () => {});
        socket.on('data', chunk => {
            if (httpBuffer || chunk.toString('latin1').startsWith('GET /admin.cgi?')) {
                httpBuffer = Buffer.concat([httpBuffer || Buffer.alloc(0), chunk]);
                const text = httpBuffer.toString('latin1');
                if (text.startsWith('GET /admin.cgi?')) {
                    const end = text.indexOf('\r\n\r\n');
                    if (end < 0) return;
                    state.metadataRequests.push(text.slice(0, end + 4));
                    socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nOK');
                    return;
                }
                httpBuffer = null;
            }
            for (const frame of parser.push(chunk)) {
                state.controls.push({ type: frame.type, text: frame.text });
                if (frame.type === TYPES.REQUEST_CIPHER) {
                    socket.write(encodeControlFrame(TYPES.REQUEST_CIPHER, 'ACK:0123456789abcdef'));
                } else if (frame.type === TYPES.AUTHENTICATE) {
                    assert(frame.text.startsWith(`2.1:${sid}:`), frame.text);
                    socket.write(encodeControlFrame(TYPES.AUTHENTICATE, 'ACK:Allow'));
                } else if (frame.type === TYPES.NEGOTIATE_PAYLOAD) {
                    socket.write(encodeControlFrame(TYPES.NEGOTIATE_PAYLOAD, 'ACK:4096'));
                } else if (frame.type === TYPES.STANDBY) {
                    socket.write(encodeControlFrame(TYPES.STANDBY, 'ACK:Data transfer mode'));
                } else if (
                    frame.type === TYPES.SET_MIME
                    || frame.type === TYPES.SETUP
                    || frame.type === TYPES.NEGOTIATE_BUFFER
                    || frame.type === TYPES.ICY_NAME
                    || frame.type === TYPES.ICY_GENRE
                    || frame.type === TYPES.ICY_URL
                    || frame.type === TYPES.ICY_PUBLIC
                ) {
                    socket.write(encodeControlFrame(frame.type, 'ACK'));
                } else if (
                    frame.type === TYPES.MP3_DATA
                    || frame.type === TYPES.AAC_LC_DATA
                    || frame.type === TYPES.AACP_DATA
                ) {
                    state.audioFrames += 1;
                    state.audioBytes += frame.payload.length;
                } else if (frame.type === TYPES.TERMINATE) {
                    socket.destroy();
                }
            }
        });
    });
    await listen(server);
    return { server, state, port: server.address().port };
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

async function writeSyntheticAudio(engine, serverId, chunks = 30) {
    for (let i = 0; i < chunks; i += 1) {
        engine.send({
            module: 'encoder',
            cmd: 'writeSyntheticPcm',
            serverId,
            durationMs: 120,
            sampleRate: 44100
        });
        await sleep(90);
    }
}

async function updateMetadata(engine, command, fixture, label) {
    engine.send({ ...command, cmd: 'updateMetadata', message: `${label} metadata` });
    await engine.waitFor(m => m.module === 'encoder' && m.cmd === 'updateMetadata' && m.ok, 5000, `${label} metadata ok`);
    await engine.waitFor(() => fixture.state.metadataRequests.length > 0, 5000, `${label} metadata recibida`);
    return fixture.state.metadataRequests[0].split('\r\n')[0];
}

function latestServerStatus(engine, serverId) {
    for (let i = engine.messages.length - 1; i >= 0; i -= 1) {
        const message = engine.messages[i];
        if (!Array.isArray(message.encoderServers)) continue;
        const server = message.encoderServers.find(item => item.serverId === serverId);
        if (server) return server;
    }
    return null;
}

async function runIcecastCase() {
    const password = 'lab-icecast-pass';
    const mount = '/lab-stream';
    const fixture = await startIcecastFixture({ password, mount });
    const engine = new RustEngineProbe();
    const serverId = 'lab-icecast';
    try {
        const command = {
            module: 'encoder',
            cmd: 'startIcecast',
            serverId,
            ffmpegPath,
            serverType: 'icecast',
            ip: '127.0.0.1',
            port: String(fixture.port),
            user: 'source',
            password,
            mount,
            codec: 'mp3',
            bitrate: '96',
            icyName: 'LF Lab Icecast',
            icyGenre: 'test'
        };
        engine.send(command);
        await engine.waitFor(m => m.module === 'encoder' && m.cmd === 'startIcecast' && m.ok, 5000, 'startIcecast ok');
        await writeSyntheticAudio(engine, serverId);
        await engine.waitFor(() => fixture.state.audioBytes > 12000, 7000, 'audio Icecast recibido');
        const metadata = await updateMetadata(engine, command, fixture, 'icecast');
        const status = latestServerStatus(engine, serverId);
        assert(status && status.status === 'live', JSON.stringify(status));
        engine.send({ module: 'encoder', cmd: 'stopServer', serverId });
        return { ok: true, audioBytes: fixture.state.audioBytes, request: fixture.state.requests[0].split('\r\n')[0], metadata };
    } finally {
        await engine.close();
        fixture.server.close();
    }
}

async function runShoutcastCase() {
    const password = 'lab-shoutcast-pass';
    const fixture = await startShoutcastFixture({ password });
    const engine = new RustEngineProbe();
    const serverId = 'lab-shoutcast';
    try {
        const command = {
            module: 'encoder',
            cmd: 'startShoutcast',
            serverId,
            ffmpegPath,
            serverType: 'shoutcast',
            ip: '127.0.0.1',
            port: String(fixture.port),
            password,
            codec: 'mp3',
            bitrate: '96',
            icyName: 'LF Lab Shoutcast',
            icyGenre: 'test'
        };
        engine.send(command);
        await engine.waitFor(m => m.module === 'encoder' && m.cmd === 'startShoutcast' && m.ok, 5000, 'startShoutcast ok');
        await writeSyntheticAudio(engine, serverId);
        await engine.waitFor(() => fixture.state.audioBytes > 12000, 7000, 'audio SHOUTcast recibido');
        const metadata = await updateMetadata(engine, command, fixture, 'shoutcast');
        const status = latestServerStatus(engine, serverId);
        assert(status && status.status === 'live', JSON.stringify(status));
        assert(fixture.state.headers[0].includes('icy-name:LF Lab Shoutcast'), fixture.state.headers[0]);
        engine.send({ module: 'encoder', cmd: 'stopServer', serverId });
        return {
            ok: true,
            audioBytes: fixture.state.audioBytes,
            handshake: fixture.state.handshakes[0],
            headerLine: fixture.state.headers[0].split('\r\n')[0],
            metadata
        };
    } finally {
        await engine.close();
        fixture.server.close();
    }
}

async function runShoutcastBadPasswordCase() {
    const fixture = await startShoutcastFixture({ password: 'expected-password' });
    const engine = new RustEngineProbe();
    const serverId = 'lab-shoutcast-bad-password';
    try {
        engine.send({
            module: 'encoder',
            cmd: 'startShoutcast',
            serverId,
            ffmpegPath,
            serverType: 'shoutcast',
            ip: '127.0.0.1',
            port: String(fixture.port),
            password: 'wrong-password',
            codec: 'mp3',
            bitrate: '96',
            icyName: 'LF Lab Bad Password',
            icyGenre: 'test'
        });
        const error = await engine.waitFor(m => m.type === 'error', 5000, 'error de password SHOUTcast');
        assert(/rechazo|password|SHOUTcast/i.test(error.error || error.message || ''), JSON.stringify(error));
        engine.send({ module: 'encoder', cmd: 'serverSnapshot' });
        await sleep(200);
        const status = latestServerStatus(engine, serverId);
        assert(!status, JSON.stringify(status));
        return { ok: true, rejected: true };
    } finally {
        await engine.close();
        fixture.server.close();
    }
}

async function runShoutcast2LegacyCase() {
    const password = 'lab-shoutcast2-legacy-pass';
    const sid = '2';
    const fixture = await startShoutcastFixture({ password: `${password}:#${sid}` });
    const engine = new RustEngineProbe();
    const serverId = 'lab-shoutcast2-legacy';
    try {
        const command = {
            module: 'encoder',
            cmd: 'startShoutcast',
            serverId,
            ffmpegPath,
            serverType: 'shoutcast2',
            legacy: true,
            ip: '127.0.0.1',
            port: String(fixture.port),
            password,
            mount: sid,
            codec: 'mp3',
            bitrate: '96',
            icyName: 'LF Lab Shoutcast2 Legacy',
            icyGenre: 'test'
        };
        engine.send(command);
        await engine.waitFor(m => m.module === 'encoder' && m.cmd === 'startShoutcast' && m.ok, 5000, 'startShoutcast2 legacy ok');
        await writeSyntheticAudio(engine, serverId);
        await engine.waitFor(() => fixture.state.audioBytes > 12000, 7000, 'audio SHOUTcast2 legacy recibido');
        const metadata = await updateMetadata(engine, command, fixture, 'shoutcast2 legacy');
        const status = latestServerStatus(engine, serverId);
        assert(status && status.status === 'live', JSON.stringify(status));
        assert.strictEqual(fixture.state.handshakes[0], `${password}:#${sid}`);
        engine.send({ module: 'encoder', cmd: 'stopServer', serverId });
        return {
            ok: true,
            audioBytes: fixture.state.audioBytes,
            handshake: fixture.state.handshakes[0],
            headerLine: fixture.state.headers[0].split('\r\n')[0],
            metadata
        };
    } finally {
        await engine.close();
        fixture.server.close();
    }
}

async function runShoutcast2UltravoxCase() {
    const sid = '1';
    const fixture = await startUltravoxFixture({ sid });
    const engine = new RustEngineProbe();
    const serverId = 'lab-shoutcast2-ultravox';
    try {
        const command = {
            module: 'encoder',
            cmd: 'startShoutcast',
            serverId,
            ffmpegPath,
            serverType: 'shoutcast2',
            ip: '127.0.0.1',
            port: String(fixture.port),
            password: 'lab-shoutcast2-pass',
            mount: sid,
            codec: 'mp3',
            bitrate: '96',
            icyName: 'LF Lab Shoutcast2',
            icyGenre: 'test'
        };
        engine.send(command);
        await engine.waitFor(m => m.module === 'encoder' && m.cmd === 'startShoutcast' && m.ok, 7000, 'startShoutcast2 ok');
        await writeSyntheticAudio(engine, serverId, 36);
        await engine.waitFor(() => fixture.state.audioBytes > 12000, 9000, 'audio SHOUTcast2 Ultravox recibido');
        const metadata = await updateMetadata(engine, command, fixture, 'shoutcast2 ultravox');
        const status = latestServerStatus(engine, serverId);
        assert(status && status.status === 'live', JSON.stringify(status));
        assert(fixture.state.controls.some(item => item.type === TYPES.AUTHENTICATE), 'sin authenticate');
        assert(fixture.state.controls.some(item => item.type === TYPES.STANDBY), 'sin standby');
        engine.send({ module: 'encoder', cmd: 'stopServer', serverId });
        return {
            ok: true,
            audioBytes: fixture.state.audioBytes,
            audioFrames: fixture.state.audioFrames,
            controls: fixture.state.controls.filter(item => item.type < 0x7000).length,
            metadata
        };
    } finally {
        await engine.close();
        fixture.server.close();
    }
}

async function main() {
    const results = [];
    results.push({ name: 'icecast-direct', ...(await runIcecastCase()) });
    results.push({ name: 'shoutcast-icy-legacy', ...(await runShoutcastCase()) });
    results.push({ name: 'shoutcast-bad-password', ...(await runShoutcastBadPasswordCase()) });
    results.push({ name: 'shoutcast2-legacy-icy', ...(await runShoutcast2LegacyCase()) });
    results.push({ name: 'shoutcast2-ultravox', ...(await runShoutcast2UltravoxCase()) });
    console.log(redact(JSON.stringify({ ok: true, enginePath, ffmpegPath, results }, null, 2)));
}

main().catch(err => {
    console.error(redact(err.stack || err.message || err));
    process.exit(1);
});
