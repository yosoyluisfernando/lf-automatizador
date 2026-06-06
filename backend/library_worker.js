const { parentPort } = require('worker_threads');
const path = require('path');
const db = require('../database');
const { getConfigDir } = require('./utils/app_paths');

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const fileTypesPath = path.join(configDir, 'file_types.json');
const explicitTypesPath = path.join(configDir, 'explicit_types.json');
const fs = require('fs');

const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

function loadJsonConfig(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed || fallback;
    } catch (err) {
        return fallback;
    }
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function textIncludesToken(haystack, token) {
    const cleanNeedle = normalizeText(token);
    if (!cleanNeedle) return false;
    const cleanHaystack = normalizeText(haystack);
    return cleanHaystack.includes(cleanNeedle);
}

function isUtilityType(type) {
    const text = normalizeText(`${type?.name || ''} ${type?.identifier || ''}`);
    return /(locuci|hora|time|saytime|station|pisador|jingle|id|comercial|spot|promo)/i.test(text);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getFileTypes() {
    return loadJsonConfig(fileTypesPath, []);
}

function getExplicitTypes() {
    return loadJsonConfig(explicitTypesPath, {});
}

function getTypeData(filePath, row = null, fileTypes = [], explicitTypes = {}) {
    if (row?.type_id) {
        const found = fileTypes.find(type => type.id === row.type_id);
        if (found) return found;
    }
    if (explicitTypes[filePath]) {
        const found = fileTypes.find(type => type.id === explicitTypes[filePath]);
        if (found) return found;
    }
    const dirPath = path.dirname(filePath);
    if (explicitTypes[dirPath]) {
        const found = fileTypes.find(type => type.id === explicitTypes[dirPath]);
        if (found) return found;
    }

    const nameStr = path.basename(filePath).toLowerCase();
    for (const type of fileTypes) {
        const identifier = type._identifier !== undefined ? type._identifier : String(type.identifier || '').toLowerCase().trim();
        if (!identifier) continue;
        if (type._regex) {
            if (type._regex.test(nameStr)) return type;
        } else if (type._identifier !== undefined) {
            if (nameStr.includes(identifier)) return type;
        } else {
            if (/^[a-z0-9]+$/.test(identifier)) {
                if (new RegExp(`\\b${identifier}\\b`, 'i').test(nameStr)) return type;
            } else if (nameStr.includes(identifier)) {
                return type;
            }
        }
    }
    return null;
}

function getGenreCategoryDefs() {
    const categories = [];
    const seen = new Set();
    const addGenre = (genreKey, displayName, parentGenre = '') => {
        const parentKey = normalizeText(parentGenre);
        const baseKey = normalizeText(genreKey || displayName);
        const key = parentKey && baseKey && !baseKey.includes(':') ? `${parentKey}:${baseKey}` : baseKey;
        if (!key || seen.has(key)) return;
        seen.add(key);
        const name = String(displayName || genreKey || '').trim() || key;
        const parentName = String(parentGenre || '').trim();
        categories.push({
            id: `genre:${key}`,
            name: parentName ? `${parentName} / ${name}` : name,
            color: '#2ecc71',
            source: 'genre',
            genreKey: key,
            parentGenre: parentKey,
            sortName: parentName ? `${parentName} / ${name}` : name,
            aliases: parentName ? [`${name} (${parentName})`, name] : []
        });
    };

    try {
        db.prepare(`
            SELECT genre_key AS genreKey, display_name AS displayName, parent_genre AS parentGenre
            FROM genre_profiles
            ORDER BY display_name COLLATE NOCASE
        `).all().forEach(profile => {
            addGenre(profile.genreKey, profile.displayName || profile.genreKey, profile.parentGenre || '');
        });
    } catch (err) {}

    const stmt = db.prepare(`SELECT genre, primary_genre, subgenre, genres_json FROM tracks WHERE genre IS NOT NULL OR primary_genre IS NOT NULL OR subgenre IS NOT NULL`);
    for (const row of stmt.iterate()) {
        const genre = row?.genre || '';
        const genreParts = String(genre).split('/').map(part => part.trim()).filter(Boolean);
        const primaryGenre = row?.primary_genre || genreParts[0] || '';
        if (primaryGenre || genreParts[0]) addGenre(primaryGenre || genreParts[0], genreParts[0] || primaryGenre);
        if (row?.subgenre) addGenre(row.subgenre, row.subgenre, primaryGenre || genreParts[0] || '');
        if (genreParts.length > 1) addGenre(genreParts.slice(1).join(' / '), genreParts.slice(1).join(' / '), primaryGenre || genreParts[0] || '');
        try {
            const parsed = JSON.parse(row?.genres_json || '[]');
            if (Array.isArray(parsed)) parsed.forEach(item => addGenre(item.key, item.name || item.key, item.parent || ''));
        } catch (err) {}
    }

    return categories.sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name), 'es', { sensitivity: 'base' }));
}

