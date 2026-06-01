'use strict';

const { EventEmitter } = require('events');
const net = require('net');

const MAX_UVOX_PAYLOAD = 16377;

const TYPES = Object.freeze({
    AUTHENTICATE: 0x1001,
    SETUP: 0x1002,
    NEGOTIATE_BUFFER: 0x1003,
    STANDBY: 0x1004,
    TERMINATE: 0x1005,
    FLUSH_METADATA: 0x1006,
    NEGOTIATE_PAYLOAD: 0x1008,
    REQUEST_CIPHER: 0x1009,
    SET_MIME: 0x1040,
    ICY_NAME: 0x1100,
    ICY_GENRE: 0x1101,
    ICY_URL: 0x1102,
    ICY_PUBLIC: 0x1103,
    XML_METADATA: 0x3902,
    MP3_DATA: 0x7000,
    AAC_LC_DATA: 0x8001,
    AACP_DATA: 0x8003,
});

function encodeUvoxFrame(type, payload = Buffer.alloc(0), reserved = 0) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (data.length > 0xffff) throw new Error(`Payload UVOX demasiado grande: ${data.length}`);
    const output = Buffer.alloc(7 + data.length);
    output[0] = 0x5a;
    output[1] = reserved & 0xff;
    output.writeUInt16BE(type & 0xffff, 2);
    output.writeUInt16BE(data.length, 4);
    data.copy(output, 6);
    output[output.length - 1] = 0;
    return output;
}

function encodeControlFrame(type, text = '') {
    const payload = Buffer.concat([Buffer.from(String(text), 'utf8'), Buffer.from([0])]);
    return encodeUvoxFrame(type, payload);
}

class UltravoxParser {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }

    push(chunk) {
        if (chunk?.length) this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        const frames = [];
        while (this.buffer.length) {
            const marker = this.buffer.indexOf(0x5a);
            if (marker < 0) {
                this.buffer = Buffer.alloc(0);
                break;
            }
            if (marker > 0) this.buffer = this.buffer.subarray(marker);
            if (this.buffer.length < 7) break;
            const length = this.buffer.readUInt16BE(4);
            const total = 7 + length;
            if (this.buffer.length < total) break;
            if (this.buffer[total - 1] !== 0) {
                this.buffer = this.buffer.subarray(1);
                continue;
            }
            const payload = Buffer.from(this.buffer.subarray(6, 6 + length));
            frames.push({
                reserved: this.buffer[1],
                type: this.buffer.readUInt16BE(2),
                payload,
                text: payload.toString('utf8').replace(/\0+$/g, ''),
            });
            this.buffer = this.buffer.subarray(total);
        }
        return frames;
    }
}

function toPaddedBuffer(value, blockSize) {
    const source = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    if (!source.length) return Buffer.alloc(0);
    const output = Buffer.alloc(Math.ceil(source.length / blockSize) * blockSize);
    source.copy(output);
    return output;
}

function encryptXteaHex(value, keyValue) {
    const data = toPaddedBuffer(value, 8);
    const keySource = Buffer.isBuffer(keyValue) ? keyValue : Buffer.from(String(keyValue), 'utf8');
    const keyBytes = Buffer.alloc(16);
    keySource.copy(keyBytes, 0, 0, Math.min(keySource.length, keyBytes.length));
    const key = [
        keyBytes.readUInt32BE(0),
        keyBytes.readUInt32BE(4),
        keyBytes.readUInt32BE(8),
        keyBytes.readUInt32BE(12),
    ];
    const encrypted = [];
    for (let offset = 0; offset < data.length; offset += 8) {
        let left = data.readUInt32BE(offset);
        let right = data.readUInt32BE(offset + 4);
        let sum = 0;
        for (let round = 0; round < 32; round++) {
            left = (left + (((((right << 4) ^ (right >>> 5)) + right) ^ (sum + key[sum & 3])) >>> 0)) >>> 0;
            sum = (sum + 0x9e3779b9) >>> 0;
            right = (right + (((((left << 4) ^ (left >>> 5)) + left) ^ (sum + key[(sum >>> 11) & 3])) >>> 0)) >>> 0;
        }
        encrypted.push(left.toString(16).padStart(8, '0'), right.toString(16).padStart(8, '0'));
    }
    return encrypted.join('');
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG_SAMPLE_RATES = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
};

