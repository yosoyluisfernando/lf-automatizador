'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const test = require('node:test');

const {
    TYPES,
    CodecFrameAccumulator,
    UltravoxParser,
    UltravoxSource,
    encodeControlFrame,
    encodeUvoxFrame,
    encryptXteaHex,
} = require('../backend/encoder/ultravox');

function decodeSingle(buffer) {
    const parser = new UltravoxParser();
    const frames = parser.push(buffer);
    assert.strictEqual(frames.length, 1);
    return frames[0];
}

function ack(type, text) {
    return encodeControlFrame(type, text);
}

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.timeoutCalls = [];
        this.destroyed = false;
    }
    setTimeout(value) { this.timeoutCalls.push(value); }
    connect(_port, _host, callback) { callback(); }
    write(data) {
        this.writes.push(Buffer.from(data));
        return true;
    }
    destroy() {
        this.destroyed = true;
        this.emit('close');
    }
}

test('Ultravox cipher request matches the canonical 2.1 packet bytes', () => {
    assert.deepStrictEqual(
        encodeControlFrame(TYPES.REQUEST_CIPHER, '2.1'),
        Buffer.from([0x5a, 0x00, 0x10, 0x09, 0x00, 0x04, 0x32, 0x2e, 0x31, 0x00, 0x00])
    );
});

test('Ultravox parser handles fragmented and coalesced frames', () => {
    const parser = new UltravoxParser();
    const one = encodeControlFrame(TYPES.REQUEST_CIPHER, 'ACK:key');
    const two = encodeControlFrame(TYPES.AUTHENTICATE, 'ACK:2.1:Allow');
    assert.deepStrictEqual(parser.push(one.subarray(0, 4)), []);
    const frames = parser.push(Buffer.concat([one.subarray(4), two]));
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].type, TYPES.REQUEST_CIPHER);
    assert.strictEqual(frames[0].text, 'ACK:key');
    assert.strictEqual(frames[1].text, 'ACK:2.1:Allow');
});

test('XTEA encryption matches the standard zero-block vector', () => {
    assert.strictEqual(encryptXteaHex(Buffer.alloc(8), Buffer.alloc(16)), 'dee9d4d8f7131ed9');
});

test('native SHOUTcast2 source completes the ordered Ultravox handshake', () => {
    const socket = new FakeSocket();
    let ready = false;
    const source = new UltravoxSource({
        socket,
        config: {
            ip: '127.0.0.1', port: '8000', user: 'source', password: 'secret',
            mount: '2', codec: 'aac', bitrate: '128', icyName: 'Radio', icyGenre: 'Pop',
        },
        onReady: () => { ready = true; },
        onError: error => assert.fail(error.message),
    });

    source.connect();
    assert.strictEqual(decodeSingle(socket.writes.shift()).type, TYPES.REQUEST_CIPHER);
    socket.emit('data', ack(TYPES.REQUEST_CIPHER, 'ACK:0123456789abcdef'));
    assert.strictEqual(decodeSingle(socket.writes.shift()).type, TYPES.AUTHENTICATE);
    socket.emit('data', ack(TYPES.AUTHENTICATE, 'ACK:2.1:Allow'));

    const expectedTypes = [
        TYPES.SET_MIME, TYPES.SETUP, TYPES.NEGOTIATE_BUFFER, TYPES.NEGOTIATE_PAYLOAD,
        TYPES.ICY_NAME, TYPES.ICY_GENRE, TYPES.ICY_URL, TYPES.ICY_PUBLIC, TYPES.STANDBY,
    ];
    for (const expectedType of expectedTypes) {
        const sent = decodeSingle(socket.writes.shift());
        assert.strictEqual(sent.type, expectedType);
        socket.emit('data', ack(expectedType, expectedType === TYPES.STANDBY ? 'ACK:Data transfer mode' : 'ACK'));
    }

    assert.strictEqual(ready, true);
    assert.strictEqual(source.live, true);
    assert.deepStrictEqual(socket.timeoutCalls, [10000, 0]);
});

