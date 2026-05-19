const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { ipcRenderer, webUtils } = require('electron');
const { normalizeAudioPrefs } = require('./audio_prefs');
const { AudioEngineClient, WebAudioEngineAdapter, RustAudioEngineAdapter } = require('./audio_engine_client');

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
    e.preventDefault();
    try { clearPlaylistDragState(); } catch (err) { }
});

function getPathFromDroppedFile(file) {
    if (!file) return '';
    try {
        if (webUtils?.getPathForFile) return webUtils.getPathForFile(file) || '';
    } catch (err) { }
    return file.path || '';
}

function getDroppedFilePaths(dataTransfer) {
    if (!dataTransfer?.files || dataTransfer.files.length === 0) return [];
    return Array.from(dataTransfer.files).map(getPathFromDroppedFile).filter(Boolean);
}

const nextTick = () => new Promise(resolve => requestAnimationFrame(resolve));

async function* walkAudioFilesAsync(dir) {
    try {
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                yield* walkAudioFilesAsync(fullPath);
            } else if (file.isFile() && isSupportedAudioName(file.name)) {
                yield fullPath;
            }
        }
    } catch (err) {
        console.error(`Error walking directory ${dir}:`, err);
    }
}

const configDir = path.join(__dirname, '..', 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

const uiPrefsPath = path.join(configDir, 'ui_prefs.json');
const fxPrefsPath = path.join(configDir, 'fx_prefs.json');
const generalPrefsPath = path.join(configDir, 'general_settings.json');
const encoderPrefsPath = path.join(configDir, 'encoder_prefs.json');
const fileTypesPath = path.join(configDir, 'file_types.json');
const clockwheelPrefsPath = path.join(configDir, 'clockwheel_prefs.json');
const sessionStatePath = path.join(configDir, 'session_state.json');
const SESSION_AUTOSAVE_MS = 3000;
const PLAYBACK_GUARD_INTERVAL_MS = 1000;
const PLAYBACK_GUARD_STALL_MS = 9000;
const PLAYBACK_GUARD_PAUSE_MS = 3000;
const PLAYBACK_GUARD_COOLDOWN_MS = 6000;
const PLAYBACK_GUARD_SILENCE_THRESHOLD = 1.5;
const TRACK_LOAD_TIMEOUT_MS = 12000;
const RUST_MIRROR_SEEK_DEBOUNCE_MS = 2000;
const PREANALYSIS_BATCH_DELAY_MS = 900;
const RANDOM_WARM_LOOKAHEAD_ROWS = 12;
const RANDOM_FOLDER_CACHE_TTL_MS = 60000;
const TIME_UI_FRAME_INTERVAL_MS = 50;
const VU_IPC_INTERVAL_MS = 20;
const VU_DIAGNOSTICS_IPC_INTERVAL_MS = 1000;
// RUST_LIVE_METER_POLL_MS / RUST_IDLE_STATUS_POLL_MS: retiradas del flujo.
// El motor Rust ahora emite `status` por su propio bucle PushTick (100 ms) y
// el renderer lo recibe vía `audio-engine-rust-event`. Se conservan las
// constantes por si algún fallback de polling on-demand vuelve a necesitarlas.
const RUST_LIVE_METER_POLL_MS = 50;
const RUST_IDLE_STATUS_POLL_MS = 3000;
const IDLE_METADATA_TEXT = 'Esperando...';
const ICON_CLOCK_LABEL = '\u23f0 Locuci\u00f3n de hora';
const ICON_STOP_LABEL = '\u23f9';
const ICON_NOTE_LABEL = '\u{1f4dd}';
const ICON_PLAYLIST_JUMP_LABEL = '\u23ed';
const ICON_EVENT_LABEL = '\u{1f4c5}';
const ICON_TEMP_PREFIX = '\u23f3 ';
const ICON_WARNING_LABEL = '\u26a0\ufe0f';
const ICON_EVENT_DISABLED_LABEL = '\u{1f515}';
const ICON_AIR_PREFIX = '\u25b6 Sonando:';
const ICON_ENCODER_LABEL = '\u{1f4e1}';
const ICON_USER_LABEL = '\u{1f464}';

function loadConfig(filePath, defaultData) {
    if (fs.existsSync(filePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (Array.isArray(defaultData)) return Array.isArray(parsed) ? parsed : defaultData;
            return { ...defaultData, ...parsed };
        } catch (e) { return defaultData; }
    }
    return defaultData;
}

function saveConfig(filePath, data) {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (e) { }
}

function nodeBufferToArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function createDecodeAudioContext() {
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OfflineCtor) {
        try { return new OfflineCtor(1, 2, 44100); } catch (err) { }
    }
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioCtor) {
        try { return new AudioCtor({ latencyHint: 'playback' }); } catch (err) { }
    }
    return null;
}

const waveformDecodeCtx = createDecodeAudioContext();
let waveformRenderToken = 0;
const waveformPeaksByPath = new Map();
const audioDurationCache = new Map();

function parseFiniteCueValue(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getAudioDuration(filePath) {
    if (!filePath) return Promise.resolve(0);
    if (audioDurationCache.has(filePath)) return Promise.resolve(audioDurationCache.get(filePath));
    return new Promise(resolve => {
        const probe = new Audio();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            probe.removeAttribute('src');
            probe.load();
            const duration = Number.isFinite(value) ? value : 0;
            audioDurationCache.set(filePath, duration);
            resolve(duration);
        };
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => finish(probe.duration || 0);
        probe.onerror = () => finish(0);
        probe.src = url.pathToFileURL(filePath).href;
    });
}

function getAudioMimeType(filePath) {
    const ext = String(path.extname(filePath || '')).toLowerCase();
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.flac') return 'audio/flac';
    if (ext === '.ogg') return 'audio/ogg';
    if (ext === '.m4a' || ext === '.aac') return 'audio/mp4';
    return 'application/octet-stream';
}

function getFilePlaybackDiagnostics(filePath) {
    try {
        if (!filePath) return { ok: false, reason: 'ruta vacia' };
        if (!fs.existsSync(filePath)) return { ok: false, reason: 'no existe en disco' };
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return { ok: false, reason: 'la ruta no es archivo' };
        if (!isSupportedAudioName(filePath)) return { ok: false, reason: `extension no compatible ${path.extname(filePath) || '(sin extension)'}` };
        let fd = null;
        try {
            fd = fs.openSync(filePath, 'r');
            const probe = Buffer.alloc(1);
            fs.readSync(fd, probe, 0, 1, 0);
        } catch (readErr) {
            return { ok: false, reason: `Windows no permite leer el archivo (${readErr.message || readErr.code || 'error desconocido'})` };
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (err) { }
            }
        }
        return { ok: true, size: stats.size };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

function buildMainWaveformPeaks(audioBuffer) {
    const rawData = audioBuffer.getChannelData(0);
    const targetBins = Math.max(2048, Math.min(60000, Math.ceil(audioBuffer.duration * 120)));
    const samplesPerBin = Math.max(1, Math.ceil(rawData.length / targetBins));
    const bins = Math.ceil(rawData.length / samplesPerBin);
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
        const start = bin * samplesPerBin;
        const end = Math.min(rawData.length, start + samplesPerBin);
        let binMin = 1;
        let binMax = -1;
        for (let i = start; i < end; i++) {
            const datum = rawData[i];
            if (datum < binMin) binMin = datum;
            if (datum > binMax) binMax = datum;
        }
        min[bin] = binMin;
        max[bin] = binMax;
    }
    return { min, max, bins, duration: audioBuffer.duration };
}

function normalizeMainWaveformPeaks(peaks) {
    if (!peaks || !Array.isArray(peaks.min) || !Array.isArray(peaks.max)) return null;
    return {
        min: Float32Array.from(peaks.min),
        max: Float32Array.from(peaks.max),
        bins: Number(peaks.bins) || peaks.min.length,
        duration: Number(peaks.duration) || 0
    };
}

const MIN_PLAYBACK_WINDOW_SECONDS = 0.05;
const MIX_FIN_GUARD_SECONDS = 0.25;
const MIN_MIX_AFTER_START_SECONDS = 3;
const playerPlaybackMeta = new WeakMap();
const ANALYSIS_DEFAULTS = Object.freeze({
    dbMix: -14,
    dbStart: -36,
    dbFin: -48
});

function getResolvedRowMixAbsolute(row, trackConfig) {
    const customMix = parseFiniteCueValue(row?.dataset?.customMix);
    if (customMix !== null) return customMix;
    return parseFiniteCueValue(trackConfig?.mixAbsolute);
}

function getFallbackMixTriggerSeconds(trackConfig) {
    if (!trackConfig?.mixDbActive) return 0;
    if (!trackConfig.mixFadeoutActive) return 1;
    const fadeSeconds = parseFiniteCueValue(trackConfig.mixFadeout) ?? 0;
    return Math.max(1, fadeSeconds || 0);
}

function resolveTrackPlaybackWindow(filePath, options = {}) {
    const cueData = (filePath && manualCuesDB[filePath]) ? manualCuesDB[filePath] : {};
    let startOffset = options.startOffset !== undefined
        ? parseFiniteCueValue(options.startOffset)
        : parseFiniteCueValue(cueData.inicio);
    if (startOffset === null || startOffset < 0) startOffset = 0;

    const naturalEndAbsolute = options.baseDuration !== undefined
        ? parseFiniteCueValue(options.baseDuration)
        : parseFiniteCueValue(cueData.duration);

    let mixAbsolute = options.mixAbsolute !== undefined
        ? parseFiniteCueValue(options.mixAbsolute)
        : parseFiniteCueValue(cueData.mix);
    // Si el mix vino del operador (editor 2 o 3 pistas), se respeta tal cual:
    // las guardas que siguen son una proteccion contra valores absurdos del
    // analisis automatico, no contra decisiones manuales del operador.
    const mixIsManual = options.mixIsManual === true;
    if (!mixIsManual) {
        if (mixAbsolute !== null && mixAbsolute <= (startOffset + MIN_MIX_AFTER_START_SECONDS)) mixAbsolute = null;
        if (naturalEndAbsolute !== null && mixAbsolute !== null && mixAbsolute >= naturalEndAbsolute) mixAbsolute = null;
    }

    let finAbsolute = options.finAbsolute !== undefined
        ? parseFiniteCueValue(options.finAbsolute)
        : parseFiniteCueValue(cueData.fin);
    if (naturalEndAbsolute !== null && finAbsolute !== null) finAbsolute = Math.min(finAbsolute, naturalEndAbsolute);
    if (finAbsolute !== null && finAbsolute <= (startOffset + MIN_PLAYBACK_WINDOW_SECONDS)) finAbsolute = null;

    // Si fin queda pegado a mix, lo tomamos como un cue contradictorio
    // para no matar la cola de la pista al disparar el punto mix.
    if (mixAbsolute !== null && finAbsolute !== null && finAbsolute <= (mixAbsolute + MIX_FIN_GUARD_SECONDS)) {
        finAbsolute = null;
    }

    const effectiveEndAbsolute = finAbsolute !== null ? finAbsolute : naturalEndAbsolute;
    const effectiveDuration = effectiveEndAbsolute !== null
        ? Math.max(MIN_PLAYBACK_WINDOW_SECONDS, effectiveEndAbsolute - startOffset)
        : null;

    return {
        startOffset,
        mixAbsolute,
        finAbsolute,
        naturalEndAbsolute,
        effectiveEndAbsolute,
        effectiveDuration
    };
}

function setPlayerPlaybackMeta(player, meta) {
    if (!player) return;
    playerPlaybackMeta.set(player, meta || {});
}

function getPlayerPlaybackMeta(player) {
    if (!player) return null;
    return playerPlaybackMeta.get(player) || null;
}

function clearPlayerPlaybackMeta(player) {
    if (!player) return;
    playerPlaybackMeta.delete(player);
}

let uiPrefs = loadConfig(uiPrefsPath, { controlsPos: 'bottom', temp: true, hum: true, leftPanel: true, ext: false, sysLog: true, showRemainingTime: false, cartwall: false, playlistColumnWidths: [92, 520, 96, 82, 82] });
let fxPrefs = loadConfig(fxPrefsPath, { preamp: 0, pan: 0, mono: false, eq_bands: [0, 0, 0, 0, 0, 0, 0, 0], eq_on: false, comp_on: false, lim_on: false, order: ['eq', 'comp', 'limiter'], custom_presets: {}, active_preset: 'def_Plano (Reset)' });
let generalPrefs = normalizeAudioPrefs(loadConfig(generalPrefsPath, { modeLoopPlaylist: false, modeRemovePlayed: false, modeRepeatTrack: false, timeFolder: '', duckingFade: 1.0, duckingVolume: 20, outMain: 'default', outMonitor: 'default', outEditor: 'default', outCue: 'default', outCartwall: 'default', monitorVolume: 100, monitorEnabled: false, monitorSourceMode: 'postFx', encoderSourceMode: 'postFx', monitorVolumeUiEnabled: true, monitorVolumeUiMode: 'inline', playlistOutputMode: 'disabled', playlistSharedDevice: 'default', playlistOutputs: ['default', 'default', 'default', 'default'], cartwallOutputMode: 'master', audioEngineMode: 'rustAudio', rustPlaylistOwnerEnabled: true, chk_mus_fadein: false, chk_mus_fadeout: false, chk_mus_mix: false, chk_mus_mix_db: false, chk_mus_mix_fadeout: false, num_mus_fadein: 0, num_mus_fadeout: 0, num_mus_mix: 0, num_mus_mix_db: -14, eventsMasterActive: true, eventsManualOnly: false }));
let clockwheelPrefs = loadConfig(clockwheelPrefsPath, { pattern: '', targetMinutes: 60, sepArtist: 4, sepTitle: 8, sepFolder: 2, clearList: false });

// Adaptar rutas de configuración al SO actual (Linux: traduce rutas Windows automáticamente)
const { adaptStoredPath } = require('../backend/utils/platform');
const __projectRoot = path.resolve(__dirname, '..');
if (generalPrefs.timeFolder) {
    generalPrefs.timeFolder = adaptStoredPath(generalPrefs.timeFolder, __projectRoot);
}
if (generalPrefs.weatherFolder) {
    generalPrefs.weatherFolder = adaptStoredPath(generalPrefs.weatherFolder, __projectRoot);
}

if (generalPrefs.duckingFade >= 10) generalPrefs.duckingFade = 1.0;

let fileTypesData = [];
function loadFileTypes() { fileTypesData = loadConfig(fileTypesPath, []); }
loadFileTypes();
let genreProfiles = [];

window.showPlaylistExtensions = uiPrefs.ext;

let manualCuesDB = {};
const preanalysisRequested = new Set();
const preanalysisQueue = new Map();
let preanalysisTimer = null;

function hasValidNumber(v) { return v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v)); }

function ensurePreanalysisForTrack(ruta, options = {}) {
    if (!ruta) return;
    if (preanalysisRequested.has(ruta)) return;

    const mc = manualCuesDB[ruta] || {};
    const missingInicio = !hasValidNumber(mc.inicio);
    const missingFin = !hasValidNumber(mc.fin);
    const missingMix = !hasValidNumber(mc.mix);

    if (!(missingInicio || missingFin || missingMix)) return;

    preanalysisRequested.add(ruta);
    preanalysisQueue.set(ruta, {
        filePath: ruta,
        dbMix: options.dbMix ?? ANALYSIS_DEFAULTS.dbMix,
        dbStart: options.dbStart ?? ANALYSIS_DEFAULTS.dbStart,
        dbFin: options.dbFin ?? ANALYSIS_DEFAULTS.dbFin,
        priority: options.priority || 'normal',
        forceOverwrite: false
    });
    schedulePreanalysisFlush();
}

function schedulePreanalysisFlush() {
    if (preanalysisTimer) return;
    preanalysisTimer = setTimeout(flushPreanalysisQueue, PREANALYSIS_BATCH_DELAY_MS);
}

function flushPreanalysisQueue() {
    preanalysisTimer = null;
    const tasks = Array.from(preanalysisQueue.values());
    preanalysisQueue.clear();
    if (tasks.length > 0) ipcRenderer.send('lib-start-analyzer-ffmpeg', tasks);
}

let eventsMasterDB = [];
let eventGroupsDB = [];

// ============================================================================
// ARQUITECTURA DE PESTAÃ‘AS (FASE 2)
// ============================================================================
let tbodys = [];
let currentViewTab = 0;
let pgmTab = 0;
let playlistBody = null;
let isRestoringSession = false;
let lastSessionSnapshotJson = '';
let incidentEntries = [];
let incidentFilter = 'all';
let incidentAutoActionCount = 0;
let incidentLastAutoAction = 'Ultima autoaccion: ninguna';
const incidentRepeatState = new Map();
let lastEncoderStatus = 'disconnected';
const incidentStatusState = {
    air: { value: 'Detenido', tone: 'warn' },
    events: { value: 'Activos', tone: 'ok' },
    encoder: { value: 'Desconectado', tone: 'warn' },
    session: { value: 'Nueva', tone: 'manual' }
};

const playlistTable = document.getElementById('playlist-table');
const playlistSection = document.getElementById('playlist-container');
const txtSiguiente = document.getElementById('txt-siguiente');
const PLAYLIST_COLUMN_MIN_WIDTHS = [82, 240, 90, 78, 78];

const PLAYLIST_COLUMN_DEFAULT_WIDTHS = [92, 520, 96, 82, 82];
let playlistColumnWidths = [];

if (playlistTable) {
    for (let i = 0; i < 4; i++) {
        let tb = document.createElement('tbody');
        tb.id = 'playlist-body-' + i;
        if (i !== 0) tb.style.display = 'none';
        playlistTable.appendChild(tb);
        tbodys.push(tb);
    }
    playlistBody = tbodys[0];
}

function normalizePlaylistColumnWidths(widths) {
    const source = Array.isArray(widths) ? widths : [];
    return PLAYLIST_COLUMN_DEFAULT_WIDTHS.map((defaultWidth, index) => {
        const parsed = parseInt(source[index], 10);
        return Number.isFinite(parsed)
            ? Math.max(PLAYLIST_COLUMN_MIN_WIDTHS[index], parsed)
            : defaultWidth;
    });
}

function ensurePlaylistColGroup() {
    if (!playlistTable) return null;


    let colGroup = playlistTable.querySelector('colgroup');
    if (!colGroup) {
        colGroup = document.createElement('colgroup');
        playlistTable.insertBefore(colGroup, playlistTable.firstChild);
    }

    while (colGroup.children.length < PLAYLIST_COLUMN_DEFAULT_WIDTHS.length) {
        colGroup.appendChild(document.createElement('col'));
    }
    while (colGroup.children.length > PLAYLIST_COLUMN_DEFAULT_WIDTHS.length) {
        colGroup.removeChild(colGroup.lastElementChild);
    }
    return colGroup;
}

function getPlaylistHeaderCells() {
    return Array.from(playlistTable?.querySelectorAll('thead th') || []);
}

function applyPlaylistColumnWidths() {
    if (!playlistTable) return;
    playlistColumnWidths = normalizePlaylistColumnWidths(playlistColumnWidths.length ? playlistColumnWidths : uiPrefs.playlistColumnWidths);
    uiPrefs.playlistColumnWidths = [...playlistColumnWidths];

    const colGroup = ensurePlaylistColGroup();
    if (colGroup) {
        Array.from(colGroup.children).forEach((col, index) => {
            col.style.width = `${playlistColumnWidths[index]}px`;
        });
    }

    getPlaylistHeaderCells().forEach((th, index) => {
        th.style.width = `${playlistColumnWidths[index]}px`;
        th.style.minWidth = `${playlistColumnWidths[index]}px`;
    });

    const totalWidth = playlistColumnWidths.reduce((sum, value) => sum + value, 0);
    playlistTable.style.minWidth = `${totalWidth}px`;
}

function persistPlaylistColumnWidths() {
    uiPrefs.playlistColumnWidths = [...playlistColumnWidths];
    saveConfig(uiPrefsPath, uiPrefs);
}

function startPlaylistColumnResize(event, colIndex) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    playlistColumnWidths = normalizePlaylistColumnWidths(playlistColumnWidths.length ? playlistColumnWidths : uiPrefs.playlistColumnWidths);
    const startX = event.clientX;
    const startWidth = playlistColumnWidths[colIndex];

    document.body.classList.add('playlist-col-resizing');

    const onMouseMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        playlistColumnWidths[colIndex] = Math.max(PLAYLIST_COLUMN_MIN_WIDTHS[colIndex], startWidth + delta);
        applyPlaylistColumnWidths();
    };

    const onMouseUp = () => {
        document.body.classList.remove('playlist-col-resizing');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        persistPlaylistColumnWidths();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

function initPlaylistColumnResizers() {
    if (!playlistTable) return;
    applyPlaylistColumnWidths();
    getPlaylistHeaderCells().forEach((th, index) => {
        th.classList.add('playlist-col-header');
        let resizer = th.querySelector('.playlist-col-resizer');
        if (!resizer) {
            resizer = document.createElement('span');
            resizer.className = 'playlist-col-resizer';
            th.appendChild(resizer);
        }
        resizer.onmousedown = (event) => startPlaylistColumnResize(event, index);
    });
}

function getRowLocation(row) {
    if (!row || !document.body.contains(row)) return null;
    const tbody = row.closest('tbody');
    const tab = tbodys.indexOf(tbody);
    if (tab < 0) return null;
    const rowIndex = Array.from(tbody.children).indexOf(row);
    if (rowIndex < 0) return null;
    return { tab, row: rowIndex };
}

function getRowByLocation(location) {
    if (!location || !Number.isInteger(location.tab) || !Number.isInteger(location.row)) return null;
    const tbody = tbodys[location.tab];
    if (!tbody) return null;
    return tbody.children[location.row] || null;
}

function serializePlaylistRow(row) {
    return {
        ruta: row.dataset.ruta,
        duracion: parseInt(row.dataset.duracion, 10) || 0,
        type: row.dataset.type || 'normal',
        titulo: row.dataset.pureName ? (row.dataset.pureName + (row.dataset.ext || '')) : row.children[1].innerText,
        customMix: row.dataset.customMix || null,
        temp: row.dataset.temp === 'true',
        noteText: row.dataset.noteText || null,
        targetTab: Number.isInteger(parseInt(row.dataset.targetTab, 10)) ? parseInt(row.dataset.targetTab, 10) : null,
        eventId: row.dataset.eventId || null,
        eventName: row.dataset.eventName || null
    };
}

function isTimeLocutionRow(row) {
    return !!row && ((row.dataset.type || '') === 'time' || row.dataset.ruta === 'time_locution');
}

function normalizeTimeLocutionRow(row) {
    if (!isTimeLocutionRow(row)) return false;
    row.dataset.type = 'time';
    row.dataset.ruta = 'time_locution';
    row.dataset.pureName = ICON_CLOCK_LABEL;
    row.dataset.ext = '';
    row.style.color = '#2ecc71';
    row.style.fontStyle = 'italic';
    if (row.children?.[1]) row.children[1].innerText = ICON_CLOCK_LABEL;
    if (row.children?.[3]) row.children[3].innerText = '0.0';
    if (row.children?.[4]) row.children[4].innerText = '0.0';
    return true;
}

const PLAYLIST_COMMAND_TYPES = new Set(['stop', 'note', 'playlist_jump', 'execute_event']);

function isPlaylistCommandRow(row) {
    return !!row && PLAYLIST_COMMAND_TYPES.has(row.dataset.type || '');
}

function isPlaylistNoteRow(row) {
    return !!row && (row.dataset.type || '') === 'note';
}

function isPlaylistStopRow(row) {
    return !!row && (row.dataset.type || '') === 'stop';
}

function isPlaylistJumpRow(row) {
    return !!row && (row.dataset.type || '') === 'playlist_jump';
}

function isPlaylistExecuteEventRow(row) {
    return !!row && (row.dataset.type || '') === 'execute_event';
}

function getNextPlaylistCandidate(row, allowLoop = false) {
    if (!row) return null;
    const tbody = row.closest('tbody');
    let next = row.nextElementSibling;
    if (!next && allowLoop && tbody) next = tbody.firstElementChild;
    return next || null;
}

function resolveNextOperationalRow(startRow, allowLoop = false) {
    let scan = startRow;
    while (scan && scan.parentNode) {
        const type = scan.dataset.type || 'normal';
        if (type !== 'note') return scan;
        scan = scan.nextElementSibling;
    }
    if (allowLoop) {
        const tbody = startRow ? startRow.closest('tbody') : tbodys[pgmTab];
        if (tbody) {
            scan = tbody.firstElementChild;
            while (scan && scan.parentNode) {
                const type = scan.dataset.type || 'normal';
                if (type !== 'note') return scan;
                if (scan === startRow) break;
                scan = scan.nextElementSibling;
            }
        }
    }
    return null;
}

function setQueuedNextManual(row) {
    document.querySelectorAll('.playlist-table tr[data-manual-next="true"]').forEach(tr => {
        delete tr.dataset.manualNext;
    });

    queuedNextRow = row;
    if (queuedNextRow) {
        queuedNextRow.dataset.manualNext = "true";
    }
    updateNextTrackVisuals();
    saveSessionSnapshot();
}

function setQueuedNextAutomatic(row) {
    document.querySelectorAll('.playlist-table tr[data-manual-next="true"]').forEach(tr => {
        delete tr.dataset.manualNext;
    });
    queuedNextRow = row || null;
    updateNextTrackVisuals();
    saveSessionSnapshot();
}

function formatSpecialPlaylistTitle(type, targetTab = null, noteText = '') {
    if (type === 'stop') return `${ICON_STOP_LABEL} Comando: STOP`;
    if (type === 'note') return `${ICON_NOTE_LABEL} ${noteText || 'Nota'}`;
    if (type === 'playlist_jump') return `${ICON_PLAYLIST_JUMP_LABEL} Reproducir Playlist ${(parseInt(targetTab, 10) || 0) + 1}`;
    if (type === 'execute_event') return `${ICON_EVENT_LABEL} Ejecutar evento: ${noteText || 'Evento'}`;
    return '';
}

function isExternalPlaylistDrop(dataTransfer) {
    if (draggedTableRow) return false;
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    if (dataTransfer.types && Array.from(dataTransfer.types).includes('Files')) return true;
    const text = dataTransfer.getData ? dataTransfer.getData('text/plain') : '';
    return !!(text && text !== 'internal_row' && text !== 'multiple_internal_rows');
}

function clearPlaylistDragState() {
    if (playlistSection) playlistSection.classList.remove('playlist-drop-active');
    document.querySelectorAll('.playlist-table tr').forEach(row => {
        row.classList.remove('dragging-row', 'drag-over-top', 'drag-over-bottom');
    });
}

function isRowAfterAnchor(row, anchorRow) {
    if (!row || !anchorRow || row.closest('tbody') !== anchorRow.closest('tbody')) return false;
    let scan = anchorRow.nextElementSibling;
    while (scan) {
        if (scan === row) return true;
        scan = scan.nextElementSibling;
    }
    return false;
}

function buildSessionState() {
    const playingLocation = getRowLocation(currentPlayingRow);
    const queuedLocation = getRowLocation(queuedNextRow);
    return {
        version: 1,
        savedAt: new Date().toISOString(),
        currentViewTab,
        pgmTab,
        stopAfterCurrent: stopAfterCurrent === true,
        playlists: tbodys.map(tbody => Array.from(tbody.children).map(serializePlaylistRow)),
        currentPlaying: playingLocation ? {
            location: playingLocation,
            currentTime: 0,
            type: currentPlayingRow?.dataset?.type || 'normal'
        } : null,
        queuedNext: queuedLocation
    };
}

function saveSessionSnapshot(force = false) {
    if (isRestoringSession) return;
    try {
        const json = JSON.stringify(buildSessionState(), null, 2);
        if (!force && json === lastSessionSnapshotJson) return;
        fs.writeFileSync(sessionStatePath, json, 'utf-8');
        lastSessionSnapshotJson = json;
    } catch (err) { }
}

function applySessionViewState(nextViewTab) {
    const safeViewTab = tbodys[nextViewTab] ? nextViewTab : 0;
    tbodys.forEach((tbody, idx) => {
        tbody.style.display = idx === safeViewTab ? 'table-row-group' : 'none';
    });
    currentViewTab = safeViewTab;
    playlistBody = tbodys[currentViewTab];
    try { ipcRenderer.send('active-tab-changed', currentViewTab); } catch (err) { }
}

function updateTabsUI() {
    document.querySelectorAll('.pl-tab').forEach((btn, idx) => {
        const dot = btn.querySelector('.pgm-dot');
        if (dot) {
            if (idx === pgmTab && currentPlayingRow && idx !== currentViewTab) {
                dot.style.display = 'inline-block';
            } else {
                dot.style.display = 'none';
            }
        }
        if (idx === currentViewTab) {
            btn.classList.add('active');
            btn.style.color = '#fff';
        } else {
            btn.classList.remove('active');
            btn.style.color = '#888';
        }
    });
}

function clearAirTimeSegmentState() {
    const lblT = document.getElementById('lbl-tiempo');
    const txtTiempo = document.getElementById('txt-tiempo');
    const cueClock = document.getElementById('txt-cue-countdown');

    if (lblT) {
        lblT.classList.remove('label-intro', 'label-outro');
        lblT.innerText = uiPrefs.showRemainingTime ? "Tiempo restante" : "Tiempo transcurrido";
    }
    if (txtTiempo) {
        txtTiempo.classList.remove('segment-intro', 'segment-outro');
    }
    if (cueClock) {
        cueClock.style.display = 'none';
        cueClock.className = 'digital-time cue-countdown-display';
        cueClock.innerText = '';
    }
}

function formatCueCountdown(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    return safeSeconds.toString().padStart(2, '0');
}

function updateAirTimeSegmentState(segment = null, secondsRemaining = 0) {
    clearAirTimeSegmentState();
    if (!segment) return;

    const lblT = document.getElementById('lbl-tiempo');
    const txtTiempo = document.getElementById('txt-tiempo');
    const cueClock = document.getElementById('txt-cue-countdown');
    const labelText = segment === 'intro' ? 'INTRO' : 'OUTRO';
    const labelClass = segment === 'intro' ? 'label-intro' : 'label-outro';
    const timeClass = segment === 'intro' ? 'segment-intro' : 'segment-outro';

    if (uiPrefs.showRemainingTime) {
        if (lblT) {
            lblT.innerText = `${labelText} restante`;
            lblT.classList.add(labelClass);
        }
        if (txtTiempo) txtTiempo.classList.add(timeClass);
        if (segment === 'intro' && cueClock) {
            cueClock.style.display = 'flex';
            cueClock.classList.add('cue-clock-intro');
            cueClock.innerText = `INTRO: ${formatCueCountdown(secondsRemaining)}`;
        }
        return;
    }

    if (cueClock) {
        cueClock.style.display = 'flex';
        cueClock.classList.add(segment === 'intro' ? 'cue-clock-intro' : 'cue-clock-outro');
        cueClock.innerText = `${labelText}: ${formatCueCountdown(secondsRemaining)}`;
    }
}

function ensurePlaybackRowsVisible(options = {}) {
    const {
        forcePgmView = false,
        centerCurrent = false,
        onlyIfAnchorVisible = false,
        visibleAnchorRow = null,
        anchorWasVisible = null
    } = options;
    const anchorRow = (currentPlayingRow && document.body.contains(currentPlayingRow))
        ? currentPlayingRow
        : ((queuedNextRow && document.body.contains(queuedNextRow)) ? queuedNextRow : null);
    if (!anchorRow) return;

    const targetBody = anchorRow.closest('tbody');
    const targetTab = tbodys.indexOf(targetBody);
    if (targetTab < 0) return;

    if (forcePgmView && currentViewTab !== targetTab) {
        applySessionViewState(targetTab);
        updateTabsUI();
    }

    if (currentViewTab !== targetTab) return;
    if (onlyIfAnchorVisible) {
        if (typeof anchorWasVisible === 'boolean') {
            if (!anchorWasVisible) return;
        } else {
            const rowToCheck = (visibleAnchorRow && document.body.contains(visibleAnchorRow)) ? visibleAnchorRow : anchorRow;
            if (!isPlaylistRowVisible(rowToCheck)) return;
        }
    }

    requestAnimationFrame(() => {
        const focusRow = (currentPlayingRow && document.body.contains(currentPlayingRow)) ? currentPlayingRow : anchorRow;
        try {
            focusRow.scrollIntoView({ block: centerCurrent ? 'center' : 'nearest' });
        } catch (err) { }

        if (queuedNextRow && document.body.contains(queuedNextRow) && queuedNextRow.closest('tbody') === targetBody) {
            try { queuedNextRow.scrollIntoView({ block: 'nearest' }); } catch (err) { }
        }
    });
}

function isPlaylistRowVisible(row, marginPx = 0) {
    if (!row || !document.body.contains(row)) return false;
    const rowBody = row.closest('tbody');
    if (tbodys.indexOf(rowBody) !== currentViewTab) return false;
    const scroller = document.getElementById('playlist-container');
    if (!scroller) return false;

    const rowRect = row.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return rowRect.bottom >= (scrollerRect.top - marginPx)
        && rowRect.top <= (scrollerRect.bottom + marginPx);
}

function isPlaylistRowInAutoFollowZone(row) {
    if (!isPlaylistRowVisible(row)) return false;
    const scroller = document.getElementById('playlist-container');
    if (!scroller) return false;

    const rowRect = row.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const rowCenter = rowRect.top + (rowRect.height / 2);
    const scrollerMiddle = scrollerRect.top + (scrollerRect.height / 2);
    return rowCenter >= scrollerMiddle;
}

function setIncidentStatus(key, value, tone = 'ok') {
    if (!incidentStatusState[key]) return;
    incidentStatusState[key] = { value, tone };
    const card = document.getElementById(`status-${key}`);
    if (card) {
        const valueNode = card.querySelector('.incident-status-value');
        if (valueNode) valueNode.innerText = value;
        card.dataset.tone = tone;
    }
    pushIncidentSnapshot();
}

function updateIncidentAutoSummary() {
    const counter = document.getElementById('incident-auto-count');
    if (counter) counter.innerText = `AUTO ${incidentAutoActionCount}`;
    const lastAction = document.getElementById('incident-last-action');
    if (lastAction) lastAction.innerText = incidentLastAutoAction;
}

function buildEventWatchSnapshot(limit = 3) {
    try {
        if (typeof buildUpcomingEventTimeline !== 'function') return { summary: 'Sin eventos proximos', items: [] };
        const items = buildUpcomingEventTimeline(limit).map(item => {
            const entry = item.entry || {};
            return {
                time: (item.timeStr || item.ev?.primaryTime || '--:--').substring(0, 5),
                name: item.ev?.name || 'Evento sin nombre',
                status: entry.status || 'scheduled',
                label: entry.label || 'PROG',
                message: entry.message || item.countdownText || 'Programado',
                countdownText: item.countdownText || '',
                sourceSummary: entry.sourceSummary || ''
            };
        });
        return {
            summary: items.length ? `${items.length} en vigilancia` : 'Sin eventos proximos',
            items
        };
    } catch (err) {
        return { summary: 'Guardia no disponible', items: [] };
    }
}

function buildIncidentSnapshot() {
    return {
        statuses: {
            air: { ...incidentStatusState.air },
            events: { ...incidentStatusState.events },
            encoder: { ...incidentStatusState.encoder },
            session: { ...incidentStatusState.session }
        },
        autoCount: incidentAutoActionCount,
        lastAction: incidentLastAutoAction,
        eventWatch: buildEventWatchSnapshot(6),
        entries: incidentEntries.map(entry => ({ ...entry }))
    };
}

function pushIncidentSnapshot() {
    try { ipcRenderer.send('incident-sync-broadcast', buildIncidentSnapshot()); } catch (err) { }
}

function escapeIncidentHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function deriveIncidentCategory(msg, meta = {}) {
    if (meta.category) return meta.category;
    if (msg.includes('[GUARDIA AIRE]')) return 'guard';
    if (msg.includes('[SESION]')) return 'session';
    if (msg.includes('[ERROR Audio]') || msg.includes('Audio]')) return 'audio';
    if (msg.includes('Eventos') || msg.includes('[EVENTOS]')) return 'events';
    if (msg.includes(ICON_ENCODER_LABEL) || msg.includes('[ENCODER]')) return 'encoder';
    if (msg.startsWith(ICON_AIR_PREFIX)) return 'air';
    if (msg.includes('Reproducci')) return 'air';
    return 'system';
}

function deriveIncidentLevel(msg, meta = {}) {
    if (meta.level) return meta.level;
    if (msg.includes('[ERROR]') || msg.includes('[ERROR ')) return 'error';
    if (msg.includes('[ADVERTENCIA]') || msg.includes('[GUARDIA AIRE]')) return 'warn';
    if (msg.startsWith(ICON_AIR_PREFIX)) return 'success';
    return 'info';
}

function categoryLabel(category) {
    const labels = {
        all: 'Todos',
        air: 'Aire',
        guard: 'Guardia',
        audio: 'Audio',
        events: 'Eventos',
        encoder: 'Encoder',
        session: 'Sesion',
        system: 'Sistema'
    };
    return labels[category] || 'Sistema';
}

function renderIncidentEntries() {
    const logBox = document.getElementById('sys-log');
    if (!logBox) return;
    const previousScrollTop = logBox.scrollTop;
    const keepScrollPosition = previousScrollTop > 8;
    const visibleEntries = incidentEntries.filter(entry => incidentFilter === 'all' || entry.category === incidentFilter);
    if (visibleEntries.length === 0) {
        logBox.innerHTML = '<div class="incident-empty">No hay incidencias para este filtro.</div>';
        return;
    }
    logBox.innerHTML = visibleEntries.map(entry => `
        <div class="incident-entry" data-level="${entry.level}">
            <div class="incident-entry-head">
                <div class="incident-entry-meta">
                    <span class="incident-entry-time">${escapeIncidentHtml(entry.time)}</span>
                    <span class="incident-entry-tag" data-category="${entry.category}">${categoryLabel(entry.category)}</span>
                </div>
            </div>
            <div class="incident-entry-message">${escapeIncidentHtml(entry.message)}</div>
        </div>
    `).join('');
    logBox.scrollTop = keepScrollPosition ? Math.min(previousScrollTop, logBox.scrollHeight) : 0;
}

function recordIncident(msg, meta = {}) {
    const now = new Date();
    const throttleKey = meta.throttleKey || ((meta.autoAction === true || msg.includes('[GUARDIA AIRE]')) ? msg.replace(/\d+(?:[.,]\d+)?/g, '#') : '');
    if (throttleKey) {
        const nowMs = now.getTime();
        const windowMs = Math.max(60000, Number(meta.throttleWindowMs) || 10 * 60 * 1000);
        const maxRepeats = Math.max(1, Number(meta.throttleMax) || 3);
        let state = incidentRepeatState.get(throttleKey);
        if (!state || nowMs - state.startedAt > windowMs) {
            state = { startedAt: nowMs, count: 0, suppressed: false };
        }
        state.count++;
        incidentRepeatState.set(throttleKey, state);
        if (state.count > maxRepeats) {
            if (!state.suppressed) {
                state.suppressed = true;
                incidentRepeatState.set(throttleKey, state);
                msg = `${msg} Avisos repetidos silenciados hasta que cambie la condicion.`;
            } else {
                return;
            }
        }
    }
    const entry = {
        id: `${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
        time: now.toLocaleString('es-PE', { hour12: false }),
        category: deriveIncidentCategory(msg, meta),
        level: deriveIncidentLevel(msg, meta),
        message: msg,
        autoAction: meta.autoAction === true || msg.includes('[GUARDIA AIRE]')
    };
    incidentEntries.unshift(entry);
    if (incidentEntries.length > 250) incidentEntries.length = 250;
    if (entry.autoAction) {
        incidentAutoActionCount++;
        incidentLastAutoAction = `Ultima autoaccion: ${entry.time} - ${entry.message}`;
        updateIncidentAutoSummary();
    }
    renderIncidentEntries();
    pushIncidentSnapshot();
}

function refreshAirIncidentStatus() {
    if (currentPlayingRow && !isPlayerClockPaused(activePlayer)) { setIncidentStatus('air', 'En aire', 'ok'); return; }
    if (currentPlayingRow && playbackHoldByUser) { setIncidentStatus('air', 'Pausa manual', 'manual'); return; }
    if (currentPlayingRow) { setIncidentStatus('air', 'En espera', 'warn'); return; }
    setIncidentStatus('air', 'Detenido', 'manual');
}

function refreshEventsIncidentStatus() {
    const chkManual = document.getElementById('chk-events-manual');
    const chkMaster = document.getElementById('chk-events-master');
    if (!chkMaster || !chkManual) return;
    if (!chkMaster.checked) { setIncidentStatus('events', 'Pausados', 'manual'); return; }
    if (chkManual.checked) { setIncidentStatus('events', 'Manual', 'manual'); return; }
    if (eventsMasterDB.some(ev => ev.hasError)) { setIncidentStatus('events', 'Con alertas', 'error'); return; }
    setIncidentStatus('events', 'Activos', 'ok');
}

function setEncoderIncidentStatus(status) {
    const statusMap = {
        live: { value: 'En vivo', tone: 'ok' },
        reconnecting: { value: 'Reconectando', tone: 'warn' },
        connecting: { value: 'Conectando', tone: 'warn' },
        error: { value: 'Error', tone: 'error' },
        disconnected: { value: 'Desconectado', tone: 'manual' }
    };
    const next = statusMap[status] || statusMap.disconnected;
    setIncidentStatus('encoder', next.value, next.tone);
    if (status === lastEncoderStatus) return;
    lastEncoderStatus = status;
    if (status === 'live') recordIncident('[ENCODER] Transmision en vivo.', { category: 'encoder', level: 'success' });
    else if (status === 'reconnecting') recordIncident('[ENCODER] Intentando reconectar.', { category: 'encoder', level: 'warn' });
    else if (status === 'error') recordIncident('[ENCODER] Error en la transmision.', { category: 'encoder', level: 'error' });
    else if (status === 'disconnected') recordIncident('[ENCODER] Transmision detenida.', { category: 'encoder', level: 'info' });
}

function initIncidentCenter() {
    document.querySelectorAll('.incident-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            incidentFilter = btn.dataset.filter || 'all';
            document.querySelectorAll('.incident-filter').forEach(node => node.classList.toggle('active', node === btn));
            renderIncidentEntries();
        });
    });
    const btnOpenReports = document.getElementById('btn-open-reports');
    if (btnOpenReports) btnOpenReports.addEventListener('click', () => { ipcRenderer.send('open-reports-window'); });
    updateIncidentAutoSummary();
    refreshAirIncidentStatus();
    refreshEventsIncidentStatus();
    setEncoderIncidentStatus('disconnected');
    setIncidentStatus('session', 'Nueva', 'manual');
    recordIncident('Sistema de Reportes Activado.', { category: 'system', level: 'info' });
    pushIncidentSnapshot();
}

function buildPlaybackGuardToken() {
    if (!currentPlayingRow) return '';
    return `${currentPlayingRow.dataset.ruta || ''}|${pgmTab}|${playRowSessionId}`;
}

function isPlaybackActuallyOnAir() {
    return !!(currentPlayingRow && activePlayer && !isPlayerClockPaused(activePlayer) && !activePlayer.ended);
}

function getVisibleCurrentSongText() {
    const txtCancion = document.getElementById('txt-cancion');
    return (txtCancion?.innerText || '').trim();
}

function publishRustNowPlaying(text, extra = {}) {
    if (!shouldMirrorRustControlPlane()) return;
    const title = String(text || IDLE_METADATA_TEXT).trim() || IDLE_METADATA_TEXT;
    commandRustControlPlane('nowPlaying', {
        title,
        artist: '',
        path: extra.path || getActivePlaybackFilePath() || '',
        player: extra.player || (activePlayer === playerB ? 'player-b' : 'player-a'),
        source: extra.source || 'renderer'
    }).catch(() => { });
}

let lastRustTransportPublishAt = 0;
let lastRustTransportSignature = '';
const rustPlaylistMirrorState = new Map();
const rustPlaylistOwnerHealth = {
    active: false,
    failures: 0,
    lastOkAt: 0,
    fallbackUntil: 0,
    fallbackReason: '',
    lastStallRecoveryAt: 0,
    lastPlayerId: '',
    lastPositionMs: null,
    lastPositionAt: 0,
    audioNotReadySince: 0
};
let rustPlaylistStopGuardUntil = 0;
const rustPlaylistVirtualClock = {
    active: false,
    player: null,
    path: '',
    baseTime: 0,
    startedAt: 0,
    paused: true,
    // Marca de tiempo del ultimo seek manual del operador. Mientras la
    // diferencia con Date.now() sea menor a RUST_SEEK_BLACKOUT_MS, el reloj
    // virtual ignora la posicion que reporta Rust (porque viene atrasada
    // respecto del seek recien enviado) y usa baseTime local.
    seekedAt: 0
};
const RUST_SEEK_BLACKOUT_MS = 600;
const rustPlaylistGainRampTimers = new Map();
const rustMonitorMirrorState = new Map();
let currentPlaybackStartCause = 'idle';

function getActivePlaybackFilePath() {
    const metaPath = getPlayerPlaybackMeta(activePlayer)?.filePath;
    if (metaPath && metaPath !== 'time_locution') return metaPath;
    const rowPath = currentPlayingRow?.dataset?.resolvedRandomPath || currentPlayingRow?.dataset?.ruta || '';
    return rowPath === 'time_locution' ? '' : rowPath;
}

function normalizeEncoderProvider(value) {
    const provider = String(value || 'auto').trim().toLowerCase();
    if (provider === 'rust' || provider === 'rustaudio' || provider === 'rustaudioengine') return 'rust';
    if (provider === 'webaudio' || provider === 'web-audio' || provider === 'renderer') return 'webAudio';
    return 'auto';
}

function readEncoderProviderPreference() {
    try {
        return normalizeEncoderProvider(loadConfig(encoderPrefsPath, { encoderProvider: 'auto' }).encoderProvider);
    } catch (err) {
        return 'auto';
    }
}

function shouldMirrorRustControlPlane() {
    if (generalPrefs.audioEngineMode === 'rustAudio') return true;
    if (liveEncoderSourceState?.requestedOwner === 'rustAudioEngine'
        || liveEncoderSourceState?.owner === 'rustAudioEngine'
        || liveEncoderSourceState?.captureProvider === 'rustAudioEngine') {
        return true;
    }
    return readEncoderProviderPreference() === 'rust';
}

function commandRustControlPlane(type, payload = {}) {
    if (!shouldMirrorRustControlPlane()) return Promise.resolve({ ok: false, skipped: true });
    return Promise.resolve(rustAudioEngineAdapter.command(type, payload));
}

function isRustPlaylistOwnerEnabled() {
    return shouldMirrorRustControlPlane()
        && (generalPrefs.audioEngineMode === 'rustAudio' || generalPrefs.rustPlaylistOwnerEnabled === true);
}

function isRustExclusiveAudioMode() {
    return generalPrefs.audioEngineMode === 'rustAudio';
}

function isRustPlaylistOwnerActive() {
    return isRustPlaylistOwnerEnabled()
        && rustPlaylistOwnerHealth.active === true
        && rustPlaylistOwnerHealth.fallbackUntil <= Date.now();
}

function isRustPlaylistStopGuardActive() {
    return rustPlaylistStopGuardUntil > Date.now();
}

function isRustVirtualPlayer(player) {
    return rustPlaylistVirtualClock.active === true && rustPlaylistVirtualClock.player === player;
}

function getRustVirtualCurrentTime() {
    if (!rustPlaylistVirtualClock.active) return 0;
    // Tras un seek manual del operador, Rust tarda decenas de milisegundos en
    // confirmar la nueva posicion. Durante ese blackout devolvemos el reloj
    // local actualizado por seekRustVirtualPlayback para que la UI no vuelva
    // un instante a la posicion vieja (causa visible: la hora de finalizacion
    // y las horas de la playlist quedaban sin recalcularse al adelantar).
    const sinceSeek = Date.now() - rustPlaylistVirtualClock.seekedAt;
    if (rustPlaylistVirtualClock.seekedAt > 0 && sinceSeek < RUST_SEEK_BLACKOUT_MS) {
        if (rustPlaylistVirtualClock.paused) return rustPlaylistVirtualClock.baseTime;
        return rustPlaylistVirtualClock.baseTime + Math.max(0, (Date.now() - rustPlaylistVirtualClock.startedAt) / 1000);
    }
    const playerId = getPlaylistPlayerId(rustPlaylistVirtualClock.player);
    const rustPlayer = playerId ? findRustStatusPlayer(rustAudioProbeStatus.lastStatus, playerId) : null;
    const rustPositionSeconds = Number(rustPlayer?.positionMs) / 1000;
    if (Number.isFinite(rustPositionSeconds) && rustPositionSeconds >= 0) {
        if (rustPlayer.status === 'playing' && rustPlayer.audioReady !== false) {
            const updatedAt = Number(rustAudioProbeStatus.lastStatus?.updatedAt) || 0;
            const driftSeconds = updatedAt > 0 ? Math.max(0, (Date.now() - updatedAt) / 1000) : 0;
            return rustPositionSeconds + Math.min(0.5, driftSeconds);
        }
        return rustPositionSeconds;
    }
    if (rustPlaylistVirtualClock.paused) return rustPlaylistVirtualClock.baseTime;
    return rustPlaylistVirtualClock.baseTime + Math.max(0, (Date.now() - rustPlaylistVirtualClock.startedAt) / 1000);
}

function getPlayerClockTime(player) {
    if (isRustVirtualPlayer(player)) return getRustVirtualCurrentTime();
    return Number.isFinite(player?.currentTime) ? Number(player.currentTime) : 0;
}

function getPlayerClockDuration(player) {
    const meta = getPlayerPlaybackMeta(player) || {};
    const metaStart = parseFiniteCueValue(meta.startOffset) ?? 0;
    const metaEnd = parseFiniteCueValue(meta.playbackEndAbsolute) ?? parseFiniteCueValue(meta.naturalEndAbsolute);
    if (isRustVirtualPlayer(player)) {
        const virtualDuration = parseFiniteCueValue(currentDuration);
        if (virtualDuration !== null && virtualDuration > 0) return virtualDuration;
        if (metaEnd !== null) return Math.max(0, metaEnd - metaStart);
    }
    if (Number.isFinite(player?.duration)) return Number(player.duration);
    if (metaEnd !== null) return Math.max(0, metaEnd - metaStart);
    return 0;
}

function isPlayerClockPaused(player) {
    if (isRustVirtualPlayer(player)) return rustPlaylistVirtualClock.paused;
    return !player || player.paused;
}

function startRustVirtualPlayback(player, filePath, positionSeconds = 0) {
    rustPlaylistVirtualClock.active = true;
    rustPlaylistVirtualClock.player = player;
    rustPlaylistVirtualClock.path = filePath || '';
    rustPlaylistVirtualClock.baseTime = Math.max(0, Number(positionSeconds) || 0);
    rustPlaylistVirtualClock.startedAt = Date.now();
    rustPlaylistVirtualClock.paused = false;
}

function pauseRustVirtualPlayback() {
    if (!rustPlaylistVirtualClock.active || rustPlaylistVirtualClock.paused) return;
    rustPlaylistVirtualClock.baseTime = getRustVirtualCurrentTime();
    rustPlaylistVirtualClock.startedAt = Date.now();
    rustPlaylistVirtualClock.paused = true;
}

function resumeRustVirtualPlayback() {
    if (!rustPlaylistVirtualClock.active || !rustPlaylistVirtualClock.paused) return;
    rustPlaylistVirtualClock.startedAt = Date.now();
    rustPlaylistVirtualClock.paused = false;
}

function seekRustVirtualPlayback(positionSeconds = 0) {
    if (!rustPlaylistVirtualClock.active) return;
    rustPlaylistVirtualClock.baseTime = Math.max(0, Number(positionSeconds) || 0);
    rustPlaylistVirtualClock.startedAt = Date.now();
    rustPlaylistVirtualClock.seekedAt = Date.now();
}

function stopRustVirtualPlayback(player = null) {
    if (player && rustPlaylistVirtualClock.player !== player) return;
    rustPlaylistVirtualClock.active = false;
    rustPlaylistVirtualClock.player = null;
    rustPlaylistVirtualClock.path = '';
    rustPlaylistVirtualClock.baseTime = 0;
    rustPlaylistVirtualClock.startedAt = 0;
    rustPlaylistVirtualClock.paused = true;
}

function cancelRustPlaylistGainRamp(playerId = '') {
    const timers = rustPlaylistGainRampTimers.get(playerId);
    if (!Array.isArray(timers)) return;
    timers.forEach(timer => clearTimeout(timer));
    rustPlaylistGainRampTimers.delete(playerId);
}

function clearRustPlaylistGainRamps() {
    Array.from(rustPlaylistGainRampTimers.keys()).forEach(cancelRustPlaylistGainRamp);
}

function setRustPlaylistMirrorGain(playerId, gain, extra = {}) {
    if (!playerId) return;
    const previous = rustPlaylistMirrorState.get(playerId) || {};
    rustPlaylistMirrorState.set(playerId, {
        ...previous,
        ...extra,
        gain: Math.max(0, Math.min(2, Number(gain) || 0))
    });
}

function scheduleRustPlaylistGainRamp(playerId, fromGain, toGain, seconds, { stopAfter = false } = {}) {
    if (!playerId) return;
    cancelRustPlaylistGainRamp(playerId);
    const startGain = Math.max(0, Math.min(2, Number(fromGain) || 0));
    const endGain = Math.max(0, Math.min(2, Number(toGain) || 0));
    const durationMs = Math.max(0, Number(seconds) || 0) * 1000;
    if (durationMs <= 25 || Math.abs(startGain - endGain) < 0.001) {
        commandRustPlaylist('setGain', { player: playerId, gain: endGain }).catch(() => { });
        setRustPlaylistMirrorGain(playerId, endGain);
        if (stopAfter) {
            commandRustPlaylist('stop', { player: playerId }).catch(() => { });
            rustPlaylistMirrorState.delete(playerId);
        }
        return;
    }

    const steps = Math.max(4, Math.min(30, Math.round(durationMs / 60)));
    const timers = [];
    for (let step = 1; step <= steps; step++) {
        const atMs = Math.round((durationMs * step) / steps);
        const t = step / steps;
        const curved = t * t * (3 - 2 * t);
        const gain = startGain + ((endGain - startGain) * curved);
        timers.push(setTimeout(() => {
            commandRustPlaylist('setGain', { player: playerId, gain }).catch(() => { });
            setRustPlaylistMirrorGain(playerId, gain);
            if (step === steps) {
                rustPlaylistGainRampTimers.delete(playerId);
                if (stopAfter) {
                    commandRustPlaylist('stop', { player: playerId }).catch(() => { });
                    rustPlaylistMirrorState.delete(playerId);
                }
            }
        }, atMs));
    }
    rustPlaylistGainRampTimers.set(playerId, timers);
}

function scheduleRustPlaylistStop(playerId, delaySeconds = 0) {
    if (!playerId) return;
    cancelRustPlaylistGainRamp(playerId);
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    if (delayMs <= 25) {
        commandRustPlaylist('stop', { player: playerId }).catch(() => { });
        rustPlaylistMirrorState.delete(playerId);
        return;
    }
    const timer = setTimeout(() => {
        rustPlaylistGainRampTimers.delete(playerId);
        commandRustPlaylist('stop', { player: playerId }).catch(() => { });
        rustPlaylistMirrorState.delete(playerId);
    }, delayMs);
    rustPlaylistGainRampTimers.set(playerId, [timer]);
}

function findRustStatusPlayer(status = null, playerId = '') {
    const players = Array.isArray(status?.players) ? status.players : [];
    return players.find(player => player?.id === playerId) || null;
}

function getFreshPlaylistPlayerState(playerId = '') {
    const mix = buildMixDiagnostics();
    const players = Array.isArray(mix.players) ? mix.players : [];
    return players.find(player => player?.id === playerId) || null;
}

function isRustPlaylistPlayConfirmed(result, playerId = '') {
    if (!result?.ok) return false;
    const status = result.result?.status || result.result?.message || rustAudioProbeStatus.lastStatus || null;
    const rustPlayer = findRustStatusPlayer(status, playerId);
    return rustPlayer?.status === 'playing' && rustPlayer.audioReady !== false;
}

function resetRustPlaylistOwnerWatch(playerId = '') {
    rustPlaylistOwnerHealth.lastPlayerId = playerId;
    rustPlaylistOwnerHealth.lastPositionMs = null;
    rustPlaylistOwnerHealth.lastPositionAt = Date.now();
    rustPlaylistOwnerHealth.audioNotReadySince = 0;
}

function watchRustPlaylistOwnerHealth(status = null) {
    // Durante locuciones horarias de playlist el player HTML está activo pero Rust gestiona
    // el audio via 'time-locucion'; no aplicar stall-recovery a player-a/b en ese período.
    if (!isRustPlaylistOwnerEnabled() || !status || !currentPlayingRow || isPlayerClockPaused(activePlayer) || isPlaylistTimeActive) return;
    const playerId = getPlaylistPlayerId(activePlayer);
    if (!playerId) return;
    const rustPlayer = findRustStatusPlayer(status, playerId);
    if (!rustPlayer) return;
    const now = Date.now();
    const positionMs = Math.max(0, Number(rustPlayer.positionMs) || 0);
    if (rustPlaylistOwnerHealth.lastPlayerId !== playerId) resetRustPlaylistOwnerWatch(playerId);
    if (rustPlaylistOwnerHealth.lastPositionMs === null || Math.abs(positionMs - rustPlaylistOwnerHealth.lastPositionMs) > 40) {
        rustPlaylistOwnerHealth.lastPositionMs = positionMs;
        rustPlaylistOwnerHealth.lastPositionAt = now;
    }
    if (rustPlayer.audioReady === false) {
        if (!rustPlaylistOwnerHealth.audioNotReadySince) rustPlaylistOwnerHealth.audioNotReadySince = now;
    } else {
        rustPlaylistOwnerHealth.audioNotReadySince = 0;
    }
    const audioNotReadyMs = rustPlaylistOwnerHealth.audioNotReadySince ? now - rustPlaylistOwnerHealth.audioNotReadySince : 0;
    const stalledMs = now - (rustPlaylistOwnerHealth.lastPositionAt || now);
    const needsRecovery = rustPlayer.status !== 'playing'
        || audioNotReadyMs >= 2500
        || (rustPlayer.status === 'playing' && stalledMs >= 4500);
    if (!needsRecovery) return;
    if (now - rustPlaylistOwnerHealth.lastStallRecoveryAt < 1800) return;
    rustPlaylistOwnerHealth.lastStallRecoveryAt = now;
    const resumePositionMs = Math.max(positionMs, Math.round(getPlayerClockTime(activePlayer) * 1000));
    recordIncident(`[AIRE] Rust detecto player ${playerId} sin avance/audio listo. Reintentando reproduccion.`, { category: 'air', level: 'warn', autoAction: true, throttleKey: `rust-owner-stall:${playerId}` });
    commandRustPlaylist('seek', { player: playerId, positionMs: resumePositionMs })
        .then(() => commandRustPlaylist('play', { player: playerId }))
        .then(result => {
            if (!isRustPlaylistPlayConfirmed(result, playerId)) {
                setRustPlaylistOwnerFallback(rustPlayer.audioReady === false ? 'rust-player-audio-not-ready' : `rust-player-${rustPlayer.status || 'no-playing'}`);
            } else {
                resetRustPlaylistOwnerWatch(playerId);
            }
        })
        .catch(() => setRustPlaylistOwnerFallback('rust-player-recovery-failed'));
}

function setRustPlaylistOwnerFallback(reason = 'rust-playlist-owner-command-failed') {
    rustPlaylistOwnerHealth.active = false;
    rustPlaylistOwnerHealth.failures++;
    rustPlaylistOwnerHealth.fallbackUntil = isRustExclusiveAudioMode() ? Number.MAX_SAFE_INTEGER : Date.now() + 15000;
    rustPlaylistOwnerHealth.fallbackReason = reason;
    applyRustPlaylistOwnerMute();
}

function markRustPlaylistOwnerOk({ activate = false } = {}) {
    rustPlaylistOwnerHealth.lastOkAt = Date.now();
    rustPlaylistOwnerHealth.failures = 0;
    rustPlaylistOwnerHealth.fallbackUntil = 0;
    rustPlaylistOwnerHealth.fallbackReason = '';
    if (activate && isRustPlaylistOwnerEnabled()) {
        rustPlaylistOwnerHealth.active = true;
        applyRustPlaylistOwnerMute();
    }
}

function commandRustPlaylist(type, payload = {}) {
    return commandRustControlPlane(type, payload).then(result => {
        if (result?.ok === false && !result.skipped) {
            setRustPlaylistOwnerFallback(result.error || `${type}-failed`);
        } else if (!result?.skipped) {
            markRustPlaylistOwnerOk({ activate: type === 'play' && isRustPlaylistPlayConfirmed(result, payload.player || '') });
        }
        return result;
    }).catch(err => {
        setRustPlaylistOwnerFallback(err.message || String(err));
        throw err;
    });
}

function getRustPlaylistMirrorGain(playerState = {}) {
    const gain = Number(playerState.gain);
    if (!isRustPlaylistOwnerEnabled()) return 0;
    return Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1;
}

function shouldMirrorRustProgramToMonitor() {
    // Rust owns the program monitor mirror internally; the renderer must not create
    // parallel A/B players or it will drift and miss fades/overlays.
    return false;
    if (!isRustPlaylistOwnerEnabled()) return false;
    if (generalPrefs.monitorEnabled !== true) return false;
    const mainDeviceId = generalPrefs.outMain || 'default';
    const monitorDeviceId = generalPrefs.outMonitor || mainDeviceId;
    if (!monitorDeviceId || monitorDeviceId === mainDeviceId) return false;
    const rustMasterOutput = lastRustRouteOutputs.get('master');
    const rustMonitorOutput = lastRustRouteOutputs.get('monitor');
    if (lastRustMonitorRouteUsable === false) return false;
    if (rustMasterOutput && rustMonitorOutput && rustMasterOutput === rustMonitorOutput) return false;
    return true;
}

function getRustMonitorMirrorPlayerId(playerId = '') {
    return playerId ? `${playerId}-monitor` : '';
}

function syncRustMonitorMirror(livePlayers = [], { force = false, syncPosition = force } = {}) {
    const enabled = shouldMirrorRustProgramToMonitor();
    const liveIds = new Set(enabled ? livePlayers.map(player => getRustMonitorMirrorPlayerId(player.id)).filter(Boolean) : []);
    for (const [mirrorId] of rustMonitorMirrorState.entries()) {
        if (!liveIds.has(mirrorId)) {
            commandRustControlPlane('stop', { player: mirrorId }).catch(() => { });
            rustMonitorMirrorState.delete(mirrorId);
        }
    }
    if (!enabled) return;

    livePlayers.forEach(player => {
        const mirrorId = getRustMonitorMirrorPlayerId(player.id);
        if (!mirrorId || !player.path) return;
        const previous = rustMonitorMirrorState.get(mirrorId);
        const gain = getRustPlaylistMirrorGain(player) * Math.max(0, Math.min(1, (generalPrefs.monitorVolume ?? 100) / 100));
        const positionMs = Math.max(0, Math.round((Number(player.currentTime) || 0) * 1000));
        const sourceChanged = !previous || previous.path !== player.path;
        if (sourceChanged) {
            commandRustControlPlane('load', {
                player: mirrorId,
                bus: 'monitor',
                path: player.path,
                gain,
                autoplay: player.active === true
            }).then(result => {
                if (!result?.ok) return commandRustControlPlane('stop', { player: mirrorId });
                return commandRustControlPlane('seek', { player: mirrorId, positionMs });
            }).catch(() => { });
        } else {
            if (force || Math.abs((previous.gain ?? 0) - gain) > 0.015) {
                commandRustControlPlane('setGain', { player: mirrorId, gain }).catch(() => { });
            }
            if (player.active && previous.status !== 'playing') {
                commandRustControlPlane('play', { player: mirrorId }).catch(() => { });
            } else if (!player.active && previous.status === 'playing') {
                commandRustControlPlane('pause', { player: mirrorId }).catch(() => { });
            }
            const seekBucket = Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS);
            if (syncPosition === true || force || previous.seekBucket !== seekBucket) {
                commandRustControlPlane('seek', { player: mirrorId, positionMs }).catch(() => { });
            }
        }
        rustMonitorMirrorState.set(mirrorId, {
            path: player.path,
            gain,
            status: player.active ? 'playing' : 'paused',
            seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
        });
    });
}

function sendRustOwnerStopAll({ fadeSeconds = 0 } = {}) {
    if (!isRustPlaylistOwnerEnabled()) return;
    const safeFadeSeconds = Math.max(0, Number(fadeSeconds) || 0);
    rustPlaylistStopGuardUntil = Date.now() + Math.max(1200, Math.round((safeFadeSeconds * 1000) + 1200));
    clearRustPlaylistGainRamps();
    stopRustVirtualPlayback();
    ['player-a', 'player-b', 'player-a-aux', 'player-b-aux'].forEach(player => {
        const previous = rustPlaylistMirrorState.get(player) || {};
        const currentGain = Number.isFinite(Number(previous.gain)) ? Number(previous.gain) : 1;
        if (safeFadeSeconds > 0) {
            scheduleRustPlaylistGainRamp(player, currentGain, 0.0001, safeFadeSeconds, { stopAfter: true });
        } else {
            commandRustPlaylist('setGain', { player, gain: 0 }).catch(() => { });
            commandRustPlaylist('stop', { player }).catch(() => { });
            rustPlaylistMirrorState.delete(player);
        }
    });
    syncRustMonitorMirror([], { force: true });
    // Retardar la marca de inactivo para que los metros sigan respondiendo
    // durante el fade-out; si no hay fade, desactivar inmediatamente.
    if (safeFadeSeconds > 0) {
        setTimeout(() => { rustPlaylistOwnerHealth.active = false; }, safeFadeSeconds * 1000 + 150);
    } else {
        rustPlaylistOwnerHealth.active = false;
    }
    applyRustPlaylistOwnerMute();
}

function sendRustOwnerPauseActive() {
    if (!isRustPlaylistOwnerEnabled()) return false;
    const player = getPlaylistPlayerId(activePlayer);
    if (!player) return false;
    const auxPlayer = getRustPlaylistAuxPlayerId(player, currentPlayingRow);
    pauseRustVirtualPlayback();
    commandRustPlaylist('pause', { player }).catch(() => { });
    if (auxPlayer) commandRustControlPlane('pause', { player: auxPlayer }).catch(() => { });
    return true;
}

function sendRustOwnerPlayActive() {
    if (!isRustPlaylistOwnerEnabled()) return false;
    const player = getPlaylistPlayerId(activePlayer);
    if (!player) return false;
    const auxPlayer = getRustPlaylistAuxPlayerId(player, currentPlayingRow);
    const positionMs = Math.max(0, Math.round(getPlayerClockTime(activePlayer) * 1000));
    resumeRustVirtualPlayback();
    commandRustPlaylist('seek', { player, positionMs })
        .then(() => commandRustPlaylist('play', { player }))
        .catch(() => { });
    if (auxPlayer) {
        commandRustControlPlane('seek', { player: auxPlayer, positionMs })
            .then(() => commandRustControlPlane('play', { player: auxPlayer }))
            .catch(() => { });
    }
    return true;
}

function syncRustPlaylistControlPlane({ force = false, syncPosition = force } = {}) {
    if (!shouldMirrorRustControlPlane()) return;
    if (isRustPlaylistStopGuardActive()) return;
    // ── Guardia de saytime ──────────────────────────────────────────────────
    // Durante la locución horaria (isPlaylistTimeActive = true), el sistema de
    // saytime tiene el control exclusivo del bus jingle via 'time-locucion'.
    // Si dejamos correr esta función, buildMixDiagnostics() ve el archivo del
    // segmento cargado en playerA/playerB y manda commandRustPlaylist('load', {
    //   player: 'player-a', bus: 'pl1', path: segmento.filePath }) en conflicto
    // directo con el cartwallPlay al bus jingle → Rust reinicia el primer
    // segmento en lugar de avanzar al segundo. Limpiamos el monitor mirror y
    // salimos sin tocar ningún estado de playlist en Rust.
    if (isPlaylistTimeActive) {
        syncRustMonitorMirror([], { force: false });
        return;
    }
    if (!isRustPlaylistOwnerEnabled()) {
        rustPlaylistOwnerHealth.active = false;
    }
    const mix = buildMixDiagnostics();
    const players = Array.isArray(mix.players) ? mix.players : [];
    const livePlayers = players
        .filter(player => player?.id && player.path && (player.active || player.loaded || player.isFading))
        .slice(0, 2);
    const liveIds = new Set(livePlayers.map(player => player.id));
    if (livePlayers.length === 0) {
        rustPlaylistOwnerHealth.active = false;
        applyRustPlaylistOwnerMute();
    }
    syncRustMonitorMirror(livePlayers, { force, syncPosition });

    for (const [playerId, state] of rustPlaylistMirrorState.entries()) {
        if (!liveIds.has(playerId)) {
            const primaryPlayerId = getRustPrimaryPlayerId(playerId);
            if (primaryPlayerId !== playerId
                && liveIds.has(primaryPlayerId)
                && getRustPlaylistAuxPlayerId(primaryPlayerId, currentPlayingRow) === playerId) continue;
            if (rustPlaylistGainRampTimers.has(playerId)) continue;
            commandRustPlaylist('stop', { player: playerId }).catch(() => { });
            rustPlaylistMirrorState.delete(playerId);
        } else if (!isRustPlaylistOwnerEnabled() && state.owner === true) {
            commandRustPlaylist('setGain', { player: playerId, gain: 0 }).catch(() => { });
            rustPlaylistMirrorState.set(playerId, { ...state, owner: false, gain: 0 });
        }
    }

    livePlayers.forEach(player => {
        const previous = rustPlaylistMirrorState.get(player.id);
        const gain = getRustPlaylistMirrorGain(player);
        const positionMs = Math.max(0, Math.round((Number(player.currentTime) || 0) * 1000));
        const sourceChanged = !previous || previous.path !== player.path;
        const owner = isRustPlaylistOwnerEnabled();
        const rustBus = getRustPlaylistPrimaryBus(player.playlistIndex);
        if (sourceChanged) {
            commandRustPlaylist('load', {
                player: player.id,
                bus: rustBus,
                path: player.path,
                gain
            }).then(result => {
                if (!result?.ok) return commandRustPlaylist('stop', { player: player.id });
                return commandRustPlaylist('seek', { player: player.id, positionMs })
                    .then(() => {
                        const freshPlayer = getFreshPlaylistPlayerState(player.id) || player;
                        if (freshPlayer.active) return commandRustPlaylist('play', { player: player.id });
                        if (!owner) return commandRustPlaylist('pause', { player: player.id });
                        return null;
                    });
            }).catch(() => { });
        } else {
            if (force || Math.abs((previous.gain ?? 0) - gain) > 0.015 || previous.owner !== owner) {
                commandRustPlaylist('setGain', { player: player.id, gain }).catch(() => { });
            }
            if (player.active && previous.status !== 'playing') {
                commandRustPlaylist('play', { player: player.id }).catch(() => { });
            } else if (!player.active && previous.status === 'playing') {
                commandRustPlaylist('pause', { player: player.id }).catch(() => { });
            }
            const seekBucket = Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS);
            const shouldSyncSeek = owner
                ? syncPosition === true
                : (force || previous.seekBucket !== seekBucket);
            if (shouldSyncSeek) {
                commandRustPlaylist('seek', { player: player.id, positionMs }).catch(() => { });
            }
        }
        rustPlaylistMirrorState.set(player.id, {
            path: player.path,
            gain,
            owner,
            status: player.active ? 'playing' : 'paused',
            seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
        });
    });
}

function publishRustTransport({ force = false, syncPosition = force } = {}) {
    if (!shouldMirrorRustControlPlane()) return;
    applyRustPlaylistOwnerMute();
    const now = Date.now();
    if (!force && now - lastRustTransportPublishAt < 1500) return;
    const positionMs = Math.max(0, Math.round(getPlayerClockTime(activePlayer) * 1000));
    const durationMs = Math.max(0, Math.round((Number.isFinite(currentDuration) ? currentDuration : Number(activePlayer?.duration) || 0) * 1000));
    const status = !currentPlayingRow
        ? 'idle'
        : isPlayerClockPaused(activePlayer)
            ? 'paused'
            : 'playing';
    const player = activePlayer === playerB ? 'player-b' : 'player-a';
    const signature = `${player}|${status}|${Math.floor(positionMs / 1000)}|${durationMs}`;
    if (!force && signature === lastRustTransportSignature) return;
    lastRustTransportSignature = signature;
    lastRustTransportPublishAt = now;
    const mix = buildMixDiagnostics();
    commandRustControlPlane('transport', {
        player,
        status,
        positionMs,
        durationMs,
        startCause: currentPlaybackStartCause,
        mixActive: mix.active,
        mixPhase: mix.phase,
        mixDirection: mix.direction,
        mixReferencePlayer: mix.driftReferencePlayer || player
    }).catch(() => { });

    syncRustPlaylistControlPlane({ force, syncPosition });
}

function sendCurrentBroadcastMetadata() {
    const text = getVisibleCurrentSongText();
    ipcRenderer.send('update-metadata', text || IDLE_METADATA_TEXT);
    publishRustNowPlaying(text || IDLE_METADATA_TEXT);
    publishRustTransport({ force: true });
}

function setIdleBroadcastMetadata(updateDisplay = false) {
    if (updateDisplay) {
        const txtCancion = document.getElementById('txt-cancion');
        if (txtCancion) txtCancion.innerText = IDLE_METADATA_TEXT;
    }
    ipcRenderer.send('update-metadata', IDLE_METADATA_TEXT);
    publishRustNowPlaying(IDLE_METADATA_TEXT, { path: '', player: '', source: 'renderer-idle' });
    publishRustTransport({ force: true });
}

function resetPlaybackGuard() {
    playbackGuard.lastAdvanceAt = Date.now();
    playbackGuard.lastTimeValue = getPlayerClockTime(activePlayer);
    playbackGuard.cooldownUntil = 0;
    playbackGuard.activeToken = buildPlaybackGuardToken();
}

function triggerPlaybackGuardRecovery(reason) {
    const now = Date.now();
    if (now < playbackGuard.cooldownUntil) return;
    playbackGuard.cooldownUntil = now + PLAYBACK_GUARD_COOLDOWN_MS;
    setIncidentStatus('air', 'Recuperando', 'warn');
    recordIncident(`[GUARDIA AIRE] ${reason}. Intentando recuperar...`, { category: 'guard', level: 'warn', autoAction: true });
    if (currentPlayingRow && document.body.contains(currentPlayingRow) && !generalPrefs.modeRepeatTrack) {
        const resumeAt = getPlayerClockTime(activePlayer);
        if (resumeAt > 0.25) currentPlayingRow.dataset.resumeStart = resumeAt.toFixed(3);
        playRow(currentPlayingRow, false);
        return;
    }
    stopAll();
}

function clearPlaybackFatalHalt() {
    playbackFatalHalt = false;
}

function applyStopAfterVisualState() {
    const btn = document.getElementById('btn-stop-after');
    if (!btn) return;
    if (stopAfterCurrent) {
        btn.classList.add('active');
        btn.style.color = '#e74c3c';
        btn.style.borderColor = '#e74c3c';
    } else {
        btn.classList.remove('active');
        btn.style.color = '';
        btn.style.borderColor = '';
    }
}

function toggleStopAfter() {
    stopAfterCurrent = !stopAfterCurrent;
    applyStopAfterVisualState();
    updateNextTrackVisuals();
}

// Conectar el botón "Pausar Fin" al click
(function () {
    const btnStopAfter = document.getElementById('btn-stop-after');
    if (btnStopAfter) btnStopAfter.addEventListener('click', toggleStopAfter);
})();

function updateAppTitle(text = '') {
    const base = 'LF Automatizador v0.9.0';
    document.title = text ? `${text} - ${base}` : base;
}

function updateMediaSessionStatus(title, artist = '') {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'LF Automatizador',
        artist: artist || 'Radio',
        album: 'LF Automatizador',
        artwork: [{ src: 'assets/icon.png', sizes: '512x512', type: 'image/png' }]
    });
}

function preloadNextTrack() {
    const next = resolvePriorityNextRow(queuedNextRow);
    if (!next || isPlaylistCommandRow(next)) return;
    const filePath = next.dataset.ruta;
    if (filePath) warmTrackFromLibraryAndFile(filePath);
}



function haltPlaybackOnFatalError(message, options = {}) {
    playbackFatalHalt = true;
    playbackHoldByUser = true;
    stopAfterCurrent = false;
    applyStopAfterVisualState();
    cancelPendingPlayerStop(playerA);
    cancelPendingPlayerStop(playerB);
    queuedNextRow = null;
    crossfadeTriggered = false;
    isPlaylistTimeActive = false;
    if (rustTimeLocutionContext) {
        commandRustControlPlane('stop', { player: 'time-locucion' }).catch(() => {});
        rustTimeLocutionContext = null;
    }
    stopRustVirtualPlayback();
    [playerA, playerB].forEach(player => {
        try { player.pause(); } catch (err) { }
        try { player.removeAttribute('src'); player.load(); } catch (err) { }
        clearPlayerPlaybackMeta(player);
    });
    try { ipcRenderer.send('emergency-stop-playback'); } catch (err) { }
    setIdleBroadcastMetadata(true);
    if (currentPlayingRow && document.body.contains(currentPlayingRow)) currentPlayingRow.classList.remove('row-active');
    currentPlayingRow = null;
    trackStartTime = null;
    isTrackReady = false;
    const visibleMessage = message || 'Reproduccion detenida por error de audio.';
    logSystem(`[ERROR CRITICO] ${visibleMessage}`);
    recordIncident(`[AIRE] ${visibleMessage}`, { category: 'air', level: 'error', autoAction: options.autoAction === true });
    setIncidentStatus('air', 'Detenido por error', 'error');
    updateNextTrackVisuals();
    refreshAirIncidentStatus();
    resetPlaybackGuard();
    saveSessionSnapshot();
}

function runPlaybackGuard() {
    if (playbackHoldByUser || stopAfterCurrent || !currentPlayingRow || !isTrackReady) return;
    if (!document.body.contains(currentPlayingRow)) return;

    const token = buildPlaybackGuardToken();
    const now = Date.now();
    if (playbackGuard.activeToken !== token) {
        resetPlaybackGuard();
        return;
    }
    if (now < playbackGuard.cooldownUntil) return;

    const currentTime = getPlayerClockTime(activePlayer);
    const pgmSilent = isRustVirtualPlayer(activePlayer) ? false : lastProgramPeakPercent <= PLAYBACK_GUARD_SILENCE_THRESHOLD;
    const timeSinceAdvance = now - playbackGuard.lastAdvanceAt;

    if (!isPlayerClockPaused(activePlayer) && currentTime > playbackGuard.lastTimeValue + 0.05) {
        playbackGuard.lastTimeValue = currentTime;
        playbackGuard.lastAdvanceAt = now;
        return;
    }

    if (!isPlayerClockPaused(activePlayer) && !activePlayer.ended && !activePlayer.seeking && pgmSilent && timeSinceAdvance >= PLAYBACK_GUARD_STALL_MS) {
        triggerPlaybackGuardRecovery('Posible cuelgue del reproductor principal');
        return;
    }

    if (isPlayerClockPaused(activePlayer) && currentTime > 0.25 && pgmSilent && timeSinceAdvance >= PLAYBACK_GUARD_PAUSE_MS) {
        triggerPlaybackGuardRecovery('Pausa inesperada en el aire');
    }
}

async function loadDatabasesFromSQLite() {
    try {
        const [events, groups] = await Promise.all([
            ipcRenderer.invoke('db-get-events'),
            ipcRenderer.invoke('db-get-groups')
        ]);
        eventsMasterDB = Array.isArray(events) ? events : [];
        eventGroupsDB = Array.isArray(groups) ? groups : [];
        if (eventGroupsDB.length === 0) { eventGroupsDB = [{ id: 'g_general', name: 'General', colorBg: '#222225', colorText: '#00a8ff', readonly: true }]; }
        renderEventsList();
        updateEventCountdowns();
    } catch (err) { }
}

async function ensureGenreProfilesLoaded(force = false) {
    if (!force && Array.isArray(genreProfiles) && genreProfiles.length > 0) return genreProfiles;
    try {
        genreProfiles = await ipcRenderer.invoke('lib-get-genre-profiles') || [];
    } catch (err) {
        genreProfiles = [];
    }
    return genreProfiles;
}

async function ensureDbTracksLoaded(paths) {
    const safePaths = Array.isArray(paths)
        ? [...new Set(paths.filter(filePath => filePath && !manualCuesDB[filePath]))]
        : [];
    if (safePaths.length === 0) return;
    try {
        const scoped = await ipcRenderer.invoke('lib-get-db-tracks', safePaths, { includeSignatures: false });
        manualCuesDB = { ...manualCuesDB, ...(scoped || {}) };
    } catch (err) { }
}

async function restoreSessionState() {
    const state = loadConfig(sessionStatePath, null);
    if (!state || !Array.isArray(state.playlists)) {
        setIncidentStatus('session', 'Nueva', 'manual');
        return false;
    }

    const sessionPaths = [];
    state.playlists.forEach(rows => {
        if (!Array.isArray(rows)) return;
        rows.forEach(item => {
            if (item?.ruta && (item.type || 'normal') === 'normal') sessionPaths.push(item.ruta);
        });
    });
    await ensureDbTracksLoaded(sessionPaths);

    isRestoringSession = true;
    try {
        currentPlayingRow = null;
        queuedNextRow = null;
        beginBulkInsert();
        try {
            tbodys.forEach(tbody => { tbody.innerHTML = ''; });
            state.playlists.forEach((rows, tabIndex) => {
                const targetTbody = tbodys[tabIndex];
                if (!targetTbody || !Array.isArray(rows)) return;
                let lastInsertedRow = null;
                rows.forEach(item => {
                    const rowType = item.type || 'normal';
                    const rowName = rowType === 'playlist_jump' ? item.targetTab : (rowType === 'note' ? (item.noteText || item.titulo || '') : item.titulo);
                    lastInsertedRow = createPlaylistRow(item.ruta, rowName, parseInt(item.duracion, 10) || 0, rowType, lastInsertedRow, 'bottom', targetTbody);
                    if (lastInsertedRow && rowType === 'playlist_jump' && Number.isInteger(parseInt(item.targetTab, 10))) lastInsertedRow.dataset.targetTab = parseInt(item.targetTab, 10);
                    if (lastInsertedRow && rowType === 'note' && item.noteText) lastInsertedRow.dataset.noteText = item.noteText;
                    if (!lastInsertedRow) return;
                    if (item.customMix) lastInsertedRow.dataset.customMix = item.customMix;
                    if (item.temp || /^[\u23f3\u231b]/.test(item.titulo || '')) lastInsertedRow.dataset.temp = 'true';
                });
            });
        } finally {
            endBulkInsert();
        }

        const storedPgmTab = Number.isInteger(state.pgmTab) && tbodys[state.pgmTab] ? state.pgmTab : 0;
        pgmTab = storedPgmTab;

        const resumeRow = state.currentPlaying?.location ? getRowByLocation(state.currentPlaying.location) : null;
        const queuedRow = state.queuedNext ? getRowByLocation(state.queuedNext) : null;
        const preferredViewTab = resumeRow
            ? (getRowLocation(resumeRow)?.tab ?? storedPgmTab)
            : (Number.isInteger(state.currentViewTab) && tbodys[state.currentViewTab] ? state.currentViewTab : storedPgmTab);

        applySessionViewState(preferredViewTab);

        stopAfterCurrent = state.stopAfterCurrent === true;
        applyStopAfterVisualState();

        if (resumeRow) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            resumeRow.classList.add('selected-row');
            const resumeRows = Array.from(resumeRow.closest('tbody').children);
            lastSelectedRowIndex = resumeRows.indexOf(resumeRow);
            anchorRowIndex = lastSelectedRowIndex;
            queuedNextRow = resumeRow;
            const resumeName = (resumeRow.dataset.pureName || resumeRow.children[1].innerText || '').replace(/^(?:\u23f3|⏳)\s*/, '');
            setIncidentStatus('session', 'Restaurada', 'ok');
            recordIncident(`[SESION] Lista restaurada. Lista para retomar con: ${resumeName}`, { category: 'session', level: 'success' });
        } else if (queuedRow) {
            queuedNextRow = queuedRow;
            setIncidentStatus('session', 'Restaurada', 'ok');
        } else {
            setIncidentStatus('session', 'Nueva', 'manual');
        }

        updateTabsUI();
        calcularHorasPlaylist();
        updateNextTrackVisuals();
        ensurePlaybackRowsVisible({ forcePgmView: true, centerCurrent: true });
        return true;
    } catch (err) {
        setIncidentStatus('session', 'Error', 'error');
        recordIncident('[SESION] No se pudo restaurar la sesion guardada.', { category: 'session', level: 'error' });
        return false;
    } finally {
        isRestoringSession = false;
        saveSessionSnapshot(true);
    }
}

function scheduleCartwallWarmup(forceRender = false) {
    const startWarmup = () => {
        initCartwall({ forceRender }).catch(() => { });
    };

    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => startWarmup(), { timeout: 500 });
    } else {
        setTimeout(startWarmup, 180);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initIncidentCenter();
    initRotationModal();
    const chkEventsMaster = document.getElementById('chk-events-master');
    const chkEventsManual = document.getElementById('chk-events-manual');
    if (chkEventsMaster) chkEventsMaster.checked = generalPrefs.eventsMasterActive !== false;
    if (chkEventsManual) chkEventsManual.checked = generalPrefs.eventsManualOnly === true;
    applyEventsUIState();

    if (uiPrefs.controlsPos === 'bottom') {
        const mainContent = document.querySelector('.main-content');
        const controlsBar = document.querySelector('.controls-bar');
        const playlistFooter = document.querySelector('.playlist-footer');
        if (mainContent && controlsBar && playlistFooter) mainContent.insertBefore(controlsBar, playlistFooter);
    }

    document.querySelectorAll('#temperatura, .temperatura, #temp, .temp, #txt-temperatura, #lbl-temp, #clima-temp, #weather-temp, #txt-temp, #temp-widget').forEach(el => el.style.display = uiPrefs.temp ? '' : 'none');
    document.querySelectorAll('#humedad, .humedad, #hum, .hum, #txt-humedad, #lbl-hum, #clima-hum, #weather-hum, #txt-hum, #hum-widget').forEach(el => el.style.display = uiPrefs.hum ? '' : 'none');

    const tabsEl = document.querySelector('.tabs');
    if (tabsEl && tabsEl.parentElement) tabsEl.parentElement.style.display = uiPrefs.leftPanel ? '' : 'none';

    const incidentPanel = document.getElementById('incident-panel');
    if (incidentPanel) incidentPanel.style.display = uiPrefs.sysLog ? '' : 'none';

    const btnModeLoop = document.getElementById('btn-mode-looplist');
    if (btnModeLoop && generalPrefs.modeLoopPlaylist) btnModeLoop.classList.add('active-loop');

    const toolbarGroup = document.querySelector('.toolbar-left-tools');
    if (toolbarGroup && !document.getElementById('btn-open-cartwall')) {
        const rotationButton = document.createElement('button');
        rotationButton.id = 'btn-open-rotation';
        rotationButton.className = 'toolbar-btn toolbar-btn-icon-only';
        rotationButton.title = 'Generador de Playlists (en desarrollo)';
        rotationButton.innerHTML = '<span class="toolbar-btn-icon">🧩</span>';
        rotationButton.addEventListener('click', () => { openRotationModal(); });
        toolbarGroup.appendChild(rotationButton);

        const cartwallButton = document.createElement('button');
        cartwallButton.id = 'btn-open-cartwall';
        cartwallButton.className = 'toolbar-btn';
        cartwallButton.title = 'Abrir botonera de efectos flotante';
        cartwallButton.innerHTML = '<span class="toolbar-btn-icon">🎛️</span><span class="toolbar-btn-label">CW</span>';
        cartwallButton.classList.add('toolbar-btn-icon-only');
        cartwallButton.innerHTML = '<span class="toolbar-btn-icon">🎛️</span>';
        cartwallButton.addEventListener('click', () => { openCartwallFloating(); });
        toolbarGroup.appendChild(cartwallButton);
    }

    const lblT = document.getElementById('lbl-tiempo');
    const txtT = document.getElementById('txt-tiempo');
    if (lblT) lblT.innerText = uiPrefs.showRemainingTime ? "Tiempo restante" : "Tiempo transcurrido";
    if (txtT) {
        txtT.style.cursor = 'pointer';
        txtT.addEventListener('click', () => {
            uiPrefs.showRemainingTime = !uiPrefs.showRemainingTime;
            saveConfig(uiPrefsPath, uiPrefs);
            if (lblT) lblT.innerText = uiPrefs.showRemainingTime ? "Tiempo restante" : "Tiempo transcurrido";
            if (activePlayer && (!isPlayerClockPaused(activePlayer) || getPlayerClockTime(activePlayer) > 0)) { handleTimeUpdate(activePlayer); }
            else { txtT.innerText = "00:00.0"; clearAirTimeSegmentState(); }
        });
    }

    initPlaylistColumnResizers();

    document.querySelectorAll('.pl-tab').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            tbodys[currentViewTab].style.display = 'none';
            currentViewTab = idx;
            ipcRenderer.send('active-tab-changed', idx);
            playlistBody = tbodys[currentViewTab];
            playlistBody.style.display = 'table-row-group';
            updateTabsUI();
            calcularHorasPlaylist();
            updateNextTrackVisuals();
        });
        // Drag & Drop Intelligent Routing
        btn.addEventListener('dragover', (e) => {
            e.preventDefault();
            btn.style.boxShadow = 'inset 0 0 10px #00a8ff';
        });
        btn.addEventListener('dragleave', () => {
            btn.style.boxShadow = '';
        });
        btn.addEventListener('drop', async (e) => {
            e.preventDefault();
            btn.style.boxShadow = '';
            let targetTbodyForDrop = tbodys[idx];

            if (draggedTableRow) {
                let rowsToMove = Array.from(document.querySelectorAll('.selected-row'));
                if (!rowsToMove.includes(draggedTableRow)) rowsToMove = [draggedTableRow];
                rowsToMove.forEach(row => targetTbodyForDrop.appendChild(row));
                try { clearPlaylistDragState(); } catch (e) { }
                draggedTableRow = null;
                calcularHorasPlaylist();
                updateNextTrackVisuals();
                return;
            }

            let lastRow = null;
            try { beginBulkInsert(); } catch (e) { }
            try {
                const droppedFilePaths = getDroppedFilePaths(e.dataTransfer);
                if (droppedFilePaths.length > 0) {
                    for (let filePath of droppedFilePaths) {
                        lastRow = await handleDroppedItem(filePath, lastRow, 'bottom', targetTbodyForDrop);
                    }
                } else if (e.dataTransfer.types.includes('lf_genre_key') || Array.from(e.dataTransfer.types).some(t => t.toLowerCase() === 'lf_genre_key')) {
                    const genreKey = e.dataTransfer.getData('lf_genre_key');
                    if (genreKey) {
                        const result = await ipcRenderer.invoke('genre-editor-get-tracks', genreKey);
                        if (result?.success && result.tracks) {
                            for (let t of result.tracks) {
                                lastRow = await handleDroppedItem(t.filePath, lastRow, 'bottom', targetTbodyForDrop);
                            }
                        }
                    }
                } else if (e.dataTransfer.types.includes('application/json')) {
                    try {
                        const paths = JSON.parse(e.dataTransfer.getData('application/json'));
                        for (let p of paths) {
                            lastRow = await handleDroppedItem(p, lastRow, 'bottom', targetTbodyForDrop);
                        }
                    } catch (err) { }
                }
            } finally {
                try { endBulkInsert(); } catch (e) { }
                calcularHorasPlaylist();
                updateNextTrackVisuals();
            }
        });
    });

    const cwPanel = document.getElementById('right-panel-cartwall');
    if (cwPanel) {
        cwPanel.style.display = uiPrefs.cartwall ? 'flex' : 'none';
    }

    loadDatabasesFromSQLite().finally(() => { restoreSessionState(); });
    if (uiPrefs.cartwall) scheduleCartwallWarmup(true);
});

function logSystem(msg) {
    recordIncident(msg);
}

function persistRendererError(kind, payload) {
    try {
        const runtimeErrorPath = path.join(configDir, 'renderer_runtime_errors.txt');
        const stamp = new Date().toISOString();
        const line = `[${stamp}] ${kind}: ${payload}\n`;
        fs.appendFileSync(runtimeErrorPath, line, 'utf-8');
    } catch (err) { }
}

window.onerror = function (message, source, lineno, colno, error) {
    const details = `${message || 'Error desconocido'} | ${source || 'sin fuente'}:${lineno || 0}:${colno || 0} | ${error?.stack || 'sin stack'}`;
    persistRendererError('window.onerror', details);
    try { console.error(details); } catch (err) { }
    return true;
};

window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    const details = reason?.stack || reason?.message || String(reason);
    persistRendererError('unhandledrejection', details);
    try { console.error(details); } catch (err) { }
});

ipcRenderer.on('editor-handle-request-track', (e, data) => {
    const rows = Array.from(playlistBody.children);
    const idx = rows.findIndex(tr => tr.dataset.ruta === data.current);
    if (idx !== -1) {
        let nextIdx = data.dir === 'next' ? idx + 1 : idx - 1;
        if (nextIdx >= 0 && nextIdx < rows.length) { ipcRenderer.send('open-audio-editor', rows[nextIdx].dataset.ruta); }
    }
});

ipcRenderer.on('force-metadata-update', () => {
    if (!isPlaybackActuallyOnAir()) {
        setIdleBroadcastMetadata();
        return;
    }
    sendCurrentBroadcastMetadata();
});

ipcRenderer.on('refresh-manual-cues', async () => {
    const playlistPaths = Array.from(document.querySelectorAll('.playlist-table tr'))
        .map(tr => tr.dataset.ruta)
        .filter(Boolean);
    if (playlistPaths.length > 0) {
        const scoped = await ipcRenderer.invoke('lib-get-db-tracks', playlistPaths, { includeSignatures: false });
        manualCuesDB = { ...manualCuesDB, ...(scoped || {}) };
    }
    document.querySelectorAll('.playlist-table tr').forEach(tr => {
        const ruta = tr.dataset.ruta;
        if (normalizeTimeLocutionRow(tr)) return;
        if (manualCuesDB[ruta]) {
            const mc = manualCuesDB[ruta];
            let artistStr = mc.customArtist ? mc.customArtist + ' - ' : '';
            let titleStr = mc.customTitle || path.basename(ruta).replace(/\.[^/.]+$/, "");
            let newTitle = artistStr + titleStr;
            tr.dataset.pureName = newTitle;
            let displayedName = window.showPlaylistExtensions ? (newTitle + tr.dataset.ext) : newTitle;
            if (tr.dataset.temp === 'true') displayedName = ICON_TEMP_PREFIX + displayedName;
            tr.children[1].innerText = displayedName;
            tr.children[3].innerText = mc.intro ? parseFloat(mc.intro).toFixed(1) : '0.0';
            tr.children[4].innerText = mc.outro ? parseFloat(mc.outro).toFixed(1) : '0.0';
        }
    });
});

ipcRenderer.on('toggle-extensions', (e, show) => {
    window.showPlaylistExtensions = show;
    uiPrefs.ext = show; saveConfig(uiPrefsPath, uiPrefs);
    document.querySelectorAll('.playlist-table tr').forEach(tr => {
        const td = tr.children[1];
        if (td) { td.innerText = show ? ((tr.dataset.pureName || '') + (tr.dataset.ext || '')) : (tr.dataset.pureName || td.innerText); }
    });
});

ipcRenderer.on('set-controls-position', (e, position) => {
    const mainContent = document.querySelector('.main-content');
    const controlsBar = document.querySelector('.controls-bar');
    const playlistSection = document.querySelector('.playlist-section');
    const playlistFooter = document.querySelector('.playlist-footer');
    uiPrefs.controlsPos = position; saveConfig(uiPrefsPath, uiPrefs);
    if (mainContent && controlsBar && playlistSection && playlistFooter) {
        if (position === 'bottom') { mainContent.insertBefore(controlsBar, playlistFooter); }
        else { mainContent.insertBefore(controlsBar, playlistSection); }
    }
});

ipcRenderer.on('toggle-temperature', (e, show) => {
    uiPrefs.temp = show; saveConfig(uiPrefsPath, uiPrefs);
    document.querySelectorAll('#temperatura, .temperatura, #temp, .temp, #txt-temperatura, #lbl-temp, #clima-temp, #weather-temp, #txt-temp, #temp-widget').forEach(el => el.style.display = show ? '' : 'none');
});

ipcRenderer.on('toggle-humidity', (e, show) => {
    uiPrefs.hum = show; saveConfig(uiPrefsPath, uiPrefs);
    document.querySelectorAll('#humedad, .humedad, #hum, .hum, #txt-humedad, #lbl-hum, #clima-hum, #weather-hum, #txt-hum, #hum-widget').forEach(el => el.style.display = show ? '' : 'none');
});

ipcRenderer.on('toggle-left-panel', (e, show) => {
    uiPrefs.leftPanel = show; saveConfig(uiPrefsPath, uiPrefs);
    const tabsEl = document.querySelector('.tabs');
    if (tabsEl && tabsEl.parentElement) { tabsEl.parentElement.style.display = show ? '' : 'none'; }
});

ipcRenderer.on('toggle-sys-log', (e, show) => {
    uiPrefs.sysLog = show; saveConfig(uiPrefsPath, uiPrefs);
    const incidentPanel = document.getElementById('incident-panel');
    if (incidentPanel) incidentPanel.style.display = show ? '' : 'none';
});

ipcRenderer.on('incident-request-sync', () => {
    pushIncidentSnapshot();
});

const explorerContainer = document.getElementById('file-explorer');

let currentPlayingRow = null;
let queuedNextRow = null;
let currentDuration = 0;
let trackStartTime = null;
let eventPreHoldActive = false;
let eventPreHoldTimer = null;
let eventPreHoldKey = null;
let contextMenuTargetFolder = null;
let rightClickedRow = null;
let currentPlaylistPath = null;

let stopAfterCurrent = false;
let playbackHoldByUser = false;
let playbackFatalHalt = false;

const explorerFolderMenu = document.getElementById('explorer-folder-menu');
const explorerFileMenu = document.getElementById('explorer-file-menu');
const playlistContextMenu = document.getElementById('playlist-context-menu');
const eventsListMenu = document.getElementById('events-list-menu');
const groupContextMenu = document.getElementById('group-context-menu');
const eimMenu = document.getElementById('event-item-menu');

let lastSelectedRowIndex = -1; let anchorRowIndex = -1; let draggedTableRow = null;
let lastSelectedExplorerIndex = -1; let anchorExplorerIndex = -1; let explorerItemsCache = [];
let clipboardData = []; let clipboardAction = null;
// Estado de la locución horaria (delegada al motor Rust). `isPlaylistTimeActive`
// es el único flag que el renderer necesita seguir manteniendo — sirve para que
// handleTimeUpdate/handleEnded/recalcEndTime sepan que el reloj corre por
// Date.now() en lugar del <audio> HTML. El motor Rust hace el resto.
let isPlaylistTimeActive = false;
// Contexto de la locución horaria en curso (delegada al motor Rust). El motor
// emite `timeLocutionEnded` cuando termina y el listener IPC lo usa para
// reaccionar (avanzar la playlist, liberar el ducking de la botonera, etc.).
//   kind: 'button'   → disparada desde la botonera del bus jingle
//   kind: 'playlist' → disparada desde una fila tipo 'time' de la playlist
//   sessionId        → snapshot de playRowSessionId para descartar eventos
//                      rezagados que correspondan a una sesión vieja
//   row              → fila de playlist asociada (solo kind='playlist')
let rustTimeLocutionContext = null;

let isTrackReady = false;
let lastProgramPeakPercent = 0;
let lastTimeUiRenderAt = 0;
let lastVuIpcSentAt = 0;
let lastVuDiagnosticsIpcSentAt = 0;
let playbackGuard = { lastAdvanceAt: 0, lastTimeValue: 0, cooldownUntil: 0, activeToken: '' };
let randomBagsCache = {};
const randomFolderFileCache = new Map();
let ignoredEventTriggers = [];
const EVENT_PREFLIGHT_WINDOW_SECONDS = 15 * 60;
const EVENT_PREFLIGHT_RECHECK_MS = 30000;
const EVENT_PREFLIGHT_FINAL_RECHECK_MS = 10000;
const EVENT_TIMELINE_LIMIT = 3;
const eventRuntimeQueue = new Map();
const eventPreflightPromises = new Map();
let lastEventTimelineRenderAt = 0;

function isDateValidForEvent(d, ev) {
    if (ev.dayMode === 'specific' && ev.specificDays && ev.specificDays.length > 0) { if (!ev.specificDays.includes(d.getDay())) return false; }
    const testDate = new Date(d.getTime()); testDate.setHours(0, 0, 0, 0);
    if (ev.validityStart) { const start = new Date(ev.validityStart + 'T00:00:00'); if (testDate < start) return false; }
    if (ev.validityEnd) { const end = new Date(ev.validityEnd + 'T00:00:00'); if (testDate > end) return false; }
    if (ev.dayMode === 'monthlyWeeks') {
        if (!ev.targetWeeks || ev.targetWeeks.length === 0) return false;
        const dom = d.getDate();
        const weekIds = [Math.min(5, Math.ceil(dom / 7))];
        const plusSeven = new Date(d.getTime());
        plusSeven.setDate(dom + 7);
        if (plusSeven.getMonth() !== d.getMonth()) weekIds.push(5);
        if (!ev.targetWeeks.some(week => weekIds.includes(week))) return false;
    }
    return true;
}

function getExpandedEventTimes(ev) {
    if (!ev || !ev.primaryTime) return [];
    let baseTimes = [ev.primaryTime];
    if (ev.otherHours && ev.otherHours.length > 0) { const [pH, pM, pS] = ev.primaryTime.split(':'); ev.otherHours.forEach(hNum => { baseTimes.push(`${hNum.toString().padStart(2, '0')}:${pM}:${pS}`); }); }
    let allTimes = new Set(baseTimes);
    if (ev.cyclicActive && ev.cyclicInterval > 0 && ev.cyclicLimit > 0) {
        baseTimes.forEach(bt => {
            let [h, m, s] = bt.split(':').map(Number);
            for (let i = 1; i <= ev.cyclicLimit; i++) {
                let d = new Date(); d.setHours(h, m, s, 0);
                if (ev.cyclicUnit === 'minutes') { d.setMinutes(d.getMinutes() + (ev.cyclicInterval * i)); } else if (ev.cyclicUnit === 'hours') { d.setHours(d.getHours() + (ev.cyclicInterval * i)); }
                allTimes.add(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`);
            }
        });
    }
    return Array.from(allTimes);
}

function getQueuedDelayInfo(eventId) {
    const queuedRow = document.querySelector(`.playlist-table tr[data-event-id="${eventId}"][data-queued-at]`);
    if (!queuedRow) return null;
    const queuedAt = parseInt(queuedRow.dataset.queuedAt || 0); const maxDelayMs = parseInt(queuedRow.dataset.maxDelay || 0);
    if (!queuedAt || !maxDelayMs) return null;
    const elapsedMs = Date.now() - queuedAt; const remainingMs = Math.max(0, maxDelayMs - elapsedMs);
    return { row: queuedRow, remainingSeconds: Math.ceil(remainingMs / 1000) };
}

function isSupportedAudioName(fileName) {
    return /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(fileName || '');
}

async function inspectEventSource(filePath, sourceType) {
    try {
        if (sourceType === 'commercial') {
            const blocks = await ipcRenderer.invoke('commercial-get-blocks');
            const block = Array.isArray(blocks) ? blocks.find(item => item.id === filePath) : null;
            if (!block) return { ok: false, message: 'Bloque comercial no encontrado', summary: 'sin bloque' };
            const items = Array.isArray(block.items) ? block.items : [];
            if (items.length === 0) return { ok: false, message: 'Bloque comercial sin piezas', summary: '0 piezas' };
            let missingCount = 0;
            let randomFoldersEmpty = 0;
            items.forEach(item => {
                if (item?.sourceType === 'time') return;
                if (!item?.filePath || !fs.existsSync(item.filePath)) {
                    missingCount++;
                    return;
                }
                if (item.sourceType === 'random') {
                    try {
                        const stats = fs.statSync(item.filePath);
                        if (!stats.isDirectory()) {
                            missingCount++;
                            return;
                        }
                        const files = fs.readdirSync(item.filePath).filter(isSupportedAudioName);
                        if (files.length === 0) randomFoldersEmpty++;
                    } catch (err) {
                        missingCount++;
                    }
                }
            });
            if (missingCount > 0) return { ok: false, message: `Bloque comercial con ${missingCount} ruta(s) faltante(s)`, summary: `${items.length} pieza(s)` };
            if (randomFoldersEmpty > 0) return { ok: false, message: `Bloque comercial con ${randomFoldersEmpty} carpeta(s) aleatoria(s) vacia(s)`, summary: `${items.length} pieza(s)` };
            return { ok: true, message: 'Bloque comercial listo', summary: `${items.length} pieza(s)` };
        }
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: 'Fuente no encontrada', summary: 'sin ruta' };
        if (sourceType === 'folder') {
            const stats = fs.statSync(filePath); if (!stats.isDirectory()) return { ok: false, message: 'La ruta no es una carpeta', summary: 'carpeta invalida' };
            const files = fs.readdirSync(filePath).filter(isSupportedAudioName);
            if (files.length === 0) return { ok: false, message: 'Carpeta sin audios compatibles', summary: '0 audios' };
            return { ok: true, message: 'Carpeta lista', summary: `${files.length} audio(s)` };
        } else if (filePath.toLowerCase().endsWith('.lfplay')) {
            const content = await fs.promises.readFile(filePath, 'utf-8'); const data = JSON.parse(content);
            if (!Array.isArray(data) || data.length === 0) return { ok: false, message: 'Lista LFPlay vacia', summary: '0 pistas' };
            let missingCount = 0; let randomFoldersEmpty = 0;
            data.forEach(item => {
                if (!item || !item.ruta || item.type === 'time' || item.type === 'commercial') return;
                if (!fs.existsSync(item.ruta)) { missingCount++; return; }
                if (item.type === 'random') {
                    try {
                        const stats = fs.statSync(item.ruta);
                        if (!stats.isDirectory()) { missingCount++; return; }
                        const files = fs.readdirSync(item.ruta).filter(isSupportedAudioName);
                        if (files.length === 0) randomFoldersEmpty++;
                    } catch (err) { missingCount++; }
                }
            });
            if (missingCount > 0) return { ok: false, message: `Lista LFPlay con ${missingCount} ruta(s) faltante(s)`, summary: `${data.length} pista(s)` };
            if (randomFoldersEmpty > 0) return { ok: false, message: `Lista LFPlay con ${randomFoldersEmpty} carpeta(s) aleatoria(s) vacia(s)`, summary: `${data.length} pista(s)` };
            return { ok: true, message: 'Lista LFPlay lista', summary: `${data.length} pista(s)` };
        }
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return { ok: false, message: 'La ruta no es un archivo', summary: 'archivo invalido' };
        if (!isSupportedAudioName(filePath)) return { ok: false, message: 'Formato de audio no compatible', summary: path.extname(filePath) || 'sin extension' };
        return { ok: true, message: 'Archivo listo', summary: path.basename(filePath) };
    } catch (e) { return { ok: false, message: 'No se pudo verificar la fuente', summary: 'error de lectura' }; }
}

async function checkPlaylistIntegrity(filePath, sourceType) {
    const inspection = await inspectEventSource(filePath, sourceType);
    return inspection.ok;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[array[i], array[j]] = [array[j], array[i]]; } return array;
}

function getCachedRandomFolderFiles(folderPath) {
    const cached = randomFolderFileCache.get(folderPath);
    if (!cached || !Array.isArray(cached.files)) return null;
    if ((Date.now() - cached.loadedAt) > RANDOM_FOLDER_CACHE_TTL_MS) return null;
    return cached.files;
}

async function warmRandomFolder(folderPath) {
    if (!folderPath) return [];
    const cached = getCachedRandomFolderFiles(folderPath);
    if (cached) return cached;
    const existing = randomFolderFileCache.get(folderPath);
    if (existing?.promise) return existing.promise;
    const promise = fs.promises.readdir(folderPath, { withFileTypes: true })
        .then(entries => entries
            .filter(entry => entry.isFile() && isSupportedAudioName(entry.name))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' })))
        .then(files => {
            randomFolderFileCache.set(folderPath, { files, loadedAt: Date.now(), promise: null });
            return files;
        })
        .catch(() => {
            randomFolderFileCache.delete(folderPath);
            return [];
        });
    randomFolderFileCache.set(folderPath, { files: null, loadedAt: 0, promise });
    return promise;
}

function getRandomFolderFilesFast(folderPath) {
    const cached = getCachedRandomFolderFiles(folderPath);
    if (cached) return cached;
    try {
        const files = fs.readdirSync(folderPath)
            .filter(isSupportedAudioName)
            .sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
        randomFolderFileCache.set(folderPath, { files, loadedAt: Date.now(), promise: null });
        return files;
    } catch (err) {
        return [];
    }
}

function takeRandomFolderFile(folderPath) {
    const files = getRandomFolderFilesFast(folderPath);
    if (files.length === 0) return null;
    if (!randomBagsCache[folderPath] || randomBagsCache[folderPath].length === 0) {
        randomBagsCache[folderPath] = shuffleArray([...files]);
    }
    const nextFile = randomBagsCache[folderPath].pop();
    return nextFile ? path.join(folderPath, nextFile) : null;
}

function getCachedTrackDurationSeconds(filePath, fallback = 180) {
    const cached = manualCuesDB[filePath] || {};
    const duration = parseFiniteCueValue(cached.duration);
    if (duration !== null && duration > 0) return Math.round(duration);
    const fallbackValue = parseFiniteCueValue(fallback);
    return Math.max(1, Math.round(fallbackValue || 180));
}

async function warmTrackFromLibraryAndFile(filePath, row = null) {
    if (!filePath) return null;
    await ensureDbTracksLoaded([filePath]);
    const typeData = getTrackTypeData(filePath);
    const transitionConfig = getCrossfadeConfig(typeData, filePath);

    const cached = manualCuesDB[filePath] || {};
    if (!hasValidNumber(cached.duration)) {
        try {
            const duration = await getAudioDuration(filePath);
            if (duration > 0) {
                if (!manualCuesDB[filePath]) manualCuesDB[filePath] = {};
                manualCuesDB[filePath].duration = duration;
            }
        } catch (err) { }
    }

    if (row && document.body.contains(row)) {
        row.dataset.duracion = getCachedTrackDurationSeconds(filePath, row.dataset.duracion);
        if (row.dataset.type === 'random' && row.dataset.resolvedRandomPath === filePath) {
            row.dataset.resolvedRandomDuration = row.dataset.duracion;
        }
    }

    maybeRequestTransitionPreanalysis(filePath, transitionConfig);
    return filePath;
}

function resolveRandomRow(row) {
    if (!row || row.dataset.type !== 'random') return null;
    if (row.dataset.resolvedRandomPath && fs.existsSync(row.dataset.resolvedRandomPath)) {
        return row.dataset.resolvedRandomPath;
    }
    const folderPath = row.dataset.ruta;
    const filePath = takeRandomFolderFile(folderPath);
    if (!filePath) return null;
    row.dataset.resolvedRandomPath = filePath;
    row.dataset.resolvedRandomName = path.basename(filePath);
    row.dataset.resolvedRandomDuration = getCachedTrackDurationSeconds(filePath, row.dataset.duracion);
    warmRandomFolder(folderPath);
    return filePath;
}

async function hydrateRandomRowFromLibrary(row) {
    const filePath = resolveRandomRow(row);
    if (!filePath) return null;
    return warmTrackFromLibraryAndFile(filePath, row);
}

function warmUpcomingRows(startRow) {
    let row = startRow;
    let checked = 0;
    while (row && checked < RANDOM_WARM_LOOKAHEAD_ROWS) {
        const targetRow = row;
        if (row.dataset.type === 'random') {
            warmRandomFolder(row.dataset.ruta).then(() => {
                if (document.body.contains(targetRow) && targetRow !== currentPlayingRow) hydrateRandomRowFromLibrary(targetRow);
            });
        } else if (row.dataset.type !== 'time') {
            const filePath = row.dataset.ruta;
            warmTrackFromLibraryAndFile(filePath, targetRow);
        }
        row = row.nextElementSibling;
        checked++;
    }
}

const EXPLICIT_TYPES_PATH = path.join(configDir, 'explicit_types.json');
let explicitTypesDB = {};
try { if (fs.existsSync(EXPLICIT_TYPES_PATH)) explicitTypesDB = JSON.parse(fs.readFileSync(EXPLICIT_TYPES_PATH, 'utf-8')); } catch (e) { }
function saveExplicitTypes() { try { fs.writeFileSync(EXPLICIT_TYPES_PATH, JSON.stringify(explicitTypesDB, null, 2)); } catch (e) { } }
function saveEventsDB() { ipcRenderer.send('db-save-events-full', eventsMasterDB); }

let selectedEventId = null; let collapsedGroups = new Set(); let rightClickedGroupId = null;

function updateSelectedEventControls() {
    const btnMod = document.getElementById('btn-events-mod');
    if (!btnMod) return;
    btnMod.disabled = !selectedEventId;
    btnMod.title = selectedEventId ? 'Modificar evento seleccionado' : 'Selecciona un evento para modificarlo';
}

ipcRenderer.on('refresh-events', async (e, savedEvent) => {
    eventsMasterDB = await ipcRenderer.invoke('db-get-events');
    eventRuntimeQueue.clear();
    eventPreflightPromises.clear();
    eventsMasterDB.forEach(ev => { ev.checkedForThisCycle = false; });
    renderEventsList(); updateEventCountdowns();
});

ipcRenderer.on('refresh-event-groups', async () => { eventGroupsDB = await ipcRenderer.invoke('db-get-groups'); renderEventsList(); });

function applyEventsUIState() {
    const listContainer = document.querySelector('.events-list-container'); const btnExec = document.getElementById('btn-events-exec'); const chkEventsManual = document.getElementById('chk-events-manual'); const chkEventsMaster = document.getElementById('chk-events-master'); const footerWarning = document.getElementById('footer-events-warning');
    if (!chkEventsMaster || !chkEventsManual || !listContainer || !btnExec) return;
    const manualLabel = chkEventsManual.parentElement; manualLabel.style.whiteSpace = 'nowrap';
    if (!chkEventsMaster.checked) {
        listContainer.style.opacity = '0.3'; listContainer.style.pointerEvents = 'none'; btnExec.disabled = true; btnExec.style.opacity = '0.5'; manualLabel.style.color = ''; manualLabel.style.fontWeight = 'normal'; chkEventsManual.disabled = true; if (footerWarning) footerWarning.style.display = 'block';
    } else {
        listContainer.style.opacity = '1'; listContainer.style.pointerEvents = 'auto'; btnExec.disabled = false; btnExec.style.opacity = '1'; chkEventsManual.disabled = false; if (footerWarning) footerWarning.style.display = 'none';
        if (chkEventsManual.checked) { manualLabel.style.color = '#e01283'; manualLabel.style.fontWeight = 'bold'; } else { manualLabel.style.color = ''; manualLabel.style.fontWeight = 'normal'; }
    }
    refreshEventsIncidentStatus();
}

const masterCheckbox = document.getElementById('chk-events-master'); if (masterCheckbox) { masterCheckbox.addEventListener('change', (e) => { generalPrefs.eventsMasterActive = e.target.checked; saveConfig(generalPrefsPath, generalPrefs); applyEventsUIState(); recordIncident(e.target.checked ? '[EVENTOS] Automatizacion activada.' : '[EVENTOS] Automatizacion pausada por operador.', { category: 'events', level: e.target.checked ? 'success' : 'warn' }); }); }
const manualCheckbox = document.getElementById('chk-events-manual'); if (manualCheckbox) { manualCheckbox.addEventListener('change', (e) => { generalPrefs.eventsManualOnly = e.target.checked; saveConfig(generalPrefsPath, generalPrefs); applyEventsUIState(); recordIncident(e.target.checked ? '[EVENTOS] Modo manual activado.' : '[EVENTOS] Modo automatico restaurado.', { category: 'events', level: e.target.checked ? 'warn' : 'success' }); }); }
const eventPreHoldCheckbox = document.getElementById('chk-event-prehold');
const eventPreHoldSecondsInput = document.getElementById('event-prehold-seconds');
if (eventPreHoldCheckbox) eventPreHoldCheckbox.checked = generalPrefs.eventPreHoldActive !== false;
if (eventPreHoldSecondsInput) eventPreHoldSecondsInput.value = getEventPreHoldSeconds();
if (eventPreHoldCheckbox) eventPreHoldCheckbox.addEventListener('change', (e) => { generalPrefs.eventPreHoldActive = e.target.checked; if (!e.target.checked) clearEventPreHold(); saveConfig(generalPrefsPath, generalPrefs); });
if (eventPreHoldSecondsInput) eventPreHoldSecondsInput.addEventListener('change', (e) => { generalPrefs.eventPreHoldSeconds = Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 20)); e.target.value = generalPrefs.eventPreHoldSeconds; saveConfig(generalPrefsPath, generalPrefs); });

document.getElementById('tab-btn-explorador').addEventListener('click', (e) => { document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); document.querySelectorAll('.sidebar-content').forEach(c => c.style.display = 'none'); document.getElementById('content-explorador').style.display = 'flex'; updateEventCountdowns(); });
document.getElementById('tab-btn-eventos').addEventListener('click', (e) => { document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); document.querySelectorAll('.sidebar-content').forEach(c => c.style.display = 'none'); document.getElementById('content-eventos').style.display = 'flex'; updateEventCountdowns(); });
document.getElementById('tab-btn-fx').addEventListener('click', (e) => { document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); document.querySelectorAll('.sidebar-content').forEach(c => c.style.display = 'none'); document.getElementById('content-fx').style.display = 'flex'; updateEventCountdowns(); });

function hideAllMenus() {
    try {
        if (explorerFolderMenu) { explorerFolderMenu.style.display = 'none'; }
        if (explorerFileMenu) { explorerFileMenu.style.display = 'none'; }
        if (playlistContextMenu) { playlistContextMenu.style.display = 'none'; }
        if (eventsListMenu) { eventsListMenu.style.display = 'none'; }
        if (eimMenu) { eimMenu.style.display = 'none'; }
        if (groupContextMenu) { groupContextMenu.style.display = 'none'; }

        const cwcm = document.getElementById('cw-context-menu');
        if (cwcm) cwcm.style.display = 'none';

        const cwtcm = document.getElementById('cw-tab-context-menu');
        if (cwtcm) cwtcm.style.display = 'none';

        const cwpm = document.getElementById('cw-profile-menu');
        if (cwpm) cwpm.style.display = 'none';

        document.querySelectorAll('.pinned').forEach(el => el.classList.remove('pinned'));
    } catch (err) { }
}

function showContextMenu(menuElement, x, y) {
    if (!menuElement) return;
    hideAllMenus();
    menuElement.style.display = 'block';
    menuElement.style.width = 'max-content';
    let menuWidth = menuElement.offsetWidth;
    let menuHeight = menuElement.offsetHeight;
    const previewSafeY = window.innerHeight - 240;
    const previewSafeX = 500;
    if (x < previewSafeX && y > previewSafeY) { y = previewSafeY - menuHeight; if (y < 5) y = 5; }
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
    if (y + menuHeight > window.innerHeight) { y = y - menuHeight; if (y < 0) y = 5; }
    menuElement.style.left = `${x}px`;
    menuElement.style.top = `${y}px`;
}

function positionFloatingMenu(menuElement, x, y) {
    if (!menuElement) return;
    menuElement.style.display = 'block';
    menuElement.style.width = 'max-content';
    const menuWidth = menuElement.offsetWidth;
    const menuHeight = menuElement.offsetHeight;
    const margin = 6;
    const nextX = Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin));
    const nextY = Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin));
    menuElement.style.left = `${nextX}px`;
    menuElement.style.top = `${nextY}px`;
}

function applyMenuLogic() {
    document.querySelectorAll('.has-submenu:not(.logic-applied)').forEach(item => {
        item.classList.add('logic-applied');
        item.addEventListener('click', (e) => {
            e.stopPropagation(); const isPinned = item.classList.contains('pinned'); const siblings = item.parentElement.querySelectorAll(':scope > .has-submenu');
            siblings.forEach(sib => { if (sib !== item) { sib.classList.remove('pinned'); sib.querySelectorAll('.pinned').forEach(p => p.classList.remove('pinned')); } });
            if (!isPinned) { item.classList.add('pinned'); const submenu = item.querySelector('.submenu'); if (submenu) positionSubmenu(item, submenu); }
            else { item.classList.remove('pinned'); item.querySelectorAll('.pinned').forEach(p => p.classList.remove('pinned')); }
        });
        item.addEventListener('mouseenter', () => { const submenu = item.querySelector('.submenu'); if (submenu) positionSubmenu(item, submenu); });
    });
}

function positionSubmenu(parentItem, submenu) { submenu.style.visibility = 'hidden'; submenu.style.display = 'block'; const rect = parentItem.getBoundingClientRect(); const subRect = submenu.getBoundingClientRect(); if (rect.right + subRect.width > window.innerWidth) { submenu.style.left = 'auto'; submenu.style.right = '100%'; } else { submenu.style.left = '100%'; submenu.style.right = 'auto'; } if (rect.top + subRect.height > window.innerHeight) { submenu.style.top = 'auto'; submenu.style.bottom = '0'; } else { submenu.style.top = '0'; submenu.style.bottom = 'auto'; } submenu.style.display = ''; submenu.style.visibility = ''; }

function setPlaylistContextMenuMode(mode) {
    const menuItemIds = ['pm-preview', 'pm-copy', 'pm-cut', 'pm-paste', 'pm-tools', 'pm-toggle-temp', 'pm-shuffle', 'pm-set-next', 'pm-clear', 'pm-delete'];
    let enabledIds = menuItemIds;
    if (mode === 'empty') {
        enabledIds = ['pm-paste', 'pm-shuffle', 'pm-clear'];
    } else if (mode === 'note') {
        enabledIds = ['pm-paste', 'pm-clear', 'pm-delete'];
    }
    menuItemIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('context-disabled', !enabledIds.includes(id));
    });
}

document.addEventListener('click', (e) => {
    try {
        if (!e.target.closest('.context-menu') && !e.target.closest('.modal-content')) hideAllMenus();
    } catch (err) { }
});

if (playlistSection) {
    playlistSection.addEventListener('click', (e) => {
        if (e.target === playlistSection || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY') {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            lastSelectedRowIndex = -1; anchorRowIndex = -1;
        }
    });
}

const evListCont = document.querySelector('.events-list-container'); if (evListCont) { evListCont.addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.tagName === 'UL') { document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected')); selectedEventId = null; updateSelectedEventControls(); hideAllMenus(); } }); }

document.getElementById('btn-open-settings').addEventListener('click', () => { ipcRenderer.send('open-settings'); });

async function handleClearPlaylist() {
    if (playlistBody.children.length === 0) return;
    const response = await ipcRenderer.invoke('dialog:askClear');
    if (response === 2) return;
    if (response === 0) { const saved = await handleSavePlaylist(); if (!saved) return; }
    playlistBody.innerHTML = '';
    if (queuedNextRow && playlistBody.contains(queuedNextRow)) queuedNextRow = null;
    currentPlaylistPath = null;
    calcularHorasPlaylist(); updateNextTrackVisuals();
    saveSessionSnapshot();
}

async function handleSavePlaylist() {
    if (playlistBody.children.length === 0) return false;
    const defaultName = currentPlaylistPath || `Playlist_${new Date().getTime()}.LFPlay`;
    const savePath = await ipcRenderer.invoke('dialog:savePlaylist', defaultName);
    if (savePath) {
        const rows = Array.from(playlistBody.children);
        const pData = rows.map(r => ({
            ruta: r.dataset.ruta, duracion: r.dataset.duracion, type: r.dataset.type,
            titulo: r.dataset.pureName ? (r.dataset.pureName + r.dataset.ext) : r.children[1].innerText,
            customMix: r.dataset.customMix || null,
            temp: r.dataset.temp === 'true',
            noteText: r.dataset.noteText || null,
            targetTab: Number.isInteger(parseInt(r.dataset.targetTab, 10)) ? parseInt(r.dataset.targetTab, 10) : null,
            eventId: r.dataset.eventId || null,
            eventName: r.dataset.eventName || null
        }));
        fs.writeFileSync(savePath, JSON.stringify(pData, null, 2));
        currentPlaylistPath = savePath; return true;
    }
    return false;
}

ipcRenderer.on('request-close-check', async () => {
    if (tbodys[pgmTab].children.length === 0) { saveSessionSnapshot(true); ipcRenderer.send('confirm-app-quit'); return; }
    const response = await ipcRenderer.invoke('dialog:askClose');
    if (response === 2) return;
    if (response === 0) { const saved = await handleSavePlaylist(); if (!saved) return; }
    saveSessionSnapshot(true);
    ipcRenderer.send('confirm-app-quit');
});

async function loadPlaylistRowsInChunks(data, targetTbody, chunkSize = 80) {
    if (!targetTbody) return;
    const rawRows = Array.isArray(data) ? data : [];
    const normalizedRows = rawRows.map(item => normalizePlaylistItem(item));
    const rows = normalizedRows.filter(item => item.ruta);
    const playableRows = rows.filter(item => item.type === 'normal' || item.type === 'random');
    const missingRows = playableRows.filter(item => !fs.existsSync(item.ruta));

    if (!rows.length) {
        logSystem(`[PLAYLIST] No se insertaron pistas: ${rawRows.length} entrada(s), 0 ruta(s) reconocible(s).`);
    } else {
        const missingText = missingRows.length ? `, ${missingRows.length} ruta(s) no existen en disco` : '';
        logSystem(`[PLAYLIST] Preparando ${rows.length} pista(s) de ${rawRows.length} entrada(s)${missingText}.`);
        if (missingRows.length) {
            const examples = missingRows.slice(0, 3).map(item => item.ruta).join(' | ');
            logSystem(`[PLAYLIST] Ejemplos de rutas faltantes: ${examples}`);
        }
    }

    targetTbody.innerHTML = '';
    if (queuedNextRow && !document.body.contains(queuedNextRow)) queuedNextRow = null;

    let lastInsertedRow = null;
    let insertedCount = 0;
    for (let index = 0; index < rows.length; index += chunkSize) {
        const chunk = rows.slice(index, index + chunkSize);
        await ensureDbTracksLoaded(chunk
            .filter(item => item.type === 'normal')
            .map(item => item.ruta));
        beginBulkInsert();
        try {
            for (const item of chunk) {
                if (item.type === 'normal') {
                    lastInsertedRow = await addTrackToPlaylist(item.ruta, 'normal', lastInsertedRow, 'bottom', targetTbody);
                } else {
                    const rowType = item.type || 'normal';
                    const rowName = rowType === 'playlist_jump' ? item.targetTab : (rowType === 'note' ? (item.noteText || item.titulo || '') : (rowType === 'execute_event' ? (item.eventName || item.titulo || '') : item.titulo));
                    lastInsertedRow = createPlaylistRow(item.ruta, rowName, parseInt(item.duracion, 10) || 0, rowType, lastInsertedRow, 'bottom', targetTbody);
                    if (lastInsertedRow && rowType === 'playlist_jump' && Number.isInteger(parseInt(item.targetTab, 10))) lastInsertedRow.dataset.targetTab = parseInt(item.targetTab, 10);
                    if (lastInsertedRow && rowType === 'note' && item.noteText) lastInsertedRow.dataset.noteText = item.noteText;
                    if (lastInsertedRow && rowType === 'execute_event') { lastInsertedRow.dataset.eventId = item.eventId || item.ruta || ''; lastInsertedRow.dataset.eventName = item.eventName || item.titulo || ''; }
                }
                if (lastInsertedRow && item.customMix) lastInsertedRow.dataset.customMix = item.customMix;
                if (lastInsertedRow && (item.temp || /^[\u23f3\u231b]/.test(item.titulo || ''))) lastInsertedRow.dataset.temp = 'true';
                if (lastInsertedRow) insertedCount++;
            }
        } finally {
            endBulkInsert();
        }

        if (index === 0 && targetTbody.firstElementChild && !queuedNextRow) {
            queuedNextRow = resolveNextOperationalRow(targetTbody.firstElementChild, false);
            updateNextTrackVisuals();
        }
        await nextTick();
    }
    logSystem(`[PLAYLIST] Insertadas ${insertedCount} fila(s) en la playlist activa.`);
}

function normalizePlaylistItem(item = {}) {
    if (typeof item === 'string') item = { ruta: item };
    const ruta = String(
        item.ruta || item.Ruta ||
        item.rutaFisica || item.RutaFisica ||
        item.rutaCompleta || item.RutaCompleta ||
        item.pathCompleto || item.PathCompleto ||
        item.fullPath || item.FullPath || item.full_path ||
        item.filePath || item.FilePath ||
        item.path || item.Path ||
        item.archivo || item.Archivo ||
        item.file || item.File ||
        item.src || item.Src ||
        ''
    ).trim();
    const type = (String(item.type || item.Type || item.tipo || item.Tipo || 'normal').trim() || 'normal').toLowerCase();
    const titulo = item.titulo || item.Titulo || item.title || item.Title || item.nombre || item.Nombre || (ruta ? path.basename(ruta) : '');
    return {
        ruta,
        type,
        titulo,
        duracion: item.duracion ?? item.Duracion ?? item.duration ?? item.Duration ?? item.dur ?? 0,
        customMix: item.customMix ?? item.CustomMix ?? item.mix ?? item.Mix ?? null,
        temp: item.temp === true || item.Temp === true || item.temporary === true || item.Temporary === true,
        noteText: item.noteText || item.NoteText || item.nota || item.Nota || null,
        targetTab: Number.isInteger(parseInt(item.targetTab ?? item.TargetTab ?? item.playlistTarget ?? item.PlaylistTarget, 10)) ? parseInt(item.targetTab ?? item.TargetTab ?? item.playlistTarget ?? item.PlaylistTarget, 10) : null,
        eventId: item.eventId || item.EventId || item.eventID || item.idEvento || item.IdEvento || null,
        eventName: item.eventName || item.EventName || item.nombreEvento || item.NombreEvento || null
    };
}

async function handleOpenPlaylist() {
    const openPath = await ipcRenderer.invoke('dialog:openPlaylist');
    if (openPath) {
        try {
            const content = await fs.promises.readFile(openPath, 'utf-8');
            const data = JSON.parse(content);
            const rows = extractPlaylistRows(data);
            if (!rows.length) logSystem(`[ERROR] Playlist sin pistas reconocibles: ${path.basename(openPath)}`);
            await loadPlaylistRowsInChunks(rows, playlistBody);
            currentPlaylistPath = openPath;
            saveSessionSnapshot();
        } catch (e) {
            logSystem(`[ERROR] No se pudo cargar playlist: ${path.basename(openPath)} (${e.message})`);
        }
    }
}

function extractPlaylistRows(data) {
    if (Array.isArray(data)) return data;
    const directLists = [
        data?.tracks, data?.Tracks,
        data?.items, data?.Items,
        data?.playlist, data?.Playlist,
        data?.rows, data?.Rows,
        data?.pistas, data?.Pistas,
        data?.canciones, data?.Canciones
    ];
    for (const list of directLists) {
        if (Array.isArray(list)) return list;
    }
    if (Array.isArray(data?.playlists)) {
        return data.playlists.flatMap(list => {
            if (Array.isArray(list)) return list;
            return extractPlaylistRows(list);
        });
    }
    return [];
}
document.getElementById('btn-top-clear').addEventListener('click', handleClearPlaylist); document.getElementById('btn-top-open').addEventListener('click', handleOpenPlaylist); document.getElementById('btn-top-save').addEventListener('click', handleSavePlaylist);

ipcRenderer.on('menu-action', (e, action) => { if (action === 'clear') handleClearPlaylist(); if (action === 'open') handleOpenPlaylist(); if (action === 'save') handleSavePlaylist(); });
ipcRenderer.on('menu-add-files', async (e, paths) => {
    let lastRow = null;
    await ensureDbTracksLoaded(paths);
    beginBulkInsert();
    try {
        for (let i = 0; i < paths.length; i++) {
            lastRow = await addTrackToPlaylist(paths[i], 'normal', lastRow, 'bottom', playlistBody);
            if ((i + 1) % 25 === 0) {
                endBulkInsert();
                await nextTick();
                beginBulkInsert();
            }
        }
    } finally {
        endBulkInsert();
    }
});

ipcRenderer.on('remote-add-to-playlist', async (e, payload) => {
    let targetTbody = playlistBody;
    if (typeof payload.playlistIndex === 'number' && payload.playlistIndex >= 0 && payload.playlistIndex < tbodys.length) {
        targetTbody = tbodys[payload.playlistIndex];
    }

    let lastRow = null;
    await ensureDbTracksLoaded(payload.paths);
    beginBulkInsert();
    try {
        for (let i = 0; i < payload.paths.length; i++) {
            lastRow = await addTrackToPlaylist(payload.paths[i], 'normal', lastRow, 'bottom', targetTbody);
            if ((i + 1) % 25 === 0) {
                endBulkInsert();
                await nextTick();
                beginBulkInsert();
            }
        }
    } finally {
        endBulkInsert();
        if (targetTbody === playlistBody) calcularHorasPlaylist();
    }
});
ipcRenderer.on('menu-add-folder', async (e, folder) => { await handleDroppedItem(folder, null, 'bottom', playlistBody); });
ipcRenderer.on('menu-add-random', async (e, folder) => { await addRandomFolderToPlaylist(folder, null, 'bottom', playlistBody); });
ipcRenderer.on('menu-insert-time', () => { addTimeLocutionToPlaylist(); });
ipcRenderer.on('menu-add-event-command', async () => {
    const eventObj = await requestPlaylistEventSelection();
    if (!eventObj) return;
    insertSpecialRow('execute_event', null, eventObj);
});
ipcRenderer.on('menu-set-next', () => { const selectedQ = resolveNextOperationalRow(document.querySelector('.selected-row'), false); if (selectedQ) { setQueuedNextManual(selectedQ); } });
ipcRenderer.on('menu-toggle-temp', () => {
    document.querySelectorAll('.selected-row').forEach(tr => {
        let isTemp = tr.dataset.temp === 'true';
        tr.dataset.temp = isTemp ? 'false' : 'true';
        let currentName = tr.dataset.pureName || tr.children[1].innerText;
        if (isTemp && /^(?:\u23f3|⏳)\s/.test(currentName)) { tr.dataset.pureName = currentName.replace(/^(?:\u23f3|⏳)\s*/, ''); tr.children[1].innerText = tr.dataset.pureName; }
        else if (!isTemp && !/^(?:\u23f3|⏳)\s/.test(currentName)) { tr.dataset.pureName = ICON_TEMP_PREFIX + currentName; tr.children[1].innerText = ICON_TEMP_PREFIX + currentName; }
    });
});
ipcRenderer.on('menu-delete-selected', () => {
    document.querySelectorAll('.selected-row').forEach(tr => { if (tr === queuedNextRow) queuedNextRow = resolveNextOperationalRow(tr.nextElementSibling, false); tr.remove(); });
    calcularHorasPlaylist(); updateNextTrackVisuals();
});

ipcRenderer.on('menu-shuffle', () => { handleShuffleActivePlaylist(); });
ipcRenderer.on('menu-clear-played', () => { handleClearPlayedTracks(); });
ipcRenderer.on('menu-check-links', () => { handleCheckBrokenLinks(); });
ipcRenderer.on('menu-open-rotation', () => { openRotationModal(); });

ipcRenderer.on('menu-add-stop', () => { insertSpecialRow('stop'); });
ipcRenderer.on('menu-add-note', async () => {
    const noteText = await requestPlaylistNoteText('');
    if (noteText === null) return;
    insertSpecialRow('note', null, noteText);
});
ipcRenderer.on('menu-play-next-playlist', (e, targetTab) => { insertSpecialRow('playlist_jump', targetTab); });

let playlistNoteModalResolver = null;
let playlistEventModalResolver = null;

function requestPlaylistNoteText(initialText = '') {
    const modal = document.getElementById('playlist-note-modal');
    const input = document.getElementById('playlist-note-input');
    const btnCancel = document.getElementById('btn-cancel-playlist-note');
    const btnAccept = document.getElementById('btn-accept-playlist-note');
    if (!modal || !input || !btnCancel || !btnAccept) return Promise.resolve(null);

    if (playlistNoteModalResolver) {
        playlistNoteModalResolver(null);
        playlistNoteModalResolver = null;
    }

    input.value = initialText || '';
    modal.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 0);

    return new Promise(resolve => {
        const cleanup = (value) => {
            modal.style.display = 'none';
            btnCancel.removeEventListener('click', onCancel);
            btnAccept.removeEventListener('click', onAccept);
            modal.removeEventListener('mousedown', onBackdrop);
            input.removeEventListener('keydown', onKeyDown);
            playlistNoteModalResolver = null;
            resolve(value);
        };
        const onCancel = () => cleanup(null);
        const onAccept = () => cleanup(input.value.trim());
        const onBackdrop = (event) => { if (event.target === modal) cleanup(null); };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cleanup(null);
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                cleanup(input.value.trim());
            }
        };
        playlistNoteModalResolver = cleanup;
        btnCancel.addEventListener('click', onCancel);
        btnAccept.addEventListener('click', onAccept);
        modal.addEventListener('mousedown', onBackdrop);
        input.addEventListener('keydown', onKeyDown);
    });
}

function getGroupedEventsForPicker() {
    const groupsById = new Map();
    eventGroupsDB.forEach(group => groupsById.set(group.id, group));
    if (!groupsById.has('g_general')) groupsById.set('g_general', { id: 'g_general', name: 'General', colorBg: '#222225', colorText: '#00a8ff' });
    const grouped = new Map();
    eventsMasterDB.forEach(ev => {
        let groupId = ev.group || 'g_general';
        if (!groupsById.has(groupId)) {
            const byName = eventGroupsDB.find(group => group.name === groupId);
            groupId = byName ? byName.id : 'g_general';
        }
        if (!grouped.has(groupId)) grouped.set(groupId, []);
        grouped.get(groupId).push(ev);
    });
    grouped.forEach(list => list.sort((a, b) => String(a.primaryTime || '').localeCompare(String(b.primaryTime || ''))));
    return { groupsById, grouped };
}

function renderPlaylistEventPickerList(selectedEventId = '') {
    const list = document.getElementById('playlist-event-list');
    if (!list) return;
    list.innerHTML = '';
    const { groupsById, grouped } = getGroupedEventsForPicker();
    if (eventsMasterDB.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'incident-empty';
        empty.textContent = 'No hay eventos disponibles.';
        list.appendChild(empty);
        return;
    }
    grouped.forEach((events, groupId) => {
        if (!events.length) return;
        const group = groupsById.get(groupId) || { name: 'General', colorBg: '#222225', colorText: '#00a8ff' };
        const header = document.createElement('li');
        header.className = 'event-group-header';
        header.textContent = group.name || 'General';
        header.style.backgroundColor = group.colorBg || '#222225';
        header.style.color = group.colorText || '#00a8ff';
        list.appendChild(header);
        events.forEach(ev => {
            const item = document.createElement('li');
            item.className = 'event-item';
            if (ev.id === selectedEventId) item.classList.add('selected');
            item.dataset.id = ev.id;
            item.style.color = ev.colorText || '';
            item.style.backgroundColor = ev.colorBg || '';
            item.innerHTML = `<div class="evt-time">${String(ev.primaryTime || '00:00').substring(0, 5)}</div><div class="evt-info"><span class="evt-name">${ev.hasError ? '[!] ' : ''}${ev.name || 'Evento sin nombre'}</span></div><div class="evt-countdown">Evento</div>`;
            item.addEventListener('click', () => {
                list.querySelectorAll('.event-item').forEach(node => node.classList.remove('selected'));
                item.classList.add('selected');
            });
            item.addEventListener('dblclick', () => {
                const selected = eventsMasterDB.find(candidate => candidate.id === ev.id);
                if (playlistEventModalResolver) playlistEventModalResolver(selected || null);
            });
            list.appendChild(item);
        });
    });
}

function requestPlaylistEventSelection() {
    const modal = document.getElementById('playlist-event-modal');
    const list = document.getElementById('playlist-event-list');
    const btnCancel = document.getElementById('btn-cancel-playlist-event');
    const btnAccept = document.getElementById('btn-accept-playlist-event');
    if (!modal || !list || !btnCancel || !btnAccept) return Promise.resolve(null);

    if (playlistEventModalResolver) {
        playlistEventModalResolver(null);
        playlistEventModalResolver = null;
    }

    renderPlaylistEventPickerList(selectedEventId || '');
    modal.style.display = 'flex';

    return new Promise(resolve => {
        const cleanup = (value) => {
            modal.style.display = 'none';
            btnCancel.removeEventListener('click', onCancel);
            btnAccept.removeEventListener('click', onAccept);
            modal.removeEventListener('mousedown', onBackdrop);
            modal.removeEventListener('keydown', onKeyDown);
            playlistEventModalResolver = null;
            resolve(value);
        };
        const onCancel = () => cleanup(null);
        const onAccept = () => {
            const selected = list.querySelector('.event-item.selected');
            cleanup(selected ? (eventsMasterDB.find(ev => ev.id === selected.dataset.id) || null) : null);
        };
        const onBackdrop = (event) => { if (event.target === modal) cleanup(null); };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cleanup(null);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                onAccept();
            }
        };
        playlistEventModalResolver = cleanup;
        btnCancel.addEventListener('click', onCancel);
        btnAccept.addEventListener('click', onAccept);
        modal.addEventListener('mousedown', onBackdrop);
        modal.addEventListener('keydown', onKeyDown);
        modal.tabIndex = -1;
        setTimeout(() => modal.focus(), 0);
    });
}

function removeCommandRowAfterExecution(commandRow) {
    if (commandRow && commandRow.parentNode) {
        if (commandRow === queuedNextRow) queuedNextRow = resolveNextOperationalRow(commandRow.nextElementSibling, false);
        commandRow.remove();
    }
    calcularHorasPlaylist();
    updateNextTrackVisuals();
    saveSessionSnapshot();
}

function insertSpecialRow(type, targetTab = null, noteText = '') {
    const targetBody = tbodys[currentViewTab] || playlistBody;
    const selected = Array.from(targetBody.querySelectorAll('.selected-row'));
    const insertAfterElement = selected.length > 0 ? selected[selected.length - 1] : targetBody.lastElementChild;
    const payloadName = type === 'playlist_jump' ? parseInt(targetTab, 10) : (type === 'execute_event' ? (noteText?.name || noteText?.eventName || '') : (noteText || ''));
    const row = createPlaylistRow(type === 'playlist_jump' ? 'playlist_jump' : '', payloadName, 0, type, insertAfterElement, 'bottom', targetBody);
    if (row && type === 'execute_event') {
        row.dataset.eventId = noteText?.id || noteText?.eventId || '';
        row.dataset.eventName = noteText?.name || noteText?.eventName || payloadName || '';
        row.dataset.ruta = row.dataset.eventId;
        row.dataset.pureName = formatSpecialPlaylistTitle('execute_event', null, row.dataset.eventName);
        row.children[1].innerText = row.dataset.pureName;
    }
    if (row && !isPlaylistNoteRow(row) && !queuedNextRow && !currentPlayingRow) setQueuedNextManual(row);
    calcularHorasPlaylist();
    updateNextTrackVisuals();
    saveSessionSnapshot();
    return row;
}


function handleShuffleActivePlaylist() {
    const targetBody = tbodys[currentViewTab] || playlistBody;
    const rows = Array.from(targetBody.children);
    if (rows.length < 2) return;
    const shuffled = shuffleArray(rows);
    shuffled.forEach(row => targetBody.appendChild(row));
    calcularHorasPlaylist();
    updateNextTrackVisuals();
}

function handleClearPlayedTracks() {
    const targetBody = tbodys[currentViewTab] || playlistBody;
    const rows = Array.from(targetBody.children);

    let boundaryIndex = -1;
    if (currentPlayingRow && rows.includes(currentPlayingRow)) {
        boundaryIndex = rows.indexOf(currentPlayingRow);
    } else if (queuedNextRow && rows.includes(queuedNextRow)) {
        boundaryIndex = rows.indexOf(queuedNextRow);
    }

    if (boundaryIndex > 0) {
        for (let i = 0; i < boundaryIndex; i++) {
            if (rows[i] === queuedNextRow) queuedNextRow = resolveNextOperationalRow(rows[i].nextElementSibling, false);
            rows[i].remove();
        }
        calcularHorasPlaylist();
        updateNextTrackVisuals();
    }
}

function handleCheckBrokenLinks() {
    const targetBody = tbodys[currentViewTab] || playlistBody;
    const rows = Array.from(targetBody.children);
    let deletedCount = 0;

    rows.forEach(tr => {
        if (tr === currentPlayingRow) return;
        if (tr.dataset.type === 'time') return;
        const filePath = tr.dataset.path;
        if (filePath) {
            const diag = getFilePlaybackDiagnostics(filePath);
            if (!diag.ok) {
                if (tr === queuedNextRow) queuedNextRow = resolveNextOperationalRow(tr.nextElementSibling, false);
                tr.remove();
                deletedCount++;
            }
        }
    });

    if (deletedCount > 0) {
        calcularHorasPlaylist();
        updateNextTrackVisuals();
    }
}


function getNextAbsoluteOccurrence(ev, includeIgnored = false) {
    const now = new Date(); let expandedTimes = getExpandedEventTimes(ev); let targetDates = [];
    for (let tStr of expandedTimes) {
        let [h, m, s] = tStr.split(':').map(Number); let d = new Date(now); d.setHours(h, m, s, 0); if (d <= now) d.setDate(d.getDate() + 1);
        let loops = 0; let valid = false;
        while (loops < 365) { if (isDateValidForEvent(d, ev)) { valid = true; break; } d.setDate(d.getDate() + 1); d.setHours(h, m, s, 0); loops++; }
        if (valid) targetDates.push({ date: d, timeStr: tStr });
    }
    let validDates = targetDates;
    if (!includeIgnored) { validDates = targetDates.filter(item => { const dateStr = item.date.toDateString(); const ignoreKey = `${ev.id}_${item.timeStr}_${dateStr}`; return !ignoredEventTriggers.includes(ignoreKey); }); }
    validDates.sort((a, b) => a.date - b.date); return validDates.length > 0 ? validDates[0] : null;
}

function formatEventTimeLeft(ev) {
    const now = new Date(); const queuedDelay = getQueuedDelayInfo(ev.id);
    if (queuedDelay) { const mins = Math.floor(queuedDelay.remainingSeconds / 60).toString().padStart(2, '0'); const secs = (queuedDelay.remainingSeconds % 60).toString().padStart(2, '0'); const fallbackNext = getNextAbsoluteOccurrence(ev, false); return { text: `Espera: ${mins}:${secs}`, seconds: 0, targetDate: fallbackNext ? fallbackNext.date : null, targetTimeStr: fallbackNext ? fallbackNext.timeStr : null, absoluteNext: fallbackNext, waitingMaxDelay: true }; }
    const closestValid = getNextAbsoluteOccurrence(ev, false);
    if (!closestValid) return { text: 'Caducado / Fuera de Rango', seconds: 999999, targetDate: null, targetTimeStr: null, absoluteNext: null };
    let diffMs = closestValid.date - now; let totalSecs = Math.floor(diffMs / 1000); let h = Math.floor(totalSecs / 3600); let m = Math.floor((totalSecs % 3600) / 60); let s = totalSecs % 60; let text = "";
    if (h >= 24) { const days = Math.floor(totalSecs / 86400); const rem = totalSecs % 86400; const rh = Math.floor(rem / 3600); const rm = Math.floor((rem % 3600) / 60); const rs = rem % 60; text = `${days}d ${rh.toString().padStart(2, '0')}:${rm.toString().padStart(2, '0')}:${rs.toString().padStart(2, '0')}`; }
    else { text = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`; }
    return { text: text, seconds: totalSecs, targetDate: closestValid.date, targetTimeStr: closestValid.timeStr, absoluteNext: closestValid };
}

function getEventOccurrenceKey(ev, occurrence) {
    if (!ev || !occurrence || !occurrence.date || !occurrence.timeStr) return null;
    return `${ev.id}_${occurrence.timeStr}_${occurrence.date.toDateString()}`;
}

function getEventFireId(ev, timeStr, date) {
    if (!ev || !timeStr || !date) return null;
    if (ev.dayMode === 'once') return `${ev.id}_${timeStr}`;
    return `${ev.id}_${timeStr}_${date.toDateString()}`;
}

function getEventQueueEntryForOccurrence(ev, occurrence) {
    const key = getEventOccurrenceKey(ev, occurrence);
    if (!key) return null;
    let entry = eventRuntimeQueue.get(key);
    const seconds = Math.floor((occurrence.date.getTime() - Date.now()) / 1000);
    if (!entry) {
        entry = {
            key,
            eventId: ev.id,
            eventName: ev.name,
            timeStr: occurrence.timeStr,
            targetTimeMs: occurrence.date.getTime(),
            seconds,
            status: 'scheduled',
            label: 'PROG',
            message: 'Programado',
            sourceSummary: '',
            lastCheckedAt: 0,
            preflightOk: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        eventRuntimeQueue.set(key, entry);
    }
    entry.eventName = ev.name;
    entry.timeStr = occurrence.timeStr;
    entry.targetTimeMs = occurrence.date.getTime();
    entry.seconds = seconds;
    return entry;
}

function getEventQueueEntry(ev, timeData) {
    const occurrence = timeData?.absoluteNext || (timeData?.targetDate && timeData?.targetTimeStr ? { date: timeData.targetDate, timeStr: timeData.targetTimeStr } : null);
    return getEventQueueEntryForOccurrence(ev, occurrence);
}

function getActiveQueuedEntryForEvent(eventId) {
    const row = document.querySelector(`.playlist-table tr[data-event-id="${eventId}"][data-event-queue-key]`);
    if (!row) return null;
    return eventRuntimeQueue.get(row.dataset.eventQueueKey) || null;
}

function setEventQueueStatus(entry, status, label, message) {
    if (!entry) return;
    entry.status = status;
    entry.label = label || entry.label || status.toUpperCase();
    entry.message = message || entry.message || '';
    entry.updatedAt = Date.now();
}

function cleanupEventRuntimeQueue() {
    const nowMs = Date.now();
    const finalStates = new Set(['fired', 'skipped', 'omitted']);
    eventRuntimeQueue.forEach((entry, key) => {
        const isOldFinal = finalStates.has(entry.status) && nowMs - entry.updatedAt > 20 * 60 * 1000;
        const isVeryOld = entry.targetTimeMs && entry.targetTimeMs < nowMs - 2 * 60 * 60 * 1000;
        if (isOldFinal || isVeryOld) eventRuntimeQueue.delete(key);
    });
}

async function runEventPreflight(ev, entry, reason = 'auto') {
    if (!entry) return { ok: false, message: 'Sin ocurrencia programada', summary: '' };
    const force = reason === 'fire' || reason === 'manual';
    const recheckMs = entry.seconds <= 60 ? EVENT_PREFLIGHT_FINAL_RECHECK_MS : EVENT_PREFLIGHT_RECHECK_MS;
    if (!force && entry.lastCheckedAt && Date.now() - entry.lastCheckedAt < recheckMs) {
        return { ok: entry.preflightOk !== false, message: entry.message, summary: entry.sourceSummary, cached: true };
    }
    if (eventPreflightPromises.has(entry.key)) return eventPreflightPromises.get(entry.key);

    const promise = (async () => {
        setEventQueueStatus(entry, 'checking', 'REV', 'Verificando fuente');
        renderEventTimeline(true);
        const inspection = await inspectEventSource(ev.filePath, ev.sourceType);
        entry.lastCheckedAt = Date.now();
        entry.preflightOk = inspection.ok;
        entry.sourceSummary = inspection.summary || '';
        if (inspection.ok) {
            setEventQueueStatus(entry, 'ready', 'OK', inspection.message || 'Listo');
            if (ev.hasError && ['integrity', 'fire-block', 'preflight'].includes(ev.errorLoggedFor)) {
                recordIncident(`[EVENTOS] ${ev.name}: fuente recuperada y lista.`, { category: 'events', level: 'success' });
            }
            ev.hasError = false;
            ev.errorDiscoveredAt = null;
            ev.errorLoggedFor = null;
            ev.errorMessage = null;
        } else {
            setEventQueueStatus(entry, 'blocked', 'ERROR', inspection.message || 'Fuente no lista');
            if (!ev.hasError || ev.errorLoggedFor !== 'preflight' || ev.errorMessage !== inspection.message) {
                recordIncident(`[EVENTOS] ${ev.name}: ${inspection.message || 'fuente no lista'}.`, { category: 'events', level: 'error' });
            }
            ev.hasError = true;
            ev.errorDiscoveredAt = Date.now();
            ev.errorLoggedFor = 'preflight';
            ev.errorMessage = inspection.message;
        }
        refreshEventsIncidentStatus();
        renderEventTimeline(true);
        return inspection;
    })().finally(() => eventPreflightPromises.delete(entry.key));

    eventPreflightPromises.set(entry.key, promise);
    return promise;
}

function buildUpcomingEventTimeline(limit = EVENT_TIMELINE_LIMIT) {
    cleanupEventRuntimeQueue();
    const items = [];
    eventsMasterDB.forEach(ev => {
        const activeEntry = getActiveQueuedEntryForEvent(ev.id);
        if (activeEntry && ['waiting', 'queued'].includes(activeEntry.status)) {
            items.push({ ev, entry: activeEntry, seconds: 0, countdownText: activeEntry.message || 'En cola', timeStr: activeEntry.timeStr });
            return;
        }
        const timeData = formatEventTimeLeft(ev);
        if (!timeData || !timeData.targetDate || !Number.isFinite(timeData.seconds)) return;
        const entry = getEventQueueEntry(ev, timeData);
        items.push({ ev, entry, seconds: timeData.seconds, countdownText: timeData.text, timeStr: timeData.targetTimeStr || ev.primaryTime });
    });
    return items.sort((a, b) => {
        const aTime = a.entry?.targetTimeMs || Number.MAX_SAFE_INTEGER;
        const bTime = b.entry?.targetTimeMs || Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
    }).slice(0, limit);
}

function renderEventTimeline(force = false) {
    const container = document.getElementById('events-timeline');
    if (!container) {
        if (force) pushIncidentSnapshot();
        return;
    }
    if (!force && Date.now() - lastEventTimelineRenderAt < 700) return;
    lastEventTimelineRenderAt = Date.now();

    const summary = document.getElementById('events-ops-summary');
    const items = buildUpcomingEventTimeline();
    container.replaceChildren();
    if (summary) summary.textContent = items.length ? `${items.length} en vigilancia` : 'Sin eventos proximos';
    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'event-timeline-empty';
        empty.textContent = 'No hay eventos programados en la cola.';
        container.appendChild(empty);
        return;
    }

    items.forEach(item => {
        const entry = item.entry;
        const row = document.createElement('div');
        row.className = 'event-timeline-item';
        row.dataset.status = entry?.status || 'scheduled';

        const time = document.createElement('div');
        time.className = 'event-timeline-time';
        time.textContent = (item.timeStr || item.ev.primaryTime || '--:--').substring(0, 5);

        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'event-timeline-name';
        name.textContent = item.ev.name || 'Evento sin nombre';
        const meta = document.createElement('div');
        meta.className = 'event-timeline-meta';
        const source = entry?.sourceSummary ? ` - ${entry.sourceSummary}` : '';
        meta.textContent = `${item.countdownText || entry?.message || 'Programado'}${source}`;
        info.appendChild(name);
        info.appendChild(meta);

        const state = document.createElement('div');
        state.className = 'event-timeline-state';
        state.textContent = entry?.label || 'PROG';

        row.appendChild(time);
        row.appendChild(info);
        row.appendChild(state);
        container.appendChild(row);
    });
}

function isEventQueuedWithMaxDelay(evId) { return !!getQueuedDelayInfo(evId); }
function applyEventWarningColors(liElement, secondsRemaining, customColor, forceHardRedFlash = false) {
    const baseColor = customColor || '#1a1a1c'; liElement.style.setProperty('--evt-base-bg', baseColor); liElement.classList.remove('evt-flash-red', 'evt-flash-red-hard');
    if (forceHardRedFlash) { liElement.style.backgroundColor = ''; liElement.classList.add('evt-flash-red-hard'); return; }
    if (secondsRemaining <= 30) { liElement.style.backgroundColor = ''; liElement.classList.add('evt-flash-red'); }
    else if (secondsRemaining <= 60) { liElement.style.backgroundColor = 'rgba(231, 76, 60, 0.9)'; }
    else if (secondsRemaining <= 300) { liElement.style.backgroundColor = 'rgba(243, 156, 18, 0.9)'; }
    else if (secondsRemaining <= 900) { liElement.style.backgroundColor = 'rgba(243, 156, 18, 0.3)'; }
    else { liElement.style.backgroundColor = baseColor; }
}

function renderEventsList() {
    const ul = document.getElementById('events-list'); ul.innerHTML = ''; let groupedEvents = {}; eventGroupsDB.forEach(g => groupedEvents[g.id] = { meta: g, events: [] });
    if (!groupedEvents['g_general']) groupedEvents['g_general'] = { meta: { id: 'g_general', name: 'General', colorBg: '#222225', colorText: '#00a8ff', readonly: true }, events: [] };
    eventsMasterDB.sort((a, b) => a.primaryTime.localeCompare(b.primaryTime));
    eventsMasterDB.forEach(ev => { let gid = ev.group || 'g_general'; if (!groupedEvents[gid]) { const match = eventGroupsDB.find(g => g.name === gid); if (match) { gid = match.id; ev.group = gid; } else { gid = 'g_general'; } } groupedEvents[gid].events.push(ev); });

    Object.values(groupedEvents).forEach(groupObj => {
        if (groupObj.events.length === 0) return; const isCollapsed = collapsedGroups.has(groupObj.meta.id);
        const headerLi = document.createElement('li'); headerLi.className = `event-group-header ${isCollapsed ? 'group-collapsed' : ''}`;
        headerLi.style.backgroundColor = groupObj.meta.colorBg; headerLi.style.color = groupObj.meta.colorText;
        headerLi.innerHTML = `<span style="flex:1;">${groupObj.meta.name}</span> <span class="event-group-icon" style="transition: transform 0.2s; color: inherit; transform: ${isCollapsed ? 'rotate(-90deg)' : 'rotate(0)'};">&#9662;</span>`;
        headerLi.style.display = 'flex'; headerLi.style.justifyContent = 'space-between'; headerLi.style.alignItems = 'center'; headerLi.style.cursor = 'pointer';
        headerLi.onclick = () => { if (collapsedGroups.has(groupObj.meta.id)) collapsedGroups.delete(groupObj.meta.id); else collapsedGroups.add(groupObj.meta.id); renderEventsList(); };
        headerLi.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); rightClickedGroupId = groupObj.meta.id; showContextMenu(groupContextMenu, e.pageX, e.pageY); applyMenuLogic(); };
        ul.appendChild(headerLi);

        if (!isCollapsed) {
            groupObj.events.forEach(ev => {
                const li = document.createElement('li'); li.className = 'event-item'; li.dataset.id = ev.id; if (ev.id === selectedEventId) li.classList.add('selected'); li.style.color = ev.colorText;
                const timeData = formatEventTimeLeft(ev); const isQueuedWithDelay = isEventQueuedWithMaxDelay(ev.id); const queueEntry = getEventQueueEntry(ev, timeData); if (queueEntry) li.dataset.queueStatus = queueEntry.status;
                let displayName = ev.name;
                if (ev.hasError) { li.style.backgroundColor = '#e01283'; li.classList.remove('evt-flash-red', 'evt-flash-red-hard'); displayName = `[${ICON_WARNING_LABEL}] ${ev.name}`; }
                else { applyEventWarningColors(li, timeData.seconds, ev.colorBg, isQueuedWithDelay); }
                li.innerHTML = `<div class="evt-time">${ev.primaryTime.substring(0, 5)}</div><div class="evt-info"><span class="evt-name">${displayName}</span></div><div class="evt-countdown">${timeData.text}</div>`;
                li.onclick = (e) => { e.stopPropagation(); hideAllMenus(); selectedEventId = ev.id; updateSelectedEventControls(); document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected')); li.classList.add('selected'); };
                li.ondblclick = (e) => { e.stopPropagation(); ev.hasError = false; ev.errorLoggedFor = null; ipcRenderer.send('open-event-editor', ev); };
                li.oncontextmenu = (e) => {
                    e.preventDefault(); e.stopPropagation(); selectedEventId = ev.id; updateSelectedEventControls(); document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected')); li.classList.add('selected');
                    const btnIgnore = document.getElementById('eim-ignore'); const absoluteTarget = getNextAbsoluteOccurrence(ev, true);
                    if (absoluteTarget) { const dateStr = absoluteTarget.date.toDateString(); const ignoreKey = `${ev.id}_${absoluteTarget.timeStr}_${dateStr}`; if (ignoredEventTriggers.includes(ignoreKey)) { btnIgnore.innerHTML = `&#9654; No ignorar este evento`; btnIgnore.style.color = '#2ecc71'; } else { btnIgnore.innerHTML = `&#9940; Ignorar este evento`; btnIgnore.style.color = ''; } }
                    showContextMenu(document.getElementById('event-item-menu'), e.pageX, e.pageY);
                };
                ul.appendChild(li);
            });
        }
    });
    updateSelectedEventControls();
    renderEventTimeline(true);
}

function updateTabAppearance(globalHasError, nearestHealthy, nearestSecs, recentEmergency, isManualOnly, isMasterActive) {
    const tabEventos = document.getElementById('tab-btn-eventos'); if (!tabEventos) return; const isActive = tabEventos.classList.contains('active');
    tabEventos.style.backgroundColor = ''; tabEventos.style.color = ''; tabEventos.classList.remove('tab-emergency-flash', 'tab-flash-red', 'tab-flash-orange', 'tab-flash-orange-trans', 'tab-flash-gray');
    if (!isMasterActive) { tabEventos.innerText = `${ICON_EVENT_DISABLED_LABEL} Eventos`; tabEventos.style.backgroundColor = '#333333'; tabEventos.style.color = '#aaaaaa'; if (nearestHealthy) { if ((nearestSecs <= 60 && nearestSecs >= 30) || (nearestSecs <= 300 && nearestSecs >= 270) || (nearestSecs <= 900 && nearestSecs >= 870)) { tabEventos.classList.add('tab-flash-gray'); } } return; }
    if (isActive) { tabEventos.innerText = globalHasError ? `${ICON_WARNING_LABEL} Eventos` : 'Eventos'; return; }
    if (recentEmergency) { tabEventos.classList.add('tab-emergency-flash'); tabEventos.innerText = `${ICON_WARNING_LABEL} Eventos`; return; }
    if (nearestHealthy && nearestSecs <= 900) { tabEventos.innerText = 'Eventos'; if (isManualOnly) { if (nearestSecs <= 60 && nearestSecs >= 50) { tabEventos.classList.add('tab-flash-red'); } else if (nearestSecs <= 300 && nearestSecs >= 290) { tabEventos.classList.add('tab-flash-orange'); } else if (nearestSecs <= 900 && nearestSecs >= 890) { tabEventos.classList.add('tab-flash-orange-trans'); } } else { if (nearestSecs <= 30) { tabEventos.classList.add('tab-flash-red'); } else if (nearestSecs <= 60) { tabEventos.style.backgroundColor = '#e74c3c'; tabEventos.style.color = '#fff'; } else if (nearestSecs <= 300) { tabEventos.style.backgroundColor = 'rgba(243, 156, 18, 0.9)'; tabEventos.style.color = '#fff'; } else if (nearestSecs <= 900) { tabEventos.style.backgroundColor = 'rgba(243, 156, 18, 0.3)'; tabEventos.style.color = ''; } } return; }
    tabEventos.innerText = globalHasError ? `${ICON_WARNING_LABEL} Eventos` : 'Eventos';
}

function updateEventCountdowns() {
    const isTabVisible = document.getElementById('content-eventos').style.display !== 'none'; const chkManual = document.getElementById('chk-events-manual'); const chkMaster = document.getElementById('chk-events-master'); const isManualOnly = chkManual ? chkManual.checked : false; const isMasterActive = chkMaster ? chkMaster.checked : true;
    let globalHasError = false; let nearestHealthy = null; let nearestSecs = Infinity; let recentEmergency = false; const nowMs = Date.now();

    eventsMasterDB.forEach(ev => {
        const timeData = formatEventTimeLeft(ev);
        const queueEntry = getEventQueueEntry(ev, timeData);
        if (isMasterActive && queueEntry && timeData.seconds <= EVENT_PREFLIGHT_WINDOW_SECONDS && timeData.seconds > 0) {
            const recheckMs = timeData.seconds <= 60 ? EVENT_PREFLIGHT_FINAL_RECHECK_MS : EVENT_PREFLIGHT_RECHECK_MS;
            const shouldRecheckIntegrity = !ev.checkedForThisCycle || ev.hasError || !queueEntry.lastCheckedAt || (Date.now() - queueEntry.lastCheckedAt >= recheckMs);
            if (shouldRecheckIntegrity) {
                ev.checkedForThisCycle = true;
                ev.lastIntegrityCheckAt = Date.now();
                runEventPreflight(ev, queueEntry, 'auto').catch(() => {
                    setEventQueueStatus(queueEntry, 'blocked', 'ERROR', 'Fallo de preflight');
                    ev.hasError = true;
                    ev.errorDiscoveredAt = Date.now();
                    ev.errorLoggedFor = 'preflight';
                    refreshEventsIncidentStatus();
                    renderEventTimeline(true);
                });
            }
        } else if (timeData.seconds > EVENT_PREFLIGHT_WINDOW_SECONDS + 10 || timeData.seconds < 0) { ev.checkedForThisCycle = false; delete ev.lastIntegrityCheckAt; }
        if (ev.hasError) { globalHasError = true; if (ev.errorDiscoveredAt && (nowMs - ev.errorDiscoveredAt < 30000)) { recentEmergency = true; } }
        else { if (timeData.seconds > 0 && timeData.seconds < nearestSecs) { nearestSecs = timeData.seconds; nearestHealthy = ev; } }
        if (isTabVisible) {
            const li = document.querySelector(`.event-item[data-id="${ev.id}"]`);
            if (li && queueEntry) li.dataset.queueStatus = queueEntry.status;
            if (li) { li.querySelector('.evt-countdown').innerText = timeData.text; let displayName = ev.name; if (ev.hasError) { li.style.backgroundColor = '#e01283'; li.classList.remove('evt-flash-red', 'evt-flash-red-hard'); displayName = `[${ICON_WARNING_LABEL}] ${ev.name}`; } else { const isQueuedWithDelay = isEventQueuedWithMaxDelay(ev.id); applyEventWarningColors(li, timeData.seconds, ev.colorBg, isQueuedWithDelay); } li.querySelector('.evt-name').innerText = displayName; }
        }
    });
    updateTabAppearance(globalHasError, nearestHealthy, nearestSecs, recentEmergency, isManualOnly, isMasterActive);
    refreshEventsIncidentStatus();
    renderEventTimeline();
}
setInterval(updateEventCountdowns, 1000);

async function queueEventForEmission(ev, options = {}) {
    clearEventPreHold();
    const manualNow = new Date();
    const manualOccurrence = (options.manual || options.playlistCommand) ? {
        date: manualNow,
        timeStr: `${manualNow.getHours().toString().padStart(2, '0')}:${manualNow.getMinutes().toString().padStart(2, '0')}:${manualNow.getSeconds().toString().padStart(2, '0')}`
    } : null;
    const occurrence = options.occurrence || manualOccurrence || getNextAbsoluteOccurrence(ev, true);
    const entry = getEventQueueEntryForOccurrence(ev, occurrence);
    if (!entry) {
        recordIncident(`[EVENTOS] ${ev.name}: no tiene una hora valida para entrar en cola.`, { category: 'events', level: 'error' });
        return false;
    }

    const preflightReason = options.playlistCommand ? 'fire' : (options.manual ? 'manual' : 'fire');
    const inspection = await runEventPreflight(ev, entry, preflightReason);
    if (!inspection.ok) {
        setEventQueueStatus(entry, 'blocked', 'ERROR', inspection.message || 'Fuente no lista');
        renderEventTimeline(true);
        return false;
    }

    setEventQueueStatus(entry, 'dispatching', 'ENVIO', options.playlistCommand ? 'Ejecucion desde playlist' : (options.manual ? 'Ejecucion manual' : 'Disparo automatico'));
    const executed = await executeEvent(ev, { queueKey: entry.key, scheduledTime: entry.timeStr, manual: !!options.manual, playlistCommand: options.playlistCommand === true });
    if (!executed) {
        setEventQueueStatus(entry, 'blocked', 'ERROR', 'No se pudo cargar en playlist');
        recordIncident(`[EVENTOS] ${ev.name}: no se pudo cargar en la playlist.`, { category: 'events', level: 'error' });
        renderEventTimeline(true);
        return false;
    }
    recordIncident(`[EVENTOS] ${ev.name}: enviado a emision${options.manual ? ' manual' : ''}.`, { category: 'events', level: 'success' });
    renderEventTimeline(true);
    return true;
}

document.getElementById('gm-edit').addEventListener('click', () => { ipcRenderer.send('open-event-groups'); hideAllMenus(); });
document.getElementById('btn-events-add').addEventListener('click', () => ipcRenderer.send('open-event-editor', null));
document.getElementById('btn-events-mod').addEventListener('click', () => { const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) { ev.hasError = false; ev.errorLoggedFor = null; ipcRenderer.send('open-event-editor', ev); } });
document.getElementById('eim-exec').addEventListener('click', () => { const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) queueEventForEmission(ev, { manual: true }); hideAllMenus(); });
document.getElementById('eim-ignore').addEventListener('click', () => { const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) { const absoluteTarget = getNextAbsoluteOccurrence(ev, true); if (absoluteTarget) { const dateStr = absoluteTarget.date.toDateString(); const ignoreKey = `${ev.id}_${absoluteTarget.timeStr}_${dateStr}`; if (ignoredEventTriggers.includes(ignoreKey)) { ignoredEventTriggers = ignoredEventTriggers.filter(k => k !== ignoreKey); } else { ignoredEventTriggers.push(ignoreKey); if (ev.hasError) { ev.hasError = false; ev.errorLoggedFor = null; } } updateEventCountdowns(); } } hideAllMenus(); });
document.getElementById('eim-mod').addEventListener('click', () => { const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) { ev.hasError = false; ev.errorLoggedFor = null; ipcRenderer.send('open-event-editor', ev); } hideAllMenus(); });
document.getElementById('eim-del').addEventListener('click', async () => { const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) { hideAllMenus(); const confirm = await ipcRenderer.invoke('dialog:confirm', `Seguro que deseas eliminar el evento "${ev.name}"? Esta accion no se puede deshacer.`); if (confirm) { eventsMasterDB = eventsMasterDB.filter(e => e.id !== selectedEventId); selectedEventId = null; updateSelectedEventControls(); saveEventsDB(); renderEventsList(); } } });
document.getElementById('em-calendar').addEventListener('click', () => { ipcRenderer.send('open-calendar'); hideAllMenus(); });
document.getElementById('btn-events-list').addEventListener('click', (e) => {
    e.stopPropagation();
    if (eventsListMenu && eventsListMenu.style.display === 'block') {
        hideAllMenus();
    } else {
        hideAllMenus();
        showContextMenu(eventsListMenu, e.pageX - 100, e.pageY + 10);
        applyMenuLogic();
    }
});
document.getElementById('em-save-all').addEventListener('click', () => { const blob = new Blob([JSON.stringify(eventsMasterDB, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `Respaldo_Total.eventoslf`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); hideAllMenus(); });
document.getElementById('em-load').addEventListener('click', () => { document.getElementById('load-event-input').click(); hideAllMenus(); });
document.getElementById('load-event-input').addEventListener('change', (e) => { if (e.target.files.length === 0) return; const file = e.target.files[0]; const reader = new FileReader(); reader.onload = (ev) => { try { const data = JSON.parse(ev.target.result); if (Array.isArray(data)) { eventsMasterDB = data; } else { const idx = eventsMasterDB.findIndex(ex => ex.id === data.id); if (idx >= 0) eventsMasterDB[idx] = data; else eventsMasterDB.push(data); } saveEventsDB(); } catch (err) { } }; reader.readAsText(file); e.target.value = ''; });
document.getElementById('btn-events-exec').addEventListener('click', () => { if (!selectedEventId) return; const ev = eventsMasterDB.find(e => e.id === selectedEventId); if (ev) queueEventForEmission(ev, { manual: true }); });

const EVENT_PRIORITY_RANK = { low: 0, normal: 1, high: 2, critical: 3 };

function getEventPriority(eventObj) {
    const priority = eventObj?.priority || 'normal';
    return Object.prototype.hasOwnProperty.call(EVENT_PRIORITY_RANK, priority) ? priority : 'normal';
}

function getEventPriorityRank(eventObj) {
    return EVENT_PRIORITY_RANK[getEventPriority(eventObj)] ?? EVENT_PRIORITY_RANK.normal;
}

function getCurrentPlayingEvent() {
    const eventId = currentPlayingRow?.dataset?.eventId;
    if (!eventId) return null;
    return eventsMasterDB.find(ev => ev.id === eventId) || { priority: currentPlayingRow.dataset.eventPriority || 'normal' };
}

function isEventAudioRunning() {
    return !!(currentPlayingRow?.dataset?.eventId && !isPlayerClockPaused(activePlayer));
}

function canEventInterruptNow(eventObj, runtimeOptions = {}) {
    if (runtimeOptions.manual) return true;
    const currentEvent = getCurrentPlayingEvent();
    if (!currentEvent || !isEventAudioRunning()) return true;
    return getEventPriorityRank(eventObj) > getEventPriorityRank(currentEvent);
}

function getPlaylistRowEventRank(row) {
    if (!row?.dataset?.eventId) return -1;
    return EVENT_PRIORITY_RANK[row.dataset.eventPriority || 'normal'] ?? EVENT_PRIORITY_RANK.normal;
}

function getPriorityInsertTarget(targetTbody, baseTarget, eventObj) {
    if (!targetTbody || !baseTarget) return baseTarget;
    const newRank = getEventPriorityRank(eventObj);
    let target = baseTarget;
    let scan = baseTarget.nextElementSibling;
    while (scan && scan.parentNode === targetTbody) {
        if (!scan.dataset.eventId) break;
        const scanRank = getPlaylistRowEventRank(scan);
        if (scanRank <= newRank) break;
        target = scan;
        scan = scan.nextElementSibling;
    }
    return target;
}

function getPlaybackAnchorRow() {
    if (currentPlayingRow && document.body.contains(currentPlayingRow)) return currentPlayingRow;
    return document.querySelector('#playlist-table tr.row-active');
}

function moveRowsAfterAnchor(rows, anchorRow) {
    if (!anchorRow || !anchorRow.parentNode || !Array.isArray(rows) || rows.length === 0) return false;
    let ref = anchorRow;
    rows.forEach(row => {
        if (!row || !row.parentNode || row === ref) return;
        ref.parentNode.insertBefore(row, ref.nextSibling);
        ref = row;
    });
    return true;
}

function syncQueuedNextAfterEventInsert(targetTbody, firstInsertedRow) {
    if (!firstInsertedRow) return;

    const anchorRow = getPlaybackAnchorRow();
    if (anchorRow && targetTbody && targetTbody.contains(anchorRow)) {
        setQueuedNextAutomatic(firstInsertedRow);
    } else if (!currentPlayingRow || (isPlayerClockPaused(activePlayer) && getPlayerClockTime(activePlayer) === 0)) {
        setQueuedNextAutomatic(firstInsertedRow);
    } else {
        updateNextTrackVisuals();
    }
}

function getRowsInPlaylistBody(tbody) {
    return tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
}

function getBatchRowsInPlaylistBody(tbody, batchId) {
    if (!tbody || !batchId) return [];
    return getRowsInPlaylistBody(tbody).filter(row => row.dataset.batchId === batchId);
}

function clearPlaylistBodyForEventBatch(tbody, batchId) {
    if (!tbody || !batchId) return;
    getRowsInPlaylistBody(tbody).forEach(row => {
        if (row.dataset.batchId === batchId) return;
        if (row === queuedNextRow) queuedNextRow = null;
        row.remove();
    });
}

function resolvePriorityNextRow(candidate) {
    if (!currentPlayingRow || !document.body.contains(currentPlayingRow)) return candidate;
    const naturalNext = currentPlayingRow.nextElementSibling;
    if (!naturalNext || !document.body.contains(naturalNext)) return candidate;
    if (naturalNext === candidate) return candidate;

    if (candidate && candidate.closest('tbody') === currentPlayingRow.closest('tbody') && !isRowAfterAnchor(candidate, currentPlayingRow)) {
        if (candidate.dataset.manualNext === "true") return candidate;
        return resolveNextOperationalRow(naturalNext, false);
    }

    // Proteccion de seleccion manual del usuario
    if (candidate && candidate.dataset.manualNext === "true") {
        // Solo sobreescribimos si el naturalNext es un evento CRITICO (rank >= 3)
        // Esto permite que el usuario salte locuciones horarias programadas
        // pero que no se salte por error una Pauta Legal o Alerta critica.
        if (naturalNext.dataset.eventId && getPlaylistRowEventRank(naturalNext) >= 3) {
            return naturalNext;
        }
        return candidate;
    }

    if (naturalNext.dataset.eventId && (!candidate || !candidate.dataset.eventId || getPlaylistRowEventRank(naturalNext) >= getPlaylistRowEventRank(candidate))) {
        return naturalNext;
    }
    return candidate;
}

function getEventPreHoldSeconds() {
    return Math.max(1, Math.min(120, parseInt(generalPrefs.eventPreHoldSeconds, 10) || 20));
}

function getUpcomingEventWithinPreHold() {
    if (generalPrefs.eventPreHoldActive === false) return null;
    const master = document.getElementById('chk-events-master');
    const manual = document.getElementById('chk-events-manual');
    if ((master && !master.checked) || (manual && manual.checked)) return null;
    const now = Date.now();
    const windowSeconds = getEventPreHoldSeconds();
    let best = null;
    eventsMasterDB.forEach(ev => {
        if (!ev || ev.hasError || isEventQueuedWithMaxDelay(ev.id)) return;
        const occurrence = getNextAbsoluteOccurrence(ev, false);
        if (!occurrence) return;
        const seconds = Math.ceil((occurrence.date.getTime() - now) / 1000);
        if (seconds < 0 || seconds > windowSeconds) return;
        if (!best || seconds < best.seconds) best = { ev, occurrence, seconds };
    });
    return best;
}

function clearEventPreHold() {
    eventPreHoldActive = false;
    eventPreHoldKey = null;
    if (eventPreHoldTimer) {
        clearTimeout(eventPreHoldTimer);
        eventPreHoldTimer = null;
    }
}

function holdForUpcomingEvent(item) {
    if (!item) return false;
    const key = `${item.ev.id}_${item.occurrence.timeStr}_${item.occurrence.date.toDateString()}`;
    if (eventPreHoldActive && eventPreHoldKey === key) return true;
    clearEventPreHold();
    eventPreHoldActive = true;
    eventPreHoldKey = key;
    setIncidentStatus('events', 'En espera', 'warn');
    recordIncident(`[EVENTOS] Esperando ${item.seconds}s para no pisar el evento "${item.ev.name}".`, { category: 'events', level: 'warn' });
    eventPreHoldTimer = setTimeout(() => {
        clearEventPreHold();
        if (!currentPlayingRow || isPlayerClockPaused(activePlayer)) playNext(false);
    }, Math.max(1500, (item.seconds + 3) * 1000));
    refreshAirIncidentStatus();
    renderEventTimeline(true);
    return true;
}

function markEventQueueAfterInsert(eventObj, runtimeOptions, firstInsertedRow, maxDelayActive, execution, action, canInterrupt) {
    if (!runtimeOptions?.queueKey) return;
    const entry = eventRuntimeQueue.get(runtimeOptions.queueKey);
    if (!entry) return;
    if (maxDelayActive) {
        setEventQueueStatus(entry, 'waiting', 'ESPERA', 'En cola con retardo maximo');
    } else if (action === 'append-end') {
        setEventQueueStatus(entry, 'queued', 'COLA', 'Agregado al final de la playlist');
    } else if (execution === 'interrupt' && canInterrupt) {
        setEventQueueStatus(entry, 'fired', 'AL AIRE', 'Disparado a emision');
    } else if (execution === 'interrupt') {
        setEventQueueStatus(entry, 'queued', 'COLA', 'En espera por evento activo de igual o mayor prioridad');
    } else if (firstInsertedRow && currentPlayingRow && firstInsertedRow !== currentPlayingRow) {
        setEventQueueStatus(entry, 'queued', 'COLA', 'Preparado como siguiente');
    } else {
        setEventQueueStatus(entry, 'fired', 'AL AIRE', 'Disparado a emision');
    }
    renderEventTimeline(true);
}

async function executeEvent(eventObj, runtimeOptions = {}) {
    let pistas = [];
    if (eventObj.sourceType === 'commercial') {
        try {
            const blocks = await ipcRenderer.invoke('commercial-get-blocks');
            const block = Array.isArray(blocks) ? blocks.find(item => item.id === eventObj.filePath) : null;
            if (!block || !Array.isArray(block.items) || block.items.length === 0) return false;
            pistas = block.items
                .filter(item => item.sourceType === 'time' || (item.filePath && fs.existsSync(item.filePath)))
                .map(item => ({
                    ruta: item.sourceType === 'time' ? 'time_locution' : item.filePath,
                    nombre: item.sourceType === 'time' ? ICON_CLOCK_LABEL : (item.title || path.basename(item.filePath)),
                    duracion: item.sourceType === 'time' ? (item.duration || 5) : (item.duration || 0),
                    type: item.sourceType === 'time' || item.sourceType === 'random' ? item.sourceType : 'normal',
                    temp: item.temp !== false
                }));
        } catch (e) { return false; }
    } else if (eventObj.sourceType === 'folder') {
        try {
            const finalPath = takeRandomFolderFile(eventObj.filePath);
            if (!finalPath) return false;
            await warmTrackFromLibraryAndFile(finalPath);
            const dur = getCachedTrackDurationSeconds(finalPath, 180);
            pistas.push({ ruta: finalPath, nombre: `[Rotativa] ${path.basename(finalPath)}`, duracion: dur, type: 'normal' });
        } catch (e) { return false; }
    } else if (eventObj.filePath.toLowerCase().endsWith('.lfplay')) {
        try { const content = fs.readFileSync(eventObj.filePath, 'utf-8'); const data = JSON.parse(content); pistas = data.map(item => ({ ruta: item.ruta, nombre: item.titulo || path.basename(item.ruta), duracion: item.duracion, type: item.type || 'normal', temp: item.temp === true || /^[\u23f3\u231b]/.test(item.titulo || '') })); } catch (e) { return false; }
    } else { let dur = 0; try { dur = Math.round(await getAudioDuration(eventObj.filePath)); } catch (e) { } pistas.push({ ruta: eventObj.filePath, nombre: path.basename(eventObj.filePath), duracion: dur, type: 'normal' }); }

    if (pistas.length === 0) return false;
    const action = eventObj.action || 'add'; const execution = eventObj.execution || 'interrupt'; const maxDelayActive = execution === 'max-delay' && eventObj.maxDelayActive; const priority = getEventPriority(eventObj); const interruptAllowed = execution === 'interrupt' && canEventInterruptNow(eventObj, runtimeOptions); const fromPlaylistCommand = runtimeOptions.playlistCommand === true; const deferClearUntilExecution = action === 'clear' && currentPlayingRow && !interruptAllowed && !fromPlaylistCommand;

    const targetTbody = currentPlayingRow ? currentPlayingRow.closest('tbody') : tbodys[currentViewTab] || tbodys[pgmTab];

    if (action === 'clear' && !deferClearUntilExecution) {
        const clearTabIndex = tbodys.indexOf(targetTbody);
        recordIncident(`[EVENTOS] ${eventObj.name}: limpiando Playlist ${clearTabIndex + 1} para cargar evento.`, { category: 'events', level: 'warn' });
        targetTbody.innerHTML = '';
        if (queuedNextRow && (!queuedNextRow.parentNode || targetTbody.contains(queuedNextRow))) queuedNextRow = null;
    }

    let firstInsertedRow = null; let currentTarget = null;
    if (action === 'temp') { currentTarget = currentPlayingRow; }
    else if (action === 'clear' && deferClearUntilExecution && currentPlayingRow) { currentTarget = currentPlayingRow; }
    else if (action === 'add') { currentTarget = currentPlayingRow || null; }
    else if (action === 'append-end') { currentTarget = targetTbody.lastElementChild; }
    if (currentTarget && action !== 'append-end') currentTarget = getPriorityInsertTarget(targetTbody, currentTarget, eventObj);
    const batchId = Date.now().toString();
    const insertedRows = [];

    for (let i = 0; i < pistas.length; i++) {
        let pName = pistas[i].nombre;
        const p = pistas[i];
        if ((action === 'temp' || p.temp) && !/^[\u23f3\u231b]/.test(pName)) pName = '\u23f3 ' + pName;
        const insertPosition = (currentTarget === null && action !== 'append-end') ? 'top' : 'bottom';
        const insertRef = (currentTarget === null && action !== 'append-end') ? targetTbody.firstElementChild : currentTarget;
        let tr = createPlaylistRow(p.ruta, pName, p.duracion, p.type, insertRef, insertPosition, targetTbody);
        tr.dataset.eventId = eventObj.id || '';
        tr.dataset.eventName = eventObj.name || '';
        tr.dataset.eventPriority = priority;
        if (runtimeOptions.queueKey) tr.dataset.eventQueueKey = runtimeOptions.queueKey;
        if (runtimeOptions.scheduledTime) tr.dataset.eventScheduledTime = runtimeOptions.scheduledTime;
        if (action === 'temp' || p.temp) tr.dataset.temp = 'true';
        if (maxDelayActive) {
            tr.dataset.batchId = batchId; tr.dataset.queuedAt = Date.now(); const maxDelayMinutes = parseInt(eventObj.maxDelayMinutes, 10); const maxDelaySeconds = parseInt(eventObj.maxDelaySeconds, 10); let maxDelayMs = 0;
            if (Number.isFinite(maxDelayMinutes) || Number.isFinite(maxDelaySeconds)) { const normalizedMinutes = Number.isFinite(maxDelayMinutes) ? Math.max(0, maxDelayMinutes) : 0; const normalizedSeconds = Number.isFinite(maxDelaySeconds) ? Math.min(59, Math.max(0, maxDelaySeconds)) : 0; maxDelayMs = ((normalizedMinutes * 60) + normalizedSeconds) * 1000; } else { maxDelayMs = (parseInt(eventObj.maxDelayTime) || 0) * 60000; }
            tr.dataset.maxDelay = maxDelayMs; tr.dataset.delayAction = eventObj.maxDelayAction; tr.dataset.eventId = eventObj.id; tr.dataset.clearOnExecution = deferClearUntilExecution ? 'true' : 'false';
            tr.dataset.originalTbodyIndex = tbodys.indexOf(targetTbody);
        }
        if (deferClearUntilExecution && !maxDelayActive) {
            tr.dataset.batchId = batchId;
            tr.dataset.clearOnExecution = 'true';
            tr.dataset.originalTbodyIndex = tbodys.indexOf(targetTbody);
        }
        if (action === 'clear' || deferClearUntilExecution) tr.dataset.forceFollowView = 'true';
        insertedRows.push(tr);
        if (i === 0) firstInsertedRow = tr; currentTarget = tr;
    }
    const shouldQueueAfterCurrent = firstInsertedRow
        && action !== 'append-end'
        && !fromPlaylistCommand
        && !(execution === 'interrupt' && interruptAllowed);
    const playbackAnchorRow = shouldQueueAfterCurrent ? getPlaybackAnchorRow() : null;
    if (playbackAnchorRow && playbackAnchorRow.parentNode === targetTbody) {
        moveRowsAfterAnchor(insertedRows, playbackAnchorRow);
    }
    calcularHorasPlaylist(); updateNextTrackVisuals();
    markEventQueueAfterInsert(eventObj, runtimeOptions, firstInsertedRow, maxDelayActive, execution, action, interruptAllowed || (fromPlaylistCommand && action !== 'append-end'));

    if (fromPlaylistCommand && firstInsertedRow && action !== 'append-end') {
        if (firstInsertedRow) playRow(firstInsertedRow, false, 2, { forceFollowView: action === 'clear' });
        return true;
    }
    if (action === 'append-end') { if (firstInsertedRow && (!currentPlayingRow || (isPlayerClockPaused(activePlayer) && getPlayerClockTime(activePlayer) === 0))) { playRow(firstInsertedRow, false); const entry = runtimeOptions.queueKey ? eventRuntimeQueue.get(runtimeOptions.queueKey) : null; if (entry) setEventQueueStatus(entry, 'fired', 'AL AIRE', 'Disparado a emision'); } return true; }
    if (execution === 'interrupt' && interruptAllowed) { if (firstInsertedRow) playRow(firstInsertedRow, false, 2, { forceFollowView: action === 'clear' }); } else { if (firstInsertedRow && (!currentPlayingRow || (isPlayerClockPaused(activePlayer) && getPlayerClockTime(activePlayer) === 0))) { playRow(firstInsertedRow, false, 0, { forceFollowView: action === 'clear' }); } else if (firstInsertedRow) { syncQueuedNextAfterEventInsert(targetTbody, firstInsertedRow); } }
    return true;
}

setInterval(() => {
    document.querySelectorAll('.playlist-table tr[data-queued-at]').forEach(tr => {
        if (!tr.parentNode) return;
        const queuedAt = parseInt(tr.dataset.queuedAt); const maxDelay = parseInt(tr.dataset.maxDelay); const action = tr.dataset.delayAction; const batchId = tr.dataset.batchId;
        const queueEntry = tr.dataset.eventQueueKey ? eventRuntimeQueue.get(tr.dataset.eventQueueKey) : null;
        if (Date.now() - queuedAt > maxDelay) {
            if (action === 'omit') {
                if (queueEntry && queueEntry.status !== 'omitted') {
                    setEventQueueStatus(queueEntry, 'omitted', 'OMITIDO', 'Retardo maximo vencido');
                    recordIncident(`[EVENTOS] ${queueEntry.eventName}: omitido por retardo maximo.`, { category: 'events', level: 'warn' });
                }
                getBatchRowsInPlaylistBody(tr.closest('tbody'), batchId).forEach(r => { if (r === queuedNextRow) queuedNextRow = r.nextElementSibling || null; r.remove(); });
                calcularHorasPlaylist(); updateNextTrackVisuals(); renderEventTimeline(true);
            } else if (action === 'force') {
                if (isEventAudioRunning() && !canEventInterruptNow({ priority: tr.dataset.eventPriority || 'normal' })) {
                    getBatchRowsInPlaylistBody(tr.closest('tbody'), batchId).forEach(r => { delete r.dataset.queuedAt; });
                    syncQueuedNextAfterEventInsert(tr.closest('tbody'), tr);
                    if (queueEntry) {
                        setEventQueueStatus(queueEntry, 'queued', 'COLA', 'Retardo vencido; espera evento activo de igual o mayor prioridad');
                        recordIncident(`[EVENTOS] ${queueEntry.eventName}: no se forzo por prioridad del evento al aire.`, { category: 'events', level: 'warn' });
                    }
                    calcularHorasPlaylist(); updateNextTrackVisuals(); renderEventTimeline(true);
                    return;
                }
                const batchBody = tr.closest('tbody'); const batchRows = getBatchRowsInPlaylistBody(batchBody, batchId); const mustClearOnExecution = batchRows.some(r => r.dataset.clearOnExecution === 'true');
                if (mustClearOnExecution) { clearPlaylistBodyForEventBatch(batchBody, batchId); }
                getBatchRowsInPlaylistBody(batchBody, batchId).forEach(r => { delete r.dataset.queuedAt; delete r.dataset.clearOnExecution; });
                if (queueEntry) {
                    setEventQueueStatus(queueEntry, 'fired', 'AL AIRE', 'Forzado por retardo maximo');
                    recordIncident(`[EVENTOS] ${queueEntry.eventName}: forzado por retardo maximo.`, { category: 'events', level: 'warn' });
                }
                if (tr.parentNode) playRow(tr, true, 2, { forceFollowView: mustClearOnExecution }); calcularHorasPlaylist(); updateNextTrackVisuals(); renderEventTimeline(true);
            }
        }
    });

    const masterEnable = document.getElementById('chk-events-master') ? document.getElementById('chk-events-master').checked : true;
    const manualOnly = document.getElementById('chk-events-manual') ? document.getElementById('chk-events-manual').checked : false;
    if (!masterEnable || manualOnly) return;

    const now = new Date(); const currentH = now.getHours(); const currentM = now.getMinutes(); const currentS = now.getSeconds();
    const currentStr = `${currentH.toString().padStart(2, '0')}:${currentM.toString().padStart(2, '0')}:${currentS.toString().padStart(2, '0')}`;

    eventsMasterDB.forEach(ev => {
        if (!isDateValidForEvent(now, ev)) return;
        if (isEventQueuedWithMaxDelay(ev.id)) return;
        if (ev.requirePlaying && (!eventPreHoldActive && (!currentPlayingRow || isPlayerClockPaused(activePlayer)))) {
            let expandedTimes = getExpandedEventTimes(ev);
            if (expandedTimes.includes(currentStr)) {
                const todayStr = now.toDateString(); const fireId = getEventFireId(ev, currentStr, now); const ignoreId = `${ev.id}_${currentStr}_${todayStr}`;
                if (ev.lastFired !== fireId && !ignoredEventTriggers.includes(ignoreId)) {
                    const entry = getEventQueueEntryForOccurrence(ev, { date: new Date(now.getTime()), timeStr: currentStr });
                    if (entry) setEventQueueStatus(entry, 'skipped', 'OMITIDO', 'Requiere audio al aire');
                    ev.lastFired = fireId;
                    saveEventsDB();
                    recordIncident(`[EVENTOS] ${ev.name}: omitido porque no habia audio al aire.`, { category: 'events', level: 'warn' });
                    renderEventTimeline(true);
                }
            }
            return;
        }

        let expandedTimes = getExpandedEventTimes(ev);
        expandedTimes.forEach(tTime => {
            if (currentStr === tTime) {
                const todayStr = now.toDateString(); const fireId = getEventFireId(ev, tTime, now); const ignoreId = `${ev.id}_${tTime}_${todayStr}`;
                if (ev.lastFired !== fireId && !ignoredEventTriggers.includes(ignoreId)) {
                    ev.lastFired = fireId;
                    saveEventsDB();
                    queueEventForEmission(ev, { occurrence: { date: new Date(now.getTime()), timeStr: tTime } }).catch(() => {
                        recordIncident(`[EVENTOS] ${ev.name}: disparo bloqueado por error interno.`, { category: 'events', level: 'error' });
                    });
                }
            }
        });
    });
}, 1000);

explorerContainer.addEventListener('click', () => { hideAllMenus(); clearSelection(); });

async function loadDrives() {
    const isLinux = process.platform === 'linux';
    let drives = [];
    try { drives = await ipcRenderer.invoke('get-system-drives'); } catch (e) { }
    try {
        const paths = await ipcRenderer.invoke('get-default-paths');
        const shortcuts = [];
        // Windows: Desktop + Downloads + Music
        // Linux: Downloads + Music + Home (sin Desktop, no se usa)
        if (!isLinux && paths.desktop) shortcuts.push(paths.desktop);
        if (paths.downloads) shortcuts.push(paths.downloads);
        if (paths.music) shortcuts.push(paths.music);
        if (isLinux && paths.home) shortcuts.push(paths.home);
        renderTree([...shortcuts, ...drives], explorerContainer, true);
    } catch (e) {
        renderTree(drives, explorerContainer, true);
    }
}

function clearSelection() { document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('selected')); }
function updateExplorerItemsCache() { explorerItemsCache = Array.from(document.querySelectorAll('.tree-item')); }
function handleExplorerSelection(e, div) {
    updateExplorerItemsCache();
    const currentIndex = explorerItemsCache.indexOf(div);
    if (e.shiftKey && anchorExplorerIndex !== -1) {
        clearSelection();
        const start = Math.min(anchorExplorerIndex, currentIndex);
        const end = Math.max(anchorExplorerIndex, currentIndex);
        for (let i = start; i <= end; i++) if (explorerItemsCache[i]) explorerItemsCache[i].classList.add('selected');
        lastSelectedExplorerIndex = currentIndex;
    } else if (e.ctrlKey) {
        div.classList.toggle('selected');
        lastSelectedExplorerIndex = currentIndex;
        anchorExplorerIndex = currentIndex;
    } else {
        clearSelection();
        div.classList.add('selected');
        lastSelectedExplorerIndex = currentIndex;
        anchorExplorerIndex = currentIndex;
    }
}
function getSelectedExplorerPaths() { return Array.from(document.querySelectorAll('.tree-item.selected')).map(el => el.dataset.path).filter(Boolean); }

function renderTree(items, container, isRoot = false) {
    const ul = document.createElement('ul'); ul.className = isRoot ? 'file-tree root' : 'file-tree';
    let dirs = [], files = [];
    items.forEach(itemPath => {
        try {
            const stats = fs.statSync(itemPath);
            if (stats.isDirectory()) dirs.push(itemPath);
            else if (/\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(itemPath)) files.push(itemPath);
        } catch (e) { console.error("Error leyendo ruta:", itemPath, e); }
    });

    if (!isRoot) {
        dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
        files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    }

    [...dirs, ...files].forEach(itemPath => {
        const li = document.createElement('li'); const div = document.createElement('div'); div.className = 'tree-item';
        let name = path.basename(itemPath) || itemPath;
        let icon = '📁';

        let isDir = false; try { isDir = fs.statSync(itemPath).isDirectory(); } catch (e) { return; }

        if (isRoot) {
            const isLinux = process.platform === 'linux';
            const lowerPath = itemPath.toLowerCase();
            const lowerName = name.toLowerCase();
            // Escritorio: solo en Windows
            if (!isLinux && (lowerPath.includes('desktop') || lowerName === 'escritorio')) {
                name = 'Escritorio'; icon = '💻';
            }
            else if (lowerPath.includes('downloads') || lowerName === 'descargas') {
                name = 'Descargas'; icon = '📥';
            }
            else if (lowerPath.includes('music') || lowerName === 'música' || lowerName === 'musica') {
                name = 'Música'; icon = '🎵';
            }
            // Home de Linux
            else if (isLinux && itemPath === os.homedir()) {
                name = 'Inicio'; icon = '🏠';
            }
            // Discos USB/externos montados en /media/ o /mnt/
            else if (isLinux && (itemPath.startsWith('/media/') || itemPath.startsWith('/mnt/'))) {
                name = `Disco (${path.basename(itemPath)})`; icon = '💿';
            }
            // Unidades de disco Windows
            else if (!isLinux) {
                name = `Disco Local (${itemPath.replace(/[\\/]/g, '')})`; icon = '💿';
            }
        }

        if (isDir) {
            div.dataset.path = itemPath;
            div.innerHTML = `<span class="tree-toggle">+</span><span class="icon-folder">${icon}</span> ${name}`; div.draggable = true;
            div.ondragstart = (e) => {
                if (!div.classList.contains('selected')) { clearSelection(); div.classList.add('selected'); updateExplorerItemsCache(); const idx = explorerItemsCache.indexOf(div); lastSelectedExplorerIndex = idx; anchorExplorerIndex = idx; }
                const paths = getSelectedExplorerPaths();
                e.dataTransfer.setData('application/json', JSON.stringify(paths));
                if (paths.length === 1) e.dataTransfer.setData('text/plain', paths[0]);
                else e.dataTransfer.setData('text/plain', 'multiple_explorer_items');
                e.dataTransfer.effectAllowed = 'copy';
            };
            div.onclick = (e) => {
                e.stopPropagation();
                if (e.target.classList.contains('tree-toggle')) {
                    div.ondblclick(e);
                    return;
                }
                hideAllMenus(); handleExplorerSelection(e, div);
            };
            div.ondblclick = (e) => {
                e.stopPropagation();
                let childUl = li.querySelector('ul');
                const iconSpan = div.querySelector('.icon-folder');
                const toggleSpan = div.querySelector('.tree-toggle');
                if (childUl) {
                    if (childUl.style.display === 'none') {
                        childUl.style.display = 'block';
                        if (iconSpan && iconSpan.textContent === '📁') iconSpan.textContent = '📂';
                        if (toggleSpan) toggleSpan.textContent = '-';
                    } else {
                        childUl.style.display = 'none';
                        if (iconSpan && iconSpan.textContent === '📂') iconSpan.textContent = '📁';
                        if (toggleSpan) toggleSpan.textContent = '+';
                    }
                } else {
                    try {
                        if (iconSpan && iconSpan.textContent === '📁') iconSpan.textContent = '📂';
                        if (toggleSpan) toggleSpan.textContent = '-';
                        const children = fs.readdirSync(itemPath).map(child => path.join(itemPath, child));
                        renderTree(children, li);
                    } catch (err) { console.error("Error abriendo carpeta:", err); }
                }
            };
            div.oncontextmenu = (e) => {
                e.preventDefault(); e.stopPropagation(); clearSelection(); div.classList.add('selected'); contextMenuTargetFolder = itemPath;
                let explicitId = explicitTypesDB[itemPath];
                if (!explicitId) explicitId = getTrackTypeData(path.join(itemPath, 'dummy.mp3')) ? getTrackTypeData(path.join(itemPath, 'dummy.mp3')).id : null;
                const isDefault = !explicitId;

                const typeMenu = document.getElementById('exp-folder-type-list');
                typeMenu.innerHTML = `<div class="context-item" onclick="window.setExplicitTypeExplorer('default')">${isDefault ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} Música (Por defecto)</div><div class="context-separator"></div>`;

                fileTypesData.forEach(t => { const isChecked = (explicitId === t.id); const divOpt = document.createElement('div'); divOpt.className = 'context-item'; divOpt.innerHTML = `${isChecked ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} ${t.name}`; divOpt.style.color = t.color; divOpt.onclick = () => window.setExplicitTypeExplorer(t.id); typeMenu.appendChild(divOpt); });
                showContextMenu(explorerFolderMenu, e.pageX, e.pageY);
                applyMenuLogic();
            };
        } else {
            if (!/\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(name)) return;
            div.dataset.path = itemPath;
            div.innerHTML = `<span class="icon-file">🎵</span> ${name}`; div.draggable = true;
            div.ondragstart = (e) => {
                if (!div.classList.contains('selected')) { clearSelection(); div.classList.add('selected'); updateExplorerItemsCache(); const idx = explorerItemsCache.indexOf(div); lastSelectedExplorerIndex = idx; anchorExplorerIndex = idx; }
                const paths = getSelectedExplorerPaths();
                e.dataTransfer.setData('application/json', JSON.stringify(paths));
                if (paths.length === 1) e.dataTransfer.setData('text/plain', paths[0]);
                else e.dataTransfer.setData('text/plain', 'multiple_explorer_items');
                e.dataTransfer.effectAllowed = 'copy';
            };
            div.onclick = (e) => { e.stopPropagation(); hideAllMenus(); handleExplorerSelection(e, div); };
            div.ondblclick = async (e) => { e.stopPropagation(); let targetRow = document.querySelector('.selected-row'); await addTrackToPlaylist(itemPath, 'normal', targetRow, 'bottom', playlistBody); };
            div.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); clearSelection(); div.classList.add('selected'); contextMenuTargetFolder = itemPath; showContextMenu(explorerFileMenu, e.pageX, e.pageY); applyMenuLogic(); };
        }
        li.appendChild(div); ul.appendChild(li);
    });
    container.appendChild(ul); applyMenuLogic();
}
explorerContainer.innerHTML = ''; loadDrives();

window.setExplicitTypeExplorer = function (typeId) {
    const ruta = contextMenuTargetFolder; if (!ruta) return;
    if (typeId === 'default') delete explicitTypesDB[ruta]; else explicitTypesDB[ruta] = typeId;
    saveExplicitTypes(); hideAllMenus();
    document.querySelectorAll('.playlist-table tr').forEach(tr => { const typeData = getTrackTypeData(tr.dataset.ruta); const rowColor = (tr.dataset.type === 'time') ? '#2ecc71' : (tr.dataset.type === 'random') ? '#f39c12' : (typeData ? typeData.color : '#e0e0e0'); tr.style.color = rowColor; });
};

document.getElementById('ctx-add-random').addEventListener('click', async () => { let targetRow = document.querySelector('.selected-row'); if (contextMenuTargetFolder) await addRandomFolderToPlaylist(contextMenuTargetFolder, targetRow, 'bottom', playlistBody); hideAllMenus(); });
document.getElementById('ctx-add-all').addEventListener('click', async () => { let targetRow = document.querySelector('.selected-row'); if (contextMenuTargetFolder) await handleDroppedItem(contextMenuTargetFolder, targetRow, 'bottom', playlistBody); hideAllMenus(); });
document.getElementById('ctx-file-add').addEventListener('click', async () => { let targetRow = document.querySelector('.selected-row'); if (contextMenuTargetFolder) await addTrackToPlaylist(contextMenuTargetFolder, 'normal', targetRow, 'bottom', playlistBody); hideAllMenus(); });
document.getElementById('ctx-file-preview').addEventListener('click', () => { if (contextMenuTargetFolder) ipcRenderer.send('open-preview', contextMenuTargetFolder); hideAllMenus(); });
document.getElementById('ctx-file-edit').addEventListener('click', () => { if (contextMenuTargetFolder) ipcRenderer.send('open-audio-editor', contextMenuTargetFolder); hideAllMenus(); });

if (playlistSection) {
    let playlistDragDepth = 0;
    playlistSection.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (!isExternalPlaylistDrop(e.dataTransfer)) return;
        playlistDragDepth++;
        playlistSection.classList.add('playlist-drop-active');
    });
    playlistSection.addEventListener('dragleave', (e) => {
        if (!playlistSection.contains(e.relatedTarget)) playlistDragDepth = 0;
        else playlistDragDepth = Math.max(0, playlistDragDepth - 1);
        if (playlistDragDepth === 0) playlistSection.classList.remove('playlist-drop-active');
    });
    playlistSection.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = draggedTableRow ? 'move' : 'copy';
        if (!isExternalPlaylistDrop(e.dataTransfer)) playlistSection.classList.remove('playlist-drop-active');
    });

    playlistSection.addEventListener('drop', async (e) => {
        e.preventDefault();
        playlistDragDepth = 0;
        clearPlaylistDragState();
        let targetTbodyForDrop = e.target.closest('tbody') || playlistBody;

        if (draggedTableRow) {
            if (e.target === playlistSection || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY' || e.target.tagName === 'TR' || e.target.tagName === 'TD') {
                let rowsToMove = Array.from(document.querySelectorAll('.selected-row')); if (!rowsToMove.includes(draggedTableRow)) rowsToMove = [draggedTableRow];
                rowsToMove.forEach(row => targetTbodyForDrop.appendChild(row));
                calcularHorasPlaylist(); updateNextTrackVisuals(); lastSelectedRowIndex = -1; anchorRowIndex = -1;
            }
            clearPlaylistDragState();
            draggedTableRow = null;
            return;
        }
        let lastRow = null;
        beginBulkInsert();
        try {
            const droppedFilePaths = getDroppedFilePaths(e.dataTransfer);
            if (droppedFilePaths.length > 0) {
                for (let filePath of droppedFilePaths) {
                    lastRow = await handleDroppedItem(filePath, lastRow, 'bottom', targetTbodyForDrop);
                }
            } else if (e.dataTransfer.types.includes('lf_genre_key') || Array.from(e.dataTransfer.types).some(t => t.toLowerCase() === 'lf_genre_key')) {
                const genreKey = e.dataTransfer.getData('lf_genre_key');
                if (genreKey) {
                    const result = await ipcRenderer.invoke('genre-editor-get-tracks', genreKey);
                    if (result?.success && result.tracks) {
                        for (let t of result.tracks) {
                            lastRow = await handleDroppedItem(t.filePath, lastRow, 'bottom', targetTbodyForDrop);
                        }
                    }
                }
            } else if (e.dataTransfer.types.includes('application/json')) {
                try {
                    const paths = JSON.parse(e.dataTransfer.getData('application/json'));
                    for (let p of paths) {
                        lastRow = await handleDroppedItem(p, lastRow, 'bottom', targetTbodyForDrop);
                    }
                } catch (err) { }
            } else {
                const filePath = e.dataTransfer.getData('text/plain');
                if (filePath && filePath !== 'internal_row' && filePath !== 'multiple_internal_rows') {
                    await handleDroppedItem(filePath, lastRow, 'bottom', targetTbodyForDrop);
                }
            }
        } finally {
            endBulkInsert();
            clearPlaylistDragState();
        }
    });
}

let bulkInsertDepth = 0;
function beginBulkInsert() { bulkInsertDepth++; }
function endBulkInsert() {
    bulkInsertDepth = Math.max(0, bulkInsertDepth - 1);
    if (bulkInsertDepth === 0) {
        calcularHorasPlaylist();
        updateNextTrackVisuals();
    }
}
function isBulkInsertActive() { return bulkInsertDepth > 0; }


async function handleDroppedItem(itemPath, insertTarget = null, position = 'bottom', targetTbody = null) {
    let lastInsertedRow = insertTarget;
    let currentPos = position;
    try {
        const stats = await fs.promises.stat(itemPath);
        if (stats.isDirectory()) {
            const CHUNK_SIZE = 25;
            let processed = 0;
            let pendingPaths = [];
            beginBulkInsert();
            try {
                for await (const filePath of walkAudioFilesAsync(itemPath)) {
                    pendingPaths.push(filePath);
                    if (pendingPaths.length >= CHUNK_SIZE) {
                        await ensureDbTracksLoaded(pendingPaths);
                        for (const pendingPath of pendingPaths) {
                            lastInsertedRow = await addTrackToPlaylist(pendingPath, 'normal', lastInsertedRow, currentPos, targetTbody);
                            currentPos = 'bottom';
                            processed++;
                        }
                        pendingPaths = [];
                        endBulkInsert();
                        await nextTick();
                        beginBulkInsert();
                    }
                }
                if (pendingPaths.length > 0) {
                    await ensureDbTracksLoaded(pendingPaths);
                    for (const pendingPath of pendingPaths) {
                        lastInsertedRow = await addTrackToPlaylist(pendingPath, 'normal', lastInsertedRow, currentPos, targetTbody);
                        currentPos = 'bottom';
                        processed++;
                    }
                }
            } finally {
                endBulkInsert();
            }
        } else {
            if (/\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(itemPath)) {
                await ensureDbTracksLoaded([itemPath]);
                lastInsertedRow = await addTrackToPlaylist(itemPath, 'normal', lastInsertedRow, currentPos, targetTbody);
            }
        }
    } catch (err) { }
    return lastInsertedRow;
}
async function addRandomFolderToPlaylist(folderPath, insertTarget = null, position = 'bottom', targetTbody = null) {
    warmRandomFolder(folderPath);
    const filename = `[Aleatorio] ${path.basename(folderPath)}`;
    return createPlaylistRow(folderPath, filename, 180, 'random', insertTarget, position, targetTbody);
}

async function addTrackToPlaylist(filePath, type = 'normal', insertTarget = null, position = 'bottom', targetTbody = null) {
    let filename = path.basename(filePath);
    if (!manualCuesDB[filePath]) await ensureDbTracksLoaded([filePath]);
    const cachedTrack = manualCuesDB[filePath] || null;
    if (cachedTrack) {
        let artistStr = cachedTrack.customArtist ? cachedTrack.customArtist + ' - ' : '';
        let titleStr = cachedTrack.customTitle || filename.replace(/\.[^/.]+$/, "");
        if (cachedTrack.customTitle || cachedTrack.customArtist) {
            filename = artistStr + titleStr;
        }
    }
    let duracionSegundos = Math.round(parseFloat(cachedTrack?.duration || 0) || 0);
    if (!duracionSegundos) {
        try {
            duracionSegundos = Math.round(await getAudioDuration(filePath));
        } catch (e) { }
    }
    if (cachedTrack) {
        const sT = cachedTrack.inicio ? parseFloat(cachedTrack.inicio) : 0;
        const eT = cachedTrack.fin ? parseFloat(cachedTrack.fin) : duracionSegundos;
        if (eT > sT) duracionSegundos = Math.round(eT - sT);
    }
    return createPlaylistRow(filePath, filename, duracionSegundos, type, insertTarget, position, targetTbody);
}

function createPlaylistRow(ruta, nombre, duracionSegundos, type = 'normal', insertTarget = null, position = 'bottom', targetTbody = null) {
    const bodyToUse = targetTbody || playlistBody;
    if (type === 'time' || ruta === 'time_locution') {
        type = 'time';
        ruta = 'time_locution';
        nombre = ICON_CLOCK_LABEL;
    }
    if (PLAYLIST_COMMAND_TYPES.has(type)) {
        duracionSegundos = 0;
        if (type === 'stop') ruta = 'playlist_command_stop';
        if (type === 'note') ruta = 'playlist_note';
        if (type === 'playlist_jump') ruta = 'playlist_jump';
        if (type === 'execute_event') ruta = ruta || 'playlist_execute_event';
    }

    let m = Math.floor(duracionSegundos / 60).toString().padStart(2, '0');
    let s = (duracionSegundos % 60).toString().padStart(2, '0');
    let duracionStr = m + ':' + s;
    const tr = document.createElement('tr');
    tr.dataset.ruta = ruta;
    tr.dataset.duracion = duracionSegundos;
    tr.dataset.type = type;

    const typeData = getTrackTypeData(ruta);
    const rowColor = (type === 'time') ? '#2ecc71' : (type === 'random') ? '#f39c12' : (typeData ? typeData.color : '#e0e0e0');
    tr.style.color = rowColor;
    if (type === 'time' || type === 'random') tr.style.fontStyle = 'italic';

    let pureName = nombre;
    let ext = '';
    const match = String(nombre || '').match(/(.*)(\.[a-zA-Z0-9]{2,5})$/i);
    if (match && type !== 'time' && type !== 'random' && !PLAYLIST_COMMAND_TYPES.has(type)) {
        pureName = match[1];
        ext = match[2];
    }
    tr.dataset.pureName = pureName;
    tr.dataset.ext = ext;
    let displayedName = window.showPlaylistExtensions ? (pureName + ext) : pureName;

    let introTxt = '0.0';
    let outroTxt = '0.0';
    if (manualCuesDB[ruta]) {
        if (manualCuesDB[ruta].intro) introTxt = parseFloat(manualCuesDB[ruta].intro).toFixed(1);
        if (manualCuesDB[ruta].outro) outroTxt = parseFloat(manualCuesDB[ruta].outro).toFixed(1);
    }

    if (PLAYLIST_COMMAND_TYPES.has(type)) {
        let targetTab = null;
        if (type === 'playlist_jump') {
            targetTab = parseInt(nombre, 10);
            if (!Number.isInteger(targetTab) || targetTab < 0) targetTab = parseInt(ruta, 10);
            if (!Number.isInteger(targetTab) || targetTab < 0) targetTab = 0;
            tr.dataset.targetTab = targetTab;
        }
        if (type === 'note') {
            const cleanNote = String(nombre || '').replace(/^(?:\u{1f4dd}|📝)\s*/u, '').trim();
            tr.dataset.noteText = cleanNote === 'Nota' ? '' : cleanNote;
        }
        if (type === 'execute_event') {
            tr.dataset.eventId = ruta && ruta !== 'playlist_execute_event' ? ruta : '';
            tr.dataset.eventName = String(nombre || '').replace(/^(?:\u{1f4c5}|ðŸ“…)\s*Ejecutar evento:\s*/iu, '').trim();
        }
        displayedName = formatSpecialPlaylistTitle(type, tr.dataset.targetTab, tr.dataset.noteText || '');
        if (type === 'execute_event') displayedName = formatSpecialPlaylistTitle(type, null, tr.dataset.eventName || nombre || '');
        pureName = displayedName;
        ext = '';
        tr.dataset.pureName = pureName;
        tr.dataset.ext = '';
        duracionStr = '--:--';
        introTxt = '--';
        outroTxt = '--';
        if (type === 'stop') {
            tr.style.backgroundColor = 'rgba(231, 76, 60, 0.15)';
            tr.style.color = '#e74c3c';
            tr.style.fontWeight = 'bold';
        } else if (type === 'note') {
            tr.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
            tr.style.color = '#aaaaaa';
            tr.style.fontStyle = 'italic';
        } else if (type === 'playlist_jump') {
            tr.style.backgroundColor = 'rgba(155, 89, 182, 0.15)';
            tr.style.color = '#d2a8ff';
            tr.style.fontWeight = 'bold';
        } else if (type === 'execute_event') {
            tr.style.backgroundColor = 'rgba(0, 168, 255, 0.12)';
            tr.style.color = '#79d6ff';
            tr.style.fontWeight = 'bold';
        }
    }

    tr.innerHTML = '<td>--:--:--</td><td style="font-weight:bold;">' + displayedName + '</td><td>' + duracionStr + '</td><td>' + introTxt + '</td><td>' + outroTxt + '</td>';
    normalizeTimeLocutionRow(tr);

    if (insertTarget) {
        if (position === 'top') bodyToUse.insertBefore(tr, insertTarget);
        else bodyToUse.insertBefore(tr, insertTarget.nextSibling);
    } else {
        bodyToUse.appendChild(tr);
    }

    tr.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = draggedTableRow ? 'move' : 'copy';
        if (draggedTableRow && draggedTableRow === tr) return;
        if (draggedTableRow && tr.classList.contains('selected-row')) return;
        const rect = tr.getBoundingClientRect();
        const nextDragSide = ((e.clientY - rect.top) > rect.height / 2) ? 'bottom' : 'top';
        if (tr.dataset.dragSide === nextDragSide) return;
        tr.dataset.dragSide = nextDragSide;
        tr.classList.toggle('drag-over-top', nextDragSide === 'top');
        tr.classList.toggle('drag-over-bottom', nextDragSide === 'bottom');
    };
    tr.ondragleave = () => { delete tr.dataset.dragSide; tr.classList.remove('drag-over-top', 'drag-over-bottom'); };
    tr.ondrop = async (e) => {
        e.preventDefault(); e.stopPropagation(); delete tr.dataset.dragSide; tr.classList.remove('drag-over-top', 'drag-over-bottom'); const rect = tr.getBoundingClientRect(); const isBottom = (e.clientY - rect.top) > (rect.height / 2); const targetPosition = isBottom ? 'bottom' : 'top';
        let targetTbodyForDrop = tr.closest('tbody');
        if (draggedTableRow) {
            if (draggedTableRow !== tr && !tr.classList.contains('selected-row')) { let rowsToMove = Array.from(document.querySelectorAll('.selected-row')); if (!rowsToMove.includes(draggedTableRow)) rowsToMove = [draggedTableRow]; let refNode = isBottom ? tr.nextSibling : tr; rowsToMove.forEach(row => { if (row !== tr) targetTbodyForDrop.insertBefore(row, refNode); }); calcularHorasPlaylist(); updateNextTrackVisuals(); lastSelectedRowIndex = -1; anchorRowIndex = -1; }
        } else {
            let lastRow = null;
            const droppedFilePaths = getDroppedFilePaths(e.dataTransfer);
            if (droppedFilePaths.length > 0) { for (let filePath of droppedFilePaths) { let refTarget = lastRow ? lastRow : tr; let refPos = lastRow ? 'bottom' : targetPosition; lastRow = await handleDroppedItem(filePath, refTarget, refPos, targetTbodyForDrop); } }
            else if (e.dataTransfer.types.includes('lf_genre_key') || Array.from(e.dataTransfer.types).some(t => t.toLowerCase() === 'lf_genre_key')) {
                const genreKey = e.dataTransfer.getData('lf_genre_key');
                if (genreKey) {
                    const result = await ipcRenderer.invoke('genre-editor-get-tracks', genreKey);
                    if (result?.success && result.tracks) {
                        for (let t of result.tracks) { let refTarget = lastRow ? lastRow : tr; let refPos = lastRow ? 'bottom' : targetPosition; lastRow = await handleDroppedItem(t.filePath, refTarget, refPos, targetTbodyForDrop); }
                    }
                }
            }
            else if (e.dataTransfer.types.includes('application/json')) { try { const paths = JSON.parse(e.dataTransfer.getData('application/json')); for (let p of paths) { let refTarget = lastRow ? lastRow : tr; let refPos = lastRow ? 'bottom' : targetPosition; lastRow = await handleDroppedItem(p, refTarget, refPos, targetTbodyForDrop); } } catch (err) { } }
            else { const filePath = e.dataTransfer.getData('text/plain'); if (filePath && filePath !== 'internal_row' && filePath !== 'multiple_internal_rows') { await handleDroppedItem(filePath, tr, targetPosition, targetTbodyForDrop); } }
        }
        clearPlaylistDragState();
        draggedTableRow = null;
    };
    tr.ondragend = () => { clearPlaylistDragState(); draggedTableRow = null; };

    const titleCell = tr.children[1]; titleCell.draggable = true;
    titleCell.ondragstart = (e) => {
        if (!tr.classList.contains('selected-row')) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            tr.classList.add('selected-row');
            const targetBody = tr.closest('tbody');
            if (targetBody) {
                lastSelectedRowIndex = Array.from(targetBody.children).indexOf(tr);
                anchorRowIndex = lastSelectedRowIndex;
            }
        }
        draggedTableRow = tr;
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', 'internal_row');
        const selectedRows = Array.from(document.querySelectorAll('.selected-row'));
        const paths = selectedRows.map(r => r.dataset.ruta).filter(Boolean).filter(p => !String(p).startsWith('playlist_'));
        if (paths.length > 0) {
            e.dataTransfer.setData('application/json', JSON.stringify(paths));
            if (paths.length === 1) e.dataTransfer.setData('text/plain', paths[0]);
            else e.dataTransfer.setData('text/plain', 'multiple_internal_rows');
        }
        document.querySelectorAll('.selected-row').forEach(el => el.classList.add('dragging-row'));
    };

    tr.ondblclick = async (e) => {
        if (isPlaylistNoteRow(tr)) {
            if (e.ctrlKey) return;
            const currentNote = tr.dataset.noteText || '';
            const newNote = await requestPlaylistNoteText(currentNote);
            if (newNote !== null) {
                tr.dataset.noteText = newNote.trim();
                tr.dataset.pureName = formatSpecialPlaylistTitle('note', null, tr.dataset.noteText);
                tr.children[1].innerText = tr.dataset.pureName;
                saveSessionSnapshot();
            }
            return;
        }
        const targetRow = resolveNextOperationalRow(tr, false);
        if (!targetRow) return;
        if (e.ctrlKey) {
            playRow(targetRow, false, 0, { forceFollowView: true, startCause: 'manual-jump' });
        } else {
            setQueuedNextManual(targetRow);
        }
    };
    tr.onclick = (e) => {
        const targetBody = tr.closest('tbody');
        const rows = Array.from(targetBody.children);
        const currentIndex = rows.indexOf(tr);
        if (e.shiftKey && anchorRowIndex !== -1) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            const start = Math.min(anchorRowIndex, currentIndex);
            const end = Math.max(anchorRowIndex, currentIndex);
            for (let i = start; i <= end; i++) rows[i].classList.add('selected-row');
            lastSelectedRowIndex = currentIndex;
        } else if (e.ctrlKey) {
            tr.classList.toggle('selected-row');
            lastSelectedRowIndex = currentIndex;
            anchorRowIndex = currentIndex;
        } else {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            tr.classList.add('selected-row');
            lastSelectedRowIndex = currentIndex;
            anchorRowIndex = currentIndex;
        }
    };
    if (!insertTarget && !queuedNextRow && !currentPlayingRow && !isPlaylistNoteRow(tr)) setQueuedNextManual(tr);
    if (!isBulkInsertActive()) {
        calcularHorasPlaylist();
        updateNextTrackVisuals();
    }

    const useMixDb = typeData ? typeData.mixDbActive : generalPrefs.chk_mus_mix_db;
    if (!isBulkInsertActive() && useMixDb && type !== 'time' && type !== 'random' && !isPlaylistCommandRow(tr)) {
        const cached = manualCuesDB[ruta];
        if (!cached || !cached.db) {
            const targetDb = typeData ? typeData.mixDb : generalPrefs.num_mus_mix_db;
            ensurePreanalysisForTrack(ruta, { dbMix: targetDb });
        }
    }
    return tr;
}

if (playlistSection) {
    playlistSection.addEventListener('contextmenu', (e) => {
        if (e.target.closest('thead')) return;
        const tr = e.target.closest('tr');
        const tbody = tr ? tr.closest('tbody') : (e.target.closest('tbody') || playlistBody);
        if (!tbody || !tbodys.includes(tbody)) return;

        e.preventDefault(); e.stopPropagation();
        const typeMenu = document.getElementById('pm-type-list');
        if (!tr) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            lastSelectedRowIndex = -1;
            anchorRowIndex = -1;
            rightClickedRow = null;
            if (typeMenu) typeMenu.innerHTML = '';
            setPlaylistContextMenuMode('empty');
            showContextMenu(playlistContextMenu, e.pageX, e.pageY);
            applyMenuLogic();
            return;
        }

        if (!tr.classList.contains('selected-row')) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            tr.classList.add('selected-row');
            lastSelectedRowIndex = Array.from(tbody.children).indexOf(tr);
            anchorRowIndex = lastSelectedRowIndex;
        }

        rightClickedRow = tr; const currentRuta = tr.dataset.ruta; const explicitId = explicitTypesDB[currentRuta]; const isDefault = !explicitId;
        typeMenu.innerHTML = `<div class="context-item" onclick="window.setExplicitType('default')">${isDefault ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} Música (Por defecto)</div><div class="context-separator"></div>`;
        fileTypesData.forEach(t => { const isChecked = (explicitId === t.id); const div = document.createElement('div'); div.className = 'context-item'; div.innerHTML = `${isChecked ? '✓ ' : '&nbsp;&nbsp;&nbsp;'} ${t.name}`; div.style.color = t.color; div.onclick = () => window.setExplicitType(t.id); typeMenu.appendChild(div); });


        setPlaylistContextMenuMode(tr.dataset.type === 'note' ? 'note' : 'row');

        showContextMenu(playlistContextMenu, e.pageX, e.pageY);
        applyMenuLogic();
    });
}

window.setExplicitType = function (typeId) {
    document.querySelectorAll('.selected-row').forEach(tr => {
        const ruta = tr.dataset.ruta; if (typeId === 'default') { delete explicitTypesDB[ruta]; } else { explicitTypesDB[ruta] = typeId; }
        const typeData = getTrackTypeData(ruta); const rowColor = (tr.dataset.type === 'time') ? '#2ecc71' : (tr.dataset.type === 'random') ? '#f39c12' : (typeData ? typeData.color : '#e0e0e0'); tr.style.color = rowColor;
    }); saveExplicitTypes(); hideAllMenus();
}

document.getElementById('pm-copy').addEventListener('click', () => { clipboardData = Array.from(document.querySelectorAll('.selected-row')).map(tr => ({ ruta: tr.dataset.ruta, nombre: (tr.dataset.pureName || '') + (tr.dataset.ext || ''), duracion: tr.dataset.duracion, type: tr.dataset.type, temp: tr.dataset.temp === 'true', noteText: tr.dataset.noteText || null, targetTab: Number.isInteger(parseInt(tr.dataset.targetTab, 10)) ? parseInt(tr.dataset.targetTab, 10) : null, eventId: tr.dataset.eventId || null, eventName: tr.dataset.eventName || null })); clipboardAction = 'copy'; hideAllMenus(); });
document.getElementById('pm-cut').addEventListener('click', () => { clipboardData = Array.from(document.querySelectorAll('.selected-row')).map(tr => ({ ruta: tr.dataset.ruta, nombre: (tr.dataset.pureName || '') + (tr.dataset.ext || ''), duracion: tr.dataset.duracion, type: tr.dataset.type, temp: tr.dataset.temp === 'true', noteText: tr.dataset.noteText || null, targetTab: Number.isInteger(parseInt(tr.dataset.targetTab, 10)) ? parseInt(tr.dataset.targetTab, 10) : null, eventId: tr.dataset.eventId || null, eventName: tr.dataset.eventName || null, element: tr })); clipboardData.forEach(item => { if (item.element === queuedNextRow) queuedNextRow = null; item.element.remove(); }); calcularHorasPlaylist(); updateNextTrackVisuals(); clipboardAction = 'cut'; hideAllMenus(); });
document.getElementById('pm-paste').addEventListener('click', () => { if (clipboardData.length === 0) return; let targetRow = rightClickedRow; let targetTbody = targetRow ? targetRow.closest('tbody') : (tbodys[currentViewTab] || playlistBody); clipboardData.forEach(item => { const rowName = item.type === 'playlist_jump' ? item.targetTab : (item.type === 'note' ? (item.noteText || item.nombre) : (item.type === 'execute_event' ? (item.eventName || item.nombre) : item.nombre)); const newTr = createPlaylistRow(item.type === 'execute_event' ? (item.eventId || item.ruta) : item.ruta, rowName, parseInt(item.duracion), item.type, targetRow, 'bottom', targetTbody); if (newTr && item.temp) newTr.dataset.temp = 'true'; if (newTr && item.type === 'note' && item.noteText) newTr.dataset.noteText = item.noteText; if (newTr && item.type === 'playlist_jump' && Number.isInteger(parseInt(item.targetTab, 10))) newTr.dataset.targetTab = parseInt(item.targetTab, 10); if (newTr && item.type === 'execute_event') { newTr.dataset.eventId = item.eventId || item.ruta || ''; newTr.dataset.eventName = item.eventName || rowName || ''; } targetRow = newTr; }); if (clipboardAction === 'cut') { clipboardData = []; clipboardAction = null; } calcularHorasPlaylist(); updateNextTrackVisuals(); saveSessionSnapshot(); hideAllMenus(); });
document.getElementById('pm-delete').addEventListener('click', () => { document.querySelectorAll('.selected-row').forEach(tr => { if (tr === queuedNextRow) queuedNextRow = resolveNextOperationalRow(tr.nextElementSibling, false); tr.remove(); }); calcularHorasPlaylist(); updateNextTrackVisuals(); hideAllMenus(); });
document.getElementById('pm-clear').addEventListener('click', () => { handleClearPlaylist(); hideAllMenus(); });
document.getElementById('pm-preview').addEventListener('click', () => { if (rightClickedRow) ipcRenderer.send('open-preview', rightClickedRow.dataset.ruta); hideAllMenus(); });

document.getElementById('pm-edit-name').addEventListener('click', () => {
    if (!rightClickedRow) return;
    let currentName = rightClickedRow.dataset.pureName || rightClickedRow.children[1].innerText;
    let isTemp = rightClickedRow.dataset.temp === 'true';
    if (/^(?:\u23f3|⏳)\s/.test(currentName)) currentName = currentName.replace(/^(?:\u23f3|⏳)\s*/, '');

    const newName = prompt("Editar nombre de la pista:", currentName);
    if (newName && newName.trim() !== "") {
        let finalName = newName.trim(); if (isTemp) finalName = ICON_TEMP_PREFIX + finalName;
        rightClickedRow.dataset.pureName = finalName; rightClickedRow.dataset.ext = ''; rightClickedRow.children[1].innerText = finalName;
        if (currentPlayingRow === rightClickedRow) {
            let cleanName = finalName.replace(/^(?:\u23f3|⏳)\s*/, '');
            document.getElementById('txt-cancion').innerText = cleanName;
            if (isPlaybackActuallyOnAir()) ipcRenderer.send('update-metadata', cleanName);
            else setIdleBroadcastMetadata();
        }
        if (queuedNextRow === rightClickedRow) updateNextTrackVisuals();
    } hideAllMenus();
});

document.getElementById('pm-set-next').addEventListener('click', () => { const nextRow = resolveNextOperationalRow(rightClickedRow, false); if (nextRow) { setQueuedNextManual(nextRow); } hideAllMenus(); });
document.getElementById('pm-advanced-edit').addEventListener('click', () => { if (rightClickedRow) ipcRenderer.send('open-audio-editor', rightClickedRow.dataset.ruta); hideAllMenus(); });

document.getElementById('pm-transition-edit').addEventListener('click', () => {
    if (!rightClickedRow) return;
    const nextRow = rightClickedRow.nextElementSibling;
    if (!nextRow) { alert("No hay una pista siguiente para realizar la transiciÃ³n."); hideAllMenus(); return; }
    // FIX BUG (reapertura): si la fila ya tenía mixPoint guardado, pasarlo
    // al editor para que reconstruya visualmente la edición previa.
    const savedMix = parseFloat(rightClickedRow.dataset.customMix);
    const data = {
        trackA: rightClickedRow.dataset.ruta, nameA: rightClickedRow.dataset.pureName || rightClickedRow.children[1].innerText,
        trackB: nextRow.dataset.ruta, nameB: nextRow.dataset.pureName || nextRow.children[1].innerText,
        // savedMixPoint: segundo dentro de A donde la pista B debe arrancar.
        savedMixPoint: Number.isFinite(savedMix) ? savedMix : null
    };
    ipcRenderer.send('open-transition-editor', data); hideAllMenus();
});

document.getElementById('pm-jingle-edit').addEventListener('click', () => {
    if (!rightClickedRow) return;
    const prevRow = rightClickedRow.previousElementSibling; const nextRow = rightClickedRow.nextElementSibling;
    if (!prevRow || !nextRow) { alert("El pisador debe estar ubicado entre dos canciones."); hideAllMenus(); return; }
    // FIX BUG (reapertura con tiempos guardados): si el operador ya editó este
    // pisador antes, las filas tienen `dataset.customMix` con los segundos
    // dentro de cada pista donde se debe iniciar el siguiente bloque. Los
    // pasamos al editor para que reconstruya visualmente la disposición que
    // el operador dejó al guardar — antes se ignoraban y todo aparecía
    // montado en el default (-10s pisador, -5s pista B).
    const prevCustomMix = parseFloat(prevRow.dataset.customMix);
    const jingleCustomMix = parseFloat(rightClickedRow.dataset.customMix);
    const data = {
        trackA: prevRow.dataset.ruta, nameA: prevRow.dataset.pureName || prevRow.children[1].innerText,
        jingle: rightClickedRow.dataset.ruta, nameJingle: rightClickedRow.dataset.pureName || rightClickedRow.children[1].innerText,
        trackB: nextRow.dataset.ruta, nameB: nextRow.dataset.pureName || nextRow.children[1].innerText,
        // mixPointA: segundo dentro de A donde el jingle debe arrancar (si fue guardado antes).
        savedMixPointA: Number.isFinite(prevCustomMix) ? prevCustomMix : null,
        // mixPointJ: segundo dentro del jingle donde la pista B debe arrancar.
        savedMixPointJ: Number.isFinite(jingleCustomMix) ? jingleCustomMix : null
    };
    ipcRenderer.send('open-jingle-editor', data); hideAllMenus();
});

document.getElementById('pm-shuffle').addEventListener('click', () => {
    hideAllMenus();
    handleShuffleActivePlaylist();
});

document.getElementById('pm-toggle-temp').addEventListener('click', () => {
    document.querySelectorAll('.selected-row').forEach(tr => {
        let isTemp = tr.dataset.temp === 'true';
        tr.dataset.temp = isTemp ? 'false' : 'true';
        let currentName = tr.dataset.pureName || tr.children[1].innerText;
        if (isTemp && /^(?:\u23f3|⏳)\s/.test(currentName)) {
            tr.dataset.pureName = currentName.replace(/^(?:\u23f3|⏳)\s*/, '');
            tr.children[1].innerText = tr.dataset.pureName;
        } else if (!isTemp && !/^(?:\u23f3|⏳)\s/.test(currentName)) {
            tr.dataset.pureName = ICON_TEMP_PREFIX + currentName;
            tr.children[1].innerText = ICON_TEMP_PREFIX + currentName;
        }
    });
    hideAllMenus();
});

ipcRenderer.on('apply-transition', (e, res) => {
    document.querySelectorAll('.playlist-table tr').forEach(row => {
        if (row.dataset.ruta === res.trackA) row.dataset.customMix = res.mixPoint;
    });
});

ipcRenderer.on('apply-jingle-transition', (e, res) => {
    document.querySelectorAll('.playlist-table tr').forEach(row => {
        if (row.dataset.ruta === res.trackA) row.dataset.customMix = res.mixPointA;
        if (row.dataset.ruta === res.jingle) row.dataset.customMix = res.mixPointJ;
    });
});


function getTrackTypeData(filePath) {
    const types = fileTypesData;
    if (manualCuesDB[filePath] && manualCuesDB[filePath].typeId) { const found = types.find(t => t.id === manualCuesDB[filePath].typeId); if (found) return found; }
    if (explicitTypesDB[filePath]) { const found = types.find(t => t.id === explicitTypesDB[filePath]); if (found) return found; }
    const dirPath = path.dirname(filePath);
    if (explicitTypesDB[dirPath]) { const found = types.find(t => t.id === explicitTypesDB[dirPath]); if (found) return found; }

    const nameStr = path.basename(filePath).toLowerCase();
    for (let t of types) {
        if (t.identifier && t.identifier.trim() !== '') {
            const iden = t.identifier.toLowerCase().trim();
            if (/^[a-z0-9]+$/.test(iden)) {
                const regex = new RegExp('\\b' + iden + '\\b', 'i');
                if (regex.test(nameStr)) return t;
            } else {
                if (nameStr.includes(iden)) return t;
            }
        }
    }
    return null;
}

function normalizeRotationText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

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

    (genreProfiles || []).forEach(profile => {
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
        ...fileTypesData.map(t => ({ id: t.id, name: t.name, color: t.color || '#e0e0e0', identifier: t.identifier || '', source: 'type' })),
        ...getRotationGenreCategoryDefs()
    ];
}

function resolveRotationCategory(token, categoryDefs = null) {
    const clean = normalizeRotationText(String(token || '').replace(/^@/, ''));
    if (!clean || ['musica', 'default', 'general', 'normal'].includes(clean)) return { id: 'default', name: 'Musica', color: '#e0e0e0' };
    const defs = categoryDefs || getRotationCategoryDefs();
    return defs.find(cat => {
        return normalizeRotationText(cat.id) === clean || normalizeRotationText(cat.name) === clean || normalizeRotationText(cat.identifier) === clean || normalizeRotationText(cat.genreKey) === clean || (Array.isArray(cat.aliases) && cat.aliases.some(alias => normalizeRotationText(alias) === clean));
    }) || null;
}

function getDefaultRotationPattern() {
    const stationId = fileTypesData.find(t => /station|id|pisador|jingle/i.test(`${t.name} ${t.identifier}`));
    return ['Musica', stationId ? stationId.name : null, 'Musica', 'Musica'].filter(Boolean).join('\n');
}

function parseRotationIntegerInput(input, fallback, min, max) {
    const raw = String(input?.value ?? '').replace(/[^\d]/g, '');
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function commitRotationIntegerInput(id, fallback, min, max) {
    const input = document.getElementById(id);
    if (!input) return fallback;
    const value = parseRotationIntegerInput(input, fallback, min, max);
    input.value = String(value);
    return value;
}

function commitRotationNumberInputs() {
    commitRotationIntegerInput('rotation-target-min', 60, 5, 360);
    commitRotationIntegerInput('rotation-sep-artist', 4, 0, 50);
    commitRotationIntegerInput('rotation-sep-title', 8, 0, 50);
}

function readRotationPrefsFromUi() {
    const patternEl = document.getElementById('rotation-pattern');
    const targetEl = document.getElementById('rotation-target-min');
    const artistEl = document.getElementById('rotation-sep-artist');
    const titleEl = document.getElementById('rotation-sep-title');
    const artistCheck = document.getElementById('rotation-sep-artist-check');
    const titleCheck = document.getElementById('rotation-sep-title-check');
    return {
        pattern: patternEl ? patternEl.value : '',
        targetMinutes: parseRotationIntegerInput(targetEl, 60, 5, 360),
        sepArtist: parseRotationIntegerInput(artistEl, 4, 0, 50),
        sepTitle: parseRotationIntegerInput(titleEl, 8, 0, 50),
        checkArtist: artistCheck ? artistCheck.checked : true,
        checkTitle: titleCheck ? titleCheck.checked : true
    };
}

function saveClockwheelPrefsFromUi() {
    clockwheelPrefs = readRotationPrefsFromUi();
    saveConfig(clockwheelPrefsPath, clockwheelPrefs);
}

function getRotationPatternCategories(patternText, categoryDefs = null) {
    const defs = categoryDefs || getRotationCategoryDefs();
    const rawTokens = String(patternText || '').split(/[\n,>]+/).map(t => t.trim()).filter(Boolean);
    const tokens = rawTokens.length ? rawTokens : getDefaultRotationPattern().split(/\n/);
    return tokens.map(token => ({ token, category: resolveRotationCategory(token, defs) })).filter(item => item.category);
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
    Object.entries(manualCuesDB || {}).forEach(([filePath, data]) => {
        if (!filePath || !/\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(filePath)) return;
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

function pickRotationTrack(pool, recent, prefs) {
    if (!pool || !pool.items || pool.items.length === 0) return null;

    if (pool.cursor >= pool.items.length) {
        pool.items = shuffleArray([...pool.items]);
        pool.cursor = 0;
    }

    const passes = [
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

    for (const predicate of passes) {
        for (let i = pool.cursor; i < pool.items.length; i++) {
            const track = pool.items[i];
            if (track.isIdentifier && recent.paths.includes(track.filePath)) continue;

            if (predicate(track)) {
                const temp = pool.items[pool.cursor];
                pool.items[pool.cursor] = pool.items[i];
                pool.items[i] = temp;

                const pickedTrack = pool.items[pool.cursor];
                pool.cursor++;
                return isTimeLocutionTrack(pickedTrack) ? { ...pickedTrack } : { ...pickedTrack };
            }
        }
    }

    const fallbackTrack = pool.items[pool.cursor];
    pool.cursor++;
    return isTimeLocutionTrack(fallbackTrack) ? { ...fallbackTrack } : { ...fallbackTrack };
}

async function buildRotationPlan() {
    const prefs = readRotationPrefsFromUi();
    const categoryDefs = getRotationCategoryDefs();
    const pattern = getRotationPatternCategories(prefs.pattern, categoryDefs);

    if (!pattern || pattern.length === 0) {
        throw new Error('El patron esta vacio o es invalido.');
    }

    const byCategory = getRotationCandidates(categoryDefs);
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

    // Use setTimeout to yield so the "Calculando..." UI update can paint
    await new Promise(resolve => setTimeout(resolve, 10));

    while (totalSeconds < targetSeconds && pattern.length > 0 && attempts < 1200) {
        attempts++;
        const item = pattern[cursor % pattern.length];
        cursor++;
        const pool = byCategory.get(item.category.id) || [];
        const track = pickRotationTrack(pool, recent, prefs);

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

function updateRotationQuickSummary() {
    const summary = document.getElementById('rotation-summary');
    if (!summary) return;
    const prefs = readRotationPrefsFromUi();
    const rawPattern = String(prefs.pattern || getDefaultRotationPattern());
    const patternSteps = rawPattern.split(/[\n,>]+/).map(t => t.trim()).filter(Boolean).length;
    summary.textContent = `Patron: ${patternSteps} paso(s)\nObjetivo: ${prefs.targetMinutes} minuto(s)\nPulsa Preflight para calcular sin bloquear mientras editas.`;
}

function updateRotationSummary(plan = null) {
    const summary = document.getElementById('rotation-summary');
    if (!summary) return;
    if (!plan) {
        updateRotationQuickSummary();
        return;
    }
    const missingItems = Array.isArray(plan.missing) ? plan.missing : Object.keys(plan.missing || {});
    const missingText = missingItems.length ? `\nAlertas: ${missingItems.join(', ')} sin suficientes canciones.` : '';
    const prefs = readRotationPrefsFromUi();
    const rawPattern = String(prefs.pattern || getDefaultRotationPattern());
    const patternSteps = rawPattern.split(/[\n,>]+/).map(t => t.trim()).filter(Boolean).length;
    summary.textContent = `Patron: ${patternSteps} paso(s)\nGeneraria: ${plan.tracks.length} pista(s) / ${formatRotationDuration(plan.totalSeconds)}${missingText}`;
}

function runRotationPreflight() {
    const summary = document.getElementById('rotation-summary');
    if (summary) summary.textContent = 'Calculando preflight...';
    setTimeout(async () => {
        try {
            saveClockwheelPrefsFromUi();
            updateRotationSummary(await buildRotationPlan());
        } catch (err) {
            if (summary) summary.textContent = `No se pudo calcular: ${err.message}`;
        }
    }, 0);
}

function populateRotationModal() {
    const patternEl = document.getElementById('rotation-pattern');
    const targetEl = document.getElementById('rotation-target-min');
    const artistEl = document.getElementById('rotation-sep-artist');
    const titleEl = document.getElementById('rotation-sep-title');
    const artistCheck = document.getElementById('rotation-sep-artist-check');
    const titleCheck = document.getElementById('rotation-sep-title-check');
    if (patternEl) patternEl.value = clockwheelPrefs.pattern || getDefaultRotationPattern();
    if (targetEl) targetEl.value = clockwheelPrefs.targetMinutes || 60;
    if (artistEl) artistEl.value = clockwheelPrefs.sepArtist ?? 4;
    if (titleEl) titleEl.value = clockwheelPrefs.sepTitle ?? 8;
    if (artistCheck) artistCheck.checked = clockwheelPrefs.checkArtist ?? true;
    if (titleCheck) titleCheck.checked = clockwheelPrefs.checkTitle ?? true;

    const palette = document.getElementById('rotation-category-palette');
    if (palette) {
        palette.innerHTML = '';
        getRotationCategoryDefs().forEach(cat => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'rotation-chip';
            chip.textContent = cat.name;
            chip.title = cat.source === 'genre' ? `Genero: ${cat.name}` : `Tipo: ${cat.name}`;
            chip.style.color = cat.color;
            chip.addEventListener('click', () => {
                if (!patternEl) return;
                const prefix = patternEl.value.trim() ? '\n' : '';
                patternEl.value += `${prefix}${cat.name}`;
                saveClockwheelPrefsFromUi();
                updateRotationSummary();
            });
            palette.appendChild(chip);
        });
    }
    updateRotationSummary();
}

async function openRotationModal() {
    const modal = document.getElementById('rotation-modal');
    if (!modal) return;
    loadFileTypes();
    await ensureGenreProfilesLoaded(true);
    populateRotationModal();
    modal.style.display = 'flex';
}

function closeRotationModal() {
    const modal = document.getElementById('rotation-modal');
    if (modal) modal.style.display = 'none';
}

async function applyRotationPlanToPlaylist() {
    let plan;
    try {
        plan = await buildRotationPlan();
    } catch (err) {
        alert(err.message || 'No se pudo generar la rotacion.');
        return;
    }
    if (plan.tracks.length === 0) {
        alert('No hay canciones suficientes para ese patron. Revisa tipos de archivo o biblioteca.');
        updateRotationSummary(plan);
        return;
    }
    saveClockwheelPrefsFromUi();

    // --- Selector de playlist destino ---
    const selection = await showPlaylistTargetSelector();
    if (selection === null) return; // usuario canceló

    const chosenTab = selection.tab;
    const clearList = selection.clearList;

    const targetTbody = tbodys[chosenTab];
    if (!targetTbody) return;

    const playingInsideTarget = currentPlayingRow && targetTbody.contains(currentPlayingRow);

    if (clearList && playingInsideTarget) {
        alert('Esa playlist esta al aire. Por seguridad no se reemplaza mientras hay audio sonando.');
        return;
    }
    if (clearList) {
        targetTbody.innerHTML = '';
        if (queuedNextRow && !document.body.contains(queuedNextRow)) queuedNextRow = null;
    }
    let insertTarget = targetTbody.lastElementChild;
    let skippedMissing = 0;
    const skippedMissingPaths = [];
    const chunkSize = 40;
    for (let index = 0; index < plan.tracks.length; index += chunkSize) {
        const chunk = plan.tracks.slice(index, index + chunkSize);

        await ensureDbTracksLoaded(chunk.filter(t => t.rowType === 'normal').map(t => t.filePath));

        beginBulkInsert();
        try {
            for (const track of chunk) {
                const rowType = track.rowType || 'normal';
                if (rowType === 'normal' && !fs.existsSync(track.filePath)) {
                    skippedMissing++;
                    skippedMissingPaths.push(track.filePath);
                    continue;
                }
                const row = createPlaylistRow(track.filePath, track.title, track.duration, rowType, insertTarget, 'bottom', targetTbody);
                if (row) {
                    row.dataset.rotationCategory = track.category.id;
                    insertTarget = row;
                    if (rowType === 'normal') ensurePreanalysisForTrack(track.filePath);
                }
            }
        } finally {
            endBulkInsert();
        }
        await nextTick();
    }

    // Asignar siguiente si no hay uno
    if (!queuedNextRow && targetTbody.firstElementChild) {
        queuedNextRow = resolveNextOperationalRow(targetTbody.firstElementChild, false);
    }

    calcularHorasPlaylist();
    updateNextTrackVisuals();
    saveSessionSnapshot();

    if (skippedMissing > 0) {
        const missingList = skippedMissingPaths
            .map((filePath, index) => `${index + 1}. ${filePath}`)
            .join('\n');
        alert(`Se omitieron ${skippedMissing} archivo(s) que ya no existen en disco:\n\n${missingList}`);
    }
    recordIncident(`[CLOCKWHEEL] Rotacion generada: ${plan.tracks.length - skippedMissing} pista(s), ${formatRotationDuration(plan.totalSeconds)} en Playlist ${chosenTab + 1}.`, { category: 'system', level: 'success' });
    updateRotationSummary(plan);

    // Cerrar modal y cambiar a la pestaña destino
    closeRotationModal();
    if (currentViewTab !== chosenTab) {
        tbodys[currentViewTab].style.display = 'none';
        currentViewTab = chosenTab;
        ipcRenderer.send('active-tab-changed', chosenTab);
        playlistBody = tbodys[currentViewTab];
        playlistBody.style.display = 'table-row-group';
        updateTabsUI();
        calcularHorasPlaylist();
    }
}

function showPlaylistTargetSelector() {
    return new Promise(resolve => {
        // Remover selector previo si existe
        document.getElementById('rotation-playlist-selector')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'rotation-playlist-selector';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

        const box = document.createElement('div');
        box.style.cssText = 'background:#1a1a2e;border:1px solid #00a8ff;border-radius:10px;padding:24px 28px;min-width:320px;text-align:center;box-shadow:0 8px 32px rgba(0,168,255,0.2);';

        const title = document.createElement('h3');
        title.style.cssText = 'margin:0 0 6px;color:#00a8ff;font-size:16px;';
        title.textContent = '¿En cuál playlist deseas cargar?';

        const subtitle = document.createElement('p');
        subtitle.style.cssText = 'margin:0 0 18px;color:#8f96a3;font-size:12px;';
        subtitle.textContent = 'Selecciona la playlist de destino';

        box.appendChild(title);
        box.appendChild(subtitle);

        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-bottom:16px;';

        for (let i = 0; i < tbodys.length; i++) {
            const btn = document.createElement('button');
            const isLive = (currentPlayingRow && tbodys.indexOf(currentPlayingRow.closest('tbody')) === i);
            btn.textContent = `Playlist ${i + 1}`;
            btn.style.cssText = `padding:10px 18px;border-radius:6px;border:2px solid ${isLive ? '#e74c3c' : '#444'};background:${isLive ? '#2c1018' : '#222'};color:${isLive ? '#ff6b6b' : '#ccc'};cursor:pointer;font-size:13px;font-weight:bold;transition:all 0.15s;`;
            if (isLive) {
                btn.title = '⚠ Esta playlist está al aire';
            }
            btn.addEventListener('mouseenter', () => { btn.style.background = isLive ? '#3a1520' : '#00a8ff'; btn.style.color = '#fff'; btn.style.borderColor = isLive ? '#ff6b6b' : '#00a8ff'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = isLive ? '#2c1018' : '#222'; btn.style.color = isLive ? '#ff6b6b' : '#ccc'; btn.style.borderColor = isLive ? '#e74c3c' : '#444'; });
            btn.addEventListener('click', () => {
                const clearCheckEl = document.getElementById('rotation-clear-list');
                const isClear = clearCheckEl ? clearCheckEl.checked : false;
                clockwheelPrefs.clearList = isClear;
                saveConfig(clockwheelPrefsPath, clockwheelPrefs);
                overlay.remove();
                resolve({ tab: i, clearList: isClear });
            });
            btnContainer.appendChild(btn);
        }

        box.appendChild(btnContainer);

        // Indicador de al aire
        const liveIdx = currentPlayingRow ? tbodys.indexOf(currentPlayingRow.closest('tbody')) : -1;
        if (liveIdx >= 0) {
            const liveHint = document.createElement('p');
            liveHint.style.cssText = 'margin:0 0 12px;color:#e74c3c;font-size:11px;';
            liveHint.textContent = `🔴 Playlist ${liveIdx + 1} está al aire`;
            box.appendChild(liveHint);
        }

        const optionContainer = document.createElement('div');
        optionContainer.style.cssText = 'margin-bottom:15px; text-align:center;';
        const clearCheck = document.createElement('input');
        clearCheck.type = 'checkbox';
        clearCheck.id = 'rotation-clear-list';
        clearCheck.checked = clockwheelPrefs.clearList === true;
        const clearLabel = document.createElement('label');
        clearLabel.style.cssText = 'color:#ccc; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px;';
        clearLabel.appendChild(clearCheck);
        clearLabel.appendChild(document.createTextNode('Limpiar lista destino al generar'));
        optionContainer.appendChild(clearLabel);
        box.appendChild(optionContainer);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.style.cssText = 'padding:7px 20px;border-radius:5px;border:1px solid #555;background:#333;color:#aaa;cursor:pointer;font-size:12px;';
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
        cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = '#444'; cancelBtn.style.color = '#fff'; });
        cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = '#333'; cancelBtn.style.color = '#aaa'; });
        box.appendChild(cancelBtn);

        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
        document.body.appendChild(overlay);
    });
}

function initRotationModal() {
    const modal = document.getElementById('rotation-modal');
    if (!modal) return;
    document.getElementById('btn-close-rotation')?.addEventListener('click', closeRotationModal);
    document.getElementById('btn-cancel-rotation')?.addEventListener('click', closeRotationModal);
    document.getElementById('btn-apply-rotation')?.addEventListener('click', applyRotationPlanToPlaylist);
    document.getElementById('btn-build-rotation')?.addEventListener('click', applyRotationPlanToPlaylist);
    document.getElementById('rotation-pattern')?.addEventListener('input', () => updateRotationQuickSummary());
    document.getElementById('rotation-target-min')?.addEventListener('input', () => updateRotationQuickSummary());
    document.getElementById('rotation-sep-artist')?.addEventListener('input', () => updateRotationQuickSummary());
    document.getElementById('rotation-sep-title')?.addEventListener('input', () => updateRotationQuickSummary());
    document.getElementById('rotation-sep-artist-check')?.addEventListener('change', () => updateRotationQuickSummary());
    document.getElementById('rotation-sep-title-check')?.addEventListener('change', () => updateRotationQuickSummary());
}

function updateNextTrackVisuals() {
    let visualNextRow = resolvePriorityNextRow(queuedNextRow);
    const allRows = document.querySelectorAll('#playlist-table tr');
    allRows.forEach(row => row.classList.remove('row-next'));

    if (stopAfterCurrent && currentPlayingRow) {
        // "Pausar Fin" activo: quitar línea naranja y mostrar mensaje de pausa.
        if (txtSiguiente) { txtSiguiente.innerText = '⏸ Pausado al finalizar'; txtSiguiente.style.color = '#e74c3c'; }
    } else if (generalPrefs.nextPausada) {
        if (txtSiguiente) { txtSiguiente.innerText = `${ICON_TEMP_PREFIX}Siguiente pausada temporalmente`; txtSiguiente.style.color = "#e74c3c"; }
    } else {
        if (txtSiguiente) txtSiguiente.style.color = "";
        if (visualNextRow) {
            visualNextRow.classList.add('row-next');
            let pureName = visualNextRow.dataset.pureName || visualNextRow.children[1].innerText;

            const nextTabIdx = tbodys.indexOf(visualNextRow.closest('tbody'));
            let prefix = "";
            if (nextTabIdx !== pgmTab && currentPlayingRow) {
                prefix = `[Playlist ${nextTabIdx + 1}] `;
            }

            if (txtSiguiente) txtSiguiente.innerText = prefix + pureName;
            if (!isPlaylistCommandRow(visualNextRow)) {
                warmUpcomingRows(visualNextRow);
                preloadNextTrack();
            }
        } else { if (txtSiguiente) txtSiguiente.innerText = "(Vacio)"; }
    }
    const isAnchorVisible = isPlaylistRowInAutoFollowZone(currentPlayingRow || visualNextRow);
    if (isAnchorVisible && (currentPlayingRow || visualNextRow)) {
        ensurePlaybackRowsVisible({ forcePgmView: false, centerCurrent: false });
    }
}

function formatDurationTotal(seconds) { const h = Math.floor(seconds / 3600).toString().padStart(2, '0'); const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0'); const s = Math.floor(seconds % 60).toString().padStart(2, '0'); return `${h}:${m}:${s}`; }

function recalcEndTime() {
    if (!trackStartTime || !currentPlayingRow || currentDuration <= 0) return;
    let elapsed;
    if (isPlaylistTimeActive) {
        // Durante la locución horaria el clock corre por Date.now() (Rust
        // gestiona el audio, no hay <audio> que medir).
        elapsed = (Date.now() - trackStartTime.getTime()) / 1000;
    } else {
        elapsed = getPlayerClockTime(activePlayer) - currentStartTimeOffset;
    }
    if (elapsed < 0) elapsed = 0;
    const remaining = Math.max(0, currentDuration - elapsed);
    trackStartTime = new Date(Date.now() - elapsed * 1000);
    const endTime = new Date(Date.now() + remaining * 1000);
    document.getElementById('txt-acaba').innerText = endTime.toLocaleTimeString('es-PE', { hour12: false });
    calcularHorasPlaylist();
}

function calcularHorasPlaylist() {
    _calcTbodyHours(currentViewTab, true);
    if (pgmTab !== currentViewTab) {
        _calcTbodyHours(pgmTab, false);
    }
}

function _calcTbodyHours(tbodyIndex, updateUI = false) {
    const targetBody = tbodys[tbodyIndex];
    if (!targetBody) return;
    const rows = Array.from(targetBody.children);
    if (rows.length === 0) {
        if (updateUI) document.getElementById('txt-duracion-total').innerText = "00:00:00";
        return;
    }
    let timeObj = new Date();
    let startIndex = 0;

    if (currentPlayingRow && targetBody.contains(currentPlayingRow)) {
        startIndex = rows.indexOf(currentPlayingRow);
        if (startIndex === -1) startIndex = 0;
        if (trackStartTime) {
            // getPlayerClockTime devuelve el tiempo ABSOLUTO dentro del archivo
            // (incluyendo currentStartTimeOffset). Para obtener el "elapsed"
            // dentro de la ventana efectiva de la pista hay que restarlo, igual
            // que hace recalcEndTime(). Sin esta resta, al hacer seek dentro de
            // una pista con startOffset > 0 las horas siguientes quedaban
            // descalibradas en X segundos.
            let elapsed = (getPlayerClockTime(activePlayer) || 0) - currentStartTimeOffset;
            if (elapsed < 0) elapsed = 0;
            let remaining = currentDuration - elapsed;
            if (remaining < 0) remaining = 0;
            timeObj = new Date(Date.now() + (remaining * 1000));
        }
    }

    let totalRemainingSeconds = 0;
    for (let i = startIndex; i < rows.length; i++) {
        if (rows[i].dataset.type === 'note') { rows[i].children[0].innerText = '--:--:--'; continue; }
        let h = timeObj.getHours().toString().padStart(2, '0');
        let m = timeObj.getMinutes().toString().padStart(2, '0');
        let s = timeObj.getSeconds().toString().padStart(2, '0');
        rows[i].children[0].innerText = `${h}:${m}:${s}`;
        let dur = parseInt(rows[i].dataset.duracion) || 0;
        timeObj.setSeconds(timeObj.getSeconds() + dur);
        totalRemainingSeconds += dur;
    }
    if (updateUI) document.getElementById('txt-duracion-total').innerText = formatDurationTotal(totalRemainingSeconds);
}

// ============================================================================
// MOTOR DE AUDIO (BUSES Y CONSOLA)
// ============================================================================
const playerA = document.getElementById('player-a'); const playerB = document.getElementById('player-b'); const jingleElement = document.getElementById('jingle-player');
const MainAudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
try {
    audioCtx = new MainAudioContext({ latencyHint: 'interactive' });
} catch (err) {
    audioCtx = new MainAudioContext();
}
const meterSilentSink = audioCtx.createGain();
meterSilentSink.gain.value = 0;
meterSilentSink.connect(audioCtx.destination);

// FASE D · sub-paso 12.1: si arrancamos en modo rustAudio, suspendemos el
// AudioContext del navegador inmediatamente. El motor Rust hace todo el
// procesamiento real (DSP, mezcla, taps a monitor/encoder); el grafo
// WebAudio del renderer queda inerte. Esto libera CPU y deja claro que
// "WebAudio pasa a la historia". Si más adelante el usuario fuerza el
// fallback `webAudio`, los helpers `resumeCurrentPlayback`/`playSelectedRow`
// lo despiertan bajo demanda.
try {
    if (typeof generalPrefs !== 'undefined'
        && generalPrefs?.audioEngineMode === 'rustAudio'
        && audioCtx.state === 'running') {
        audioCtx.suspend().catch(() => { });
    }
} catch (err) { }

function createOutputTap(label, fftSize = 1024) {
    const input = audioCtx.createGain();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    const streamNode = audioCtx.createMediaStreamDestination();
    input.connect(analyser);
    input.connect(streamNode);

    const audioEl = new Audio();
    audioEl.srcObject = streamNode.stream;
    audioEl.autoplay = false;
    audioEl.preload = 'auto';
    audioEl.playsInline = true;
    audioEl.disableRemotePlayback = true;

    return { label, input, analyser, streamNode, audioEl, isActive: false };
}

function createStereoAnalyserPair(fftSize = 1024) {
    const splitter = audioCtx.createChannelSplitter(2);
    const left = audioCtx.createAnalyser();
    const right = audioCtx.createAnalyser();
    left.fftSize = fftSize;
    right.fftSize = fftSize;
    left.connect(meterSilentSink);
    right.connect(meterSilentSink);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    return { splitter, left, right };
}

async function resumeTapPlayback(tap) {
    if (!tap || !tap.audioEl) return;
    if (tap.isActive) return;
    try {
        await tap.audioEl.play();
        tap.isActive = true;
    } catch (err) {
        tap.isActive = false;
    }
}

function suspendTapPlayback(tap) {
    if (!tap || !tap.audioEl) return;
    tap.isActive = false;
    try { tap.audioEl.pause(); } catch (err) { }
}

function resolveOutputDevice(deviceId, devices) {
    if (!Array.isArray(devices) || devices.length === 0) return null;
    if (!deviceId || deviceId === 'default') {
        return devices.find(device => device.deviceId === 'default')
            || devices.find(device => device.kind === 'audiooutput')
            || null;
    }
    return devices.find(device => device.deviceId === deviceId) || null;
}

function outputsSharePhysicalDevice(deviceA, deviceB, devices) {
    if (!deviceA || !deviceB) return deviceA === deviceB;
    const resolvedA = resolveOutputDevice(deviceA, devices);
    const resolvedB = resolveOutputDevice(deviceB, devices);
    if (!resolvedA || !resolvedB) return deviceA === deviceB;
    if (resolvedA.groupId && resolvedB.groupId) return resolvedA.groupId === resolvedB.groupId;
    if (resolvedA.deviceId === resolvedB.deviceId) return true;
    if (resolvedA.label && resolvedB.label) return resolvedA.label === resolvedB.label;
    return deviceA === deviceB;
}

function setImmediateGain(gainNode, value) {
    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.setValueAtTime(value, audioCtx.currentTime);
}

const playlistBuses = Array.from({ length: 4 }, () => audioCtx.createGain());
const playlistStereoMeters = playlistBuses.map(() => createStereoAnalyserPair(1024));

const pgmBus = audioCtx.createGain();
const cueBus = audioCtx.createGain();
const monitorBus = audioCtx.createGain();
const monitorOutputGain = audioCtx.createGain();
const jingleBus = audioCtx.createGain();
const cartwallBus = audioCtx.createGain();
const monitorMirrorSend = audioCtx.createGain();
const cartwallMasterSend = audioCtx.createGain();
const cartwallMonitorSend = audioCtx.createGain();
const cartwallCueSend = audioCtx.createGain();

const pgmStereoMeter = createStereoAnalyserPair(1024);
const cueStereoMeter = createStereoAnalyserPair(1024);
const monitorStereoMeter = createStereoAnalyserPair(1024);
const jingleStereoMeter = createStereoAnalyserPair(1024);
const cartwallStereoMeter = createStereoAnalyserPair(1024);
const monitorTap = createOutputTap('monitor');
const cueTap = createOutputTap('cue');
const cartwallDeviceTap = createOutputTap('cartwall-device');
const playlistTaps = Array.from({ length: 4 }, (_, idx) => createOutputTap(`playlist-${idx + 1}`));

const sourceA = audioCtx.createMediaElementSource(playerA);
const sourceB = audioCtx.createMediaElementSource(playerB);
const sourceJingle = audioCtx.createMediaElementSource(jingleElement);

const gainA = audioCtx.createGain(); const gainB = audioCtx.createGain(); const rustPlaylistOwnerMuteA = audioCtx.createGain(); const rustPlaylistOwnerMuteB = audioCtx.createGain(); const duckingNode = audioCtx.createGain(); const masterNode = audioCtx.createGain();
const routeA = audioCtx.createGain(); const routeB = audioCtx.createGain();
const splitter = audioCtx.createChannelSplitter(2); const analyserL = audioCtx.createAnalyser(); const analyserR = audioCtx.createAnalyser();
analyserL.fftSize = 2048; analyserR.fftSize = 2048;

sourceA.connect(gainA); gainA.connect(rustPlaylistOwnerMuteA); rustPlaylistOwnerMuteA.connect(routeA);
sourceB.connect(gainB); gainB.connect(rustPlaylistOwnerMuteB); rustPlaylistOwnerMuteB.connect(routeB);
duckingNode.connect(pgmBus);
sourceJingle.connect(jingleBus);

playlistBuses.forEach((bus, idx) => {
    bus.connect(duckingNode);
    bus.connect(playlistStereoMeters[idx].splitter);
    bus.connect(playlistTaps[idx].input);
});

routeA.connect(playlistBuses[0]);
routeB.connect(playlistBuses[0]);

jingleBus.connect(jingleStereoMeter.splitter);
jingleBus.connect(pgmBus);

cartwallBus.connect(cartwallStereoMeter.splitter);
cartwallBus.connect(cartwallMasterSend); cartwallMasterSend.connect(pgmBus);
cartwallBus.connect(cartwallMonitorSend); cartwallMonitorSend.connect(monitorBus);
cartwallBus.connect(cartwallCueSend); cartwallCueSend.connect(cueBus);
cartwallBus.connect(cartwallDeviceTap.input);

const fxPreNode = audioCtx.createGain(); const postFxNode = audioCtx.createGain();
const eqInput = audioCtx.createGain(); const eqOutput = audioCtx.createGain(); const eqDry = audioCtx.createGain(); const eqWet = audioCtx.createGain();
const preAmpNode = audioCtx.createGain(); const panNode = audioCtx.createStereoPanner(); const monoNode = audioCtx.createGain();
const eqFrequencies = [63, 125, 250, 500, 1000, 2000, 4000, 8000]; let fxEqNodes = [];

eqInput.connect(eqWet); eqWet.connect(preAmpNode); let prevNode = preAmpNode;
eqFrequencies.forEach(freq => { let filter = audioCtx.createBiquadFilter(); filter.type = 'peaking'; filter.frequency.value = freq; filter.Q.value = 1.4; filter.gain.value = 0; prevNode.connect(filter); prevNode = filter; fxEqNodes.push(filter); });
prevNode.connect(panNode); panNode.connect(monoNode); monoNode.connect(eqOutput);
eqInput.connect(eqDry); eqDry.connect(eqOutput);

const compInput = audioCtx.createGain(); const compOutput = audioCtx.createGain(); const compDry = audioCtx.createGain(); const compWet = audioCtx.createGain();
const fxCompressor = audioCtx.createDynamicsCompressor(); fxCompressor.threshold.value = -24; fxCompressor.knee.value = 15; fxCompressor.ratio.value = 3.5; fxCompressor.attack.value = 0.005; fxCompressor.release.value = 0.25;
compInput.connect(compWet); compWet.connect(fxCompressor); fxCompressor.connect(compOutput); compInput.connect(compDry); compDry.connect(compOutput);

const limInput = audioCtx.createGain(); const limOutput = audioCtx.createGain(); const limDry = audioCtx.createGain(); const limWet = audioCtx.createGain();
const fxLimiter = audioCtx.createDynamicsCompressor(); fxLimiter.threshold.value = -0.5; fxLimiter.knee.value = 0.0; fxLimiter.ratio.value = 20.0; fxLimiter.attack.value = 0.001; fxLimiter.release.value = 0.05;
limInput.connect(limWet); limWet.connect(fxLimiter); fxLimiter.connect(limOutput); limInput.connect(limDry); limDry.connect(limOutput);

pgmBus.connect(fxPreNode);
postFxNode.connect(masterNode);

masterNode.connect(audioCtx.destination);
masterNode.connect(splitter); splitter.connect(analyserL, 0); splitter.connect(analyserR, 1);
masterNode.connect(pgmStereoMeter.splitter);
monitorMirrorSend.connect(monitorBus);
monitorBus.connect(monitorOutputGain);
monitorOutputGain.connect(monitorTap.input);
monitorOutputGain.connect(monitorStereoMeter.splitter);
cueBus.connect(cueTap.input);
cueBus.connect(cueStereoMeter.splitter);

setImmediateGain(monitorMirrorSend, generalPrefs.monitorEnabled ? 1 : 0);
setImmediateGain(monitorOutputGain, (generalPrefs.monitorVolume ?? 100) / 100);
setImmediateGain(rustPlaylistOwnerMuteA, 1);
setImmediateGain(rustPlaylistOwnerMuteB, 1);
setImmediateGain(cartwallMasterSend, 1);
setImmediateGain(cartwallMonitorSend, 0);
setImmediateGain(cartwallCueSend, 0);
setImmediateGain(cartwallDeviceTap.input, 0);
playlistTaps.forEach(tap => setImmediateGain(tap.input, 0));

let webAudioPlaylistDecksDetachedForRust = false;

function detachWebAudioPlaylistDeck(player) {
    if (!player) return;
    try { player.pause(); } catch (err) { }
    try {
        if (player.src) {
            player.removeAttribute('src');
            player.load();
        }
    } catch (err) { }
}

function detachWebAudioPlaylistDecksForRust() {
    // Guardia de idempotencia: sólo ejecutar la primera vez.
    // Sin esto, publishRustTransport llama a esta función en cada ciclo
    // y borra el src del player HTML mientras la locución de hora lo está cargando.
    if (webAudioPlaylistDecksDetachedForRust) return;
    detachWebAudioPlaylistDeck(playerA);
    detachWebAudioPlaylistDeck(playerB);
    webAudioPlaylistDecksDetachedForRust = true;
}

function connectMonitorMirrorSource() {
    try { masterNode.disconnect(monitorMirrorSend); } catch (err) { }
    try { fxPreNode.disconnect(monitorMirrorSend); } catch (err) { }
    try { postFxNode.disconnect(monitorMirrorSend); } catch (err) { }
    const source = generalPrefs.monitorSourceMode === 'preFx' ? fxPreNode : postFxNode;
    source.connect(monitorMirrorSend);
}

connectMonitorMirrorSource();

function applyRustPlaylistOwnerMute() {
    const muted = isRustPlaylistOwnerEnabled();
    setImmediateGain(rustPlaylistOwnerMuteA, muted ? 0 : 1);
    setImmediateGain(rustPlaylistOwnerMuteB, muted ? 0 : 1);
    if (muted) {
        detachWebAudioPlaylistDecksForRust();
    } else {
        webAudioPlaylistDecksDetachedForRust = false;
    }
}

function getPlaylistIndexFromRow(row) {
    if (!row) return 0;
    const tbody = row.closest('tbody');
    const idx = tbodys.indexOf(tbody);
    return idx >= 0 ? idx : 0;
}

function getPlayerRouteNode(player) {
    return player === playerA ? routeA : routeB;
}

function assignPlayerToPlaylistBus(player, playlistIndex) {
    const routeNode = getPlayerRouteNode(player);
    routeNode.disconnect();
    routeNode.connect(playlistBuses[Math.max(0, Math.min(playlistBuses.length - 1, playlistIndex || 0))]);
}

function rebuildAudioRouting() {
    if (isRustExclusiveAudioMode()) {
        syncRustFxContract();
        return;
    }
    fxPreNode.disconnect(); eqOutput.disconnect(); compOutput.disconnect(); limOutput.disconnect();
    let activeBlocks = []; const modules = Array.from(document.querySelectorAll('#fx-chain .fx-module')).reverse();
    modules.forEach(mod => { const id = mod.dataset.id; if (id === 'eq') activeBlocks.push({ in: eqInput, out: eqOutput }); if (id === 'comp') activeBlocks.push({ in: compInput, out: compOutput }); if (id === 'limiter') activeBlocks.push({ in: limInput, out: limOutput }); });
    let currentNode = fxPreNode;
    activeBlocks.forEach(block => { currentNode.connect(block.in); currentNode = block.out; });
    currentNode.connect(postFxNode);
    syncRustFxContract();
}

function toggleFxNode(dryGain, wetGain, isActive) {
    if (isRustExclusiveAudioMode()) return;
    const t = audioCtx.currentTime; const transitionTime = 0.05;
    dryGain.gain.cancelScheduledValues(t); wetGain.gain.cancelScheduledValues(t);
    dryGain.gain.setValueAtTime(dryGain.gain.value, t); wetGain.gain.setValueAtTime(wetGain.gain.value, t);
    if (isActive) { dryGain.gain.linearRampToValueAtTime(0, t + transitionTime); wetGain.gain.linearRampToValueAtTime(1, t + transitionTime); }
    else { dryGain.gain.linearRampToValueAtTime(1, t + transitionTime); wetGain.gain.linearRampToValueAtTime(0, t + transitionTime); }
}

const defaultEqPresets = { "Plano (Reset)": [0, 0, 0, 0, 0, 0, 0, 0], "Voz / Locucion": [-2, -1, 0, 1, 3, 4, 2, 0], "Bass Boost": [5, 4, 2, 0, 0, 0, 0, 0], "Brillo / Aire": [0, 0, 0, 0, 1, 2, 4, 5], "Rock (En V)": [5, 4, 1, -2, -1, 2, 4, 5] };
function refreshEqPresets(activeName = null) {
    const select = document.getElementById('eq-preset-select'); if (!select) return;
    select.innerHTML = '<option value="custom_unsaved">-- Personalizado --</option>';
    const optGroupDef = document.createElement('optgroup'); optGroupDef.label = "Fabrica"; Object.keys(defaultEqPresets).forEach(name => { const opt = document.createElement('option'); opt.value = `def_${name}`; opt.innerText = name; optGroupDef.appendChild(opt); }); select.appendChild(optGroupDef);
    const optGroupCus = document.createElement('optgroup'); optGroupCus.label = "Mis Preajustes"; Object.keys(fxPrefs.custom_presets).forEach(name => { const opt = document.createElement('option'); opt.value = `cus_${name}`; opt.innerText = name; optGroupCus.appendChild(opt); }); select.appendChild(optGroupCus);
    if (activeName) select.value = activeName; else select.value = fxPrefs.active_preset; updateDeleteButtonVisibility();
}

function updateDeleteButtonVisibility() { const select = document.getElementById('eq-preset-select'); const btnDel = document.getElementById('btn-eq-delete-preset'); if (select.value.startsWith('cus_')) { btnDel.style.display = 'inline-block'; } else { btnDel.style.display = 'none'; } }

function setFxParamValue(param, value) {
    if (isRustExclusiveAudioMode()) return;
    param.value = value;
}

let savedEqSnapshot = []; let savedPreAmpSnapshot = 0; let savedPanSnapshot = 0; let savedMonoSnapshot = false;
const eqModal = document.getElementById('eq-modal'); const preAmpSlider = document.getElementById('eq-preamp-slider'); const preAmpVal = document.getElementById('preamp-val'); const panSlider = document.getElementById('eq-pan-slider'); const panVal = document.getElementById('pan-val'); const monoToggle = document.getElementById('eq-mono-toggle'); const monoLbl = document.getElementById('mono-val'); const formSavePreset = document.getElementById('save-preset-form');

document.getElementById('btn-open-eq').addEventListener('click', () => {
    savedEqSnapshot = Array.from(document.querySelectorAll('.eq-slider')).map(s => parseFloat(s.value));
    savedPreAmpSnapshot = parseFloat(preAmpSlider.value);
    savedPanSnapshot = parseFloat(panSlider.value);
    savedMonoSnapshot = monoToggle.checked;
    formSavePreset.style.display = 'none';
    eqModal.style.display = 'flex';
});

// FIX BUG: btn-eq-cancel ahora también restaura `fxPrefs` y manda sync a Rust.
// Antes solo tocaba la UI y los nodos WebAudio (inertes en modo Rust), así que
// el motor seguía con los valores nuevos a pesar del "cancelar".
document.getElementById('btn-eq-cancel').addEventListener('click', () => {
    document.querySelectorAll('.eq-slider').forEach((slider, idx) => {
        slider.value = savedEqSnapshot[idx];
        setFxParamValue(fxEqNodes[idx].gain, savedEqSnapshot[idx]);
    });
    preAmpSlider.value = savedPreAmpSnapshot;
    setFxParamValue(preAmpNode.gain, Math.pow(10, savedPreAmpSnapshot / 20));
    preAmpVal.innerText = `${savedPreAmpSnapshot > 0 ? '+' : ''}${savedPreAmpSnapshot} dB`;
    panSlider.value = savedPanSnapshot;
    setFxParamValue(panNode.pan, savedPanSnapshot);
    updatePanLabel(savedPanSnapshot);
    monoToggle.checked = savedMonoSnapshot;
    applyMonoState(savedMonoSnapshot);
    // FIX: actualizar fxPrefs al snapshot para que syncRustFxContract envíe
    // los valores correctos al motor (no los valores en vivo que el usuario
    // estaba probando).
    fxPrefs.eq_bands = savedEqSnapshot.slice();
    fxPrefs.preamp = savedPreAmpSnapshot;
    fxPrefs.pan = savedPanSnapshot;
    fxPrefs.mono = savedMonoSnapshot;
    syncRustFxContract({ force: true });
    eqModal.style.display = 'none';
});

// FIX BUG: btn-eq-reset ahora también actualiza fxPrefs y sincroniza Rust.
document.getElementById('btn-eq-reset').addEventListener('click', () => {
    document.getElementById('eq-preset-select').value = 'def_Plano (Reset)';
    document.getElementById('eq-preset-select').dispatchEvent(new Event('change'));
    preAmpSlider.value = 0;
    setFxParamValue(preAmpNode.gain, 1);
    preAmpVal.innerText = `0 dB`;
    panSlider.value = 0;
    setFxParamValue(panNode.pan, 0);
    updatePanLabel(0);
    monoToggle.checked = false;
    applyMonoState(false);
    // FIX: estado a defaults también en fxPrefs y propagar a Rust.
    fxPrefs.eq_bands = new Array(8).fill(0);
    fxPrefs.preamp = 0;
    fxPrefs.pan = 0;
    fxPrefs.mono = false;
    syncRustFxContract({ force: true });
});

document.getElementById('btn-eq-save').addEventListener('click', () => {
    fxPrefs.eq_bands = Array.from(document.querySelectorAll('.eq-slider')).map(s => parseFloat(s.value));
    fxPrefs.preamp = parseFloat(preAmpSlider.value);
    fxPrefs.pan = parseFloat(panSlider.value);
    fxPrefs.mono = monoToggle.checked;
    saveConfig(fxPrefsPath, fxPrefs);
    syncRustFxContract({ force: true });
    eqModal.style.display = 'none';
});

function updatePanLabel(val) { if (val === 0) panVal.innerText = 'C (Centro)'; else if (val < 0) panVal.innerText = `L ${Math.abs(Math.round(val * 100))}%`; else panVal.innerText = `R ${Math.round(val * 100)}%`; }
function applyMonoState(isMono) {
    if (!isRustExclusiveAudioMode()) {
        if (isMono) {
            monoNode.channelCount = 1;
            monoNode.channelCountMode = 'explicit';
        } else {
            monoNode.channelCount = 2;
            monoNode.channelCountMode = 'max';
        }
    }
    monoLbl.innerText = isMono ? 'MONO' : 'ESTEREO';
    monoLbl.style.color = isMono ? '#f39c12' : '#2ecc71';
}

let selectedFxModule = null;
function clearFxSelection() { if (selectedFxModule) { selectedFxModule.classList.remove('fx-selected'); selectedFxModule = null; } }

function selectFxModule(mod) {
    if (!mod) return;
    clearFxSelection();
    selectedFxModule = mod;
    mod.classList.add('fx-selected');
}

function moveFxModule(mod, direction) {
    if (!mod) return;
    const sibling = direction === 'up' ? mod.previousElementSibling : mod.nextElementSibling;
    if (!sibling) return;
    if (direction === 'up') mod.parentNode.insertBefore(mod, sibling);
    else mod.parentNode.insertBefore(sibling, mod);
    selectFxModule(mod);
    saveFxOrder();
    rebuildAudioRouting();
    // FASE D · sub-paso 11.4: propagar el nuevo orden visual al motor Rust.
    // Sin esta llamada, los botones 🔼 🔽 sólo movían el DOM y persistían a disco
    // pero el motor nativo seguía con la cascada PreAmp→Pan→Mono→EQ→Comp→Limiter
    // fija. Ahora cada movimiento dispara un `fx` IPC con el array `order`.
    syncRustFxContractDebounced();
}

// FIX BUG (regla de negocio): AGC y Limiter son ambos compresores y NO
// pueden estar prendidos a la vez. Cuando el operador activa uno, el otro
// se apaga automáticamente. La función original solo actuaba si AMBOS
// estaban activos; ahora siempre apaga el contrario si está marcado.
function enforceExclusiveDynamics(preferred) {
    const chkComp = document.getElementById('fx-comp-enable');
    const chkLim = document.getElementById('fx-limiter-enable');
    if (!chkComp || !chkLim) return;
    if (preferred === 'limiter' && chkComp.checked) {
        chkComp.checked = false;
        fxPrefs.comp_on = false;
        toggleFxNode(compDry, compWet, false);
        saveConfig(fxPrefsPath, fxPrefs);
    } else if (preferred === 'comp' && chkLim.checked) {
        chkLim.checked = false;
        fxPrefs.lim_on = false;
        toggleFxNode(limDry, limWet, false);
        saveConfig(fxPrefsPath, fxPrefs);
    }
}

function getFxDropTarget(container, y) {
    return Array.from(container.querySelectorAll('.fx-module:not(.fx-dragging)')).find(child => {
        const box = child.getBoundingClientRect();
        return y < box.top + box.height / 2;
    }) || null;
}

function initFXUI() {
    preAmpSlider.value = fxPrefs.preamp; preAmpVal.innerText = `${fxPrefs.preamp > 0 ? '+' : ''}${fxPrefs.preamp} dB`; setFxParamValue(preAmpNode.gain, Math.pow(10, fxPrefs.preamp / 20));
    preAmpSlider.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        preAmpVal.innerText = `${val > 0 ? '+' : ''}${val} dB`;
        setFxParamValue(preAmpNode.gain, Math.pow(10, val / 20));
        fxPrefs.preamp = val;
        syncRustFxContractDebounced();
    });
    preAmpSlider.addEventListener('dblclick', (e) => {
        e.target.value = 0;
        preAmpVal.innerText = `0 dB`;
        setFxParamValue(preAmpNode.gain, 1);
        fxPrefs.preamp = 0;
        syncRustFxContractDebounced();
    });

    panSlider.value = fxPrefs.pan; updatePanLabel(fxPrefs.pan); setFxParamValue(panNode.pan, fxPrefs.pan);
    panSlider.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (val > -0.15 && val < 0.15) { val = 0; e.target.value = 0; }
        setFxParamValue(panNode.pan, val);
        updatePanLabel(val);
        fxPrefs.pan = val;
        syncRustFxContractDebounced();
    });
    panSlider.addEventListener('dblclick', (e) => {
        e.target.value = 0;
        setFxParamValue(panNode.pan, 0);
        updatePanLabel(0);
        fxPrefs.pan = 0;
        syncRustFxContractDebounced();
    });

    monoToggle.checked = fxPrefs.mono; applyMonoState(fxPrefs.mono);
    monoToggle.addEventListener('change', (e) => {
        applyMonoState(e.target.checked);
        // FIX BUG: tiempo real al motor Rust. Antes solo aplicaba el estado a
        // WebAudio (inerte en modo Rust). Ahora el operador escucha el mono
        // al instante de tocar el toggle, igual que pan y preamp.
        fxPrefs.mono = e.target.checked;
        syncRustFxContractDebounced();
    });

    const eqContainer = document.getElementById('eq-bands-container');
    if (eqContainer) {
        eqContainer.innerHTML = ''; const eqLabels = ['63', '125', '250', '500', '1K', '2K', '4K', '8K']; let savedEq = fxPrefs.eq_bands; if (!savedEq || savedEq.length !== 8) savedEq = new Array(8).fill(0);
        eqLabels.forEach((lbl, index) => {
            const val = savedEq[index] || 0; setFxParamValue(fxEqNodes[index].gain, val);
            const bandDiv = document.createElement('div'); bandDiv.className = 'eq-band';
            bandDiv.innerHTML = `<input type="range" class="eq-slider" title="Doble clic para reiniciar a 0" min="-12" max="12" step="0.5" value="${val}" data-index="${index}" orient="vertical"><span class="eq-label">${lbl}</span>`;
            eqContainer.appendChild(bandDiv);
        });
        document.querySelectorAll('.eq-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.index);
                const val = parseFloat(e.target.value);
                setFxParamValue(fxEqNodes[idx].gain, val);
                // Actualizar fxPrefs en tiempo real para que buildRustFxSyncPlan lea el valor correcto.
                if (!Array.isArray(fxPrefs.eq_bands)) fxPrefs.eq_bands = new Array(8).fill(0);
                fxPrefs.eq_bands[idx] = val;
                const sel = document.getElementById('eq-preset-select');
                if (sel.value !== 'custom_unsaved') { sel.value = 'custom_unsaved'; fxPrefs.active_preset = 'custom_unsaved'; updateDeleteButtonVisibility(); }
                // Enviar a Rust en tiempo real (debounced 50ms para no saturar IPC durante arrastre).
                syncRustFxContractDebounced();
            });
            slider.addEventListener('dblclick', (e) => {
                e.target.value = 0;
                const idx = parseInt(e.target.dataset.index);
                setFxParamValue(fxEqNodes[idx].gain, 0);
                if (!Array.isArray(fxPrefs.eq_bands)) fxPrefs.eq_bands = new Array(8).fill(0);
                fxPrefs.eq_bands[idx] = 0;
                const sel = document.getElementById('eq-preset-select');
                if (sel.value !== 'custom_unsaved') { sel.value = 'custom_unsaved'; fxPrefs.active_preset = 'custom_unsaved'; updateDeleteButtonVisibility(); }
                syncRustFxContractDebounced();
            });
        });
        refreshEqPresets();
    }

    document.getElementById('eq-preset-select').addEventListener('change', (e) => {
        const val = e.target.value; updateDeleteButtonVisibility(); fxPrefs.active_preset = val; if (val === 'custom_unsaved') return;
        let presetArr = []; if (val.startsWith('def_')) { presetArr = defaultEqPresets[val.replace('def_', '')]; } else if (val.startsWith('cus_')) { presetArr = fxPrefs.custom_presets[val.replace('cus_', '')]; }
        if (presetArr && presetArr.length === 8) {
            document.querySelectorAll('.eq-slider').forEach((slider, idx) => { slider.value = presetArr[idx]; setFxParamValue(fxEqNodes[idx].gain, presetArr[idx]); });
            // FIX BUG: aplicar el preset también a fxPrefs.eq_bands y propagar
            // a Rust en tiempo real. Antes el preset cambiaba la UI y los nodos
            // WebAudio inertes pero el motor seguía con las bandas previas.
            fxPrefs.eq_bands = presetArr.slice();
            syncRustFxContractDebounced();
        }
    });

    document.getElementById('btn-eq-save-preset').addEventListener('click', () => { formSavePreset.style.display = 'block'; document.getElementById('preset-name-input').focus(); });
    document.getElementById('btn-cancel-save-preset').addEventListener('click', () => { formSavePreset.style.display = 'none'; document.getElementById('preset-name-input').value = ''; });
    document.getElementById('btn-confirm-save-preset').addEventListener('click', () => {
        const name = document.getElementById('preset-name-input').value; if (!name || name.trim() === "") return;
        const currentEq = Array.from(document.querySelectorAll('.eq-slider')).map(s => parseFloat(s.value)); fxPrefs.custom_presets[name.trim()] = currentEq; saveConfig(fxPrefsPath, fxPrefs);
        refreshEqPresets(`cus_${name.trim()}`); fxPrefs.active_preset = `cus_${name.trim()}`; formSavePreset.style.display = 'none'; document.getElementById('preset-name-input').value = '';
    });

    document.getElementById('btn-eq-delete-preset').addEventListener('click', async () => {
        const select = document.getElementById('eq-preset-select'); const val = select.value; if (!val.startsWith('cus_')) return;
        const confirmDelete = await ipcRenderer.invoke('dialog:confirm', 'Seguro que deseas eliminar este preajuste?');
        if (confirmDelete) { const name = val.replace('cus_', ''); delete fxPrefs.custom_presets[name]; saveConfig(fxPrefsPath, fxPrefs); refreshEqPresets('def_Plano (Reset)'); document.getElementById('eq-preset-select').dispatchEvent(new Event('change')); }
    });

    if (fxPrefs.comp_on && fxPrefs.lim_on) {
        fxPrefs.lim_on = false;
        saveConfig(fxPrefsPath, fxPrefs);
    }
    const chkEq = document.getElementById('fx-eq-enable'); const chkComp = document.getElementById('fx-comp-enable'); const chkLim = document.getElementById('fx-limiter-enable');
    chkEq.checked = fxPrefs.eq_on; chkComp.checked = fxPrefs.comp_on; chkLim.checked = fxPrefs.lim_on;
    if (!isRustExclusiveAudioMode()) {
        eqDry.gain.value = fxPrefs.eq_on ? 0 : 1; eqWet.gain.value = fxPrefs.eq_on ? 1 : 0; compDry.gain.value = fxPrefs.comp_on ? 0 : 1; compWet.gain.value = fxPrefs.comp_on ? 1 : 0; limDry.gain.value = fxPrefs.lim_on ? 0 : 1; limWet.gain.value = fxPrefs.lim_on ? 1 : 0;
    }

    chkEq.addEventListener('change', () => { fxPrefs.eq_on = chkEq.checked; saveConfig(fxPrefsPath, fxPrefs); toggleFxNode(eqDry, eqWet, fxPrefs.eq_on); syncRustFxContract({ force: true }); });
    chkComp.addEventListener('change', () => { enforceExclusiveDynamics('comp'); fxPrefs.comp_on = chkComp.checked; saveConfig(fxPrefsPath, fxPrefs); toggleFxNode(compDry, compWet, fxPrefs.comp_on); syncRustFxContract({ force: true }); });
    chkLim.addEventListener('change', () => { enforceExclusiveDynamics('limiter'); fxPrefs.lim_on = chkLim.checked; saveConfig(fxPrefsPath, fxPrefs); toggleFxNode(limDry, limWet, fxPrefs.lim_on); syncRustFxContract({ force: true }); });

    document.querySelectorAll('.fx-module').forEach(mod => {
        mod.draggable = true;
        mod.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT' || e.target.classList.contains('slider') || e.target.tagName === 'BUTTON' || e.target.closest('.settings-btn') || e.target.closest('.switch')) { return; } e.stopPropagation(); selectFxModule(mod); });
        mod.addEventListener('dragstart', (e) => { selectFxModule(mod); mod.classList.add('fx-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', mod.dataset.id || 'fx-module'); });
        mod.addEventListener('dragend', () => { mod.classList.remove('fx-dragging'); document.querySelectorAll('.fx-module').forEach(el => el.classList.remove('drag-over')); saveFxOrder(); rebuildAudioRouting(); syncRustFxContractDebounced(); });
    });

    document.getElementById('btn-fx-up')?.addEventListener('click', (e) => { e.stopPropagation(); moveFxModule(selectedFxModule, 'up'); });
    document.getElementById('btn-fx-down')?.addEventListener('click', (e) => { e.stopPropagation(); moveFxModule(selectedFxModule, 'down'); });
    document.getElementById('fx-chain')?.addEventListener('dragover', (e) => {
        const dragged = document.querySelector('.fx-dragging');
        if (!dragged) return;
        e.preventDefault();
        const container = e.currentTarget;
        const afterElement = getFxDropTarget(container, e.clientY);
        if (afterElement) container.insertBefore(dragged, afterElement);
        else container.appendChild(dragged);
    });
    document.addEventListener('click', (e) => { if (selectedFxModule) { if (!e.target.closest('#content-fx')) { clearFxSelection(); } else if (!e.target.closest('.fx-module') && !e.target.closest('.fx-btn')) { clearFxSelection(); } } });

    const savedOrder = fxPrefs.order;
    if (savedOrder && savedOrder.length === 3) { const container = document.getElementById('fx-chain'); savedOrder.forEach(id => { const el = document.querySelector(`.fx-module[data-id="${id}"]`); if (el) container.appendChild(el); }); }
    rebuildAudioRouting();
}

function saveFxOrder() { fxPrefs.order = Array.from(document.querySelectorAll('#fx-chain .fx-module')).map(el => el.dataset.id); saveConfig(fxPrefsPath, fxPrefs); }
setTimeout(initFXUI, 100);

let currentSinkId = null;
let warnedMonitorSameAsMain = false;
const pendingPlayerStopTimeouts = new Map();
let rustAudioProbeStatus = { available: false, running: false, lastStatus: null, lastError: '' };

function shouldPollRustLiveMeters() {
    return generalPrefs.audioEngineMode === 'rustAudio';
}

// Helper on-demand para forzar un refresh manual del estado Rust (no se llama
// desde el flujo normal — el push de 100 ms cubre el caso). Conservado por si
// otra parte del código necesita un pull sincrónico.
async function refreshRustAudioProbeStatus() {
    try {
        if (shouldPollRustLiveMeters()) {
            const result = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'status', silent: true });
            if (result?.success === true) {
                rustAudioProbeStatus = {
                    ...rustAudioProbeStatus,
                    available: true,
                    running: true,
                    lastStatus: result.status || result.message || rustAudioProbeStatus.lastStatus,
                    lastError: ''
                };
                watchRustPlaylistOwnerHealth(rustAudioProbeStatus.lastStatus);
                reconcileRustCartwallRuntimeStatus(rustAudioProbeStatus.lastStatus);
                reconcileRustOverlayRuntimeStatus(rustAudioProbeStatus.lastStatus);
                return;
            }
        }
        rustAudioProbeStatus = await ipcRenderer.invoke('audio-engine-rust-status');
        watchRustPlaylistOwnerHealth(rustAudioProbeStatus.lastStatus);
        reconcileRustCartwallRuntimeStatus(rustAudioProbeStatus.lastStatus);
        reconcileRustOverlayRuntimeStatus(rustAudioProbeStatus.lastStatus);
    } catch (err) {
        rustAudioProbeStatus = { available: false, running: false, lastStatus: null, lastError: err.message || String(err) };
    }
}

// ─── Modo PUSH del motor Rust (filosofía "humilde control remoto") ────────
// El polling agresivo (RUST_LIVE_METER_POLL_MS = 50 ms = 20 Hz) quedó
// retirado. Ahora el motor Rust EMITE su status cada 100 ms desde su propio
// bucle interno (PushTick en main.rs) y main.js lo reenvía al renderer por
// el canal `audio-engine-rust-event`. El listener IPC más abajo en este
// archivo (ipcRenderer.on('audio-engine-rust-event', ...)) lo recibe y
// llama a las funciones reconciliadoras directamente.
//
// Lo único que necesitamos hacer al arranque en modo `rustAudio` es disparar
// UNA sola llamada para forzar el spawn del binario Rust (la lazy-spawn del
// probe arranca el proceso en el primer `command()`). De ahí en adelante el
// push fluye solo y `rustAudioProbeStatus` se mantiene fresco sin tocar IPC.
function ensureRustEngineEagerStart() {
    if (!shouldPollRustLiveMeters()) {
        // Modo webAudio: no spawneamos el motor; el fallback usa
        // ipcRenderer.invoke('audio-engine-rust-status') on-demand.
        return;
    }
    ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'status', silent: true })
        .then(result => {
            if (result?.success === true) {
                rustAudioProbeStatus = {
                    available: true,
                    running: true,
                    lastStatus: result.status || result.message || rustAudioProbeStatus.lastStatus,
                    lastError: ''
                };
            }
        })
        .catch(() => {});
}
ensureRustEngineEagerStart();

function describePlayerState(id, player, role) {
    let filePath = '';
    try {
        if (player?.src && String(player.src).startsWith('file:')) filePath = url.fileURLToPath(player.src);
    } catch (err) {
        filePath = '';
    }
    const virtualActive = isRustVirtualPlayer(player);
    return {
        id,
        role,
        active: virtualActive ? !rustPlaylistVirtualClock.paused : !!(player && !player.paused && !player.ended),
        loaded: virtualActive ? !!rustPlaylistVirtualClock.path : !!(player && player.src),
        currentTime: Number(getPlayerClockTime(player).toFixed(3)),
        duration: Number(getPlayerClockDuration(player).toFixed(3)),
        path: virtualActive ? rustPlaylistVirtualClock.path : filePath,
        sink: id === 'player-a' || id === 'player-b' || id === 'jingle-player' ? (currentSinkId || generalPrefs.outMain || 'default') : undefined
    };
}

function getPlaylistPlayerId(player) {
    if (player === playerA) return 'player-a';
    if (player === playerB) return 'player-b';
    return '';
}

function getPlaybackMetaTitle(meta) {
    const row = meta?.row;
    if (!row) return '';
    return row.dataset?.pureName || row.children?.[1]?.innerText || '';
}

function describeMixPlayer(id, player, gainNode) {
    const meta = getPlayerPlaybackMeta(player) || {};
    const gainValue = Number(gainNode?.gain?.value);
    const currentTime = getPlayerClockTime(player);
    const duration = getPlayerClockDuration(player);
    const virtualActive = isRustVirtualPlayer(player);
    const playlistIndex = meta.row ? getPlaylistIndexFromRow(meta.row) : 0;
    return {
        id,
        active: virtualActive ? !rustPlaylistVirtualClock.paused : !!(player && !player.paused && !player.ended),
        loaded: virtualActive ? !!rustPlaylistVirtualClock.path : !!(player && player.src),
        currentTime: Number(currentTime.toFixed(3)),
        duration: Number(duration.toFixed(3)),
        gain: Number.isFinite(gainValue) ? Number(gainValue.toFixed(4)) : 0,
        isOnAirReference: player === activePlayer,
        isFading: player === fadingPlayer && (virtualActive ? !rustPlaylistVirtualClock.paused : !!(player && !player.paused && !player.ended)),
        hasPendingStop: pendingPlayerStopTimeouts.has(player),
        playlistIndex,
        bus: `pl${Math.max(0, Math.min(3, playlistIndex)) + 1}`,
        title: getPlaybackMetaTitle(meta),
        path: meta.filePath || (virtualActive ? rustPlaylistVirtualClock.path : (player && player.src ? fileURLToPath(player.src) : ''))
    };
}

function buildMixDiagnostics() {
    const playerStates = [
        describeMixPlayer('player-a', playerA, gainA),
        describeMixPlayer('player-b', playerB, gainB)
    ];
    const audiblePlayers = playerStates.filter(player => player.active && player.gain > 0.002);
    const referencePlayer = getPlaylistPlayerId(activePlayer);
    const fadingPlayerId = getPlaylistPlayerId(fadingPlayer);
    const isMixActive = audiblePlayers.length > 1;
    const isFadeTail = !isMixActive && !!playerStates.find(player => player.isFading || player.hasPendingStop);
    const phase = isMixActive
        ? 'mix-activo'
        : isFadeTail
            ? 'cola-fade'
            : audiblePlayers.length === 1
                ? 'single'
                : 'idle';
    return {
        phase,
        active: isMixActive,
        referencePlayer,
        fadingPlayer: fadingPlayerId,
        direction: isMixActive && fadingPlayerId && referencePlayer && fadingPlayerId !== referencePlayer
            ? `${fadingPlayerId} -> ${referencePlayer}`
            : '',
        audibleCount: audiblePlayers.length,
        driftReferencePlayer: referencePlayer,
        shouldIgnoreDrift: isMixActive || isFadeTail,
        players: playerStates
    };
}

function countActiveCartwallPlayers() {
    try {
        return Object.values(cartwallAudioInstances || {}).reduce((sum, instances) => {
            if (!Array.isArray(instances)) return sum;
            return sum + instances.filter(item => item?.audio && !item.audio.paused && !item.audio.ended).length;
        }, 0);
    } catch (err) {
        return 0;
    }
}

function describeRuntimeAudioSource(prefix, item, index) {
    const audio = item?.audio || item;
    if (!audio || audio.paused || audio.ended) return null;
    const srcPath = fileURLToPath(audio.src) || item?.sourcePath || audio.__lfSourcePath || item?.btnInfo?.file || '';
    if (!srcPath) return null;
    return {
        id: `${prefix}-${index + 1}`,
        path: srcPath,
        gain: Number.isFinite(Number(audio.volume)) ? Number(audio.volume) : 1,
        currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : 0,
        duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : 0,
        title: item?.btnInfo?.label || item?.btnInfo?.name || path.basename(srcPath)
    };
}

function listActiveCartwallSources() {
    const sources = [];
    try {
        Object.values(cartwallAudioInstances || {}).forEach(instances => {
            if (!Array.isArray(instances)) return;
            instances.forEach(item => {
                const source = describeRuntimeAudioSource('cartwall', item, sources.length);
                if (source) sources.push(source);
            });
        });
    } catch (err) { }
    return sources.slice(0, 4);
}

function listActiveOverlayDropSources() {
    const sources = [];
    try {
        Array.from(overlayDropInstances || []).forEach(audio => {
            const source = describeRuntimeAudioSource('overlay', audio, sources.length);
            if (source) sources.push(source);
        });
        rustOverlayRuntimes.forEach(runtime => {
            if (!runtime?.path) return;
            sources.push({
                id: runtime.playerId || `overlay-${sources.length + 1}`,
                path: runtime.path,
                gain: 1,
                currentTime: 0,
                duration: 0,
                title: runtime.type === 'time-locution' ? 'locucion de hora' : (runtime.type || 'pisador')
            });
        });
    } catch (err) { }
    return sources.slice(0, 4);
}

function buildOverlayDiagnostics() {
    const cartwallCount = countActiveCartwallPlayers();
    const timeLocutionActive = !!(jingleElement && !jingleElement.paused && !jingleElement.ended);
    return {
        active: activePisadores > 0 || cartwallCount > 0 || timeLocutionActive,
        activePisadores,
        overlayDrops: overlayDropInstances.size + Array.from(rustOverlayRuntimes.values()).filter(runtime => runtime?.type !== 'time-locution').length,
        timeLocutionActive: timeLocutionActive || Array.from(rustOverlayRuntimes.values()).some(runtime => runtime?.type === 'time-locution'),
        cartwallActive: cartwallCount > 0,
        cartwallCount,
        cartwallMode: generalPrefs.cartwallOutputMode || 'master',
        cartwallSources: listActiveCartwallSources(),
        overlayDropSources: listActiveOverlayDropSources(),
        duckingGain: Number.isFinite(duckingNode?.gain?.value) ? Number(duckingNode.gain.value.toFixed(4)) : 1,
        lastTrigger: lastOverlayTriggerInfo
    };
}

function getFxModuleLabel(id) {
    if (id === 'eq') return 'EQ';
    if (id === 'comp') return 'AGC';
    if (id === 'limiter') return 'Limitador';
    return id || '-';
}

function getFxOrderIds() {
    const domOrder = Array.from(document.querySelectorAll('#fx-chain .fx-module')).map(el => el.dataset.id).filter(Boolean);
    if (domOrder.length) return domOrder;
    return Array.isArray(fxPrefs.order) && fxPrefs.order.length ? fxPrefs.order : ['eq', 'comp', 'limiter'];
}

function buildFxDiagnostics() {
    const uiOrder = getFxOrderIds();
    const audioOrder = uiOrder.slice().reverse();
    const activeModules = [];
    if (fxPrefs.eq_on) activeModules.push('EQ');
    if (fxPrefs.comp_on) activeModules.push('AGC');
    if (fxPrefs.lim_on) activeModules.push('Limitador');
    return {
        active: activeModules.length > 0,
        eq: !!fxPrefs.eq_on,
        comp: !!fxPrefs.comp_on,
        limiter: !!fxPrefs.lim_on,
        exclusiveDynamics: true,
        activeModules,
        chain: audioOrder.map(getFxModuleLabel),
        uiOrder: uiOrder.map(getFxModuleLabel),
        preampDb: Number.isFinite(Number(fxPrefs.preamp)) ? Number(fxPrefs.preamp) : 0,
        pan: Number.isFinite(Number(fxPrefs.pan)) ? Number(fxPrefs.pan) : 0,
        mono: !!fxPrefs.mono,
        monitorPath: !generalPrefs.monitorEnabled
            ? 'monitor apagado'
            : generalPrefs.monitorSourceMode === 'preFx'
                ? 'pre-FX/mezcla limpia'
                : 'post-FX/post-master'
    };
}

function buildWebAudioEngineDiagnostics() {
    const mainDeviceId = generalPrefs.outMain || 'default';
    const monitorDeviceId = generalPrefs.outMonitor || mainDeviceId;
    const cueDeviceId = generalPrefs.outCue || mainDeviceId;
    const monitorUsesTap = !!(generalPrefs.monitorEnabled && monitorTap?.isActive);
    const cueUsesTap = !!(cueTap?.isActive);
    const playlistTapCount = playlistTaps.filter(tap => tap?.isActive).length;
    const warnings = [];

    const rustProbeAvailable = !!(rustAudioProbeStatus.available || rustAudioProbeStatus.running || rustAudioProbeStatus.lastStatus);

    if (generalPrefs.audioEngineMode === 'rustAudio') {
        warnings.push(rustProbeAvailable
            ? 'rustAudio solicitado; el motor nativo controla playlist A/B cuando el owner esta activo.'
            : 'rustAudio solicitado, pero el ejecutable nativo no esta disponible.');
    } else if (shouldMirrorRustControlPlane()) {
        warnings.push('Rust control plane activo: rutas, metadata y transporte se espejan al motor nativo.');
    }
    if (isRustPlaylistOwnerEnabled()) {
        warnings.push(isRustPlaylistOwnerActive()
            ? 'Rust es dueno del programa; taps y salidas WebAudio auxiliares desactivadas.'
            : `Rust dueno del programa solicitado; esperando salud del motor nativo${rustPlaylistOwnerHealth.fallbackReason ? ` (${rustPlaylistOwnerHealth.fallbackReason})` : ''}.`);
    }
    if (monitorUsesTap) {
        warnings.push('Monitor usa MediaStreamDestination -> Audio element -> setSinkId; puede tener desfase frente al master.');
    }
    if (isRustPlaylistOwnerEnabled() && generalPrefs.monitorEnabled === true && !monitorUsesTap) {
        warnings.push('Monitor de programa en Rust; el tap WebAudio esta desactivado.');
    }
    if (warnedMonitorSameAsMain) {
        warnings.push('Monitor auxiliar silenciado por compartir salida fisica con Master.');
    }
    if (warnedRustMonitorRouteShared) {
        warnings.push('Monitor Rust no se activo: falta una salida nativa independiente valida.');
    }

    return {
        mode: 'webAudio',
        adapter: 'WebAudioEngineAdapter',
        rustAvailable: rustProbeAvailable,
        rustProbe: {
            available: rustProbeAvailable,
            running: !!rustAudioProbeStatus.running,
            exePath: rustAudioProbeStatus.exePath || '',
            reportPath: rustAudioProbeStatus.reportPath || '',
            lastStatus: rustAudioProbeStatus.lastStatus || null,
            lastDevices: rustAudioProbeStatus.lastDevices || null,
            lastError: rustAudioProbeStatus.lastError || ''
        },
        players: [
            describePlayerState('player-a', playerA, activePlayer === playerA ? 'playlist-active' : 'playlist-standby'),
            describePlayerState('player-b', playerB, activePlayer === playerB ? 'playlist-active' : 'playlist-standby'),
            describePlayerState('jingle-player', jingleElement, 'jingle-time'),
            { id: 'monitor-tap', role: 'output-tap', active: !!monitorTap?.isActive, loaded: true, sink: monitorDeviceId },
            { id: 'cue-tap', role: 'output-tap', active: !!cueTap?.isActive, loaded: true, sink: cueDeviceId },
            { id: 'jingle-overlay', role: 'overlay-bus', active: activePisadores > 0 || !!(jingleElement && !jingleElement.paused && !jingleElement.ended), loaded: true, sink: mainDeviceId },
            { id: 'cartwall-device-tap', role: 'output-tap', active: !!cartwallDeviceTap?.isActive, loaded: true, sink: generalPrefs.outCartwall || mainDeviceId },
            { id: 'playlist-taps', role: 'output-tap-group', active: playlistTapCount > 0, count: playlistTapCount },
            { id: 'cartwall-dynamic', role: 'dynamic-audio-elements', active: countActiveCartwallPlayers() > 0, count: countActiveCartwallPlayers() }
        ],
        buses: [
            { id: 'pgm', label: 'Master', destination: mainDeviceId },
            { id: 'monitor', label: 'Monitor', destination: monitorUsesTap ? monitorDeviceId : 'mirror-muted-or-direct' },
            { id: 'cue', label: 'Cue', destination: cueUsesTap ? cueDeviceId : 'inactive' },
            { id: 'jingle', label: 'Jingles/Pisadores', destination: mainDeviceId },
            { id: 'cartwall', label: 'Cartwall', destination: generalPrefs.cartwallOutputMode || 'master' },
            { id: 'playlists', label: 'Playlist buses', destination: generalPrefs.playlistOutputMode || 'disabled' }
        ],
        mix: buildMixDiagnostics(),
        overlays: buildOverlayDiagnostics(),
        fx: buildFxDiagnostics(),
        devices: {
            main: mainDeviceId,
            monitor: monitorDeviceId,
            cue: cueDeviceId,
            cartwall: generalPrefs.outCartwall || mainDeviceId,
            playlistMode: generalPrefs.playlistOutputMode || 'disabled'
        },
        runtime: {
            playlistOwner: isRustPlaylistOwnerActive() ? 'rustAudioEngine' : 'webAudioRenderer',
            rustControlPlane: shouldMirrorRustControlPlane(),
            rustPlaylistOwnerEnabled: generalPrefs.rustPlaylistOwnerEnabled === true,
            rustPlaylistOwnerRequested: isRustPlaylistOwnerEnabled(),
            rustPlaylistOwnerActive: isRustPlaylistOwnerActive(),
            rustPlaylistOwnerFallbackReason: rustPlaylistOwnerHealth.fallbackReason || ''
        },
        latency: {
            masterMs: 0,
            monitorMs: monitorUsesTap ? 80 : 0,
            cueMs: cueUsesTap ? 80 : 0,
            note: monitorUsesTap || cueUsesTap
                ? 'Estimacion: las salidas tap usan MediaStreamDestination y Audio element, con buffering adicional.'
                : 'Master y salidas auxiliares sin tap activo.'
        },
        encoder: (() => {
            const active = !!(
                (liveMediaRecorder && liveMediaRecorder.state !== 'inactive')
                || livePcmCaptureProcessor
                || rustPcmEncoderSyncRunning
            );
            return {
                active,
                source: active ? (liveEncoderSourceState?.source || (livePcmCaptureProcessor ? 'master' : 'mic')) : 'sin fuente',
                owner: active ? (liveEncoderSourceState?.owner || (livePcmCaptureProcessor ? 'webAudioRenderer' : 'mediaInputRenderer')) : 'none',
                requestedOwner: active ? (liveEncoderSourceState?.requestedOwner || liveEncoderSourceState?.owner || (livePcmCaptureProcessor ? 'webAudioRenderer' : 'mediaInputRenderer')) : 'none',
                captureProvider: active ? (liveEncoderSourceState?.captureProvider || liveEncoderSourceState?.owner || (livePcmCaptureProcessor ? 'webAudioRenderer' : 'mediaInputRenderer')) : 'none',
                encoderProvider: active ? (liveEncoderSourceState?.encoderProvider || 'auto') : 'auto',
                tapPoint: active ? (liveEncoderSourceState?.tapPoint || 'postFx') : 'postFx',
                rustPcmReady: liveEncoderSourceState?.rustPcmReady === true,
                fallbackReason: active ? (liveEncoderSourceState?.fallbackReason || '') : '',
                captureFormat: active ? (liveEncoderSourceState?.captureFormat || (livePcmCaptureProcessor ? 'pcm_s16le' : 'webm-opus')) : '',
                sampleRate: active ? (liveEncoderSourceState?.sampleRate || 0) : 0,
                transport: active ? (liveEncoderSourceState?.transport || 'ffmpeg') : ''
            };
        })(),
        warnings
    };
}

const webAudioEngineAdapter = new WebAudioEngineAdapter({ getState: buildWebAudioEngineDiagnostics });
const rustAudioEngineAdapter = new RustAudioEngineAdapter({
    ipcRenderer,
    getState: buildWebAudioEngineDiagnostics,
    fallbackAdapter: webAudioEngineAdapter
});
const audioEngineClient = new AudioEngineClient({
    mode: generalPrefs.audioEngineMode,
    adapter: webAudioEngineAdapter,
    fallbackAdapter: webAudioEngineAdapter
});
audioEngineClient.registerAdapter('rustAudio', rustAudioEngineAdapter);
let lastRustRouteSyncSignature = '';
let lastRustFxSyncSignature = '';
let warnedRustMonitorRouteShared = false;
let lastRustMonitorRouteUsable = true;
const lastRustRouteOutputs = new Map();
// Serialización: evita enviar un lote de rutas mientras el anterior está en vuelo.
// Si llega un cambio mientras hay comandos en curso se agenda un re-sync forzado.
let _rustRouteContractInFlight = false;
let _rustRoutePendingSync = false;

const RUST_ROUTE_COMMON_DEVICE_WORDS = new Set([
    'audio', 'device', 'speakers', 'speaker', 'auriculares', 'headphones', 'altavoces',
    'salida', 'output', 'digital', 'high', 'definition', 'usb', 'wasapi', 'default'
]);

function tokenizeRustRouteLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[\[\]\(\)\{\}_-]+/g, ' ')
        .replace(/[^a-z0-9áéíóúüñ]+/gi, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !RUST_ROUTE_COMMON_DEVICE_WORDS.has(token));
}

function scoreRustRouteLabelMatch(a = '', b = '') {
    const aTokens = new Set(tokenizeRustRouteLabel(a));
    const bTokens = new Set(tokenizeRustRouteLabel(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let hits = 0;
    aTokens.forEach(token => { if (bTokens.has(token)) hits++; });
    return hits / Math.max(aTokens.size, bTokens.size);
}

function resolveRustRouteOutput(deviceId, rustDevices = {}, browserOutputs = []) {
    const requested = String(deviceId || '').trim();
    const rustOutputs = Array.isArray(rustDevices.outputs) ? rustDevices.outputs : [];
    if (!requested || requested === 'default') return { outputId: 'default', resolved: true, requested: requested || 'default' };
    const exact = rustOutputs.find(output => output.id === requested || output.indexId === requested || output.name === requested);
    if (exact) return { outputId: exact.id || exact.indexId || 'default', resolved: true, requested };

    const browserDevice = browserOutputs.find(device => device.deviceId === requested);
    const browserLabel = browserDevice?.label || '';
    let best = null;
    rustOutputs.forEach(output => {
        const score = scoreRustRouteLabelMatch(browserLabel, output.name || '');
        if (!best || score > best.score) best = { output, score };
    });
    if (best && best.score >= 0.34) {
        return { outputId: best.output.id || best.output.indexId || 'default', resolved: true, requested };
    }
    return { outputId: 'default', resolved: false, requested, browserLabel };
}

function resolveRustRouteOutputId(deviceId, rustDevices = {}, browserOutputs = []) {
    return resolveRustRouteOutput(deviceId, rustDevices, browserOutputs).outputId;
}

function buildRustRouteSyncPlan(rustDevices = {}, browserOutputs = []) {
    const mainDeviceId = generalPrefs.outMain || 'default';
    const monitorDeviceId = generalPrefs.outMonitor || mainDeviceId;
    const cueDeviceId = generalPrefs.outCue || mainDeviceId;
    const cartwallDeviceId = generalPrefs.cartwallOutputMode === 'monitor'
        ? monitorDeviceId
        : generalPrefs.cartwallOutputMode === 'cue'
            ? cueDeviceId
            : generalPrefs.cartwallOutputMode === 'device'
                ? (generalPrefs.outCartwall || mainDeviceId)
                : mainDeviceId;
    const plan = [
        { bus: 'master', outputId: resolveRustRouteOutputId(mainDeviceId, rustDevices, browserOutputs) },
        { bus: 'jingle', outputId: resolveRustRouteOutputId(mainDeviceId, rustDevices, browserOutputs) },
        { bus: 'cue', outputId: resolveRustRouteOutputId(cueDeviceId, rustDevices, browserOutputs) },
        { bus: 'cartwall', outputId: resolveRustRouteOutputId(cartwallDeviceId, rustDevices, browserOutputs) }
    ];
    if (generalPrefs.monitorEnabled) {
        plan.push({
            bus: 'monitor',
            outputId: resolveRustRouteOutputId(monitorDeviceId, rustDevices, browserOutputs),
            sourceMode: generalPrefs.monitorSourceMode === 'preFx' ? 'preFx' : 'postFx'
        });
    }
    // Encoder: ruta virtual (no tiene stream cpal, usa PCM tap por stdout).
    // Siempre se incluye en el plan para que Rust sepa el modo pre/post-FX del encoder.
    // Prioridad: liveEncoderSourceState.tapPoint (estado activo del encoder en ejecución)
    //            > generalPrefs.encoderSourceMode (preferencia guardada)
    //            > 'postFx' (valor seguro por defecto).
    const encoderTapPoint = liveEncoderSourceState?.tapPoint
        || generalPrefs.encoderSourceMode
        || 'postFx';
    plan.push({
        bus: 'encoder',
        outputId: 'pcm-tap',
        sourceMode: encoderTapPoint === 'preFx' ? 'preFx' : 'postFx'
    });
    const playlistMode = generalPrefs.playlistOutputMode || 'disabled';
    if (playlistMode === 'independent') {
        [0, 1, 2, 3].forEach(idx => {
            const playlistDeviceId = generalPrefs.playlistOutputs?.[idx] || generalPrefs.playlistSharedDevice || mainDeviceId;
            plan.push({ bus: `pl${idx + 1}`, outputId: resolveRustRouteOutputId(playlistDeviceId, rustDevices, browserOutputs) });
        });
    }
    return plan;
}

async function syncRustRouteContract({ force = false } = {}) {
    if (!shouldMirrorRustControlPlane()) return;
    // Bug 2: si hay un lote de comandos en vuelo, marcar para re-sync posterior.
    if (_rustRouteContractInFlight) {
        _rustRoutePendingSync = true;
        return;
    }
    _rustRouteContractInFlight = true;
    try {
        let rustDevices = rustAudioProbeStatus.lastDevices || null;
        let browserOutputs = [];
        try {
            browserOutputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audiooutput');
        } catch (err) { }
        if (!rustDevices?.outputs) {
            try {
                const result = await ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'devices', silent: true });
                rustDevices = result?.message || result?.status || rustDevices || {};
                if (result?.success === true && result.message?.type === 'devices') {
                    rustAudioProbeStatus.lastDevices = result.message;
                }
            } catch (err) { }
        }
        const plan = buildRustRouteSyncPlan(rustDevices || {}, browserOutputs);
        lastRustRouteOutputs.clear();
        plan.forEach(route => {
            if (route?.bus) lastRustRouteOutputs.set(route.bus, route.outputId || 'default');
        });
        const rustMasterOutput = lastRustRouteOutputs.get('master') || 'default';
        const rustMonitorOutput = lastRustRouteOutputs.get('monitor') || '';
        const monitorDeviceId = generalPrefs.outMonitor || generalPrefs.outMain || 'default';
        const monitorResolution = resolveRustRouteOutput(monitorDeviceId, rustDevices || {}, browserOutputs);
        const monitorRequested = generalPrefs.monitorEnabled === true
            && monitorDeviceId !== (generalPrefs.outMain || 'default');
        const monitorCannotUseRustOutput = !!(monitorRequested && (!monitorResolution.resolved || (rustMonitorOutput && rustMonitorOutput === rustMasterOutput)));
        // Bug 4 (lado JS): rastrear transición false→true para re-activar el espejo.
        const previousMonitorUsable = lastRustMonitorRouteUsable;
        lastRustMonitorRouteUsable = !monitorCannotUseRustOutput;
        if (monitorCannotUseRustOutput) {
            if (!warnedRustMonitorRouteShared) {
                warnedRustMonitorRouteShared = true;
                const reason = monitorResolution.resolved
                    ? 'la salida seleccionada resuelve al mismo dispositivo nativo que Master'
                    : 'no pude relacionar el deviceId de Electron con una salida nativa de Rust';
                logSystem(`[ADVERTENCIA] Monitor Rust no se espeja: ${reason}.`);
            }
            syncRustMonitorMirror([], { force: true });
        } else {
            warnedRustMonitorRouteShared = false;
            // Bug 4: monitor volvió a ser usable → re-sincronizar espejo con los
            // players vivos actuales después de que las rutas lleguen al motor.
            if (!previousMonitorUsable && lastRustMonitorRouteUsable) {
                setTimeout(() => syncRustPlaylistControlPlane({ force: true, syncPosition: true }), 600);
            }
        }
        const signature = JSON.stringify(plan);
        if (!force && signature === lastRustRouteSyncSignature) return;
        lastRustRouteSyncSignature = signature;
        plan.forEach(route => {
            commandRustControlPlane('route', route).catch(() => { });
        });
    } finally {
        _rustRouteContractInFlight = false;
        // Si llegó un cambio mientras estábamos procesando, re-sincronizar ahora.
        if (_rustRoutePendingSync) {
            _rustRoutePendingSync = false;
            syncRustRouteContract({ force: true });
        }
    }
}
setTimeout(() => {
    syncRustRouteContract({ force: true });
    // Enviar ganancia inicial del master y monitor al motor Rust en el arranque.
    const initMasterVol = btnMasterVol ? (Number(btnMasterVol.value) || 100) / 100 : 1.0;
    commandRustControlPlane('masterGain', { gain: initMasterVol }).catch(() => {});
    commandRustControlPlane('monitorGain', { gain: (generalPrefs.monitorVolume ?? 100) / 100 }).catch(() => {});
}, 1200);

function buildRustFxSyncPlan() {
    const diagnostics = buildFxDiagnostics();
    return {
        eq: diagnostics.eq === true,
        comp: diagnostics.comp === true,
        limiter: diagnostics.limiter === true,
        preampDb: diagnostics.preampDb || 0,
        pan: diagnostics.pan || 0,
        mono: diagnostics.mono === true,
        bands: Array.isArray(fxPrefs.eq_bands) ? fxPrefs.eq_bands : [],
        order: getFxOrderIds().slice().reverse()
    };
}

function syncRustFxContract({ force = false } = {}) {
    if (!shouldMirrorRustControlPlane()) return;
    const plan = buildRustFxSyncPlan();
    const signature = JSON.stringify(plan);
    if (!force && signature === lastRustFxSyncSignature) return;
    lastRustFxSyncSignature = signature;
    commandRustControlPlane('fx', plan).catch(() => { });
}

// Versión debounced para uso durante arrastre de sliders EQ (evita saturar el IPC).
let _rustFxDebounceTimer = null;
function syncRustFxContractDebounced() {
    clearTimeout(_rustFxDebounceTimer);
    _rustFxDebounceTimer = setTimeout(() => syncRustFxContract({ force: true }), 50);
}

function getRustPlaylistBusFromIndex(playlistIndex = 0) {
    const idx = Math.max(0, Math.min(3, Number(playlistIndex) || 0));
    return `pl${idx + 1}`;
}

function getRustPlaylistPrimaryBus(rowOrIndex) {
    const playlistIndex = typeof rowOrIndex === 'number' ? rowOrIndex : getPlaylistIndexFromRow(rowOrIndex);
    return getRustPlaylistBusFromIndex(playlistIndex);
}

function getRustPlaylistAuxBus(row) {
    const mode = generalPrefs.playlistOutputMode || 'disabled';
    if (mode !== 'independent') return '';
    return getRustPlaylistPrimaryBus(row);
}

function getRustPlaylistAuxPlayerId(playerId, row) {
    return '';
}

function getRustPrimaryPlayerId(playerId = '') {
    return String(playerId || '').replace(/-aux$/, '');
}

ipcRenderer.on('audio-engine-command', (event, command = {}) => {
    Promise.resolve(audioEngineClient.command(command.type, command.payload || {})).then(result => {
        ipcRenderer.send('audio-engine-command-result', {
            id: command.id || null,
            type: command.type || '',
            result,
            diagnostics: audioEngineClient.getDiagnostics()
        });
    });
});

function dbToLinear(db) {
    const val = parseFloat(db);
    if (!Number.isFinite(val)) return 1;
    return Math.pow(10, val / 20);
}

function getCrossfadeConfig(typeData, filePath) {
    const mc = filePath ? (manualCuesDB[filePath] || {}) : {};

    let fadein = 0, fadeoutStop = 0, fadeoutNext = 0, mixTrigger = 0, mixFadeout = 0, ampDb = 0, mixFadeoutActive = false;
    const source = typeData ? `tipo:${typeData.name || typeData.id || 'archivo'}` : 'general';
    const mixDbActive = typeData ? typeData.mixDbActive === true : generalPrefs.chk_mus_mix_db === true;
    const mixDb = typeData ? (parseFloat(typeData.mixDb) || -14) : (parseFloat(generalPrefs.num_mus_mix_db) || -14);

    if (typeData) {
        fadein = typeData.fadeinActive ? (parseFloat(typeData.fadein) || 0) : 0;
        fadeoutStop = typeData.fadeoutStopActive ? (parseFloat(typeData.fadeoutStop) || 0) : 0;
        fadeoutNext = typeData.fadeoutNextActive ? (parseFloat(typeData.fadeoutNext) || 0) : 0;
        mixTrigger = typeData.mixActive ? (parseFloat(typeData.mix) || 0) : 0;
        mixFadeoutActive = typeData.mixFadeoutActive === true;
        mixFadeout = mixFadeoutActive ? fadeoutNext : 0;
        ampDb = parseFloat(typeData.amp) || 0;
    } else {
        fadein = generalPrefs.chk_mus_fadein ? (parseFloat(generalPrefs.num_mus_fadein) || 0) : 0;
        fadeoutStop = generalPrefs.chk_mus_fadeout_stop ? (parseFloat(generalPrefs.num_mus_fadeout_stop) || 0) : 0;
        fadeoutNext = generalPrefs.chk_mus_fadeout_next ? (parseFloat(generalPrefs.num_mus_fadeout_next) || 0) : 0;
        mixTrigger = generalPrefs.chk_mus_mix ? (parseFloat(generalPrefs.num_mus_mix) || 0) : 0;
        mixFadeoutActive = generalPrefs.chk_mus_mix_fadeout === true;
        mixFadeout = mixFadeoutActive ? fadeoutNext : 0;
        ampDb = 0;
    }

    const mixAbsolute = parseFiniteCueValue(mc.mix);

    return { fadein, fadeoutStop, fadeoutNext, mixTrigger, mixFadeout, mixFadeoutActive, ampDb, mixAbsolute, mixDbActive, mixDb, source };
}

function getFadeOutPlanForTransition(player, trackConfig, isAutoMix, forcedSeconds) {
    if (forcedSeconds > 0) return { seconds: forcedSeconds, stopDelaySeconds: forcedSeconds, scheduleStop: true, holdTail: false };
    if (!trackConfig) return { seconds: 0, stopDelaySeconds: 0, scheduleStop: false, holdTail: false };
    if (isAutoMix) {
        const meta = getPlayerPlaybackMeta(player) || {};
        const finAbsolute = parseFiniteCueValue(meta.playbackEndAbsolute) ?? parseFiniteCueValue(meta.naturalEndAbsolute);
        const remainingToFin = finAbsolute !== null ? Math.max(0, finAbsolute - getPlayerClockTime(player)) : 0;
        if (trackConfig.mixFadeoutActive) {
            const fadeSeconds = remainingToFin || trackConfig.mixFadeout || trackConfig.fadeoutNext || 0;
            return { seconds: fadeSeconds, stopDelaySeconds: fadeSeconds, scheduleStop: fadeSeconds > 0, holdTail: false };
        }
        return { seconds: 0, stopDelaySeconds: remainingToFin, scheduleStop: remainingToFin > 0, holdTail: true };
    }
    const fadeSeconds = trackConfig.fadeoutNext || 0;
    if (fadeSeconds <= 0) return { seconds: 0, stopDelaySeconds: 0, scheduleStop: false, holdTail: false };
    return { seconds: fadeSeconds, stopDelaySeconds: fadeSeconds, scheduleStop: true, holdTail: false };
}

function getRustTransitionPlan({ row, filePath, currentConfig, outgoingConfig, playbackWindow, isAutoMix, forcedFadeOutSeconds, targetGain, previousGain }) {
    const customMix = parseFiniteCueValue(row?.dataset?.customMix);
    const mixSource = customMix !== null
        ? 'playlist-personalizado'
            : playbackWindow?.mixAbsolute !== null && playbackWindow?.mixAbsolute !== undefined
            ? 'analisis/manual-cue'
            : currentConfig?.mixTrigger > 0
                ? 'mix-tiempo-general/tipo'
                : getFallbackMixTriggerSeconds(currentConfig) > 0
                    ? 'plan-b-sin-analisis'
                : currentConfig?.mixDbActive
                    ? 'pendiente-analisis-db'
                    : 'sin-mix';
    const fadeOutPlan = getFadeOutPlanForTransition(null, outgoingConfig, isAutoMix, forcedFadeOutSeconds);
    return {
        filePath,
        mixSource,
        settingsSource: currentConfig?.source || 'general',
        startOffset: currentStartTimeOffset,
        mixAbsolute: playbackWindow?.mixAbsolute ?? null,
        fadeInSeconds: currentConfig?.fadein || 0,
        fadeOutSeconds: fadeOutPlan.seconds || 0,
        tailStopSeconds: fadeOutPlan.stopDelaySeconds || 0,
        holdTail: fadeOutPlan.holdTail === true,
        targetGain: Number.isFinite(Number(targetGain)) ? Number(targetGain) : 1,
        previousGain: Number.isFinite(Number(previousGain)) ? Number(previousGain) : 1,
        mixDbActive: currentConfig?.mixDbActive === true,
        mixDb: currentConfig?.mixDb ?? null
    };
}

function maybeRequestTransitionPreanalysis(filePath, trackConfig) {
    if (!filePath) return;
    const mc = manualCuesDB[filePath] || {};
    if (hasValidNumber(mc.inicio) && hasValidNumber(mc.fin) && hasValidNumber(mc.mix)) return;
    ensurePreanalysisForTrack(filePath, {
        dbMix: trackConfig?.mixDb ?? ANALYSIS_DEFAULTS.dbMix,
        dbStart: ANALYSIS_DEFAULTS.dbStart,
        dbFin: ANALYSIS_DEFAULTS.dbFin,
        priority: trackConfig?.priority || 'normal'
    });
}

function requestImmediateTransitionPreanalysis(filePath, trackConfig) {
    if (!filePath) return;
    const mc = manualCuesDB[filePath] || {};
    if (hasValidNumber(mc.inicio) && hasValidNumber(mc.fin) && hasValidNumber(mc.mix)) return;
    preanalysisRequested.delete(filePath);
    ensurePreanalysisForTrack(filePath, {
        dbMix: trackConfig?.mixDb ?? ANALYSIS_DEFAULTS.dbMix,
        dbStart: ANALYSIS_DEFAULTS.dbStart,
        dbFin: ANALYSIS_DEFAULTS.dbFin,
        priority: 'now'
    });
    if (preanalysisTimer) {
        clearTimeout(preanalysisTimer);
        preanalysisTimer = null;
    }
    flushPreanalysisQueue();
}

function cancelPendingPlayerStop(player) {
    const timeoutId = pendingPlayerStopTimeouts.get(player);
    if (timeoutId) {
        clearTimeout(timeoutId);
        pendingPlayerStopTimeouts.delete(player);
    }
}

function schedulePlayerStop(player, delayMs) {
    if (!player || !Number.isFinite(delayMs) || delayMs <= 0) return;
    cancelPendingPlayerStop(player);
    const timeoutId = setTimeout(() => {
        pendingPlayerStopTimeouts.delete(player);
        try { player.pause(); } catch (err) { }
        try { player.currentTime = 0; } catch (err) { }
        clearPlayerPlaybackMeta(player);
    }, delayMs);
    pendingPlayerStopTimeouts.set(player, timeoutId);
}

async function setTapSink(tap, deviceId, label) {
    if (tap.audioEl.setSinkId) {
        try { await tap.audioEl.setSinkId(deviceId || 'default'); }
        catch (e) { logSystem(`[ERROR Audio] Fallo ${label}.`); }
    }
}

function getAudioRouteSignature(prefs = {}) {
    const normalized = normalizeAudioPrefs(prefs || {});
    return JSON.stringify({
        audioEngineMode: normalized.audioEngineMode || 'rustAudio',
        rustPlaylistOwnerEnabled: normalized.rustPlaylistOwnerEnabled === true,
        outMain: normalized.outMain || 'default',
        outMonitor: normalized.outMonitor || normalized.outMain || 'default',
        outCue: normalized.outCue || normalized.outMain || 'default',
        outCartwall: normalized.outCartwall || normalized.outMain || 'default',
        monitorEnabled: normalized.monitorEnabled === true,
        monitorSourceMode: normalized.monitorSourceMode === 'preFx' ? 'preFx' : 'postFx',
        playlistOutputMode: normalized.playlistOutputMode || 'disabled',
        playlistSharedDevice: normalized.playlistSharedDevice || normalized.outMain || 'default',
        playlistOutputs: Array.isArray(normalized.playlistOutputs) ? normalized.playlistOutputs.slice(0, 4) : [],
        cartwallOutputMode: normalized.cartwallOutputMode || 'master'
    });
}

async function applyAudioRouting() {
    generalPrefs = normalizeAudioPrefs(generalPrefs);

    const mainDeviceId = generalPrefs.outMain || 'default';
    const monitorDeviceId = generalPrefs.outMonitor || mainDeviceId;
    const cueDeviceId = generalPrefs.outCue || mainDeviceId;
    const cartwallDeviceId = generalPrefs.outCartwall || mainDeviceId;
    const rustOwnsProgramAudio = isRustPlaylistOwnerEnabled();
    const webAudioMainDeviceId = rustOwnsProgramAudio ? 'default' : mainDeviceId;
    let outputDevices = [];
    connectMonitorMirrorSource();

    if (audioCtx.setSinkId && currentSinkId !== webAudioMainDeviceId) {
        try { await audioCtx.setSinkId(webAudioMainDeviceId); currentSinkId = webAudioMainDeviceId; } catch (e) { logSystem("[ERROR Audio] Fallo PGM."); }
    }

    try {
        outputDevices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audiooutput');
    } catch (err) { }

    const monitorSharesMainOutput = generalPrefs.monitorEnabled && outputsSharePhysicalDevice(monitorDeviceId, mainDeviceId, outputDevices);
    if (rustOwnsProgramAudio) {
        warnedMonitorSameAsMain = false;
        setImmediateGain(monitorMirrorSend, 0);
        suspendTapPlayback(monitorTap);
        // Bug 3: sincronizar ganancia del monitor al motor Rust al aplicar routing.
        // Si está desactivado → gain=0; si activo → volumen configurado.
        const rustMonGain = generalPrefs.monitorEnabled
            ? (generalPrefs.monitorVolume ?? 100) / 100
            : 0;
        commandRustControlPlane('monitorGain', { gain: rustMonGain }).catch(() => {});
    } else if (monitorSharesMainOutput) {
        setImmediateGain(monitorMirrorSend, 0);
        suspendTapPlayback(monitorTap);
        if (!warnedMonitorSameAsMain) {
            warnedMonitorSameAsMain = true;
            logSystem("[ADVERTENCIA] Monitor auxiliar silenciado: comparte la misma salida fisica que Master y producia duplicacion/chorus.");
        }
    } else {
        warnedMonitorSameAsMain = false;
        setImmediateGain(monitorMirrorSend, generalPrefs.monitorEnabled ? 1 : 0);
        if (generalPrefs.monitorEnabled) {
            await resumeTapPlayback(monitorTap);
            await setTapSink(monitorTap, monitorDeviceId, 'Monitor');
        } else {
            suspendTapPlayback(monitorTap);
        }
    }

    if (rustOwnsProgramAudio) {
        suspendTapPlayback(cueTap);
        playlistTaps.forEach(tap => {
            setImmediateGain(tap.input, 0);
            suspendTapPlayback(tap);
        });
        setImmediateGain(cartwallMasterSend, 0);
        setImmediateGain(cartwallMonitorSend, 0);
        setImmediateGain(cartwallCueSend, 0);
        setImmediateGain(cartwallDeviceTap.input, 0);
        suspendTapPlayback(cartwallDeviceTap);
        return;
    }

    const cueTapActive = generalPrefs.cartwallOutputMode === 'cue';
    if (cueTapActive) {
        await resumeTapPlayback(cueTap);
        await setTapSink(cueTap, cueDeviceId, 'CUE');
    } else {
        suspendTapPlayback(cueTap);
    }

    const playlistMode = generalPrefs.playlistOutputMode || 'disabled';
    for (let idx = 0; idx < playlistTaps.length; idx++) {
        const tap = playlistTaps[idx];
        if (playlistMode === 'disabled') {
            setImmediateGain(tap.input, 0);
            suspendTapPlayback(tap);
            continue;
        }

        const playlistDeviceId = playlistMode === 'shared'
            ? (generalPrefs.playlistSharedDevice || mainDeviceId)
            : (generalPrefs.playlistOutputs[idx] || generalPrefs.playlistSharedDevice || mainDeviceId);

        if (outputsSharePhysicalDevice(playlistDeviceId, mainDeviceId, outputDevices)) {
            setImmediateGain(tap.input, 0);
            suspendTapPlayback(tap);
            continue;
        }

        setImmediateGain(tap.input, 1);
        await resumeTapPlayback(tap);
        await setTapSink(tap, playlistDeviceId, `Playlist ${idx + 1}`);
    }

    setImmediateGain(cartwallMasterSend, generalPrefs.cartwallOutputMode === 'master' ? 1 : 0);
    setImmediateGain(cartwallMonitorSend, generalPrefs.cartwallOutputMode === 'monitor' ? 1 : 0);
    setImmediateGain(cartwallCueSend, generalPrefs.cartwallOutputMode === 'cue' ? 1 : 0);
    const cartwallDeviceActive = generalPrefs.cartwallOutputMode === 'device';
    setImmediateGain(cartwallDeviceTap.input, cartwallDeviceActive ? 1 : 0);
    if (cartwallDeviceActive) {
        await resumeTapPlayback(cartwallDeviceTap);
        await setTapSink(cartwallDeviceTap, cartwallDeviceId, 'Cartwall');
    } else {
        suspendTapPlayback(cartwallDeviceTap);
    }
}
applyAudioRouting();

const btnMonitorVol = document.getElementById('monitor-volume');
const btnMonitorVolPop = document.getElementById('monitor-volume-pop');
const monitorFaderWrap = document.getElementById('monitor-fader-wrap');
const monitorToolbarWrap = document.getElementById('monitor-toolbar-wrap');
const monitorPopover = document.getElementById('monitor-popover');
const btnMonitorUi = document.getElementById('btn-monitor-ui');

function syncMonitorVolumeInputs(nextValue) {
    const safeValue = Math.max(0, Math.min(100, parseInt(nextValue, 10) || 0));
    if (btnMonitorVol) btnMonitorVol.value = safeValue;
    if (btnMonitorVolPop) btnMonitorVolPop.value = safeValue;
}

function closeMonitorPopover() {
    if (monitorPopover) monitorPopover.style.display = 'none';
}

function toggleMonitorPopover(forceState = null) {
    if (!monitorPopover || !monitorToolbarWrap || monitorToolbarWrap.style.display === 'none') return;
    const shouldOpen = forceState === null ? monitorPopover.style.display === 'none' : forceState === true;
    monitorPopover.style.display = shouldOpen ? 'block' : 'none';
}

function updateMonitorVolumeUi() {
    const canShowMonitorUi = generalPrefs.monitorEnabled === true && generalPrefs.monitorVolumeUiEnabled !== false;
    const mode = generalPrefs.monitorVolumeUiMode === 'icon' ? 'icon' : 'inline';

    if (monitorFaderWrap) monitorFaderWrap.style.display = canShowMonitorUi && mode === 'inline' ? 'flex' : 'none';
    if (monitorToolbarWrap) monitorToolbarWrap.style.display = canShowMonitorUi && mode === 'icon' ? 'flex' : 'none';
    if (!canShowMonitorUi || mode !== 'icon') closeMonitorPopover();
}

function setMonitorVolume(nextValue, persist = true) {
    const safeValue = Math.max(0, Math.min(100, parseInt(nextValue, 10) || 0));
    setImmediateGain(monitorOutputGain, safeValue / 100);
    generalPrefs.monitorVolume = safeValue;
    syncMonitorVolumeInputs(safeValue);
    if (persist) saveConfig(generalPrefsPath, generalPrefs);
    // Bug 3: en Rust el monitor tiene su propio FaderSource. Si el monitor está
    // desactivado enviar gain=0 para silenciarlo; si está activo, el volumen real.
    const rustMonGain = (generalPrefs.monitorEnabled !== false) ? (safeValue / 100) : 0;
    commandRustControlPlane('monitorGain', { gain: rustMonGain }).catch(() => {});
    syncRustPlaylistControlPlane({ force: true, syncPosition: false });
}

syncMonitorVolumeInputs(generalPrefs.monitorVolume ?? 100);
updateMonitorVolumeUi();

if (btnMonitorVol) btnMonitorVol.addEventListener('input', (e) => {
    setMonitorVolume(e.target.value);
});
if (btnMonitorVolPop) btnMonitorVolPop.addEventListener('input', (e) => {
    setMonitorVolume(e.target.value);
});
if (btnMonitorUi) {
    btnMonitorUi.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMonitorPopover();
    });
}
document.addEventListener('click', (e) => {
    if (!monitorToolbarWrap || !monitorPopover) return;
    if (monitorPopover.style.display !== 'block') return;
    if (monitorToolbarWrap.contains(e.target)) return;
    closeMonitorPopover();
});

ipcRenderer.on('settings-updated', () => {
    const previousRouteSignature = getAudioRouteSignature(generalPrefs);
    const previousEngineMode = generalPrefs.audioEngineMode || 'rustAudio';
    generalPrefs = normalizeAudioPrefs(loadConfig(generalPrefsPath, generalPrefs));
    const routeChanged = previousRouteSignature !== getAudioRouteSignature(generalPrefs);
    const engineChanged = previousEngineMode !== (generalPrefs.audioEngineMode || 'rustAudio');
    audioEngineClient.setRequestedMode(generalPrefs.audioEngineMode);
    if (routeChanged || engineChanged) {
        applyRustPlaylistOwnerMute();
        syncRustPlaylistControlPlane({ force: engineChanged, syncPosition: false });
        syncRustRouteContract({ force: engineChanged });
    }
    syncRustFxContract({ force: engineChanged });
    loadFileTypes();
    setMonitorVolume(generalPrefs.monitorVolume ?? 100, false);
    updateMonitorVolumeUi();
    if (routeChanged || engineChanged) applyAudioRouting();
    if (currentPlayingRow && currentPlayingRow.dataset && currentPlayingRow.dataset.ruta) {
        currentTrackConfig = getCrossfadeConfig(getTrackTypeData(currentPlayingRow.dataset.ruta), currentPlayingRow.dataset.ruta);
    }
});

let lastLeftPeak = 0; let lastRightPeak = 0; let isJinglePlaying = false;
let activePlayer = playerA; let activeGain = gainA; let fadingPlayer = null; let fadingGain = null;
let currentTrackConfig = null; let crossfadeTriggered = false;
let currentStartTimeOffset = 0; let currentFiredDrops = [];
let playRowSessionId = 0;
let lastOverlayEvalSessionId = 0;
let lastOverlayEvalElapsed = 0;

let activePisadores = 0;
const overlayDropInstances = new Set();
let lastOverlayTriggerInfo = null;
const rustPlaylistPreDuckingGains = new Map();
const rustOverlayRuntimes = new Map();

function applyRustPlaylistDucking() {
    if (!isRustPlaylistOwnerActive()) return;
    const duckGain = Math.max(0, Math.min(1, (parseInt(generalPrefs.duckingVolume, 10) || 20) / 100));
    rustPlaylistMirrorState.forEach((state, playerId) => {
        if (!state?.owner || state.status === 'stopped') return;
        if (!rustPlaylistPreDuckingGains.has(playerId)) {
            rustPlaylistPreDuckingGains.set(playerId, Number.isFinite(Number(state.gain)) ? Number(state.gain) : 1);
        }
        const baseGain = rustPlaylistPreDuckingGains.get(playerId) ?? 1;
        const duckedGain = Math.max(0, Math.min(2, baseGain * duckGain));
        commandRustPlaylist('setGain', { player: playerId, gain: duckedGain }).catch(() => { });
        setRustPlaylistMirrorGain(playerId, duckedGain);
    });
}

function removeRustPlaylistDucking() {
    if (!rustPlaylistPreDuckingGains.size) return;
    rustPlaylistPreDuckingGains.forEach((gain, playerId) => {
        commandRustPlaylist('setGain', { player: playerId, gain }).catch(() => { });
        setRustPlaylistMirrorGain(playerId, gain);
    });
    rustPlaylistPreDuckingGains.clear();
}

function applyDucking() {
    const fadeSecs = Math.max(0.1, parseFloat(generalPrefs.duckingFade) || 1.0);
    const duckVol = Math.max(0, Math.min(100, parseInt(generalPrefs.duckingVolume) || 20));
    if (!isRustExclusiveAudioMode()) {
        duckingNode.gain.cancelScheduledValues(audioCtx.currentTime);
        duckingNode.gain.setValueAtTime(duckingNode.gain.value, audioCtx.currentTime);
        duckingNode.gain.linearRampToValueAtTime(duckVol / 100, audioCtx.currentTime + fadeSecs);
    }
    applyRustPlaylistDucking();
}
function removeDucking() {
    const fadeSecs = Math.max(0.1, parseFloat(generalPrefs.duckingFade) || 1.0);
    if (!isRustExclusiveAudioMode()) {
        duckingNode.gain.cancelScheduledValues(audioCtx.currentTime);
        duckingNode.gain.setValueAtTime(duckingNode.gain.value, audioCtx.currentTime);
        duckingNode.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + fadeSecs);
    }
    removeRustPlaylistDucking();
}

function shouldRustOwnJingleBus() {
    return generalPrefs.audioEngineMode === 'rustAudio' && shouldMirrorRustControlPlane();
}

function beginProgramOverlayDucking() {
    activePisadores++;
    if (activePisadores === 1) applyDucking();
}

function endProgramOverlayDucking() {
    activePisadores--;
    if (activePisadores <= 0) {
        activePisadores = 0;
        removeDucking();
    }
}

function buildRustOverlayPlayerId(prefix = 'overlay') {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function registerRustOverlayRuntime(runtime = {}) {
    if (!runtime.playerId) return;
    rustOverlayRuntimes.set(runtime.playerId, runtime);
    if (runtime.affectsProgram !== false) beginProgramOverlayDucking();
}

function finishRustOverlayRuntime(playerId = '') {
    const runtime = rustOverlayRuntimes.get(playerId);
    if (!runtime) return;
    rustOverlayRuntimes.delete(playerId);
    commandRustControlPlane('stop', { player: playerId }).catch(() => { });
    if (runtime.affectsProgram !== false) endProgramOverlayDucking();
    if (typeof runtime.onEnded === 'function') runtime.onEnded(runtime);
}

function reconcileRustOverlayRuntimeStatus(status = {}) {
    const rustPlayers = new Map((Array.isArray(status?.players) ? status.players : []).map(player => [player?.id, player]));
    Array.from(rustOverlayRuntimes.keys()).forEach(playerId => {
        const rustPlayer = rustPlayers.get(playerId);
        if (!rustPlayer) return;
        if (rustPlayer.status === 'ended' || rustPlayer.status === 'stopped') {
            finishRustOverlayRuntime(playerId);
        }
    });
}

async function playOverlayDropViaRust(filePath) {
    const playerId = buildRustOverlayPlayerId('overlay');
    registerRustOverlayRuntime({ playerId, path: filePath, type: 'overlay', affectsProgram: true });
    const result = await commandRustControlPlane('load', {
        player: playerId,
        bus: 'jingle',
        path: filePath,
        gain: 1,
        autoplay: true
    });
    if (result?.ok) return true;
    finishRustOverlayRuntime(playerId);
    logSystem(`[RUST OVERLAY] No se pudo reproducir pisador: ${result?.error || 'sin detalle'}`);
    return false;
}

async function playOverlayDrop(filePath) {
    if (!fs.existsSync(filePath)) return;
    let finalPath = filePath;
    if (fs.statSync(filePath).isDirectory()) {
        const files = fs.readdirSync(filePath).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
        if (files.length > 0) finalPath = path.join(filePath, files[Math.floor(Math.random() * files.length)]); else return;
    }
    if (shouldRustOwnJingleBus()) {
        await playOverlayDropViaRust(finalPath);
        return;
    }
    try {
        const dropAudio = new window.Audio(url.pathToFileURL(finalPath).href);
        dropAudio.__lfSourcePath = finalPath;
        const dropSource = audioCtx.createMediaElementSource(dropAudio);
        dropSource.connect(jingleBus);
        overlayDropInstances.add(dropAudio);

        beginProgramOverlayDucking();

        dropAudio.play().catch(e => { });
        dropAudio.onended = () => {
            dropSource.disconnect();
            dropAudio.src = '';
            overlayDropInstances.delete(dropAudio);
            endProgramOverlayDucking();
        };
    } catch (err) { }
}

function resolveTimedOverlayTrigger({ markerTime, mode = 'start', startOffset = 0, estimatedDuration = 0 }) {
    const marker = parseFloat(markerTime);
    if (!Number.isFinite(marker)) return null;
    const offset = Number.isFinite(Number(startOffset)) ? Number(startOffset) : 0;
    const duration = Math.max(0, Number(estimatedDuration) || 0);
    let absoluteTrigger = marker;
    let adjustedMode = mode || 'start';

    if (adjustedMode === 'end') {
        const endModeTrigger = marker - duration;
        // Si una marca temprana no alcanza para restar la duracion del pisador,
        // se respeta la marca como disparo directo en vez de forzar 0.1s.
        absoluteTrigger = endModeTrigger >= offset ? endModeTrigger : marker;
        if (absoluteTrigger === marker) adjustedMode = 'start-fallback';
    }

    const triggerTime = Math.max(0, absoluteTrigger - offset);
    return { marker, triggerTime, adjustedMode };
}

function didCrossOverlayTrigger(triggerTime, realElapsed) {
    if (!isTrackReady) return false;
    if (!Number.isFinite(triggerTime) || !Number.isFinite(realElapsed)) return false;
    if (lastOverlayEvalSessionId !== playRowSessionId) {
        lastOverlayEvalSessionId = playRowSessionId;
        lastOverlayEvalElapsed = 0;
    }
    const previousElapsed = lastOverlayEvalElapsed;
    return previousElapsed < triggerTime
        && realElapsed >= triggerTime
        && realElapsed <= triggerTime + 1.5;
}

function rememberOverlayEval(realElapsed) {
    if (!isTrackReady) return;
    if (!Number.isFinite(realElapsed)) return;
    lastOverlayEvalSessionId = playRowSessionId;
    if (lastOverlayEvalElapsed > realElapsed + 0.25) {
        lastOverlayEvalElapsed = Math.max(0, realElapsed);
        return;
    }
    lastOverlayEvalElapsed = Math.max(0, realElapsed);
}

// La secuenciación de la locución horaria vive ahora en el motor Rust
// (comando `timeLocution`). Las funciones que aquí existían
// (buildPlaylistTimeSegment, getActivePlaylistTimeSegment,
// loadActivePlaylistTimeSegment, advancePlaylistTimeSegment) se eliminaron:
// Electron ya no decodifica audio ni cuenta tiempo de segmentos. El motor
// emite `timeLocutionEnded` y el listener IPC al final del archivo se
// encarga de avanzar la playlist y liberar el ducking de la botonera.

function schedulePlayNextAfterFailure(isAutoMix = false, delayMs = 1200) {
    const name = currentPlayingRow?.dataset?.pureName || currentPlayingRow?.children?.[1]?.innerText || 'pista actual';
    haltPlaybackOnFatalError(`Fallo de reproduccion en ${name}. La siguiente pista no se disparo automaticamente.`, { autoAction: true });
}

function handleTimeUpdate(player) {
    if (player !== activePlayer || !currentPlayingRow) return;
    publishRustTransport();
    const activePlayerMeta = getPlayerPlaybackMeta(activePlayer);

    // La locución horaria se trata ahora como una pista normal: usa el mismo
    // player virtual y el mismo `playbackEndAbsolute`, así handleTimeUpdate la
    // procesa con el flujo estándar (pinta el reloj, detecta fin, dispara
    // playNext con transición). Ya no hace falta la rama especial isPlaylistTimeActive.

    let startOffset = 0;
    if (manualCuesDB[currentPlayingRow.dataset.ruta]) {
        startOffset = parseFloat(manualCuesDB[currentPlayingRow.dataset.ruta].inicio) || 0;
    }

    let elapsed = getPlayerClockTime(activePlayer);
    let realElapsed = elapsed - startOffset;
    if (realElapsed < 0) realElapsed = 0;

    const totalElapsed = realElapsed;
    let timeLeft = currentDuration - totalElapsed;
    if (timeLeft < 0) timeLeft = 0;

    // PreanÃ¡lisis inteligente (anti-silencios): unos segundos antes de terminar
    // asegura que la "siguiente" ya tenga inicio/fin/mix si faltan.
    if (timeLeft <= 12) {
        let nextRow = resolveNextOperationalRow(queuedNextRow, generalPrefs.modeLoopPlaylist);
        if (!nextRow && currentPlayingRow && document.body.contains(currentPlayingRow)) {
            nextRow = resolveNextOperationalRow(currentPlayingRow.nextElementSibling, generalPrefs.modeLoopPlaylist);
            if (!nextRow && generalPrefs.modeLoopPlaylist) nextRow = resolveNextOperationalRow(currentPlayingRow.closest('tbody').firstElementChild, false);
        }
        if (nextRow && nextRow.dataset.type !== 'time' && nextRow.dataset.type !== 'random' && !isPlaylistCommandRow(nextRow)) {
            ensurePreanalysisForTrack(nextRow.dataset.ruta);
        }
    }

    let prog = (totalElapsed / currentDuration) * 100;
    const progBar = document.getElementById('barra-progreso');
    if (progBar && !window.isDraggingProgress) progBar.style.width = `${Math.min(prog, 100)}%`;

    let displayTime = uiPrefs.showRemainingTime ? timeLeft : totalElapsed;
    let m_a = Math.floor(displayTime / 60).toString().padStart(2, '0');
    let s_a = Math.floor(displayTime % 60).toString().padStart(2, '0');
    let ms = Math.floor((displayTime % 1) * 10);

    const txtTiempo = document.getElementById('txt-tiempo');
    if (txtTiempo) {
        txtTiempo.innerText = `${m_a}:${s_a}.${ms}`;
        txtTiempo.classList.remove('time-warning-blue', 'time-warning-red', 'time-flash');
    }

    let isMusic = currentDuration >= 90;
    if (isMusic && currentPlayingRow) {
        const typeData = getTrackTypeData(currentPlayingRow.dataset.ruta);
        if (typeData && (typeData.identifier === 'comercial' || typeData.identifier === 'saytime')) { isMusic = false; }
    }

    let absTime = elapsed;
    let introTime = 0, outroTime = 0;
    if (currentPlayingRow && manualCuesDB[currentPlayingRow.dataset.ruta]) {
        const mc = manualCuesDB[currentPlayingRow.dataset.ruta];
        if (mc.intro) introTime = parseFloat(mc.intro);
        if (mc.outro) outroTime = parseFloat(mc.outro);
    }

    clearAirTimeSegmentState();
    if (progBar) { progBar.className = 'progress-bar-fill prog-normal'; }

    if (introTime > 0 && absTime < introTime) {
        let leftIntro = introTime - absTime;
        updateAirTimeSegmentState('intro', leftIntro);
        if (progBar) progBar.className = 'progress-bar-fill prog-intro';
    } else if (outroTime > 0 && absTime >= outroTime) {
        const activeSegmentEnd = currentDuration + startOffset;
        let leftOutro = activeSegmentEnd - absTime;
        updateAirTimeSegmentState('outro', leftOutro);
        if (progBar) progBar.className = 'progress-bar-fill prog-outro';
    }

    const segmentDecoratesMainClock = uiPrefs.showRemainingTime && txtTiempo && (txtTiempo.classList.contains('segment-intro') || txtTiempo.classList.contains('segment-outro'));
    if (isMusic && txtTiempo && !segmentDecoratesMainClock) {
        if (timeLeft <= 10) { txtTiempo.classList.add('time-warning-red', 'time-flash'); }
        else if (timeLeft <= 30) { txtTiempo.classList.add('time-warning-blue'); }
    }

    // FASE D · 7.4-bis ext: misma corrección que el bloque de fade-out de la
    // locución. En modo Rust `fadingPlayer.paused` siempre es true (el HTML
    // está silenciado), entonces este auto-stop nunca se disparaba y la pista
    // fantasma quedaba colgada hasta que el siguiente swap la pisara.
    if (fadingPlayer && !isPlayerClockPaused(fadingPlayer)) {
        const fadingMeta = getPlayerPlaybackMeta(fadingPlayer);
        let finFantasma = parseFiniteCueValue(fadingMeta?.playbackEndAbsolute);
        if (finFantasma === null) {
            const rutaFantasma = fileURLToPath(fadingPlayer.src);
            finFantasma = resolveTrackPlaybackWindow(rutaFantasma, {
                baseDuration: parseFiniteCueValue(fadingPlayer.duration),
                mixAbsolute: parseFiniteCueValue(fadingMeta?.mixAbsolute)
            }).effectiveEndAbsolute;
        }
        if (finFantasma !== null && getPlayerClockTime(fadingPlayer) >= finFantasma) {
            fadingPlayer.pause();
            fadingPlayer.currentTime = 0;
            clearPlayerPlaybackMeta(fadingPlayer);
            stopRustVirtualPlayback(fadingPlayer);
        }
    }

    const finActivo = parseFiniteCueValue(activePlayerMeta?.playbackEndAbsolute);

    if (finActivo !== null && getPlayerClockTime(activePlayer) >= finActivo && !crossfadeTriggered) {
        crossfadeTriggered = true;
        if (generalPrefs.modeRepeatTrack) {
            if (isRustVirtualPlayer(activePlayer)) {
                seekRustVirtualPlayback(startOffset);
                sendRustOwnerPlayActive();
            } else {
                activePlayer.currentTime = startOffset;
                activePlayer.play();
            }
            currentFiredDrops = [];
            crossfadeTriggered = false;
            recalcEndTime();
            return;
        }
        if (stopAfterCurrent) { stopAfterCurrent = false; const btn = document.getElementById('btn-stop-after'); if (btn) { btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; } stopAll(); return; }
        playNext(false);
    }

    if (currentTrackConfig) {
        const hasPlaybackMixMeta = activePlayerMeta && Object.prototype.hasOwnProperty.call(activePlayerMeta, 'mixAbsolute');
        const triggerAbsolute = hasPlaybackMixMeta
            ? parseFiniteCueValue(activePlayerMeta.mixAbsolute)
            : getResolvedRowMixAbsolute(currentPlayingRow, currentTrackConfig);

        if (triggerAbsolute !== null) {
            if (absTime >= triggerAbsolute && !crossfadeTriggered && !generalPrefs.modeRepeatTrack && !stopAfterCurrent) {
                crossfadeTriggered = true; playNext(true);
            }
        } else {
            const fallbackMixTrigger = getFallbackMixTriggerSeconds(currentTrackConfig);
            const effectiveMixTrigger = currentTrackConfig.mixTrigger > 0 ? currentTrackConfig.mixTrigger : fallbackMixTrigger;
            if (effectiveMixTrigger > 0 && timeLeft <= effectiveMixTrigger && !crossfadeTriggered && !generalPrefs.modeRepeatTrack && !stopAfterCurrent && currentDuration > 0) {
                crossfadeTriggered = true; playNext(true);
            }
        }
    }

    if (currentPlayingRow && manualCuesDB[currentPlayingRow.dataset.ruta]) {
        const mc = manualCuesDB[currentPlayingRow.dataset.ruta];

        // GUARDIA: No disparar pisadores en los primeros 0.5s de la canciÃ³n
        // para evitar que un cÃ¡lculo negativo mal ajustado por startOffset force un disparo inmediato.
        if (realElapsed >= 0.5) {
            [1, 2, 3].forEach(i => {
                if (mc[`p${i}_active`] && mc[`p${i}_time`] && mc[`p${i}_file`] && !currentFiredDrops.includes(i)) {
                    const trigger = resolveTimedOverlayTrigger({
                        markerTime: mc[`p${i}_time`],
                        mode: mc[`p${i}_mode`] || 'start',
                        startOffset
                    });
                    if (trigger) {
                        const { marker, triggerTime, adjustedMode } = trigger;
                        if (didCrossOverlayTrigger(triggerTime, realElapsed)) {
                            currentFiredDrops.push(i);
                            lastOverlayTriggerInfo = {
                                type: `p${i}`,
                                marker,
                                mode: adjustedMode,
                                triggerTime,
                                realElapsed,
                                at: Date.now()
                            };
                            playOverlayDrop(mc[`p${i}_file`]);
                            logSystem(`[INFO] Pisador ${i} disparado. Marca: ${marker}s, mode: ${adjustedMode}, startOffset: ${startOffset}s, triggerTime: ${triggerTime.toFixed(2)}s, realElapsed: ${realElapsed.toFixed(2)}s`);
                        }
                    }
                }
            });
            if (mc.phora_active && mc.phora_time && !currentFiredDrops.includes('phora')) {
                const trigger = resolveTimedOverlayTrigger({
                    markerTime: mc.phora_time,
                    mode: mc.phora_mode || 'start',
                    startOffset,
                    estimatedDuration: 5
                });
                if (trigger) {
                    const { marker, triggerTime, adjustedMode } = trigger;
                    if (didCrossOverlayTrigger(triggerTime, realElapsed)) {
                        currentFiredDrops.push('phora');
                        lastOverlayTriggerInfo = {
                            type: 'hora',
                            marker,
                            mode: adjustedMode,
                            triggerTime,
                            realElapsed,
                            at: Date.now()
                        };
                        playTimeLocution();
                        logSystem(`[INFO] Locucion Hora disparada. Marca: ${marker}s, mode: ${adjustedMode}, startOffset: ${startOffset}s, triggerTime: ${triggerTime.toFixed(2)}s, realElapsed: ${realElapsed.toFixed(2)}s`);
                    }
                }
            }
        }
    }
    rememberOverlayEval(realElapsed);

}

ipcRenderer.on('analyzer-done', (e, payload) => {
    if (!payload || !payload.filePath) return;
    const ruta = payload.filePath;
    if (!payload.success || !payload.data) return;

    if (!manualCuesDB[ruta]) manualCuesDB[ruta] = {};
    const mc = manualCuesDB[ruta];
    if (payload.data.inicio !== undefined) mc.inicio = payload.data.inicio;
    if (payload.data.fin !== undefined) mc.fin = payload.data.fin;
    if (payload.data.mix !== undefined) mc.mix = payload.data.mix;
    if (payload.data.db !== undefined) mc.db = payload.data.db;
    if (payload.data.peak_db !== undefined) mc.peak_db = payload.data.peak_db;

    // Si el archivo ya estÃ¡ en playlist, actualiza su duraciÃ³n aproximada (fin - inicio)
    // y recalcula horas una vez.
    let changed = false;
    document.querySelectorAll(`.playlist-table tr[data-ruta="${CSS.escape(ruta)}"]`).forEach(tr => {
        if (tr.dataset.type === 'time' || tr.dataset.type === 'random') return;
        const inicio = hasValidNumber(mc.inicio) ? parseFloat(mc.inicio) : 0;
        const fin = hasValidNumber(mc.fin) ? parseFloat(mc.fin) : null;
        if (fin !== null && fin > inicio) {
            const newDur = Math.round(fin - inicio);
            if (newDur > 0 && parseInt(tr.dataset.duracion) !== newDur) {
                tr.dataset.duracion = newDur;
                const m = Math.floor(newDur / 60).toString().padStart(2, '0');
                const s = (newDur % 60).toString().padStart(2, '0');
                tr.children[2].innerText = `${m}:${s}`;
                changed = true;
            }
        }
    });
    if (changed) { calcularHorasPlaylist(); updateNextTrackVisuals(); }
});

function fileURLToPath(fileUrl) { if (!fileUrl) return null; try { return url.fileURLToPath(fileUrl); } catch (e) { return null; } }

playerA.addEventListener('timeupdate', () => handleTimeUpdate(playerA));
playerB.addEventListener('timeupdate', () => handleTimeUpdate(playerB));
playerA.addEventListener('play', refreshAirIncidentStatus);
playerB.addEventListener('play', refreshAirIncidentStatus);
playerA.addEventListener('pause', refreshAirIncidentStatus);
playerB.addEventListener('pause', refreshAirIncidentStatus);

function visualTimeLoop(now = 0) {
    if (activePlayer && !isPlayerClockPaused(activePlayer) && (now - lastTimeUiRenderAt) >= TIME_UI_FRAME_INTERVAL_MS) {
        lastTimeUiRenderAt = now;
        handleTimeUpdate(activePlayer);
    }
    requestAnimationFrame(visualTimeLoop);
}
visualTimeLoop();

function handleEnded(player) {
    try {
        if (playbackFatalHalt) return;
        // Durante la locución horaria el <audio> HTML está sin src, así que
        // no emite `ended`. Si llegara algún evento residual, lo ignoramos:
        // el avance lo dispara handleTimeUpdate cuando el reloj virtual cruza
        // playbackEndAbsolute (mismo flujo que cualquier pista normal).
        if (isPlaylistTimeActive) return;
        if (player === activePlayer && !crossfadeTriggered) {
            if (generalPrefs.modeRepeatTrack) {
                if (isRustVirtualPlayer(activePlayer)) {
                    seekRustVirtualPlayback(currentStartTimeOffset);
                    sendRustOwnerPlayActive();
                } else {
                    activePlayer.currentTime = currentStartTimeOffset;
                    activePlayer.play();
                }
                currentFiredDrops = [];
                recalcEndTime();
                return;
            }
            if (stopAfterCurrent) { stopAfterCurrent = false; const btn = document.getElementById('btn-stop-after'); if (btn) { btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; } stopAll(); return; }
            if (currentPlayingRow && currentPlayingRow.dataset.temp === 'true') { currentPlayingRow.remove(); currentPlayingRow = null; calcularHorasPlaylist(); } else if (generalPrefs.modeRemovePlayed && currentPlayingRow && document.body.contains(currentPlayingRow)) { currentPlayingRow.remove(); currentPlayingRow = null; calcularHorasPlaylist(); } playNext(false);
        } else if (player !== activePlayer) { player.pause(); player.currentTime = 0; clearPlayerPlaybackMeta(player); }
    } catch (err) { }
}
playerA.addEventListener('ended', () => handleEnded(playerA));
playerB.addEventListener('ended', () => handleEnded(playerB));

const btnReloj = document.getElementById('btn-reloj');
if (btnReloj) { btnReloj.addEventListener('click', playTimeLocution); btnReloj.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); hideAllMenus(); addTimeLocutionToPlaylist(); }); }

function addTimeLocutionToPlaylist() { let targetRow = document.querySelector('.selected-row'); createPlaylistRow('time_locution', ICON_CLOCK_LABEL, 5, 'time', targetRow, 'bottom', playlistBody); }

function resolveTimeLocutionFiles(folder, now = new Date()) {
    if (!folder || !fs.existsSync(folder)) return [];
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    const filesToPlay = [];
    const allFiles = fs.readdirSync(folder);
    if (m === '00') {
        const file = allFiles.find(f => f.toUpperCase().startsWith(`HRS${h}_O`));
        if (file) filesToPlay.push(path.join(folder, file));
    } else {
        const fileH = allFiles.find(f => f.toUpperCase().startsWith(`HRS${h}`) && !f.toUpperCase().includes('_O'));
        const fileM = allFiles.find(f => f.toUpperCase().startsWith(`MIN${m}`));
        if (fileH) filesToPlay.push(path.join(folder, fileH));
        if (fileM) filesToPlay.push(path.join(folder, fileM));
    }
    return filesToPlay;
}

function playTimeLocution() {
    if (isJinglePlaying) return;
    const folder = generalPrefs.timeFolder;
    if (!folder || !fs.existsSync(folder)) return;

    if (shouldRustOwnJingleBus()) {
        // Ruta nueva: el motor Rust se encarga 100%. Electron solo entrega la
        // carpeta y espera el evento `timeLocutionEnded` (ver listener al final
        // de este archivo). No resolvemos archivos ni miramos el reloj acá.
        playTimeLocutionViaRust();
        ipcRenderer.send('update-metadata', ICON_CLOCK_LABEL);
        return;
    }

    // Fallback WebAudio (modo legacy). Aquí sí seguimos resolviendo en JS
    // porque el camino WebAudio no tiene el comando timeLocution disponible.
    const filesToPlay = resolveTimeLocutionFiles(folder);
    if (filesToPlay.length === 0) return;
    isJinglePlaying = true;
    beginProgramOverlayDucking();

    let currentIndex = 0; const playJingleSequence = () => { jingleElement.src = url.pathToFileURL(filesToPlay[currentIndex]).href; jingleElement.load(); jingleElement.oncanplay = () => { jingleElement.oncanplay = null; jingleElement.play().catch(e => { }); }; jingleElement.onended = () => { currentIndex++; if (currentIndex < filesToPlay.length) { playJingleSequence(); } else { isJinglePlaying = false; endProgramOverlayDucking(); jingleElement.onended = null; } }; }; playJingleSequence();
    ipcRenderer.send('update-metadata', ICON_CLOCK_LABEL);
}

/**
 * Botonera de hora → motor Rust. Electron deja de saber la hora, los archivos
 * y la secuenciación. Solo envía el comando `timeLocution` con la carpeta y
 * escucha el evento `timeLocutionEnded` (ver listener al final del archivo)
 * para liberar el ducking y el flag isJinglePlaying.
 */
async function playTimeLocutionViaRust() {
    const folder = generalPrefs.timeFolder;
    if (!folder || !fs.existsSync(folder)) return;
    isJinglePlaying = true;
    beginProgramOverlayDucking();
    rustTimeLocutionContext = { kind: 'button' };
    const result = await commandRustControlPlane('timeLocution', {
        folder,
        bus: 'jingle',
        gain: 1
    });
    if (!result?.ok) {
        rustTimeLocutionContext = null;
        isJinglePlaying = false;
        endProgramOverlayDucking();
        logSystem(`[RUST HORA] No se pudo reproducir locucion: ${result?.error || 'sin detalle'}`);
        return;
    }
    const durationMs = result.result?.message?.durationMs || result.result?.durationMs || 0;
    if (durationMs > 0) {
        logSystem(`${ICON_AIR_PREFIX} ${ICON_CLOCK_LABEL} (Rust, ${(durationMs/1000).toFixed(1)}s)`);
    }
}

const panelAire = document.getElementById('panel-aire');
if (panelAire) {
    window.isDraggingProgress = false;
    let seekStartPercentage = 0;
    let seekDragButton = 0;

    function cancelSeekDrag() {
        window.isDraggingProgress = false;
        seekDragButton = 0;
        document.removeEventListener('mousemove', onSeekDragMove);
        document.removeEventListener('mouseup', onSeekDragUp);
        document.removeEventListener('keydown', onSeekDragKey);
        if (activePlayer && currentDuration > 0) {
            handleTimeUpdate(activePlayer);
        }
    }

    function onSeekDragMove(e) {
        if (!window.isDraggingProgress) return;
        const rect = panelAire.getBoundingClientRect();

        if (e.clientY < rect.top - 60 || e.clientY > rect.bottom + 60) {
            cancelSeekDrag();
            return;
        }

        let clickX = e.clientX - rect.left;
        let currentPercentage = clickX / rect.width;
        currentPercentage = Math.max(0, Math.min(1, currentPercentage));

        const progBar = document.getElementById('barra-progreso');
        if (progBar) progBar.style.width = `${currentPercentage * 100}%`;
    }

    function commitActiveSeek(targetTimeSeconds) {
        const safeTargetSeconds = Math.max(0, Number(targetTimeSeconds) || 0);
        const positionMs = Math.max(0, Math.round(safeTargetSeconds * 1000));

        // Migración a Rust como única fuente de verdad para el seek. Ya NO
        // tocamos `activePlayer.currentTime` (el <audio> HTML está silenciado
        // en modo rustAudio, su currentTime no produce ningún cambio audible).
        // Actualizamos el reloj virtual local para que la UI no parpadee
        // esperando al próximo status, pero el motor Rust es quien manda.
        if (isRustVirtualPlayer(activePlayer)) {
            seekRustVirtualPlayback(safeTargetSeconds);
        } else if (!isRustExclusiveAudioMode()) {
            // Solo en el fallback WebAudio puro (modo legacy) seteamos el
            // <audio> HTML — ahí el HTML SÍ es la fuente de audio.
            try { activePlayer.currentTime = safeTargetSeconds; } catch (err) {}
        }

        const playerId = getPlaylistPlayerId(activePlayer);
        if (playerId && isRustPlaylistOwnerEnabled()) {
            const auxPlayerId = getRustPlaylistAuxPlayerId(playerId, currentPlayingRow);
            commandRustPlaylist('seek', {
                player: playerId,
                positionMs
            }).catch(() => { });
            if (auxPlayerId) {
                commandRustControlPlane('seek', {
                    player: auxPlayerId,
                    positionMs
                }).catch(() => { });
            }
            const previous = rustPlaylistMirrorState.get(playerId) || {};
            rustPlaylistMirrorState.set(playerId, {
                ...previous,
                seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
            });
            if (auxPlayerId) {
                const previousAux = rustPlaylistMirrorState.get(auxPlayerId) || {};
                rustPlaylistMirrorState.set(auxPlayerId, {
                    ...previousAux,
                    seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
                });
            }
        }
        handleTimeUpdate(activePlayer);
        publishRustTransport({ force: true, syncPosition: false });
    }

    function onSeekDragUp(e) {
        if (!window.isDraggingProgress) return;
        if (e.button !== seekDragButton) return;

        const rect = panelAire.getBoundingClientRect();
        let clickX = e.clientX - rect.left;
        let finalPercentage = clickX / rect.width;
        finalPercentage = Math.max(0, Math.min(1, finalPercentage));

        const diff = Math.abs(finalPercentage - seekStartPercentage);
        let targetPercentage = finalPercentage;

        if (diff < 0.01) {
            targetPercentage = seekStartPercentage;
        }

        commitActiveSeek(currentStartTimeOffset + (currentDuration * targetPercentage));
        window.isDraggingProgress = false;
        seekDragButton = 0;
        if (typeof recalcEndTime === 'function') recalcEndTime();

        document.removeEventListener('mousemove', onSeekDragMove);
        document.removeEventListener('mouseup', onSeekDragUp);
        document.removeEventListener('keydown', onSeekDragKey);
    }

    function onSeekDragKey(e) {
        if (e.key === 'Escape' && window.isDraggingProgress) {
            cancelSeekDrag();
        }
    }

    panelAire.addEventListener('mousedown', (e) => {
        // El adelanto/atraso por arrastre se dispara EXCLUSIVAMENTE con clic
        // derecho (button 2). El clic izquierdo no inicia drag — queda libre
        // para otros usos (selección, menú de contexto del navegador, etc.).
        if (e.button !== 2) return;
        e.preventDefault();
        if (typeof isPlaylistTimeActive !== 'undefined' && isPlaylistTimeActive) return;
        if (!currentPlayingRow && isPlayerClockPaused(activePlayer) && getPlayerClockTime(activePlayer) === 0) return;
        if (currentDuration <= 0) return;

        const rect = panelAire.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        seekStartPercentage = Math.max(0, Math.min(1, clickX / rect.width));

        window.isDraggingProgress = true;
        seekDragButton = e.button;

        const progBar = document.getElementById('barra-progreso');
        if (progBar) progBar.style.width = `${seekStartPercentage * 100}%`;

        document.addEventListener('mousemove', onSeekDragMove);
        document.addEventListener('mouseup', onSeekDragUp);
        document.addEventListener('keydown', onSeekDragKey);
    });

    // Suprimir el menú nativo del navegador sobre el panel de aire: el clic
    // derecho aquí se reserva para el arrastre de seek.
    panelAire.addEventListener('contextmenu', (e) => { e.preventDefault(); });
}

function updateClock() {
    const now = new Date();
    const ct = document.getElementById('clock-time');
    const cd = document.getElementById('clock-date');
    if (ct) ct.innerText = now.toLocaleTimeString('es-PE', { hour12: false });
    if (cd) cd.innerText = now.toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
}
setInterval(updateClock, 1000);
updateClock();

// --- Weather Update Logic ---
window.currentWeather = { temp: null, hum: null, lastUpdate: 0, unitSym: '' };

async function fetchWeatherBackground() {
    if (!generalPrefs.weatherCity) return;
    try {
        const city = generalPrefs.weatherCity.trim();
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`);
        const geoData = await geoRes.json();

        if (geoData.results && geoData.results.length > 0) {
            const { latitude, longitude } = geoData.results[0];
            const unitStr = generalPrefs.weatherUnit === 'imperial' ? 'fahrenheit' : 'celsius';
            const unitSym = generalPrefs.weatherUnit === 'imperial' ? '°F' : '°C';

            const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m&temperature_unit=${unitStr}`);
            const wData = await wRes.json();

            if (wData.current) {
                window.currentWeather = {
                    temp: wData.current.temperature_2m,
                    hum: wData.current.relative_humidity_2m,
                    lastUpdate: Date.now(),
                    unitSym: unitSym
                };
                try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'config', 'weather.json'), JSON.stringify(window.currentWeather)); } catch (err) { }

                const tempW = document.getElementById('temp-widget');
                const humW = document.getElementById('hum-widget');
                if (tempW) tempW.innerText = `🌡️ ${window.currentWeather.temp} ${unitSym}`;
                if (humW) humW.innerText = `💧 ${window.currentWeather.hum} %`;
            }
        }
    } catch (e) {
        console.error('Failed to fetch weather in background:', e);
    }
}

// Check weather every 20 minutes (1200000 ms)
setInterval(() => {
    if (Date.now() - window.currentWeather.lastUpdate > 1200000) {
        fetchWeatherBackground();
    }
}, 60000);

// Initial fetch attempt after a small delay to ensure prefs are loaded
setTimeout(() => {
    fetchWeatherBackground();
}, 2000);

// Also listen for settings updates to refetch immediately if city changes
ipcRenderer.on('update-general-prefs', () => {
    setTimeout(fetchWeatherBackground, 1000);
});


function ampToPercent(amp) { if (amp <= 0.0001) return 0; let db = 20 * Math.log10(amp); if (db < -36) return 0; if (db > 3) return 100; return ((db + 36) / 39) * 100; }
function ampToDb(amp) { if (!(amp > 0.0000001)) return Number.NEGATIVE_INFINITY; return 20 * Math.log10(amp); }
const analyserBufferCache = new WeakMap();
function getPeak(analyser) {
    let dataArray = analyserBufferCache.get(analyser);
    if (!dataArray || dataArray.length !== analyser.fftSize) {
        dataArray = new Float32Array(analyser.fftSize);
        analyserBufferCache.set(analyser, dataArray);
    }
    analyser.getFloatTimeDomainData(dataArray);
    let max = 0;
    for (let i = 0; i < dataArray.length; i++) {
        if (Math.abs(dataArray[i]) > max) max = Math.abs(dataArray[i]);
    }
    return max;
}

function readStereoPeaks(meterPair) {
    const left = getPeak(meterPair.left);
    const right = getPeak(meterPair.right);
    return {
        left,
        right,
        max: Math.max(left, right)
    };
}

function readRustStereoMetersByBus() {
    const meters = Array.isArray(rustAudioProbeStatus.lastStatus?.meters)
        ? rustAudioProbeStatus.lastStatus.meters
        : [];
    const byBus = new Map();
    meters.forEach(meter => {
        const bus = String(meter?.bus || '').toLowerCase();
        if (!bus) return;
        const rawLeft = Math.max(0, Math.min(100, Number(meter.left) || 0));
        const rawRight = Math.max(0, Math.min(100, Number(meter.right) || 0));
        const visualLeft = ampToPercent(rawLeft / 100);
        const visualRight = ampToPercent(rawRight / 100);
        const previous = byBus.get(bus) || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY };
        const max = Math.max(visualLeft, visualRight);
        byBus.set(bus, {
            left: Math.max(previous.left, visualLeft),
            right: Math.max(previous.right, visualRight),
            max: Math.max(previous.max, max),
            db: Math.max(previous.db, Number.isFinite(Number(meter.db)) ? Number(meter.db) : ampToDb(Math.max(rawLeft, rawRight) / 100))
        });
    });
    return byBus;
}

function mergeRustStereoLevels(levels = []) {
    let left = 0;
    let right = 0;
    let max = 0;
    let db = Number.NEGATIVE_INFINITY;
    levels.forEach(level => {
        if (!level) return;
        left = Math.max(left, Number(level.left) || 0);
        right = Math.max(right, Number(level.right) || 0);
        max = Math.max(max, Number(level.max) || 0);
        db = Math.max(db, Number.isFinite(Number(level.db)) ? Number(level.db) : Number.NEGATIVE_INFINITY);
    });
    max = Math.max(max, left, right);
    return max > 0 ? { left, right, max, db } : null;
}

function readRustProgramStereoPercent() {
    // FIX BUG (UI principal no refleja la consola virtual):
    // El motor Rust ahora emite un meter explícito `id="master"` post-fader
    // (MeteredSource entre el FaderSource Master y el sink físico). Ese meter
    // YA contiene la mezcla completa de program + DSP + master fader — es
    // exactamente lo que sale al sink. Si está disponible, lo usamos SOLO
    // sin sumar otros buses (evita doble conteo y alinea el meter del UI
    // principal con el MASTER de la consola virtual al sample).
    //
    // Fallback: si por algún motivo el meter master no llega (motor sin
    // sub-mixer, falla de routing), reconstruimos manualmente sumando los
    // buses pre-fader como antes — mejor que mostrar 0 dB en el aire.
    if (!shouldMirrorRustControlPlane()) return null;
    const byBus = readRustStereoMetersByBus();
    const explicitMaster = byBus.get('master');
    if (explicitMaster) {
        return explicitMaster; // ← UN solo punto de verdad: post-fader.
    }
    // Camino fallback (sin meter master): suma manual de buses de programa.
    const playlistProgram = mergeRustStereoLevels(['pl1', 'pl2', 'pl3', 'pl4'].map(bus => byBus.get(bus)));
    const pisadores = mergeRustStereoLevels(['jingle', 'cartwall'].map(bus => byBus.get(bus)));
    const playlistMode = generalPrefs.playlistOutputMode || 'disabled';
    if (playlistMode === 'independent') {
        return mergeRustStereoLevels([pisadores]);
    }
    return mergeRustStereoLevels([playlistProgram, pisadores]);
}

function readRustPlaylistStereoPercents() {
    if (!isRustPlaylistOwnerActive()) return [];
    const byBus = readRustStereoMetersByBus();
    return ['pl1', 'pl2', 'pl3', 'pl4'].map(bus => byBus.get(bus) || null);
}

function readRustBusStereoPercent(bus = '') {
    if (!shouldMirrorRustControlPlane()) return null;
    const byBus = readRustStereoMetersByBus();
    return byBus.get(String(bus || '').toLowerCase()) || null;
}

function percentToDb(percent) {
    return ampToDb(Math.max(0, Math.min(100, Number(percent) || 0)) / 100);
}

let lastVuAnimationFrameAt = 0;

function animateVUMeters(scheduleNextFrame = true) {
    lastVuAnimationFrameAt = performance.now();
    const rustProgramStereo = readRustProgramStereoPercent();
    if (!rustProgramStereo && ((isPlayerClockPaused(activePlayer) && jingleElement.paused && (!fadingPlayer || isPlayerClockPaused(fadingPlayer))) || (activePlayer.ended && jingleElement.ended))) {
        lastLeftPeak = Math.max(0, lastLeftPeak - 2);
        lastRightPeak = Math.max(0, lastRightPeak - 2);
    } else {
        const leftPeak = getPeak(analyserL);
        const rightPeak = getPeak(analyserR);
        const currentLPercent = Math.max(ampToPercent(leftPeak), rustProgramStereo?.left || 0);
        const currentRPercent = Math.max(ampToPercent(rightPeak), rustProgramStereo?.right || 0);
        lastLeftPeak = currentLPercent >= lastLeftPeak ? currentLPercent : Math.max(0, lastLeftPeak - 1.5);
        lastRightPeak = currentRPercent >= lastRightPeak ? currentRPercent : Math.max(0, lastRightPeak - 1.5);
    }
    const vul = document.getElementById('vu-l-cover'); const vur = document.getElementById('vu-r-cover'); if (vul) vul.style.width = `${100 - lastLeftPeak}%`; if (vur) vur.style.width = `${100 - lastRightPeak}%`;

    const pgmStereo = readStereoPeaks(pgmStereoMeter);
    const cueStereo = readStereoPeaks(cueStereoMeter);
    const monitorStereo = readStereoPeaks(monitorStereoMeter);
    const jingleStereo = readStereoPeaks(jingleStereoMeter);
    const cartwallStereo = readStereoPeaks(cartwallStereoMeter);
    const playlistStereo = playlistStereoMeters.map(readStereoPeaks);
    const rustPlaylistStereo = readRustPlaylistStereoPercents();
    const rustJingleStereo = readRustBusStereoPercent('jingle');
    const rustCartwallStereo = readRustBusStereoPercent('cartwall');
    const pgmLeftPercent = Math.max(ampToPercent(pgmStereo.left), rustProgramStereo?.left || 0);
    const pgmRightPercent = Math.max(ampToPercent(pgmStereo.right), rustProgramStereo?.right || 0);
    const pgmPercent = Math.max(ampToPercent(pgmStereo.max), rustProgramStereo?.max || 0);
    const pgmDb = rustProgramStereo ? Math.max(ampToDb(pgmStereo.max), rustProgramStereo.db) : ampToDb(pgmStereo.max);
    lastProgramPeakPercent = pgmPercent;

    const now = performance.now();
    if ((now - lastVuIpcSentAt) >= VU_IPC_INTERVAL_MS) {
        lastVuIpcSentAt = now;
        const includeDiagnostics = (now - lastVuDiagnosticsIpcSentAt) >= VU_DIAGNOSTICS_IPC_INTERVAL_MS;
        if (includeDiagnostics) lastVuDiagnosticsIpcSentAt = now;
        const playlistLevels = playlistStereo.map((peak, idx) => Math.max(ampToPercent(peak.max), rustPlaylistStereo[idx]?.max || 0));
        const rustMeters = Array.isArray(rustAudioProbeStatus.lastStatus?.meters)
            ? rustAudioProbeStatus.lastStatus.meters
            : [];
        const vuPayload = {
            pgm: pgmPercent,
            cue: ampToPercent(cueStereo.max),
            monitor: ampToPercent(monitorStereo.max),
            jingle: Math.max(ampToPercent(jingleStereo.max), rustJingleStereo?.max || 0),
            cartwall: Math.max(ampToPercent(cartwallStereo.max), rustCartwallStereo?.max || 0),
            playlists: playlistLevels,
            rustMeters,
            rustMetersUpdatedAt: rustMeters.length ? (rustAudioProbeStatus.lastStatus?.updatedAt || Date.now()) : 0,
            stereo: {
                pgm: { left: pgmLeftPercent, right: pgmRightPercent },
                cue: { left: ampToPercent(cueStereo.left), right: ampToPercent(cueStereo.right) },
                monitor: { left: ampToPercent(monitorStereo.left), right: ampToPercent(monitorStereo.right) },
                jingle: {
                    left: Math.max(ampToPercent(jingleStereo.left), rustJingleStereo?.left || 0),
                    right: Math.max(ampToPercent(jingleStereo.right), rustJingleStereo?.right || 0)
                },
                cartwall: {
                    left: Math.max(ampToPercent(cartwallStereo.left), rustCartwallStereo?.left || 0),
                    right: Math.max(ampToPercent(cartwallStereo.right), rustCartwallStereo?.right || 0)
                },
                playlists: playlistStereo.map((peak, idx) => ({
                    left: Math.max(ampToPercent(peak.left), rustPlaylistStereo[idx]?.left || 0),
                    right: Math.max(ampToPercent(peak.right), rustPlaylistStereo[idx]?.right || 0)
                }))
            },
            dbs: {
                pgm: pgmDb,
                cue: ampToDb(cueStereo.max),
                monitor: ampToDb(monitorStereo.max),
                jingle: Math.max(ampToDb(jingleStereo.max), rustJingleStereo?.db ?? Number.NEGATIVE_INFINITY),
                cartwall: Math.max(ampToDb(cartwallStereo.max), rustCartwallStereo?.db ?? Number.NEGATIVE_INFINITY),
                playlists: playlistStereo.map((peak, idx) => Math.max(ampToDb(peak.max), rustPlaylistStereo[idx]?.db ?? Number.NEGATIVE_INFINITY))
            },
            stereoDbs: {
                pgm: { left: percentToDb(pgmLeftPercent), right: percentToDb(pgmRightPercent) },
                cue: { left: ampToDb(cueStereo.left), right: ampToDb(cueStereo.right) },
                monitor: { left: ampToDb(monitorStereo.left), right: ampToDb(monitorStereo.right) },
                jingle: {
                    left: Math.max(ampToDb(jingleStereo.left), percentToDb(rustJingleStereo?.left || 0)),
                    right: Math.max(ampToDb(jingleStereo.right), percentToDb(rustJingleStereo?.right || 0))
                },
                cartwall: {
                    left: Math.max(ampToDb(cartwallStereo.left), percentToDb(rustCartwallStereo?.left || 0)),
                    right: Math.max(ampToDb(cartwallStereo.right), percentToDb(rustCartwallStereo?.right || 0))
                },
                playlists: playlistStereo.map((peak, idx) => ({
                    left: Math.max(ampToDb(peak.left), percentToDb(rustPlaylistStereo[idx]?.left || 0)),
                    right: Math.max(ampToDb(peak.right), percentToDb(rustPlaylistStereo[idx]?.right || 0))
                }))
            }
        };
        if (includeDiagnostics) vuPayload.diagnostics = audioEngineClient.getDiagnostics();
        ipcRenderer.send('vu-levels', vuPayload);
    }

    if (scheduleNextFrame) requestAnimationFrame(animateVUMeters);
}
requestAnimationFrame(animateVUMeters);
setInterval(() => {
    if (performance.now() - lastVuAnimationFrameAt > 300) animateVUMeters(false);
}, 250);

function drawMainMarkers(filePath, duration, startOffset) {
    const container = document.getElementById('panel-aire'); if (!container) return; container.querySelectorAll('.main-marker, .main-marker-lbl').forEach(e => e.remove()); if (!manualCuesDB[filePath]) return; const mc = manualCuesDB[filePath];
    const markers = [{ active: mc.p1_active, time: mc.p1_time, lbl: 'P1', color: '#9b59b6' }, { active: mc.p2_active, time: mc.p2_time, lbl: 'P2', color: '#9b59b6' }, { active: mc.p3_active, time: mc.p3_time, lbl: 'P3', color: '#9b59b6' }, { active: mc.phora_active, time: mc.phora_time, lbl: 'HORA', color: '#2ecc71' }, { active: (mc.mix !== undefined && mc.mix !== ''), time: mc.mix, lbl: 'MIX', color: '#00a8ff' }];
    const waveCanvas = document.getElementById('waveform-canvas'); if (!waveCanvas) return; const w = waveCanvas.offsetWidth; let endT = mc.fin ? parseFloat(mc.fin) : duration; let realDuration = endT - startOffset; if (realDuration <= 0) realDuration = duration;
    markers.forEach(m => { if (m.active && m.time !== undefined && m.time !== '') { let t = parseFloat(m.time) - startOffset; if (t >= 0 && t <= realDuration) { let px = (t / realDuration) * w; const line = document.createElement('div'); line.className = 'main-marker'; line.style.cssText = `position: absolute; top: 0; height: calc(100% - 44px); width: 1px; border-left: 2px dashed ${m.color}; z-index: 5; pointer-events: none; left: ${px}px;`; const lbl = document.createElement('div'); lbl.className = 'main-marker-lbl'; lbl.style.cssText = `position: absolute; top: 5px; font-size: 10px; font-family: Consolas; font-weight: bold; background: ${m.color}; color: #000; padding: 1px 4px; border-radius: 2px; z-index: 5; pointer-events: none; left: ${px + 3}px;`; lbl.innerText = m.lbl; container.appendChild(line); container.appendChild(lbl); } } });
}

async function drawWaveform(filePath) {
    const renderToken = ++waveformRenderToken;
    try {
        if (!waveformDecodeCtx || !filePath) return;
        let peaks = waveformPeaksByPath.get(filePath);
        if (!peaks) {
            const result = await ipcRenderer.invoke('audio-build-waveform-peaks', filePath);
            peaks = normalizeMainWaveformPeaks(result?.peaks);
            if (!peaks) {
                const fileBuffer = await fs.promises.readFile(filePath);
                const audioBuffer = await waveformDecodeCtx.decodeAudioData(nodeBufferToArrayBuffer(fileBuffer));
                peaks = buildMainWaveformPeaks(audioBuffer);
            }
            waveformPeaksByPath.set(filePath, peaks);
            if (waveformPeaksByPath.size > 12) {
                const oldestKey = waveformPeaksByPath.keys().next().value;
                waveformPeaksByPath.delete(oldestKey);
            }
        }
        if (renderToken !== waveformRenderToken) return;

        const canvas = document.getElementById('waveform-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let manualInicio = 0;
        let manualFin = peaks.duration;
        let introTime = 0;
        let outroTime = 0;
        if (manualCuesDB[filePath]) {
            const mc = manualCuesDB[filePath];
            if (mc.inicio) manualInicio = parseFloat(mc.inicio);
            if (mc.fin) manualFin = parseFloat(mc.fin);
            if (mc.intro) introTime = parseFloat(mc.intro);
            if (mc.outro) outroTime = parseFloat(mc.outro);
        }

        if (!Number.isFinite(manualInicio) || manualInicio < 0) manualInicio = 0;
        if (!Number.isFinite(manualFin) || manualFin <= manualInicio) manualFin = peaks.duration;

        const visibleDuration = Math.max(0.05, manualFin - manualInicio);
        const startBin = Math.max(0, Math.floor((manualInicio / peaks.duration) * peaks.bins));
        const endBin = Math.min(peaks.bins, Math.ceil((manualFin / peaks.duration) * peaks.bins));
        const binLen = Math.max(1, endBin - startBin);
        const binsPerPixel = binLen / Math.max(1, canvas.width);
        const amp = canvas.height / 2;
        const introPx = introTime > manualInicio ? ((introTime - manualInicio) / visibleDuration) * canvas.width : -1;
        const outroPx = outroTime > manualInicio ? ((outroTime - manualInicio) / visibleDuration) * canvas.width : canvas.width + 1;

        for (let i = 0; i < canvas.width; i++) {
            if (i < introPx && introPx > 0) ctx.fillStyle = '#f1c40f';
            else if (i >= outroPx && outroTime > 0) ctx.fillStyle = '#e74c3c';
            else ctx.fillStyle = '#55555c';

            let min = 1.0;
            let max = -1.0;
            const pxStartBin = startBin + Math.floor(i * binsPerPixel);
            const pxEndBin = Math.max(pxStartBin + 1, startBin + Math.ceil((i + 1) * binsPerPixel));
            for (let j = pxStartBin; j < pxEndBin && j < endBin; j++) {
                const binMin = peaks.min[j];
                const binMax = peaks.max[j];
                if (binMin < min) min = binMin;
                if (binMax > max) max = binMax;
            }
            ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
        }
        drawMainMarkers(filePath, peaks.duration, manualInicio);
    } catch (e) { }
}

function scheduleAirWaveform(filePath, sessionId) {
    if (!filePath) return;
    setTimeout(() => {
        if (sessionId !== playRowSessionId) return;
        drawWaveform(filePath);
    }, 250);
}

async function playRow(tr, isAutoMix = false, forcedFadeOutSeconds = 0, options = {}) {
    if (!tr) {
        playNext(isAutoMix, forcedFadeOutSeconds);
        return;
    }
    playRowSessionId++;
    const currentSessionId = playRowSessionId;
    const previousPlayingRow = currentPlayingRow;

    // Limpieza de pista anterior (crucial para canciones temporales y saltos a comandos)
    if (previousPlayingRow && previousPlayingRow !== tr) {
        if (previousPlayingRow.dataset.temp === 'true' || (generalPrefs.modeRemovePlayed && document.body.contains(previousPlayingRow))) {
            previousPlayingRow.remove();
            calcularHorasPlaylist();
        } else if (document.body.contains(previousPlayingRow)) {
            previousPlayingRow.classList.remove('row-active');
        }
        currentPlayingRow = null;
    }

    if (isPlaylistNoteRow(tr)) {
        playNext(isAutoMix, forcedFadeOutSeconds);
        return;
    }
    if (isPlaylistStopRow(tr)) {
        executeStopCommandRow(tr);
        return;
    }
    if (isPlaylistJumpRow(tr)) {
        executePlaylistJumpCommandRow(tr, isAutoMix, forcedFadeOutSeconds);
        return;
    }
    if (isPlaylistExecuteEventRow(tr)) {
        executeEventCommandRow(tr);
        return;
    }
    const outgoingTrackConfig = currentTrackConfig;
    const forceFollowView = options.forceFollowView === true || tr.dataset.forceFollowView === 'true';
    delete tr.dataset.forceFollowView;
    const keepPlaybackVisible = forceFollowView || isPlaylistRowInAutoFollowZone(previousPlayingRow || tr);

    try {
        isTrackReady = false; crossfadeTriggered = false;
        currentPlaybackStartCause = options.startCause || (isAutoMix ? 'auto-mix' : forcedFadeOutSeconds > 0 ? 'forced-transition' : 'normal');

        fadingPlayer = activePlayer;
        fadingGain = activeGain;
        activePlayer = (activePlayer === playerA) ? playerB : playerA;
        activeGain = (activeGain === gainA) ? gainB : gainA;
        cancelPendingPlayerStop(fadingPlayer);
        cancelPendingPlayerStop(activePlayer);
        assignPlayerToPlaylistBus(activePlayer, getPlaylistIndexFromRow(tr));
        assignPlayerToPlaylistBus(fadingPlayer, getPlaylistIndexFromRow(previousPlayingRow || tr));
        clearPlayerPlaybackMeta(activePlayer);

        activeGain.gain.cancelScheduledValues(audioCtx.currentTime);

        const batchIdToKeep = tr.dataset.batchId || null;
        const originalIdx = parseInt(tr.dataset.originalTbodyIndex, 10);
        const eventClearBody = (Number.isInteger(originalIdx) && tbodys[originalIdx]) ? tbodys[originalIdx] : tr.closest('tbody');
        if (tr.dataset.clearOnExecution === 'true' && batchIdToKeep) { clearPlaylistBodyForEventBatch(eventClearBody, batchIdToKeep); getBatchRowsInPlaylistBody(eventClearBody, batchIdToKeep).forEach(row => { delete row.dataset.clearOnExecution; delete row.dataset.queuedAt; delete row.dataset.originalTbodyIndex; }); calcularHorasPlaylist(); updateNextTrackVisuals(); }
        if (!isAutoMix && stopAfterCurrent) { stopAfterCurrent = false; applyStopAfterVisualState(); }
        if (typeof window.disableRepeatMode === 'function') window.disableRepeatMode();
        // FASE D · sub-paso 12.1: en modo rustAudio el audioCtx no procesa
        // audio — todo lo hace el motor Rust. Solo lo resumimos en modo
        // webAudio para no despertar nodos inútilmente.
        if (audioCtx.state === 'suspended' && !isRustExclusiveAudioMode()) audioCtx.resume();
        playbackHoldByUser = false;

        const txtTiempo = document.getElementById('txt-tiempo'); if (txtTiempo) txtTiempo.classList.remove('time-warning-blue', 'time-warning-red', 'time-flash');
        clearAirTimeSegmentState();
        const progBar = document.getElementById('barra-progreso'); if (progBar) progBar.className = 'progress-bar-fill prog-normal';



        currentPlayingRow = tr; currentPlayingRow.classList.add('row-active'); queuedNextRow = resolveNextOperationalRow(currentPlayingRow.nextElementSibling, generalPrefs.modeLoopPlaylist);
        const eventQueueKey = tr.dataset.eventQueueKey;
        if (eventQueueKey && eventRuntimeQueue.has(eventQueueKey)) {
            const entry = eventRuntimeQueue.get(eventQueueKey);
            if (entry.status !== 'fired') setEventQueueStatus(entry, 'fired', 'AL AIRE', 'Disparado a emision');
            renderEventTimeline(true);
        }

        pgmTab = tbodys.indexOf(tr.closest('tbody'));
        updateTabsUI();
        ensurePlaybackRowsVisible({
            forcePgmView: forceFollowView,
            centerCurrent: true,
            onlyIfAnchorVisible: true,
            visibleAnchorRow: previousPlayingRow || tr,
            anchorWasVisible: keepPlaybackVisible
        });
        saveSessionSnapshot();
        resetPlaybackGuard();

        const type = tr.dataset.type || 'normal'; isPlaylistTimeActive = false;
        // Si quedaba alguna locución horaria activa de la fila previa, se la
        // detenemos al motor Rust antes de pisar el contexto. El motor responde
        // al `stop` invalidando su contador de generación → el timer interno
        // no emitirá un `timeLocutionEnded` rezagado.
        if (rustTimeLocutionContext) {
            commandRustControlPlane('stop', { player: 'time-locucion' }).catch(() => {});
            rustTimeLocutionContext = null;
        }
        currentStartTimeOffset = 0; currentFiredDrops = []; lastOverlayEvalSessionId = currentSessionId; lastOverlayEvalElapsed = 0; let manualFin = null;
        const savedResumeStart = parseFloat(tr.dataset.resumeStart || '');
        const resumeStart = type === 'normal' && Number.isFinite(savedResumeStart) && savedResumeStart > 0.25 ? savedResumeStart : null;
        delete tr.dataset.resumeStart;

        if (type === 'time') {
            // Locución horaria delegada 100% al motor Rust. Electron solo:
            //   1) Aplica el fade-out del programa saliente (control de transición).
            //   2) Envía un único comando `timeLocution` con la carpeta.
            //   3) Pinta el reloj UI usando trackStartTime + durationMs que
            //      devuelve el motor.
            //   4) Escucha `timeLocutionEnded` (listener IPC al final del
            //      archivo) para avanzar la playlist.
            const folder = generalPrefs.timeFolder;
            if (!folder || !fs.existsSync(folder)) { 
                logSystem(`[SKIP] La carpeta de Hora no existe. Saltando...`);
                setTimeout(() => playNext(false), 500);
                return; 
            }

            currentTrackConfig = getCrossfadeConfig(getTrackTypeData('dummy.saytime'), null);
            setPlayerPlaybackMeta(activePlayer, {
                row: tr,
                filePath: null,
                mixAbsolute: null,
                playbackEndAbsolute: null,
                naturalEndAbsolute: null,
                startOffset: 0
            });

            // Fade-out de la canción saliente al disparar la locución horaria.
            // BUG FIX FASE D 7.4-bis: la guarda original `!fadingPlayer.paused`
            // siempre era false en modo Rust (el HTML está pausado por diseño),
            // por eso la canción de fondo se quedaba a volumen completo durante
            // toda la locución. Ahora usamos `isPlayerClockPaused` que sí detecta
            // el reloj virtual Rust. La lógica interna del bloque ya respeta
            // el setting de fade-out: `fadeoutNext = 0` → corte abrupto al
            // iniciar la voz; `fadeoutNext > 0` → rampa de esa duración.
            if (fadingPlayer && !isPlayerClockPaused(fadingPlayer)) {
                const currentVol = fadingGain.gain.value; fadingGain.gain.cancelScheduledValues(audioCtx.currentTime); fadingGain.gain.setValueAtTime(currentVol, audioCtx.currentTime);
                const fadePlan = getFadeOutPlanForTransition(fadingPlayer, outgoingTrackConfig, isAutoMix, forcedFadeOutSeconds);
                if (fadePlan.seconds > 0) {
                    fadingGain.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + fadePlan.seconds);
                }
                if (fadePlan.scheduleStop) schedulePlayerStop(fadingPlayer, (fadePlan.stopDelaySeconds || fadePlan.seconds) * 1000);
                // En modo rustAudio el gain HTML está silenciado: hay que aplicar
                // la misma rampa al player Rust real para que el fade se oiga.
                if (isRustPlaylistOwnerEnabled()) {
                    const previousPlayerId = getPlaylistPlayerId(fadingPlayer);
                    const previousAuxPlayerId = previousPlayerId && previousPlayingRow
                        ? getRustPlaylistAuxPlayerId(previousPlayerId, previousPlayingRow)
                        : '';
                    const applyRustFade = (playerId) => {
                        if (!playerId) return;
                        const mirrorState = rustPlaylistMirrorState.get(playerId) || {};
                        const fromGain = Number.isFinite(Number(mirrorState.gain)) ? Number(mirrorState.gain) : 1;
                        cancelRustPlaylistGainRamp(playerId);
                        if (fadePlan.seconds > 0) {
                            const stopWithRamp = fadePlan.scheduleStop
                                && (fadePlan.stopDelaySeconds || fadePlan.seconds) <= fadePlan.seconds + 0.05;
                            scheduleRustPlaylistGainRamp(playerId, fromGain, 0.0001, fadePlan.seconds, { stopAfter: stopWithRamp });
                            if (fadePlan.scheduleStop && !stopWithRamp) {
                                scheduleRustPlaylistStop(playerId, fadePlan.stopDelaySeconds || fadePlan.seconds);
                            }
                        } else if (fadePlan.scheduleStop && fadePlan.holdTail) {
                            scheduleRustPlaylistStop(playerId, fadePlan.stopDelaySeconds);
                        } else {
                            commandRustPlaylist('setGain', { player: playerId, gain: 0 }).catch(() => { });
                            commandRustPlaylist('stop', { player: playerId }).catch(() => { });
                            rustPlaylistMirrorState.delete(playerId);
                        }
                    };
                    applyRustFade(previousPlayerId);
                    applyRustFade(previousAuxPlayerId);
                }
            }

            // Display inicial — la duración real llega en el ack del motor.
            currentDuration = 5;
            trackStartTime = new Date();
            document.getElementById('txt-cancion').innerText = ICON_CLOCK_LABEL;
            document.getElementById('txt-cancion').style.color = '#ffffff';
            document.getElementById('txt-acaba').innerText = '';
            drawWaveform(null);

            // La locución desde la playlist va por el MISMO bus y player que
            // una pista normal del programa (pl1-pl4 + player-a/player-b), no
            // por el bus 'jingle'/'time-locucion' de la botonera. Así el master,
            // los VU, la detección de "En aire" y la transición a la siguiente
            // pista funcionan igual que con cualquier otro audio del programa.
            const timePlaylistPlayerId = getPlaylistPlayerId(activePlayer); // 'player-a' o 'player-b'
            const timePlaylistBus = getRustPlaylistPrimaryBus(tr);            // 'pl1'..'pl4'

            // currentTrackConfig YA viene de getCrossfadeConfig(saytime) — respeta
            // los ajustes generales del tipo "saytime" (fade-out, mix-trigger, amp).
            // No anulamos nada: handleTimeUpdate y la transición a la siguiente
            // pista usan esos mismos valores igual que con cualquier pista normal.

            isPlaylistTimeActive = true;
            rustTimeLocutionContext = {
                kind: 'playlist',
                row: tr,
                sessionId: playRowSessionId,
                playerId: timePlaylistPlayerId
            };

            // Pausar el <audio> HTML — el motor Rust toca, este solo lleva
            // el id virtual y los flags de transporte.
            try { activePlayer.pause(); activePlayer.currentTime = 0; activePlayer.removeAttribute('src'); activePlayer.load(); } catch (err) {}

            const result = await commandRustControlPlane('timeLocution', {
                player: timePlaylistPlayerId,
                bus: timePlaylistBus,
                folder,
                gain: dbToLinear(currentTrackConfig.ampDb)
            });
            if (currentSessionId !== playRowSessionId) return;
            if (!result?.ok) {
                rustTimeLocutionContext = null;
                isPlaylistTimeActive = false;
                logSystem(`[SKIP] Rust no pudo lanzar la locucion de hora: ${result?.error || 'sin detalle'}. Saltando...`);
                setTimeout(() => playNext(false), 500);
                return;
            }
            const startedMsg = result.result?.message || {};
            const durationMs = Number(startedMsg.durationMs) || 0;
            const segments = Number(startedMsg.segments) || 0;
            if (durationMs > 0) {
                currentDuration = durationMs / 1000;
                const endTime = new Date(trackStartTime.getTime() + currentDuration * 1000);
                document.getElementById('txt-acaba').innerText = endTime.toLocaleTimeString('es-PE', { hour12: false });
            }

            // Configurar la metadata de transporte como si fuera una pista
            // normal: filePath con marcador (no-null para que pase los filtros
            // de "live player"), playbackEndAbsolute para que handleTimeUpdate
            // detecte el fin y dispare playNext con transición de programa.
            const timePlaybackEnd = currentDuration; // startOffset = 0
            setPlayerPlaybackMeta(activePlayer, {
                row: tr,
                filePath: '<time-locution>',
                mixAbsolute: null,
                playbackEndAbsolute: timePlaybackEnd,
                naturalEndAbsolute: timePlaybackEnd,
                startOffset: 0
            });

            // Activar el reloj virtual sobre el player asignado para que
            // isPlayerClockPaused devuelva false → "En aire" se enciende →
            // los meters/incidencias reflejan el aire correctamente.
            startRustVirtualPlayback(activePlayer, '<time-locution>', 0);

            // Espejar el estado en el control-plane Rust (mismo registro que
            // usaría una pista normal) para que la sincronización lo trate
            // como un player vivo y no intente pararlo.
            if (timePlaylistPlayerId) {
                const targetGain = dbToLinear(currentTrackConfig.ampDb);
                setRustPlaylistMirrorGain(timePlaylistPlayerId, targetGain, {
                    path: '<time-locution>',
                    owner: true,
                    status: 'playing',
                    seekBucket: 0
                });
            }
            markRustPlaylistOwnerOk({ activate: true });
            isTrackReady = true;
            refreshAirIncidentStatus();
            publishRustTransport({ force: true, syncPosition: false });

            calcularHorasPlaylist(); updateNextTrackVisuals();
            logSystem(`${ICON_AIR_PREFIX} ${ICON_CLOCK_LABEL} (Rust, ${segments} archivo(s), ${(durationMs/1000).toFixed(1)}s, bus=${timePlaylistBus})`);
            return;
        }

        let rutaFisica = tr.dataset.ruta; let nombreMostrar = tr.dataset.pureName || tr.children[1].innerText;
        nombreMostrar = nombreMostrar.replace(/^\[Aleatorio\]\s*/i, '').replace(/^\[Rotativa\]\s*/i, '').replace(/^(?:\u23f3|⏳)\s*/, '');
        if (type === 'random') {
            try {
                const randomPath = await hydrateRandomRowFromLibrary(tr);
                if (currentSessionId !== playRowSessionId) return;
                if (randomPath) {
                    rutaFisica = randomPath;
                    const randomFile = path.basename(randomPath);
                    nombreMostrar = randomFile.match(/(.*)(\.[a-zA-Z0-9]{2,5})$/i) ? randomFile.match(/(.*)(\.[a-zA-Z0-9]{2,5})$/i)[1] : randomFile;
                    tr.dataset.duracion = tr.dataset.resolvedRandomDuration || getCachedTrackDurationSeconds(rutaFisica, tr.dataset.duracion);
                    delete tr.dataset.resolvedRandomPath;
                    delete tr.dataset.resolvedRandomName;
                    delete tr.dataset.resolvedRandomDuration;
                } else { 
                    logSystem('[SKIP] No se pudo resolver la pista aleatoria. Saltando...');
                    setTimeout(() => playNext(false), 500);
                    return; 
                }
            } catch (e) { 
                logSystem(`[SKIP] Error resolviendo pista aleatoria: ${e.message || e}. Saltando...`);
                setTimeout(() => playNext(false), 500);
                return; 
            }
        }

        if (!manualCuesDB[rutaFisica] || manualCuesDB[rutaFisica].is_remix === undefined) {
            try {
                const scoped = await ipcRenderer.invoke('lib-get-db-tracks', [rutaFisica], { includeSignatures: false });
                manualCuesDB = { ...manualCuesDB, ...(scoped || {}) };
            } catch (err) { }
            if (currentSessionId !== playRowSessionId) return;
        }

        if (manualCuesDB[rutaFisica]) {
            const mc = manualCuesDB[rutaFisica];
            const cueStart = parseFiniteCueValue(mc.inicio);
            manualFin = parseFiniteCueValue(mc.fin);
            if (cueStart !== null) currentStartTimeOffset = cueStart;
        }
        const cacheDbg = manualCuesDB[rutaFisica] || {};
        const baseDur = parseFiniteCueValue(cacheDbg.duration) ?? parseFiniteCueValue(tr.dataset.duracion) ?? 0;
        currentTrackConfig = getCrossfadeConfig(getTrackTypeData(rutaFisica), rutaFisica);
        const rowMixAbsolute = getResolvedRowMixAbsolute(tr, currentTrackConfig);
        // Si el operador definio el mix a mano en el editor de 2 o 3 pistas, la
        // fila trae dataset.customMix y ese valor debe respetarse aunque caiga
        // antes de los 3 segundos (caso jingles cortos, identificaciones, etc).
        const rowMixIsManual = parseFiniteCueValue(tr?.dataset?.customMix) !== null;
        if (rowMixAbsolute === null && currentTrackConfig.mixDbActive) {
            requestImmediateTransitionPreanalysis(rutaFisica, currentTrackConfig);
        } else {
            maybeRequestTransitionPreanalysis(rutaFisica, currentTrackConfig);
        }
        let playbackWindow = resolveTrackPlaybackWindow(rutaFisica, {
            baseDuration: baseDur,
            startOffset: currentStartTimeOffset,
            mixAbsolute: rowMixAbsolute,
            finAbsolute: manualFin,
            mixIsManual: rowMixIsManual
        });
        const resumeLimit = playbackWindow.effectiveEndAbsolute ?? playbackWindow.naturalEndAbsolute;
        if (resumeStart !== null && (resumeLimit === null || resumeStart < (resumeLimit - MIX_FIN_GUARD_SECONDS))) {
            currentStartTimeOffset = Math.max(playbackWindow.startOffset, resumeStart);
            playbackWindow = resolveTrackPlaybackWindow(rutaFisica, {
                baseDuration: baseDur,
                startOffset: currentStartTimeOffset,
                mixAbsolute: rowMixAbsolute,
                finAbsolute: manualFin,
                mixIsManual: rowMixIsManual
            });
        }
        currentStartTimeOffset = playbackWindow.startOffset;
        currentDuration = playbackWindow.effectiveDuration ?? Math.max(MIN_PLAYBACK_WINDOW_SECONDS, baseDur - currentStartTimeOffset);
        if (!Number.isFinite(currentDuration) || currentDuration < 1) {
            haltPlaybackOnFatalError(`Duracion invalida menor a 1 segundo: ${nombreMostrar}`);
            return;
        }
        trackStartTime = new Date(); document.getElementById('txt-cancion').innerText = nombreMostrar; document.getElementById('txt-cancion').style.color = '#ffffff';
        updateMediaSessionStatus(nombreMostrar);
        ipcRenderer.send('update-metadata', nombreMostrar);
        publishRustNowPlaying(nombreMostrar, {
            path: rutaFisica,
            player: activePlayer === playerB ? 'player-b' : 'player-a',
            source: 'playRow'
        });
        const endTime = new Date(trackStartTime.getTime() + currentDuration * 1000); document.getElementById('txt-acaba').innerText = endTime.toLocaleTimeString('es-PE', { hour12: false });
        const playbackDiagnostics = getFilePlaybackDiagnostics(rutaFisica);

        if (!playbackDiagnostics.ok) {
            tr.dataset.playbackUnavailable = 'true';
            logSystem(`[ERROR] No se puede abrir archivo: ${nombreMostrar} (${playbackDiagnostics.reason})`);
            schedulePlayNextAfterFailure(isAutoMix);
            return;
        }
        calcularHorasPlaylist(); updateNextTrackVisuals();
        setPlayerPlaybackMeta(activePlayer, {
            row: tr,
            filePath: rutaFisica,
            mixAbsolute: playbackWindow.mixAbsolute,
            playbackEndAbsolute: playbackWindow.effectiveEndAbsolute,
            naturalEndAbsolute: playbackWindow.naturalEndAbsolute,
            startOffset: currentStartTimeOffset
        });

        if (fadingPlayer && !isPlayerClockPaused(fadingPlayer)) {
            const currentVol = fadingGain.gain.value; fadingGain.gain.cancelScheduledValues(audioCtx.currentTime); fadingGain.gain.setValueAtTime(currentVol, audioCtx.currentTime);
            const fadePlan = getFadeOutPlanForTransition(fadingPlayer, outgoingTrackConfig, isAutoMix, forcedFadeOutSeconds);
            if (fadePlan.seconds > 0) {
                fadingGain.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + fadePlan.seconds);
            }
            if (fadePlan.scheduleStop) schedulePlayerStop(fadingPlayer, (fadePlan.stopDelaySeconds || fadePlan.seconds) * 1000);
        }

        const targetLinearGain = dbToLinear(currentTrackConfig.ampDb); activeGain.gain.cancelScheduledValues(audioCtx.currentTime);
        if (currentTrackConfig.fadein > 0) { activeGain.gain.setValueAtTime(0.0001, audioCtx.currentTime); activeGain.gain.linearRampToValueAtTime(targetLinearGain, audioCtx.currentTime + currentTrackConfig.fadein); } else { activeGain.gain.setValueAtTime(targetLinearGain, audioCtx.currentTime); }
        const nextPlayer = activePlayer;

        if (isRustPlaylistOwnerEnabled()) {
            const nextPlayerId = getPlaylistPlayerId(nextPlayer);
            if (!nextPlayerId) {
                haltPlaybackOnFatalError('Rust no pudo resolver el player activo.');
                return;
            }

            const previousPlayerId = getPlaylistPlayerId(fadingPlayer);
            const previousAuxPlayerId = previousPlayerId && previousPlayingRow ? getRustPlaylistAuxPlayerId(previousPlayerId, previousPlayingRow) : '';
            const previousRustState = previousPlayerId ? (rustPlaylistMirrorState.get(previousPlayerId) || {}) : {};
            const previousRustGain = Number.isFinite(Number(previousRustState.gain)) ? Number(previousRustState.gain) : 1;
            const previousFadePlan = previousPlayerId && previousPlayerId !== nextPlayerId
                ? getFadeOutPlanForTransition(fadingPlayer, outgoingTrackConfig, isAutoMix, forcedFadeOutSeconds)
                : { seconds: 0, stopDelaySeconds: 0, scheduleStop: false, holdTail: false };
            const nextAuxPlayerId = getRustPlaylistAuxPlayerId(nextPlayerId, tr);
            const nextAuxBus = getRustPlaylistAuxBus(tr);
            const rustTransitionPlan = getRustTransitionPlan({
                row: tr,
                filePath: rutaFisica,
                currentConfig: currentTrackConfig,
                outgoingConfig: outgoingTrackConfig,
                playbackWindow,
                isAutoMix,
                forcedFadeOutSeconds,
                targetGain: targetLinearGain,
                previousGain: previousRustGain
            });

            try {
                nextPlayer.onloadedmetadata = null;
                nextPlayer.onerror = null;
                try { nextPlayer.pause(); } catch (err) { }
                try { nextPlayer.removeAttribute('src'); nextPlayer.load(); } catch (err) { }

                const positionMs = Math.max(0, Math.round(currentStartTimeOffset * 1000));
                const rustStartGain = currentTrackConfig.fadein > 0 ? 0.0001 : targetLinearGain;
                const rustPrimaryBus = getRustPlaylistPrimaryBus(tr);
                cancelRustPlaylistGainRamp(nextPlayerId);
                if (nextAuxPlayerId) cancelRustPlaylistGainRamp(nextAuxPlayerId);
                const loadResult = await commandRustPlaylist('load', {
                    player: nextPlayerId,
                    bus: rustPrimaryBus,
                    path: rutaFisica,
                    gain: rustStartGain
                });
                if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
                if (!loadResult?.ok) throw new Error(loadResult?.error || 'Rust no pudo cargar la pista.');
                setRustPlaylistMirrorGain(nextPlayerId, rustStartGain, {
                    path: rutaFisica,
                    owner: true,
                    status: 'loaded',
                    seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
                });
                if (nextAuxPlayerId && nextAuxBus) {
                    const auxLoadResult = await commandRustControlPlane('load', {
                        player: nextAuxPlayerId,
                        bus: nextAuxBus,
                        path: rutaFisica,
                        gain: rustStartGain
                    });
                    if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
                    if (auxLoadResult?.ok) {
                        setRustPlaylistMirrorGain(nextAuxPlayerId, rustStartGain, {
                            path: rutaFisica,
                            owner: true,
                            status: 'loaded',
                            seekBucket: Math.floor(positionMs / RUST_MIRROR_SEEK_DEBOUNCE_MS)
                        });
                    }
                }

                const seekResult = await commandRustPlaylist('seek', { player: nextPlayerId, positionMs });
                if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
                if (!seekResult?.ok) throw new Error(seekResult?.error || 'Rust no pudo ubicar la pista.');
                if (nextAuxPlayerId && rustPlaylistMirrorState.has(nextAuxPlayerId)) {
                    await commandRustControlPlane('seek', { player: nextAuxPlayerId, positionMs }).catch(() => null);
                }

                const playResult = await commandRustPlaylist('play', { player: nextPlayerId });
                if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
                if (!playResult?.ok) throw new Error(playResult?.error || 'Rust no pudo reproducir la pista.');
                setRustPlaylistMirrorGain(nextPlayerId, rustStartGain, { status: 'playing' });
                if (nextAuxPlayerId && rustPlaylistMirrorState.has(nextAuxPlayerId)) {
                    commandRustControlPlane('play', { player: nextAuxPlayerId }).catch(() => { });
                    setRustPlaylistMirrorGain(nextAuxPlayerId, rustStartGain, { status: 'playing' });
                }

                if (currentTrackConfig.fadein > 0) {
                    scheduleRustPlaylistGainRamp(nextPlayerId, rustStartGain, targetLinearGain, currentTrackConfig.fadein);
                    if (nextAuxPlayerId && rustPlaylistMirrorState.has(nextAuxPlayerId)) {
                        scheduleRustPlaylistGainRamp(nextAuxPlayerId, rustStartGain, targetLinearGain, currentTrackConfig.fadein);
                    }
                } else if (Math.abs(rustStartGain - targetLinearGain) > 0.001) {
                    commandRustPlaylist('setGain', { player: nextPlayerId, gain: targetLinearGain }).catch(() => { });
                    setRustPlaylistMirrorGain(nextPlayerId, targetLinearGain);
                    if (nextAuxPlayerId && rustPlaylistMirrorState.has(nextAuxPlayerId)) {
                        commandRustControlPlane('setGain', { player: nextAuxPlayerId, gain: targetLinearGain }).catch(() => { });
                        setRustPlaylistMirrorGain(nextAuxPlayerId, targetLinearGain);
                    }
                }

                const fadeOrStopPreviousRustPlayer = (playerId, previousGain) => {
                    if (!playerId) return;
                    if (previousFadePlan.seconds > 0) {
                        const stopWithRamp = previousFadePlan.scheduleStop
                            && (previousFadePlan.stopDelaySeconds || previousFadePlan.seconds) <= previousFadePlan.seconds + 0.05;
                        scheduleRustPlaylistGainRamp(playerId, previousGain, 0.0001, previousFadePlan.seconds, { stopAfter: stopWithRamp });
                        if (previousFadePlan.scheduleStop && !stopWithRamp) {
                            scheduleRustPlaylistStop(playerId, previousFadePlan.stopDelaySeconds || previousFadePlan.seconds);
                        }
                    } else if (previousFadePlan.scheduleStop && previousFadePlan.holdTail) {
                        scheduleRustPlaylistStop(playerId, previousFadePlan.stopDelaySeconds);
                    } else {
                        commandRustPlaylist('setGain', { player: playerId, gain: 0 }).catch(() => { });
                        commandRustPlaylist('stop', { player: playerId }).catch(() => { });
                        rustPlaylistMirrorState.delete(playerId);
                    }
                };
                if (previousPlayerId && previousPlayerId !== nextPlayerId) {
                    fadeOrStopPreviousRustPlayer(previousPlayerId, previousRustGain);
                    if (previousAuxPlayerId) {
                        const previousAuxState = rustPlaylistMirrorState.get(previousAuxPlayerId) || {};
                        const previousAuxGain = Number.isFinite(Number(previousAuxState.gain)) ? Number(previousAuxState.gain) : previousRustGain;
                        fadeOrStopPreviousRustPlayer(previousAuxPlayerId, previousAuxGain);
                    }
                }

                startRustVirtualPlayback(nextPlayer, rutaFisica, currentStartTimeOffset);
                markRustPlaylistOwnerOk({ activate: true });
                isTrackReady = true;
                refreshAirIncidentStatus();
                publishRustTransport({ force: true, syncPosition: false });
                scheduleAirWaveform(rutaFisica, currentSessionId);
                handleTimeUpdate(nextPlayer);
                logSystem(`[RUST TRANSICION] fuente=${rustTransitionPlan.settingsSource}, mix=${rustTransitionPlan.mixSource}, fadeIn=${rustTransitionPlan.fadeInSeconds}s, fadeOut=${rustTransitionPlan.fadeOutSeconds}s, cola=${rustTransitionPlan.holdTail ? 'hasta-fin' : 'fade'}, gain=${rustTransitionPlan.targetGain.toFixed(3)}`);
                logSystem(`Sonando por Rust: ${nombreMostrar}`);
                return;
            } catch (err) {
                refreshAirIncidentStatus();
                haltPlaybackOnFatalError(`Rust no pudo reproducir: ${nombreMostrar}. ${err?.message || ''}`.trim());
                return;
            }
        }

        haltPlaybackOnFatalError(`RustAudio es obligatorio para reproducir: ${nombreMostrar}.`);
        return;

        const syncLoadedMetadataDuration = () => {
            const metadataDuration = parseFiniteCueValue(nextPlayer.duration);
            if (metadataDuration !== null && metadataDuration > 0 && (baseDur <= 0 || Math.abs(metadataDuration - baseDur) > 1)) {
                if (!manualCuesDB[rutaFisica]) manualCuesDB[rutaFisica] = {};
                manualCuesDB[rutaFisica].duration = metadataDuration;
                playbackWindow = resolveTrackPlaybackWindow(rutaFisica, {
                    baseDuration: metadataDuration,
                    startOffset: currentStartTimeOffset,
                    mixAbsolute: rowMixAbsolute,
                    finAbsolute: manualFin,
                    mixIsManual: rowMixIsManual
                });
                currentStartTimeOffset = playbackWindow.startOffset;
                currentDuration = playbackWindow.effectiveDuration ?? Math.max(MIN_PLAYBACK_WINDOW_SECONDS, metadataDuration - currentStartTimeOffset);
                tr.dataset.duracion = Math.round(currentDuration);
                const adjustedEndTime = new Date(trackStartTime.getTime() + currentDuration * 1000);
                document.getElementById('txt-acaba').innerText = adjustedEndTime.toLocaleTimeString('es-PE', { hour12: false });
                setPlayerPlaybackMeta(activePlayer, {
                    row: tr,
                    filePath: rutaFisica,
                    mixAbsolute: playbackWindow.mixAbsolute,
                    playbackEndAbsolute: playbackWindow.effectiveEndAbsolute,
                    naturalEndAbsolute: playbackWindow.naturalEndAbsolute,
                    startOffset: currentStartTimeOffset
                });
                calcularHorasPlaylist();
            }
        };

        const startPlayback = () => {
            clearTimeout(trackFallbackTimeout);
            if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
            if (!Number.isFinite(currentDuration) || currentDuration < 1) {
                haltPlaybackOnFatalError(`Duracion invalida menor a 1 segundo: ${nombreMostrar}`);
                return;
            }
            nextPlayer.currentTime = currentStartTimeOffset > 0 ? currentStartTimeOffset : 0;
            nextPlayer.play().then(() => {
                isTrackReady = true;
                refreshAirIncidentStatus();
                publishRustTransport({ force: true });
                scheduleAirWaveform(rutaFisica, currentSessionId);
                logSystem(`Sonando: ${nombreMostrar}`);
            }).catch(err => { refreshAirIncidentStatus(); haltPlaybackOnFatalError(`No se pudo reproducir: ${nombreMostrar}. ${err?.message || ''}`.trim()); });
        };
        const targetMediaUrl = url.pathToFileURL(rutaFisica).href;
        let trackFallbackTimeout = setTimeout(() => {
            if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
            logSystem(`[ERROR] Tiempo de espera agotado cargando pista: ${nombreMostrar}`);
            tr.dataset.playbackUnavailable = 'true';
            nextPlayer.onloadedmetadata = null;
            nextPlayer.onerror = null;
            schedulePlayNextAfterFailure(isAutoMix);
        }, TRACK_LOAD_TIMEOUT_MS);
        nextPlayer.onloadedmetadata = () => {
            syncLoadedMetadataDuration();
            startPlayback();
            nextPlayer.onloadedmetadata = null;
            nextPlayer.onerror = null;
        };
        nextPlayer.onerror = () => {
            clearTimeout(trackFallbackTimeout);
            if (currentSessionId !== playRowSessionId || nextPlayer !== activePlayer) return;
            const mediaError = nextPlayer.error ? ` codigo ${nextPlayer.error.code}` : '';
            logSystem(`[ERROR] Archivo danado o ilegible: ${nombreMostrar}${mediaError}`);
            tr.dataset.playbackUnavailable = 'true';
            nextPlayer.onloadedmetadata = null;
            nextPlayer.onerror = null;
            schedulePlayNextAfterFailure(isAutoMix);
        };
        if (nextPlayer.src === targetMediaUrl && nextPlayer.readyState >= 1) {
            syncLoadedMetadataDuration();
            startPlayback();
            nextPlayer.onloadedmetadata = null;
            nextPlayer.onerror = null;
        } else {
            nextPlayer.src = targetMediaUrl;
            nextPlayer.load();
        }
    } catch (err) { haltPlaybackOnFatalError(`Error interno al iniciar pista: ${err.message || err}`); }
}

function isPlaybackFullyStopped() {
    const playerAStopped = !playerA || (playerA.paused && (!playerA.src || playerA.currentTime === 0));
    const playerBStopped = !playerB || (playerB.paused && (!playerB.src || playerB.currentTime === 0));
    return playerAStopped && playerBStopped && !currentPlayingRow;
}

function executeStopCommandRow(commandRow) {
    const rowToRemove = commandRow;
    stopAll();
    setTimeout(() => {
        if (!isPlaybackFullyStopped()) {
            stopAll();
        }
        setTimeout(() => {
            if (isPlaybackFullyStopped()) {
                if (rowToRemove && rowToRemove.parentNode) rowToRemove.remove();
                recordIncident('[PLAYLIST] Comando stop ejecutado y eliminado.', { category: 'air', level: 'success', autoAction: true });
            } else {
                recordIncident('[PLAYLIST] No se pudo confirmar la detencion del comando stop.', { category: 'air', level: 'error', autoAction: true });
            }
            calcularHorasPlaylist();
            updateNextTrackVisuals();
            saveSessionSnapshot();
        }, 120);
    }, 80);
}

function executePlaylistJumpCommandRow(commandRow, isAutoMix = false, forcedFadeOutSeconds = 0) {
    const targetTab = parseInt(commandRow?.dataset?.targetTab, 10);
    const currentCommandTbody = commandRow?.closest('tbody');
    const fallbackNext = resolveNextOperationalRow(commandRow?.nextElementSibling, generalPrefs.modeLoopPlaylist);
    const commandTab = tbodys.indexOf(currentCommandTbody);
    if (!Number.isInteger(targetTab) || !tbodys[targetTab] || targetTab === commandTab) {
        recordIncident('[PLAYLIST] Salto de playlist no ejecutado: destino invalido o igual a la playlist del comando.', { category: 'air', level: 'error', autoAction: true });
        if (fallbackNext && fallbackNext !== commandRow) playRow(fallbackNext, isAutoMix, forcedFadeOutSeconds);
        else stopAll();
        return;
    }

    const targetRow = resolveNextOperationalRow(tbodys[targetTab].firstElementChild, false);
    if (!targetRow) {
        recordIncident(`[PLAYLIST] Salto no ejecutado: Playlist ${targetTab + 1} esta vacia o solo tiene notas.`, { category: 'air', level: 'error', autoAction: true });
        if (fallbackNext && fallbackNext.closest('tbody') === currentCommandTbody && fallbackNext !== commandRow) playRow(fallbackNext, isAutoMix, forcedFadeOutSeconds);
        else if (generalPrefs.modeLoopPlaylist) {
            const loopTarget = resolveNextOperationalRow(currentCommandTbody?.firstElementChild, false);
            if (loopTarget && loopTarget !== commandRow) playRow(loopTarget, isAutoMix, forcedFadeOutSeconds);
            else stopAll();
        } else {
            stopAll();
        }
        return;
    }

    pgmTab = targetTab;
    applySessionViewState(targetTab);
    updateTabsUI();
    recordIncident(`[PLAYLIST] Saltando a Playlist ${targetTab + 1}.`, { category: 'air', level: 'success', autoAction: true });
    playRow(targetRow, isAutoMix, forcedFadeOutSeconds);
}

async function executeEventCommandRow(commandRow) {
    const eventId = commandRow?.dataset?.eventId || commandRow?.dataset?.ruta || '';
    const eventName = commandRow?.dataset?.eventName || commandRow?.dataset?.pureName || 'evento';
    const ev = eventsMasterDB.find(item => item.id === eventId);
    let executed = false;
    isTrackReady = false;
    playbackGuard.cooldownUntil = Date.now() + Math.max(PLAYBACK_GUARD_COOLDOWN_MS, 15000);
    try {
        if (!ev) {
            recordIncident(`[PLAYLIST] No se pudo ejecutar "${eventName}": el evento ya no existe.`, { category: 'events', level: 'error', autoAction: true });
            return;
        }
        executed = await queueEventForEmission(ev, { playlistCommand: true });
        if (!executed) {
            recordIncident(`[PLAYLIST] Comando de evento fallido: ${ev.name}.`, { category: 'events', level: 'error', autoAction: true });
        }
    } catch (err) {
        recordIncident(`[PLAYLIST] Error ejecutando evento "${eventName}": ${err.message || err}.`, { category: 'events', level: 'error', autoAction: true });
    } finally {
        const fallbackRow = commandRow?.parentNode ? resolveNextOperationalRow(commandRow.nextElementSibling, generalPrefs.modeLoopPlaylist) : null;
        removeCommandRowAfterExecution(commandRow);
        if (!executed) {
            if (fallbackRow && document.body.contains(fallbackRow)) playRow(fallbackRow, false);
            else playNext(false);
        }
    }
}

function playNext(isAutoMix = false, forcedFadeOutSeconds = 0) {
    if (playbackFatalHalt) {
        logSystem('[SEGURIDAD] Avance automatico bloqueado por error critico. Pulsa Stop y luego Play para reintentar.');
        return;
    }
    const preHold = getUpcomingEventWithinPreHold();
    if (!isAutoMix && forcedFadeOutSeconds === 0 && preHold && !queuedNextRow?.dataset?.eventId) {
        // Si el usuario marco algo manualmente y el evento proximo no es critico (rank < 3),
        // ignoramos el "Hold" (espera) y procedemos a reproducir la seleccion del usuario.
        const isManual = queuedNextRow && queuedNextRow.dataset.manualNext === "true";
        const eventRank = getEventPriorityRank(preHold.ev);

        if (isManual && eventRank < 3) {
            clearEventPreHold();
        } else {
            if (holdForUpcomingEvent(preHold)) return;
        }
    }
    let target = null;
    if (queuedNextRow && document.body.contains(queuedNextRow)) {
        target = queuedNextRow;
    } else if (currentPlayingRow && document.body.contains(currentPlayingRow)) {
        target = currentPlayingRow.nextElementSibling;
    } else {
        target = tbodys[pgmTab].firstElementChild;
    }
    target = resolvePriorityNextRow(resolveNextOperationalRow(target, generalPrefs.modeLoopPlaylist));

    if (!target && generalPrefs.modeLoopPlaylist) target = resolveNextOperationalRow(tbodys[pgmTab].firstElementChild, false);
    if (target) playRow(target, isAutoMix, forcedFadeOutSeconds); else stopAll();
}

function skipToNextTrack() {
    let fade = 0.08;
    if (typeof currentTrackConfig !== 'undefined' && currentTrackConfig && currentTrackConfig.fadeoutNext > 0) {
        fade = currentTrackConfig.fadeoutNext;
    }
    playNext(false, fade);
}

function stopAll() {
    clearPlaybackFatalHalt();
    playbackHoldByUser = false;
    const preservedQueuedNextRow = (queuedNextRow && document.body.contains(queuedNextRow))
        ? queuedNextRow
        : ((currentPlayingRow && document.body.contains(currentPlayingRow))
            ? resolveNextOperationalRow(currentPlayingRow.nextElementSibling, generalPrefs.modeLoopPlaylist)
            : null);
    try { ipcRenderer.send('emergency-stop-playback'); } catch (err) { }
    // Asegurarse de detener también la locución horaria del bus jingle de Rust.
    // El motor invalida su contador de generación al recibir `stop` sobre
    // `time-locucion`, así el timer interno no emite `timeLocutionEnded` post-stop.
    if (rustTimeLocutionContext) {
        commandRustControlPlane('stop', { player: 'time-locucion' }).catch(() => {});
        rustTimeLocutionContext = null;
    }
    cancelPendingPlayerStop(playerA);
    cancelPendingPlayerStop(playerB);
    let fadeOutTime = 0;
    if (typeof currentTrackConfig !== 'undefined' && currentTrackConfig && currentTrackConfig.fadeoutStop > 0) {
        fadeOutTime = currentTrackConfig.fadeoutStop;
    }
    sendRustOwnerStopAll({ fadeSeconds: fadeOutTime });
    if (fadeOutTime > 0) {
        [{ p: playerA, g: gainA }, { p: playerB, g: gainB }].forEach(({ p, g }) => {
            if (!p.paused) {
                const currentVol = g.gain.value; g.gain.cancelScheduledValues(audioCtx.currentTime);
                g.gain.setValueAtTime(currentVol, audioCtx.currentTime); g.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + fadeOutTime);
                setTimeout(() => { p.pause(); p.currentTime = 0; clearPlayerPlaybackMeta(p); }, fadeOutTime * 1000);
            }
        });
    } else {
        playerA.pause(); playerA.currentTime = 0; try { playerA.removeAttribute('src'); playerA.load(); } catch (err) { } clearPlayerPlaybackMeta(playerA);
        playerB.pause(); playerB.currentTime = 0; try { playerB.removeAttribute('src'); playerB.load(); } catch (err) { } clearPlayerPlaybackMeta(playerB);
    }
    if (currentPlayingRow && (currentPlayingRow.dataset.temp === 'true' || (generalPrefs.modeRemovePlayed && document.body.contains(currentPlayingRow)))) {
        currentPlayingRow.remove();
        calcularHorasPlaylist();
    } else if (currentPlayingRow && document.body.contains(currentPlayingRow)) {
        currentPlayingRow.classList.remove('row-active');
    }
    currentPlayingRow = null; trackStartTime = null; crossfadeTriggered = false; isPlaylistTimeActive = false; rustTimeLocutionContext = null;
    queuedNextRow = preservedQueuedNextRow && document.body.contains(preservedQueuedNextRow) ? preservedQueuedNextRow : null;
    const txtT = document.getElementById('txt-tiempo'); if (txtT) { txtT.innerText = "00:00.0"; txtT.classList.remove('time-warning-blue', 'time-warning-red', 'time-flash'); }
    clearAirTimeSegmentState();
    setIdleBroadcastMetadata(true);
    document.getElementById('barra-progreso').style.width = '0%';
    logSystem(`${ICON_STOP_LABEL} Reproduccion detenida.`);
    updateTabsUI();
    updateNextTrackVisuals({ allowIdleFallback: false });
    refreshAirIncidentStatus();
    resetPlaybackGuard();
    saveSessionSnapshot();
}

window.addEventListener('beforeunload', () => { saveSessionSnapshot(true); });
setInterval(() => { saveSessionSnapshot(); }, SESSION_AUTOSAVE_MS);
setInterval(() => { runPlaybackGuard(); }, PLAYBACK_GUARD_INTERVAL_MS);

const btnMasterVol = document.getElementById('master-volume');
if (btnMasterVol) {
    // Sincronizar valor inicial al motor Rust cuando ya esté listo
    btnMasterVol.addEventListener('input', (e) => {
        const vol = e.target.value / 100;
        masterNode.gain.value = vol;
        // En modo rustAudio el audio no pasa por WebAudio: enviar ganancia al motor nativo.
        commandRustControlPlane('masterGain', { gain: vol }).catch(() => {});
    });
}
function resumeCurrentPlayback() {
    clearPlaybackFatalHalt();
    playbackHoldByUser = false;
    // FASE D · sub-paso 12.1: idem playSelectedRow — en modo rustAudio el
    // audioCtx queda dormido porque el motor Rust hace todo el trabajo.
    if (audioCtx.state === 'suspended' && !isRustExclusiveAudioMode()) audioCtx.resume();
    if (isPlayerClockPaused(activePlayer) && currentPlayingRow) {
        resetPlaybackGuard();
        if (isRustVirtualPlayer(activePlayer)) {
            sendRustOwnerPlayActive();
        } else {
            activePlayer.play();
            sendRustOwnerPlayActive();
        }
        sendCurrentBroadcastMetadata();
        recalcEndTime();
    } else {
        playNext(false);
    }
}

function pauseCurrentPlayback() {
    playbackHoldByUser = true;
    sendRustOwnerPauseActive();
    if (!isRustVirtualPlayer(activePlayer)) activePlayer.pause();
    setIdleBroadcastMetadata();
    recalcEndTime();
}

const btnPlay = document.getElementById('btn-play'); if (btnPlay) btnPlay.addEventListener('click', resumeCurrentPlayback);
const btnPause = document.getElementById('btn-pause'); if (btnPause) btnPause.addEventListener('click', pauseCurrentPlayback);
const btnStop = document.getElementById('btn-stop'); if (btnStop) btnStop.addEventListener('click', stopAll);
const btnNext = document.getElementById('btn-next'); if (btnNext) btnNext.addEventListener('click', skipToNextTrack);

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'escape') {
        const rotModal = document.getElementById('rotation-modal');
        if (rotModal && rotModal.style.display === 'flex') {
            e.preventDefault();
            closeRotationModal();
            return;
        }
    }

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Alt') { e.preventDefault(); return; }
    if (e.key.toLowerCase() === 'escape') {
        e.preventDefault(); document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
        document.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected')); selectedEventId = null; updateSelectedEventControls(); hideAllMenus(); return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'h') { e.preventDefault(); addTimeLocutionToPlaylist(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); handleClearPlaylist(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); handleOpenPlaylist(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); handleSavePlaylist(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); ipcRenderer.send('open-settings'); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const targetBody = tbodys[currentViewTab] || playlistBody;
        const rows = Array.from(targetBody.children);
        if (rows.length > 0) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            rows.forEach(row => row.classList.add('selected-row'));
            anchorRowIndex = 0;
            lastSelectedRowIndex = rows.length - 1;
        }
        return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        const copyBtn = document.getElementById('pm-copy');
        if (copyBtn) copyBtn.click();
        return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        const cutBtn = document.getElementById('pm-cut');
        if (cutBtn) cutBtn.click();
        return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (typeof clipboardData === 'undefined' || clipboardData.length === 0) return;

        const selectedRows = document.querySelectorAll('.selected-row');
        let targetRow = selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : (typeof rightClickedRow !== 'undefined' ? rightClickedRow : null);
        let targetTbody = targetRow ? targetRow.closest('tbody') : (tbodys[currentViewTab] || playlistBody);

        clipboardData.forEach(item => {
            const rowName = item.type === 'playlist_jump' ? item.targetTab : (item.type === 'note' ? (item.noteText || item.nombre) : (item.type === 'execute_event' ? (item.eventName || item.nombre) : item.nombre));
            const newTr = createPlaylistRow(item.type === 'execute_event' ? (item.eventId || item.ruta) : item.ruta, rowName, parseInt(item.duracion), item.type, targetRow, 'bottom', targetTbody);
            if (newTr && item.temp) newTr.dataset.temp = 'true';
            if (newTr && item.type === 'note' && item.noteText) newTr.dataset.noteText = item.noteText;
            if (newTr && item.type === 'playlist_jump' && Number.isInteger(parseInt(item.targetTab, 10))) newTr.dataset.targetTab = parseInt(item.targetTab, 10);
            if (newTr && item.type === 'execute_event') { newTr.dataset.eventId = item.eventId || item.ruta || ''; newTr.dataset.eventName = item.eventName || rowName || ''; }
            targetRow = newTr;
        });
        if (clipboardAction === 'cut') { clipboardData = []; clipboardAction = null; }
        calcularHorasPlaylist();
        updateNextTrackVisuals();
        if (typeof saveSessionSnapshot === 'function') saveSessionSnapshot();
        hideAllMenus();
        return;
    }
    if (e.ctrlKey) return;
    switch (e.key.toLowerCase()) {
        case 'p': e.preventDefault(); resumeCurrentPlayback(); break;
        case 's': e.preventDefault(); stopAll(); break;
        case 'n': e.preventDefault(); skipToNextTrack(); break;
        case 'q': e.preventDefault(); const selectedQ = resolveNextOperationalRow(document.querySelector('.selected-row'), false); if (selectedQ) { setQueuedNextManual(selectedQ); } break;
        case 'f': e.preventDefault(); toggleStopAfter(); break;
        case 'delete': e.preventDefault(); const selected = document.querySelectorAll('.selected-row'); if (selected.length > 0) { selected.forEach(el => el.remove()); calcularHorasPlaylist(); updateNextTrackVisuals(); } break;
    }
    const navKeys = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    if (navKeys.includes(e.key)) {
        e.preventDefault();
        const rows = Array.from(playlistBody.children);
        if (rows.length === 0) return;
        if (lastSelectedRowIndex === -1) lastSelectedRowIndex = 0;
        if (anchorRowIndex === -1) anchorRowIndex = lastSelectedRowIndex;
        let nextIndex = lastSelectedRowIndex;
        if (e.key === 'ArrowUp') nextIndex--;
        else if (e.key === 'ArrowDown') nextIndex++;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = rows.length - 1;
        if (nextIndex < 0) nextIndex = 0;
        if (nextIndex >= rows.length) nextIndex = rows.length - 1;

        if (e.shiftKey) {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            const start = Math.min(anchorRowIndex, nextIndex);
            const end = Math.max(anchorRowIndex, nextIndex);
            for (let i = start; i <= end; i++) rows[i].classList.add('selected-row');
            lastSelectedRowIndex = nextIndex;
        } else {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            rows[nextIndex].classList.add('selected-row');
            lastSelectedRowIndex = nextIndex;
            anchorRowIndex = nextIndex;
        }
        rows[nextIndex].scrollIntoView({ block: "nearest" });
    }
});

window.addEventListener('keyup', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return; if (e.key === 'Alt') { e.preventDefault(); ipcRenderer.send('toggle-menu-bar'); } });

document.getElementById('btn-open-encoder').addEventListener('click', () => { ipcRenderer.send('open-encoder'); });
let liveMediaRecorder = null;
let liveCaptureStreamNode = null;
let livePcmCaptureInput = null;
let livePcmCaptureProcessor = null;
let livePcmCaptureSilentGain = null;
let livePcmCaptureSourceStream = null;
let livePcmCaptureStats = null;
let liveEncoderSourceState = null;
let rustPcmEncoderSyncTimer = null;
let rustPcmEncoderSyncRunning = false;
let rustPcmEncoderSyncBusy = false;
let rustPcmEncoderLastStatus = null;
let rustPcmEncoderEmptyPlanStrikes = 0;

setTimeout(() => {
    applyRustPlaylistOwnerMute();
    syncRustPlaylistControlPlane({ force: true });
}, 1500);

function resolveMasterEncoderSourceState(config = {}, sampleRate = 44100) {
    const provider = String(config.encoderProvider || 'auto').trim();
    const providerLower = provider.toLowerCase();
    const tapPoint = config.tapPoint === 'preFx' ? 'preFx' : 'postFx';
    const rustExclusive = isRustExclusiveAudioMode();
    const forcedWebAudio = !rustExclusive && (config.captureProvider === 'webAudioRenderer' || config.owner === 'webAudioRenderer');
    const wantsRustPcm = ['rust', 'rustaudio', 'rustaudioengine'].includes(providerLower)
        || rustExclusive
        || providerLower === 'auto';
    const rustEncoder = rustAudioProbeStatus.lastStatus?.encoder || {};
    const rustPcmReady = !forcedWebAudio && wantsRustPcm
        && (rustEncoder.pcmBridgeReady === true
            || (rustEncoder.rustPcmReady === true
                && (rustEncoder.owner === 'rustAudioEngine' || rustEncoder.captureProvider === 'rustAudioEngine')));
    const owner = rustPcmReady ? 'rustAudioEngine' : 'webAudioRenderer';
    const fallbackReason = config.fallbackReason || (wantsRustPcm && !rustPcmReady
        ? (rustEncoder.pcmBridgeReason || rustEncoder.fallbackReason || 'rust-master-pcm-pending')
        : '');
    return {
        active: true,
        source: 'master',
        owner,
        requestedOwner: wantsRustPcm ? 'rustAudioEngine' : 'webAudioRenderer',
        captureProvider: owner,
        encoderProvider: provider || 'auto',
        tapPoint,
        rustPcmReady,
        pcmBridgeReady: rustEncoder.pcmBridgeReady === true,
        pcmBridgeMode: rustEncoder.pcmBridgeMode || 'planned',
        pcmBridgeReason: fallbackReason,
        fallbackReason,
        captureFormat: 'pcm_s16le',
        sampleRate,
        transport: rustPcmReady ? (rustEncoder.transport || 'ffmpeg') : 'ffmpeg'
    };
}

function clampPcmSample(value) {
    const sample = Math.max(-1, Math.min(1, Number(value) || 0));
    return sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
}

function writePcmSample(buffer, offset, value) {
    buffer.writeInt16LE(clampPcmSample(value), offset);
}

function stopEncoderPcmCapture() {
    flushEncoderPcmStats('stop');
    if (livePcmCaptureProcessor) {
        livePcmCaptureProcessor.onaudioprocess = null;
        try { livePcmCaptureProcessor.disconnect(); } catch (err) { }
    }
    if (livePcmCaptureInput) {
        try { masterNode.disconnect(livePcmCaptureInput); } catch (err) { }
        try { livePcmCaptureInput.disconnect(); } catch (err) { }
    }
    if (livePcmCaptureSilentGain) {
        try { livePcmCaptureSilentGain.disconnect(); } catch (err) { }
    }
    if (livePcmCaptureSourceStream) {
        try { livePcmCaptureSourceStream.getTracks().forEach(track => track.stop()); } catch (err) { }
    }
    livePcmCaptureInput = null;
    livePcmCaptureProcessor = null;
    livePcmCaptureSilentGain = null;
    livePcmCaptureSourceStream = null;
    livePcmCaptureStats = null;
}

function normalizeRustPcmPlanSource(source, fallbackPlayer) {
    if (!source || !source.path) return null;
    const currentTime = Number(source.currentTime);
    const positionMsValue = Number(source.positionMs);
    const duration = Number(source.duration);
    const gain = Number(source.gain);
    return {
        player: source.player || source.id || fallbackPlayer,
        path: source.path,
        bus: source.bus || '',
        gain: Number.isFinite(gain) ? Math.max(0, Math.min(4, gain)) : 1,
        positionMs: Number.isFinite(positionMsValue)
            ? Math.max(0, Math.round(positionMsValue))
            : Math.max(0, Math.round((Number.isFinite(currentTime) ? currentTime : 0) * 1000)),
        active: source.active !== false,
        title: source.title || ''
    };
}

function getLiveEncoderTapPoint() {
    return liveEncoderSourceState?.tapPoint === 'preFx' ? 'preFx' : 'postFx';
}

function rustBusFeedsEncoderMaster(bus = '') {
    const normalized = String(bus || '').toLowerCase();
    if (['master', 'jingle'].includes(normalized)) return true;
    if (normalized === 'cartwall') return (generalPrefs.cartwallOutputMode || 'master') === 'master';
    if (['pl1', 'pl2', 'pl3', 'pl4'].includes(normalized)) {
        return (generalPrefs.playlistOutputMode || 'disabled') !== 'independent';
    }
    return false;
}

function buildRustPcmEncoderNativePlan() {
    if (!shouldMirrorRustControlPlane()) return [];
    const rustPlayers = Array.isArray(rustAudioProbeStatus.lastStatus?.players)
        ? rustAudioProbeStatus.lastStatus.players
        : [];
    const seen = new Set();
    return rustPlayers
        .filter(player => player?.path && player.audioReady !== false && ['playing', 'loaded'].includes(player.status) && rustBusFeedsEncoderMaster(player.bus))
        .map(player => normalizeRustPcmPlanSource({
            player: player.id,
            id: player.id,
            path: player.path,
            bus: player.bus || '',
            gain: player.gain,
            positionMs: player.positionMs,
            active: player.status === 'playing',
            title: player.id
        }, player.id))
        .filter(plan => {
            if (!plan || !plan.active) return false;
            const key = `${plan.player}|${plan.path}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 12);
}

function buildRustPcmEncoderLiveMixPlan() {
    const nativePlan = buildRustPcmEncoderNativePlan();
    if (nativePlan.length > 0) return nativePlan;
    if (isRustExclusiveAudioMode()) return [];

    const diagnostics = buildWebAudioEngineDiagnostics();
    const sources = [];
    const mixPlayers = (diagnostics.mix?.players || []).filter(player => player?.path && player.active);
    const activeMixPlayers = mixPlayers.filter(player => player.active);
    const hasAudibleActiveMixGain = activeMixPlayers.some(player => {
        const gain = Number(player.gain);
        return Number.isFinite(gain) && gain > 0.002;
    });
    const fallbackAudiblePlayerId = !hasAudibleActiveMixGain
        ? (diagnostics.mix?.referencePlayer || activeMixPlayers[0]?.id || '')
        : '';

    mixPlayers.forEach(player => {
        if (!player?.path || !player.active) return;
        const forcedGain = player.id === fallbackAudiblePlayerId ? 1 : undefined;
        const plan = normalizeRustPcmPlanSource({
            ...player,
            player: player.id,
            gain: forcedGain ?? player.gain
        }, player.id);
        if (plan) sources.push(plan);
    });
    const jinglePlayer = (diagnostics.players || []).find(item => item.id === 'jingle-player');
    if (jinglePlayer?.active && jinglePlayer.path) {
        const plan = normalizeRustPcmPlanSource({ ...jinglePlayer, player: 'jingle-player', gain: 1 }, 'jingle-player');
        if (plan) sources.push(plan);
    }
    (diagnostics.overlays?.overlayDropSources || []).forEach((source, idx) => {
        const plan = normalizeRustPcmPlanSource({ ...source, player: `overlay-${idx + 1}` }, `overlay-${idx + 1}`);
        if (plan) sources.push(plan);
    });
    if ((generalPrefs.cartwallOutputMode || 'master') === 'master') {
        (diagnostics.overlays?.cartwallSources || []).forEach((source, idx) => {
            const plan = normalizeRustPcmPlanSource({ ...source, player: `cartwall-${idx + 1}` }, `cartwall-${idx + 1}`);
            if (plan) sources.push(plan);
        });
    }

    if (sources.length === 0 && activePlayer && !isPlayerClockPaused(activePlayer) && !activePlayer.ended) {
        const activePath = getActivePlaybackFilePath();
        const activePlayerId = getPlaylistPlayerId(activePlayer) || 'player-a';
        const activeGainNode = activePlayer === playerB ? gainB : gainA;
        const activeGainValue = Number(activeGainNode?.gain?.value);
        const plan = normalizeRustPcmPlanSource({
            player: activePlayerId,
            path: activePath,
            currentTime: getPlayerClockTime(activePlayer),
            duration: activePlayer.duration,
            gain: Number.isFinite(activeGainValue) && activeGainValue > 0.002 ? activeGainValue : 1,
            active: true,
            title: getVisibleCurrentSongText()
        }, activePlayerId);
        if (plan) {
            sources.push(plan);
            if (!window._lastEncoderDirectPlayerPlan) {
                logSystem(`[ENCODER] Rust PCM usando player activo directo: ${activePlayerId}.`);
                window._lastEncoderDirectPlayerPlan = true;
            }
        }
    } else if (sources.length > 0) {
        window._lastEncoderDirectPlayerPlan = false;
    }

    const seen = new Set();
    const unique = sources.filter(source => {
        if (!source.active) return false;
        const key = `${source.player}|${source.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 8);
    const hasAudibleActiveSource = unique.some(source => source.active && Number(source.gain) > 0.002);
    if (!hasAudibleActiveSource) {
        const fallback = unique.find(source => source.active) || unique[0];
        if (fallback) fallback.gain = 1;
    }
    return unique;
}

async function syncRustPcmEncoderOnce() {
    if (!rustPcmEncoderSyncRunning || rustPcmEncoderSyncBusy) return;
    rustPcmEncoderSyncBusy = true;
    try {
        const players = buildRustPcmEncoderLiveMixPlan();
        if (players.length === 0) {
            if (!window._lastEncoderSyncEmpty) {
                logSystem("[ENCODER] Rust PCM sync: Plan vacio (silencio).");
                window._lastEncoderSyncEmpty = true;
            }
            rustPcmEncoderEmptyPlanStrikes++;
            if (rustPcmEncoderEmptyPlanStrikes >= 3) {
                const diagnostics = buildWebAudioEngineDiagnostics();
                if (isRustExclusiveAudioMode()) {
                    logSystem("[ENCODER] Rust PCM sin fuentes vivas. Modo Rust exclusivo: Web Audio no se activa como respaldo.");
                    rustPcmEncoderEmptyPlanStrikes = 0;
                    return;
                }
                logSystem("[ENCODER] Rust PCM sin fuentes vivas. Volviendo a captura master WebAudio.");
                ipcRenderer.send('encoder-request-webaudio-fallback', {
                    reason: 'rust-pcm-empty-live-plan',
                    activePlayer: diagnostics.mix?.referencePlayer || '',
                    mixPhase: diagnostics.mix?.phase || '',
                    audibleCount: diagnostics.mix?.audibleCount || 0
                });
                rustPcmEncoderEmptyPlanStrikes = 0;
                return;
            }
        } else {
            window._lastEncoderSyncEmpty = false;
            rustPcmEncoderEmptyPlanStrikes = 0;
        }
        rustPcmEncoderLastStatus = await ipcRenderer.invoke('rust-pcm-encoder-sync', {
            players,
            fx: buildRustFxSyncPlan(),
            tapPoint: getLiveEncoderTapPoint()
        });
        if (rustPcmEncoderLastStatus?.success === false) {
            logSystem(`[ENCODER] Rust PCM sync: ${rustPcmEncoderLastStatus.error || 'sin detalle'}`);
        }
    } catch (err) {
        logSystem(`[ENCODER] Rust PCM sync fallo: ${err.message || err}`);
    } finally {
        rustPcmEncoderSyncBusy = false;
    }
}

function startRustPcmEncoderSync(config = {}) {
    stopEncoderPcmCapture();
    rustPcmEncoderSyncRunning = true;
    rustPcmEncoderEmptyPlanStrikes = 0;
    liveEncoderSourceState = {
        ...config,
        active: true,
        source: 'master',
        owner: 'rustAudioEngine',
        requestedOwner: 'rustAudioEngine',
        captureProvider: 'rustAudioEngine',
        tapPoint: config.tapPoint === 'preFx' ? 'preFx' : 'postFx',
        rustPcmReady: true,
        pcmBridgeReady: true,
        captureFormat: 'pcm_s16le',
        sampleRate: Number(config.sampleRate) || Math.round(audioCtx.sampleRate || 44100),
        transport: 'ffmpeg-rust-pcm-bridge'
    };
    if (rustPcmEncoderSyncTimer) clearInterval(rustPcmEncoderSyncTimer);
    rustPcmEncoderSyncTimer = setInterval(syncRustPcmEncoderOnce, 1000);
    syncRustPcmEncoderOnce();
    setEncoderIncidentStatus('connecting');
    logSystem(`[ENCODER] Rust PCM conectado al encoder. Punto de escucha: ${getLiveEncoderTapPoint() === 'preFx' ? 'Pre-FX' : 'Post-FX'}.`);
    // FIX BUG ENCODER PRE-FX: al iniciar la captura PCM del encoder, sincronizar
    // inmediatamente el route bus=encoder con el motor Rust. Sin esta llamada,
    // el motor mantiene el atómico encoder_tap_mode con el último valor
    // conocido (que puede ser el default postFx) y `emit_encoder_pcm_chunk`
    // sigue drenando el ring postFx aunque la UI muestre "Pre-FX". El force
    // garantiza que el route se reenvíe aunque la firma del plan coincida.
    syncRustRouteContract({ force: true });
}

function stopRustPcmEncoderSync() {
    if (rustPcmEncoderSyncTimer) clearInterval(rustPcmEncoderSyncTimer);
    rustPcmEncoderSyncTimer = null;
    rustPcmEncoderSyncRunning = false;
    rustPcmEncoderSyncBusy = false;
    rustPcmEncoderLastStatus = null;
    rustPcmEncoderEmptyPlanStrikes = 0;
}

function initEncoderPcmStats(sampleRate, processorSize) {
    const now = performance.now();
    livePcmCaptureStats = {
        sampleRate,
        processorSize,
        expectedGapMs: processorSize / sampleRate * 1000,
        startedAt: now,
        lastChunkAt: 0,
        lastSummaryAt: now,
        chunks: 0,
        bytes: 0,
        maxGapMs: 0,
        gapWarnings: 0
    };
}

function flushEncoderPcmStats(reason = 'summary') {
    if (!livePcmCaptureStats || !livePcmCaptureStats.chunks) return;
    const now = performance.now();
    const elapsedSec = Math.max(0.001, (now - livePcmCaptureStats.startedAt) / 1000);
    ipcRenderer.send('encoder-health', {
        source: 'renderer-pcm',
        reason,
        chunks: livePcmCaptureStats.chunks,
        bytes: livePcmCaptureStats.bytes,
        elapsedSec,
        expectedGapMs: livePcmCaptureStats.expectedGapMs,
        maxGapMs: livePcmCaptureStats.maxGapMs,
        gapWarnings: livePcmCaptureStats.gapWarnings
    });
    livePcmCaptureStats.lastSummaryAt = now;
    livePcmCaptureStats.maxGapMs = 0;
}

function recordEncoderPcmChunk(byteLength) {
    if (!livePcmCaptureStats) return;
    const now = performance.now();
    if (livePcmCaptureStats.lastChunkAt) {
        const gapMs = now - livePcmCaptureStats.lastChunkAt;
        livePcmCaptureStats.maxGapMs = Math.max(livePcmCaptureStats.maxGapMs, gapMs);
        if (gapMs > 500) {
            livePcmCaptureStats.gapWarnings++;
            ipcRenderer.send('encoder-health', {
                source: 'renderer-pcm',
                reason: 'chunk-gap',
                gapMs,
                expectedGapMs: livePcmCaptureStats.expectedGapMs,
                chunks: livePcmCaptureStats.chunks
            });
        }
    }
    livePcmCaptureStats.lastChunkAt = now;
    livePcmCaptureStats.chunks++;
    livePcmCaptureStats.bytes += byteLength;
    if (now - livePcmCaptureStats.lastSummaryAt > 60000) flushEncoderPcmStats('minute');
}

function startMasterPcmEncoderCapture(config = {}) {
    stopEncoderPcmCapture();
    const processorSize = 4096;
    const sampleRate = Math.round(audioCtx.sampleRate || 44100);
    liveEncoderSourceState = resolveMasterEncoderSourceState(config, sampleRate);
    initEncoderPcmStats(sampleRate, processorSize);
    livePcmCaptureInput = audioCtx.createGain();
    livePcmCaptureProcessor = audioCtx.createScriptProcessor(processorSize, 2, 2);
    livePcmCaptureSilentGain = audioCtx.createGain();
    livePcmCaptureSilentGain.gain.value = 0;
    livePcmCaptureInput.connect(livePcmCaptureProcessor);
    livePcmCaptureProcessor.connect(livePcmCaptureSilentGain);
    livePcmCaptureSilentGain.connect(audioCtx.destination);
    masterNode.connect(livePcmCaptureInput);

    livePcmCaptureProcessor.onaudioprocess = (event) => {
        try {
            const input = event.inputBuffer;
            const frames = input.length;
            const left = input.getChannelData(0);
            const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
            const pcm = Buffer.allocUnsafe(frames * 4);
            for (let idx = 0; idx < frames; idx++) {
                const offset = idx * 4;
                writePcmSample(pcm, offset, left[idx]);
                writePcmSample(pcm, offset + 2, right[idx]);
            }
            recordEncoderPcmChunk(pcm.byteLength);
            ipcRenderer.send('audio-chunk', pcm);
        } catch (err) {
            logSystem(`[ERROR] Captura PCM encoder: ${err.message || err}`);
        }
    };

    ipcRenderer.send('init-ffmpeg', {
        ...config,
        ...liveEncoderSourceState,
        captureFormat: 'pcm_s16le',
        sampleRate
    });
}

ipcRenderer.on('start-audio-capture', async (e, config) => {
    try {
        setEncoderIncidentStatus('connecting');
        stopRustPcmEncoderSync();
        if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
            liveMediaRecorder.stop();
            liveMediaRecorder.stream.getTracks().forEach(t => t.stop());
            liveMediaRecorder = null;
        }
        if (liveCaptureStreamNode) {
            try { masterNode.disconnect(liveCaptureStreamNode); } catch (err) { }
            liveCaptureStreamNode = null;
        }
        stopEncoderPcmCapture();
        let captureStream;
        if (config.source === 'master') {
            startMasterPcmEncoderCapture(config);
        } else {
            captureStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: config.micId ? { exact: config.micId } : undefined } });
            livePcmCaptureSourceStream = captureStream;
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            liveMediaRecorder = new MediaRecorder(captureStream, { mimeType });
            liveMediaRecorder.ondataavailable = async (event) => { if (event.data.size > 0) ipcRenderer.send('audio-chunk', Buffer.from(await event.data.arrayBuffer())); };
            liveMediaRecorder.onerror = (event) => {
                const msg = event?.error?.message || 'Error desconocido de MediaRecorder';
                logSystem(`[ERROR] Captura encoder: ${msg}`);
                ipcRenderer.send('stop-encoder');
            };
            liveEncoderSourceState = {
                active: true,
                source: 'mic',
                owner: 'mediaInputRenderer',
                requestedOwner: 'mediaInputRenderer',
                captureProvider: 'mediaInputRenderer',
                encoderProvider: 'auto',
                rustPcmReady: false,
                fallbackReason: '',
                captureFormat: 'webm-opus',
                sampleRate: 0,
                transport: 'ffmpeg'
            };
            ipcRenderer.send('init-ffmpeg', config);
            liveMediaRecorder.start(250);
        }
        if (!isPlaybackActuallyOnAir()) setIdleBroadcastMetadata();
        logSystem(config.source === 'master' ? "[ENCODER] Iniciando transmision PCM desde master..." : "[ENCODER] Iniciando transmision desde microfono...");
    } catch (err) { setEncoderIncidentStatus('error'); logSystem(`[ERROR] Fallo al iniciar captura: ${err.message}`); ipcRenderer.send('stop-encoder'); }
});

ipcRenderer.on('start-rust-pcm-encoder-sync', (e, config) => {
    startRustPcmEncoderSync(config || {});
});

ipcRenderer.on('stop-rust-pcm-encoder-sync', () => {
    stopRustPcmEncoderSync();
});

ipcRenderer.on('stop-audio-capture', () => {
    stopRustPcmEncoderSync();
    if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
        liveMediaRecorder.stop();
        liveMediaRecorder.stream.getTracks().forEach(t => t.stop());
        liveMediaRecorder = null;
        logSystem(`${ICON_ENCODER_LABEL} Transmision detenida.`);
    }
    if (liveCaptureStreamNode) {
        try { masterNode.disconnect(liveCaptureStreamNode); } catch (err) { }
        liveCaptureStreamNode = null;
    }
    stopEncoderPcmCapture();
    liveEncoderSourceState = null;
    setEncoderIncidentStatus('disconnected');
});

ipcRenderer.on('encoder-global-status', (e, status) => {
    const btn = document.getElementById('btn-open-encoder');
    if (btn) {
        if (status === 'live') { btn.style.background = '#e74c3c'; btn.style.color = '#fff'; }
        else if (['error', 'reconnecting', 'connecting'].includes(status)) { btn.style.background = '#f39c12'; btn.style.color = '#fff'; }
        else { btn.style.background = 'transparent'; btn.style.color = '#e74c3c'; }
    }
    setEncoderIncidentStatus(status);
});

// ============================================================================
// FASE 3: MOTOR DE CARTWALL / BOTONERA AUXILIAR (El Cerebro Receptor)
// ============================================================================

let cartwallState = null;
let cwActiveTabIndex = 0;
let cartwallAudioInstances = {};
let cwPlayingTabs = new Set();
let isCartwallUndocked = false;
let cartwallInitPromise = null;
let applyingCartwallUiState = false;

let botonSeleccionado = null;
let tabSeleccionadaIndex = null;
let modoTab = 'nuevo';
let cwSavingProfile = false;
let cwSavingTab = false;

const cwGrid = document.getElementById('cw-grid');
const cwTabsContainer = document.getElementById('cw-tabs');

const cwContextMenu = document.getElementById('cw-context-menu');
const cwTabContextMenu = document.getElementById('cw-tab-context-menu');
const cwProfileMenu = document.getElementById('cw-profile-menu');
const cwProfileButton = document.getElementById('cw-profile-button');
const cwEditModal = document.getElementById('cw-edit-modal');
const cwTabModal = document.getElementById('cw-tab-modal');
const cwProfileModal = document.getElementById('cw-profile-modal');
let modoProfile = 'nuevo';

function cwExtractFirstDroppedPath(e) {
    try {
        const droppedFilePaths = getDroppedFilePaths(e.dataTransfer);
        if (droppedFilePaths.length > 0) return droppedFilePaths[0];
        if (e.dataTransfer?.types?.includes('application/json')) {
            const raw = e.dataTransfer.getData('application/json');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) return arr[0];
        }
        const txt = e.dataTransfer?.getData('text/plain');
        if (txt && txt !== 'internal_row' && txt !== 'multiple_internal_rows') return txt;
    } catch (err) { }
    return null;
}
function cwIsValidAudioPath(p) { return !!p && /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(p); }
function getRandomDarkEffectColor() {
    const palette = ['#164e3a', '#1f4b5f', '#47346b', '#61395a', '#653b2f', '#36502a', '#214a70', '#5a4630', '#285057', '#4d375f'];
    return palette[Math.floor(Math.random() * palette.length)];
}

function createEmptyCwButtons(total) {
    const botones = [];
    for (let i = 1; i <= total; i++) {
        botones.push({ id: i, label: i.toString(), file: '', type: 'audio', folder: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false, restart: false, shortcut: '' });
    }
    return botones;
}

function createCwPalette(index, rows = 5, cols = 5) {
    return { nombre: `Botonera ${index}`, rows, cols, audioOut: 'global', shortcut: '', tabBg: '#3a3f44', tabText: '#cccccc', botones: createEmptyCwButtons(rows * cols) };
}

function getActiveCwProfile() {
    if (!cartwallState?.profiles?.length) return null;
    return cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId) || cartwallState.profiles[0];
}

function updateCwProfileButton() {
    if (!cwProfileButton) return;
    const profile = getActiveCwProfile();
    cwProfileButton.innerText = `${ICON_USER_LABEL} ${profile?.name || 'Principal'}`;
}

function applyCartwallUiState(uiState, { render = true } = {}) {
    if (!uiState || !cartwallState?.profiles?.length) return;
    applyingCartwallUiState = true;
    try {
        const profile = cartwallState.profiles.find(p => p.id === uiState.activeProfileId) || cartwallState.profiles[0];
        cartwallState.activeProfileId = profile.id;
        const tabCount = Math.max(1, profile.paletas?.length || 1);
        cwActiveTabIndex = Math.max(0, Math.min(tabCount - 1, Number(uiState.activeTabIndex) || 0));
        if (render && !isCartwallUndocked && isDockedCartwallVisible()) {
            updateCwProfileButton();
            renderCartwallTabs();
            renderCartwallGrid();
        } else if (render) {
            updateCwProfileButton();
        }
    } finally {
        applyingCartwallUiState = false;
    }
}

function setCartwallUiState(partial) {
    if (applyingCartwallUiState) return;
    ipcRenderer.send('set-cartwall-ui-state', {
        activeProfileId: cartwallState?.activeProfileId,
        activeTabIndex: cwActiveTabIndex,
        ...partial
    });
}

function ensureCartwallStateShape(state) {
    if (!state.profiles || state.profiles.length === 0) {
        state.profiles = [{ id: 'default', name: 'Principal', bg: '#008c3a', text: '#ffffff', config: { outMain: 'default', outPre: 'default', keys: { stopAll: '', next: '', prev: '' } }, paletas: [createCwPalette(1)] }];
    }
    state.profiles.forEach(profile => {
        profile.config = profile.config || {};
        profile.config.outMain = profile.config.outMain || 'default';
        profile.config.outPre = profile.config.outPre || 'default';
        profile.config.keys = profile.config.keys || {};
        profile.config.keys.stopAll = profile.config.keys.stopAll || '';
        profile.config.keys.next = profile.config.keys.next || '';
        profile.config.keys.prev = profile.config.keys.prev || '';
        if (!Array.isArray(profile.paletas) || profile.paletas.length === 0) profile.paletas = [createCwPalette(1)];
        profile.paletas.forEach((paleta, index) => {
            paleta.nombre = paleta.nombre || `Botonera ${index + 1}`;
            paleta.rows = Number(paleta.rows) || 5;
            paleta.cols = Number(paleta.cols) || 5;
            paleta.audioOut = paleta.audioOut || 'global';
            paleta.shortcut = paleta.shortcut || '';
            paleta.tabBg = paleta.tabBg || '#3a3f44';
            paleta.tabText = paleta.tabText || '#cccccc';
            if (!Array.isArray(paleta.botones)) paleta.botones = [];
            const total = paleta.rows * paleta.cols;
            if (paleta.botones.length < total) paleta.botones.push(...createEmptyCwButtons(total - paleta.botones.length).map((b, i) => ({ ...b, id: paleta.botones.length + i + 1, label: (paleta.botones.length + i + 1).toString() })));
            if (paleta.botones.length > total) paleta.botones = paleta.botones.slice(0, total);
            paleta.botones.forEach((b, i) => {
                b.id = i + 1;
                b.label = b.label || String(i + 1);
                b.type = ['audio', 'time'].includes(b.type) ? b.type : 'audio';
                b.folder = b.folder || '';
                b.text = b.text || '#FFFFFF';
                b.vol = Number.isFinite(Number(b.vol)) ? Number(b.vol) : 1;
                b.loop = !!b.loop;
                b.stopOther = !!b.stopOther;
                b.overlap = !!b.overlap;
                b.restart = !!b.restart;
                b.shortcut = b.shortcut || '';
            });
        });
    });
    return state;
}

function getCwRuntimeKey(btnInfo) {
    const tabIndex = Number.isInteger(btnInfo?._cwTabIndex) ? btnInfo._cwTabIndex : cwActiveTabIndex;
    return `${tabIndex}:${btnInfo.id}`;
}

function parseCwRuntimeKey(key) {
    const [tabIndex, id] = String(key).split(':').map(Number);
    return { tabIndex, id };
}

function refreshCwPlayingTabs() {
    cwPlayingTabs = new Set(Object.entries(cartwallAudioInstances)
        .filter(([, instances]) => Array.isArray(instances) && instances.length > 0)
        .map(([key]) => parseCwRuntimeKey(key).tabIndex)
        .filter(Number.isInteger));
    renderCartwallTabs();
}

function isCwTabPlaying(tabIndex) {
    return Object.entries(cartwallAudioInstances).some(([key, instances]) => {
        return parseCwRuntimeKey(key).tabIndex === tabIndex && Array.isArray(instances) && instances.length > 0;
    });
}
async function cwAssignPathToButton(btnInfo, filePath) {
    if (!btnInfo || !cwIsValidAudioPath(filePath)) return false;
    let nombre = path.basename(filePath);
    nombre = nombre.substring(0, nombre.lastIndexOf('.')) || nombre;
    btnInfo.file = filePath;
    btnInfo.type = 'audio';
    btnInfo.folder = '';
    btnInfo.name = (nombre || '').toUpperCase();
    btnInfo.bg = getRandomDarkEffectColor();
    btnInfo.text = '#FFFFFF';
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallGrid();
    return true;
}

function isCartwallTimeButton(btnInfo) {
    return btnInfo?.type === 'time';
}

function resetCartwallButtonModeOptions(btnInfo) {
    if (!isCartwallTimeButton(btnInfo)) return;
    btnInfo.loop = false;
    btnInfo.stopOther = false;
    btnInfo.overlap = false;
    btnInfo.restart = false;
}

function getCartwallPanel() {
    return document.getElementById('right-panel-cartwall');
}

function isDockedCartwallVisible() {
    const panel = getCartwallPanel();
    return !!panel && panel.style.display !== 'none';
}

async function openCartwallFloating() {
    await initCartwall();
    const panel = getCartwallPanel();
    if (panel) panel.style.display = 'none';
    isCartwallUndocked = true;
    setCartwallUiState({ mode: 'floating' });
    ipcRenderer.send('open-cartwall-window');
}

ipcRenderer.on('menu-toggle-cartwall', async (e, show) => {
    if (isCartwallUndocked) return;
    const panel = getCartwallPanel();
    if (!panel) return;
    if (show) {
        await initCartwall({ forceRender: true });
        panel.style.display = 'flex';
        setCartwallUiState({ mode: 'docked' });
        return;
    }
    panel.style.display = 'none';
    setCartwallUiState({ mode: 'hidden' });
});

document.getElementById('btn-undock-cartwall').addEventListener('click', () => {
    openCartwallFloating();
});

if (cwProfileButton) {
    cwProfileButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAllMenus();
        buildCwProfileMenu();
        const rect = cwProfileButton.getBoundingClientRect();
        positionFloatingMenu(cwProfileMenu, rect.left, rect.bottom + 4);
    });
}

ipcRenderer.on('cartwall-docked', async () => {
    isCartwallUndocked = false;
    await initCartwall({ forceRender: true });
    const panel = getCartwallPanel();
    if (panel) panel.style.display = 'flex';
    setCartwallUiState({ mode: 'docked' });
});

ipcRenderer.on('cartwall-floating-closed', () => {
    isCartwallUndocked = false;
    setCartwallUiState({ mode: isDockedCartwallVisible() ? 'docked' : 'hidden' });
});

ipcRenderer.on('sync-cartwall-state', () => {
    cartwallInitPromise = null;
    cartwallState = null;
    if (!isCartwallUndocked && !isDockedCartwallVisible()) return;
    initCartwall({ forceRender: isDockedCartwallVisible() });
});

ipcRenderer.on('cartwall-ui-state', async (e, uiState) => {
    if (!cartwallState) await initCartwall();
    applyCartwallUiState(uiState, { render: true });
});


function createCwProfile(name) {
    return { id: `profile_${Date.now()}_${Math.random().toString(16).slice(2)}`, name: name || 'Nuevo Perfil', bg: '#008c3a', text: '#ffffff', config: { outMain: 'default', outPre: 'default', keys: { stopAll: '', next: '', prev: '' } }, paletas: [createCwPalette(1)] };
}

async function saveCartwallStateAndRefresh() {
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallTabs();
    renderCartwallGrid();
    updateCwProfileButton();
}

function stopAllCartwallAudio() {
    Object.keys(cartwallAudioInstances).forEach(key => stopCartwallAudio(key));
}

function openCwProfileModal(mode) {
    const profile = getActiveCwProfile();
    modoProfile = mode;
    document.getElementById('cw-profile-modal-title').innerText = mode === 'editar' ? 'Editar Perfil' : 'Nuevo Perfil';
    document.getElementById('cw-profile-name').value = mode === 'editar' ? (profile?.name || 'Perfil') : `Perfil ${cartwallState.profiles.length + 1}`;
    document.getElementById('cw-profile-text-color').value = mode === 'editar' ? (profile?.text || '#ffffff') : '#ffffff';
    hideAllMenus();
    cwProfileModal.style.display = 'flex';
    cwProfileModal.tabIndex = -1;
    setTimeout(() => {
        cwProfileModal.focus();
        document.getElementById('cw-profile-name')?.select();
    }, 0);
}

async function saveCwProfileModal() {
    if (cwSavingProfile) return;
    cwSavingProfile = true;
    try {
        const name = document.getElementById('cw-profile-name').value.trim() || 'Perfil';
        const text = document.getElementById('cw-profile-text-color').value || '#ffffff';
        closeCwProfileModal();
        if (modoProfile === 'nuevo') {
            stopAllCartwallAudio();
            const profile = createCwProfile(name);
            profile.text = text;
            cartwallState.profiles.push(profile);
            cartwallState.activeProfileId = profile.id;
            cwActiveTabIndex = 0;
        } else {
            const profile = getActiveCwProfile();
            if (profile) {
                profile.name = name;
                profile.text = text;
            }
        }
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
    } finally {
        cwSavingProfile = false;
    }
}

async function switchCwProfile(profileId) {
    if (profileId === cartwallState.activeProfileId) return;
    stopAllCartwallAudio();
    cartwallState.activeProfileId = profileId;
    cwActiveTabIndex = 0;
    await saveCartwallStateAndRefresh();
    setCartwallUiState({ activeProfileId: profileId, activeTabIndex: 0 });
}

function buildCwProfileMenu() {
    if (!cwProfileMenu || !cartwallState) return;
    const active = getActiveCwProfile();
    cwProfileMenu.innerHTML = '';
    const addItem = (label, onClick, className = '') => {
        const item = document.createElement('div');
        item.className = `context-item ${className}`;
        item.innerText = label;
        item.onclick = async () => { hideAllMenus(); await onClick(); };
        cwProfileMenu.appendChild(item);
        return item;
    };
    const sep = () => { const el = document.createElement('div'); el.className = 'context-separator'; cwProfileMenu.appendChild(el); };
    addItem(`${ICON_USER_LABEL} ${active?.name || 'Principal'}`, async () => { }, 'cw-profile-current');
    sep();
    addItem('Nuevo Perfil...', async () => openCwProfileModal('nuevo'));
    addItem('Editar Perfil actual...', async () => openCwProfileModal('editar'));
    sep();
    addItem('Importar Perfil (.bdeplf)', async () => {
        const imported = await ipcRenderer.invoke('importar-bdeplf');
        if (!imported) return;
        imported.id = `profile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        imported.name = imported.name || 'Perfil importado';
        if (!Array.isArray(imported.paletas) || imported.paletas.length === 0) imported.paletas = [createCwPalette(1)];
        cartwallState.profiles.push(imported);
        cartwallState.activeProfileId = imported.id;
        cwActiveTabIndex = 0;
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: imported.id, activeTabIndex: 0 });
    });
    addItem('Exportar Perfil (.bdeplf)', async () => {
        await ipcRenderer.invoke('exportar-bdeplf', getActiveCwProfile());
    });
    sep();
    addItem('Eliminar Perfil actual', async () => {
        if (cartwallState.profiles.length <= 1) { alert('No puedes eliminar el unico perfil.'); return; }
        const profile = getActiveCwProfile();
        const ok = await ipcRenderer.invoke('dialog:confirm', `Seguro que deseas eliminar el perfil "${profile.name}"?`);
        if (!ok) return;
        stopAllCartwallAudio();
        cartwallState.profiles = cartwallState.profiles.filter(p => p.id !== profile.id);
        cartwallState.activeProfileId = cartwallState.profiles[0].id;
        cwActiveTabIndex = 0;
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: 0 });
    }, 'danger');
    sep();
    cartwallState.profiles.forEach(profile => {
        const item = addItem(profile.name || 'Perfil', async () => switchCwProfile(profile.id), profile.id === cartwallState.activeProfileId ? 'cw-profile-current' : '');
        if (profile.text) item.style.color = profile.text;
    });
}
async function initCartwall({ forceRender = false } = {}) {
    if (!cartwallInitPromise) {
        cartwallInitPromise = (async () => {
            let nextState = await ipcRenderer.invoke('get-cartwall-profiles');
            if (!nextState || !nextState.profiles || nextState.profiles.length === 0) {
                nextState = {
                    activeProfileId: 'default',
                    profiles: [{
                        id: 'default', name: 'Principal', bg: '#008c3a', text: '#ffffff',
                        paletas: [createCwPalette(1)]
                    }]
                };
                await ipcRenderer.invoke('save-cartwall-profiles', nextState);
            }
            cartwallState = ensureCartwallStateShape(nextState);
            const uiState = await ipcRenderer.invoke('get-cartwall-ui-state');
            applyCartwallUiState(uiState, { render: false });
            return cartwallState;
        })();
    }

    await cartwallInitPromise;
    if (forceRender && !isCartwallUndocked) {
        updateCwProfileButton();
        renderCartwallTabs();
        renderCartwallGrid();
    }
    return cartwallState;
}

function getActiveCwPalette() {
    const profile = getActiveCwProfile();
    if (!profile || profile.paletas.length === 0) return null;
    if (cwActiveTabIndex >= profile.paletas.length) cwActiveTabIndex = 0;
    return profile.paletas[cwActiveTabIndex];
}

async function addCartwallTab() {
    const profile = getActiveCwProfile();
    if (!profile) return;
    modoTab = 'nuevo';
    tabSeleccionadaIndex = null;
    document.getElementById('cw-tab-modal-title').innerText = 'Nueva Botonera';
    document.getElementById('cw-tab-name').value = `Botonera ${profile.paletas.length + 1}`;
    document.getElementById('cw-tab-v').value = 5;
    document.getElementById('cw-tab-h').value = 5;
    document.getElementById('cw-tab-bg-color').value = '#3a3f44';
    document.getElementById('cw-tab-text-color').value = '#cccccc';
    hideAllMenus();
    cwTabModal.style.display = 'flex';
    cwTabModal.tabIndex = -1;
    setTimeout(() => cwTabModal.focus(), 0);
}

function renderCartwallTabs() {
    if (!cwTabsContainer) return;
    updateCwProfileButton();
    cwTabsContainer.innerHTML = '';
    const profile = getActiveCwProfile();
    if (!profile) return;
    profile.paletas.forEach((paleta, index) => {
        let tab = document.createElement('div');
        tab.className = `cw-tab ${index === cwActiveTabIndex ? 'active' : ''} ${cwPlayingTabs.has(index) && index !== cwActiveTabIndex ? 'cw-tab-playing' : ''}`;
        tab.innerText = paleta.nombre;
        tab.onclick = () => {
            cwActiveTabIndex = index;
            renderCartwallTabs();
            renderCartwallGrid();
            setCartwallUiState({ activeTabIndex: index });
        };

        tab.oncontextmenu = (e) => {
            e.preventDefault();
            tabSeleccionadaIndex = index;
            hideAllMenus();
            positionFloatingMenu(cwTabContextMenu, e.clientX, e.clientY);
        };

        cwTabsContainer.appendChild(tab);
    });
    const addTab = document.createElement('div');
    addTab.className = 'cw-tab cw-tab-add';
    addTab.innerText = '+';
    addTab.title = 'Agregar botonera';
    addTab.onclick = addCartwallTab;
    cwTabsContainer.appendChild(addTab);
}

function closeCwTabModal() {
    cwTabModal.style.display = 'none';
}

function closeCwEditModal() {
    cwEditModal.style.display = 'none';
}

function closeCwProfileModal() {
    cwProfileModal.style.display = 'none';
}

function handleCartwallModalKeydown(event, acceptFn, cancelFn) {
    if (event.key === 'Escape') {
        event.preventDefault();
        cancelFn();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        acceptFn();
    }
}

function formatCwTime(seconds) {
    if (isNaN(seconds)) return "00:00"; const m = Math.floor(seconds / 60).toString().padStart(2, '0'); const s = Math.floor(seconds % 60).toString().padStart(2, '0'); return `${m}:${s}`;
}

function getCartwallButtonReadyText(btnInfo) {
    return (btnInfo?.file || (isCartwallTimeButton(btnInfo) && btnInfo.folder)) ? 'LISTO' : '';
}

function refreshCartwallModeMenu(btnInfo) {
    const disabled = isCartwallTimeButton(btnInfo);
    ['menu-bucle', 'menu-overlap', 'menu-restart', 'menu-detener'].forEach(id => {
        const item = document.getElementById(id);
        if (item) item.classList.toggle('context-disabled', disabled);
    });
}

function renderCartwallGrid() {
    if (!cwGrid) return;
    cwGrid.innerHTML = '';
    const paleta = getActiveCwPalette();
    if (!paleta) return;

    cwGrid.style.gridTemplateColumns = `repeat(${paleta.cols}, minmax(0, 1fr))`;
    cwGrid.style.gridTemplateRows = `repeat(${paleta.rows}, minmax(0, 1fr))`;

    paleta.botones.forEach(btnInfo => {
        Object.defineProperty(btnInfo, '_cwTabIndex', { value: cwActiveTabIndex, configurable: true, writable: true });
        btnInfo.type = ['audio', 'time'].includes(btnInfo.type) ? btnInfo.type : 'audio';
        btnInfo.folder = btnInfo.folder || '';
        resetCartwallButtonModeOptions(btnInfo);
        const runtimeKey = getCwRuntimeKey(btnInfo);
        let btn = document.createElement('div');
        btn.className = 'cw-grid-item';
        btn.id = `cw-btn-${btnInfo.id}`;
        if (btnInfo.bg) btn.style.backgroundColor = btnInfo.bg;
        if (btnInfo.text) btn.style.color = btnInfo.text;

        btn.innerHTML = `<span class="cw-index">${btnInfo.id}</span><span class="cw-name">${btnInfo.name || ''}</span><span class="cw-timer" id="cw-timer-${btnInfo.id}">${getCartwallButtonReadyText(btnInfo)}</span><div class="cw-progress-container"><div class="cw-progress-bar" id="cw-progress-${btnInfo.id}"></div></div>`;

        btn.onclick = () => handleCartwallPlay(btnInfo, btn);
        btn.draggable = true;
        btn.addEventListener('dragstart', (e) => {
            if (!e.ctrlKey || !getCartwallButtonReadyText(btnInfo)) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-lf-cartwall-button', JSON.stringify({ tabIndex: cwActiveTabIndex, id: btnInfo.id }));
        });

        // Soporta clic derecho entre botones: usa el Ãºltimo hover
        btn.addEventListener('mouseenter', () => { botonSeleccionado = btnInfo; });

        btn.oncontextmenu = (e) => {
            e.preventDefault(); e.stopPropagation();
            botonSeleccionado = btnInfo;
            hideAllMenus();
            document.getElementById('check-bucle').innerText = btnInfo.loop ? '✓' : '';
            document.getElementById('check-detener').innerText = btnInfo.stopOther ? '✓' : '';
            document.getElementById('check-overlap').innerText = btnInfo.overlap ? '✓' : '';
            document.getElementById('check-restart').innerText = btnInfo.restart ? '✓' : '';
            refreshCartwallModeMenu(btnInfo);

            positionFloatingMenu(cwContextMenu, e.clientX, e.clientY);
        };

        btn.addEventListener('dragenter', (e) => { e.preventDefault(); btn.classList.add('cw-drag-over'); });
        btn.addEventListener('dragover', (e) => { e.preventDefault(); btn.classList.add('cw-drag-over'); });
        btn.addEventListener('dragleave', () => btn.classList.remove('cw-drag-over'));
        btn.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation(); btn.classList.remove('cw-drag-over');
            const movedRaw = e.dataTransfer?.getData('application/x-lf-cartwall-button');
            if (movedRaw) {
                const moved = JSON.parse(movedRaw);
                await moveCartwallButton(moved.tabIndex, moved.id, cwActiveTabIndex, btnInfo.id);
                return;
            }
            const p = cwExtractFirstDroppedPath(e);
            await cwAssignPathToButton(btnInfo, p);
        });

        cwGrid.appendChild(btn);

        if (cartwallAudioInstances[runtimeKey] && cartwallAudioInstances[runtimeKey].length > 0) {
            btn.classList.add('cw-playing');
        }
    });
}

// Drop/clic derecho sobre el fondo del grid (entre botones)
if (cwGrid) {
    cwGrid.addEventListener('contextmenu', (e) => {
        if (e.target && e.target.closest('.cw-grid-item')) return;
        if (!botonSeleccionado) return;
        e.preventDefault(); e.stopPropagation();
        hideAllMenus();
        document.getElementById('check-bucle').innerText = botonSeleccionado.loop ? '✓' : '';
        document.getElementById('check-detener').innerText = botonSeleccionado.stopOther ? '✓' : '';
        document.getElementById('check-overlap').innerText = botonSeleccionado.overlap ? '✓' : '';
        document.getElementById('check-restart').innerText = botonSeleccionado.restart ? '✓' : '';
        refreshCartwallModeMenu(botonSeleccionado);
        positionFloatingMenu(cwContextMenu, e.clientX, e.clientY);
    });

    cwGrid.addEventListener('drop', async (e) => {
        if (e.target && e.target.closest('.cw-grid-item')) return;
        e.preventDefault(); e.stopPropagation();
        const p = cwExtractFirstDroppedPath(e);
        if (!cwIsValidAudioPath(p)) return;
        const paleta = getActiveCwPalette();
        if (!paleta) return;
        const firstEmpty = paleta.botones.find(b => !b.file);
        if (firstEmpty) await cwAssignPathToButton(firstEmpty, p);
        else if (botonSeleccionado) await cwAssignPathToButton(botonSeleccionado, p);
    });

    cwGrid.addEventListener('dragover', (e) => { e.preventDefault(); });
}

function handleCartwallPlay(btnInfo, btnDOM) {
    const runtimeKey = getCwRuntimeKey(btnInfo);
    const { tabIndex, id } = parseCwRuntimeKey(runtimeKey);
    if (isCartwallTimeButton(btnInfo)) {
        if (cartwallAudioInstances[runtimeKey] && cartwallAudioInstances[runtimeKey].length > 0) {
            stopCartwallAudio(runtimeKey);
            return;
        }
        handleCartwallTimePlay(btnInfo, btnDOM, runtimeKey, tabIndex, id);
        return;
    }
    if (!btnInfo.file) return;

    if (cartwallAudioInstances[runtimeKey] && cartwallAudioInstances[runtimeKey].length > 0) {
        if (btnInfo.restart) {
            stopCartwallAudio(runtimeKey);
        } else
            if (!btnInfo.overlap) {
                stopCartwallAudio(runtimeKey);
                return;
            }
    }

    if (btnInfo.stopOther) {
        for (let key in cartwallAudioInstances) {
            if (key !== runtimeKey) stopCartwallAudio(key);
        }
    }

    playCartwallButtonViaRust({ btnInfo, btnDOM, runtimeKey, tabIndex, id });
}

// Determina el bus y outputId de Rust para el cartwall según el modo de salida.
// Todos los modos tienen path Rust nativo — no hay fallback a Web Audio.
function getRustCartwallBusAndOutput() {
    const mode = generalPrefs.cartwallOutputMode || 'master';
    switch (mode) {
        case 'cue':
            return { bus: 'cue', outputId: generalPrefs.outCue || 'default' };
        case 'device': {
            // 'cartwall-independent' NO está en is_program_bus() → el player se
            // conecta directamente al sink del dispositivo independiente, sin
            // pasar por el program_mixer ni por la cadena DSP del master.
            const deviceId = generalPrefs.outCartwall || 'default';
            return { bus: 'cartwall-independent', outputId: deviceId };
        }
        case 'monitor':
            // 'monitor-direct' NO está en is_program_bus() → load_audio_player()
            // llama ensure_output(monitorDeviceId) y conecta el player directo al
            // mixer del sink de monitor, sin program_mixer ni cadena DSP.
            return { bus: 'monitor-direct', outputId: generalPrefs.outMonitor || 'default' };
        default: // 'master'
            return { bus: 'cartwall', outputId: 'default' };
    }
}

function shouldRustOwnCartwallButton(btnInfo = {}) {
    // Rust es ahora el unico motor — el flag queda como compatibilidad para
    // callers que aun preguntan, pero la respuesta es siempre afirmativa salvo
    // el boton de hora (tiene su propio path) o un boton sin archivo.
    if (!shouldMirrorRustControlPlane()) return false;
    if (!btnInfo.file) return false;
    if (isCartwallTimeButton(btnInfo)) return false;
    return true;
}

function buildRustCartwallPlayerId(runtimeKey = '') {
    return `cartwall-${String(runtimeKey || '').replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}`;
}

async function playCartwallButtonViaRust({ btnInfo, btnDOM, runtimeKey, tabIndex, id }) {
    const affectsProgram = generalPrefs.cartwallOutputMode === 'master';
    const busAndOutput = getRustCartwallBusAndOutput();
    const rustPlayerId = buildRustCartwallPlayerId(runtimeKey);
    const runtimeItem = {
        audio: null,
        source: null,
        rustOnly: true,
        rustPlayerId,
        affectsProgram,
        tabIndex,
        id,
        key: runtimeKey,
        btnInfo,
        sourcePath: btnInfo.file,
        cartwallBus: busAndOutput.bus,
        cartwallOutputId: busAndOutput.outputId,
        loop: btnInfo.loop === true,
        restartPending: false,
        stopped: false
    };

    if (affectsProgram) {
        activePisadores++;
        if (activePisadores === 1) applyDucking();
    }
    if (!cartwallAudioInstances[runtimeKey]) cartwallAudioInstances[runtimeKey] = [];
    cartwallAudioInstances[runtimeKey].push(runtimeItem);
    if (btnDOM && tabIndex === cwActiveTabIndex) btnDOM.classList.add('cw-playing');
    ipcRenderer.send('cartwall-play-state', { id, tabIndex, state: 'playing' });
    refreshCwPlayingTabs();

    const result = await playRustCartwallRuntimeItem(runtimeItem);
    if (result?.ok) return;

    cartwallAudioInstances[runtimeKey] = (cartwallAudioInstances[runtimeKey] || []).filter(item => item !== runtimeItem);
    if (affectsProgram) {
        activePisadores--;
        if (activePisadores <= 0) { activePisadores = 0; removeDucking(); }
    }
    if (btnDOM && tabIndex === cwActiveTabIndex) btnDOM.classList.remove('cw-playing');
    ipcRenderer.send('cartwall-play-state', { id, tabIndex, state: 'stopped', tabPlaying: isCwTabPlaying(tabIndex) });
    refreshCwPlayingTabs();
    logSystem(`[CARTWALL] Rust no pudo reproducir ${btnInfo.name || btnInfo.label || 'boton'}: ${result?.error || 'sin detalle'}`);
}

function playRustCartwallRuntimeItem(runtimeItem) {
    if (!runtimeItem?.rustPlayerId || !runtimeItem.sourcePath) {
        return Promise.resolve({ ok: false, error: 'Runtime Rust cartwall incompleto.' });
    }
    return commandRustControlPlane('cartwallPlay', {
        player: runtimeItem.rustPlayerId,
        bus: runtimeItem.cartwallBus || 'cartwall',
        outputId: runtimeItem.cartwallOutputId || 'default',
        path: runtimeItem.sourcePath,
        gain: runtimeItem.btnInfo?.vol ?? 1,
        autoplay: true
    });
}

function handleCartwallTimePlay(btnInfo, btnDOM, runtimeKey, tabIndex, id) {
    const filesToPlay = resolveTimeLocutionFiles(btnInfo.folder);
    if (filesToPlay.length === 0) {
        logSystem('[CARTWALL] Locucion de hora sin archivos validos.');
        return;
    }
    playCartwallTimeButtonViaRust({ btnInfo, btnDOM, runtimeKey, tabIndex, id, filesToPlay });
}

async function playCartwallTimeButtonViaRust({ btnInfo, btnDOM, runtimeKey, tabIndex, id, filesToPlay }) {
    const affectsProgram = generalPrefs.cartwallOutputMode === 'master';
    const busAndOutput = getRustCartwallBusAndOutput();
    const runtimeItem = {
        audio: null,
        source: null,
        rustOnly: true,
        rustPlayerId: buildRustCartwallPlayerId(runtimeKey),
        affectsProgram,
        tabIndex,
        id,
        key: runtimeKey,
        btnInfo,
        timeSequence: true,
        filesToPlay,
        currentIndex: 0,
        stopped: false,
        sourcePath: filesToPlay[0] || '',
        cartwallBus: busAndOutput.bus,
        cartwallOutputId: busAndOutput.outputId
    };
    cartwallAudioInstances[runtimeKey] = [runtimeItem];
    if (affectsProgram) {
        activePisadores++;
        if (activePisadores === 1) applyDucking();
    }
    if (btnDOM && tabIndex === cwActiveTabIndex) btnDOM.classList.add('cw-playing');
    ipcRenderer.send('cartwall-play-state', { id, tabIndex, state: 'playing' });
    refreshCwPlayingTabs();
    const result = await playRustCartwallRuntimeItem(runtimeItem);
    if (result?.ok) return;
    finishCartwallRuntimeItem(runtimeItem);
    logSystem(`[CARTWALL] Rust no pudo reproducir locucion de hora: ${result?.error || 'sin detalle'}`);
}

function finishCartwallRuntimeItem(runtimeItem) {
    if (!runtimeItem) return;
    const endedKey = runtimeItem.key;
    const endedTabIndex = runtimeItem.tabIndex;
    const endedId = runtimeItem.id;
    if (runtimeItem.rustOnly && runtimeItem.rustPlayerId) {
        commandRustControlPlane('cartwallStop', { player: runtimeItem.rustPlayerId }).catch(() => { });
    }
    cartwallAudioInstances[endedKey] = (cartwallAudioInstances[endedKey] || []).filter(item => item !== runtimeItem);
    if ((cartwallAudioInstances[endedKey] || []).length === 0) delete cartwallAudioInstances[endedKey];
    if (runtimeItem.affectsProgram) {
        activePisadores--;
        if (activePisadores <= 0) { activePisadores = 0; removeDucking(); }
    }
    if (!isCartwallUndocked && endedTabIndex === cwActiveTabIndex) {
        const btnDOM = document.getElementById(`cw-btn-${endedId}`);
        if (btnDOM) btnDOM.classList.remove('cw-playing');
        const pb = document.getElementById(`cw-progress-${endedId}`);
        const tt = document.getElementById(`cw-timer-${endedId}`);
        if (pb) pb.style.width = '0%';
        if (tt) tt.innerText = getCartwallButtonReadyText(runtimeItem.btnInfo);
    }
    ipcRenderer.send('cartwall-play-state', { id: endedId, tabIndex: endedTabIndex, state: 'stopped', tabPlaying: isCwTabPlaying(endedTabIndex) });
    refreshCwPlayingTabs();
}

function reconcileRustCartwallRuntimeStatus(status = {}) {
    const rustPlayers = new Map((Array.isArray(status?.players) ? status.players : []).map(player => [player?.id, player]));
    Object.values(cartwallAudioInstances || {}).forEach(instances => {
        if (!Array.isArray(instances)) return;
        instances.slice().forEach(item => {
            if (!item?.rustOnly || !item.rustPlayerId || item.stopped) return;
            const rustPlayer = rustPlayers.get(item.rustPlayerId);
            if (!rustPlayer) return;
            if (rustPlayer.status === 'ended' || rustPlayer.status === 'stopped') {
                handleRustCartwallRuntimeEnded(item);
                return;
            }
            // Actualizar barra de progreso desde el status push de 100ms.
            // `positionMs` y `durationMs` son emitidos por el motor Rust para
            // todos los players (durationMs leído del decoder al cargar).
            const posSec = (rustPlayer.positionMs || 0) / 1000;
            const durSec = (rustPlayer.durationMs || 0) / 1000;
            if (durSec > 0 && !isCartwallUndocked && item.tabIndex === cwActiveTabIndex) {
                const pb = document.getElementById(`cw-progress-${item.id}`);
                const tt = document.getElementById(`cw-timer-${item.id}`);
                if (pb) pb.style.width = `${Math.min(100, (posSec / durSec) * 100)}%`;
                if (tt) tt.innerText = `${formatCwTime(posSec)} / ${formatCwTime(durSec)}`;
                ipcRenderer.send('cartwall-progress', { id: item.id, tabIndex: item.tabIndex, currentTime: posSec, duration: durSec });
            }
        });
    });
}

function handleRustCartwallRuntimeEnded(runtimeItem) {
    if (!runtimeItem || runtimeItem.stopped) return;
    const endedPlayerId = runtimeItem.rustPlayerId;
    if (runtimeItem.timeSequence) {
        runtimeItem.currentIndex = (Number(runtimeItem.currentIndex) || 0) + 1;
        const nextPath = runtimeItem.filesToPlay?.[runtimeItem.currentIndex];
        if (!nextPath) {
            finishCartwallRuntimeItem(runtimeItem);
            return;
        }
        commandRustControlPlane('cartwallStop', { player: endedPlayerId }).catch(() => { });
        runtimeItem.rustPlayerId = buildRustCartwallPlayerId(runtimeItem.key);
        runtimeItem.sourcePath = nextPath;
        playRustCartwallRuntimeItem(runtimeItem).then(result => {
            if (!result?.ok) finishCartwallRuntimeItem(runtimeItem);
        }).catch(() => finishCartwallRuntimeItem(runtimeItem));
        return;
    }
    if (runtimeItem.loop) {
        if (runtimeItem.restartPending) return;
        runtimeItem.restartPending = true;
        commandRustControlPlane('cartwallStop', { player: endedPlayerId }).catch(() => { });
        runtimeItem.rustPlayerId = buildRustCartwallPlayerId(runtimeItem.key);
        playRustCartwallRuntimeItem(runtimeItem).then(result => {
            runtimeItem.restartPending = false;
            if (!result?.ok) finishCartwallRuntimeItem(runtimeItem);
        }).catch(() => {
            runtimeItem.restartPending = false;
            finishCartwallRuntimeItem(runtimeItem);
        });
        return;
    }
    finishCartwallRuntimeItem(runtimeItem);
}

function stopCartwallAudio(target) {
    const targetKey = typeof target === 'object' && target ? getCwRuntimeKey(target) : String(target);
    const keys = targetKey.includes(':')
        ? [targetKey]
        : Object.keys(cartwallAudioInstances).filter(key => key === targetKey || key.endsWith(`:${targetKey}`));

    keys.forEach(key => {
        const { tabIndex, id } = parseCwRuntimeKey(key);
        if (cartwallAudioInstances[key]) {
            cartwallAudioInstances[key].forEach(item => {
                item.stopped = true;
                if (item.audio) {
                    item.audio.pause();
                    item.audio.currentTime = 0;
                    item.audio.src = '';
                }
                if (item.source) item.source.disconnect();
                if (item.rustOnly && item.rustPlayerId) {
                    commandRustControlPlane('cartwallStop', { player: item.rustPlayerId }).catch(() => { });
                }

                if (item.affectsProgram) {
                    activePisadores--;
                    if (activePisadores <= 0) { activePisadores = 0; removeDucking(); }
                }
            });
            cartwallAudioInstances[key] = [];
        }
        if (!isCartwallUndocked && tabIndex === cwActiveTabIndex) {
            const btnDOM = document.getElementById(`cw-btn-${id}`);
            if (btnDOM) btnDOM.classList.remove('cw-playing');
            const pb = document.getElementById(`cw-progress-${id}`);
            const tt = document.getElementById(`cw-timer-${id}`);
            if (pb) pb.style.width = '0%';
            if (tt) {
                const paleta = getActiveCwPalette();
                const btnInfo = paleta ? paleta.botones.find(b => b.id == id) : null;
                tt.innerText = getCartwallButtonReadyText(btnInfo);
            }
        }
        ipcRenderer.send('cartwall-play-state', { id, tabIndex, state: 'stopped', tabPlaying: isCwTabPlaying(tabIndex) });
    });
    refreshCwPlayingTabs();
}

function stopCartwallTabAudio(tabIndex) {
    Object.keys(cartwallAudioInstances).forEach(key => {
        if (parseCwRuntimeKey(key).tabIndex === tabIndex) stopCartwallAudio(key);
    });
}

function hasConfiguredCartwallEffects(paleta) {
    return !!paleta && Array.isArray(paleta.botones) && paleta.botones.some(btn => !!btn.file);
}

async function confirmDeleteCartwallTab(paleta) {
    if (!hasConfiguredCartwallEffects(paleta)) return true;
    return await ipcRenderer.invoke('dialog:confirm', `La botonera "${paleta.nombre}" tiene efectos cargados. Seguro que deseas eliminarla?`);
}
// LÃ“GICA DE MENÃšS Y MODALES DEL CARTWALL EN PANTALLA PRINCIPAL
function createEmptyCwButtonForSlot(id) {
    return { id, label: String(id), file: '', type: 'audio', folder: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false, restart: false, shortcut: '' };
}

function moveCartwallRuntime(fromTabIndex, fromId, toTabIndex, toId) {
    const oldKey = `${fromTabIndex}:${fromId}`;
    const newKey = `${toTabIndex}:${toId}`;
    if (oldKey === newKey || !cartwallAudioInstances[oldKey]?.length) return;
    if (cartwallAudioInstances[newKey]?.length) stopCartwallAudio(newKey);
    cartwallAudioInstances[newKey] = cartwallAudioInstances[oldKey];
    cartwallAudioInstances[newKey].forEach(item => { item.tabIndex = toTabIndex; item.id = toId; item.key = newKey; });
    delete cartwallAudioInstances[oldKey];
    ipcRenderer.send('cartwall-play-state', { id: fromId, tabIndex: fromTabIndex, state: 'stopped', tabPlaying: isCwTabPlaying(fromTabIndex) });
    ipcRenderer.send('cartwall-play-state', { id: toId, tabIndex: toTabIndex, state: 'playing' });
    refreshCwPlayingTabs();
}

async function moveCartwallButton(fromTabIndex, fromId, toTabIndex, toId, { save = true, moveRuntime = true } = {}) {
    const profile = getActiveCwProfile();
    const fromPalette = profile?.paletas?.[fromTabIndex];
    const toPalette = profile?.paletas?.[toTabIndex];
    if (!fromPalette || !toPalette || (fromTabIndex === toTabIndex && fromId === toId)) return false;
    const source = fromPalette.botones.find(btn => btn.id === fromId);
    const target = toPalette.botones.find(btn => btn.id === toId);
    if (!source || !target || !source.file) return false;
    if (moveRuntime) moveCartwallRuntime(fromTabIndex, fromId, toTabIndex, toId);
    else if (cartwallAudioInstances[`${toTabIndex}:${toId}`]?.length) stopCartwallAudio(`${toTabIndex}:${toId}`);
    const moved = { ...source, id: target.id, label: target.label || String(target.id) };
    Object.assign(target, moved);
    Object.assign(source, createEmptyCwButtonForSlot(source.id));
    if (save) await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallGrid();
    return true;
}
document.getElementById('menu-editar').addEventListener('click', () => {
    botonSeleccionado.type = ['audio', 'time'].includes(botonSeleccionado.type) ? botonSeleccionado.type : 'audio';
    document.getElementById('cw-edit-type').value = botonSeleccionado.type;
    document.getElementById('cw-edit-filepath').value = botonSeleccionado.type === 'time' ? (botonSeleccionado.folder || '') : (botonSeleccionado.file || '');
    document.getElementById('cw-edit-name').value = botonSeleccionado.name || '';
    document.getElementById('cw-edit-volume').value = botonSeleccionado.vol || 1;
    document.getElementById('cw-edit-bg-color').value = botonSeleccionado.bg || '#444444';
    document.getElementById('cw-edit-text-color').value = botonSeleccionado.text || '#FFFFFF';
    hideAllMenus();
    cwEditModal.style.display = 'flex';
    cwEditModal.tabIndex = -1;
    setTimeout(() => cwEditModal.focus(), 0);
});

document.getElementById('menu-limpiar').addEventListener('click', () => {
    stopCartwallAudio(botonSeleccionado);
    botonSeleccionado.file = ''; botonSeleccionado.folder = ''; botonSeleccionado.type = 'audio'; botonSeleccionado.name = ''; botonSeleccionado.bg = ''; botonSeleccionado.overlap = false; botonSeleccionado.restart = false;
    ipcRenderer.invoke('save-cartwall-profiles', cartwallState); renderCartwallGrid(); hideAllMenus();
});

document.getElementById('menu-bucle').addEventListener('click', () => { if (isCartwallTimeButton(botonSeleccionado)) return; botonSeleccionado.loop = !botonSeleccionado.loop; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllMenus(); });
document.getElementById('menu-detener').addEventListener('click', () => { if (isCartwallTimeButton(botonSeleccionado)) return; botonSeleccionado.stopOther = !botonSeleccionado.stopOther; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllMenus(); });
document.getElementById('menu-overlap').addEventListener('click', () => { if (isCartwallTimeButton(botonSeleccionado)) return; botonSeleccionado.overlap = !botonSeleccionado.overlap; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllMenus(); });
document.getElementById('menu-restart').addEventListener('click', () => { if (isCartwallTimeButton(botonSeleccionado)) return; botonSeleccionado.restart = !botonSeleccionado.restart; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllMenus(); });

document.getElementById('menu-previa').addEventListener('click', () => {
    if (botonSeleccionado.file) { ipcRenderer.send('open-preview', botonSeleccionado.file); }
    hideAllMenus();
});

document.getElementById('tab-menu-editar').addEventListener('click', () => {
    modoTab = 'editar';
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    const paleta = profile.paletas[tabSeleccionadaIndex];
    document.getElementById('cw-tab-modal-title').innerText = 'Editar Botonera';
    document.getElementById('cw-tab-name').value = paleta.nombre;
    document.getElementById('cw-tab-v').value = paleta.rows;
    document.getElementById('cw-tab-h').value = paleta.cols;
    document.getElementById('cw-tab-bg-color').value = paleta.tabBg || '#3a3f44';
    document.getElementById('cw-tab-text-color').value = paleta.tabText || '#cccccc';
    hideAllMenus();
    cwTabModal.style.display = 'flex';
    cwTabModal.tabIndex = -1;
    setTimeout(() => cwTabModal.focus(), 0);
});


document.getElementById('tab-menu-eliminar').addEventListener('click', async () => {
    hideAllMenus();
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    if (profile.paletas.length <= 1) { alert("No puedes eliminar la unica botonera."); return; }
    const paleta = profile.paletas[tabSeleccionadaIndex];
    if (!(await confirmDeleteCartwallTab(paleta))) return;
    stopCartwallTabAudio(tabSeleccionadaIndex);
    profile.paletas.splice(tabSeleccionadaIndex, 1);
    cwActiveTabIndex = Math.min(cwActiveTabIndex, profile.paletas.length - 1);
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    refreshCwPlayingTabs();
    renderCartwallTabs();
    renderCartwallGrid();
    setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
});

document.getElementById('cw-close-modal')?.addEventListener('click', closeCwEditModal);
document.getElementById('btn-cancel-cw-edit').addEventListener('click', closeCwEditModal);
cwEditModal.addEventListener('mousedown', (event) => { if (event.target === cwEditModal) closeCwEditModal(); });
cwEditModal.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-edit').click(), closeCwEditModal));

document.getElementById('btn-select-file').addEventListener('click', async () => {
    const selectedType = document.getElementById('cw-edit-type')?.value || 'audio';
    const ruta = selectedType === 'time'
        ? await ipcRenderer.invoke('dialog:selectFolder')
        : await ipcRenderer.invoke('dialog:openFile');
    if (ruta) {
        document.getElementById('cw-edit-filepath').value = ruta;
        const nombre = path.basename(ruta);
        document.getElementById('cw-edit-name').value = selectedType === 'time' ? 'Locucion de hora' : (nombre.substring(0, nombre.lastIndexOf('.')) || nombre).toUpperCase();
    }
});

document.getElementById('cw-edit-type')?.addEventListener('change', () => {
    const selectedType = document.getElementById('cw-edit-type').value;
    document.getElementById('cw-edit-filepath').value = selectedType === botonSeleccionado?.type
        ? (selectedType === 'time' ? (botonSeleccionado.folder || '') : (botonSeleccionado.file || ''))
        : '';
    if (selectedType === 'time') document.getElementById('cw-edit-name').value = 'Locucion de hora';
});

document.getElementById('btn-save-cw-edit').addEventListener('click', async () => {
    const selectedType = document.getElementById('cw-edit-type')?.value || 'audio';
    const selectedPath = document.getElementById('cw-edit-filepath').value;
    const previousPath = selectedType === 'time' ? botonSeleccionado.folder : botonSeleccionado.file;
    if (botonSeleccionado.type !== selectedType || previousPath !== selectedPath) {
        stopCartwallAudio(botonSeleccionado);
    }
    botonSeleccionado.type = selectedType;
    botonSeleccionado.file = selectedType === 'time' ? '' : selectedPath;
    botonSeleccionado.folder = selectedType === 'time' ? selectedPath : '';
    botonSeleccionado.name = document.getElementById('cw-edit-name').value;
    botonSeleccionado.vol = parseFloat(document.getElementById('cw-edit-volume').value);
    botonSeleccionado.bg = document.getElementById('cw-edit-bg-color').value;
    botonSeleccionado.text = document.getElementById('cw-edit-text-color').value;
    resetCartwallButtonModeOptions(botonSeleccionado);
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallGrid();
    closeCwEditModal();
});

document.getElementById('cw-close-tab-modal')?.addEventListener('click', closeCwTabModal);
document.getElementById('btn-cancel-cw-tab')?.addEventListener('click', closeCwTabModal);
cwTabModal.addEventListener('mousedown', (event) => {
    if (event.target === cwTabModal) closeCwTabModal();
});
cwTabModal.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-tab').click(), closeCwTabModal));
document.getElementById('btn-cancel-cw-profile')?.addEventListener('click', closeCwProfileModal);
cwProfileModal?.addEventListener('mousedown', (event) => { if (event.target === cwProfileModal) closeCwProfileModal(); });
cwProfileModal?.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-profile').click(), closeCwProfileModal));
document.getElementById('btn-save-cw-profile')?.addEventListener('click', saveCwProfileModal);
document.getElementById('btn-save-cw-tab').addEventListener('click', async () => {
    if (cwSavingTab) return;
    cwSavingTab = true;
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    const nombre = document.getElementById('cw-tab-name').value.trim() || `Botonera ${profile.paletas.length + 1}`;
    const v = Math.max(1, Math.min(20, parseInt(document.getElementById('cw-tab-v').value) || 5));
    const h = Math.max(1, Math.min(20, parseInt(document.getElementById('cw-tab-h').value) || 5));
    document.getElementById('cw-tab-v').value = v;
    document.getElementById('cw-tab-h').value = h;

    closeCwTabModal();
    try {
        if (modoTab === 'nuevo') {
            let botones = createEmptyCwButtons(v * h);
            profile.paletas.push({ nombre, rows: v, cols: h, tabBg: document.getElementById('cw-tab-bg-color').value, tabText: document.getElementById('cw-tab-text-color').value, botones });
            cwActiveTabIndex = profile.paletas.length - 1;
        } else {
            const paleta = profile.paletas[tabSeleccionadaIndex];
            paleta.nombre = nombre;
            paleta.tabBg = document.getElementById('cw-tab-bg-color').value;
            paleta.tabText = document.getElementById('cw-tab-text-color').value;

            const total = v * h;
            if (paleta.botones.length < total) {
                for (let i = paleta.botones.length + 1; i <= total; i++) { paleta.botones.push(createEmptyCwButtonForSlot(i)); }
            } else if (paleta.botones.length > total) {
                paleta.botones = paleta.botones.slice(0, total);
            }
            paleta.botones.forEach((b, i) => b.id = i + 1);
            paleta.rows = v;
            paleta.cols = h;
        }
        await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
        renderCartwallTabs();
        renderCartwallGrid();
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
    } finally {
        cwSavingTab = false;
    }
});

ipcRenderer.on('remote-cw-play', (e, btnInfo) => { handleCartwallPlay(btnInfo, null); });
ipcRenderer.on('remote-cw-stop', (e, target) => { stopCartwallAudio(target); });
ipcRenderer.on('remote-cw-stopall', () => { for (let key in cartwallAudioInstances) { stopCartwallAudio(key); } });
ipcRenderer.on('remote-cw-stop-tab', (e, tabIndex) => { stopCartwallTabAudio(tabIndex); });
ipcRenderer.on('remote-cw-move-button', (e, payload) => {
    moveCartwallRuntime(payload.fromTabIndex, payload.fromId, payload.toTabIndex, payload.toId);
});

window.addEventListener('blur', hideAllMenus);

// Sidebar Resizer Logic
function initSidebarResizer() {
    const sidebar = document.getElementById('left-sidebar');
    const resizer = document.getElementById('sidebar-resizer');

    if (sidebar && resizer) {
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = e.clientX - sidebar.getBoundingClientRect().left;
            sidebar.style.width = `${newWidth}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.body.style.cursor = '';
                localStorage.setItem('lf-sidebar-width', sidebar.style.width);
            }
        });

        const savedWidth = localStorage.getItem('lf-sidebar-width');
        if (savedWidth) {
            sidebar.style.width = savedWidth;
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarResizer);
} else {
    initSidebarResizer();
}

// FIX FASE D — Listener que recibe el cambio de tap-point del encoder desde
// la ventana del encoder. Actualiza generalPrefs y dispara
// syncRustRouteContract para que el motor Rust reciba el `route` del bus
// encoder con el nuevo `sourceMode`. El motor cambia el atómico
// `encoder_tap_mode` sample-by-sample y el siguiente chunk PCM sale del ring
// correcto sin reiniciar el encoder.
ipcRenderer.on('encoder-tap-point-changed', (e, payload = {}) => {
    const tapPoint = payload?.tapPoint === 'preFx' ? 'preFx' : 'postFx';
    generalPrefs.encoderSourceMode = tapPoint;
    if (liveEncoderSourceState) liveEncoderSourceState.tapPoint = tapPoint;
    syncRustRouteContract({ force: true });
});

// ─── Listener de eventos asíncronos del motor Rust ─────────────────────────
// El motor empuja eventos vía stdout que main.js reenvía por IPC. Aquí
// escuchamos:
//   · `status` (push automático cada 100 ms desde el bucle PushTick del motor)
//     → reconcilia el estado del transporte, cartwall y overlays sin tener
//       que pedirlo. Reemplaza al antiguo polling agresivo de 50 ms.
//   · `timeLocutionEnded` → fin de locución horaria, avanza playlist.
//
// Filosofía "humilde control remoto": Electron sólo escucha y dibuja. No
// pregunta, no calcula tiempos, no decide cuándo refrescar.
ipcRenderer.on('audio-engine-rust-event', (e, message) => {
    if (!message || typeof message !== 'object') return;

    // Status push de 10 Hz desde el motor Rust. Sustituye al polling.
    if (message.type === 'status') {
        rustAudioProbeStatus = {
            available: true,
            running: true,
            lastStatus: message,
            lastError: ''
        };
        try { watchRustPlaylistOwnerHealth(message); } catch (err) {}
        try { reconcileRustCartwallRuntimeStatus(message); } catch (err) {}
        try { reconcileRustOverlayRuntimeStatus(message); } catch (err) {}
        return;
    }

    if (message.type === 'timeLocutionEnded') {
        const ctx = rustTimeLocutionContext;
        rustTimeLocutionContext = null;

        if (!ctx) {
            // Sin contexto = ya lo cerramos por stop manual o por una nueva
            // locución; ignoramos el evento rezagado.
            return;
        }

        if (ctx.kind === 'button') {
            // Locución lanzada desde la botonera de hora del bus jingle:
            // simplemente liberamos los flags de ducking y "jingle sonando".
            isJinglePlaying = false;
            endProgramOverlayDucking();
            return;
        }

        if (ctx.kind === 'playlist') {
            // Locución programada como fila de playlist. El avance lo dispara
            // handleTimeUpdate al cruzar playbackEndAbsolute (igual que una
            // pista normal). Este evento llega como salvavidas: limpiamos los
            // flags y forzamos un repintado por si el reloj virtual quedó
            // desfasado y no detectó el fin a tiempo.
            if (ctx.sessionId !== playRowSessionId) return;
            isPlaylistTimeActive = false;
            // Si por algún motivo handleTimeUpdate aún no disparó la transición
            // (canción siguiente cargada), forzamos el avance.
            if (!crossfadeTriggered && currentPlayingRow === ctx.row) {
                if (stopAfterCurrent) {
                    stopAfterCurrent = false;
                    applyStopAfterVisualState();
                    stopAll();
                    return;
                }
                if (currentPlayingRow.dataset.temp === 'true') {
                    currentPlayingRow.remove();
                    currentPlayingRow = null;
                    calcularHorasPlaylist();
                } else if (generalPrefs.modeRemovePlayed && document.body.contains(currentPlayingRow)) {
                    currentPlayingRow.remove();
                    currentPlayingRow = null;
                    calcularHorasPlaylist();
                }
                playNext(false);
            }
        }
    }
});

