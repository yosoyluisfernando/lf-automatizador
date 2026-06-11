const { parentPort } = require('worker_threads');
const fs = require('fs');
const nodeID3 = require('node-id3');
const db = require('../database');
const { readId3TagsSync } = require('./services/id3_reader');

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

function genreFileTagToLibraryLabel(value) {
    return String(value || '')
        .split(/\s*(?:;|,|\/)\s*/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(' / ');
}

const upsertLocalMetaForceStmt = db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = excluded.custom_title, custom_artist = excluded.custom_artist, feat = excluded.feat, is_remix = excluded.is_remix, album = excluded.album, year = excluded.year, genre = excluded.genre, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const upsertLocalMetaFillStmt = db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = COALESCE(NULLIF(tracks.custom_title, ''), excluded.custom_title), custom_artist = COALESCE(NULLIF(tracks.custom_artist, ''), excluded.custom_artist), feat = COALESCE(NULLIF(tracks.feat, ''), excluded.feat), is_remix = COALESCE(NULLIF(tracks.is_remix, ''), excluded.is_remix), album = COALESCE(NULLIF(tracks.album, ''), excluded.album), year = COALESCE(NULLIF(tracks.year, ''), excluded.year), genre = COALESCE(NULLIF(tracks.genre, ''), excluded.genre), file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const selectTrackByPathStmt = db.prepare("SELECT * FROM tracks WHERE file_path = ?");
const selectTrackMetaForWriteStmt = db.prepare("SELECT custom_title, custom_artist, feat, album, year, genre FROM tracks WHERE file_path = ?");

function getTrackFileSignature(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { fileSize: stat.size, fileMtimeMs: Math.round(stat.mtimeMs) };
    } catch (err) {
        return null;
    }
}

function toDisplayArtist(value) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    return clean || '';
}

function parseFeatList(featValue) {
    if (!featValue) return [];
    if (Array.isArray(featValue)) return featValue.map(toDisplayArtist).filter(Boolean);
    if (typeof featValue === 'string') {
        try {
            const parsed = JSON.parse(featValue);
            if (Array.isArray(parsed)) return parsed.map(toDisplayArtist).filter(Boolean);
        } catch (err) {}
        return featValue.split(/\s*(?:,|;|\||\/|\\|\s+x\s+|\s+y\s+|\s+vs\.?\s+|&)\s*/i).map(toDisplayArtist).filter(Boolean);
    }
    return [];
}

function parseTitleAndArtist(rawArtist, rawTitle) {
    let artist = (rawArtist || '').trim();
    let title = (rawTitle || '').trim();
    let feats = [];
    let isRemix = false;
    const remixMatch = title.match(/[\(\[]?\s*(?:official\s+)?(?:remix|mix|rmx)\s*[\)\]]?/i);
    if (remixMatch) { isRemix = true; title = title.replace(remixMatch[0], '').trim(); }
    const remixArtistMatch = artist.match(/[\(\[]?\s*(?:official\s+)?(?:remix|mix|rmx)\s*[\)\]]?/i);
    if (remixArtistMatch) { isRemix = true; artist = artist.replace(remixArtistMatch[0], '').trim(); }
    const featInTitleMatch = title.match(/[\(\[]?(?:feat\.?|ft\.?|featuring)\s+([^()\[\]]+)[\)\]]?/i);
    if (featInTitleMatch) { feats.push(...parseFeatList(featInTitleMatch[1])); title = title.replace(featInTitleMatch[0], '').trim(); }
    const featInArtistMatch = artist.match(/(?:feat\.?|ft\.?|featuring)\s+(.+)/i);
    if (featInArtistMatch) { feats.push(...parseFeatList(featInArtistMatch[1])); artist = artist.replace(featInArtistMatch[0], '').trim(); }
    feats = [...new Set(feats.filter(f => f.length > 0))];
    title = title.replace(/\(\s*\)|\[\s*\]/g, '').replace(/-\s*$/, '').trim();
    return { artist, title, feats, isRemix };
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

function normalizeArtistKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function upsertArtistProfile(displayName) {
    const finalName = toDisplayArtist(displayName);
    const artistKey = normalizeArtistKey(finalName);
    if (!artistKey) return null;
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO artist_profiles (artist_key, display_name, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(artist_key) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(artistKey, finalName, now);
    return { key: artistKey, displayName: finalName };
}

function syncTrackArtistLinks(filePath, artistName, featValue = []) {
    if (!filePath) return;
    const mainArtist = upsertArtistProfile(artistName);
    const feats = parseFeatList(featValue);
    const deleteLinks = db.prepare("DELETE FROM track_artist_links WHERE file_path = ?");
    const insertLink = db.prepare(`
        INSERT OR REPLACE INTO track_artist_links (file_path, artist_key, role, display_name, position)
        VALUES (?, ?, ?, ?, ?)
    `);
    deleteLinks.run(filePath);
    if (mainArtist) insertLink.run(filePath, mainArtist.key, 'main', mainArtist.displayName, 0);
    feats.forEach((featName, index) => {
        const featArtist = upsertArtistProfile(featName);
        if (featArtist) insertLink.run(filePath, featArtist.key, 'feat', featArtist.displayName, index + 1);
    });
}

async function readTask(task) {
    const tags = await readTagsAsync(task.filePath);
    const parsed = parseTitleAndArtist(tags.artist || '', tags.title || '');
    const title = parsed.title || tags.title || '';
    const artist = parsed.artist || tags.artist || '';
    const featsJson = parsed.feats.length > 0 ? JSON.stringify(parsed.feats) : null;
    const signature = getTrackFileSignature(task.filePath);

    if (task.forceOverwrite) {
        upsertLocalMetaForceStmt.run(task.filePath, title, artist, featsJson, parsed.isRemix ? 1 : 0, tags.album || '', tags.year || '', genreFileTagToLibraryLabel(tags.genre), signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
    } else {
        upsertLocalMetaFillStmt.run(task.filePath, title, artist, featsJson, parsed.isRemix ? 1 : 0, tags.album || '', tags.year || '', genreFileTagToLibraryLabel(tags.genre), signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
    }

    const updatedRow = selectTrackByPathStmt.get(task.filePath);
    syncTrackArtistLinks(task.filePath, updatedRow?.custom_artist || artist, updatedRow?.feat || featsJson);
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