test('native Ultravox source completes its handshake over a real TCP socket', async () => {
    const receivedTypes = [];
    const expectedConfigTypes = new Set([
        TYPES.SET_MIME, TYPES.SETUP, TYPES.NEGOTIATE_BUFFER, TYPES.NEGOTIATE_PAYLOAD,
        TYPES.ICY_NAME, TYPES.ICY_GENRE, TYPES.ICY_URL, TYPES.ICY_PUBLIC,
    ]);
    const server = net.createServer(socket => {
        const parser = new UltravoxParser();
        socket.on('data', chunk => {
            for (const frame of parser.push(chunk)) {
                receivedTypes.push(frame.type);
                if (frame.type === TYPES.REQUEST_CIPHER) {
                    const response = ack(frame.type, 'ACK:0123456789abcdef');
                    socket.write(response.subarray(0, 4));
                    socket.write(response.subarray(4));
                } else if (frame.type === TYPES.AUTHENTICATE) {
                    socket.write(ack(frame.type, 'ACK:2.1:Allow'));
                } else if (frame.type === TYPES.STANDBY) {
                    socket.write(ack(frame.type, 'ACK:Data transfer mode'));
                } else if (expectedConfigTypes.has(frame.type)) {
                    socket.write(ack(frame.type, frame.type === TYPES.NEGOTIATE_PAYLOAD ? 'ACK:16377' : 'ACK'));
                }
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const source = new UltravoxSource({
        config: {
            ip: '127.0.0.1', port: address.port, user: 'source', password: 'secret',
            mount: '2', codec: 'mp3', bitrate: '128', icyName: 'TCP Test',
        },
    });
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('timeout esperando Ultravox TCP listo')), 2000);
            source.on('ready', () => {
                clearTimeout(timeout);
                resolve();
            });
            source.on('failure', reject);
            source.connect();
        });
        assert.strictEqual(source.live, true);
        assert.deepStrictEqual(receivedTypes, [
            TYPES.REQUEST_CIPHER, TYPES.AUTHENTICATE,
            TYPES.SET_MIME, TYPES.SETUP, TYPES.NEGOTIATE_BUFFER, TYPES.NEGOTIATE_PAYLOAD,
            TYPES.ICY_NAME, TYPES.ICY_GENRE, TYPES.ICY_URL, TYPES.ICY_PUBLIC, TYPES.STANDBY,
        ]);
    } finally {
        source.terminate();
        await new Promise(resolve => server.close(resolve));
    }
});

test('ADTS accumulator emits complete frames across arbitrary chunk boundaries', () => {
    const adtsFrame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 0x11, 0x22, 0x33, 0x44]);
    const accumulator = new CodecFrameAccumulator('aac');
    assert.deepStrictEqual(accumulator.push(adtsFrame.subarray(0, 5)), []);
    const frames = accumulator.push(adtsFrame.subarray(5));
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual(frames[0], adtsFrame);
});

test('MP3 accumulator emits a complete MPEG1 Layer III frame across chunk boundaries', () => {
    const mp3Frame = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(mp3Frame);
    const accumulator = new CodecFrameAccumulator('mp3');
    assert.deepStrictEqual(accumulator.push(mp3Frame.subarray(0, 100)), []);
    const frames = accumulator.push(mp3Frame.subarray(100));
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual(frames[0], mp3Frame);
});

test('native Ultravox authentication NAK is classified as permanent auth failure', () => {
    const socket = new FakeSocket();
    let failure = null;
    const source = new UltravoxSource({
        socket,
        config: {
            ip: '127.0.0.1', port: '8000', user: 'source', password: 'wrong',
            mount: '1', codec: 'mp3', bitrate: '128',
        },
        onError: error => { failure = error; },
    });
    source.connect();
    socket.emit('data', ack(TYPES.REQUEST_CIPHER, 'ACK:0123456789abcdef'));
    socket.emit('data', ack(TYPES.AUTHENTICATE, 'NAK:2.1:Deny'));
    assert.ok(failure);
    assert.strictEqual(failure.category, 'auth');
    assert.strictEqual(failure.retryable, false);
});