function getCategoryDefs(fileTypes = []) {
    return [
        { id: 'default', name: 'Musica', color: '#e0e0e0', source: 'type' },
        ...fileTypes.map(type => ({
            id: type.id,
            name: type.name,
            color: type.color || '#e0e0e0',
            identifier: type.identifier || '',
            source: 'type'
        })),
        ...getGenreCategoryDefs()
    ];
}

function resolveCategory(token, categoryDefs = []) {
    const clean = normalizeText(String(token || '').replace(/^@/, ''));
    if (!clean || ['musica', 'default', 'general', 'normal'].includes(clean)) {
        return { id: 'default', name: 'Musica', color: '#e0e0e0' };
    }
    return categoryDefs.find(category => {
        return normalizeText(category.id) === clean
            || normalizeText(category.name) === clean
            || normalizeText(category.identifier) === clean
            || normalizeText(category.genreKey) === clean
            || (Array.isArray(category.aliases) && category.aliases.some(alias => normalizeText(alias) === clean));
    }) || null;
}

function getDefaultPattern(fileTypes = []) {
    const stationId = fileTypes.find(type => /station|id|pisador|jingle/i.test(`${type.name} ${type.identifier}`));
    return ['Musica', stationId ? stationId.name : null, 'Musica', 'Musica'].filter(Boolean).join('\n');
}

function normalizePrefs(payload = {}, fileTypes = []) {
    const clampInt = (value, fallback, min, max) => {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min, Math.min(max, parsed));
    };
    return {
        pattern: String(payload.pattern || '').trim() || getDefaultPattern(fileTypes),
        targetMinutes: clampInt(payload.targetMinutes, 60, 5, 360),
        sepArtist: clampInt(payload.sepArtist, 4, 0, 50),
        sepTitle: clampInt(payload.sepTitle, 8, 0, 50),
        sepFolder: clampInt(payload.sepFolder, 2, 0, 50),
        clearList: payload.clearList === true
    };
}

function getPatternCategories(patternText, categoryDefs = [], fileTypes = []) {
    const rawTokens = String(patternText || '').split(/[\n,>]+/).map(token => token.trim()).filter(Boolean);
    const tokens = rawTokens.length ? rawTokens : getDefaultPattern(fileTypes).split(/\n/);
    return tokens.map(token => ({ token, category: resolveCategory(token, categoryDefs) })).filter(item => item.category);
}

function getTrackTitle(row) {
    const filePath = row.file_path || '';
    const baseName = path.basename(filePath, path.extname(filePath));
    const title = String(row.custom_title || '').trim();
    const artist = String(row.custom_artist || '').trim();
    if (artist && title) return `${artist} - ${title}${path.extname(filePath)}`;
    return `${title || baseName}${path.extname(filePath)}`;
}

function getArtistKey(row) {
    const artist = String(row.custom_artist || '').trim();
    if (artist) return normalizeText(artist);
    const baseName = path.basename(row.file_path || '', path.extname(row.file_path || ''));
    const split = baseName.split(/\s+-\s+/);
    return normalizeText(split.length > 1 ? split[0] : baseName);
}

function getTitleKey(row) {
    const title = String(row.custom_title || '').trim();
    if (title) return normalizeText(title);
    const baseName = path.basename(row.file_path || '', path.extname(row.file_path || ''));
    const split = baseName.split(/\s+-\s+/);
    return normalizeText(split.length > 1 ? split.slice(1).join(' - ') : baseName);
}

function getDuration(row) {
    const start = parseFloat(row.inicio || 0) || 0;
    const end = parseFloat(row.fin || 0) || 0;
    if (end > start) return Math.round(end - start);
    const duration = parseFloat(row.duration || 0) || 0;
    return duration > 0 ? Math.round(duration) : 180;
}

