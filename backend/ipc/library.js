module.exports = function(context) {
    const {
        app, cp, readLibraryDirInWorker, mapTrackRowToClient, buildWaveformPeaksInWorker,
        selectTrackByPathStmt, saveDbTrackStmt, parseFeatList, normalizeTrackArtistFields,
        isProtectedArtistGroup, getTrackFileSignature, syncTrackArtistLinks, applyGenreToTrackPaths,
        buildRootGenrePreview, upsertVirtualFolder, collectAudioFilesRecursive, writeGenreTagsToFiles,
        inferGenreFromFolderName, AUDIO_FILE_RE, getCountryProfiles, runLibraryWorkerTask,
        getArtistCatalogData, deleteArtistProfiles, mergeArtistProfiles, setArtistMainGenreFromCatalog,
        autofillArtistProfilesFromCatalog, getArtistCardDetailsForTrackPath, normalizeArtistKey,
        getArtistCardByKey, ensureArtistProfileForLink, getArtistTracksByKey, fetchArtistMetadataOnline,
        downloadArtistImage, saveArtistCard, cleanCsvList, mergeCsvList, toDisplayArtist,
        openArtistCatalogWindow, openGenreEditorWindow, getGenreEditorCatalog, getGenreEditorTracks,
        browseGenreEditorPath, suggestGenreForInputPaths, syncGenreLinksForExistingTracks,
        broadcastGenreProfilesUpdated, saveGenreProfileForEditor, mergeGenreProfilesForEditor,
        setGenreProfileTypeForEditor, reclassifyGenreForEditor, collectAudioFilesFromInputPaths, normalizeGenreKey,
        ipcMain, db,   writeLog, fs, path, BrowserWindow, dialog
    } = context;

    // Dynamic properties that might be reassigned
    

ipcMain.handle('get-default-paths', () => {
    const isLinux = process.platform === 'linux';
    const result = {
        downloads: app.getPath('downloads'),
        music: app.getPath('music')
    };
    // En Linux excluimos Escritorio — no se usa para guardar archivos de audio
    if (!isLinux) {
        result.desktop = app.getPath('desktop');
    }
    // En Linux agregamos Home como raíz de navegación
    if (isLinux) {
        result.home = app.getPath('home');
    }
    return result;
});
ipcMain.handle('get-system-drives', async () => {
    if (process.platform === 'win32') {
        return new Promise((resolve) => {
            cp.exec('wmic logicaldisk get name', (err, stdout) => {
                if (err) resolve(['C:\\']);
                else resolve(stdout.split('\r\n').filter(line => /[A-Z]:/.test(line)).map(line => line.trim() + '\\'));
            });
        });
    }
    // Linux: devolver puntos de montaje reales (USB, discos externos)
    const mounts = [];
    try {
        const os = require('os');
        const mediaUser = path.join('/media', os.userInfo().username);
        if (fs.existsSync(mediaUser)) {
            fs.readdirSync(mediaUser).forEach(entry => {
                const mountPath = path.join(mediaUser, entry);
                try {
                    if (fs.statSync(mountPath).isDirectory()) {
                        mounts.push(mountPath);
                    }
                } catch (e) {}
            });
        }
    } catch (e) {}
    // También revisar /mnt/ por si hay montajes manuales
    try {
        if (fs.existsSync('/mnt')) {
            fs.readdirSync('/mnt').forEach(entry => {
                const mountPath = path.join('/mnt', entry);
                try {
                    if (fs.statSync(mountPath).isDirectory()) {
                        mounts.push(mountPath);
                    }
                } catch (e) {}
            });
        }
    } catch (e) {}
    return mounts;
});
ipcMain.handle('lib-read-dir', async (e, dirPath, recursive = false) => readLibraryDirInWorker(dirPath, recursive === true));

ipcMain.handle('lib-get-full-db', (e, options = {}) => {
    if(!db) return {};
    try {
        // Carga masiva: usar deferSignature para NO llamar fs.statSync() por cada pista.
        // Los valores de firma se leen de la BD. La verificación individual se hace bajo demanda.
        const deferSignature = options?.deferSignatures !== false;
        const countryRows = db.prepare(`
            SELECT tal.file_path AS filePath, ap.country, ap.country_code AS countryCode
            FROM track_artist_links tal
            JOIN artist_profiles ap ON ap.artist_key = tal.artist_key
            WHERE tal.role = 'main'
        `).all();
        const artistCountryLookup = new Map(countryRows.map(row => [row.filePath, row]));
        const rows = db.prepare("SELECT * FROM tracks").all(); const cuesDB = {};
        rows.forEach(r => { cuesDB[r.file_path] = mapTrackRowToClient(r, artistCountryLookup, { deferSignature }); });
        return cuesDB;
    } catch(err) { writeLog("Error get-full-db: " + err); return {}; }
});

ipcMain.handle('lib-get-db-tracks', (e, paths, options = {}) => {
    if (!db) return {};
    try {
        const safePaths = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
        if (safePaths.length === 0) return {};
        // Carga por lotes: diferir verificación de firma al disco
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
    } catch (err) {
        writeLog("Error get-db-tracks: " + err);
        return {};
    }
});

ipcMain.handle('lib-get-db-track', (e, filePath) => {
    if(!db) return null;
    try {
        const r = db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath); if (!r) return null;
        return mapTrackRowToClient(r);
    } catch(err) { return null; }
});