function readAdtsFrameLength(buffer, offset) {
    if (offset + 7 > buffer.length) return 0;
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf6) !== 0xf0) return -1;
    return ((buffer[offset + 3] & 0x03) << 11)
        | (buffer[offset + 4] << 3)
        | ((buffer[offset + 5] & 0xe0) >>> 5);
}

function readMp3FrameLength(buffer, offset) {
    if (offset + 4 > buffer.length) return 0;
    const one = buffer[offset + 1];
    const two = buffer[offset + 2];
    if (buffer[offset] !== 0xff || (one & 0xe0) !== 0xe0) return -1;
    const version = (one >>> 3) & 0x03;
    const layer = (one >>> 1) & 0x03;
    const bitrateIndex = (two >>> 4) & 0x0f;
    const sampleRateIndex = (two >>> 2) & 0x03;
    if (version === 1 || layer !== 1 || sampleRateIndex === 3) return -1;
    const bitrate = (version === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
    const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex] || 0;
    if (!bitrate || !sampleRate) return -1;
    const padding = (two >>> 1) & 0x01;
    return Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
}

class CodecFrameAccumulator {
    constructor(codec) {
        this.codec = codec;
        this.buffer = Buffer.alloc(0);
    }

    push(chunk) {
        if (chunk?.length) this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        const frames = [];
        const readLength = this.codec === 'mp3' ? readMp3FrameLength : readAdtsFrameLength;
        let offset = 0;
        while (offset < this.buffer.length) {
            const length = readLength(this.buffer, offset);
            if (length === 0) break;
            if (length < 0) {
                offset++;
                continue;
            }
            if (offset + length > this.buffer.length) break;
            frames.push(Buffer.from(this.buffer.subarray(offset, offset + length)));
            offset += length;
        }
        if (offset) this.buffer = this.buffer.subarray(offset);
        return frames;
    }
}