function getTrackGenreCategoryIds(row) {
    const ids = new Set();
    const add = (value) => {
        const key = normalizeText(value);
        if (key) ids.add(`genre:${key}`);
    };
    const addSubgenre = (subgenre, parentGenre = '') => {
        const subKey = normalizeText(subgenre);
        if (!subKey) return;
        const parentKey = normalizeText(parentGenre);
        if (parentKey && !subKey.includes(':')) add(`${parentKey}:${subKey}`);
        add(subKey);
    };
    add(row?.primary_genre);
    const genreParts = String(row?.genre || '').split('/').map(part => part.trim()).filter(Boolean);
    genreParts.forEach(add);
    if (genreParts.length > 1) addSubgenre(genreParts.slice(1).join(' / '), row?.primary_genre || genreParts[0] || '');
    addSubgenre(row?.subgenre, row?.primary_genre || genreParts[0] || '');
    try {
        const parsed = JSON.parse(row?.genres_json || '[]');
        if (Array.isArray(parsed)) parsed.forEach(item => add(item.key || item.name));
    } catch (err) {}
    return Array.from(ids);
}

function inferCategoryIdsFromPath(row, compiledCategoryDefs = [], typeData = null) {
    const ids = new Set();
    const haystack = [
        path.dirname(row?.file_path || ''),
        path.basename(row?.file_path || '', path.extname(row?.file_path || '')),
        row?.genre,
        row?.primary_genre,
        row?.subgenre
    ].filter(Boolean).join(' ');

    const cleanHaystack = normalizeText(haystack);
    
    if (cleanHaystack) {
        compiledCategoryDefs.forEach(category => {
            if (category.normalizedCandidates.some(cleanNeedle => cleanHaystack.includes(cleanNeedle))) {
                ids.add(category.id);
            }
        });
    }

    if (!typeData || !isUtilityType(typeData)) ids.add('default');
    return Array.from(ids);
}

function addCandidate(byCategory, catId, track) {
    if (!byCategory.has(catId)) byCategory.set(catId, []);
    byCategory.get(catId).push(track);
}

function isTimeLocutionTrack(track) {
    return track?.rowType === 'time' || track?.filePath === 'time_locution';
}

function getCandidates(categoryDefs = [], fileTypes = [], explicitTypes = {}) {
    const byCategory = new Map();
    categoryDefs.forEach(category => byCategory.set(category.id, []));
    const timeCategory = fileTypes.find(type => /locuci|hora|time|saytime/i.test(`${type.name} ${type.identifier}`));
    if (timeCategory) {
        addCandidate(byCategory, timeCategory.id, {
            filePath: 'time_locution',
            title: '⌚ Locución de hora',
            duration: 5,
            artistKey: 'locucion-hora',
            titleKey: 'locucion-hora',
            folderKey: 'time',
            rowType: 'time'
        });
    }

    const compiledCategoryDefs = categoryDefs.map(category => {
        if (!category || category.id === 'default' || (category.source === 'type' && isUtilityType(category))) return null;
        const candidates = [category.name, category.identifier, category.genreKey, ...(Array.isArray(category.aliases) ? category.aliases : [])].filter(Boolean);
        const normalizedCandidates = [...new Set(candidates.map(c => normalizeText(c)).filter(Boolean))];
        return { id: category.id, normalizedCandidates };
    }).filter(Boolean);

    const compiledFileTypes = fileTypes.map(type => {
        const identifier = String(type.identifier || '').toLowerCase().trim();
        let regex = null;
        if (identifier && /^[a-z0-9]+$/.test(identifier)) regex = new RegExp(`\\b${identifier}\\b`, 'i');
        return { ...type, _identifier: identifier, _regex: regex };
    });

    const stmt = db.prepare(`
        SELECT file_path, custom_title, custom_artist, genre, primary_genre, subgenre, genres_json,
               inicio, fin, duration
        FROM tracks
    `);
    
    for (const row of stmt.iterate()) {
        const filePath = row.file_path || '';
        if (!filePath || !AUDIO_FILE_RE.test(filePath)) continue;
        const typeData = getTypeData(filePath, row, compiledFileTypes, explicitTypes);
        const catId = typeData ? typeData.id : 'default';
        const track = {
            filePath,
            title: getTrackTitle(row),
            duration: getDuration(row),
            artistKey: getArtistKey(row),
            titleKey: getTitleKey(row),
            folderKey: normalizeText(path.dirname(filePath)),
            rowType: 'normal'
        };
        addCandidate(byCategory, catId, track);
        getTrackGenreCategoryIds(row).forEach(genreCatId => addCandidate(byCategory, genreCatId, track));
        inferCategoryIdsFromPath(row, compiledCategoryDefs, typeData).forEach(inferredCatId => addCandidate(byCategory, inferredCatId, track));
    }

    byCategory.forEach((tracks, catId) => {
        const unique = [];
        const seenPaths = new Set();
        tracks.forEach(track => {
            if (!track?.filePath || seenPaths.has(track.filePath)) return;
            seenPaths.add(track.filePath);
            unique.push(track);
        });
        byCategory.set(catId, shuffleArray(unique));
    });
    return byCategory;
}

