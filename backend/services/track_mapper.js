'use strict';

// Mapeo de filas de `tracks` al formato que consume el frontend (manualCuesDB).
// Vive en un módulo propio para que tanto el proceso principal como
// library_worker.js (hilo aparte, con su propia conexión SQLite en modo WAL)
// usen exactamente la misma lógica. La carga masiva (lib-get-db-tracks con
// miles de rutas) corre en el worker: si corriera en el proceso principal,
// bloquearía el event loop que también atiende el puente con RustAudio y
// produciría falsos "Timeout esperando respuesta RustAudio".

const fs = require('fs');
const db = require('../../database.js');
const {
    normalizeTrackArtistFields,
    inferArtistDataFromRow,
    filterInternalGroupFeats,
    toDisplayArtist,
    parseFeatList
} = require('./artists.js');

const updateTrackFileSignatureStmt = db.prepare(`
    UPDATE tracks
    SET file_size = ?, file_mtime_ms = ?
    WHERE file_path = ?
`);

const selectMainArtistCountryStmt = db.prepare(`
    SELECT ap.country, ap.country_code AS countryCode
    FROM track_artist_links tal
    JOIN artist_profiles ap ON ap.artist_key = tal.artist_key
    WHERE tal.file_path = ? AND tal.role = 'main'
    ORDER BY tal.position
    LIMIT 1
`);

function getTrackFileSignature(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return null;
        return {
            fileSize: Number(stats.size) || 0,
            fileMtimeMs: Math.round(Number(stats.mtimeMs) || 0)
        };
    } catch (err) {
        return null;
    }
}

function storeTrackFileSignature(filePath, signature = null) {
    const safeSignature = signature || getTrackFileSignature(filePath);
    if (!safeSignature) return null;
    try {
        updateTrackFileSignatureStmt.run(safeSignature.fileSize, safeSignature.fileMtimeMs, filePath);
    } catch (err) {}
    return safeSignature;
}

function sanitizeChangedTrackData(trackData) {
    if (!trackData || trackData.fileChanged !== true) return trackData;
    return {
        ...trackData,
        inicio: null,
        intro: null,
        mix: null,
        outro: null,
        fin: null,
        p1_active: false,
        p1_time: null,
        p2_active: false,
        p2_time: null,
        p3_active: false,
        p3_time: null,
        p4_active: false,
        p4_time: null,
        phora_active: false,
        phora_time: null,
        db: null,
        peak_db: null,
        bpm: null,
        duration: null
    };
}

