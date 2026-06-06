'use strict';

// ============================================================================
// Núcleo del Generador de Playlist (lógica pura, sin DOM).
//
// Extraído de render.js para (a) que el renderer no siga creciendo y (b) poder
// reutilizar la MISMA lógica desde un worker de Node más adelante (el trabajo
// pesado debe salir del hilo de UI).
//
// No accede a variables globales: recibe los datos dinámicos por GETTERS y los
// helpers por inyección, vía `createPlaylistGeneratorCore(ctx)`. Así el mismo
// módulo sirve en el renderer (le pasa sus globals) y en un worker (le pasa lo
// que lea de la base de datos).
// ============================================================================

const path = require('path');

function normalizeRotationText(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

const AUDIO_EXT_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

function createPlaylistGeneratorCore(ctx = {}) {
    const getManualCuesDB = ctx.getManualCuesDB || (() => ({}));
    const getFileTypesData = ctx.getFileTypesData || (() => []);
    const getGenreProfiles = ctx.getGenreProfiles || (() => []);
    const getTrackTypeData = ctx.getTrackTypeData || (() => null);
    const shuffleArray = ctx.shuffleArray || (arr => arr.slice());
    const ICON_CLOCK_LABEL = ctx.ICON_CLOCK_LABEL || '';
    // Escáner de carpetas inyectado: (folderPath, recursive) => Promise<string[] rutas absolutas>.
    // El renderer lo provee con el escáner async existente; un worker pasaría el suyo.
    const listFolderFiles = ctx.listFolderFiles || (async () => []);
    const ICON_TEMP_LABEL = ctx.ICON_TEMP_LABEL || 'Locución de temperatura';
    const ICON_HUM_LABEL = ctx.ICON_HUM_LABEL || 'Locución de humedad';

    function getRotationGenreCategoryDefs() {
        const categories = [];
        const seen = new Set();
        const addGenre = (genreKey, displayName, parentGenre = '') => {
            const parentKey = normalizeRotationText(parentGenre);
            const baseKey = normalizeRotationText(genreKey || displayName);
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

        (getGenreProfiles() || []).forEach(profile => {
            // Only show genres that have at least one track
            if (profile.trackCount > 0) {
                addGenre(profile.genreKey, profile.displayName || profile.genreKey, profile.parentGenre || '');
            }
        });

        return categories.sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name), 'es', { sensitivity: 'base' }));
    }

    function getRotationCategoryDefs() {
        return [
            { id: 'default', name: 'Musica', color: '#e0e0e0', source: 'type' },
            ...getFileTypesData().map(t => ({ id: t.id, name: t.name, color: t.color || '#e0e0e0', identifier: t.identifier || '', source: 'type' })),
            ...getRotationGenreCategoryDefs()
        ];
    }

    function resolveRotationCategory(token, categoryDefs = null) {
        const clean = normalizeRotationText(String(token || '').replace(/^@/, ''));
        if (!clean || ['musica', 'default', 'general', 'normal'].includes(clean)) return { id: 'default', name: 'Musica', color: '#e0e0e0' };
        const defs = categoryDefs || getRotationCategoryDefs();
        // Locuciones de hora: el patron puede escribirse "Locucion horaria", "Hora",
        // "Locuciones"... Mapear por palabra clave a la MISMA categoria que recibe el
        // candidato time_locution (misma deteccion que getRotationCandidates), para que
        // el paso no se descarte silenciosamente y rompa el ciclo del patron.
        if (/locuci|hora|saytime/.test(clean)) {
            const timeCat = defs.find(cat => /locuci|hora|time|saytime/i.test(`${cat.name} ${cat.identifier || ''}`));
            if (timeCat) return timeCat;
        }
        return defs.find(cat => {
            return normalizeRotationText(cat.id) === clean || normalizeRotationText(cat.name) === clean || normalizeRotationText(cat.identifier) === clean || normalizeRotationText(cat.genreKey) === clean || (Array.isArray(cat.aliases) && cat.aliases.some(alias => normalizeRotationText(alias) === clean));
        }) || null;
    }

    function getDefaultRotationPattern() {
        const stationId = getFileTypesData().find(t => /station|id|pisador|jingle/i.test(`${t.name} ${t.identifier}`));
        return ['Musica', stationId ? stationId.name : null, 'Musica', 'Musica'].filter(Boolean).join('\n');
    }

    // Token de carpeta en el patrón: "@folder:C:\ruta" (incluye subcarpetas) o
    // "@folderflat:C:\ruta" (solo la raíz). La ruta NO se normaliza (se respeta tal cual).
    function parseFolderToken(rawToken) {
        const m = String(rawToken || '').trim().match(/^@folder(flat)?:(.+)$/i);
        if (!m) return null;
        const folderPath = m[2].trim();
        if (!folderPath) return null;
        const baseName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
        return {
            id: 'folder:' + folderPath.toLowerCase(),
            name: '[Carpeta] ' + baseName,
            source: 'folder',
            folderPath,
            recursive: !m[1]
        };
    }

    function getRotationPatternCategories(patternText, categoryDefs = null) {
        const defs = categoryDefs || getRotationCategoryDefs();
        const rawTokens = String(patternText || '').split(/[\n,>]+/).map(t => t.trim()).filter(Boolean);
        const tokens = rawTokens.length ? rawTokens : getDefaultRotationPattern().split(/\n/);
        return tokens.map(token => {
            const folderCat = parseFolderToken(token);
            if (folderCat) return { token, category: folderCat };
            const locCat = parseLocutionToken(token);
            if (locCat) return { token, category: locCat };
            return { token, category: resolveRotationCategory(token, defs) };
        }).filter(item => item.category);
    }

    // Token de locución: @loc:time | @loc:temperature | @loc:humidity.
    // (La duración real se resuelve al sonar, como al enlistarla manualmente.)
    function parseLocutionToken(rawToken) {
        const m = String(rawToken || '').trim().match(/^@loc:(time|temperature|humidity)$/i);
        if (!m) return null;
        const locType = m[1].toLowerCase();
        const marker = locType === 'time' ? 'time_locution' : (locType + '_locution');
        const label = locType === 'time' ? (ICON_CLOCK_LABEL || 'Locución de hora')
            : (locType === 'temperature' ? ICON_TEMP_LABEL : ICON_HUM_LABEL);
        return { id: 'loc:' + locType, name: label, source: 'locution', locType, marker, label };
    }

    function getRotationTrackTitle(filePath, data) {
        const baseName = path.basename(filePath, path.extname(filePath));
        const title = (data?.customTitle || '').trim();
        const artist = (data?.customArtist || '').trim();
        if (artist && title) return `${artist} - ${title}${path.extname(filePath)}`;
        return `${title || baseName}${path.extname(filePath)}`;
    }

    function getRotationArtistKey(filePath, data) {
        const artist = (data?.customArtist || '').trim();
        if (artist) return normalizeRotationText(artist);
        const baseName = path.basename(filePath, path.extname(filePath));
        const split = baseName.split(/\s+-\s+/);
        return normalizeRotationText(split.length > 1 ? split[0] : baseName);
    }

    function getRotationTitleKey(filePath, data) {
        const title = (data?.customTitle || '').trim();
        if (title) return normalizeRotationText(title);
        const baseName = path.basename(filePath, path.extname(filePath));
        const split = baseName.split(/\s+-\s+/);
        return normalizeRotationText(split.length > 1 ? split.slice(1).join(' - ') : baseName);
    }

    function getRotationDuration(filePath, data) {
        const start = parseFloat(data?.inicio || 0) || 0;
        const end = parseFloat(data?.fin || 0) || 0;
        if (end > start) return Math.round(end - start);
        const duration = parseFloat(data?.duration || 0) || 0;
        return duration > 0 ? Math.round(duration) : 180;
    }

    function getRotationTrackGenreCategoryIds(data) {
        const ids = new Set();
        const add = (value) => {
            const key = normalizeRotationText(value);
            if (key) ids.add(`genre:${key}`);
        };
        const addSubgenre = (subgenre, parentGenre = '') => {
            const subKey = normalizeRotationText(subgenre);
            if (!subKey) return;
            const parentKey = normalizeRotationText(parentGenre);
            if (parentKey && !subKey.includes(':')) add(`${parentKey}:${subKey}`);
            add(subKey);
        };
        add(data?.primaryGenre);
        const genreParts = String(data?.genre || '').split('/').map(part => part.trim()).filter(Boolean);
        if (data?.genre) {
            genreParts.forEach(add);
        }
        if (genreParts.length > 1) addSubgenre(genreParts.slice(1).join(' / '), data?.primaryGenre || genreParts[0] || '');
        addSubgenre(data?.subgenre, data?.primaryGenre || genreParts[0] || '');
        try {
            const parsed = JSON.parse(data?.genresJson || '[]');
            if (Array.isArray(parsed)) parsed.forEach(item => add(item.key || item.name));
        } catch (err) { }
        return Array.from(ids);
    }

    function addRotationCandidate(byCategory, catId, track) {
        if (!byCategory.has(catId)) byCategory.set(catId, []);
        byCategory.get(catId).push(track);
    }

    function isTimeLocutionTrack(track) {
        return track?.rowType === 'time' || track?.filePath === 'time_locution';
    }

    function inferRotationCategoryIdsFromPath(filePath, data, categoryDefs, typeData) {
        const ids = new Set();
        const haystack = [
            path.dirname(filePath),
            path.basename(filePath, path.extname(filePath)),
            data?.genre,
            data?.primaryGenre,
            data?.subgenre
        ].filter(Boolean).join(' ');

        const cleanHaystack = normalizeRotationText(haystack);
        if (!cleanHaystack) {
            if (!typeData || typeData.id === 'default' || typeData.id === 'general') ids.add('default');
            return Array.from(ids);
        }

        categoryDefs.forEach(category => {
            if (!category || category.id === 'default' || category.id === 'general') return;
            const candidates = [
                category.name,
                category.identifier,
                category.genreKey,
                ...(Array.isArray(category.aliases) ? category.aliases : [])
            ].filter(Boolean);
            if (candidates.some(candidate => {
                const cleanNeedle = normalizeRotationText(candidate);
                return cleanNeedle && cleanHaystack.includes(cleanNeedle);
            })) {
                ids.add(category.id);
            }
        });

        if (!typeData || typeData.id === 'default' || typeData.id === 'general') ids.add('default');
        return Array.from(ids);
    }

    function getRotationCandidates(categoryDefs = null) {
        const defs = categoryDefs || getRotationCategoryDefs();
        const byCategory = new Map();
        defs.forEach(cat => byCategory.set(cat.id, []));
        const fileTypesData = getFileTypesData();
        const timeCategory = fileTypesData.find(t => /locuci|hora|time|saytime/i.test(`${t.name} ${t.identifier}`));
        if (timeCategory) {
            addRotationCandidate(byCategory, timeCategory.id, {
                filePath: 'time_locution',
                title: ICON_CLOCK_LABEL,
                duration: 5,
                artistKey: 'locucion-hora',
                titleKey: 'locucion-hora',
                folderKey: 'time',
                rowType: 'time'
            });
        }
        Object.entries(getManualCuesDB() || {}).forEach(([filePath, data]) => {
            if (!filePath || !AUDIO_EXT_RE.test(filePath)) return;
            const typeData = getTrackTypeData(filePath);
            const catId = typeData ? typeData.id : 'default';
            const isId = typeData && /id|pisador|jingle|cuña|station|promo/i.test(`${typeData.name} ${typeData.identifier}`);
            const track = {
                filePath,
                title: getRotationTrackTitle(filePath, data),
                duration: getRotationDuration(filePath, data),
                artistKey: getRotationArtistKey(filePath, data),
                titleKey: getRotationTitleKey(filePath, data),
                folderKey: normalizeRotationText(path.dirname(filePath)),
                isIdentifier: !!isId
            };
            addRotationCandidate(byCategory, catId, track);
            getRotationTrackGenreCategoryIds(data).forEach(genreCatId => addRotationCandidate(byCategory, genreCatId, track));
            inferRotationCategoryIdsFromPath(filePath, data, defs, typeData).forEach(inferredCatId => addRotationCandidate(byCategory, inferredCatId, track));
        });
        byCategory.forEach((tracks, catId) => byCategory.set(catId, { items: shuffleArray([...tracks]), cursor: 0 }));
        return byCategory;
    }

    function isRecentlyUsed(value, recent, distance) {
        if (!value || distance <= 0) return false;
        const scope = recent.slice(-distance);
        return scope.includes(value);
    }

    // Restricción DURA contra el inmediato anterior: nunca repetir el mismo
    // archivo ni el mismo título seguidos, ni apilar dos identificaciones/jingles.
    // Solo se relaja si la categoría no tiene ninguna alternativa.
    function violatesHardConstraint(track, prevTrack) {
        if (!prevTrack) return false;
        if (track.filePath && track.filePath === prevTrack.filePath) return true;
        if (track.titleKey && prevTrack.titleKey && track.titleKey === prevTrack.titleKey) return true;
        if (track.isIdentifier && prevTrack.isIdentifier) return true;
        return false;
    }

    function pickRotationTrack(pool, recent, prefs, prevTrack = null) {
        if (!pool || !pool.items || pool.items.length === 0) return null;

        if (pool.cursor >= pool.items.length) {
            pool.items = shuffleArray([...pool.items]);
            pool.cursor = 0;
        }

        const items = pool.items;
        const take = (idx) => {
            const tmp = items[pool.cursor];
            items[pool.cursor] = items[idx];
            items[idx] = tmp;
            const picked = items[pool.cursor];
            pool.cursor++;
            return { ...picked };
        };

        // Pasadas SUAVES de separación por artista/título (ventana configurable).
        const softPasses = [
            track => {
                if (track.isIdentifier) return !isRecentlyUsed(track.filePath, recent.paths, 2);
                return !recent.paths.includes(track.filePath)
                    && (!prefs.checkArtist || !isRecentlyUsed(track.artistKey, recent.artists, prefs.sepArtist))
                    && (!prefs.checkTitle || !isRecentlyUsed(track.titleKey, recent.titles, prefs.sepTitle));
            },
            track => {
                if (track.isIdentifier) return !isRecentlyUsed(track.filePath, recent.paths, 2);
                return !recent.paths.includes(track.filePath)
                    && (!prefs.checkArtist || !isRecentlyUsed(track.artistKey, recent.artists, Math.floor(prefs.sepArtist / 2)))
                    && (!prefs.checkTitle || !isRecentlyUsed(track.titleKey, recent.titles, Math.floor(prefs.sepTitle / 2)));
            },
            track => {
                if (track.isIdentifier) return true;
                return !recent.paths.includes(track.filePath);
            },
            () => true
        ];

        // 1) Ideal: cumple la restricción dura Y alguna pasada suave.
        for (const pass of softPasses) {
            for (let i = pool.cursor; i < items.length; i++) {
                const track = items[i];
                if (violatesHardConstraint(track, prevTrack)) continue;
                if (track.isIdentifier && recent.paths.includes(track.filePath)) continue;
                if (pass(track)) return take(i);
            }
        }
        // 2) Al menos respeta la restricción dura (no consecutivo).
        for (let i = pool.cursor; i < items.length; i++) {
            if (!violatesHardConstraint(items[i], prevTrack)) return take(i);
        }
        // 3) Último recurso: la categoría no tiene alternativa al anterior.
        return take(pool.cursor);
    }

    async function buildRotationPlan(prefs) {
        prefs = prefs || {};
        const categoryDefs = getRotationCategoryDefs();
        const pattern = getRotationPatternCategories(prefs.pattern, categoryDefs);

        if (!pattern || pattern.length === 0) {
            throw new Error('El patron esta vacio o es invalido.');
        }

        const byCategory = getRotationCandidates(categoryDefs);

        // Carpetas del patrón: escanear (async, no bloquea) y construir su pozo.
        // Para archivos fuera de la biblioteca la duración real se resuelve al
        // sonar (estimación 180 s, igual que las filas de carpeta aleatoria).
        const folderCats = [...new Map(
            pattern.filter(p => p.category.source === 'folder').map(p => [p.category.id, p.category])
        ).values()];
        for (const fc of folderCats) {
            let files = [];
            try { files = await listFolderFiles(fc.folderPath, fc.recursive !== false); } catch (e) { files = []; }
            const tracks = (files || []).filter(fp => AUDIO_EXT_RE.test(fp)).map(fp => {
                const data = getManualCuesDB()[fp] || {};
                return {
                    filePath: fp,
                    title: getRotationTrackTitle(fp, data),
                    duration: getRotationDuration(fp, data),
                    artistKey: getRotationArtistKey(fp, data),
                    titleKey: getRotationTitleKey(fp, data),
                    folderKey: normalizeRotationText(path.dirname(fp)),
                    isIdentifier: false
                };
            });
            byCategory.set(fc.id, { items: shuffleArray([...tracks]), cursor: 0 });
        }

        // Locuciones del patrón: cada una es un único candidato (rowType time/
        // temperature/humidity). El archivo real se resuelve al sonar.
        const locCats = [...new Map(
            pattern.filter(p => p.category.source === 'locution').map(p => [p.category.id, p.category])
        ).values()];
        for (const lc of locCats) {
            byCategory.set(lc.id, { items: [{
                filePath: lc.marker,
                title: lc.label || lc.name,
                duration: 5,
                artistKey: 'locucion-' + lc.locType,
                titleKey: 'locucion-' + lc.locType,
                folderKey: lc.locType,
                rowType: lc.locType
            }], cursor: 0 });
        }
        const emptyCategories = pattern.filter(p => !byCategory.has(p.category.id) || byCategory.get(p.category.id).length === 0);

        if (emptyCategories.length > 0) {
            const names = [...new Set(emptyCategories.map(p => p.category.name))];
            throw new Error(`Faltan canciones: Las categorias [${names.join(', ')}] no tienen ninguna pista asignada en la biblioteca.`);
        }

        const recent = { paths: [], artists: [], titles: [], folders: [] };
        let prevTrack = null;
        const tracks = [];
        const missing = new Map();
        const targetSeconds = prefs.targetMinutes * 60;
        let totalSeconds = 0;
        let cursor = 0;
        let attempts = 0;

        // Yield so the "Calculando..." UI update can paint (inocuo en worker).
        await new Promise(resolve => setTimeout(resolve, 10));

        while (totalSeconds < targetSeconds && pattern.length > 0 && attempts < 1200) {
            attempts++;
            const item = pattern[cursor % pattern.length];
            cursor++;
            const pool = byCategory.get(item.category.id) || [];
            const track = pickRotationTrack(pool, recent, prefs, prevTrack);

            if (!track) {
                missing.set(item.category.name, (missing.get(item.category.name) || 0) + 1);
                if (Array.from(byCategory.values()).every(list => list.every(isTimeLocutionTrack))) break;
                continue;
            }

            tracks.push({ ...track, category: item.category, rowType: track.rowType || 'normal' });
            totalSeconds += track.duration;
            recent.paths.push(track.filePath);
            recent.artists.push(track.artistKey);
            recent.titles.push(track.titleKey);
            recent.folders.push(track.folderKey);
            prevTrack = track;

            const maxMemory = Math.max(60, (prefs.sepArtist || 0) * 2, (prefs.sepTitle || 0) * 2);
            if (recent.paths.length > maxMemory) recent.paths.shift();
            if (recent.artists.length > maxMemory) recent.artists.shift();
            if (recent.titles.length > maxMemory) recent.titles.shift();
            if (recent.folders.length > maxMemory) recent.folders.shift();
        }

        return {
            tracks,
            totalSeconds,
            missing: Object.fromEntries(missing)
        };
    }

    function formatRotationDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    }

    return {
        getRotationCategoryDefs,
        getDefaultRotationPattern,
        getRotationPatternCategories,
        resolveRotationCategory,
        getRotationCandidates,
        pickRotationTrack,
        isTimeLocutionTrack,
        buildRotationPlan,
        formatRotationDuration
    };
}

module.exports = { createPlaylistGeneratorCore, normalizeRotationText };