function wasRecentlyUsed(value, recent, distance) {
    if (!value || distance <= 0) return false;
    return recent.slice(-distance).includes(value);
}

function pickTrack(pool, recent, prefs) {
    if (!pool || pool.length === 0) return null;
    const passes = [
        track => (isTimeLocutionTrack(track) || !recent.paths.includes(track.filePath))
            && !wasRecentlyUsed(track.artistKey, recent.artists, prefs.sepArtist)
            && !wasRecentlyUsed(track.titleKey, recent.titles, prefs.sepTitle)
            && !wasRecentlyUsed(track.folderKey, recent.folders, prefs.sepFolder),
        track => (isTimeLocutionTrack(track) || !recent.paths.includes(track.filePath))
            && !wasRecentlyUsed(track.artistKey, recent.artists, Math.floor(prefs.sepArtist / 2))
            && !wasRecentlyUsed(track.titleKey, recent.titles, Math.floor(prefs.sepTitle / 2)),
        track => isTimeLocutionTrack(track) || !recent.paths.includes(track.filePath),
        () => true
    ];
    for (const predicate of passes) {
        const index = pool.findIndex(predicate);
        if (index >= 0) {
            const track = pool[index];
            return isTimeLocutionTrack(track) ? { ...track } : pool.splice(index, 1)[0];
        }
    }
    return null;
}

function buildClockwheelPlan(payload = {}) {
    const fileTypes = getFileTypes();
    const explicitTypes = getExplicitTypes();
    
    // Optimizamos obteniendo solo el count para los stats finales
    const trackCount = db.prepare("SELECT COUNT(*) AS count FROM tracks").get().count;
    
    const prefs = normalizePrefs(payload, fileTypes);
    const categoryDefs = getCategoryDefs(fileTypes);
    const pattern = getPatternCategories(prefs.pattern, categoryDefs, fileTypes);
    const byCategory = getCandidates(categoryDefs, fileTypes, explicitTypes);
    
    const emptyCategories = pattern.filter(p => !byCategory.has(p.category.id) || byCategory.get(p.category.id).length === 0);
    if (emptyCategories.length > 0) {
        const names = [...new Set(emptyCategories.map(p => p.category.name))];
        throw new Error(`Faltan canciones: Las categorias [${names.join(', ')}] no tienen ninguna pista asignada en la biblioteca.`);
    }

    const recent = { paths: [], artists: [], titles: [], folders: [] };
    const tracks = [];
    const missing = new Map();
    const targetSeconds = prefs.targetMinutes * 60;
    let totalSeconds = 0;
    let cursor = 0;
    let attempts = 0;

    while (totalSeconds < targetSeconds && pattern.length > 0 && attempts < 1200) {
        attempts++;
        const item = pattern[cursor % pattern.length];
        cursor++;
        const pool = byCategory.get(item.category.id) || [];
        const track = pickTrack(pool, recent, prefs);
        if (!track) {
            missing.set(item.category.name, (missing.get(item.category.name) || 0) + 1);
            if (Array.from(byCategory.values()).every(list => list.length === 0)) break;
            continue;
        }

        tracks.push({ ...track, category: item.category });
        totalSeconds += track.duration;
        recent.paths.push(track.filePath);
        recent.artists.push(track.artistKey);
        recent.titles.push(track.titleKey);
        recent.folders.push(track.folderKey);
        if (recent.paths.length > 60) recent.paths.shift();
        if (recent.artists.length > 60) recent.artists.shift();
        if (recent.titles.length > 60) recent.titles.shift();
        if (recent.folders.length > 60) recent.folders.shift();
    }

    return {
        prefs,
        pattern,
        tracks,
        totalSeconds,
        missing: Array.from(missing.keys()),
        candidateCount: trackCount
    };
}

