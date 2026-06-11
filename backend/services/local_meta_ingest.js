'use strict';

// Ingesta de metadatos locales en la tabla `tracks` — la MISMA lógica para el
// indexador del buscador y para "Centro de Procesamiento > Metadatos" de la
// Biblioteca. Recibe los tags ya leídos (lector acotado de id3_reader) y:
//   1. Parsea título/artista/feats/remix con el parser canónico de artists.js
//      (grupos protegidos como "Wisin y Yandel" incluidos).
//   2. Hace upsert en `tracks` con semántica "fill" por defecto (jamás pisa
//      datos curados por el operador) o "force" si se pide explícitamente.
//   3. Sincroniza perfiles y enlaces de artista.
// Así, indexar una carpeta deja los metadatos completos listos y al archivo
// solo le queda el análisis de audio (inicio/mezcla/fin) para pasar de
// "pendiente" a "tratado".

const db = require('../../database.js');
const {
    parseTitleAndArtist,
    syncTrackArtistLinks
} = require('./artists.js');

// Copia local del helper puro de services/genres.js (ese módulo requiere
// `electron` y no puede cargarse dentro de un worker_thread).
function genreFileTagToLibraryLabel(value) {
    return String(value || '')
        .split(/\s*(?:;|,|\/)\s*/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(' / ');
}

const upsertLocalMetaForceStmt = db.prepare(`
    INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
        custom_title = excluded.custom_title,
        custom_artist = excluded.custom_artist,
        feat = excluded.feat,
        is_remix = excluded.is_remix,
        album = excluded.album,
        year = excluded.year,
        genre = excluded.genre,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms
`);

const upsertLocalMetaFillStmt = db.prepare(`
    INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
        custom_title = COALESCE(NULLIF(tracks.custom_title, ''), excluded.custom_title),
        custom_artist = COALESCE(NULLIF(tracks.custom_artist, ''), excluded.custom_artist),
        feat = COALESCE(NULLIF(tracks.feat, ''), excluded.feat),
        is_remix = COALESCE(tracks.is_remix, excluded.is_remix),
        album = COALESCE(NULLIF(tracks.album, ''), excluded.album),
        year = COALESCE(NULLIF(tracks.year, ''), excluded.year),
        genre = COALESCE(NULLIF(tracks.genre, ''), excluded.genre),
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms
`);

const selectTrackByPathStmt = db.prepare('SELECT * FROM tracks WHERE file_path = ?');

function hasUsefulTagData(tags = {}) {
    return !!(String(tags.title || '').trim()
        || String(tags.artist || '').trim()
        || String(tags.album || '').trim()
        || String(tags.year || '').trim()
        || String(tags.genre || '').trim());
}

// Ingresa los tags de un archivo a `tracks` y sincroniza artistas.
// Devuelve la fila resultante (con los datos curados que hayan prevalecido).
function ingestFileTags(filePath, tags = {}, options = {}) {
    if (!filePath) return null;
    const parsed = parseTitleAndArtist(tags.artist || '', tags.title || '');
    const title = parsed.title || String(tags.title || '').trim();
    const artist = parsed.artist || String(tags.artist || '').trim();
    const featsJson = parsed.feats.length > 0 ? JSON.stringify(parsed.feats) : null;
    const stmt = options.forceOverwrite === true ? upsertLocalMetaForceStmt : upsertLocalMetaFillStmt;
    stmt.run(
        filePath,
        title,
        artist,
        featsJson,
        parsed.isRemix ? 1 : 0,
        String(tags.album || '').trim(),
        String(tags.year || '').trim(),
        genreFileTagToLibraryLabel(tags.genre),
        Number.isFinite(Number(options.fileSize)) ? Number(options.fileSize) : null,
        Number.isFinite(Number(options.fileMtimeMs)) ? Math.round(Number(options.fileMtimeMs)) : null
    );
    const updatedRow = selectTrackByPathStmt.get(filePath);
    try {
        syncTrackArtistLinks(filePath, updatedRow?.custom_artist || artist, updatedRow?.feat || featsJson || []);
    } catch (err) {}
    return updatedRow;
}

module.exports = {
    ingestFileTags,
    hasUsefulTagData,
    genreFileTagToLibraryLabel
};