test('native Ultravox authentication closes the socket and classifies a terse NAK as auth failure', () => {
    const socket = new FakeSocket();
    let failure = null;
    const source = new UltravoxSource({
        socket,
        config: {
            ip: '127.0.0.1', port: '8000', user: 'source', password: 'wrong',
            mount: '1', codec: 'mp3', bitrate: '128',
        },
        onError: error => { failure = error; },
    });
    source.connect();
    socket.emit('data', ack(TYPES.REQUEST_CIPHER, 'ACK:0123456789abcdef'));
    socket.emit('data', ack(TYPES.AUTHENTICATE, 'NAK'));
    assert.ok(failure);
    assert.strictEqual(failure.category, 'auth');
    assert.strictEqual(failure.retryable, false);
    assert.strictEqual(socket.destroyed, true);
});

test('live Ultravox source wraps AAC frames and terminates cleanly', () => {
    const socket = new FakeSocket();
    const source = new UltravoxSource({
        socket,
        config: { codec: 'aac', bitrate: '128' },
    });
    source.live = true;
    const adtsFrame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 0x11, 0x22, 0x33, 0x44]);
    source.writeAudio(adtsFrame);
    assert.strictEqual(decodeSingle(socket.writes.shift()).type, TYPES.AAC_LC_DATA);

    source.terminate();
    assert.strictEqual(decodeSingle(socket.writes.shift()).type, TYPES.TERMINATE);
    assert.strictEqual(socket._lfIntentionalClose, true);
    assert.strictEqual(socket.destroyed, true);
});

test('live Ultravox source sends XML metadata through flush and metadata frames', () => {
    const socket = new FakeSocket();
    const source = new UltravoxSource({
        socket,
        config: { codec: 'mp3', bitrate: '128' },
    });
    source.live = true;
    assert.strictEqual(source.updateMetadata('Artist & Title'), true);

    assert.strictEqual(decodeSingle(socket.writes.shift()).type, TYPES.FLUSH_METADATA);
    const metadata = decodeSingle(socket.writes.shift());
    assert.strictEqual(metadata.type, TYPES.XML_METADATA);
    assert.strictEqual(metadata.payload.readUInt16BE(0), 1);
    assert.strictEqual(metadata.payload.readUInt16BE(2), 1);
    assert.strictEqual(metadata.payload.readUInt16BE(4), 1);
    assert.match(metadata.payload.subarray(6).toString('utf8'), /Artist &amp; Title/);
});

test('live Ultravox source bounds queued audio while TCP is backpressured', () => {
    const socket = new FakeSocket();
    let acceptWrites = false;
    socket.write = data => {
        socket.writes.push(Buffer.from(data));
        return acceptWrites;
    };
    const source = new UltravoxSource({
        socket,
        config: { codec: 'mp3', bitrate: '128' },
        maxQueuedAudioBytes: 500,
    });
    source.live = true;
    const mp3Frame = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(mp3Frame);

    assert.strictEqual(source.writeAudio(mp3Frame), true);
    assert.strictEqual(source.writeAudio(mp3Frame), true);
    assert.strictEqual(source.writeAudio(mp3Frame), false);
    assert.strictEqual(source.failed, true);

    acceptWrites = true;
    socket.emit('drain');
    assert.strictEqual(socket.destroyed, true);
});

test('live Ultravox metadata stays ordered behind queued audio during TCP backpressure', () => {
    const socket = new FakeSocket();
    let acceptWrites = false;
    socket.write = data => {
        socket.writes.push(Buffer.from(data));
        return acceptWrites;
    };
    const source = new UltravoxSource({
        socket,
        config: { codec: 'mp3', bitrate: '128' },
        maxQueuedAudioBytes: 2048,
    });
    source.live = true;
    const mp3Frame = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(mp3Frame);

    assert.strictEqual(source.writeAudio(mp3Frame), true);
    assert.strictEqual(source.writeAudio(mp3Frame), true);
    assert.strictEqual(source.updateMetadata('Queued title'), true);
    assert.strictEqual(socket.writes.length, 1);

    acceptWrites = true;
    socket.emit('drain');
    assert.deepStrictEqual(
        socket.writes.map(frame => decodeSingle(frame).type),
        [TYPES.MP3_DATA, TYPES.MP3_DATA, TYPES.FLUSH_METADATA, TYPES.XML_METADATA]
    );
});