ipcMain.handle('audio-build-waveform-peaks', async (e, filePath) => {
    if (!filePath) return { success: false, error: 'Archivo invalido' };
    return await buildWaveformPeaksInWorker(filePath);
});

ipcMain.handle('lib-save-db-track', (e, trackData) => {
    if(!db) return { success: false, error: "BD no conectada" };
    try {
        const parseNum = (val) => (val !== '' && val !== null && val !== undefined && !isNaN(val)) ? parseFloat(val) : null;
        const keepExistingIfBlank = (incoming, existing) => {
            const value = String(incoming ?? '').trim();
            return value ? value : (existing ?? null);
        };
        const hasFeatData = (value) => {
            const feats = parseFeatList(value);
            return feats.length > 0;
        };
        const existingTrack = selectTrackByPathStmt.get(trackData.filePath) || {};
        const finalMeta = {
            customTitle: keepExistingIfBlank(trackData.customTitle, existingTrack.custom_title),
            customArtist: keepExistingIfBlank(trackData.customArtist, existingTrack.custom_artist),
            feat: hasFeatData(trackData.feat) ? trackData.feat : (existingTrack.feat ?? null),
            is_remix: trackData.is_remix ? 1 : (existingTrack.is_remix === 1 ? 1 : 0),
            album: keepExistingIfBlank(trackData.album, existingTrack.album),
            year: keepExistingIfBlank(trackData.year, existingTrack.year),
            genre: keepExistingIfBlank(trackData.genre, existingTrack.genre)
        };
        const normalizedArtists = normalizeTrackArtistFields(finalMeta.customArtist, finalMeta.customTitle, finalMeta.feat);
        if (normalizedArtists.artist) finalMeta.customArtist = normalizedArtists.artist;
        if (normalizedArtists.feats.length > 0) finalMeta.feat = JSON.stringify(normalizedArtists.feats);
        else if (isProtectedArtistGroup(finalMeta.customArtist)) finalMeta.feat = null;
        const signature = getTrackFileSignature(trackData.filePath);
        saveDbTrackStmt.run({
            filePath: trackData.filePath, customTitle: finalMeta.customTitle, customArtist: finalMeta.customArtist, feat: finalMeta.feat, is_remix: finalMeta.is_remix, album: finalMeta.album, year: finalMeta.year, genre: finalMeta.genre, inicio: parseNum(trackData.inicio), intro: parseNum(trackData.intro), mix: parseNum(trackData.mix), outro: parseNum(trackData.outro), fin: parseNum(trackData.fin), p1_active: trackData.p1_active ? 1 : 0, p1_mode: trackData.p1_mode || 'start', p1_time: trackData.p1_time || null, p1_file: trackData.p1_file || null, p1_options: trackData.p1_options || null, p2_active: trackData.p2_active ? 1 : 0, p2_mode: trackData.p2_mode || 'start', p2_time: trackData.p2_time || null, p2_file: trackData.p2_file || null, p2_options: trackData.p2_options || null, p3_active: trackData.p3_active ? 1 : 0, p3_mode: trackData.p3_mode || 'start', p3_time: trackData.p3_time || null, p3_file: trackData.p3_file || null, p3_options: trackData.p3_options || null, p4_active: trackData.p4_active ? 1 : 0, p4_mode: trackData.p4_mode || 'start', p4_time: trackData.p4_time || null, p4_file: trackData.p4_file || null, p4_options: trackData.p4_options || null, phora_active: trackData.phora_active ? 1 : 0, phora_mode: trackData.phora_mode || 'start', phora_time: trackData.phora_time || null, fileSize: signature?.fileSize ?? null, fileMtimeMs: signature?.fileMtimeMs ?? null
        });
        if (finalMeta.customArtist) {
            syncTrackArtistLinks(trackData.filePath, finalMeta.customArtist, finalMeta.feat || [], { country: trackData.artistCountry || '' });
        }
        const incomingGenre = String(trackData.genre || '').trim();
        if (incomingGenre) {
            const genreParts = incomingGenre.split('/').map(part => part.trim()).filter(Boolean);
            applyGenreToTrackPaths([trackData.filePath], genreParts[0], genreParts.slice(1).join(' / '), 'manual', '');
        }
        return { success: true };
    } catch(err) { writeLog("Error guardando pista: " + err); return { success: false, error: err.message }; }
});