const PROTECTED_ARTIST_GROUP_NAMES = [
    'AC/DC', 'Chino y Nacho', 'Sandy y Papo', 'Wisin y Yandel', 'Alexis y Fido',
    'Zion y Lennox', 'Jowell y Randy', 'Mau y Ricky', 'Monchy y Alexandra',
    'Hector y Tito', 'Baby Rasta y Gringo', 'Angel y Khriz', 'RKM y Ken-Y',
    'Rakim y Ken-Y'
];

function normalizeArtistKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeArtistGroupKey(value) {
    return normalizeArtistKey(String(value || '').replace(/&/g, ' y ').replace(/\+/g, ' y '));
}

const PROTECTED_ARTIST_GROUP_KEYS = new Set(PROTECTED_ARTIST_GROUP_NAMES.map(normalizeArtistGroupKey));

function isProtectedArtistGroup(value) {
    const key = normalizeArtistGroupKey(value);
    return !!key && PROTECTED_ARTIST_GROUP_KEYS.has(key);
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
        const cleanFeat = toDisplayArtist(featValue);
        if (isProtectedArtistGroup(cleanFeat)) return [cleanFeat];
        return featValue.split(/\s*(?:,|;|\||\/|\\|\s+x\s+|\s+y\s+|\s+vs\.?\s+|&)\s*/i).map(toDisplayArtist).filter(Boolean);
    }
    return [];
}

function filterInternalGroupFeats(mainArtist, feats = []) {
    const cleanMain = toDisplayArtist(mainArtist);
    if (!cleanMain || !isProtectedArtistGroup(cleanMain)) return feats;
    const mainTokens = new Set(normalizeArtistKey(cleanMain).split(' ').filter(token => token && token !== 'y'));
    return (Array.isArray(feats) ? feats : []).filter(featName => {
        const featTokens = normalizeArtistKey(featName).split(' ').filter(token => token && token !== 'y');
        if (featTokens.length === 0) return false;
        return !featTokens.every(token => mainTokens.has(token));
    });
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
    const canSplitSlash = artist.includes('/') && !/^AC\/DC$/i.test(artist.trim());
    const multiArtistPattern = canSplitSlash
        ? /\s*(?:\/|\\|&|\||,|;|\s+x\s+|\s+vs\.?\s+|\s+y\s+)\s*/i
        : /\s*(?:\\|&|\||,|;|\s+x\s+|\s+vs\.?\s+|\s+y\s+)\s*/i;
    if (!isProtectedArtistGroup(artist)) {
        const artistParts = artist.split(multiArtistPattern).map(s => s.trim()).filter(Boolean);
        if (artistParts.length > 1) {
            artist = artistParts[0];
            feats.push(...artistParts.slice(1));
        }
    }
    feats = [...new Set(feats.filter(f => f.length > 0))];
    title = title.replace(/\(\s*\)|\[\s*\]/g, '').replace(/-\s*$/, '').trim();
    return { artist, title, feats, isRemix };
}

function parseLeadingArtistCandidate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const split = text.split(/\s+-\s+/);
    if (split.length < 2) return null;
    return parseTitleAndArtist(split[0], split.slice(1).join(' - '));
}

