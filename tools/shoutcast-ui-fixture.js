'use strict';

const net = require('net');

const host = process.env.LF_SHOUTCAST_FIXTURE_HOST || '127.0.0.1';
const port = Number(process.env.LF_SHOUTCAST_FIXTURE_PORT || 18000);
const password = process.env.LF_SHOUTCAST_FIXTURE_PASSWORD || 'lab-shoutcast-pass';

let connectionId = 0;

function now() {
    return new Date().toLocaleTimeString();
}

const server = net.createServer(socket => {
    const id = ++connectionId;
    let stage = 'password';
    let buffer = Buffer.alloc(0);
    let audioBytes = 0;

    console.log(`[${now()}] [srv ${id}] conexion desde ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 'password') {
            const text = buffer.toString('latin1');
            const idx = text.indexOf('\r\n');
            if (idx < 0) return;

            const received = text.slice(0, idx);
            if (received !== password && received !== `${password}:#1`) {
                console.log(`[${now()}] [srv ${id}] password rechazado: "${received}"`);
                socket.write('invalid password\r\n');
                socket.destroy();
                return;
            }

            console.log(`[${now()}] [srv ${id}] password OK`);
            socket.write('OK2\r\n');
            buffer = buffer.subarray(idx + 2);
            stage = 'headers';
        }

        if (stage === 'headers') {
            const text = buffer.toString('latin1');
            const idx = text.indexOf('\r\n\r\n');
            if (idx < 0) return;

            const headers = text.slice(0, idx).split(/\r?\n/).filter(Boolean);
            console.log(`[${now()}] [srv ${id}] headers recibidos: ${headers.slice(0, 4).join(' | ')}`);
            buffer = buffer.subarray(idx + 4);
            audioBytes += buffer.length;
            buffer = Buffer.alloc(0);
            stage = 'audio';
        } else if (stage === 'audio') {
            audioBytes += buffer.length;
            buffer = Buffer.alloc(0);
        }
    });

    const meter = setInterval(() => {
        if (audioBytes > 0) {
            console.log(`[${now()}] [srv ${id}] audio recibido: ${audioBytes} bytes`);
        }
    }, 3000);

    socket.on('close', () => {
        clearInterval(meter);
        console.log(`[${now()}] [srv ${id}] conexion cerrada, total audio=${audioBytes} bytes`);
    });
    socket.on('error', err => {
        console.log(`[${now()}] [srv ${id}] socket error: ${err.code || err.message}`);
    });
});

server.on('error', err => {
    console.error(`[${now()}] No se pudo iniciar fixture SHOUTcast: ${err.message}`);
    process.exit(1);
});

server.listen(port, host, () => {
    console.log('Servidor SHOUTcast de prueba listo para la app');
    console.log(`Host: ${host}`);
    console.log(`Puerto: ${port}`);
    console.log(`Password: ${password}`);
    console.log('Tipo en la app: SHOUTcast');
    console.log('Deja esta ventana abierta mientras pruebas. Ctrl+C para cerrar.');
});
