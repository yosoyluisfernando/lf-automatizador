const { parentPort } = require('worker_threads');
const fs = require('fs');
const nodeID3 = require('node-id3');
const db = require('../database');
const { readId3TagsSync } = require('./services/id3_reader');
const { ingestFileTags } = require('./services/local_meta_ingest');

let queue = [];
let active = 0;
let cancelled = false;
let mode = 'read';
const MAX_CONCURRENT = 5;

// Lectura acotada (solo la cabecera ID3, no el archivo completo) compartida
// con el índice musical: el "Análisis de metadatos" del Centro de
// Procesamiento corre a la misma velocidad que el indexado del buscador.
const readTagsAsync = (file) => Promise.resolve(readId3TagsSync(file));
// La escritura sí necesita el archivo completo (node-id3 lo reconstruye).
const writeTagsAsync = (tags, file) => new Promise(resolve => nodeID3.update(tags, file, (err) => resolve(!err)));
function assertReadableFile(filePath) {
    let fd = null;
    try {
        if (!filePath || !fs.existsSync(filePath)) throw new Error('archivo no existe');
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error('la ruta no es archivo');
        fd = fs.openSync(filePath, 'r');
        const probe = Buffer.alloc(1);
        fs.readSync(fd, probe, 0, 1, 0);
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (err) {}
        }
    }
}

function genreLabelToFileTag(value) {
    return String(value || '')
        .split(/\s*(?:\/|;|,)\s*/)
        .map(part => part.trim())
        .filter(Boolean)
        .join('; ');
}

// El upsert de metadatos (fill/force), la conversión de género de archivo a
// etiqueta de biblioteca y los enlaces de artista viven ahora en
// services/local_meta_ingest.js, compartidos con el indexador del buscador.
const selectTrackMetaForWriteStmt = db.prepare("SELECT custom_title, custom_artist, feat, album, year, genre FROM tracks WHERE file_path = ?");

function getTrackFileSignature(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { fileSize: stat.size, fileMtimeMs: Math.round(stat.mtimeMs) };
    } catch (err) {
        return null;
    }
}

function mapTrackRowToClient(row) {
    return {
        customTitle: row?.custom_title || '',
        customArtist: row?.custom_artist || '',
        album: row?.album || '',
        year: row?.year || '',
        genre: row?.genre || '',
        feat: row?.feat || '',
        isRemix: row?.is_remix === 1,
        fileSize: row?.file_size ?? null,
        fileMtimeMs: row?.file_mtime_ms ?? null
    };
}

async function readTask(task) {
    // Misma ingesta compartida que usa el indexador del buscador
    // (services/local_meta_ingest): parser can\u00f3nico de artistas (grupos
    // protegidos incluidos), upsert fill/force y enlaces de artista.
    const tags = await readTagsAsync(task.filePath);
    const signature = getTrackFileSignature(task.filePath);
    const updatedRow = ingestFileTags(task.filePath, tags, {
        forceOverwrite: task.forceOverwrite === true,
        fileSize: signature?.fileSize ?? null,
        fileMtimeMs: signature?.fileMtimeMs ?? null
    });
    return { success: true, filePath: task.filePath, data: mapTrackRowToClient(updatedRow) };
}

async function writeTask(filePath) {
    assertReadableFile(filePath);
    const trackData = selectTrackMetaForWriteStmt.get(filePath);
    if (trackData) {
        const tags = {};
        if (trackData.custom_title) tags.title = trackData.custom_title;
        let finalArtist = trackData.custom_artist || '';
        if (trackData.feat) {
            try {
                const featArr = JSON.parse(trackData.feat);
                if (Array.isArray(featArr) && featArr.length > 0) finalArtist = `${finalArtist} feat. ${featArr.join(', ')}`;
            } catch (err) {
                finalArtist = `${finalArtist} feat. ${trackData.feat}`;
            }
        }
        if (finalArtist) tags.artist = finalArtist;
        if (trackData.album) tags.album = trackData.album;
        if (trackData.year) tags.year = trackData.year;
        if (trackData.genre) tags.genre = genreLabelToFileTag(trackData.genre);
        if (Object.keys(tags).length > 0) await writeTagsAsync(tags, filePath);
        const signature = getTrackFileSignature(filePath);
        db.prepare("UPDATE tracks SET file_size = ?, file_mtime_ms = ? WHERE file_path = ?").run(signature?.fileSize ?? null, signature?.fileMtimeMs ?? null, filePath);
    }
    return { success: true, filePath };
}

function postResult(payload) {
    parentPort.postMessage({ type: 'result', mode, payload });
}

function postFinished() {
    parentPort.postMessage({ type: 'finished', mode });
}

function pump() {
    if (cancelled) {
        if (active === 0) postFinished();
        return;
    }
    const maxActive = mode === 'write' ? 1 : MAX_CONCURRENT;
    while (active < maxActive && queue.length > 0) {
        const item = queue.shift();
        active++;
        const work = mode === 'write' ? writeTask(item) : readTask(item);
        work
            .then(result => postResult(result))
            .catch(err => postResult({ success: false, filePath: item?.filePath || item, error: err.message }))
            .finally(() => {
                active--;
                if ((queue.length === 0 || cancelled) && active === 0) postFinished();
                else pump();
            });
    }
    if (queue.length === 0 && active === 0) postFinished();
}

parentPort.on('message', (message) => {
    if (message?.action === 'cancel') {
        cancelled = true;
        queue = [];
        return;
    }
    if (message?.action === 'start') {
        cancelled = false;
        mode = message.mode === 'write' ? 'write' : 'read';
        queue = Array.isArray(message.tasks) ? message.tasks : [];
        pump();
    }
});
