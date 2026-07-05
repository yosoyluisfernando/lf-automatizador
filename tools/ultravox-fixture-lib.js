'use strict';

const TYPES = Object.freeze({
    AUTHENTICATE: 0x1001,
    SETUP: 0x1002,
    NEGOTIATE_BUFFER: 0x1003,
    STANDBY: 0x1004,
    TERMINATE: 0x1005,
    NEGOTIATE_PAYLOAD: 0x1008,
    REQUEST_CIPHER: 0x1009,
    SET_MIME: 0x1040,
    ICY_NAME: 0x1100,
    ICY_GENRE: 0x1101,
    ICY_URL: 0x1102,
    ICY_PUBLIC: 0x1103,
    MP3_DATA: 0x7000,
    AAC_LC_DATA: 0x8001,
    AACP_DATA: 0x8003,
});

function encodeUvoxFrame(type, payload = Buffer.alloc(0), reserved = 0) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
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
    return encodeUvoxFrame(type, Buffer.concat([Buffer.from(String(text), 'utf8'), Buffer.from([0])]));
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

module.exports = {
    TYPES,
    UltravoxParser,
    encodeControlFrame,
    encodeUvoxFrame,
};