function mapTrackRowToClient(row, artistCountryLookup = null, options = {}) {
    if (!row) return null;
    // deferSignature: si es true, NO llama fs.statSync() y usa los valores almacenados en la BD.
    // Esto evita ~1,912 llamadas sync al disco al cargar la librería completa.
    const deferSignature = options.deferSignature === true;
    const includeSignature = !deferSignature && options.includeSignature !== false;
    const signature = includeSignature ? getTrackFileSignature(row.file_path) : null;
    const storedFileSize = Number.isFinite(Number(row.file_size)) ? Number(row.file_size) : null;
    const storedFileMtimeMs = Number.isFinite(Number(row.file_mtime_ms)) ? Math.round(Number(row.file_mtime_ms)) : null;
    let effectiveSignature = signature;
    let fileChanged = false;

    if (includeSignature && signature && (storedFileSize === null || storedFileMtimeMs === null)) {
        storeTrackFileSignature(row.file_path, signature);
    } else if (includeSignature && signature && storedFileSize !== null && storedFileMtimeMs !== null) {
        fileChanged = storedFileSize !== signature.fileSize || storedFileMtimeMs !== signature.fileMtimeMs;
    }

    if (!effectiveSignature) {
        effectiveSignature = {
            fileSize: storedFileSize,
            fileMtimeMs: storedFileMtimeMs
        };
    }

    let artistCountry = '';
    let artistCountryCode = '';
    try {
        const artistCountryRow = artistCountryLookup instanceof Map
            ? artistCountryLookup.get(row.file_path)
            : selectMainArtistCountryStmt.get(row.file_path);
        artistCountry = artistCountryRow?.country || '';
        artistCountryCode = artistCountryRow?.countryCode || '';
    } catch (err) {}

    const normalizedArtists = normalizeTrackArtistFields(row.custom_artist, row.custom_title, row.feat);
    const inferredArtists = inferArtistDataFromRow(row);
    const finalArtist = inferredArtists.artist || normalizedArtists.artist || row.custom_artist;
    const finalFeats = filterInternalGroupFeats(finalArtist, [...new Set([
        ...(normalizedArtists.feats || []),
        ...(inferredArtists.feats || [])
    ].map(toDisplayArtist).filter(Boolean))]);
    const hadStoredFeats = parseFeatList(row.feat).length > 0;

    return sanitizeChangedTrackData({
        customTitle: row.custom_title,
        customArtist: finalArtist,
        feat: finalFeats.length > 0 ? JSON.stringify(finalFeats) : (hadStoredFeats ? null : row.feat),
        is_remix: row.is_remix,
        album: row.album,
        year: row.year,
        genre: row.genre,
        inicio: row.inicio,
        intro: row.intro,
        mix: row.mix,
        outro: row.outro,
        fin: row.fin,
        p1_active: row.p1_active === 1,
        p1_mode: row.p1_mode,
        p1_time: row.p1_time,
        p1_file: row.p1_file,
        p1_options: row.p1_options,
        p2_active: row.p2_active === 1,
        p2_mode: row.p2_mode,
        p2_time: row.p2_time,
        p2_file: row.p2_file,
        p2_options: row.p2_options,
        p3_active: row.p3_active === 1,
        p3_mode: row.p3_mode,
        p3_time: row.p3_time,
        p3_file: row.p3_file,
        p3_options: row.p3_options,
        p4_active: row.p4_active === 1,
        p4_mode: row.p4_mode,
        p4_time: row.p4_time,
        p4_file: row.p4_file,
        p4_options: row.p4_options,
        phora_active: row.phora_active === 1,
        phora_mode: row.phora_mode,
        phora_time: row.phora_time,
        db: row.db,
        peak_db: row.peak_db,
        bpm: row.bpm,
        duration: row.duration,
        primaryGenre: row.primary_genre,
        subgenre: row.subgenre,
        artistCountry,
        artistCountryCode,
        genresJson: row.genres_json,
        genreSource: row.genre_source,
        genreConfidence: row.genre_confidence,
        folderGenrePath: row.folder_genre_path,
        isUnusualGenre: row.is_unusual_genre === 1,
        fileSize: effectiveSignature?.fileSize ?? null,
        fileMtimeMs: effectiveSignature?.fileMtimeMs ?? null,
        fileChanged
    });
}

// Carga por lotes de pistas (la consulta detrás de 'lib-get-db-tracks').
// deferSignatures por defecto: sin fs.statSync por pista.
function getDbTracksMap(paths, options = {}) {
    const safePaths = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
    if (safePaths.length === 0) return {};
    const deferSignature = options?.deferSignatures !== false;
    const cuesDB = {};

    for (let i = 0; i < safePaths.length; i += 500) {
        const chunk = safePaths.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM tracks WHERE file_path IN (${placeholders})`).all(...chunk);
        const countryRows = db.prepare(`
            SELECT tal.file_path AS filePath, ap.country, ap.country_code AS countryCode
            FROM track_artist_links tal
            JOIN artist_profiles ap ON ap.artist_key = tal.artist_key
            WHERE tal.role = 'main' AND tal.file_path IN (${placeholders})
        `).all(...chunk);
        const artistCountryLookup = new Map(countryRows.map(row => [row.filePath, row]));
        rows.forEach(row => {
            cuesDB[row.file_path] = mapTrackRowToClient(row, artistCountryLookup, { deferSignature });
        });
    }

    return cuesDB;
}

module.exports = {
    getTrackFileSignature,
    storeTrackFileSignature,
    sanitizeChangedTrackData,
    mapTrackRowToClient,
    getDbTracksMap
};