ipcMain.on('lib-delete-db-tracks', (e, paths) => { try { const delStmt = db.prepare("DELETE FROM tracks WHERE file_path = ?"); const delArtistLinks = db.prepare("DELETE FROM track_artist_links WHERE file_path = ?"); const delGenreLinks = db.prepare("DELETE FROM track_genre_links WHERE file_path = ?"); db.transaction((pths) => { for (let p of pths || []) { delArtistLinks.run(p); delGenreLinks.run(p); delStmt.run(p); } })(paths); if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues'); } catch(err) {} });
ipcMain.on('lib-clear-cues', (e, paths) => { try { const stmt = db.prepare("UPDATE tracks SET inicio = NULL, mix = NULL, fin = NULL WHERE file_path = ?"); db.transaction((pths) => { for (let p of pths) stmt.run(p); })(paths || []); if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues'); } catch(err) {} });
ipcMain.on('lib-clear-meta', (e, paths) => { try { const stmt = db.prepare("UPDATE tracks SET custom_title = NULL, custom_artist = NULL, feat = NULL, is_remix = 0, album = NULL, year = NULL, genre = NULL, primary_genre = NULL, subgenre = NULL, genres_json = NULL, genre_source = NULL, genre_confidence = NULL, folder_genre_path = NULL WHERE file_path = ?"); const delGenreLinks = db.prepare("DELETE FROM track_genre_links WHERE file_path = ?"); const delArtistLinks = db.prepare("DELETE FROM track_artist_links WHERE file_path = ?"); db.transaction((pths) => { for (let p of pths || []) { stmt.run(p); delGenreLinks.run(p); delArtistLinks.run(p); } })(paths || []); if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues'); } catch(err) {} });

ipcMain.handle('lib-preview-root-genres', (e, rootPath) => {
    try {
        return { success: true, items: buildRootGenrePreview(rootPath) };
    } catch (err) {
        writeLog("Error preview-root-genres: " + err.message);
        return { success: false, error: err.message, items: [] };
    }
});

ipcMain.handle('lib-apply-folder-genres', (e, payload) => {
    try {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        let updatedTracks = 0;
        let savedFolders = 0;
        const details = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i] || {};
            const folderPath = item.path && fs.existsSync(item.path) ? item.path : '';
            if (!folderPath || !fs.statSync(folderPath).isDirectory()) continue;
            const genre = String(item.genre || '').trim();
            const subgenre = String(item.subgenre || '').trim();
            if (!genre) continue;
            const normalizedItem = { ...item, genre, subgenre, sortOrder: i };
            upsertVirtualFolder(normalizedItem);
            savedFolders++;
            let files = [];
            if (payload?.applyToTracks !== false) files = collectAudioFilesRecursive(folderPath);
            const result = applyGenreToTrackPaths(files, genre, subgenre, 'folder', folderPath);
            updatedTracks += result.updatedTracks;
            details.push({ path: folderPath, genre: result.genre, subgenre: result.subgenre, tracks: result.updatedTracks });
        }
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, updatedTracks, savedFolders, details };
    } catch (err) {
        writeLog("Error apply-folder-genres: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-set-track-genre', async (e, payload) => {
    try {
        const paths = Array.isArray(payload?.paths) ? payload.paths.filter(Boolean) : [];
        const genre = String(payload?.genre || '').trim();
        const subgenre = String(payload?.subgenre || '').trim();
        if (!paths.length || !genre) return { success: false, error: 'Datos incompletos' };
        const result = applyGenreToTrackPaths(paths, genre, subgenre, 'manual', '');
        const tagResult = payload?.writeTags ? await writeGenreTagsToFiles(paths, result.genre) : { tagUpdated: 0, tagFailed: 0 };
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, ...result, ...tagResult };
    } catch (err) {
        writeLog("Error set-track-genre: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-sync-folder-genre', (e, paths) => {
    try {
        const groups = new Map();
        for (const filePath of Array.isArray(paths) ? paths : []) {
            if (!filePath || !AUDIO_FILE_RE.test(filePath)) continue;
            const directFolder = path.dirname(filePath);
            const folderName = path.basename(directFolder);
            const parentSuggestion = inferGenreFromFolderName(path.basename(path.dirname(directFolder)));
            const suggestion = inferGenreFromFolderName(folderName, parentSuggestion);
            if (!suggestion.genre) continue;
            const key = `${suggestion.genre}\n${suggestion.subgenre || ''}\n${directFolder}`;
            if (!groups.has(key)) groups.set(key, { genre: suggestion.genre, subgenre: suggestion.subgenre || '', folderPath: directFolder, paths: [] });
            groups.get(key).paths.push(filePath);
        }
        let updatedTracks = 0;
        for (const group of groups.values()) {
            const result = applyGenreToTrackPaths(group.paths, group.genre, group.subgenre, 'folder', group.folderPath);
            updatedTracks += result.updatedTracks;
        }
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, updatedTracks };
    } catch (err) {
        writeLog("Error sync-folder-genre: " + err.message);
        return { success: false, error: err.message };
    }
});

function getAllGenreProfilesForUi() {
    const profiles = new Map();
    const trackCounts = new Map();

    const normalizeProfileKey = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (raw.includes(':')) return raw.split(':').map(part => normalizeGenreKey(part)).filter(Boolean).join(':');
        return normalizeGenreKey(raw);
    };
    
    const resolveKey = (genreKey, parentGenre) => {
        const parentKey = normalizeProfileKey(parentGenre);
        const baseKey = normalizeProfileKey(genreKey);
        return parentKey && baseKey && !baseKey.includes(':') ? `${parentKey}:${baseKey}` : baseKey;
    };

    const addProfile = (genreKey, displayName, parentGenre = '', extra = {}) => {
        const key = resolveKey(genreKey, parentGenre);
        if (!key) return;
        const cleanName = String(displayName || genreKey || '').trim();
        const parentName = String(parentGenre || '').trim();
        const current = profiles.get(key) || {};
        profiles.set(key, {
            ...current,
            ...extra,
            genreKey: key,
            displayName: cleanName || current.displayName || key,
            parentGenre: normalizeProfileKey(parentGenre) || current.parentGenre || '',
            sortName: parentName && cleanName ? `${parentName} / ${cleanName}` : (cleanName || current.sortName || key)
        });
    };

    const registerTrack = (genreKey, parentGenre, filePath) => {
        if (!filePath) return;
        const key = resolveKey(genreKey, parentGenre);
        if (key) {
            if (!trackCounts.has(key)) trackCounts.set(key, new Set());
            trackCounts.get(key).add(filePath);
        }
    };

    db.prepare(`
        SELECT genre_key AS genreKey, display_name AS displayName, parent_genre AS parentGenre,
               energy_level AS energyLevel, compatible_genres AS compatibleGenres, bridge_genres AS bridgeGenres,
               tipo
        FROM genre_profiles
        WHERE COALESCE(is_active, 1) = 1
    `).all().forEach(profile => {
        addProfile(profile.genreKey, profile.displayName || profile.genreKey, profile.parentGenre || '', profile);
    });

    db.prepare(`
        SELECT file_path AS filePath, genre, primary_genre AS primaryGenre, subgenre, genres_json AS genresJson
        FROM tracks
        WHERE COALESCE(genre, '') <> ''
           OR COALESCE(primary_genre, '') <> ''
           OR COALESCE(subgenre, '') <> ''
           OR COALESCE(genres_json, '') <> ''
    `).all().forEach(row => {
        const genreParts = String(row.genre || '').split('/').map(part => part.trim()).filter(Boolean);
        const primaryName = row.primaryGenre || genreParts[0] || '';
        if (primaryName) {
            registerTrack(primaryName, '', row.filePath);
        }
        if (row.subgenre) {
            registerTrack(row.subgenre, primaryName, row.filePath);
        }
        if (genreParts.length > 1) {
            registerTrack(genreParts.slice(1).join(' / '), primaryName, row.filePath);
        }
        try {
            const parsed = JSON.parse(row.genresJson || '[]');
            if (Array.isArray(parsed)) parsed.forEach(item => {
                registerTrack(item.key, item.parent || '', row.filePath);
            });
        } catch (err) {}
    });

    db.prepare(`
        SELECT tgl.genre_key AS genreKey, tgl.role, tgl.file_path AS filePath, gp.display_name AS displayName, gp.parent_genre AS parentGenre
        FROM track_genre_links tgl
        LEFT JOIN genre_profiles gp ON gp.genre_key = tgl.genre_key
    `).all().forEach(link => {
        registerTrack(link.genreKey, link.parentGenre || '', link.filePath);
    });

    return Array.from(profiles.values()).map(p => {
        p.trackCount = trackCounts.has(p.genreKey) ? trackCounts.get(p.genreKey).size : 0;
        return p;
    }).sort((a, b) => {
        return String(a.sortName || a.displayName || '').localeCompare(String(b.sortName || b.displayName || ''), 'es', { sensitivity: 'base' });
    });
}

ipcMain.handle('lib-get-genre-profiles', () => {
    try {
        return getAllGenreProfilesForUi();
    } catch (err) {
        return [];
    }
});

ipcMain.handle('lib-get-country-profiles', () => {
    try {
        return getCountryProfiles();
    } catch (err) {
        return [];
    }
});

ipcMain.handle('clockwheel-build-plan', async (e, payload) => {
    try {
        return await runLibraryWorkerTask('clockwheel-build-plan', payload || {});
    } catch (err) {
        writeLog("Error clockwheel-build-plan: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-rebuild-artist-profiles', async (e, paths) => {
    try {
        const safePaths = Array.isArray(paths) ? paths.filter(Boolean) : null;
        return await runLibraryWorkerTask('lib-rebuild-artist-profiles', safePaths);
    } catch (err) {
        writeLog("Error rebuild-artist-profiles: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-get-artist-profiles', () => {
    try {
        return db.prepare(`
            SELECT
                ap.artist_key AS artistKey,
                ap.display_name AS displayName,
                ap.habitual_genre AS habitualGenre,
                ap.habitual_genres_json AS habitualGenresJson,
                ap.country,
                ap.country_code AS countryCode,
                ap.energy_hint AS energyHint,
                ap.notes,
                COUNT(tal.file_path) AS trackCount
            FROM artist_profiles ap
            LEFT JOIN track_artist_links tal ON tal.artist_key = ap.artist_key
            GROUP BY ap.artist_key
            ORDER BY ap.display_name COLLATE NOCASE
        `).all();
    } catch (err) {
        return [];
    }
});

ipcMain.handle('artist-catalog-get-data', () => {
    try {
        return { success: true, ...getArtistCatalogData() };
    } catch (err) {
        writeLog("Error artist-catalog-get-data: " + err.message);
        return { success: false, error: err.message, artists: [], genres: [], status: { all: 0, curated: 0, pending: 0 } };
    }
});

ipcMain.handle('artist-catalog-delete', (e, artistKeys = []) => {
    try {
        const result = deleteArtistProfiles(artistKeys);
        if (context.artistCatalogWindow) context.artistCatalogWindow.webContents.send('artist-catalog-updated');
        return { success: true, ...result };
    } catch (err) {
        writeLog("Error artist-catalog-delete: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('artist-catalog-merge', (e, payload = {}) => {
    try {
        const result = mergeArtistProfiles(payload.targetKey, payload.sourceKeys, {
            targetDisplayName: payload.targetDisplayName
        });
        if (result.error) return { success: false, error: result.error };
        if (context.artistCatalogWindow) context.artistCatalogWindow.webContents.send('artist-catalog-updated');
        return { success: true, ...result };
    } catch (err) {
        writeLog("Error artist-catalog-merge: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('artist-catalog-set-main-genre', (e, payload = {}) => {
    try {
        const result = setArtistMainGenreFromCatalog(payload.artistKeys, payload.genreName);
        if (result.error) return { success: false, error: result.error };
        if (context.artistCatalogWindow) context.artistCatalogWindow.webContents.send('artist-catalog-updated');
        return { success: true, ...result };
    } catch (err) {
        writeLog("Error artist-catalog-set-main-genre: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('artist-catalog-autofill', async (e, payload = {}) => {
    try {
        return await autofillArtistProfilesFromCatalog(payload);
    } catch (err) {
        writeLog("Error artist-catalog-autofill: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-get-artist-card-for-track', async (e, filePath) => {
    try {
        const details = getArtistCardDetailsForTrackPath(filePath);
        return details ? { success: true, ...details } : { success: false, error: 'No se encontro artista enlazado.' };
    } catch (err) {
        writeLog("Error get-artist-card-for-track: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-get-artist-card', (e, payload = {}) => {
    try {
        const rawName = payload.displayName || payload.name || payload.artistKey;
        const artistKey = normalizeArtistKey(payload.artistKey || rawName);
        let card = getArtistCardByKey(artistKey);
        if (!card && payload.createIfMissing !== false) {
            card = ensureArtistProfileForLink(rawName);
        }
        return card ? { success: true, card, tracks: getArtistTracksByKey(card.artistKey) } : { success: false, error: 'Artista no encontrado.' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-fetch-artist-metadata', async (e, displayName) => {
    try {
        return await fetchArtistMetadataOnline(displayName);
    } catch (err) {
        writeLog("Error fetch-artist-metadata: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-save-artist-card', async (e, payload) => {
    try {
        const nextPayload = { ...(payload || {}) };
        if (nextPayload.downloadPhoto && nextPayload.photoUrl) {
            try {
                nextPayload.photoLocalPath = await downloadArtistImage(nextPayload.displayName || nextPayload.artistKey, nextPayload.photoUrl);
            } catch (err) {
                writeLog("Error descargando foto de artista: " + err.message);
            }
        }
        const result = saveArtistCard(nextPayload);
        if (result?.success) {
            if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
            if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        }
        return result;
    } catch (err) {
        writeLog("Error save-artist-card: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('lib-apply-artist-subgenres', async (e, payload = {}) => {
    try {
        const paths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
        const subgenresCsv = cleanCsvList(payload.subgenresCsv || payload.subgenres || '');
        if (!paths.length || !subgenresCsv) return { success: false, error: 'Selecciona canciones y subgeneros.' };
        const update = db.prepare(`
            UPDATE tracks
            SET subgenres_csv = ?, metadata_updated_at = ?
            WHERE file_path = ?
        `);
        const now = new Date().toISOString();
        let updatedTracks = 0;
        db.transaction((trackPaths) => {
            for (const filePath of trackPaths) {
                if (!filePath) continue;
                const current = db.prepare("SELECT subgenres_csv FROM tracks WHERE file_path = ?").get(filePath);
                const merged = mergeCsvList(current?.subgenres_csv || '', subgenresCsv);
                update.run(merged, now, filePath);
                updatedTracks++;
            }
        })(paths);
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, updatedTracks };
    } catch (err) {
        writeLog("Error apply-artist-subgenres: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.on('open-artist-card-editor', (e, filePath) => {
    if (!filePath) return;
    const sendPayload = () => {
        if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
            context.artistCardWindow.webContents.send('load-artist-card', { filePath });
        }
    };

    if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
        if (context.artistCardWindow.isMinimized()) context.artistCardWindow.restore();
        context.artistCardWindow.show();
        context.artistCardWindow.focus();
        sendPayload();
        return;
    }

    context.artistCardWindow = new BrowserWindow({
        width: 1040,
        height: 720,
        minWidth: 860,
        minHeight: 560,
        title: 'Cedula de Artista',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    context.artistCardWindow.loadFile('frontend/artist_card.html');
    context.artistCardWindow.webContents.on('did-finish-load', sendPayload);
    context.artistCardWindow.on('closed', () => {
        context.artistCardWindow = null;
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
    });
});

ipcMain.on('open-artist-card-by-name', (e, displayName) => {
    const artistKey = normalizeArtistKey(displayName);
    if (!artistKey) return;
    const sendPayload = () => {
        if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
            context.artistCardWindow.webContents.send('load-artist-card', { artistKey, displayName, createIfMissing: true });
        }
    };
    if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
        context.artistCardWindow.show();
        context.artistCardWindow.focus();
        sendPayload();
        return;
    }
    context.artistCardWindow = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 960,
        minHeight: 620,
        title: 'Cedula de Artista',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    context.artistCardWindow.loadFile('frontend/artist_card.html');
    context.artistCardWindow.webContents.on('did-finish-load', sendPayload);
    context.artistCardWindow.on('closed', () => { context.artistCardWindow = null; });
});

ipcMain.on('open-artist-card-by-key', (e, payload = {}) => {
    const artistKey = normalizeArtistKey(payload.artistKey);
    const displayName = toDisplayArtist(payload.displayName || payload.artistKey);
    if (!artistKey) return;
    const sendPayload = () => {
        if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
            context.artistCardWindow.webContents.send('load-artist-card', { artistKey, displayName, createIfMissing: true });
        }
    };
    if (context.artistCardWindow && !context.artistCardWindow.isDestroyed()) {
        context.artistCardWindow.show();
        context.artistCardWindow.focus();
        sendPayload();
        return;
    }
    context.artistCardWindow = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 960,
        minHeight: 620,
        title: 'Cedula de Artista',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    context.artistCardWindow.loadFile('frontend/artist_card.html');
    context.artistCardWindow.webContents.on('did-finish-load', sendPayload);
    context.artistCardWindow.on('closed', () => { context.artistCardWindow = null; });
});

ipcMain.on('open-artist-catalog', () => openArtistCatalogWindow());

ipcMain.on('open-genre-editor', (e, payload) => openGenreEditorWindow(payload));

ipcMain.handle('genre-editor-get-catalog', () => {
    try {
        return { success: true, genres: getGenreEditorCatalog() };
    } catch (err) {
        writeLog("Error genre-editor-get-catalog: " + err.message);
        return { success: false, error: err.message, genres: [] };
    }
});

ipcMain.handle('genre-editor-get-tracks', (e, genreKey) => {
    try {
        return { success: true, tracks: getGenreEditorTracks(genreKey) };
    } catch (err) {
        writeLog("Error genre-editor-get-tracks: " + err.message);
        return { success: false, error: err.message, tracks: [] };
    }
});

ipcMain.handle('genre-editor-browse-local', (e, currentPath = '') => {
    try {
        return { success: true, ...browseGenreEditorPath(currentPath) };
    } catch (err) {
        writeLog("Error genre-editor-browse-local: " + err.message);
        return { success: false, error: err.message, entries: [] };
    }
});

ipcMain.handle('genre-editor-suggest-folder', (e, payload = {}) => {
    try {
        const inputPaths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
        if (!inputPaths.length) return { success: false, error: 'Selecciona una carpeta o archivo.' };
        const suggestion = suggestGenreForInputPaths(inputPaths);
        if (!suggestion.genre) return { success: false, error: 'No pude inferir un genero desde esa ruta.' };
        return { success: true, suggestion };
    } catch (err) {
        writeLog("Error genre-editor-suggest-folder: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-sync-links', () => {
    try {
        const result = syncGenreLinksForExistingTracks();
        broadcastGenreProfilesUpdated();
        return { success: true, ...result };
    } catch (err) {
        writeLog("Error genre-editor-sync-links: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-save', (e, payload = {}) => {
    try {
        const result = saveGenreProfileForEditor(payload);
        if (result.success) broadcastGenreProfilesUpdated();
        return result;
    } catch (err) {
        writeLog("Error genre-editor-save: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-delete', (e, genreKey) => {
    try {
        const key = String(genreKey || '').trim();
        if (!key) return { success: false, error: 'Genero invalido' };
        db.prepare("UPDATE genre_profiles SET is_active = 0, updated_at = ? WHERE genre_key = ?").run(new Date().toISOString(), key);
        broadcastGenreProfilesUpdated();
        return { success: true };
    } catch (err) {
        writeLog("Error genre-editor-delete: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-merge-genres', (e, payload = {}) => {
    try {
        return mergeGenreProfilesForEditor(payload);
    } catch (err) {
        writeLog("Error genre-editor-merge-genres: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-reclassify', (e, payload = {}) => {
    try {
        return reclassifyGenreForEditor(payload);
    } catch (err) {
        writeLog("Error genre-editor-reclassify: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-set-type', (e, payload = {}) => {
    try {
        return setGenreProfileTypeForEditor(payload);
    } catch (err) {
        writeLog("Error genre-editor-set-type: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-apply-drop', async (e, payload = {}) => {
    try {
        const genreKey = String(payload.genreKey || '').trim();
        const profile = getGenreEditorCatalog().find(item => item.genreKey === genreKey);
        if (!profile) return { success: false, error: 'Selecciona un genero valido.' };
        const inputPaths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
        const uniqueFiles = collectAudioFilesFromInputPaths(inputPaths, 50000);
        if (uniqueFiles.length === 0) return { success: false, error: 'No se encontraron archivos de audio.' };
        const result = applyGenreToTrackPaths(uniqueFiles, profile.displayName, '', 'genre-editor', inputPaths[0] || '');
        const tagResult = await writeGenreTagsToFiles(uniqueFiles, result.genre);
        broadcastGenreProfilesUpdated();
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, ...result, ...tagResult, scannedFiles: uniqueFiles.length };
    } catch (err) {
        writeLog("Error genre-editor-apply-drop: " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('genre-editor-apply-manual', async (e, payload = {}) => {
    try {
        const inputPaths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
        const genre = String(payload.genre || '').trim();
        const subgenre = String(payload.subgenre || '').trim();
        if (!inputPaths.length || !genre) return { success: false, error: 'Datos incompletos.' };
        const uniqueFiles = collectAudioFilesFromInputPaths(inputPaths, 50000);
        if (uniqueFiles.length === 0) return { success: false, error: 'No se encontraron archivos de audio.' };
        const result = applyGenreToTrackPaths(uniqueFiles, genre, subgenre, 'genre-editor', inputPaths[0] || '');
        const tagResult = payload.writeTags === false ? { tagUpdated: 0, tagFailed: 0 } : await writeGenreTagsToFiles(uniqueFiles, result.genre);
        broadcastGenreProfilesUpdated();
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
        return { success: true, ...result, ...tagResult, genreKey: normalizeGenreKey(genre), scannedFiles: uniqueFiles.length };
    } catch (err) {
        writeLog("Error genre-editor-apply-manual: " + err.message);
        return { success: false, error: err.message };
    }
});

};
