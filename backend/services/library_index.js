'use strict';

const fs = require('fs');
const path = require('path');
const nodeID3 = require('node-id3');
const { defaultFileTypes, normalizeFileTypes } = require('../../frontend/file_types_data');
const fileTypeResolver = require('./file_type_resolver');

const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

function normalizeDiskPath(targetPath) {
    try {
        return path.resolve(String(targetPath || '').trim());
    } catch (err) {
        return String(targetPath || '').trim();
    }
}

function normalizePathKey(targetPath) {
    return fileTypeResolver.normalizePathKey(normalizeDiskPath(targetPath));
}

function isInsideRoot(targetPath, rootPath) {
    const targetKey = normalizePathKey(targetPath);
    const rootKey = normalizePathKey(rootPath);
    return targetKey === rootKey || targetKey.startsWith(`${rootKey}/`);
}

function hasCueValue(value) {
    return value !== null && value !== undefined && value !== '' && !Number.isNaN(Number(value));
}

function isTreatedTrack(row = null) {
    return !!row && hasCueValue(row.inicio) && hasCueValue(row.mix) && hasCueValue(row.fin);
}

function readJsonConfig(fsApi, filePath, fallback) {
    try {
        if (!fsApi.existsSync(filePath)) return fallback;
        const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf-8'));
        return parsed || fallback;
    } catch (err) {
        return fallback;
    }
}

function writeJsonConfig(fsApi, filePath, payload) {
    try {
        fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
        fsApi.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        return true;
    } catch (err) {
        return false;
    }
}

function readTags(filePath) {
    try {
        return nodeID3.read(filePath) || {};
    } catch (err) {
        return {};
    }
}

function parseTitleAndArtistFromFile(filePath, tags = {}) {
    const fallbackTitle = path.basename(filePath, path.extname(filePath));
    return {
        title: String(tags.title || fallbackTitle || '').trim(),
        artist: String(tags.artist || '').trim(),
        album: String(tags.album || '').trim(),
        year: String(tags.year || '').trim(),
        genre: String(tags.genre || '').trim()
    };
}