function inferArtistDataFromRow(row) {
    if (!row) return { artist: '', feats: [] };
    const directArtist = toDisplayArtist(row.custom_artist);
    const feats = parseFeatList(row.feat);
    if (directArtist) {
        const parsed = parseTitleAndArtist(directArtist, row.custom_title || '');
        const directKey = normalizeArtistKey(parsed.artist || directArtist);
        const titleCandidate = parseLeadingArtistCandidate(row.custom_title);
        const fileCandidate = parseLeadingArtistCandidate(path.basename(row.file_path || '', path.extname(row.file_path || '')));
        const protectedRecovery = [titleCandidate, fileCandidate].find(candidate => {
            const candidateArtist = candidate?.artist || '';
            if (!candidateArtist || !isProtectedArtistGroup(candidateArtist)) return false;
            const candidateKey = normalizeArtistKey(candidateArtist);
            return candidateKey === directKey || candidateKey.startsWith(`${directKey} `) || candidateKey.includes(` ${directKey} `);
        });
        if (protectedRecovery?.artist) {
            const recoveryFeats = [...new Set([...feats, ...(parsed.feats || []), ...(protectedRecovery.feats || [])])];
            return { artist: protectedRecovery.artist, feats: filterInternalGroupFeats(protectedRecovery.artist, recoveryFeats) };
        }
        const finalArtist = parsed.artist || directArtist;
        return { artist: finalArtist, feats: filterInternalGroupFeats(finalArtist, [...new Set([...feats, ...parsed.feats])]) };
    }

    const baseName = path.basename(row.file_path || '', path.extname(row.file_path || ''));
    const parsed = parseLeadingArtistCandidate(baseName);
    if (parsed) {
        return { artist: parsed.artist || '', feats: filterInternalGroupFeats(parsed.artist, [...new Set([...feats, ...parsed.feats])]) };
    }
    return { artist: '', feats };
}

