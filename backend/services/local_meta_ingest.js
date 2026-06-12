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

// Parseo PURO de tags (sin tocar la base de datos). Separado de la escritura
// para que el indexador pueda: (1) usar estos valores en la fila del índice y
// (2) diferir las escrituras al interior de la transacción de cada lote.
// Escribir por archivo con autocommit (≈8 sentencias × miles de archivos =
// cientos de miles de commits) devolvía la indexación a los minutos.
function parseTagsMeta(tags = {}) {
    const parsed = parseTitleAndArtist(tags.artist || '', tags.title || '');
    return {
        title: parsed.title || String(tags.title || '').trim(),
        artist: parsed.artist || String(tags.artist || '').trim(),
        featsJson: parsed.feats.length > 0 ? JSON.stringify(parsed.feats) : null,
        isRemix: parsed.isRemix === true,
        album: String(tags.album || '').trim(),
        year: String(tags.year || '').trim(),
        genre: genreFileTagToLibraryLabel(tags.genre)
    };
}

// Escritura de un parseo ya hecho. SIN transacción propia: el llamador decide
// (el indexador la envuelve en la transacción del lote; el worker de metadatos
// la usa por archivo, como siempre hizo el Centro de Procesamiento).
function ingestParsedTags(filePath, parsed, options = {}) {
    if (!filePath || !parsed) return null;
    const stmt = options.forceOverwrite === true ? upsertLocalMetaForceStmt : upsertLocalMetaFillStmt;
    stmt.run(
        filePath,
        parsed.title,
        parsed.artist,
        parsed.featsJson,
        parsed.isRemix ? 1 : 0,
        parsed.album,
        parsed.year,
        parsed.genre,
        Number.isFinite(Number(options.fileSize)) ? Number(options.fileSize) : null,
        Number.isFinite(Number(options.fileMtimeMs)) ? Math.round(Number(options.fileMtimeMs)) : null
    );
    const updatedRow = selectTrackByPathStmt.get(filePath);
    try {
        syncTrackArtistLinks(filePath, updatedRow?.custom_artist || parsed.artist, updatedRow?.feat || parsed.featsJson || []);
    } catch (err) {}
    return updatedRow;
}

// Ingesta completa de un archivo (parseo + escritura). La usa el worker de
// metadatos del Centro de Procesamiento.
function ingestFileTags(filePath, tags = {}, options = {}) {
    if (!filePath) return null;
    return ingestParsedTags(filePath, parseTagsMeta(tags), options);
}

module.exports = {
    parseTagsMeta,
    ingestParsedTags,
    ingestFileTags,
    hasUsefulTagData,
    genreFileTagToLibraryLabel
};
