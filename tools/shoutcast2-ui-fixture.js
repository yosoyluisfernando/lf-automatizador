'use strict';

const net = require('net');
const { TYPES, UltravoxParser, encodeControlFrame } = require('./ultravox-fixture-lib');

const host = process.env.LF_SHOUTCAST2_FIXTURE_HOST || '127.0.0.1';
const port = Number(process.env.LF_SHOUTCAST2_FIXTURE_PORT || 18002);
const password = process.env.LF_SHOUTCAST2_FIXTURE_PASSWORD || 'lab-shoutcast2-pass';
const sid = String(process.env.LF_SHOUTCAST2_FIXTURE_SID || '1');

let connectionId = 0;

function now() {
    return new Date().toLocaleTimeString();
}

const server = net.createServer(socket => {
    const id = ++connectionId;
    const parser = new UltravoxParser();
    let audioBytes = 0;
    let audioFrames = 0;

    console.log(`[${now()}] [srv ${id}] conexion desde ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', chunk => {
        for (const frame of parser.push(chunk)) {
            if (frame.type === TYPES.REQUEST_CIPHER) {
                console.log(`[${now()}] [srv ${id}] cipher solicitado: ${frame.text}`);
                socket.write(encodeControlFrame(TYPES.REQUEST_CIPHER, 'ACK:0123456789abcdef'));
                continue;
            }
            if (frame.type === TYPES.AUTHENTICATE) {
                const parts = frame.text.split(':');
                const receivedSid = parts[1] || '';
                if (receivedSid !== sid) {
                    console.log(`[${now()}] [srv ${id}] SID rechazado: ${receivedSid}`);
                    socket.write(encodeControlFrame(TYPES.AUTHENTICATE, 'NAK:Invalid SID'));
                    socket.destroy();
                    continue;
                }
                console.log(`[${now()}] [srv ${id}] auth OK para SID ${receivedSid}`);
                socket.write(encodeControlFrame(TYPES.AUTHENTICATE, 'ACK:Allow'));
                continue;
            }
            if (frame.type === TYPES.NEGOTIATE_PAYLOAD) {
                console.log(`[${now()}] [srv ${id}] payload negociado`);
                socket.write(encodeControlFrame(TYPES.NEGOTIATE_PAYLOAD, 'ACK:4096'));
                continue;
            }
            if (frame.type === TYPES.STANDBY) {
                console.log(`[${now()}] [srv ${id}] entrando en modo transferencia`);
                socket.write(encodeControlFrame(TYPES.STANDBY, 'ACK:Data transfer mode'));
                continue;
            }
            if (
                frame.type === TYPES.SET_MIME
                || frame.type === TYPES.SETUP
                || frame.type === TYPES.NEGOTIATE_BUFFER
                || frame.type === TYPES.ICY_NAME
                || frame.type === TYPES.ICY_GENRE
                || frame.type === TYPES.ICY_URL
                || frame.type === TYPES.ICY_PUBLIC
            ) {
                console.log(`[${now()}] [srv ${id}] config 0x${frame.type.toString(16)}: ${frame.text}`);
                socket.write(encodeControlFrame(frame.type, 'ACK'));
                continue;
            }
            if (
                frame.type === TYPES.MP3_DATA
                || frame.type === TYPES.AAC_LC_DATA
                || frame.type === TYPES.AACP_DATA
            ) {
                audioFrames += 1;
                audioBytes += frame.payload.length;
                continue;
            }
            if (frame.type === TYPES.TERMINATE) {
                console.log(`[${now()}] [srv ${id}] terminate recibido`);
                socket.destroy();
            }
        }
    });

    const meter = setInterval(() => {
        if (audioBytes > 0) {
            console.log(`[${now()}] [srv ${id}] audio recibido: ${audioBytes} bytes en ${audioFrames} frames UVOX`);
        }
    }, 3000);

    socket.on('close', () => {
        clearInterval(meter);
        console.log(`[${now()}] [srv ${id}] conexion cerrada, total audio=${audioBytes} bytes, frames=${audioFrames}`);
    });
    socket.on('error', err => {
        console.log(`[${now()}] [srv ${id}] socket error: ${err.code || err.message}`);
    });
});

server.on('error', err => {
    console.error(`[${now()}] No se pudo iniciar fixture SHOUTcast2: ${err.message}`);
    process.exit(1);
});

server.listen(port, host, () => {
    console.log('Servidor SHOUTcast2/Ultravox de prueba listo para la app');
    console.log(`Host: ${host}`);
    console.log(`Puerto: ${port}`);
    console.log(`SID: ${sid}`);
    console.log(`Password de referencia: ${password}`);
    console.log('Tipo en la app: SHOUTcast2');
    console.log('Legacy/compatibilidad: desactivado');
    console.log('Deja esta ventana abierta mientras pruebas. Ctrl+C para cerrar.');
});