function upsertArtistProfile(displayName) {
    const finalName = toDisplayArtist(displayName);
    const artistKey = normalizeArtistKey(finalName);
    if (!artistKey) return null;
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO artist_profiles (artist_key, display_name, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(artist_key) DO UPDATE SET
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
    `).run(artistKey, finalName, now);
    db.prepare(`
        INSERT INTO artist_aliases (alias_key, artist_key, display_name, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(alias_key) DO UPDATE SET
            artist_key = excluded.artist_key,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
    `).run(artistKey, artistKey, finalName, now);
    return { key: artistKey, displayName: finalName };
}

function syncTrackArtistLinks(filePath, artistName, featValue = []) {
    if (!filePath) return { linkedArtists: 0 };
    const mainArtist = upsertArtistProfile(artistName);
    const feats = filterInternalGroupFeats(artistName, parseFeatList(featValue));
    const deleteLinks = db.prepare("DELETE FROM track_artist_links WHERE file_path = ?");
    const insertLink = db.prepare(`
        INSERT OR REPLACE INTO track_artist_links (file_path, artist_key, role, display_name, position)
        VALUES (?, ?, ?, ?, ?)
    `);
    let linkedArtists = 0;
    deleteLinks.run(filePath);
    if (mainArtist) {
        insertLink.run(filePath, mainArtist.key, 'main', mainArtist.displayName, 0);
        linkedArtists++;
    }
    feats.forEach((featName, index) => {
        const featArtist = upsertArtistProfile(featName);
        if (!featArtist) return;
        insertLink.run(filePath, featArtist.key, 'feat', featArtist.displayName, index + 1);
        linkedArtists++;
    });
    return { linkedArtists };
}

function syncTrackArtistLinksFromRow(row) {
    const inferred = inferArtistDataFromRow(row);
    return syncTrackArtistLinks(row?.file_path, inferred.artist, inferred.feats);
}

function rebuildArtistProfilesForPaths(paths = null) {
    const rows = Array.isArray(paths) && paths.length > 0
        ? paths.map(filePath => db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath)).filter(Boolean)
        : db.prepare("SELECT * FROM tracks").all();
    let linkedTracks = 0;
    let linkedArtists = 0;
    db.transaction(() => {
        rows.forEach(row => {
            const result = syncTrackArtistLinksFromRow(row);
            if (result.linkedArtists > 0) linkedTracks++;
            linkedArtists += result.linkedArtists;
        });
    })();
    return { linkedTracks, linkedArtists };
}

function getArtistCardByKey(artistKey) {
    if (!artistKey) return null;
    const profile = db.prepare(`
        SELECT
            ap.artist_key AS artistKey,
            ap.display_name AS displayName,
            ap.habitual_genre AS habitualGenre,
            gp.display_name AS habitualGenreName,
            ap.habitual_genres_json AS habitualGenresJson,
            ap.country,
            ap.country_code AS countryCode,
            ap.energy_hint AS energyHint,
            ap.notes,
            COUNT(tal.file_path) AS trackCount
        FROM artist_profiles ap
        LEFT JOIN genre_profiles gp ON gp.genre_key = ap.habitual_genre
        LEFT JOIN track_artist_links tal ON tal.artist_key = ap.artist_key
        WHERE ap.artist_key = ?
        GROUP BY ap.artist_key
    `).get(artistKey);
    if (!profile) return null;
    const linkedGenres = db.prepare(`
        SELECT COALESCE(gp.display_name, t.genre) AS name, COUNT(*) AS count
        FROM track_artist_links tal
        JOIN tracks t ON t.file_path = tal.file_path
        LEFT JOIN genre_profiles gp ON gp.genre_key = t.primary_genre
        WHERE tal.artist_key = ? AND tal.role = 'main' AND COALESCE(t.genre, t.primary_genre, '') <> ''
        GROUP BY COALESCE(gp.display_name, t.genre)
        ORDER BY count DESC, name COLLATE NOCASE
        LIMIT 8
    `).all(artistKey);
    return { ...profile, linkedGenres };
}

function getArtistTracksByKey(artistKey) {
    if (!artistKey) return [];
    return db.prepare(`
        SELECT
            t.file_path AS filePath,
            COALESCE(NULLIF(t.custom_title, ''), '') AS customTitle,
            COALESCE(NULLIF(t.custom_artist, ''), '') AS customArtist,
            t.genre,
            t.primary_genre AS primaryGenre,
            t.subgenre,
            t.duration,
            t.file_size AS fileSize,
            t.file_mtime_ms AS fileMtimeMs,
            tal.role,
            tal.position
        FROM track_artist_links tal
        JOIN tracks t ON t.file_path = tal.file_path
        WHERE tal.artist_key = ?
        ORDER BY tal.role = 'main' DESC, COALESCE(NULLIF(t.custom_title, ''), t.file_path) COLLATE NOCASE
    `).all(artistKey).map(row => ({
        ...row,
        title: row.customTitle || path.basename(row.filePath || '', path.extname(row.filePath || '')),
        artist: row.customArtist || '',
        genre: row.genre || '',
        subgenre: row.subgenre || ''
    }));
}

function getArtistCardForTrackPath(filePath) {
    if (!filePath) return null;
    let row = db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath);
    if (!row) {
        db.prepare("INSERT OR IGNORE INTO tracks (file_path) VALUES (?)").run(filePath);
        row = db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath) || { file_path: filePath };
    }
    syncTrackArtistLinksFromRow(row);
    const mainLink = db.prepare(`
        SELECT artist_key AS artistKey
        FROM track_artist_links
        WHERE file_path = ? AND role = 'main'
        ORDER BY position
        LIMIT 1
    `).get(filePath);
    return getArtistCardByKey(mainLink?.artistKey);
}

function getArtistCardDetailsForTrackPath(filePath) {
    const card = getArtistCardForTrackPath(filePath);
    if (!card) return null;
    const linkedPaths = new Set(getArtistTracksByKey(card.artistKey).map(track => track.filePath));
    const missingRows = db.prepare(`
        SELECT *
        FROM tracks
        WHERE COALESCE(custom_artist, '') <> ''
           OR COALESCE(custom_title, '') LIKE '% - %'
           OR file_path LIKE '% - %'
    `).all().filter(row => {
        if (!row?.file_path || linkedPaths.has(row.file_path)) return false;
        const inferred = inferArtistDataFromRow(row);
        return normalizeArtistKey(inferred.artist) === card.artistKey;
    });
    missingRows.forEach(row => syncTrackArtistLinksFromRow(row));
    return {
        card,
        tracks: getArtistTracksByKey(card.artistKey)
    };
}

async function runTask(action, payload) {
    if (action === 'clockwheel-build-plan') return { success: true, plan: buildClockwheelPlan(payload || {}) };
    if (action === 'lib-rebuild-artist-profiles') {
        const safePaths = Array.isArray(payload) ? payload.filter(Boolean) : null;
        return { success: true, ...rebuildArtistProfilesForPaths(safePaths) };
    }
    if (action === 'lib-get-artist-card-for-track') {
        const details = getArtistCardDetailsForTrackPath(payload);
        if (!details?.card) return { success: false, error: 'No pude detectar un artista principal para esta pista.' };
        return { success: true, ...details };
    }
    return { success: false, error: `Accion de worker no soportada: ${action}` };
}

parentPort.on('message', async (message) => {
    try {
        const result = await runTask(message.action, message.payload);
        parentPort.postMessage({ id: message.id, result });
    } catch (err) {
        parentPort.postMessage({ id: message.id, result: { success: false, error: err.message } });
    }
});
