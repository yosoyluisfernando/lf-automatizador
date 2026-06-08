(function () {
    const { ipcRenderer, webUtils } = require('electron');
    const fs = require('fs');
    const path = require('path');

    const configDir = path.join(__dirname, '..', 'config');
    const statePath = path.join(configDir, 'auxiliary_playlists.json');
    const prefsPath = path.join(configDir, 'general_settings.json');
    const fileTypesPath = path.join(configDir, 'file_types.json');
    const explicitTypesPath = path.join(configDir, 'explicit_types.json');
    const weatherPath = path.join(configDir, 'weather.json');
    const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;
    const { defaultFileTypes, normalizeFileTypes } = require('./file_types_data');
    const { normalizeAudioPrefs } = require('./audio_prefs');
    const fileTypeAssignments = require('./file_type_assignments');
    const randomFolderSource = require('./random_folder_source');

    const defaultState = () => ({
        version: 1,
        settings: {
            layout: 'stacked',
            allowSimultaneous: null,
            visibleLists: [true, true],
            playbackModes: ['normal', 'normal']
        },
        lists: [
            { name: 'Auxiliar 1', rows: [], currentIndex: -1, selectedIndex: -1, selectedIndices: [], selectionAnchor: -1, nextIndex: -1, manualDeferredIndex: -1, deck: 'a', status: 'stopped', currentPath: '', startedAt: 0 },
            { name: 'Auxiliar 2', rows: [], currentIndex: -1, selectedIndex: -1, selectedIndices: [], selectionAnchor: -1, nextIndex: -1, manualDeferredIndex: -1, deck: 'a', status: 'stopped', currentPath: '', startedAt: 0 }
        ]
    });

    let state = loadState();
    let roots = [];
    let statusTimer = null;
    let menuEl = null;
    let menuAnchor = null;
    let autoTimers = [null, null];
    let metadataCache = {};
    let prefsCache = normalizeAudioPrefs(readJson(prefsPath, {}));
    let auxClipboard = [];
    let auxClipboardAction = null;
    let randomBagsCache = {};

    function readJson(file, fallback) {
        try {
            if (!fs.existsSync(file)) return fallback;
            return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
        } catch (_) {
            return fallback;
        }
    }

    function normalizeState(raw) {
        const base = defaultState();
        const next = raw && typeof raw === 'object' ? raw : {};
        base.settings = { ...base.settings, ...(next.settings || {}) };
        if (!['stacked', 'side'].includes(base.settings.layout)) base.settings.layout = 'stacked';
        if (![true, false, null].includes(base.settings.allowSimultaneous)) base.settings.allowSimultaneous = null;
        base.settings.visibleLists = Array.isArray(base.settings.visibleLists)
            ? [base.settings.visibleLists[0] !== false, base.settings.visibleLists[1] !== false]
            : [true, true];
        if (!base.settings.visibleLists[0] && !base.settings.visibleLists[1]) base.settings.visibleLists = [true, true];
        base.settings.playbackModes = Array.isArray(base.settings.playbackModes)
            ? [base.settings.playbackModes[0] || 'normal', base.settings.playbackModes[1] || 'normal']
            : ['normal', 'normal'];
        base.settings.playbackModes = base.settings.playbackModes.map(mode => ['normal', 'random', 'manual', 'infinite'].includes(mode) ? mode : 'normal');
        if (Array.isArray(next.lists)) {
            for (let i = 0; i < 2; i++) {
                const src = next.lists[i] || {};
                base.lists[i] = {
                    ...base.lists[i],
                    ...src,
                    name: String(src.name || base.lists[i].name).slice(0, 40),
                    rows: Array.isArray(src.rows) ? src.rows.map(normalizeRow).filter(Boolean) : [],
                    currentIndex: Number.isInteger(src.currentIndex) ? src.currentIndex : -1,
                    selectedIndex: Number.isInteger(src.selectedIndex) ? src.selectedIndex : -1,
                    selectedIndices: Array.isArray(src.selectedIndices) ? src.selectedIndices.filter(index => Number.isInteger(index) && index >= 0) : [],
                    selectionAnchor: Number.isInteger(src.selectionAnchor) ? src.selectionAnchor : -1,
                    nextIndex: Number.isInteger(src.nextIndex) ? src.nextIndex : -1,
                    manualDeferredIndex: Number.isInteger(src.manualDeferredIndex) ? src.manualDeferredIndex : -1,
                    deck: src.deck === 'b' ? 'b' : 'a',
                    status: ['playing', 'paused', 'stopped'].includes(src.status) ? src.status : 'stopped',
                    startedAt: Number.isFinite(Number(src.startedAt)) ? Number(src.startedAt) : 0
                };
                if (base.lists[i].status === 'stopped'
                    && base.lists[i].rows.length
                    && (base.lists[i].nextIndex < 0 || base.lists[i].nextIndex >= base.lists[i].rows.length)) {
                    base.lists[i].nextIndex = 0;
                }
                base.lists[i].selectedIndices = [...new Set(base.lists[i].selectedIndices.filter(index => index < base.lists[i].rows.length))].sort((a, b) => a - b);
                if (base.lists[i].selectedIndex >= 0 && base.lists[i].selectedIndex < base.lists[i].rows.length && !base.lists[i].selectedIndices.includes(base.lists[i].selectedIndex)) {
                    base.lists[i].selectedIndices.push(base.lists[i].selectedIndex);
                    base.lists[i].selectedIndices.sort((a, b) => a - b);
                }
                if (!isValidRowIndex(base.lists[i], base.lists[i].manualDeferredIndex)) base.lists[i].manualDeferredIndex = -1;
            }
        }
        return base;
    }

    function loadState() {
        return normalizeState(readJson(statePath, defaultState()));
    }

    function saveState() {
        try {
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
        } catch (_) { }
    }

    function normalizeRow(row) {
        if (!row) return null;
        const ruta = String(row.ruta || row.path || '').trim();
        const type = String(row.type || 'normal').trim() || 'normal';
        if (!ruta && !['note', 'stop', 'aux_jump', 'main_jump', 'main_resume', 'time', 'temperature', 'humidity', 'execute_event'].includes(type)) return null;
        const title = type === 'main_resume'
            ? 'Retomar playlist principal'
            : String(row.titulo || row.title || row.nombre || (ruta ? path.basename(ruta) : type)).trim();
        return {
            ruta,
            titulo: title,
            duracion: Math.max(0, parseInt(row.duracion ?? row.duration ?? 0, 10) || 0),
            type,
            target: row.target || null,
            eventId: row.eventId || row.id || '',
            eventName: row.eventName || '',
            temp: row.temp === true,
            fileType: row.fileType || null,
            recursive: row.recursive === true || row.recursive === 'true',
            resolvedRandomPath: row.resolvedRandomPath || ''
        };
    }

    function normalizePlaylistDropRow(row) {
        if (!row) return null;
        const type = String(row.type || 'normal').trim() || 'normal';
        const title = row.titulo || row.title || row.nombre || row.name || '';
        if (type === 'playlist_jump') {
            return normalizeRow({ type: 'main_jump', target: row.targetTab ?? row.target, titulo: title || 'Saltar a playlist principal' });
        }
        return normalizeRow({
            ruta: row.ruta || row.path || '',
            titulo: title,
            duracion: row.duracion ?? row.duration ?? 0,
            type,
            target: row.target ?? row.targetTab ?? null,
            temp: row.temp === true,
            fileType: row.fileType || null,
            recursive: row.recursive === true || row.recursive === 'true'
        });
    }

    function formatTime(total) {
        const sec = Math.max(0, Math.round(Number(total) || 0));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return h > 0
            ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function fileUrl(filePath) {
        return `file:///${String(filePath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`;
    }

    function probeDuration(filePath) {
        return new Promise(resolve => {
            const audio = new Audio();
            const finish = val => resolve(Math.max(0, Math.round(Number(val) || 0)));
            const timeout = setTimeout(() => finish(0), 3500);
            audio.addEventListener('loadedmetadata', () => {
                clearTimeout(timeout);
                finish(audio.duration);
            });
            audio.addEventListener('error', () => {
                clearTimeout(timeout);
                finish(0);
            });
            audio.preload = 'metadata';
            audio.src = fileUrl(filePath);
        });
    }

    async function buildAudioRow(filePath) {
        const title = path.basename(filePath).replace(/\.[^/.]+$/, '');
        const row = { ruta: filePath, titulo: title, duracion: await probeDuration(filePath), type: 'normal', target: null };
        return refreshRowMetadata(row);
    }

    function listAudioFiles(folder, recursive = false) {
        const out = [];
        function walk(dir) {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            entries.forEach(entry => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (recursive) walk(full);
                } else if (AUDIO_EXT.test(entry.name)) {
                    out.push(full);
                }
            });
        }
        walk(folder);
        return out;
    }

    function getPrefs() {
        prefsCache = normalizeAudioPrefs(readJson(prefsPath, prefsCache));
        return prefsCache;
    }

    function getCurrentWeather() {
        return readJson(weatherPath, { temp: null, hum: null, unitSym: '°C' });
    }

    function getClimateLocutionLabel(kind) {
        return kind === 'humidity' ? '💧' : '🌡️';
    }

    function getCurrentClimateValue(kind) {
        const weather = getCurrentWeather();
        return Number(kind === 'humidity' ? weather.hum : weather.temp);
    }

    function getClimateLocutionFolder(kind) {
        const prefs = getPrefs();
        if (kind === 'humidity') return prefs.weatherHumidityFolder || prefs.weatherFolder || '';
        return prefs.weatherTemperatureFolder || prefs.weatherFolder || '';
    }

    function folderHasClimateFiles(folder, kind) {
        try {
            if (!folder || !fs.existsSync(folder)) return false;
            return fs.readdirSync(folder).some(file => {
                const name = String(file || '').toUpperCase();
                return kind === 'humidity'
                    ? name.startsWith('HUM')
                    : name.startsWith('TMP') || name.startsWith('TMPN');
            });
        } catch (_) {
            return false;
        }
    }

    function findClimateLocutionFile(folder, kind, value) {
        try {
            if (!folder || !fs.existsSync(folder)) return '';
            const rounded = Math.round(Number(value));
            if (!Number.isFinite(rounded)) return '';
            const prefix = kind === 'humidity'
                ? `HUM${String(Math.max(0, Math.min(100, rounded))).padStart(3, '0')}`
                : (rounded < 0 ? `TMPN${String(Math.abs(rounded)).padStart(3, '0')}` : `TMP${String(rounded).padStart(3, '0')}`);
            const match = fs.readdirSync(folder).find(file => String(file || '').toUpperCase().startsWith(prefix));
            return match ? path.join(folder, match) : '';
        } catch (_) {
            return '';
        }
    }

    function resolveClimateLocutionFolder(kind) {
        const configured = getClimateLocutionFolder(kind);
        const childName = kind === 'humidity' ? 'Humidity' : 'Temperature';
        const candidates = [];
        if (configured) {
            candidates.push(configured);
            candidates.push(path.join(configured, childName));
            candidates.push(path.join(path.dirname(configured), childName));
        }
        return candidates.find(candidate => folderHasClimateFiles(candidate, kind)) || configured || '';
    }

    async function resolveClimatePlaybackRow(row) {
        const value = getCurrentClimateValue(row.type);
        if (!Number.isFinite(value)) return null;
        const folder = resolveClimateLocutionFolder(row.type);
        const filePath = findClimateLocutionFile(folder, row.type, value);
        if (!filePath) return null;
        const rounded = Math.round(value);
        const weather = getCurrentWeather();
        const suffix = row.type === 'humidity' ? `${rounded}%` : `${rounded}${weather.unitSym || '°C'}`;
        return {
            ...row,
            ruta: filePath,
            titulo: `${getClimateLocutionLabel(row.type)} ${suffix}`,
            duracion: await probeDuration(filePath),
            type: row.type
        };
    }

    function getFileTypes() {
        try {
            const raw = fs.existsSync(fileTypesPath) ? JSON.parse(fs.readFileSync(fileTypesPath, 'utf-8')) : defaultFileTypes;
            return normalizeFileTypes(raw);
        } catch (_) {
            return normalizeFileTypes(defaultFileTypes);
        }
    }

    function getExplicitTypes() {
        try {
            const raw = fs.existsSync(explicitTypesPath) ? JSON.parse(fs.readFileSync(explicitTypesPath, 'utf-8')) : {};
            return raw && typeof raw === 'object' ? raw : {};
        } catch (_) {
            return {};
        }
    }

    function saveExplicitTypes(map) {
        try {
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(explicitTypesPath, JSON.stringify(map && typeof map === 'object' ? map : {}, null, 2), 'utf-8');
        } catch (_) { }
    }

    function resolveExplicitTypeData(targetPath) {
        if (!targetPath) return null;
        const explicitTypes = getExplicitTypes();
        const fileTypeOptions = fileTypeAssignments.readOptions();
        const types = getFileTypes();
        const byId = id => types.find(type => type.id === id) || null;
        if (explicitTypes[targetPath]) {
            const found = byId(explicitTypes[targetPath]);
            if (found) return found;
        }
        const dirPath = path.dirname(targetPath);
        if (!dirPath || dirPath === targetPath) return null;
        if (explicitTypes[dirPath]) {
            const found = byId(explicitTypes[dirPath]);
            if (found) return found;
        }
        let prev = dirPath;
        let ancestor = path.dirname(dirPath);
        while (ancestor && ancestor !== prev) {
            if (explicitTypes[ancestor] && fileTypeAssignments.includesSubfolders(ancestor, fileTypeOptions)) {
                const found = byId(explicitTypes[ancestor]);
                if (found) return found;
            }
            prev = ancestor;
            ancestor = path.dirname(ancestor);
        }
        return null;
    }

    function parseCue(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function getTrackTypeData(filePath) {
        const meta = metadataCache[filePath] || {};
        const types = getFileTypes();
        if (meta.typeId) {
            const byId = types.find(type => type.id === meta.typeId);
            if (byId) return byId;
        }
        const explicit = resolveExplicitTypeData(filePath);
        if (explicit) return explicit;
        const lowerName = path.basename(filePath || '').toLowerCase();
        return types.find(type => {
            const terms = [type.identifier, ...(Array.isArray(type.aliases) ? type.aliases : [])]
                .filter(Boolean)
                .map(term => String(term).toLowerCase());
            return terms.some(term => lowerName.includes(term));
        }) || null;
    }

    function getAuxRowColor(row) {
        if (!row) return '';
        if (row.type === 'stop') return '#e74c3c';
        if (row.type === 'note') return '#aaaaaa';
        if (['main_jump', 'aux_jump', 'main_resume'].includes(row.type)) return '#d2a8ff';
        if (row.type === 'random') return resolveExplicitTypeData(row.ruta)?.color || '#f39c12';
        const typeData = getTrackTypeData(row.ruta || '');
        return typeData ? typeData.color : '#e5e5e5';
    }

    function getLocutionTypeData() {
        const types = getFileTypes();
        return types.find(type => type.id === 't_time')
            || types.find(type => /locuci|locution|hora|time|saytime/i.test(`${type.name} ${type.identifier} ${(type.aliases || []).join(' ')}`))
            || null;
    }

    function getFadeConfig(filePath, rowType = '') {
        const prefs = getPrefs();
        const isLocution = ['time', 'temperature', 'humidity'].includes(rowType)
            || ['time_locution', 'temperature_locution', 'humidity_locution'].includes(filePath);
        const typeData = isLocution ? getLocutionTypeData() : getTrackTypeData(filePath);
        if (typeData) {
            return {
                fadein: typeData.fadeinActive ? (Number(typeData.fadein) || 0) : 0,
                fadeoutStop: typeData.fadeoutStopActive ? (Number(typeData.fadeoutStop) || 0) : 0,
                fadeoutNext: typeData.fadeoutNextActive ? (Number(typeData.fadeoutNext) || 0) : 0,
                mixTrigger: typeData.mixActive ? (Number(typeData.mix) || 0) : 0,
                mixFadeoutActive: typeData.mixFadeoutActive === true,
                ampDb: Number(typeData.amp) || 0
            };
        }
        return {
            fadein: prefs.chk_mus_fadein ? (Number(prefs.num_mus_fadein) || 0) : 0,
            fadeoutStop: prefs.chk_mus_fadeout_stop ? (Number(prefs.num_mus_fadeout_stop) || 0) : 0,
            fadeoutNext: prefs.chk_mus_fadeout_next ? (Number(prefs.num_mus_fadeout_next) || 0) : 0,
            mixTrigger: prefs.chk_mus_mix ? (Number(prefs.num_mus_mix) || 0) : 0,
            mixFadeoutActive: prefs.chk_mus_mix_fadeout === true,
            ampDb: 0
        };
    }

    function dbToLinear(db) {
        const value = Number(db);
        return Number.isFinite(value) ? Math.pow(10, value / 20) : 1;
    }

    async function ensureMetadata(paths) {
        const safe = [...new Set((paths || []).filter(Boolean).filter(p => !metadataCache[p]))];
        if (!safe.length) return;
        try {
            const scoped = await ipcRenderer.invoke('lib-get-db-tracks', safe, { includeSignatures: false });
            metadataCache = { ...metadataCache, ...(scoped || {}) };
        } catch (_) { }
    }

    async function refreshRowMetadata(row) {
        if (!row || row.type !== 'normal' || !row.ruta) return row;
        await ensureMetadata([row.ruta]);
        const meta = metadataCache[row.ruta] || {};
        const start = parseCue(meta.inicio) || 0;
        const rawDuration = parseCue(meta.duration) || row.duracion || await probeDuration(row.ruta);
        const end = parseCue(meta.fin);
        const effectiveEnd = end !== null && end > start ? end : rawDuration;
        row.duracion = Math.max(0, Math.round(effectiveEnd - start));
        if (meta.customTitle || meta.customArtist) {
            row.titulo = `${meta.customArtist ? meta.customArtist + ' - ' : ''}${meta.customTitle || row.titulo}`;
        }
        return row;
    }

    function getAuxRoute(listIndex) {
        const prefs = getPrefs();
        const mode = Array.isArray(prefs.auxiliaryOutputModes) ? prefs.auxiliaryOutputModes[listIndex] : 'master';
        if (mode === 'cue') return { bus: 'cue', outputId: prefs.outCue || 'default', mode };
        if (mode === 'device') return { bus: `aux${listIndex + 1}-independent`, outputId: (prefs.auxiliaryOutputs || [])[listIndex] || 'default', mode };
        return { bus: `aux${listIndex + 1}`, outputId: prefs.outMain || 'default', mode: 'master' };
    }

    function playerId(listIndex, deck) {
        return `aux${listIndex + 1}-${deck}`;
    }

    function clearAutoTimer(listIndex) {
        if (autoTimers[listIndex]) clearTimeout(autoTimers[listIndex]);
        autoTimers[listIndex] = null;
    }

    function getPlaybackPlan(row) {
        const meta = metadataCache[row?.ruta] || {};
        const config = getFadeConfig(row?.ruta || '', row?.type || '');
        const start = parseCue(meta.inicio) || 0;
        const naturalDuration = parseCue(meta.duration) || row?.duracion || 0;
        const end = parseCue(meta.fin);
        const effectiveEnd = end !== null && end > start ? end : naturalDuration;
        const effectiveDuration = Math.max(0.1, effectiveEnd - start);
        const mixAbsolute = parseCue(meta.mix);
        const mixAfterStart = mixAbsolute !== null && mixAbsolute > start
            ? Math.max(0, mixAbsolute - start)
            : Math.max(0, effectiveDuration - (config.mixTrigger || 0));
        return { ...config, start, effectiveEnd, effectiveDuration, mixAfterStart };
    }

    function shuffleArray(items) {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function randomBagKey(folderPath, recursive) {
        return `${recursive ? 'R' : 'F'}|${folderPath}`;
    }

    async function resolveRandomRow(row) {
        if (!row || row.type !== 'random' || !row.ruta) return null;
        const recursive = row.recursive !== false;
        const rels = await randomFolderSource.warmRandomFolder(row.ruta, recursive);
        if (!rels.length) return null;
        const key = randomBagKey(row.ruta, recursive);
        if (!randomBagsCache[key] || randomBagsCache[key].length === 0) {
            randomBagsCache[key] = shuffleArray(rels);
        }
        const nextRel = randomBagsCache[key].pop();
        return nextRel ? randomFolderSource.resolveAbsolute(row.ruta, nextRel) : null;
    }

    function scheduleAutoAdvance(listIndex, row, startedAt) {
        clearAutoTimer(listIndex);
        const list = state.lists[listIndex];
        if (list.status !== 'playing') return;
        const plan = getPlaybackPlan(row);
        const nextIndex = getNextPlaybackIndex(listIndex);
        const hasNext = nextIndex >= 0 && nextIndex < list.rows.length;
        const triggerSeconds = hasNext ? plan.mixAfterStart : plan.effectiveDuration;
        const delayMs = Math.max(50, (triggerSeconds * 1000) - Math.max(0, Date.now() - startedAt));
        autoTimers[listIndex] = setTimeout(() => {
            if (state.lists[listIndex].status !== 'playing') return;
            const currentNextIndex = getNextPlaybackIndex(listIndex);
            if (currentNextIndex >= 0 && currentNextIndex < state.lists[listIndex].rows.length) playList(listIndex, currentNextIndex);
            else stopList(listIndex, true);
        }, delayMs);
    }

    function rescheduleCurrentAutoAdvance(listIndex) {
        const list = state.lists[listIndex];
        const row = list.rows[list.currentIndex];
        if (list.status !== 'playing' || !row || row.type === 'time') return;
        scheduleAutoAdvance(listIndex, row, list.startedAt || Date.now());
    }

    function rust(command) {
        return ipcRenderer.invoke('audio-engine-rust-command', command).catch(err => ({ success: false, error: err.message || String(err) }));
    }

    function syncAuxRoute(route) {
        if (!route?.bus) return Promise.resolve(null);
        return rust({ cmd: 'route', bus: route.bus, outputId: route.outputId || 'default' });
    }

    async function ask(message) {
        try { return await ipcRenderer.invoke('dialog:confirm', message); }
        catch (_) { return window.confirm(message); }
    }

    function isValidRowIndex(list, index) {
        return Number.isInteger(index) && index >= 0 && index < list.rows.length;
    }

    function getPlaybackMode(listIndex) {
        const mode = state.settings.playbackModes?.[listIndex] || 'normal';
        return ['normal', 'random', 'manual', 'infinite'].includes(mode) ? mode : 'normal';
    }

    function isOperationalRow(row) {
        return row && row.type !== 'note';
    }

    function getOperationalIndices(list) {
        return list.rows.map((row, index) => isOperationalRow(row) ? index : -1).filter(index => index >= 0);
    }

    function getRandomOperationalIndex(list) {
        const indices = getOperationalIndices(list);
        return indices.length ? indices[Math.floor(Math.random() * indices.length)] : -1;
    }

    function getFirstOperationalIndex(list) {
        return getOperationalIndices(list)[0] ?? -1;
    }

    function getNextOperationalIndex(list, fromIndex, allowLoop = false) {
        for (let index = Math.max(0, fromIndex + 1); index < list.rows.length; index++) {
            if (isOperationalRow(list.rows[index])) return index;
        }
        return allowLoop ? getFirstOperationalIndex(list) : -1;
    }

    function getFirstOperationalIndexExcept(list, excludedIndex) {
        return getOperationalIndices(list).find(index => index !== excludedIndex) ?? -1;
    }

    function getNextAfterTerminalCommandIndex(list, commandIndex, mode) {
        if (mode === 'random') return getRandomOperationalIndex(list);
        const next = getNextOperationalIndex(list, commandIndex, mode === 'infinite');
        if (next >= 0) return next;
        if (mode === 'normal') return getFirstOperationalIndexExcept(list, commandIndex);
        return -1;
    }

    function setAuxPlaybackMode(listIndex, mode) {
        const safeMode = ['normal', 'random', 'manual', 'infinite'].includes(mode) ? mode : 'normal';
        const list = state.lists[listIndex];
        state.settings.playbackModes[listIndex] = safeMode;
        if (safeMode === 'manual' && list.status === 'playing' && isValidRowIndex(list, list.nextIndex)) {
            list.manualDeferredIndex = list.nextIndex;
        } else {
            list.manualDeferredIndex = -1;
            if (safeMode === 'random' && !isValidRowIndex(list, list.nextIndex)) list.nextIndex = getRandomOperationalIndex(list);
        }
        saveState();
        renderAll();
    }

    function getSelectedIndices(list) {
        const source = Array.isArray(list.selectedIndices) ? list.selectedIndices : [];
        const indices = [...new Set(source.filter(index => isValidRowIndex(list, index)))].sort((a, b) => a - b);
        if (!indices.length && isValidRowIndex(list, list.selectedIndex)) indices.push(list.selectedIndex);
        return indices;
    }

    function setSingleSelection(list, index) {
        list.selectedIndex = isValidRowIndex(list, index) ? index : -1;
        list.selectedIndices = list.selectedIndex >= 0 ? [list.selectedIndex] : [];
        list.selectionAnchor = list.selectedIndex;
    }

    function selectRowWithEvent(list, index, event) {
        if (!isValidRowIndex(list, index)) return;
        if (event?.shiftKey && isValidRowIndex(list, list.selectionAnchor)) {
            const start = Math.min(list.selectionAnchor, index);
            const end = Math.max(list.selectionAnchor, index);
            list.selectedIndices = [];
            for (let i = start; i <= end; i++) list.selectedIndices.push(i);
            list.selectedIndex = index;
            return;
        }
        if (event?.ctrlKey || event?.metaKey) {
            const selected = new Set(getSelectedIndices(list));
            if (selected.has(index)) selected.delete(index);
            else selected.add(index);
            list.selectedIndices = [...selected].sort((a, b) => a - b);
            list.selectedIndex = list.selectedIndices.includes(index)
                ? index
                : (list.selectedIndices[list.selectedIndices.length - 1] ?? -1);
            list.selectionAnchor = index;
            return;
        }
        setSingleSelection(list, index);
    }

    function getPlayStartIndex(listIndex) {
        const list = state.lists[listIndex];
        if (isValidRowIndex(list, list.nextIndex)) return list.nextIndex;
        if (isValidRowIndex(list, list.currentIndex)) return list.currentIndex;
        return getFirstOperationalIndex(list);
    }

    function getNaturalNextIndex(listIndex) {
        const list = state.lists[listIndex];
        if (list.currentIndex < 0) return getPlayStartIndex(listIndex);
        return getNextOperationalIndex(list, list.currentIndex, getPlaybackMode(listIndex) === 'infinite');
    }

    function getNextPlaybackIndex(listIndex) {
        const list = state.lists[listIndex];
        const mode = getPlaybackMode(listIndex);
        if (mode === 'random') return isValidRowIndex(list, list.nextIndex) ? list.nextIndex : getRandomOperationalIndex(list);
        if (list.currentIndex >= 0
            && Number.isInteger(list.nextIndex)
            && list.nextIndex >= 0
            && list.nextIndex < list.rows.length
            && list.nextIndex !== list.currentIndex) {
            return list.nextIndex;
        }
        if (mode === 'manual' && list.status === 'playing') return -1;
        return getNaturalNextIndex(listIndex);
    }

    function continueAfterCommand(listIndex, commandIndex) {
        const list = state.lists[listIndex];
        const mode = getPlaybackMode(listIndex);
        const next = mode === 'random'
            ? getRandomOperationalIndex(list)
            : getNextOperationalIndex(list, commandIndex, mode === 'infinite');
        list.selectedIndex = -1;
        list.nextIndex = next;
        list.manualDeferredIndex = -1;
        if (mode === 'manual') {
            list.status = 'stopped';
            list.currentIndex = -1;
            list.startedAt = 0;
            saveState();
            renderAll();
            return;
        }
        saveState();
        renderAll();
        if (next >= 0) return playList(listIndex, next);
        return stopList(listIndex, true);
    }

    async function finishTerminalCommand(listIndex, commandIndex) {
        clearAutoTimer(listIndex);
        const list = state.lists[listIndex];
        const mode = getPlaybackMode(listIndex);
        await rust({ cmd: 'stop', player: playerId(listIndex, 'a') });
        await rust({ cmd: 'stop', player: playerId(listIndex, 'b') });
        list.status = 'stopped';
        list.currentIndex = -1;
        list.selectedIndex = -1;
        list.nextIndex = getNextAfterTerminalCommandIndex(list, commandIndex, mode);
        list.manualDeferredIndex = -1;
        list.startedAt = 0;
        list.currentPath = '';
        saveState();
        renderAll();
    }

    async function enforceSimultaneousPolicy(listIndex) {
        const otherIndex = listIndex === 0 ? 1 : 0;
        if (state.settings.allowSimultaneous === true) return true;
        const other = state.lists[otherIndex];
        if (other.status !== 'playing') return true;
        if (state.settings.allowSimultaneous === false) {
            const ok = await ask('La otra playlist auxiliar esta sonando. Detenerla para continuar?');
            if (!ok) return false;
            await stopList(otherIndex);
            return true;
        }
        const allow = await ask('Permitir que Auxiliar 1 y Auxiliar 2 suenen al mismo tiempo?');
        state.settings.allowSimultaneous = allow === true;
        saveState();
        if (!allow) {
            const ok = await ask('Detener la otra playlist auxiliar para continuar?');
            if (!ok) return false;
            await stopList(otherIndex);
        }
        return true;
    }

    async function playList(listIndex, startIndex = null) {
        const list = state.lists[listIndex];
        if (!list.rows.length) return;
        if (!(await enforceSimultaneousPolicy(listIndex))) return;
        let idx = startIndex == null ? getPlayStartIndex(listIndex) : startIndex;
        const row = list.rows[idx];
        if (!row) return;
        if (row.type === 'stop') return stopList(listIndex);
        if (row.type === 'note') return continueAfterCommand(listIndex, idx);
        if (row.type === 'execute_event') {
            await requestMainEventExecution(row);
            return continueAfterCommand(listIndex, idx);
        }
        if (row.type === 'main_resume') {
            requestMainResume();
            return finishTerminalCommand(listIndex, idx);
        }
        if (row.type === 'main_jump') {
            requestMainJump(Number(row.target) || 0);
            return continueAfterCommand(listIndex, idx);
        }
        if (row.type === 'aux_jump') {
            const target = Number(row.target);
            if (target === listIndex) return continueAfterCommand(listIndex, idx);
            if (target === 0 || target === 1) await playList(target, 0);
            return continueAfterCommand(listIndex, idx);
        }
        let playbackRow = row;
        const isTimeLocution = row.type === 'time';
        if (isTimeLocution) {
            const prefs = getPrefs();
            if (!prefs.timeFolder || !fs.existsSync(prefs.timeFolder)) return playNext(listIndex);
            playbackRow = { ...row, ruta: 'time_locution', duracion: row.duracion || 5 };
        } else if (row.type === 'temperature' || row.type === 'humidity') {
            playbackRow = await resolveClimatePlaybackRow(row);
            if (!playbackRow) return playNext(listIndex);
            await refreshRowMetadata(playbackRow);
        } else if (row.type === 'random') {
            const randomPath = await resolveRandomRow(row);
            if (!randomPath) return playNext(listIndex);
            row.resolvedRandomPath = randomPath;
            playbackRow = {
                ...row,
                ruta: randomPath,
                titulo: path.basename(randomPath).replace(/\.[^/.]+$/, ''),
                duracion: await probeDuration(randomPath),
                type: 'normal'
            };
            await refreshRowMetadata(playbackRow);
        } else {
            await refreshRowMetadata(row);
        }
        const plan = getPlaybackPlan(playbackRow);
        const previousIndex = list.status === 'playing' ? list.currentIndex : -1;
        const previousRow = previousIndex >= 0 ? list.rows[previousIndex] : null;
        const previousPlan = previousRow ? getPlaybackPlan(previousRow) : null;
        const previousDeck = list.deck || 'a';
        const nextDeck = previousDeck === 'a' ? 'b' : 'a';
        const route = getAuxRoute(listIndex);
        const nextPlayer = playerId(listIndex, nextDeck);
        const prevPlayer = playerId(listIndex, previousDeck);
        const targetGain = dbToLinear(plan.ampDb);
        await syncAuxRoute(route);
        if (isTimeLocution) {
            const prefs = getPrefs();
            const result = await rust({ cmd: 'timeLocution', player: nextPlayer, folder: prefs.timeFolder, bus: route.bus, outputId: route.outputId, gain: targetGain });
            if (result?.success === false) return playNext(listIndex);
            const durationMs = Number(result?.message?.durationMs ?? result?.durationMs ?? 0);
            if (durationMs > 0) playbackRow.duracion = Math.max(1, Math.round(durationMs / 1000));
        } else {
            const load = await rust({ cmd: 'loadAudio', player: nextPlayer, path: playbackRow.ruta, bus: route.bus, outputId: route.outputId, gain: 0, autoplay: false });
            if (load?.success === false) return playNext(listIndex);
            if (plan.start > 0) await rust({ cmd: 'seek', player: nextPlayer, positionMs: Math.round(plan.start * 1000) });
            await rust({ cmd: 'play', player: nextPlayer });
            await rust({ cmd: 'fade', player: nextPlayer, fromGain: 0, toGain: targetGain, durationMs: Math.round((plan.fadein || 0) * 1000) });
        }
        if (list.status === 'playing') {
            const fadeOut = previousPlan?.mixFadeoutActive ? Math.max(0, previousPlan.effectiveDuration - previousPlan.mixAfterStart) : (previousPlan?.fadeoutNext || plan.fadeoutNext || 0);
            await rust({ cmd: 'fade', player: prevPlayer, fromGain: 1, toGain: 0, durationMs: Math.round(fadeOut * 1000), stopAfter: true });
        }
        if (previousRow?.temp === true && previousRow !== row && previousIndex >= 0) {
            list.rows.splice(previousIndex, 1);
            if (previousIndex < idx) idx -= 1;
        }
        list.deck = nextDeck;
        list.currentIndex = idx;
        list.selectedIndex = -1;
        const playbackMode = getPlaybackMode(listIndex);
        if (playbackMode === 'manual') {
            if (list.nextIndex === idx) list.nextIndex = -1;
            list.manualDeferredIndex = isValidRowIndex(list, list.nextIndex) ? list.nextIndex : -1;
        } else if (playbackMode === 'random') {
            list.nextIndex = getRandomOperationalIndex(list);
            list.manualDeferredIndex = -1;
        } else {
            list.nextIndex = getNextOperationalIndex(list, idx, playbackMode === 'infinite');
            list.manualDeferredIndex = -1;
        }
        list.status = 'playing';
        list.startedAt = Date.now();
        list.currentPath = isTimeLocution ? '' : playbackRow.ruta;
        if (!isTimeLocution && playbackMode !== 'manual') scheduleAutoAdvance(listIndex, playbackRow, list.startedAt);
        saveState();
        renderAll();
    }

    async function pauseList(listIndex) {
        const list = state.lists[listIndex];
        await rust({ cmd: 'pause', player: playerId(listIndex, list.deck || 'a') });
        list.status = 'paused';
        saveState();
        renderAll();
    }

    async function stopList(listIndex, natural = false) {
        clearAutoTimer(listIndex);
        const list = state.lists[listIndex];
        const stoppingIndex = list.currentIndex;
        const stoppingRow = stoppingIndex >= 0 ? list.rows[stoppingIndex] : null;
        const mode = getPlaybackMode(listIndex);
        let nextAfterStop = natural
            ? (mode === 'manual'
                ? (isValidRowIndex(list, list.nextIndex) ? list.nextIndex : getNextOperationalIndex(list, stoppingIndex, false))
                : (mode === 'random' ? getRandomOperationalIndex(list) : getNextOperationalIndex(list, stoppingIndex, mode === 'infinite')))
            : (isValidRowIndex(list, list.nextIndex)
                ? list.nextIndex
                : getNextOperationalIndex(list, list.currentIndex, mode === 'infinite'));
        if (list.currentIndex >= 0 && list.status === 'playing') {
            const current = list.rows[list.currentIndex];
            const plan = getPlaybackPlan(current || {});
            await rust({ cmd: 'stop', player: playerId(listIndex, (list.deck || 'a') === 'a' ? 'b' : 'a') });
            await rust({ cmd: 'fade', player: playerId(listIndex, list.deck || 'a'), fromGain: dbToLinear(plan.ampDb), toGain: 0, durationMs: Math.round((plan.fadeoutStop || 0) * 1000), stopAfter: true });
        } else {
            await rust({ cmd: 'stop', player: playerId(listIndex, 'a') });
            await rust({ cmd: 'stop', player: playerId(listIndex, 'b') });
        }
        if (natural && stoppingRow?.temp === true && stoppingIndex >= 0) {
            list.rows.splice(stoppingIndex, 1);
            nextAfterStop = getFirstOperationalIndex(list);
        }
        list.status = 'stopped';
        list.currentIndex = -1;
        list.nextIndex = nextAfterStop;
        list.manualDeferredIndex = -1;
        list.startedAt = 0;
        if (natural) list.selectedIndex = -1;
        saveState();
        renderAll();
    }

    function playNext(listIndex) {
        const list = state.lists[listIndex];
        if (getPlaybackMode(listIndex) === 'manual' && list.status === 'playing') return stopList(listIndex, true);
        const next = getNextPlaybackIndex(listIndex);
        if (next >= 0 && next < list.rows.length) return playList(listIndex, next);
        return stopList(listIndex, true);
    }

    window.lfAuxiliaryPlaylistApi = {
        stopAll: async () => {
            await Promise.all([0, 1].map(index => stopList(index)));
        },
        isOnAir: () => state.lists.some(list => list.status === 'playing')
    };

    function getVisualNextIndex(listIndex) {
        const list = state.lists[listIndex];
        if (getPlaybackMode(listIndex) === 'manual' && list.status === 'playing') return -1;
        if (list.status === 'playing' && list.currentIndex >= 0) return getNextPlaybackIndex(listIndex);
        return isValidRowIndex(list, list.nextIndex) ? list.nextIndex : -1;
    }

    function getManualDeferredVisualIndex(listIndex) {
        const list = state.lists[listIndex];
        return getPlaybackMode(listIndex) === 'manual'
            && list.status === 'playing'
            && isValidRowIndex(list, list.manualDeferredIndex)
            ? list.manualDeferredIndex
            : -1;
    }

    function requestMainResume() {
        if (window.lfMainPlaylistApi) window.lfMainPlaylistApi.resume();
        else ipcRenderer.send('auxiliary-main-resume');
    }

    function requestMainJump(index) {
        if (window.lfMainPlaylistApi) window.lfMainPlaylistApi.jumpToPlaylist(index);
        else ipcRenderer.send('auxiliary-main-jump', index);
    }

    async function requestMainEventExecution(row) {
        const eventId = row?.eventId || row?.ruta || '';
        if (!eventId) return null;
        if (window.lfMainPlaylistApi?.executeEventById) return window.lfMainPlaylistApi.executeEventById(eventId, { trigger: 'auxiliary-command' });
        ipcRenderer.send('auxiliary-execute-event', { eventId });
        return null;
    }

    function captureRowRefs(list) {
        return {
            current: list.currentIndex >= 0 ? list.rows[list.currentIndex] : null,
            selected: list.selectedIndex >= 0 ? list.rows[list.selectedIndex] : null,
            next: list.nextIndex >= 0 ? list.rows[list.nextIndex] : null,
            manualDeferred: list.manualDeferredIndex >= 0 ? list.rows[list.manualDeferredIndex] : null
        };
    }

    function restoreRowRefs(list, refs) {
        list.currentIndex = refs.current ? list.rows.indexOf(refs.current) : -1;
        list.selectedIndex = refs.selected ? list.rows.indexOf(refs.selected) : -1;
        list.nextIndex = refs.next ? list.rows.indexOf(refs.next) : -1;
        list.manualDeferredIndex = refs.manualDeferred ? list.rows.indexOf(refs.manualDeferred) : -1;
    }

    async function addFiles(listIndex, paths, insertIndex = null) {
        const list = state.lists[listIndex];
        const rows = [];
        for (const file of paths.filter(p => AUDIO_EXT.test(p))) {
            rows.push(await buildAudioRow(file));
        }
        if (!rows.length) return;
        insertRows(listIndex, rows, insertIndex);
    }

    function insertRows(listIndex, rows, insertIndex = null) {
        const list = state.lists[listIndex];
        const safeRows = rows.map(normalizeRow).filter(Boolean);
        if (!safeRows.length) return;
        const refs = captureRowRefs(list);
        const target = insertIndex == null
            ? list.rows.length
            : Math.max(0, Math.min(list.rows.length, Number(insertIndex) || 0));
        list.rows.splice(target, 0, ...safeRows);
        restoreRowRefs(list, refs);
        if (list.status === 'stopped' && !isValidRowIndex(list, list.nextIndex)) list.nextIndex = list.rows.length ? 0 : -1;
        saveState();
        renderAll();
    }

    async function openOneFile(listIndex) {
        const file = await ipcRenderer.invoke('dialog:openFile');
        if (file) await addFiles(listIndex, [file], getCommandInsertIndex(listIndex));
    }

    async function addFolder(listIndex, recursive = false) {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (!folder) return;
        await addFiles(listIndex, listAudioFiles(folder, recursive), getCommandInsertIndex(listIndex));
    }

    async function addRandomFolder(listIndex) {
        const folder = await ipcRenderer.invoke('dialog:selectFolder');
        if (!folder) return;
        insertRows(listIndex, [{ ruta: folder, titulo: `[Aleatorio] ${path.basename(folder)}`, duracion: 0, type: 'random', target: null }], getCommandInsertIndex(listIndex));
    }

    async function openPlaylist(listIndex) {
        const file = await ipcRenderer.invoke('dialog:openPlaylist');
        if (!file) return;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const rows = extractRows(data).map(normalizeRow).filter(Boolean);
            state.lists[listIndex].rows = rows;
            state.lists[listIndex].currentPath = file;
            state.lists[listIndex].selectedIndex = -1;
            state.lists[listIndex].selectedIndices = [];
            state.lists[listIndex].selectionAnchor = -1;
            state.lists[listIndex].nextIndex = rows.length ? 0 : -1;
            saveState();
            renderAll();
        } catch (_) { }
    }

    async function savePlaylist(listIndex) {
        const list = state.lists[listIndex];
        const target = await ipcRenderer.invoke('dialog:savePlaylist', list.currentPath || `${list.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}.LFPlay`);
        if (!target) return;
        fs.writeFileSync(target, JSON.stringify(list.rows, null, 2), 'utf-8');
        list.currentPath = target;
        saveState();
    }

    function extractRows(data) {
        if (Array.isArray(data)) return data;
        for (const key of ['tracks', 'items', 'playlist', 'rows', 'pistas', 'canciones']) {
            if (Array.isArray(data?.[key])) return data[key];
        }
        if (Array.isArray(data?.playlists)) return data.playlists.flatMap(extractRows);
        return [];
    }

    function clearList(listIndex) {
        state.lists[listIndex].rows = [];
        state.lists[listIndex].currentIndex = -1;
        state.lists[listIndex].selectedIndex = -1;
        state.lists[listIndex].selectedIndices = [];
        state.lists[listIndex].selectionAnchor = -1;
        state.lists[listIndex].nextIndex = -1;
        state.lists[listIndex].currentPath = '';
        saveState();
        renderAll();
    }

    function addCommand(listIndex, type, target = null, title = '', extra = {}) {
        const labels = {
            stop: 'Stop',
            note: 'Nota',
            time: 'Locucion de hora',
            temperature: 'Locucion de temperatura',
            humidity: 'Locucion de humedad',
            execute_event: `Ejecutar evento: ${extra.eventName || title || 'Evento'}`,
            main_resume: 'Retomar playlist principal',
            main_jump: `Saltar a Playlist ${Number(target) + 1}`,
            aux_jump: `Saltar a Auxiliar ${Number(target) + 1}`
        };
        const markerPath = {
            time: 'time_locution',
            temperature: 'temperature_locution',
            humidity: 'humidity_locution',
            execute_event: extra.eventId || 'playlist_execute_event'
        }[type] || '';
        insertRows(listIndex, [{
            ruta: markerPath,
            titulo: title || labels[type] || type,
            duracion: ['time', 'temperature', 'humidity'].includes(type) ? 5 : 0,
            type,
            target,
            eventId: extra.eventId || '',
            eventName: extra.eventName || ''
        }], getCommandInsertIndex(listIndex));
    }

    function shuffleList(listIndex) {
        const rows = state.lists[listIndex].rows;
        for (let i = rows.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        saveState();
        renderAll();
    }

    function deleteSelected(listIndex) {
        const list = state.lists[listIndex];
        const selected = getSelectedIndices(list);
        if (!selected.length) return;
        const refs = captureRowRefs(list);
        selected.sort((a, b) => b - a).forEach(index => list.rows.splice(index, 1));
        restoreRowRefs(list, refs);
        list.selectedIndex = -1;
        list.selectedIndices = [];
        list.selectionAnchor = -1;
        if (list.status === 'stopped' && !isValidRowIndex(list, list.nextIndex)) list.nextIndex = list.rows.length ? 0 : -1;
        saveState();
        renderAll();
    }

    function setSelectedAsNext(listIndex) {
        const list = state.lists[listIndex];
        const selected = getSelectedIndices(list);
        const target = selected.find(index => index !== list.currentIndex);
        if (!isValidRowIndex(list, target)) return;
        list.nextIndex = target;
        list.manualDeferredIndex = getPlaybackMode(listIndex) === 'manual' && list.status === 'playing' ? target : -1;
        rescheduleCurrentAutoAdvance(listIndex);
        saveState();
        renderAll();
    }

    function toggleSelectedTemporal(listIndex) {
        const list = state.lists[listIndex];
        getSelectedIndices(list).forEach(index => {
            if (list.rows[index]) list.rows[index].temp = !list.rows[index].temp;
        });
        saveState();
        renderAll();
    }

    function clearPlayedRows(listIndex) {
        const list = state.lists[listIndex];
        const boundary = isValidRowIndex(list, list.currentIndex)
            ? list.currentIndex
            : (isValidRowIndex(list, list.nextIndex) ? list.nextIndex : -1);
        if (boundary <= 0) return;
        const refs = captureRowRefs(list);
        list.rows.splice(0, boundary);
        restoreRowRefs(list, refs);
        list.selectedIndices = [];
        list.selectedIndex = -1;
        list.selectionAnchor = -1;
        saveState();
        renderAll();
    }

    function checkBrokenLinks(listIndex) {
        const list = state.lists[listIndex];
        const refs = captureRowRefs(list);
        list.rows = list.rows.filter(row => {
            if (row === refs.current) return true;
            if (!row.ruta || ['note', 'stop', 'main_resume', 'main_jump', 'aux_jump', 'time', 'temperature', 'humidity', 'execute_event'].includes(row.type)) return true;
            try { return fs.existsSync(row.ruta); } catch (_) { return false; }
        });
        restoreRowRefs(list, refs);
        list.selectedIndices = [];
        list.selectedIndex = -1;
        list.selectionAnchor = -1;
        if (list.status === 'stopped' && !isValidRowIndex(list, list.nextIndex)) list.nextIndex = list.rows.length ? 0 : -1;
        saveState();
        renderAll();
    }

    function cloneRowForClipboard(row) {
        return row ? { ...row } : null;
    }

    function copySelected(listIndex, action = 'copy') {
        const list = state.lists[listIndex];
        const rows = getSelectedIndices(list).map(index => cloneRowForClipboard(list.rows[index])).filter(Boolean);
        if (!rows.length) return;
        auxClipboard = rows;
        auxClipboardAction = action;
        if (action === 'cut') deleteSelected(listIndex);
    }

    function pasteClipboard(listIndex, insertIndex = null) {
        if (!auxClipboard.length) return;
        const list = state.lists[listIndex];
        const target = insertIndex == null
            ? (isValidRowIndex(list, list.selectedIndex) ? list.selectedIndex + 1 : list.rows.length)
            : Math.max(0, Math.min(list.rows.length, Number(insertIndex) || 0));
        const refs = captureRowRefs(list);
        const rows = auxClipboard.map(cloneRowForClipboard).filter(Boolean);
        list.rows.splice(target, 0, ...rows);
        restoreRowRefs(list, refs);
        list.selectedIndex = target;
        if (list.status === 'stopped' && !isValidRowIndex(list, list.nextIndex)) list.nextIndex = list.rows.length ? 0 : -1;
        if (auxClipboardAction === 'cut') {
            auxClipboard = [];
            auxClipboardAction = null;
        }
        saveState();
        renderAll();
    }

    function moveRow(sourceListIndex, sourceIndex, targetListIndex, insertIndex) {
        const sourceList = state.lists[sourceListIndex];
        const targetList = state.lists[targetListIndex];
        if (!sourceList || !targetList) return;
        if (sourceIndex < 0 || sourceIndex >= sourceList.rows.length) return;
        const sourceRefs = captureRowRefs(sourceList);
        const targetRefs = sourceList === targetList ? sourceRefs : captureRowRefs(targetList);
        const [row] = sourceList.rows.splice(sourceIndex, 1);
        let target = Math.max(0, Math.min(targetList.rows.length, Number(insertIndex) || 0));
        if (sourceList === targetList && sourceIndex < target) target -= 1;
        targetList.rows.splice(target, 0, row);
        restoreRowRefs(sourceList, sourceRefs);
        restoreRowRefs(targetList, targetRefs);
        targetList.selectedIndex = target;
        saveState();
        renderAll();
    }

    function getDropInsertIndex(event, box) {
        const rows = Array.from(box.querySelectorAll('tbody tr'));
        const row = event.target?.closest?.('tr');
        if (!row || !rows.includes(row)) return state.lists[Number(box.dataset.auxList) || 0].rows.length;
        const idx = rows.indexOf(row);
        const rect = row.getBoundingClientRect();
        return event.clientY > rect.top + rect.height / 2 ? idx + 1 : idx;
    }

    function getSelectedRow(listIndex) {
        const list = state.lists[listIndex];
        return isValidRowIndex(list, list.selectedIndex) ? list.rows[list.selectedIndex] : null;
    }

    function getCommandInsertIndex(listIndex) {
        const list = state.lists[listIndex];
        const selected = getSelectedIndices(list);
        if (!selected.length) return list.rows.length;
        return Math.min(list.rows.length, selected[selected.length - 1] + 1);
    }

    function getNormalRowPath(row) {
        return row && row.type === 'normal' ? row.ruta || '' : '';
    }

    function getNextNormalRow(list, index) {
        for (let i = index + 1; i < list.rows.length; i++) {
            if (list.rows[i]?.type === 'normal' && list.rows[i].ruta) return list.rows[i];
        }
        return null;
    }

    function getPrevNormalRow(list, index) {
        for (let i = index - 1; i >= 0; i--) {
            if (list.rows[i]?.type === 'normal' && list.rows[i].ruta) return list.rows[i];
        }
        return null;
    }

    function prepareMenu(anchor) {
        if (!menuEl) menuEl = document.createElement('div');
        menuAnchor = anchor;
        menuEl.className = 'aux-menu';
        menuEl.innerHTML = '';
        document.body.appendChild(menuEl);
    }

    function addMenuItem(parent, label, action, className = '') {
        const item = document.createElement('div');
        item.className = `aux-menu-item ${className}`.trim();
        item.innerHTML = label;
        item.addEventListener('click', e => {
            e.stopPropagation();
            if (item.classList.contains('disabled')) return;
            hideMenu();
            action();
        });
        parent.appendChild(item);
        return item;
    }

    function iconLabel(icon, text) {
        return `${icon ? `${icon} ` : ''}${escapeHtml(text)}`;
    }

    function addMenuSeparator(parent) {
        const el = document.createElement('div');
        el.className = 'aux-menu-separator';
        parent.appendChild(el);
    }

    function addSubmenu(parent, label, builder) {
        const item = document.createElement('div');
        item.className = 'aux-menu-item aux-has-submenu';
        item.innerHTML = `<span>${label}</span><span class="aux-submenu-arrow">&gt;</span>`;
        const submenu = document.createElement('div');
        submenu.className = 'aux-submenu';
        builder(submenu);
        item.appendChild(submenu);
        parent.appendChild(item);
        return item;
    }

    function finishMenuPosition(anchorOrPosition) {
        menuEl.style.display = 'block';
        menuEl.style.left = '0px';
        menuEl.style.top = '0px';
        menuEl.querySelectorAll('.aux-has-submenu').forEach(item => {
            item.addEventListener('mouseenter', () => positionAuxSubmenu(item));
            item.addEventListener('click', e => {
                e.stopPropagation();
                item.classList.toggle('pinned');
                positionAuxSubmenu(item);
            });
        });
        const rect = anchorOrPosition && Number.isFinite(anchorOrPosition.x)
            ? { left: anchorOrPosition.x, right: anchorOrPosition.x, top: anchorOrPosition.y, bottom: anchorOrPosition.y }
            : anchorOrPosition.getBoundingClientRect();
        const menuRect = menuEl.getBoundingClientRect();
        const margin = 8;
        const left = Math.max(margin, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - margin));
        let top = rect.bottom + 4;
        if (top + menuRect.height > window.innerHeight - margin) {
            top = Math.max(margin, rect.top - menuRect.height - 4);
        }
        menuEl.style.left = `${left}px`;
        menuEl.style.top = `${top}px`;
    }

    function showCommandsMenu(button, listIndex) {
        if (menuEl && menuEl.style.display === 'block' && menuAnchor === button) {
            hideMenu();
            return;
        }
        prepareMenu(button);
        addSubmenu(menuEl, 'Modo de reproducci\u00f3n', submenu => {
            const mode = getPlaybackMode(listIndex);
            [
                ['normal', 'Normal'],
                ['random', 'Aleatorio'],
                ['manual', 'Manual'],
                ['infinite', 'Infinito']
            ].forEach(([value, label]) => {
                addMenuItem(submenu, `${mode === value ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} ${label}`, () => setAuxPlaybackMode(listIndex, value));
            });
        });
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('🎵', 'A\u00f1adir pistas...'), () => openOneFile(listIndex));
        addMenuItem(menuEl, iconLabel('📁', 'A\u00f1adir carpeta normal...'), () => addFolder(listIndex, false));
        addMenuItem(menuEl, iconLabel('🔀', 'A\u00f1adir carpeta aleatoria...'), () => addRandomFolder(listIndex));
        addMenuItem(menuEl, iconLabel('📅', 'Ejecutar evento...'), async () => {
            const eventObj = await window.lfMainPlaylistApi?.requestEventSelection?.();
            if (!eventObj) return;
            addCommand(listIndex, 'execute_event', null, `Ejecutar evento: ${eventObj.name || eventObj.eventName || 'Evento'}`, {
                eventId: eventObj.id || eventObj.eventId || '',
                eventName: eventObj.name || eventObj.eventName || ''
            });
        }, window.lfMainPlaylistApi?.requestEventSelection ? '' : 'disabled');
        addMenuItem(menuEl, iconLabel('⏱️', 'A\u00f1adir locuci\u00f3n de hora'), () => addCommand(listIndex, 'time'));
        addMenuItem(menuEl, iconLabel('🌡️', 'A\u00f1adir locuci\u00f3n de temperatura'), () => addCommand(listIndex, 'temperature'));
        addMenuItem(menuEl, iconLabel('💧', 'A\u00f1adir locuci\u00f3n de humedad'), () => addCommand(listIndex, 'humidity'));
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('⏹', 'A\u00f1adir stop'), () => addCommand(listIndex, 'stop'));
        addSubmenu(menuEl, iconLabel('⏭️', 'Reproducir siguiente playlist'), submenu => {
            for (let i = 0; i < 4; i++) addMenuItem(submenu, `Playlist ${i + 1}`, () => addCommand(listIndex, 'main_jump', i));
            const otherAux = listIndex === 0 ? 1 : 0;
            addMenuItem(submenu, `Auxiliar ${otherAux + 1}`, () => addCommand(listIndex, 'aux_jump', otherAux));
            addMenuItem(submenu, 'Retomar playlist principal', () => addCommand(listIndex, 'main_resume'));
        });
        addMenuItem(menuEl, iconLabel('📝', 'A\u00f1adir Nota'), async () => {
            const text = window.prompt('Nota') || 'Nota';
            addCommand(listIndex, 'note', null, text);
        });
        addMenuItem(menuEl, iconLabel('📻', 'Agregar URL de emisora... (Beta)'), () => {
            const text = window.prompt('URL de emisora') || '';
            if (text.trim()) addCommand(listIndex, 'note', null, `URL: ${text.trim()}`);
        });
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('🎯', 'Marcar como Siguiente'), () => setSelectedAsNext(listIndex));
        addMenuItem(menuEl, iconLabel('⏳', 'Marcar / Desmarcar como Temporal'), () => toggleSelectedTemporal(listIndex));
        addMenuItem(menuEl, iconLabel('🔀', 'Mezclar lista'), () => shuffleList(listIndex));
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('🧹', 'Limpiar pistas reproducidas'), () => clearPlayedRows(listIndex));
        addMenuItem(menuEl, iconLabel('🔗', 'Comprobar enlaces rotos'), () => checkBrokenLinks(listIndex));
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('❌', 'Eliminar seleccionadas'), () => deleteSelected(listIndex), 'danger');
        addMenuItem(menuEl, iconLabel('🗑️', 'Vaciar toda la lista'), () => clearList(listIndex), 'danger');
        finishMenuPosition(button);
    }

    function showRowContextMenu(rowEl, listIndex, position) {
        const list = state.lists[listIndex];
        const row = getSelectedRow(listIndex);
        const selectedIndex = list.selectedIndex;
        const filePath = getNormalRowPath(row);
        const assignableTypePath = row && ['normal', 'random'].includes(row.type) ? row.ruta || '' : '';
        prepareMenu(rowEl);
        if (row?.type === 'stream') addMenuItem(menuEl, iconLabel('📡', 'Editar emisora... (Beta)'), () => {});
        addMenuItem(menuEl, iconLabel('🔊', 'Escucha previa'), () => {
            if (filePath) ipcRenderer.send('open-preview', filePath);
        });
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, 'Cortar', () => copySelected(listIndex, 'cut'));
        addMenuItem(menuEl, 'Copiar', () => copySelected(listIndex, 'copy'));
        addMenuItem(menuEl, 'Pegar', () => pasteClipboard(listIndex, isValidRowIndex(list, selectedIndex) ? selectedIndex + 1 : null));
        addMenuSeparator(menuEl);
        addSubmenu(menuEl, 'Herramientas', submenu => {
        addMenuItem(submenu, iconLabel('🎧', 'Editor de Pistas Avanzado'), () => {
                if (filePath) ipcRenderer.send('open-audio-editor', filePath);
            }, 'accent-blue');
            addMenuItem(submenu, iconLabel('🔀', 'Editar Transición Musical'), () => {}, 'accent-green disabled');
            addMenuItem(submenu, iconLabel('🎙️', 'Editar Cruce con Pisador'), () => {}, 'accent-orange disabled');
            addMenuItem(submenu, 'Pisadores automaticos...', () => {}, 'accent-purple disabled');
            addMenuSeparator(submenu);
            addMenuItem(submenu, 'Editar archivo y metadatos...', () => {
                if (filePath) ipcRenderer.send('open-file-metadata-editor', filePath);
            });
            addMenuItem(submenu, 'Mostrar en carpeta', async () => {
                if (filePath) await ipcRenderer.invoke('file:show-in-folder', filePath);
            });
            addSubmenu(submenu, 'Establecer tipo de archivo', typeMenu => {
                const explicitTypes = getExplicitTypes();
                const explicitId = assignableTypePath ? explicitTypes[assignableTypePath] : null;
                const defaultItem = addMenuItem(typeMenu, `${explicitId ? '&nbsp;&nbsp;&nbsp;' : '✓ '} Música (Por defecto)`, () => {
                    if (!assignableTypePath) return;
                    const nextTypes = getExplicitTypes();
                    delete nextTypes[assignableTypePath];
                    saveExplicitTypes(nextTypes);
                    if (row) row.fileType = null;
                    saveState();
                    renderAll();
                });
                defaultItem.style.color = '#e0e0e0';
                addMenuSeparator(typeMenu);
                getFileTypes().forEach(type => {
                    const isChecked = explicitId === type.id;
                    const item = addMenuItem(typeMenu, `${isChecked ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} ${escapeHtml(type.name || type.id)}`, () => {
                        if (!assignableTypePath || !row) return;
                        const nextTypes = getExplicitTypes();
                        nextTypes[assignableTypePath] = type.id;
                        saveExplicitTypes(nextTypes);
                        row.fileType = type.id;
                        saveState();
                        renderAll();
                    });
                    item.style.color = type.color || '';
                });
            });
        });
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('⏳', 'Marcar / Desmarcar Temporal'), () => {
            if (!row) return;
            row.temp = !row.temp;
            saveState();
            renderAll();
        });
        addMenuItem(menuEl, iconLabel('🔀', 'Mezclar lista'), () => shuffleList(listIndex));
        addMenuItem(menuEl, 'Agregar como siguiente', () => {
            if (isValidRowIndex(list, selectedIndex) && selectedIndex !== list.currentIndex) {
                list.nextIndex = selectedIndex;
                list.manualDeferredIndex = getPlaybackMode(listIndex) === 'manual' && list.status === 'playing' ? selectedIndex : -1;
                rescheduleCurrentAutoAdvance(listIndex);
                saveState();
                renderAll();
            }
        });
        addMenuSeparator(menuEl);
        addMenuItem(menuEl, iconLabel('🗑️', 'Borrar toda la lista'), () => clearList(listIndex));
        addMenuItem(menuEl, iconLabel('❌', 'Borrar cancion actual'), () => deleteSelected(listIndex), 'danger');
        finishMenuPosition(position || rowEl);
    }

    function positionAuxSubmenu(item) {
        const submenu = item.querySelector('.aux-submenu');
        if (!submenu) return;
        submenu.style.visibility = 'hidden';
        submenu.style.display = 'block';
        const rect = item.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();
        if (rect.right + subRect.width > window.innerWidth - 8) {
            submenu.style.left = 'auto';
            submenu.style.right = '100%';
        } else {
            submenu.style.left = '100%';
            submenu.style.right = 'auto';
        }
        if (rect.top + subRect.height > window.innerHeight - 8) {
            submenu.style.top = 'auto';
            submenu.style.bottom = '0';
        } else {
            submenu.style.top = '0';
            submenu.style.bottom = 'auto';
        }
        submenu.style.display = '';
        submenu.style.visibility = '';
    }

    function hideMenu() {
        if (menuEl) menuEl.style.display = 'none';
        menuAnchor = null;
    }

    function clearListSelection(listIndex) {
        const list = state.lists[listIndex];
        if (!list || (list.selectedIndex < 0 && !getSelectedIndices(list).length)) return false;
        list.selectedIndex = -1;
        list.selectedIndices = [];
        list.selectionAnchor = -1;
        saveState();
        renderAll();
        return true;
    }

    function clearAllSelections() {
        let changed = false;
        state.lists.forEach(list => {
            if (list.selectedIndex >= 0 || getSelectedIndices(list).length) {
                list.selectedIndex = -1;
                list.selectedIndices = [];
                list.selectionAnchor = -1;
                changed = true;
            }
        });
        if (changed) {
            saveState();
            renderAll();
        }
    }

    function renderAll() {
        roots.forEach(root => renderRoot(root));
    }

    function renderRoot(root) {
        const content = root.querySelector('[data-aux-content]');
        if (!content) return;
        content.classList.toggle('layout-side', state.settings.layout === 'side');
        content.classList.toggle('layout-stacked', state.settings.layout !== 'side');
        const layoutBtn = root.querySelector('[data-aux-action="layout"]');
        if (layoutBtn) layoutBtn.classList.toggle('is-active', state.settings.layout === 'side');
        for (let i = 0; i < 2; i++) {
            const visible = state.settings.visibleLists[i] !== false;
            root.querySelector(`[data-aux-toggle="${i}"]`)?.classList.toggle('is-active', visible);
            root.querySelector(`[data-aux-list="${i}"]`)?.classList.toggle('is-hidden', !visible);
        }
        for (let i = 0; i < 2; i++) renderList(root, i);
    }

    function renderList(root, listIndex) {
        const list = state.lists[listIndex];
        const box = root.querySelector(`[data-aux-list="${listIndex}"]`);
        if (!box) return;
        const name = box.querySelector('.aux-name');
        if (name && document.activeElement !== name) name.value = list.name;
        const tbody = box.querySelector('tbody');
        tbody.innerHTML = '';
        const visualNextIndex = getVisualNextIndex(listIndex);
        const manualDeferredIndex = getManualDeferredVisualIndex(listIndex);
        list.rows.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.draggable = true;
            tr.dataset.index = String(idx);
            const isActive = idx === list.currentIndex && ['playing', 'paused'].includes(list.status);
            const isNext = idx === visualNextIndex && idx !== list.currentIndex;
            const isManualDeferred = idx === manualDeferredIndex && idx !== list.currentIndex;
            const isSelected = getSelectedIndices(list).includes(idx) && !isActive && !isNext && !isManualDeferred;
            tr.className = [
                isSelected ? 'selected' : '',
                isActive ? 'row-active' : '',
                isNext ? 'row-next' : '',
                isManualDeferred ? 'row-manual-next' : ''
            ].filter(Boolean).join(' ');
            if (!isSelected && !isActive && !isNext && !isManualDeferred) tr.style.color = getAuxRowColor(row);
            const displayTitle = `${row.temp ? '\u23f3 ' : ''}${row.titulo}`;
            tr.innerHTML = `<td title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</td><td class="aux-duration-col">${row.type === 'normal' ? formatTime(row.duracion) : '--:--'}</td>`;
            tr.addEventListener('click', event => {
                selectRowWithEvent(list, idx, event);
                saveState();
                renderAll();
            });
            tr.addEventListener('dblclick', () => {
                setSingleSelection(list, idx);
                if (idx !== list.currentIndex) list.nextIndex = idx;
                list.manualDeferredIndex = getPlaybackMode(listIndex) === 'manual' && list.status === 'playing' && idx !== list.currentIndex ? idx : -1;
                rescheduleCurrentAutoAdvance(listIndex);
                saveState();
                renderAll();
            });
            tr.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                if (!getSelectedIndices(list).includes(idx)) setSingleSelection(list, idx);
                saveState();
                renderAll();
                showRowContextMenu(tr, listIndex, { x: e.clientX, y: e.clientY });
            });
            tr.addEventListener('dragstart', e => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-lf-aux-row', JSON.stringify({ listIndex, index: idx }));
                e.dataTransfer.setData('text/plain', row.ruta || row.titulo || '');
                tr.classList.add('aux-dragging');
            });
            tr.addEventListener('dragend', () => {
                tr.classList.remove('aux-dragging');
                root.querySelectorAll('tr.aux-drop-before, tr.aux-drop-after').forEach(el => el.classList.remove('aux-drop-before', 'aux-drop-after'));
            });
            tbody.appendChild(tr);
        });
        const total = list.rows.reduce((sum, row) => sum + (row.type === 'normal' ? Number(row.duracion) || 0 : 0), 0);
        const totalEl = box.querySelector('.aux-total');
        if (totalEl) totalEl.textContent = `Total ${formatTime(total)}`;
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function buildRoot(container, floating = false) {
        container.classList.add('aux-panel');
        if (floating) container.classList.add('is-floating');
        container.innerHTML = `
            <div class="aux-header">
                <span class="aux-title">Playlists auxiliares</span>
                <button class="aux-toggle" data-aux-toggle="0" title="Mostrar Auxiliar 1">1</button>
                <button class="aux-toggle" data-aux-toggle="1" title="Mostrar Auxiliar 2">2</button>
                <button class="aux-icon-btn" data-aux-action="layout" title="Alternar vertical/horizontal">&#8646;</button>
                ${floating ? '<button class="aux-icon-btn" data-aux-action="dock" title="Acoplar">&#9166;</button>' : '<button class="aux-icon-btn" data-aux-action="undock" title="Desacoplar">&#8599;</button>'}
                <button class="aux-icon-btn" data-aux-action="hide" title="Ocultar">X</button>
            </div>
            <div class="aux-content" data-aux-content>
                ${[0, 1].map(i => `
                    <section class="aux-list" data-aux-list="${i}">
                        <div class="aux-list-header">
                            <input class="aux-name" maxlength="40" value="${escapeHtml(state.lists[i].name)}">
                            <button class="aux-icon-btn" data-list-action="clear" title="Limpiar">&#128196;</button>
                            <button class="aux-icon-btn" data-list-action="open" title="Abrir playlist">&#128193;</button>
                            <button class="aux-icon-btn" data-list-action="save" title="Guardar playlist">&#128190;</button>
                            <button class="aux-icon-btn" data-list-action="commands" title="Comandos">&#9776;</button>
                        </div>
                        <div class="aux-table-wrap">
                            <table class="aux-table">
                                <thead><tr><th>Titulo</th><th class="aux-duration-col">Duracion</th></tr></thead>
                                <tbody></tbody>
                            </table>
                        </div>
                        <div class="aux-footer">
                            <div class="aux-transport">
                                <button class="aux-icon-btn" data-list-action="play" title="Play">&#9654;</button>
                                <button class="aux-icon-btn" data-list-action="pause" title="Pausa">&#10074;&#10074;</button>
                                <button class="aux-icon-btn" data-list-action="stop" title="Stop">&#9632;</button>
                                <button class="aux-icon-btn" data-list-action="next" title="Siguiente">&#9197;</button>
                            </div>
                            <span class="aux-total">Total 00:00</span>
                        </div>
                    </section>
                `).join('')}
            </div>
        `;
        bindRoot(container, floating);
        roots.push(container);
        renderRoot(container);
    }

    function bindRoot(root, floating) {
        root.querySelector('[data-aux-action="layout"]')?.addEventListener('click', () => {
            state.settings.layout = state.settings.layout === 'side' ? 'stacked' : 'side';
            saveState();
            renderAll();
        });
        root.querySelector('[data-aux-action="undock"]')?.addEventListener('click', () => ipcRenderer.send('open-auxiliary-window'));
        root.querySelector('[data-aux-action="dock"]')?.addEventListener('click', () => ipcRenderer.send('auxiliary-dock'));
        root.querySelector('[data-aux-action="hide"]')?.addEventListener('click', () => ipcRenderer.send('auxiliary-hide'));
        for (let i = 0; i < 2; i++) {
            root.querySelector(`[data-aux-toggle="${i}"]`)?.addEventListener('click', () => {
                const nextVisible = state.settings.visibleLists.slice(0, 2);
                nextVisible[i] = !nextVisible[i];
                if (!nextVisible[0] && !nextVisible[1]) nextVisible[i] = true;
                state.settings.visibleLists = nextVisible;
                saveState();
                renderAll();
            });
        }
        for (let i = 0; i < 2; i++) {
            const box = root.querySelector(`[data-aux-list="${i}"]`);
            const name = box.querySelector('.aux-name');
            name.addEventListener('change', () => {
                state.lists[i].name = name.value.trim() || `Auxiliar ${i + 1}`;
                saveState();
                renderAll();
            });
            box.querySelector('[data-list-action="clear"]').addEventListener('click', () => clearList(i));
            box.querySelector('[data-list-action="open"]').addEventListener('click', () => openPlaylist(i));
            box.querySelector('[data-list-action="save"]').addEventListener('click', () => savePlaylist(i));
            box.querySelector('[data-list-action="commands"]').addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                showCommandsMenu(e.currentTarget, i);
            });
            box.querySelector('[data-list-action="play"]').addEventListener('click', () => playList(i));
            box.querySelector('[data-list-action="pause"]').addEventListener('click', () => pauseList(i));
            box.querySelector('[data-list-action="stop"]').addEventListener('click', () => stopList(i));
            box.querySelector('[data-list-action="next"]').addEventListener('click', () => playNext(i));
            box.querySelector('.aux-table-wrap')?.addEventListener('click', e => {
                if (!e.target.closest('tr')) clearListSelection(i);
            });
            box.addEventListener('dragover', e => {
                e.preventDefault();
                box.classList.add('aux-drop');
                const row = e.target?.closest?.('tr');
                box.querySelectorAll('tr.aux-drop-before, tr.aux-drop-after').forEach(el => el.classList.remove('aux-drop-before', 'aux-drop-after'));
                if (row && box.contains(row)) {
                    const rect = row.getBoundingClientRect();
                    row.classList.add(e.clientY > rect.top + rect.height / 2 ? 'aux-drop-after' : 'aux-drop-before');
                }
            });
            box.addEventListener('dragleave', () => {
                box.classList.remove('aux-drop');
                box.querySelectorAll('tr.aux-drop-before, tr.aux-drop-after').forEach(el => el.classList.remove('aux-drop-before', 'aux-drop-after'));
            });
            box.addEventListener('drop', async e => {
                e.preventDefault();
                box.classList.remove('aux-drop');
                box.querySelectorAll('tr.aux-drop-before, tr.aux-drop-after').forEach(el => el.classList.remove('aux-drop-before', 'aux-drop-after'));
                const insertIndex = getDropInsertIndex(e, box);
                const internal = e.dataTransfer?.getData('application/x-lf-aux-row');
                if (internal) {
                    try {
                        const data = JSON.parse(internal);
                        moveRow(Number(data.listIndex), Number(data.index), i, insertIndex);
                    } catch (_) { }
                    return;
                }
                const playlistRowsRaw = e.dataTransfer?.getData('application/x-lf-playlist-rows');
                if (playlistRowsRaw) {
                    try {
                        const rows = JSON.parse(playlistRowsRaw).map(normalizePlaylistDropRow).filter(Boolean);
                        insertRows(i, rows, insertIndex);
                    } catch (_) { }
                    return;
                }
                const paths = [];
                if (e.dataTransfer?.files?.length) {
                    for (const file of Array.from(e.dataTransfer.files)) {
                        const p = webUtils?.getPathForFile ? webUtils.getPathForFile(file) : file.path;
                        if (p) paths.push(p);
                    }
                } else {
                    const text = e.dataTransfer?.getData('text/plain');
                    if (text) paths.push(text);
                }
                const expanded = [];
                paths.forEach(p => {
                    try {
                        if (fs.statSync(p).isDirectory()) expanded.push(...listAudioFiles(p, false));
                        else expanded.push(p);
                    } catch (_) { }
                });
                await addFiles(i, expanded, insertIndex);
            });
        }
        if (floating) {
            window.addEventListener('beforeunload', saveState);
        }
    }

    function pollStatus() {
        rust({ cmd: 'status', silent: true }).then(result => {
            const players = result?.message?.players || result?.status?.players || [];
            if (!Array.isArray(players)) return;
            let changed = false;
            for (let i = 0; i < 2; i++) {
                const list = state.lists[i];
                if (list.status !== 'playing') continue;
                const p = players.find(item => item.id === playerId(i, list.deck));
                if (p && (p.status === 'ended' || p.status === 'stopped')) {
                    changed = true;
                    playNext(i);
                }
            }
            if (changed) renderAll();
        });
    }

    document.addEventListener('click', e => {
        if (menuEl && !menuEl.contains(e.target)) hideMenu();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            hideMenu();
            clearAllSelections();
        } else if (e.key === 'Delete') {
            const tag = String(document.activeElement?.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select'].includes(tag)) return;
            const targets = state.lists.map((list, index) => getSelectedIndices(list).length ? index : -1).filter(index => index >= 0);
            if (!targets.length) return;
            e.preventDefault();
            targets.forEach(deleteSelected);
        }
    });

    ipcRenderer.on('auxiliary-main-resume', () => requestMainResume());
    ipcRenderer.on('auxiliary-main-jump', (_e, index) => requestMainJump(index));
    ipcRenderer.on('audio-engine-rust-event', (_e, message = {}) => {
        if (message.type !== 'timeLocutionEnded') return;
        const player = String(message.player || '');
        for (let i = 0; i < 2; i++) {
            const list = state.lists[i];
            if (list.status !== 'playing' || list.rows[list.currentIndex]?.type !== 'time') continue;
            if (player && player !== playerId(i, list.deck)) continue;
            playNext(i);
        }
    });
    ipcRenderer.on('settings-updated', () => {
        prefsCache = normalizeAudioPrefs(readJson(prefsPath, prefsCache));
    });

    window.initAuxiliaryPlaylists = function initAuxiliaryPlaylists(container, options = {}) {
        if (!container) return;
        buildRoot(container, options.floating === true);
        if (!statusTimer) statusTimer = setInterval(pollStatus, 700);
    };
})();