function createLibraryIndexService(options = {}) {
    const db = options.db;
    const fsApi = options.fs || fs;
    const configDir = options.configDir || '';
    const fileTypesPath = options.fileTypesPath || path.join(configDir, 'file_types.json');
    const explicitTypesPath = options.explicitTypesPath || path.join(configDir, 'explicit_types.json');
    const fileTypeOptionsPath = options.fileTypeOptionsPath || path.join(configDir, 'file_type_options.json');
    const readTagsFn = options.readTags || readTags;

    if (!db) throw new Error('library_index requiere una instancia SQLite.');

    const selectTrack = db.prepare('SELECT * FROM tracks WHERE file_path = ?');
    const selectRoot = db.prepare('SELECT * FROM library_index_roots WHERE root_path = ?');
    const listRootsStmt = db.prepare('SELECT * FROM library_index_roots ORDER BY locked DESC, root_path COLLATE NOCASE');
    const upsertRoot = db.prepare(`
        INSERT INTO library_index_roots (root_path, source, type_id, recursive, locked, enabled, created_at, updated_at)
        VALUES (@rootPath, @source, @typeId, @recursive, @locked, @enabled, @now, @now)
        ON CONFLICT(root_path) DO UPDATE SET
            source = excluded.source,
            type_id = excluded.type_id,
            recursive = excluded.recursive,
            locked = excluded.locked,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
    `);
    const updateRootScan = db.prepare('UPDATE library_index_roots SET last_scan_at = ?, updated_at = ? WHERE root_path = ?');
    const upsertTrack = db.prepare(`
        INSERT INTO library_index_tracks (
            file_path, root_path, title, artist, album, year, genre, duration,
            file_size, file_mtime_ms, type_id, status, last_seen_at, created_at, updated_at
        )
        VALUES (
            @filePath, @rootPath, @title, @artist, @album, @year, @genre, @duration,
            @fileSize, @fileMtimeMs, @typeId, @status, @now, @now, @now
        )
        ON CONFLICT(file_path) DO UPDATE SET
            root_path = excluded.root_path,
            title = COALESCE(NULLIF(excluded.title, ''), library_index_tracks.title),
            artist = COALESCE(NULLIF(excluded.artist, ''), library_index_tracks.artist),
            album = COALESCE(NULLIF(excluded.album, ''), library_index_tracks.album),
            year = COALESCE(NULLIF(excluded.year, ''), library_index_tracks.year),
            genre = COALESCE(NULLIF(excluded.genre, ''), library_index_tracks.genre),
            duration = COALESCE(excluded.duration, library_index_tracks.duration),
            file_size = excluded.file_size,
            file_mtime_ms = excluded.file_mtime_ms,
            type_id = COALESCE(NULLIF(excluded.type_id, ''), library_index_tracks.type_id),
            status = excluded.status,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
    `);
    const markMissing = db.prepare(`
        UPDATE library_index_tracks
        SET status = 'missing', updated_at = ?
        WHERE root_path = ?
          AND status <> 'missing'
          AND last_seen_at <> ?
    `);

    function getFileTypes() {
        return normalizeFileTypes(readJsonConfig(fsApi, fileTypesPath, defaultFileTypes));
    }

    function getExplicitTypes() {
        return readJsonConfig(fsApi, explicitTypesPath, {});
    }

    function getFileTypeOptions() {
        return readJsonConfig(fsApi, fileTypeOptionsPath, {});
    }

    function getRootConflict(rootPath) {
        const normalized = normalizeDiskPath(rootPath);
        const roots = listRootsStmt.all();
        for (const root of roots) {
            if (normalizePathKey(root.root_path) === normalizePathKey(normalized)) {
                return { kind: 'same', root };
            }
            if (isInsideRoot(normalized, root.root_path)) {
                return { kind: 'inside-existing', root };
            }
            if (isInsideRoot(root.root_path, normalized)) {
                return { kind: 'covers-existing', root };
            }
        }
        return null;
    }

    function addRoot(payload = {}) {
        const rootPath = normalizeDiskPath(payload.rootPath || payload.path || '');
        if (!rootPath) return { success: false, error: 'Ruta vacia.' };
        if (!fsApi.existsSync(rootPath) || !fsApi.statSync(rootPath).isDirectory()) {
            return { success: false, error: 'La ruta no es una carpeta valida.' };
        }

        const existing = selectRoot.get(rootPath);
        if (existing?.locked === 1 && payload.locked !== true && payload.source !== existing.source) {
            return { success: false, error: 'Esta raiz es fija y solo se modifica desde su modulo original.' };
        }
        const conflict = !existing ? getRootConflict(rootPath) : null;
        if (conflict?.kind === 'inside-existing') {
            return { success: false, error: 'La carpeta ya esta cubierta por una raiz indexada.', conflict };
        }

        const now = new Date().toISOString();
        upsertRoot.run({
            rootPath,
            source: payload.source || 'extra',
            typeId: payload.typeId || null,
            recursive: payload.recursive === false ? 0 : 1,
            locked: payload.locked === true ? 1 : 0,
            enabled: payload.enabled === false ? 0 : 1,
            now
        });

        let assignment = null;
        if (payload.typeId) assignment = assignFolderType(rootPath, payload.typeId, { recursive: payload.recursive !== false });

        return { success: true, root: selectRoot.get(rootPath), conflict, assignment };
    }

    function assignFolderType(rootPath, typeId, options = {}) {
        const normalizedRoot = normalizeDiskPath(rootPath);
        const safeTypeId = String(typeId || '').trim();
        if (!normalizedRoot || !safeTypeId) return { success: false, error: 'Asignacion incompleta.' };
        const type = fileTypeResolver.getTypeById(getFileTypes(), safeTypeId);
        if (!type) return { success: false, error: 'Tipo de archivo invalido.' };

        const explicitTypes = getExplicitTypes();
        const fileTypeOptions = getFileTypeOptions();
        explicitTypes[normalizedRoot] = safeTypeId;
        fileTypeOptions[normalizedRoot] = {
            kind: 'folder',
            includeSubfolders: options.recursive !== false,
            ignoreSeparation: true,
            saveToHistory: type.history !== false
        };
        const explicitOk = writeJsonConfig(fsApi, explicitTypesPath, explicitTypes);
        const optionsOk = writeJsonConfig(fsApi, fileTypeOptionsPath, fileTypeOptions);
        return { success: explicitOk && optionsOk, typeId: safeTypeId, rootPath: normalizedRoot };
    }

    function listRoots() {
        return listRootsStmt.all().map(row => ({
            rootPath: row.root_path,
            source: row.source,
            typeId: row.type_id,
            recursive: row.recursive === 1,
            locked: row.locked === 1,
            enabled: row.enabled === 1,
            lastScanAt: row.last_scan_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    function collectAudioFiles(rootPath, recursive = true, limit = 100000) {
        const result = [];
        const stack = [rootPath];
        while (stack.length && result.length < limit) {
            const current = stack.pop();
            let entries = [];
            try {
                entries = fsApi.readdirSync(current, { withFileTypes: true });
            } catch (err) {
                continue;
            }
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (recursive) stack.push(fullPath);
                } else if (entry.isFile() && AUDIO_FILE_RE.test(entry.name)) {
                    result.push(fullPath);
                    if (result.length >= limit) break;
                }
            }
        }
        return result;
    }

    function buildIndexPayload(filePath, root, now) {
        const stat = fsApi.statSync(filePath);
        const track = selectTrack.get(filePath);
        const tags = track ? {} : readTagsFn(filePath);
        const meta = parseTitleAndArtistFromFile(filePath, tags);
        const fileTypes = getFileTypes();
        const explicitTypes = getExplicitTypes();
        const fileTypeOptions = getFileTypeOptions();
        const resolvedType = root.type_id
            ? fileTypeResolver.getTypeById(fileTypes, root.type_id)
            : fileTypeResolver.resolveFileType(filePath, track, fileTypes, explicitTypes, fileTypeOptions);
        const treated = isTreatedTrack(track);
        const changed = track && hasCueValue(track.file_size) && hasCueValue(track.file_mtime_ms)
            && (Number(track.file_size) !== Number(stat.size) || Math.round(Number(track.file_mtime_ms)) !== Math.round(Number(stat.mtimeMs)));

        return {
            filePath,
            rootPath: root.root_path,
            title: track?.custom_title || meta.title,
            artist: track?.custom_artist || meta.artist,
            album: track?.album || meta.album,
            year: track?.year || meta.year,
            genre: track?.genre || meta.genre,
            duration: track?.duration ?? null,
            fileSize: Number(stat.size) || 0,
            fileMtimeMs: Math.round(Number(stat.mtimeMs) || 0),
            typeId: resolvedType?.id || root.type_id || null,
            status: changed ? 'changed' : (treated ? 'treated' : 'pending'),
            now
        };
    }

    function syncRoot(rootPath) {
        const root = selectRoot.get(normalizeDiskPath(rootPath));
        if (!root) return { success: false, error: 'Raiz no registrada.' };
        if (root.enabled !== 1) return { success: false, error: 'Raiz deshabilitada.' };

        const now = new Date().toISOString();
        const files = collectAudioFiles(root.root_path, root.recursive === 1);
        let indexed = 0;
        let failed = 0;

        const tx = db.transaction((filePaths) => {
            for (const filePath of filePaths) {
                try {
                    upsertTrack.run(buildIndexPayload(filePath, root, now));
                    indexed++;
                } catch (err) {
                    failed++;
                }
            }
            markMissing.run(now, root.root_path, now);
            updateRootScan.run(now, now, root.root_path);
        });
        tx(files);

        return { success: true, rootPath: root.root_path, scanned: files.length, indexed, failed };
    }

    function syncAllRoots() {
        const roots = listRootsStmt.all().filter(root => root.enabled === 1);
        const results = roots.map(root => syncRoot(root.root_path));
        return {
            success: true,
            roots: results,
            scanned: results.reduce((sum, item) => sum + (item.scanned || 0), 0),
            indexed: results.reduce((sum, item) => sum + (item.indexed || 0), 0),
            failed: results.reduce((sum, item) => sum + (item.failed || 0), 0)
        };
    }

    function search(payload = {}) {
        const query = String(payload.query || '').trim();
        const typeId = String(payload.typeId || '').trim();
        const limit = Math.min(5000, Math.max(1, Number(payload.limit) || 100));
        const terms = query
            .split(/\s+/)
            .map(term => `%${term.replace(/[%_]/g, '')}%`)
            .filter(term => term.length > 2);
        const where = [];
        const params = {};

        if (typeId === '__music') {
            where.push("(type_id IS NULL OR type_id = '')");
        } else if (typeId && typeId !== 'all') {
            where.push('type_id = @typeId');
            params.typeId = typeId;
        }

        terms.forEach((term, index) => {
            const key = `term${index}`;
            params[key] = term;
            where.push(`(
                title LIKE @${key}
                OR artist LIKE @${key}
                OR album LIKE @${key}
                OR genre LIKE @${key}
                OR file_path LIKE @${key}
            )`);
        });
        params.limit = limit;

        const sql = `
            SELECT * FROM library_index_tracks
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY
                CASE status WHEN 'treated' THEN 0 WHEN 'pending' THEN 1 WHEN 'changed' THEN 2 ELSE 3 END,
                artist COLLATE NOCASE,
                title COLLATE NOCASE
            LIMIT @limit
        `;
        return db.prepare(sql).all(params).map(row => ({
            filePath: row.file_path,
            rootPath: row.root_path,
            title: row.title,
            artist: row.artist,
            album: row.album,
            year: row.year,
            genre: row.genre,
            duration: row.duration,
            fileSize: row.file_size,
            fileMtimeMs: row.file_mtime_ms,
            typeId: row.type_id,
            status: row.status,
            lastSeenAt: row.last_seen_at
        }));
    }

    return {
        addRoot,
        assignFolderType,
        listRoots,
        syncRoot,
        syncAllRoots,
        search,
        getRootConflict,
        collectAudioFiles
    };
}

module.exports = {
    AUDIO_FILE_RE,
    createLibraryIndexService,
    isTreatedTrack,
    normalizeDiskPath,
    isInsideRoot
};
