/**
 * Servicios de Géneros
 * Arquitectura "Control Remoto"
 * Soporta relaciones multi-padre y separadores de Windows (;)
 */
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodeID3 = require('node-id3');

let db;
let mainContext = {
    getSafeMainWindow: () => null,
    broadcastEvent: () => {},
    storeTrackFileSignature: () => {},
    AUDIO_FILE_RE: /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i,
    getTrackStmt: null,
    upsertArtistProfile: null,
    artists_applyGenreToTrackPaths: null,
    getTrackFileSignature: () => null,
    writeLog: (msg) => console.log(msg)
};

function _injectDeps(injectedDb, ctx) {
    db = injectedDb;
    Object.assign(mainContext, ctx);
}

const writeTagsAsync = (tags, file) => new Promise(resolve => nodeID3.update(tags, file, (err) => resolve(!err)));

function canReadFileBytes(filePath) {
    let fd = null;
    try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return false;
        fd = fs.openSync(filePath, 'r');
        const probe = Buffer.alloc(1);
        fs.readSync(fd, probe, 0, 1, 0);
        return true;
    } catch (err) {
        mainContext.writeLog(`Archivo no legible por Windows: ${filePath} (${err.message})`);
        return false;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (err) {}
        }
    }
}

function genreLabelToFileTag(value) {
    // Windows usa ; para separar géneros múltiples
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

async function writeGenreTagsToFiles(paths, genreLabel) {
    const safePaths = (Array.isArray(paths) ? paths : []).filter(filePath => filePath && mainContext.AUDIO_FILE_RE.test(filePath));
    const cleanGenre = String(genreLabel || '').trim();
    if (!cleanGenre || safePaths.length === 0) return { tagUpdated: 0, tagFailed: 0 };
    const tagGenre = genreLabelToFileTag(cleanGenre);
    let tagUpdated = 0;
    let tagFailed = 0;
    for (const filePath of safePaths) {
        try {
            if (!canReadFileBytes(filePath)) {
                tagFailed++;
                continue;
            }
            const ok = await writeTagsAsync({ genre: tagGenre }, filePath);
            if (ok) {
                tagUpdated++;
                mainContext.storeTrackFileSignature(filePath);
            } else {
                tagFailed++;
            }
        } catch (err) {
            tagFailed++;
        }
    }
    return { tagUpdated, tagFailed };
}

const GENRE_CANONICAL_ALIASES = new Map([
    ['tecnomerengue', 'tecno merengue'],
    ['techno merengue', 'tecno merengue'],
    ['tecnomerengue tipico', 'tecno merengue tipico'],
    ['regueton', 'reggaeton'],
    ['reggaeton', 'reggaeton'],
    ['dembow', 'dembow'],
    ['bachatas', 'bachata'],
    ['salsas', 'salsa'],
    ['merengues', 'merengue'],
    ['cristianas', 'cristiana']
]);

const KNOWN_GENRE_ROOTS = [
    'tecno merengue',
    'merengue',
    'salsa',
    'bachata',
    'dembow',
    'reggaeton',
    'changa',
    'vallenato',
    'joropo',
    'cumbia',
    'bolero',
    'balada',
    'tipico',
    'ranchera',
    'corridos',
    'cristiana',
    'navidad',
    'mambo',
    'son',
    'pop',
    'rock',
    'rap',
    'hip hop',
    'trap',
    'house',
    'edm',
    'disco',
    'soca',
    'dancehall',
    'reggae',
    'zouk'
].sort((a, b) => b.length - a.length);

function normalizeGenreKey(value) {
    let clean = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' y ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return '';
    clean = clean.replace(/\b(reggaeton|regueton)\b/g, 'reggaeton');
    const noSpaceAlias = GENRE_CANONICAL_ALIASES.get(clean.replace(/\s+/g, ''));
    const directAlias = GENRE_CANONICAL_ALIASES.get(clean);
    return directAlias || noSpaceAlias || clean;
}

function toDisplayGenre(value) {
    const clean = normalizeGenreKey(value);
    if (!clean) return '';
    return clean.split(' ').map(part => {
        if (/^\d{2,4}s$/.test(part)) return `${part.slice(0, -1)}s`;
        if (/^\d{2,4}$/.test(part)) return part;
        return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
}

function cleanSubgenreText(value) {
    let clean = normalizeGenreKey(value)
        .replace(/\b(de|del|la|las|los|el|y|en)\b/g, ' ')
        .replace(/\b(80|90|70|60)\s*(ta|s)?\b/g, '$1s')
        .replace(/\b(2000|2010|2020)\s*(s)?\b/g, '$1s')
        .replace(/\s+/g, ' ')
        .trim();
    return toDisplayGenre(clean);
}

function genreRootMatches(value) {
    const clean = normalizeGenreKey(value);
    return KNOWN_GENRE_ROOTS.find(root => clean === root || clean.startsWith(`${root} `)) || '';
}

function inferGenreFromFolderName(folderName, parentSuggestion = null) {
    const clean = normalizeGenreKey(folderName);
    if (!clean) return { genre: '', subgenre: '', genreKey: '', subgenreKey: '' };

    const root = genreRootMatches(clean);
    if (!root && parentSuggestion?.genre) {
        const subgenre = cleanSubgenreText(folderName);
        return {
            genre: parentSuggestion.genre,
            subgenre,
            genreKey: normalizeGenreKey(parentSuggestion.genre),
            subgenreKey: normalizeGenreKey(subgenre)
        };
    }

    const genreRoot = root || clean;
    let rest = root ? clean.slice(root.length).trim() : '';
    let genre = toDisplayGenre(genreRoot);
    let subgenre = cleanSubgenreText(rest);

    if (genreRoot === 'merengue' && /^(house|hip hop|mambo|tipico)/.test(rest)) {
        subgenre = cleanSubgenreText(rest);
    }

    return {
        genre,
        subgenre,
        genreKey: normalizeGenreKey(genre),
        subgenreKey: normalizeGenreKey(subgenre)
    };
}

function collectAudioFilesRecursive(dirPath, output = [], limit = 50000) {
    if (output.length >= limit) return output;
    let items = [];
    try { items = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (err) { return output; }
    for (const item of items) {
        if (output.length >= limit) break;
        const itemPath = path.join(dirPath, item.name);
        if (item.isDirectory()) collectAudioFilesRecursive(itemPath, output, limit);
        else if (item.isFile() && mainContext.AUDIO_FILE_RE.test(item.name)) output.push(itemPath);
    }
    return output;
}

function countAudioFilesQuick(dirPath) {
    return collectAudioFilesRecursive(dirPath, [], 20000).length;
}

function makeVirtualFolderId(sourcePath) {
    return `vf_${Buffer.from(String(sourcePath || '')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 120)}`;
}

function upsertGenreProfile(displayName, parentKeys = null, tipo = null) {
    const genreKey = normalizeGenreKey(displayName);
    if (!genreKey) return null;
    
    // Title Case format rule
    const finalDisplay = toDisplayGenre(displayName);
    const now = new Date().toISOString();
    
    const existing = db.prepare("SELECT tipo FROM genre_profiles WHERE genre_key = ?").get(genreKey);
    const finalTipo = tipo || existing?.tipo || 'sin_identificar';
    
    db.prepare(`
        INSERT INTO genre_profiles (genre_key, display_name, parent_genre, updated_at, tipo)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(genre_key) DO UPDATE SET
            display_name = excluded.display_name,
            parent_genre = COALESCE(excluded.parent_genre, genre_profiles.parent_genre),
            tipo = excluded.tipo,
            updated_at = excluded.updated_at
    `).run(genreKey, finalDisplay, null, now, finalTipo); // parent_genre will be managed by relacion_generos
    
    // Manage many-to-many relationship in relacion_generos if parentKeys provided
    if (parentKeys) {
        const parentList = Array.isArray(parentKeys) 
            ? parentKeys 
            : String(parentKeys).split(',').map(s => s.trim()).filter(Boolean);
            
        const insertRel = db.prepare("INSERT OR IGNORE INTO relacion_generos (id_padre, id_subgenero) VALUES (?, ?)");
        for (const pKey of parentList) {
            insertRel.run(pKey, genreKey);
        }
    }
    
    db.prepare(`
        INSERT INTO genre_aliases (alias_key, genre_key, display_name, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(alias_key) DO UPDATE SET
            genre_key = excluded.genre_key,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
    `).run(genreKey.replace(/\s+/g, ''), genreKey, finalDisplay, now);
    
    return { key: genreKey, displayName: finalDisplay, tipo: finalTipo };
}

function buildGenresJson(primary, subgenre) {
    const entries = [];
    if (primary?.key) entries.push({ key: primary.key, name: primary.displayName, role: 'primary' });
    if (subgenre?.key) entries.push({ key: subgenre.key, name: subgenre.displayName, role: 'subgenre', parent: primary?.key || null });
    return JSON.stringify(entries);
}

function moodToEnergyLevel(moodEnergy) {
    const mood = String(moodEnergy || '').toLowerCase();
    if (mood === 'alta' || mood.includes('alta')) return 3;
    if (mood === 'baja' || mood.includes('baja')) return 1;
    return 2;
}

function applyGenreToTrackPaths(paths, genreName, subgenreName = '', source = 'manual', folderGenrePath = '') {
    const primary = upsertGenreProfile(genreName);
    if (!primary) return { updatedTracks: 0, genre: '', subgenre: '' };
    const subgenre = subgenreName ? upsertGenreProfile(subgenreName, primary.key) : null;
    const genreLabel = subgenre ? `${primary.displayName} / ${subgenre.displayName}` : primary.displayName;
    const genresJson = buildGenresJson(primary, subgenre);
    const now = new Date().toISOString();
    
    const upsertTrack = db.prepare(`
        INSERT INTO tracks (file_path, genre, primary_genre, subgenre, genres_json, genre_source, genre_confidence, folder_genre_path, file_size, file_mtime_ms, metadata_updated_at)
        VALUES (@filePath, @genre, @primaryGenre, @subgenre, @genresJson, @genreSource, @genreConfidence, @folderGenrePath, @fileSize, @fileMtimeMs, @metadataUpdatedAt)
        ON CONFLICT(file_path) DO UPDATE SET
            genre = excluded.genre,
            primary_genre = excluded.primary_genre,
            subgenre = excluded.subgenre,
            genres_json = excluded.genres_json,
            genre_source = excluded.genre_source,
            genre_confidence = excluded.genre_confidence,
            folder_genre_path = excluded.folder_genre_path,
            file_size = COALESCE(excluded.file_size, tracks.file_size),
            file_mtime_ms = COALESCE(excluded.file_mtime_ms, tracks.file_mtime_ms),
            metadata_updated_at = excluded.metadata_updated_at
    `);
    
    const deleteLinks = db.prepare("DELETE FROM track_genre_links WHERE file_path = ? AND source IN ('folder','manual')");
    const insertLink = db.prepare(`
        INSERT OR REPLACE INTO track_genre_links (file_path, genre_key, role, confidence, source)
        VALUES (?, ?, ?, ?, ?)
    `);

    let updatedTracks = 0;
    db.transaction((trackPaths) => {
        for (const filePath of trackPaths) {
            if (!filePath || !mainContext.AUDIO_FILE_RE.test(filePath)) continue;
            const signature = mainContext.getTrackFileSignature(filePath);
            upsertTrack.run({
                filePath,
                genre: genreLabel,
                primaryGenre: primary.key,
                subgenre: subgenre?.displayName || null,
                genresJson,
                genreSource: source,
                genreConfidence: source === 'folder' ? 0.85 : 1,
                folderGenrePath: folderGenrePath || null,
                fileSize: signature?.fileSize ?? null,
                fileMtimeMs: signature?.fileMtimeMs ?? null,
                metadataUpdatedAt: now
            });
            deleteLinks.run(filePath);
            insertLink.run(filePath, primary.key, 'primary', source === 'folder' ? 0.85 : 1, source);
            if (subgenre) insertLink.run(filePath, subgenre.key, 'subgenre', source === 'folder' ? 0.85 : 1, source);
            updatedTracks++;
        }
    })(paths || []);
    
    return { updatedTracks, genre: primary.displayName, subgenre: subgenre?.displayName || '' };
}

function getGenreEditorCatalog() {
    // Escaneo de duplicados en tiempo real
    const duplicadosRaw = db.prepare(`
        SELECT LOWER(REPLACE(REPLACE(REPLACE(display_name, ' ', ''), '-', ''), 'y', 'i')) as norm, 
               COUNT(*) as c 
        FROM genre_profiles 
        WHERE COALESCE(is_active, 1) = 1
        GROUP BY norm HAVING c > 1
    `).all();
    
    const duplicateNorms = new Set(duplicadosRaw.map(d => d.norm));

    const rows = db.prepare(`
        SELECT
            gp.genre_key AS genreKey,
            gp.display_name AS displayName,
            gp.parent_genre AS parentGenre,
            parent.display_name AS parentName,
            gp.energy_level AS energyLevel,
            gp.color_hex AS colorHex,
            gp.mood_energy AS moodEnergy,
            gp.search_anchors_csv AS searchAnchorsCsv,
            gp.sort_order AS sortOrder,
            gp.is_active AS isActive,
            gp.tipo AS tipo,
            COALESCE(counts.trackCount, 0) AS trackCount
        FROM genre_profiles gp
        LEFT JOIN genre_profiles parent ON parent.genre_key = gp.parent_genre
        LEFT JOIN (
            SELECT genre_key, COUNT(DISTINCT file_path) AS trackCount
            FROM (
                SELECT primary_genre AS genre_key, file_path
                FROM tracks
                WHERE COALESCE(primary_genre, '') <> ''
                UNION ALL
                SELECT genre_key, file_path
                FROM track_genre_links
                WHERE COALESCE(genre_key, '') <> ''
            )
            GROUP BY genre_key
        ) counts ON counts.genre_key = gp.genre_key
        WHERE COALESCE(gp.is_active, 1) = 1
        ORDER BY COALESCE(gp.sort_order, 0), gp.display_name COLLATE NOCASE
    `).all();
    
    return rows.map(row => {
        const normName = String(row.displayName).toLowerCase().replace(/[\s-]/g, '').replace(/y/g, 'i');
        return {
            genreKey: row.genreKey,
            displayName: row.displayName || row.genreKey,
            parentGenre: row.parentGenre || '',
            parentName: row.parentName || '',
            energyLevel: row.energyLevel || moodToEnergyLevel(row.moodEnergy),
            colorHex: row.colorHex || '#00a8ff',
            moodEnergy: row.moodEnergy || 'media',
            searchAnchorsCsv: row.searchAnchorsCsv || '',
            sortOrder: row.sortOrder || 0,
            tipo: row.tipo || 'sin_identificar',
            trackCount: row.trackCount || 0,
            isDuplicate: duplicateNorms.has(normName)
        };
    });
}

function getGenreEditorTracks(genreKey) {
    const key = String(genreKey || '').trim();
    if (!key) return [];
    const profile = db.prepare("SELECT display_name AS displayName FROM genre_profiles WHERE genre_key = ?").get(key);
    const displayName = profile?.displayName || key;
    const keyPrefix = `${key}:%`;
    const displayPrefix = `${displayName} /%`;
    const displayLoosePrefix = `${displayName}%`;
    
    return db.prepare(`
        SELECT DISTINCT
            t.file_path AS filePath,
            COALESCE(NULLIF(t.custom_title, ''), '') AS title,
            COALESCE(NULLIF(t.custom_artist, ''), '') AS artist,
            t.genre,
            t.primary_genre AS primaryGenre,
            t.subgenre,
            t.year
        FROM tracks t
        LEFT JOIN track_genre_links tgl ON tgl.file_path = t.file_path
        WHERE t.primary_genre = ?
           OR t.primary_genre LIKE ?
           OR tgl.genre_key = ?
           OR tgl.genre_key LIKE ?
           OR t.genre = ? COLLATE NOCASE
           OR t.genre LIKE ? COLLATE NOCASE
           OR t.genre LIKE ? COLLATE NOCASE
        ORDER BY COALESCE(NULLIF(t.custom_artist, ''), '') COLLATE NOCASE,
                 COALESCE(NULLIF(t.custom_title, ''), t.file_path) COLLATE NOCASE
        LIMIT 500
    `).all(key, keyPrefix, key, keyPrefix, displayName, displayPrefix, displayLoosePrefix).map(row => ({
        ...row,
        title: row.title || path.basename(row.filePath || '', path.extname(row.filePath || ''))
    }));
}

function syncGenreLinksForExistingTracks() {
    const rows = db.prepare(`
        SELECT file_path AS filePath, genre, primary_genre AS primaryGenre, subgenre
        FROM tracks
        WHERE COALESCE(primary_genre, '') <> ''
           OR COALESCE(genre, '') <> ''
    `).all();
    
    // Obtener todas las keys activas para no resucitar perfiles eliminados
    const activeKeys = new Set(
        db.prepare("SELECT genre_key FROM genre_profiles WHERE COALESCE(is_active, 1) = 1").all()
            .map(r => r.genre_key)
    );
    
    const insertLink = db.prepare(`
        INSERT OR REPLACE INTO track_genre_links (file_path, genre_key, role, confidence, source)
        VALUES (?, ?, ?, ?, ?)
    `);
    
    let linked = 0;
    db.transaction((items) => {
        for (const row of items) {
            if (!row.filePath) continue;
            let primaryKey = row.primaryGenre ? normalizeGenreKey(row.primaryGenre) : '';
            let subgenreName = row.subgenre || '';
            if (!primaryKey && row.genre) {
                const parts = String(row.genre).split('/').map(part => part.trim()).filter(Boolean);
                primaryKey = parts[0] ? normalizeGenreKey(parts[0]) : '';
                subgenreName = subgenreName || parts.slice(1).join(' / ');
            }
            if (!primaryKey) continue;
            // Solo vincular si el perfil existe activo — NO creamos perfiles nuevos
            if (activeKeys.has(primaryKey)) {
                insertLink.run(row.filePath, primaryKey, 'primary', 0.95, 'sync');
                linked++;
            }
            if (subgenreName) {
                const subKey = normalizeGenreKey(subgenreName);
                if (subKey && activeKeys.has(subKey)) {
                    insertLink.run(row.filePath, subKey, 'subgenre', 0.9, 'sync');
                    linked++;
                }
            }
        }
    })(rows);
    
    return { tracks: rows.length, links: linked };
}

function browseGenreEditorPath(inputPath = '') {
    const rootPath = mainContext.getConfiguredLibraryRoot ? mainContext.getConfiguredLibraryRoot() : '';
    const currentPath = mainContext.getSafeBrowserPath ? mainContext.getSafeBrowserPath(inputPath) : inputPath;
    if (!currentPath || !fs.existsSync(currentPath)) {
        return { rootPath, currentPath: '', parentPath: '', entries: [] };
    }
    const resolvedRoot = path.resolve(rootPath || currentPath);
    const resolvedCurrent = path.resolve(currentPath);
    const entries = [];
    let items = [];
    try { items = fs.readdirSync(resolvedCurrent, { withFileTypes: true }); } catch (err) { items = []; }
    for (const item of items) {
        const itemPath = path.join(resolvedCurrent, item.name);
        if (item.isDirectory()) {
            entries.push({ type: 'folder', name: item.name, path: itemPath, audioCount: countAudioFilesQuick(itemPath) });
        } else if (item.isFile() && mainContext.AUDIO_FILE_RE.test(item.name)) {
            entries.push({ type: 'audio', name: item.name, path: itemPath, audioCount: 1 });
        }
    }
    entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    });
    return {
        rootPath: resolvedRoot,
        currentPath: resolvedCurrent,
        parentPath: resolvedCurrent === resolvedRoot ? '' : path.dirname(resolvedCurrent),
        entries
    };
}

function collectAudioFilesFromInputPaths(inputPaths, limit = 50000) {
    const audioFiles = [];
    for (const inputPath of Array.isArray(inputPaths) ? inputPaths : []) {
        if (audioFiles.length >= limit) break;
        try {
            if (!inputPath || !fs.existsSync(inputPath)) continue;
            const stats = fs.statSync(inputPath);
            if (stats.isDirectory()) collectAudioFilesRecursive(inputPath, audioFiles, limit);
            else if (stats.isFile() && mainContext.AUDIO_FILE_RE.test(inputPath)) audioFiles.push(inputPath);
        } catch (err) {}
    }
    return [...new Set(audioFiles)].slice(0, limit);
}

function suggestGenreForInputPaths(inputPaths = []) {
    const cleanPaths = (Array.isArray(inputPaths) ? inputPaths : []).filter(Boolean);
    const firstPath = cleanPaths[0] || '';
    if (!firstPath) return { genre: '', subgenre: '', genreKey: '', subgenreKey: '', paths: [] };
    let stats = null;
    try { if (fs.existsSync(firstPath)) stats = fs.statSync(firstPath); } catch (err) { stats = null; }
    const basePath = stats?.isFile() ? path.dirname(firstPath) : firstPath;
    const parentSuggestion = inferGenreFromFolderName(path.basename(path.dirname(basePath)));
    const suggestion = inferGenreFromFolderName(path.basename(basePath), parentSuggestion);
    const audioCount = collectAudioFilesFromInputPaths(cleanPaths, 50000).length;
    return {
        ...suggestion,
        paths: cleanPaths,
        basePath,
        baseName: path.basename(basePath),
        audioCount
    };
}

function saveGenreProfileForEditor(payload = {}) {
    const displayName = toDisplayGenre(payload.displayName || payload.name);
    if (!displayName) return { success: false, error: 'Genero invalido' };
    const parentKey = String(payload.parentGenre || '').trim() || null;
    const tipo = payload.tipo || 'sin_identificar';
    const profile = upsertGenreProfile(displayName, parentKey, tipo);
    const colorHex = /^#[0-9a-f]{6}$/i.test(String(payload.colorHex || '')) ? payload.colorHex : '#00a8ff';
    const moodEnergy = ['alta', 'media', 'baja'].includes(String(payload.moodEnergy || '').toLowerCase())
        ? String(payload.moodEnergy).toLowerCase()
        : 'media';
    const anchors = mainContext.cleanCsvList ? mainContext.cleanCsvList(payload.searchAnchorsCsv || payload.anchorsCsv || '') : (payload.searchAnchorsCsv || '');
    const now = new Date().toISOString();
    
    db.prepare(`
        UPDATE genre_profiles
        SET color_hex = ?, mood_energy = ?, energy_level = ?, search_anchors_csv = ?,
            parent_genre = ?, tipo = ?, is_active = 1, updated_at = ?
        WHERE genre_key = ?
    `).run(colorHex, moodEnergy, moodToEnergyLevel(moodEnergy), anchors || null, parentKey, tipo, now, profile.key);
    
    return { success: true, genre: getGenreEditorCatalog().find(item => item.genreKey === profile.key) || profile };
}

function getGenreProfileByKey(genreKey) {
    const key = String(genreKey || '').trim();
    if (!key) return null;
    return db.prepare(`
        SELECT gp.genre_key AS genreKey,
               gp.display_name AS displayName,
               gp.parent_genre AS parentGenre,
               parent.display_name AS parentName
        FROM genre_profiles gp
        LEFT JOIN genre_profiles parent ON parent.genre_key = gp.parent_genre
        WHERE gp.genre_key = ?
    `).get(key) || null;
}

function getTrackPathsForGenreKeys(genreKeys = []) {
    const keys = [...new Set((Array.isArray(genreKeys) ? genreKeys : []).map(key => String(key || '').trim()).filter(Boolean))];
    if (!keys.length) return [];
    const profiles = keys.map(getGenreProfileByKey).filter(Boolean);
    const names = profiles.map(profile => profile.displayName).filter(Boolean);
    const nameLikes = names.map(name => `${name} /%`);
    const keyPlaceholders = keys.map(() => '?').join(',');
    const namePlaceholders = names.length ? names.map(() => '?').join(',') : "''";
    const likeClause = nameLikes.length ? `OR ${nameLikes.map(() => 'genre COLLATE NOCASE LIKE ?').join(' OR ')}` : '';
    
    const rows = db.prepare(`
        SELECT DISTINCT file_path AS filePath
        FROM (
            SELECT file_path
            FROM tracks
            WHERE primary_genre IN (${keyPlaceholders})
               OR genre COLLATE NOCASE IN (${namePlaceholders})
               OR subgenre COLLATE NOCASE IN (${namePlaceholders})
               ${likeClause}
            UNION
            SELECT file_path
            FROM track_genre_links
            WHERE genre_key IN (${keyPlaceholders})
        )
        WHERE COALESCE(file_path, '') <> ''
    `).all(...keys, ...names, ...names, ...nameLikes, ...keys);
    
    return rows.map(row => row.filePath).filter(Boolean);
}

function applyProfileToExistingTracks(trackPaths, profile, source = 'genre-curation') {
    const cleanPaths = [...new Set((Array.isArray(trackPaths) ? trackPaths : []).filter(Boolean))];
    if (!cleanPaths.length || !profile) return { updatedTracks: 0, genreKey: profile?.genreKey || '' };
    const parentProfile = profile.parentGenre ? getGenreProfileByKey(profile.parentGenre) : null;
    const primaryName = parentProfile?.displayName || profile.displayName;
    const subgenreName = parentProfile ? profile.displayName : '';
    
    db.transaction((paths) => {
        const deleteLinks = db.prepare("DELETE FROM track_genre_links WHERE file_path = ?");
        for (const filePath of paths) deleteLinks.run(filePath);
    })(cleanPaths);
    
    const result = applyGenreToTrackPaths(cleanPaths, primaryName, subgenreName, source, '');
    return { ...result, genreKey: profile.genreKey };
}

function mergeGenreProfilesForEditor(payload = {}) {
    // 5 pasos para unificar duplicados cross-container
    const targetKey = String(payload.targetGenreKey || '').trim();
    const sourceKeys = [...new Set((Array.isArray(payload.sourceGenreKeys) ? payload.sourceGenreKeys : []).map(key => String(key || '').trim()).filter(key => key && key !== targetKey))];
    const targetProfile = getGenreProfileByKey(targetKey);
    const finalType = payload.finalType || targetProfile?.tipo || 'sin_identificar';

    if (!targetProfile || !sourceKeys.length) return { success: false, error: 'Selecciona generos validos para unificar.' };
    const validSourceKeys = sourceKeys.filter(key => getGenreProfileByKey(key));
    const affectedPaths = getTrackPathsForGenreKeys(validSourceKeys);
    const now = new Date().toISOString();
    
    // Paso 2: Reasignar todas las canciones vinculadas al ID principal que prevalece
    const applied = applyProfileToExistingTracks(affectedPaths, targetProfile, 'genre-merge');
    
    // Paso 3: Modificar el tipo del ID principal
    db.prepare("UPDATE genre_profiles SET tipo = ?, is_active = 1, updated_at = ? WHERE genre_key = ?").run(finalType, now, targetKey);
    
    db.transaction((keys) => {
        // Paso 4: Eliminar de la base de datos los registros sobrantes y limpiar rastros
        const deleteProfile = db.prepare("DELETE FROM genre_profiles WHERE genre_key = ?");
        const deleteRelations = db.prepare("DELETE FROM relacion_generos WHERE id_padre = ? OR id_subgenero = ?");
        const reassignLinks = db.prepare("UPDATE track_genre_links SET genre_key = ? WHERE genre_key = ?");
        const reassignPrimary = db.prepare("UPDATE tracks SET primary_genre = ? WHERE primary_genre = ?");
        const alias = db.prepare("UPDATE genre_aliases SET genre_key = ?, updated_at = ? WHERE genre_key = ?");
        const folders = db.prepare("UPDATE library_virtual_folders SET genre_key = ?, updated_at = ? WHERE genre_key = ?");
        const artists = db.prepare("UPDATE artist_profiles SET main_genre_key = ?, updated_at = ? WHERE main_genre_key = ?");
        for (const key of keys) {
            // Reasignar links y tracks al target antes de borrar el perfil
            reassignLinks.run(targetKey, key);
            reassignPrimary.run(targetKey, key);
            alias.run(targetKey, now, key);
            folders.run(targetKey, now, key);
            artists.run(targetProfile.parentGenre || targetKey, now, key);
            deleteRelations.run(key, key);
            deleteProfile.run(key);
        }
    })(validSourceKeys);
    
    syncGenreLinksForExistingTracks();
    broadcastGenreProfilesUpdated();
    
    // Paso 5: (se encarga el frontend de limpiar la alerta recargando el catalog)
    return { success: true, targetGenreKey: targetKey, mergedProfiles: validSourceKeys.length, updatedTracks: applied.updatedTracks || 0 };
}

function setGenreProfileTypeForEditor(payload = {}) {
    const keys = [...new Set((Array.isArray(payload.genreKeys) ? payload.genreKeys : []).map(key => String(key || '').trim()).filter(Boolean))];
    const type = String(payload.type || '').trim().toLowerCase();
    if (!keys.length || !['root', 'subgenre'].includes(type)) return { success: false, error: 'Datos incompletos.' };
    
    let parentProfile = null;
    if (type === 'subgenre') {
        const parentRaw = String(payload.parentGenre || payload.parentGenreKey || '').trim();
        const parentKey = parentRaw; // Simplificado para esta implementación
        parentProfile = getGenreProfileByKey(parentKey);
        if (!parentProfile) return { success: false, error: 'Genero padre invalido.' };
    }

    let updatedProfiles = 0;
    let updatedTracks = 0;
    const resultingKeys = [];
    const now = new Date().toISOString();
    
    for (const key of keys) {
        const profile = getGenreProfileByKey(key);
        if (!profile) continue;
        if (parentProfile && key === parentProfile.genreKey) continue;

        const target = type === 'root'
            ? upsertGenreProfile(profile.displayName, null)
            : upsertGenreProfile(profile.displayName, parentProfile.genreKey);
            
        const targetProfile = getGenreProfileByKey(target?.key);
        if (!targetProfile) continue;

        const affectedPaths = getTrackPathsForGenreKeys([key]);
        const applied = applyProfileToExistingTracks(affectedPaths, targetProfile, 'genre-type');
        updatedTracks += applied.updatedTracks || 0;
        resultingKeys.push(targetProfile.genreKey);

        db.transaction(() => {
            db.prepare("UPDATE genre_aliases SET genre_key = ?, updated_at = ? WHERE genre_key = ?").run(targetProfile.genreKey, now, key);
            db.prepare("UPDATE library_virtual_folders SET genre_key = ?, updated_at = ? WHERE genre_key = ?").run(targetProfile.genreKey, now, key);
            db.prepare("UPDATE artist_profiles SET main_genre_key = ?, updated_at = ? WHERE main_genre_key = ?").run(parentProfile?.genreKey || targetProfile.genreKey, now, key);
            if (key === targetProfile.genreKey) {
                db.prepare("UPDATE genre_profiles SET parent_genre = ?, is_active = 1, updated_at = ? WHERE genre_key = ?")
                    .run(parentProfile?.genreKey || null, now, key);
            } else {
                db.prepare("UPDATE genre_profiles SET is_active = 0, updated_at = ? WHERE genre_key = ?").run(now, key);
            }
        })();
        updatedProfiles++;
    }
    
    syncGenreLinksForExistingTracks();
    broadcastGenreProfilesUpdated();
    return { success: true, updatedProfiles, updatedTracks, genreKeys: resultingKeys, selectedGenreKey: resultingKeys[0] || '' };
}

function broadcastGenreProfilesUpdated() {
    mainContext.broadcastEvent('genre-profiles-updated');
}

function upsertVirtualFolder(item) {
    const genre = upsertGenreProfile(item.genre);
    if (!genre) return;
    const subgenre = item.subgenre ? upsertGenreProfile(item.subgenre, genre.key) : null;
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO library_virtual_folders (id, name, parent_id, source_path, genre_key, depth, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            parent_id = excluded.parent_id,
            source_path = excluded.source_path,
            genre_key = excluded.genre_key,
            depth = excluded.depth,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at
    `).run(
        makeVirtualFolderId(item.path),
        path.basename(item.path || '') || item.genre,
        item.parentPath ? makeVirtualFolderId(item.parentPath) : null,
        item.path,
        subgenre?.key || genre.key,
        Number(item.depth) || 1,
        Number(item.sortOrder) || 0,
        now
    );
}

function buildRootGenrePreview(rootPath) {
    const root = path.resolve(rootPath || '');
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    const items = [];
    const rootDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => path.join(root, item.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
        .slice(0, 300);

    for (const dirPath of rootDirs) {
        const suggestion = inferGenreFromFolderName(path.basename(dirPath));
        items.push({
            path: dirPath,
            name: path.basename(dirPath),
            depth: 1,
            parentPath: '',
            suggestedGenre: suggestion.genre,
            suggestedSubgenre: suggestion.subgenre,
            trackCount: countAudioFilesQuick(dirPath)
        });

        let childDirs = [];
        try {
            childDirs = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(item => item.isDirectory())
                .map(item => path.join(dirPath, item.name))
                .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
                .slice(0, 120);
        } catch (err) {}

        for (const childPath of childDirs) {
            const childSuggestion = inferGenreFromFolderName(path.basename(childPath), suggestion);
            items.push({
                path: childPath,
                name: path.basename(childPath),
                depth: 2,
                parentPath: dirPath,
                suggestedGenre: childSuggestion.genre,
                suggestedSubgenre: childSuggestion.subgenre,
                trackCount: countAudioFilesQuick(childPath)
            });
        }
    }
    return items;
}

function reclassifyGenreForEditor(payload = {}) {
    const genreKey = String(payload.genreKey || '').trim();
    const newTipo = String(payload.tipo || '').trim();
    const parentGenre = String(payload.parentGenre || '').trim() || null;

    if (!genreKey) return { success: false, error: 'genreKey vacío.' };
    if (!['padre', 'subgenero', 'sin_identificar'].includes(newTipo)) return { success: false, error: 'Tipo inválido.' };

    // Verificar que el registro existe
    const existing = db.prepare("SELECT genre_key, tipo FROM genre_profiles WHERE genre_key = ?").get(genreKey);
    if (!existing) return { success: false, error: 'Género no encontrado.' };
    if (existing.tipo === newTipo) return { success: true, changed: false };

    // UPDATE directo — no crea nada nuevo, solo transfiere
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE genre_profiles 
        SET tipo = ?, parent_genre = ?, updated_at = ?
        WHERE genre_key = ?
    `).run(newTipo, parentGenre, now, genreKey);

    broadcastGenreProfilesUpdated();
    return { success: true, changed: true, genreKey, tipo: newTipo };
}

module.exports = {
    _injectDeps,
    genreLabelToFileTag,
    genreFileTagToLibraryLabel,
    writeGenreTagsToFiles,
    normalizeGenreKey,
    toDisplayGenre,
    cleanSubgenreText,
    inferGenreFromFolderName,
    collectAudioFilesRecursive,
    countAudioFilesQuick,
    upsertGenreProfile,
    buildGenresJson,
    applyGenreToTrackPaths,
    getGenreEditorCatalog,
    getGenreEditorTracks,
    syncGenreLinksForExistingTracks,
    browseGenreEditorPath,
    collectAudioFilesFromInputPaths,
    suggestGenreForInputPaths,
    saveGenreProfileForEditor,
    getGenreProfileByKey,
    mergeGenreProfilesForEditor,
    setGenreProfileTypeForEditor,
    reclassifyGenreForEditor,
    broadcastGenreProfilesUpdated,
    upsertVirtualFolder,
    buildRootGenrePreview
};
