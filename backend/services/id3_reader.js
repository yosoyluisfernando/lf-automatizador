'use strict';

// Lectura acotada de tags ID3v2 — compartida por TODOS los caminos que leen
// metadatos (índice musical, Centro de Procesamiento de la Biblioteca,
// detección de tipos en la UI).
//
// node-id3 con una ruta hace fs.readFileSync/readFile del ARCHIVO COMPLETO
// solo para parsear la cabecera ID3v2, que declara su propio tamaño en los
// primeros 10 bytes. Medido en biblioteca real: ~580 MB leídos por cada 50
// canciones (~12 MB por archivo); analizar metadatos era, literalmente, leer
// toda la música byte a byte. Aquí se localiza la cabecera con la misma
// validación que usa node-id3 (marca "ID3", versión 2/3/4, revisión 0, tamaño
// syncsafe) y se lee únicamente el tag declarado.
//  - Camino rápido: cabecera en el byte 0 (la posición estándar; ~99% de los mp3).
//  - Respaldo: escaneo del primer MB para archivos con basura antes del tag.
//  - Diferencia aceptada vs. node-id3: tags incrustados más allá del primer MB
//    (p. ej. chunks ID3 al FINAL de un wav) ya no se detectan; ese caso era
//    justamente el que obligaba a leer archivos gigantes completos.
//
// La ESCRITURA de tags no pasa por aquí: reescribir un tag sí requiere
// reconstruir el archivo y sigue siendo trabajo de nodeID3.update/write.

const fs = require('fs');
const nodeID3 = require('node-id3');

const TAG_SCAN_WINDOW_BYTES = 1024 * 1024;
const TAG_MAX_BYTES = 64 * 1024 * 1024;

function decodeSyncsafeSize(buffer, offset) {
    return ((buffer[offset] & 0x7f) << 21)
        | ((buffer[offset + 1] & 0x7f) << 14)
        | ((buffer[offset + 2] & 0x7f) << 7)
        | (buffer[offset + 3] & 0x7f);
}

function findId3v2Header(buffer) {
    let position = -1;
    while (true) {
        position = buffer.indexOf('ID3', position + 1);
        if (position === -1 || position + 10 > buffer.length) return null;
        const major = buffer[position + 3];
        const revision = buffer[position + 4];
        const sizeBits = buffer[position + 6] | buffer[position + 7] | buffer[position + 8] | buffer[position + 9];
        if ((major === 2 || major === 3 || major === 4) && revision === 0x00 && (sizeBits & 0x80) === 0) {
            return { position, tagSize: decodeSyncsafeSize(buffer, position + 6) };
        }
    }
}

// Versión síncrona: para worker_threads (índice musical, worker de metadatos),
// donde bloquear el hilo propio es correcto y no afecta a la interfaz.
function readId3TagsSync(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const fileSize = Number(fs.fstatSync(fd).size) || 0;
        if (fileSize < 10) return {};

        const head = Buffer.alloc(10);
        fs.readSync(fd, head, 0, 10, 0);
        let header = findId3v2Header(head);
        let scanned = null;

        if (!header) {
            const windowSize = Math.min(fileSize, TAG_SCAN_WINDOW_BYTES);
            scanned = Buffer.alloc(windowSize);
            fs.readSync(fd, scanned, 0, windowSize, 0);
            header = findId3v2Header(scanned);
            if (!header) return {};
        }

        const needed = Math.min(header.position + 10 + header.tagSize, fileSize, TAG_MAX_BYTES);
        let tagBuffer = scanned && scanned.length >= needed ? scanned : null;
        if (!tagBuffer) {
            tagBuffer = Buffer.alloc(needed);
            fs.readSync(fd, tagBuffer, 0, needed, 0);
        }
        return nodeID3.read(tagBuffer) || {};
    } catch (err) {
        return {};
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (err) {}
        }
    }
}

// Versión asíncrona: para el proceso principal y handlers IPC, donde el event
// loop no debe bloquearse ni siquiera por lecturas pequeñas.
async function readId3TagsAsync(filePath) {
    let handle = null;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const fileSize = Number((await handle.stat()).size) || 0;
        if (fileSize < 10) return {};

        const head = Buffer.alloc(10);
        await handle.read(head, 0, 10, 0);
        let header = findId3v2Header(head);
        let scanned = null;

        if (!header) {
            const windowSize = Math.min(fileSize, TAG_SCAN_WINDOW_BYTES);
            scanned = Buffer.alloc(windowSize);
            await handle.read(scanned, 0, windowSize, 0);
            header = findId3v2Header(scanned);
            if (!header) return {};
        }

        const needed = Math.min(header.position + 10 + header.tagSize, fileSize, TAG_MAX_BYTES);
        let tagBuffer = scanned && scanned.length >= needed ? scanned : null;
        if (!tagBuffer) {
            tagBuffer = Buffer.alloc(needed);
            await handle.read(tagBuffer, 0, needed, 0);
        }
        return nodeID3.read(tagBuffer) || {};
    } catch (err) {
        return {};
    } finally {
        if (handle) {
            try { await handle.close(); } catch (err) {}
        }
    }
}

module.exports = {
    readId3TagsSync,
    readId3TagsAsync,
    findId3v2Header,
    TAG_SCAN_WINDOW_BYTES,
    TAG_MAX_BYTES
};