function codecDetails(codec) {
    if (codec === 'mp3') return { mime: 'audio/mpeg', dataType: TYPES.MP3_DATA };
    if (codec === 'aac_he') return { mime: 'audio/aacp', dataType: TYPES.AACP_DATA };
    return { mime: 'audio/aac', dataType: TYPES.AAC_LC_DATA };
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

class UltravoxSource extends EventEmitter {
    constructor(options = {}) {
        super();
        this.config = options.config || {};
        this.socket = options.socket || new net.Socket();
        this.onReady = typeof options.onReady === 'function' ? options.onReady : () => {};
        this.onError = typeof options.onError === 'function' ? options.onError : () => {};
        this.writeLog = typeof options.writeLog === 'function' ? options.writeLog : () => {};
        this.handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || 10000;
        this.parser = new UltravoxParser();
        this.codec = codecDetails(this.config.codec);
        this.audio = new CodecFrameAccumulator(this.config.codec === 'mp3' ? 'mp3' : 'aac');
        this.negotiatedMaxPayload = MAX_UVOX_PAYLOAD;
        this.live = false;
        this.failed = false;
        this.state = 'idle';
        this.pendingConfig = [];
        this.maxQueuedAudioBytes = Math.max(1, Number(options.maxQueuedAudioBytes) || 2 * 1024 * 1024);
        this.queuedAudioFrames = [];
        this.queuedAudioBytes = 0;
        this.waitingDrain = false;

        this.socket.on('data', chunk => this._onData(chunk));
        this.socket.on('drain', () => this._flushQueuedAudio());
        this.socket.on('timeout', () => this._fail('SHOUTcast2 Ultravox: timeout durante handshake.', 'network', true));
        this.socket.on('error', err => this._fail(`SHOUTcast2 Ultravox socket: ${err.message || err}`, 'network', true));
        this.socket.on('close', () => {
            if (!this.socket._lfIntentionalClose) {
                this._fail('SHOUTcast2 Ultravox: el servidor cerro la conexion.', 'network', true);
            }
        });
    }

    connect() {
        this.socket.setTimeout(this.handshakeTimeoutMs);
        this.socket.connect(Number(this.config.port), this.config.ip, () => {
            this.state = 'cipher';
            this.socket.write(encodeControlFrame(TYPES.REQUEST_CIPHER, '2.1'));
        });
        return this;
    }

    _onData(chunk) {
        for (const frame of this.parser.push(chunk)) this._handleFrame(frame);
    }

    _expectAck(frame, expectedType) {
        if (frame.type !== expectedType) {
            throw new Error(`SHOUTcast2 Ultravox: respuesta fuera de secuencia 0x${frame.type.toString(16)}.`);
        }
        if (/^NAK(?::|$)/i.test(frame.text)) {
            throw new Error(`SHOUTcast2 Ultravox rechazo: ${frame.text}.`);
        }
        if (!/^ACK(?::|$)/i.test(frame.text)) {
            throw new Error(`SHOUTcast2 Ultravox: ACK invalido para 0x${frame.type.toString(16)}.`);
        }
        return frame.text.split(':').slice(1);
    }

    _handleFrame(frame) {
        if (this.failed || this.live) return;
        try {
            if (this.state === 'cipher') {
                const [cipherKey = ''] = this._expectAck(frame, TYPES.REQUEST_CIPHER);
                const sid = String(this.config.mount || '1');
                const user = encryptXteaHex(String(this.config.user || 'source').slice(0, 8), cipherKey);
                const password = encryptXteaHex(String(this.config.password || ''), cipherKey);
                this.state = 'authenticate';
                this.socket.write(encodeControlFrame(TYPES.AUTHENTICATE, `2.1:${sid}:${user}:${password}`));
                return;
            }
            if (this.state === 'authenticate') {
                const parts = this._expectAck(frame, TYPES.AUTHENTICATE);
                if (!parts.includes('Allow')) throw new Error(`SHOUTcast2 Ultravox autenticacion rechazada: ${frame.text}.`);
                this.pendingConfig = this._buildConfigMessages();
                this._sendNextConfig();
                return;
            }
            if (this.state === 'configure') {
                this._expectAck(frame, this.currentConfig.type);
                if (this.currentConfig.type === TYPES.NEGOTIATE_PAYLOAD) {
                    const negotiated = Number(frame.text.split(':')[1]);
                    if (Number.isInteger(negotiated) && negotiated > 0) {
                        this.negotiatedMaxPayload = Math.min(negotiated, MAX_UVOX_PAYLOAD);
                    }
                }
                this._sendNextConfig();
                return;
            }
            if (this.state === 'standby') {
                this._expectAck(frame, TYPES.STANDBY);
                if (!/Data transfer mode/i.test(frame.text)) {
                    throw new Error(`SHOUTcast2 Ultravox no entro en transferencia: ${frame.text}.`);
                }
                this.live = true;
                this.state = 'live';
                this.socket.setTimeout(0);
                this.onReady(this);
                this.emit('ready');
            }
        } catch (err) {
            const category = this.state === 'cipher'
                || this.state === 'authenticate'
                || /autentic|cipher|deny|password/i.test(err.message)
                ? 'auth'
                : 'server';
            this._fail(err.message, category, false);
        }
    }

    _buildConfigMessages() {
        const bitrate = Math.max(8, Number(this.config.bitrate) || 128) * 1000;
        return [
            { type: TYPES.SET_MIME, text: this.codec.mime },
            { type: TYPES.SETUP, text: `${bitrate}:${bitrate}` },
            { type: TYPES.NEGOTIATE_BUFFER, text: '32768:8192' },
            { type: TYPES.NEGOTIATE_PAYLOAD, text: `${MAX_UVOX_PAYLOAD}:1024` },
            { type: TYPES.ICY_NAME, text: this.config.icyName || 'Radio' },
            { type: TYPES.ICY_GENRE, text: this.config.icyGenre || 'Variado' },
            { type: TYPES.ICY_URL, text: this.config.icyUrl || 'http://' },
            { type: TYPES.ICY_PUBLIC, text: this.config.icyPublic === false ? '0' : '1' },
        ];
    }

    _sendNextConfig() {
        if (this.pendingConfig.length) {
            this.currentConfig = this.pendingConfig.shift();
            this.state = 'configure';
            this.socket.write(encodeControlFrame(this.currentConfig.type, this.currentConfig.text));
            return;
        }
        this.state = 'standby';
        this.socket.write(encodeUvoxFrame(TYPES.STANDBY));
    }

    _fail(message, category = 'server', retryable = false) {
        if (this.failed) return;
        this.failed = true;
        this.live = false;
        const error = Object.assign(new Error(message), { category, retryable });
        this.writeLog(message);
        try {
            this.onError(error);
            this.emit('failure', error);
        } finally {
            this.socket._lfIntentionalClose = true;
            try { this.socket.destroy(); } catch (_) {}
        }
    }

    _queueAudioFrame(frame) {
        const queued = Buffer.from(frame);
        if (this.queuedAudioBytes + queued.length > this.maxQueuedAudioBytes) {
            this._fail(
                `SHOUTcast2 Ultravox: el servidor no recibe audio; cola de red excedida (${this.maxQueuedAudioBytes} bytes).`,
                'network',
                true
            );
            return false;
        }
        this.queuedAudioFrames.push(queued);
        this.queuedAudioBytes += queued.length;
        return true;
    }

    _writeAudioFrame(frame) {
        if (this.failed || this.socket.destroyed) return false;
        if (this.waitingDrain) return this._queueAudioFrame(frame);
        if (!this.socket.write(frame)) this.waitingDrain = true;
        return true;
    }

    _flushQueuedAudio() {
        if (this.failed || this.socket.destroyed) return;
        this.waitingDrain = false;
        while (this.queuedAudioFrames.length && !this.waitingDrain) {
            const frame = this.queuedAudioFrames.shift();
            this.queuedAudioBytes -= frame.length;
            if (!this.socket.write(frame)) this.waitingDrain = true;
        }
    }

    writeAudio(chunk) {
        if (!this.live || this.failed || !chunk?.length) return false;
        const frames = this.audio.push(chunk);
        let payloadParts = [];
        let payloadBytes = 0;
        let accepted = true;
        const flush = () => {
            if (!payloadBytes) return;
            if (!this._writeAudioFrame(encodeUvoxFrame(this.codec.dataType, Buffer.concat(payloadParts, payloadBytes)))) {
                accepted = false;
            }
            payloadParts = [];
            payloadBytes = 0;
        };
        for (const frame of frames) {
            if (frame.length > this.negotiatedMaxPayload) {
                this._fail(`SHOUTcast2 Ultravox: frame de audio excede payload negociado (${frame.length}).`, 'codec', false);
                return false;
            }
            if (payloadBytes && payloadBytes + frame.length > this.negotiatedMaxPayload) flush();
            payloadParts.push(frame);
            payloadBytes += frame.length;
        }
        flush();
        return frames.length > 0 && accepted && !this.failed;
    }

    updateMetadata(song) {
        if (!this.live || this.failed) return false;
        const xml = Buffer.from(`<metadata><TIT2>${escapeXml(song)}</TIT2></metadata>`, 'utf8');
        const maxXmlBytes = Math.max(1, this.negotiatedMaxPayload - 6);
        const span = Math.ceil(xml.length / maxXmlBytes);
        if (span > 32) throw new Error('Metadata SHOUTcast2 demasiado grande.');
        let accepted = this._writeAudioFrame(encodeUvoxFrame(TYPES.FLUSH_METADATA));
        for (let index = 0; index < span; index++) {
            const header = Buffer.alloc(6);
            header.writeUInt16BE(1, 0);
            header.writeUInt16BE(span, 2);
            header.writeUInt16BE(index + 1, 4);
            const part = xml.subarray(index * maxXmlBytes, (index + 1) * maxXmlBytes);
            if (!this._writeAudioFrame(encodeUvoxFrame(TYPES.XML_METADATA, Buffer.concat([header, part])))) {
                accepted = false;
            }
        }
        return accepted && !this.failed;
    }

    terminate() {
        if (this.socket.destroyed) return;
        try { this.socket.write(encodeUvoxFrame(TYPES.TERMINATE)); } catch (_) {}
        this.socket._lfIntentionalClose = true;
        try { this.socket.destroy(); } catch (_) {}
        this.live = false;
        this.queuedAudioFrames = [];
        this.queuedAudioBytes = 0;
    }
}

module.exports = {
    MAX_UVOX_PAYLOAD,
    TYPES,
    CodecFrameAccumulator,
    UltravoxParser,
    UltravoxSource,
    encodeControlFrame,
    encodeUvoxFrame,
    encryptXteaHex,
};
