const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, screen, shell, safeStorage, powerMonitor, powerSaveBlocker, nativeImage } = require('electron');
const i18n = require('./backend/i18n_main');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const os = require('os');
const { Worker } = require('worker_threads');
const nodeID3 = require('node-id3');
const { getConfigDir } = require('./backend/utils/app_paths');
const { version: APP_VERSION } = require('./package.json');
const db = require('./database');
const { RustAudioEngineProbe } = require('./backend/audio_engine_process');
const { defaultFileTypes, normalizeFileTypes } = require('./frontend/file_types_data');
const { cleanCsvList, mergeCsvList, cleanMetaString, tokenSet, jaccard, waitRateLimit } = require('./backend/utils/helpers.js');
const { redactSensitiveText, rotateLogIfNeeded, scrubLogFile } = require('./backend/utils/log_security');
const { resolveFfmpegRuntime } = require('./backend/utils/ffmpeg_resolver');
const { verifyMicrosoftAuthenticode } = require('./backend/utils/windows_authenticode');
const fileTypeResolver = require('./backend/services/file_type_resolver');
const {
  getTrackFileSignature,
  storeTrackFileSignature,
  mapTrackRowToClient
} = require('./backend/services/track_mapper.js');
const { readId3TagsAsync } = require('./backend/services/id3_reader.js');
const {
  _injectDeps: artists_injectDeps,
  PROTECTED_ARTIST_GROUP_NAMES,
  normalizeArtistGroupKey,
  PROTECTED_ARTIST_GROUP_KEYS,
  isProtectedArtistGroup,
  parseTitleAndArtist,
  normalizeArtistKey,
  normalizeCountryKey,
  getCountryProfiles,
  resolveCountryProfile,
  normalizeNationalitiesList,
  toDisplayArtist,
  parseFeatList,
  filterInternalGroupFeats,
  normalizeTrackArtistFields,
  parseLeadingArtistCandidate,
  inferArtistDataFromRow,
  upsertArtistProfile,
  syncTrackArtistLinks,
  syncTrackArtistLinksFromRow,
  rebuildArtistProfilesForPaths,
  getArtistCardByKey,
  ensureArtistProfileForLink,
  getArtistTracksByKey,
  getArtistCardForTrackPath,
  getArtistCardDetailsForTrackPath,
  saveArtistCard,
  isArtistCurated,
  getArtistCatalogData,
  deleteArtistProfiles,
  mergeArtistProfiles,
  setArtistMainGenreFromCatalog,
  getArtistImageDir,
  safeImageFileName,
  downloadArtistImage,
  inferArtistTypeFromMetadata
} = require('./backend/services/artists.js');

const {
  _injectDeps: genres_injectDeps,
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
} = require('./backend/services/genres.js');
app.setName('LF Automatizador');

try { db.prepare("ALTER TABLE tracks ADD COLUMN subgenres_csv TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE tracks ADD COLUMN genres_json TEXT").run(); } catch(e) {}

// Inyección de dependencias cruzadas
artists_injectDeps(db, {
    upsertGenreProfile,
    applyGenreToTrackPaths
});

function loadJsonConfig(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (err) {
        return fallback;
    }
}

function getConfiguredLibraryRoot() {
    const prefs = loadJsonConfig(path.join(configDir, 'library_prefs.json'), {});
    return String(prefs.persistentRoot || '').trim();
}

function getSafeBrowserPath(inputPath = '') {
    const rootPath = getConfiguredLibraryRoot();
    if (!rootPath || !fs.existsSync(rootPath)) return '';
    const requested = String(inputPath || '').trim() || rootPath;
    const resolvedRoot = path.resolve(rootPath);
    const resolvedPath = path.resolve(requested);
    if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return resolvedPath;
    return resolvedRoot;
}

genres_injectDeps(db, {
    getSafeMainWindow: () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null,
    broadcastEvent: (name, data) => {
        [mainWindow, libraryWindow, audioEditorWindow, artistCardWindow, genreEditorWindow].forEach(win => {
            if (win && !win.isDestroyed()) win.webContents.send(name, data);
        });
    },
    storeTrackFileSignature,
    AUDIO_FILE_RE: /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i,
    getTrackStmt: db.prepare("SELECT * FROM tracks WHERE file_path = ?"),
    upsertArtistProfile,
    artists_applyGenreToTrackPaths: applyGenreToTrackPaths,
    getTrackFileSignature,
    writeLog,
    getConfiguredLibraryRoot,
    getSafeBrowserPath,
    cleanCsvList
});
try { db.prepare("ALTER TABLE tracks ADD COLUMN is_remix INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE tracks ADD COLUMN peak_db TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE tracks ADD COLUMN file_size INTEGER").run(); } catch(e) {}
try { db.prepare("ALTER TABLE tracks ADD COLUMN file_mtime_ms INTEGER").run(); } catch(e) {}

const ffmpegRuntime = resolveFfmpegRuntime();
const ffmpegPath = ffmpegRuntime.baseline.path;
const ffmpegFdkPath = ffmpegRuntime.fdk?.path || '';
const ffmpegCapabilities = {
    baseline: ffmpegRuntime.baseline.capabilities,
    fdk: ffmpegRuntime.fdk?.capabilities || null,
};
// Lee general_settings.json y construye los comandos `route` iniciales que se
// envían al motor Rust en respuesta al evento `ready`. Los IDs almacenados son
// los IDs nativos de Rust (indexId / id del dispositivo WASAPI), escritos por
// settings.js usando setSelectRustDeviceOptions. El motor los resuelve
// directamente sin necesidad de traducción desde deviceIds de browser.
function buildStartupRouteCommands() {
    try {
        const settingsPath = path.join(getConfigDir(path.join(__dirname, 'config'), __dirname), 'general_settings.json');
        if (!fs.existsSync(settingsPath)) return [];
        const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const outMain     = cfg.outMain     || 'default';
        const outMonitor  = cfg.outMonitor  || outMain;
        const outCue      = cfg.outCue      || outMain;
        const cartwallMode = cfg.cartwallOutputMode || 'master';
        const outCartwall = cartwallMode === 'monitor' ? outMonitor
            : cartwallMode === 'cue'    ? outCue
            : cartwallMode === 'device' ? (cfg.outCartwall || outMain)
            : outMain;
        const auxModes = Array.isArray(cfg.auxiliaryOutputModes) ? cfg.auxiliaryOutputModes : ['master', 'master'];
        const auxOutputs = Array.isArray(cfg.auxiliaryOutputs) ? cfg.auxiliaryOutputs : ['default', 'default'];
        const routes = [
            { cmd: 'route', bus: 'master',   outputId: outMain },
            { cmd: 'route', bus: 'jingle',   outputId: outMain },
            { cmd: 'route', bus: 'cue',      outputId: outCue },
            { cmd: 'route', bus: 'cartwall', outputId: outCartwall },
            { cmd: 'route', bus: auxModes[0] === 'cue' ? 'cue' : (auxModes[0] === 'device' ? 'aux1-independent' : 'aux1'), outputId: auxModes[0] === 'cue' ? outCue : (auxModes[0] === 'device' ? (auxOutputs[0] || outMain) : outMain) },
            { cmd: 'route', bus: auxModes[1] === 'cue' ? 'cue' : (auxModes[1] === 'device' ? 'aux2-independent' : 'aux2'), outputId: auxModes[1] === 'cue' ? outCue : (auxModes[1] === 'device' ? (auxOutputs[1] || outMain) : outMain) },
        ];
        if (cfg.monitorEnabled === true) {
            routes.push({
                cmd: 'route',
                bus: 'monitor',
                outputId: outMonitor,
                sourceMode: cfg.monitorSourceMode === 'preFx' ? 'preFx' : 'postFx'
            });
        }
        return routes;
    } catch (err) {
        return [];
    }
}

const rustAudioEngine = new RustAudioEngineProbe({
    rootDir: __dirname,
    cp,
    writeLog,
    // El motor emite `ready` cuando WASAPI ha terminado de inicializarse y
    // puede aceptar comandos. Es el momento correcto para aplicar la
    // configuración de salida de audio guardada, sin depender de timeouts
    // ni del ciclo de vida del renderer.
    onEngineReady: () => {
        const routes = buildStartupRouteCommands();
        routes.forEach(cmd => rustAudioEngine.send(cmd));
        if (routes.length) {
            const masterOut = routes.find(r => r.bus === 'master')?.outputId || 'default';
            writeLog(`[RustAudio] Rutas de arranque aplicadas: master=${masterOut}`);
        }
    },
    // Reenvía al renderer eventos asíncronos del motor (locución horaria,
    // futuros eventos de fin de pista, etc.). El renderer escucha
    // 'audio-engine-rust-event' y reacciona sin tener que mantener relojes.
    onEngineEvent: (message) => {
        if (isAppQuitting) return;
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('audio-engine-rust-event', message);
            }
            // FASE EXTRA — Lentitud de vúmetros en consola virtual:
            // antes el push de status pasaba por el renderer principal, que
            // lo reempaquetaba en `vu-levels` y main.js lo retransmitía a la
            // consola con throttle de 50ms. Resultado: ~150ms de latencia
            // perceptual. Ahora reenviamos el push directo a la consola para
            // que pinte sus VUs inmediatamente cuando Rust emite (~100ms).
            if (consoleWindow && !consoleWindow.isDestroyed()) {
                consoleWindow.webContents.send('audio-engine-rust-event', message);
            }
            if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
                auxiliaryWindow.webContents.send('audio-engine-rust-event', message);
            }
            if (encoderWindow && !encoderWindow.isDestroyed()) {
                encoderWindow.webContents.send('audio-engine-rust-event', message);
            }
        } catch (err) {}
    }
});
let appSuspensionBlockerId = null;
let appShutdownCleanupStarted = false;

function runAppShutdownCleanup(reason = 'app-shutdown') {
    if (appShutdownCleanupStarted) return;
    appShutdownCleanupStarted = true;
    isAppQuitting = true;
    forceQuit = true;
    try {
        if (appSuspensionBlockerId !== null && powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
            powerSaveBlocker.stop(appSuspensionBlockerId);
        }
    } catch (err) {}
    try { rustAudioEngine.stop(); } catch (err) {}
    try { db.walCheckpoint(); } catch (err) {}
    try { writeLog(`[CIERRE] Limpieza principal completada: ${reason}`); } catch (err) {}
}

function confirmAppQuit(reason = 'confirm-app-quit') {
    runAppShutdownCleanup(reason);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
    }
    app.quit();
}

function broadcastAudioPowerEvent(payload = {}) {
    const message = { at: Date.now(), ...payload };
    writeLog(`[ENERGIA] ${message.phase || 'evento'}${message.reason ? `: ${message.reason}` : ''}`);
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('audio-engine-power-event', message);
        }
    } catch (err) {}
}

function installAudioPowerGuards() {
    try {
        if (appSuspensionBlockerId === null || !powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
            appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
            writeLog('[ENERGIA] Suspension automatica bloqueada; la pantalla puede apagarse normalmente.');
        }
    } catch (err) {
        writeLog(`[ENERGIA] No se pudo bloquear suspension automatica: ${err?.message || err}`);
    }
    powerMonitor.on('suspend', () => {
        broadcastAudioPowerEvent({ phase: 'suspend', reason: 'Windows suspendio la sesion.' });
    });
    powerMonitor.on('resume', async () => {
        broadcastAudioPowerEvent({ phase: 'resume', reason: 'Windows reanudo la sesion; verificando RustAudio.' });
        // Un heartbeat vivo no garantiza que WASAPI siga drenando audio. Tras
        // una suspension real reconstruimos siempre el proceso, sus sinks y el
        // tap PCM del encoder antes de permitir que la playlist avance.
        const recovery = await rustAudioEngine.recover('Windows reanudo la sesion; reconstruyendo WASAPI.');
        broadcastAudioPowerEvent({
            phase: recovery?.success ? 'ready' : 'failed',
            reason: recovery?.success ? 'RustAudio listo tras reanudar.' : (recovery?.error || 'RustAudio no se recupero tras reanudar.'),
            recovery,
        });
    });
    powerMonitor.on('lock-screen', () => broadcastAudioPowerEvent({ phase: 'lock-screen' }));
    powerMonitor.on('unlock-screen', () => broadcastAudioPowerEvent({ phase: 'unlock-screen' }));
}

let libraryWorker = null;
const libraryWorkerPending = new Map();
let libraryWorkerSeq = 0;
let audioAnalysisWorker = null;
let metadataWorker = null;
let metaNetWorker = null;
let libraryWorkerTimeout = null;

function resetLibraryWorkerTimeout() {
    if (libraryWorkerTimeout) clearTimeout(libraryWorkerTimeout);
    libraryWorkerTimeout = setTimeout(() => {
        if (libraryWorkerPending.size === 0 && libraryWorker) {
            try { libraryWorker.terminate(); } catch (err) {}
            libraryWorker = null;
        }
    }, 10000); // 10 segundos de inactividad
}

function getLibraryWorker() {
    resetLibraryWorkerTimeout();
    if (libraryWorker) return libraryWorker;
    libraryWorker = new Worker(path.join(__dirname, 'backend', 'library_worker.js'));
    libraryWorker.on('message', (message) => {
        // Mensajes de progreso (sincronización del índice): se retransmiten a
        // las ventanas sin resolver la tarea pendiente.
        if (message?.progress) {
            sendToWindowSafe(mainWindow, 'library-index-sync-progress', message.progress);
            sendToWindowSafe(libraryWindow, 'library-index-sync-progress', message.progress);
            return;
        }
        const pending = libraryWorkerPending.get(message?.id);
        if (!pending) return;
        libraryWorkerPending.delete(message.id);
        pending.resolve(message.result || { success: false, error: 'Respuesta vacia del worker.' });
        resetLibraryWorkerTimeout();
    });
    libraryWorker.on('error', (err) => {
        for (const [id, pending] of libraryWorkerPending.entries()) {
            pending.resolve({ success: false, error: err.message });
            libraryWorkerPending.delete(id);
        }
        libraryWorker = null;
        if (libraryWorkerTimeout) clearTimeout(libraryWorkerTimeout);
    });
    libraryWorker.on('exit', (code) => {
        for (const [id, pending] of libraryWorkerPending.entries()) {
            pending.resolve({ success: false, error: `Worker terminado con codigo ${code}` });
            libraryWorkerPending.delete(id);
        }
        libraryWorker = null;
        if (libraryWorkerTimeout) clearTimeout(libraryWorkerTimeout);
    });
    return libraryWorker;
}

function runLibraryWorkerTask(action, payload) {
    return new Promise((resolve) => {
        const id = `${Date.now()}-${++libraryWorkerSeq}`;
        libraryWorkerPending.set(id, { resolve });
        try {
            getLibraryWorker().postMessage({ id, action, payload });
        } catch (err) {
            libraryWorkerPending.delete(id);
            resolve({ success: false, error: err.message });
        }
    });
}

// Envío seguro a una BrowserWindow desde callbacks asíncronos (workers,
// timers, promesas). Los workers pueden emitir DESPUÉS de que el usuario cerró
// la ventana destino: enviar a una ventana destruida lanza "Object has been
// destroyed" como excepción no capturada y tumba el proceso principal con el
// diálogo de error de Electron. Toda emisión asíncrona debe pasar por aquí.
function sendToWindowSafe(win, channel, payload) {
    try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    } catch (err) {}
}

function broadcastAnalyzerResult(result) {
    sendToWindowSafe(libraryWindow, 'analyzer-done', result);
    sendToWindowSafe(audioEditorWindow, 'analyzer-done', result);
    sendToWindowSafe(mainWindow, 'analyzer-done', result);
}

function stopAudioAnalysisWorker() {
    if (!audioAnalysisWorker) return;
    try { audioAnalysisWorker.postMessage({ action: 'cancel' }); } catch (err) {}
    try { audioAnalysisWorker.terminate(); } catch (err) {}
    audioAnalysisWorker = null;
}

function startAudioAnalysisWorker(tasks) {
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    if (safeTasks.length === 0) return;
    if (audioAnalysisWorker) {
        try { audioAnalysisWorker.postMessage({ action: 'append', tasks: safeTasks }); } catch (err) {
            writeLog("Error agregando tareas audio-analysis-worker: " + err.message);
        }
        return;
    }
    audioAnalysisWorker = new Worker(path.join(__dirname, 'backend', 'audio_analysis_worker.js'));
    audioAnalysisWorker.on('message', (message) => {
        if (message?.type === 'result') {
            broadcastAnalyzerResult(message.payload);
        } else if (message?.type === 'finished') {
            stopAudioAnalysisWorker();
        }
    });
    audioAnalysisWorker.on('error', (err) => {
        writeLog("Error audio-analysis-worker: " + err.message);
        stopAudioAnalysisWorker();
    });
    audioAnalysisWorker.on('exit', () => {
        audioAnalysisWorker = null;
    });
    audioAnalysisWorker.postMessage({ action: 'start', tasks: safeTasks });
}

function stopMetadataWorker() {
    if (!metadataWorker) return;
    try { metadataWorker.postMessage({ action: 'cancel' }); } catch (err) {}
    try { metadataWorker.terminate(); } catch (err) {}
    metadataWorker = null;
}

function startMetadataWorker(mode, tasks) {
    stopMetadataWorker();
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    if (safeTasks.length === 0) return;
    metadataWorker = new Worker(path.join(__dirname, 'backend', 'metadata_worker.js'));
    metadataWorker.on('message', (message) => {
        if (message?.type === 'result') {
            const channel = message.mode === 'write' ? 'meta-local-write-done' : 'meta-local-read-done';
            sendToWindowSafe(libraryWindow, channel, message.payload);
        } else if (message?.type === 'finished') {
            stopMetadataWorker();
        }
    });
    metadataWorker.on('error', (err) => {
        writeLog("Error metadata-worker: " + err.message);
        stopMetadataWorker();
    });
    metadataWorker.on('exit', () => {
        metadataWorker = null;
    });
    metadataWorker.postMessage({ action: 'start', mode, tasks: safeTasks });
}

function stopMetaNetWorker() {
    if (!metaNetWorker) return;
    try { metaNetWorker.postMessage({ action: 'cancel' }); } catch (err) {}
    try { metaNetWorker.terminate(); } catch (err) {}
    metaNetWorker = null;
}

function startMetaNetWorker(tasks) {
    stopMetaNetWorker();
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    if (safeTasks.length === 0) return;
    metaNetWorker = new Worker(path.join(__dirname, 'backend', 'meta_net_worker.js'));
    metaNetWorker.on('message', (message) => {
        if (message?.type === 'result') {
            sendToWindowSafe(libraryWindow, 'meta-net-done', message.payload);
        } else if (message?.type === 'finished') {
            stopMetaNetWorker();
        }
    });
    metaNetWorker.on('error', (err) => {
        writeLog("Error meta-net-worker: " + err.message);
        stopMetaNetWorker();
    });
    metaNetWorker.on('exit', () => {
        metaNetWorker = null;
    });
    metaNetWorker.postMessage({ action: 'start', tasks: safeTasks });
}

function buildWaveformPeaksInWorker(filePath) {
    return new Promise((resolve) => {
        const worker = new Worker(path.join(__dirname, 'backend', 'waveform_worker.js'));
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { worker.terminate(); } catch (err) {}
            resolve(result);
        };
        worker.once('message', (message) => finish(message?.result || { success: false, error: 'Respuesta vacia del worker.' }));
        worker.once('error', (err) => finish({ success: false, error: err.message }));
        worker.once('exit', (code) => {
            if (!settled && code !== 0) finish({ success: false, error: `Worker terminado con codigo ${code}` });
        });
        worker.postMessage({ id, filePath });
    });
}

function scanCommercialPathsInWorker(paths) {
    return new Promise((resolve) => {
        const worker = new Worker(path.join(__dirname, 'backend', 'commercial_scan_worker.js'));
        let settled = false;
        const finish = (assets) => {
            if (settled) return;
            settled = true;
            try { worker.terminate(); } catch (err) {}
            resolve(Array.isArray(assets) ? assets : []);
        };
        worker.once('message', (message) => finish(message?.assets));
        worker.once('error', () => finish([]));
        worker.once('exit', (code) => { if (!settled && code !== 0) finish([]); });
        worker.postMessage({ paths: Array.isArray(paths) ? paths : [] });
    });
}

function readLibraryDirInWorker(dirPath, recursive = false) {
    return new Promise((resolve) => {
        const worker = new Worker(path.join(__dirname, 'backend', 'file_scan_worker.js'));
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { worker.terminate(); } catch (err) {}
            resolve(result || { success: false });
        };
        worker.once('message', (message) => finish(message?.result));
        worker.once('error', (err) => finish({ success: false, error: err.message }));
        worker.once('exit', (code) => {
            if (!settled && code !== 0) finish({ success: false, error: `Worker terminado con codigo ${code}` });
        });
        worker.postMessage({ id, dirPath, recursive });
    });
}

function openTaskManagerWindow() {
    if (taskManagerWindow && !taskManagerWindow.isDestroyed()) {
        taskManagerWindow.focus();
        return;
    }
    taskManagerWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),  
        width: 820,
        height: 540,
        minWidth: 720,
        minHeight: 420,
        title: 'Administrador de tareas LF',
        autoHideMenuBar: true,
        alwaysOnTop: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    taskManagerWindow.loadFile('frontend/task_manager.html');
    taskManagerWindow.on('blur', () => {
        if (taskManagerWindow && !taskManagerWindow.isDestroyed()) taskManagerWindow.close();
    });
    taskManagerWindow.on('closed', () => { taskManagerWindow = null; });
}



function openCommercialManagerWindow() {
    if (commercialManagerWindow && !commercialManagerWindow.isDestroyed()) {
        commercialManagerWindow.focus();
        return;
    }
    commercialManagerWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '', 'assets', 'icons', 'commercial.png')),  
        width: 1040,
        height: 680,
        minWidth: 900,
        minHeight: 560,
        title: 'Gestor de Comerciales',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    commercialManagerWindow.loadFile('frontend/commercial_manager.html');
    commercialManagerWindow.on('closed', () => { commercialManagerWindow = null; });
}



function resolveGenreEditorKey(value) {
    const raw = String(value?.genreKey || value?.key || value?.displayName || value?.name || value || '').trim();
    if (!raw) return '';
    const normalized = normalizeGenreKey(raw);
    const rows = db.prepare(`
        SELECT genre_key AS genreKey, display_name AS displayName
        FROM genre_profiles
        WHERE COALESCE(is_active, 1) = 1
    `).all();
    const exact = rows.find(row => row.genreKey === raw);
    if (exact) return exact.genreKey;
    const byDisplay = rows.find(row => normalizeGenreKey(row.displayName) === normalized);
    if (byDisplay) return byDisplay.genreKey;
    const byLastSegment = rows.find(row => normalizeGenreKey(String(row.genreKey || '').split(':').pop()) === normalized);
    return byLastSegment?.genreKey || '';
}

function openGenreEditorWindow(initialGenre = '') {
    const selectedGenreKey = resolveGenreEditorKey(initialGenre);
    const requestedName = String(initialGenre?.displayName || initialGenre?.name || initialGenre || '').trim();
    const sendSelection = () => {
        if ((selectedGenreKey || requestedName) && genreEditorWindow && !genreEditorWindow.isDestroyed()) {
            genreEditorWindow.webContents.send('select-genre', { genreKey: selectedGenreKey, displayName: requestedName });
        }
    };
    if (genreEditorWindow && !genreEditorWindow.isDestroyed()) {
        genreEditorWindow.focus();
        sendSelection();
        return;
    }
    genreEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '', 'assets', 'icons', 'genre.png')),  
        width: 1320,
        height: 760,
        minWidth: 1080,
        minHeight: 620,
        title: 'Editor de Géneros Musicales',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    genreEditorWindow.loadFile('frontend/genre_editor.html');
    genreEditorWindow.webContents.on('did-finish-load', sendSelection);
    genreEditorWindow.on('closed', () => { genreEditorWindow = null; });
}

function openArtistCatalogWindow() {
    if (artistCatalogWindow && !artistCatalogWindow.isDestroyed()) {
        artistCatalogWindow.focus();
        return;
    }
    artistCatalogWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '', 'assets', 'icons', 'catalog.png')),  
        width: 1280,
        height: 760,
        minWidth: 1040,
        minHeight: 620,
        title: 'Biblioteca de Cédulas',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    artistCatalogWindow.loadFile('frontend/artist_catalog.html');
    artistCatalogWindow.on('closed', () => { artistCatalogWindow = null; });
}

function openMusicSeparationWindow() {
    if (musicSeparationWindow && !musicSeparationWindow.isDestroyed()) {
        musicSeparationWindow.focus();
        return;
    }
    musicSeparationWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),
        width: 760,
        height: 640,
        minWidth: 620,
        minHeight: 520,
        title: 'Reglas de Separación Musical',
        autoHideMenuBar: true,
        parent: mainWindow || undefined,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    musicSeparationWindow.loadFile('frontend/separacion_musical.html');
    musicSeparationWindow.on('closed', () => { musicSeparationWindow = null; });
}

function openFileTypesManagerWindow() {
    if (fileTypesManagerWindow && !fileTypesManagerWindow.isDestroyed()) {
        fileTypesManagerWindow.focus();
        return;
    }
    fileTypesManagerWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),
        width: 980,
        height: 660,
        minWidth: 820,
        minHeight: 540,
        title: 'Gestor de Tipos de Archivo',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    fileTypesManagerWindow.loadFile('frontend/file_types_manager.html');
    fileTypesManagerWindow.on('closed', () => { fileTypesManagerWindow = null; });
}

// ── Generador de Playlist (ventana independiente) ────────────────────────────
// La ventana es UI delgada; la ventana PRINCIPAL tiene el core + datos + carpetas
// + inserción. Se comunican por relay: el generador pide con 'pg-to-main' y la
// principal responde con 'pg-reply' usando el mismo id.
let playlistGeneratorWindow = null;
function openPlaylistGeneratorWindow() {
    if (playlistGeneratorWindow && !playlistGeneratorWindow.isDestroyed()) {
        playlistGeneratorWindow.focus();
        return;
    }
    playlistGeneratorWindow = new BrowserWindow({
        icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),
        width: 1100, height: 720, minWidth: 900, minHeight: 600,
        title: 'Generador de Playlist',
        autoHideMenuBar: true,
        backgroundColor: '#121212',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    playlistGeneratorWindow.loadFile(require('path').join(__dirname, 'frontend', 'playlist_generator.html'));
    playlistGeneratorWindow.on('closed', () => { playlistGeneratorWindow = null; });
}
ipcMain.on('open-playlist-generator', openPlaylistGeneratorWindow);

const _pgPending = new Map();
let _pgReqId = 0;
ipcMain.handle('pg-to-main', (e, msg) => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve({ error: 'no-main-window' }); return; }
    const id = ++_pgReqId;
    _pgPending.set(id, resolve);
    mainWindow.webContents.send('pg-from-generator', { id, action: msg && msg.action, payload: msg && msg.payload });
    setTimeout(() => { if (_pgPending.has(id)) { _pgPending.delete(id); resolve({ error: 'timeout' }); } }, 120000);
}));
ipcMain.on('pg-reply', (e, msg) => {
    const resolve = msg && _pgPending.get(msg.id);
    if (resolve) { _pgPending.delete(msg.id); resolve(msg.data); }
});

async function initializeCurationFromConfiguredRoot() {
    try {
        const rootPath = getConfiguredLibraryRoot();
        if (!rootPath || !fs.existsSync(rootPath)) {
            return { success: false, error: 'Carpeta raíz no configurada o no encontrada.' };
        }

        const files = collectAudioFilesRecursive(rootPath);
        if (files.length === 0) {
            return { success: false, error: 'No se encontraron archivos de audio en la carpeta raíz.' };
        }

        let updatedTracks = 0;
        let artistLinks = 0;
        let genreTracks = 0;

        for (const filePath of files) {
            const folderPath = path.dirname(filePath);
            const folderName = path.basename(folderPath);
            const parentFolderName = path.basename(path.dirname(folderPath));
            
            // Inferencia de género por carpetas
            const parentSuggestion = inferGenreFromFolderName(parentFolderName);
            const suggestion = inferGenreFromFolderName(folderName, parentSuggestion);

            if (suggestion.genre) {
                const result = applyGenreToTrackPaths([filePath], suggestion.genre, suggestion.subgenre, 'folder', folderPath);
                updatedTracks += result.updatedTracks;
                genreTracks += result.updatedTracks;
            }

            // Sincronización de enlaces de artista
            const trackRow = db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath);
            if (trackRow) {
                const syncResult = syncTrackArtistLinksFromRow(trackRow);
                artistLinks += syncResult.linkedArtists;
            }
        }

        sendToWindowSafe(mainWindow, 'refresh-manual-cues');
        
        return {
            success: true,
            files: files.length,
            tracks: updatedTracks,
            artistLinks: artistLinks,
            genreTracks: genreTracks
        };
    } catch (err) {
        writeLog("Error initializeCuration: " + err.message);
        return { success: false, error: err.message };
    }
}


function getWorkerStatusRows() {
    return [
        { name: 'Worker biblioteca/artistas', active: !!libraryWorker, detail: `${libraryWorkerPending.size} tarea(s) pendiente(s)` },
        { name: 'Worker analisis FFmpeg', active: !!audioAnalysisWorker, detail: audioAnalysisWorker ? 'Analizando audio' : 'Inactivo' },
        { name: 'Worker metadatos locales', active: !!metadataWorker, detail: metadataWorker ? 'Leyendo/escribiendo tags' : 'Inactivo' },
        { name: 'Worker metadatos internet', active: !!metaNetWorker, detail: metaNetWorker ? 'Consultando servicios' : 'Inactivo' }
    ];
}

function getWindowProcessLabels() {
    const labels = new Map();
    const add = (win, label, diagnostic = false) => {
        try {
            if (!win || win.isDestroyed()) return;
            const pid = win.webContents.getOSProcessId();
            if (pid) labels.set(pid, { label, diagnostic });
        } catch (err) {}
    };
    add(mainWindow, 'Interfaz principal');
    add(libraryWindow, 'Biblioteca musical');
    add(audioEditorWindow, 'Editor avanzado');
    add(transitionEditorWindow, 'Editor de transicion');
    add(jingleEditorWindow, 'Editor de pisadores');
    add(consoleWindow, 'Consola virtual');
    add(taskManagerWindow, 'Administrador LF', true);
    add(previewWindow, 'Preescucha');
    add(encoderWindow, 'Encoder');
    add(reportsWindow, 'Reportes');
    add(commercialManagerWindow, 'Gestor comerciales');
    add(genreEditorWindow, 'Editor de generos');
    add(artistCatalogWindow, 'Biblioteca de cedulas');
    add(cartwallWindow, 'Botonera de efectos');
    add(artistCardWindow, 'Cedula de artista');
    return labels;
}

ipcMain.handle('task-manager-snapshot', async () => {
    const labels = getWindowProcessLabels();
    const metrics = app.getAppMetrics().map(item => ({
        pid: item.pid,
        type: item.type || 'unknown',
        label: labels.get(item.pid)?.label || '',
        diagnostic: labels.get(item.pid)?.diagnostic === true,
        cpu: item.cpu?.percentCPU ?? 0,
        memoryKb: item.memory?.workingSetSize ?? 0,
        privateKb: item.memory?.privateBytes ?? 0
    }));
    const appMetrics = metrics.filter(item => !item.diagnostic);
    // Usamos privateKb (Memoria Privada) en lugar de workingSetSize (memoryKb)
    // para evitar contar múltiples veces las librerías DLL compartidas por Chromium,
    // alineando el valor del resumen con lo que muestra el Administrador de Tareas de Windows.
    const totalMemoryKb = appMetrics.reduce((sum, item) => sum + (Number(item.privateKb) || 0), 0);
    const totalCpu = appMetrics.reduce((sum, item) => sum + (Number(item.cpu) || 0), 0);
    const diagnosticMemoryKb = metrics.filter(item => item.diagnostic).reduce((sum, item) => sum + (Number(item.privateKb) || 0), 0);
    return {
        at: Date.now(),
        metrics,
        totals: { memoryKb: totalMemoryKb, cpu: totalCpu, diagnosticMemoryKb },
        workers: getWorkerStatusRows(),
        audioEngine: lastVuLevels.diagnostics || {}
    };
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const configDir = getConfigDir(path.join(__dirname, 'config'), __dirname);

const uiPrefsPath = path.join(configDir, 'ui_prefs.json');
let uiPrefs = { menuVisible: true, controlsPos: 'bottom', temp: true, hum: true, leftPanel: true, ext: false, sysLog: true, showRemainingTime: false, cartwall: false, cartwallLastMode: 'floating', auxiliaryPanel: false, auxiliaryPanelLastMode: 'floating', auxiliaryPanelLayout: 'stacked', rightPanelOrder: 'cartwall-first', rightPanelView: 'cartwall' };
try { if (fs.existsSync(uiPrefsPath)) uiPrefs = { ...uiPrefs, ...JSON.parse(fs.readFileSync(uiPrefsPath, 'utf-8')) }; } catch(e) {}
function saveUiPrefs() { try { fs.writeFileSync(uiPrefsPath, JSON.stringify(uiPrefs, null, 2)); } catch(e) {} }
if (uiPrefs.cartwall) uiPrefs.cartwallLastMode = 'docked';
const generalSettingsPath = path.join(configDir, 'general_settings.json');
let keyboardShortcutScope = loadJsonConfig(generalSettingsPath, {}).keyboardShortcutScope || 'contextual';
const shortcutEditableByWebContents = new Map();

const cwConfigPath = path.join(configDir, 'cartwall_profiles.json');
const fileTypesPath = path.join(configDir, 'file_types.json');
const explicitTypesPath = path.join(configDir, 'explicit_types.json');
const fileTypeOptionsPath = path.join(configDir, 'file_type_options.json');

let mainWindow;
let activePlaylistTab = 0;
// Nombres + orden visual de las playlists para el menú "Lista". Cada entrada es
// { index: <índice lógico 0-3>, name: <rótulo> }, en el orden visual elegido por
// el usuario. El renderer lo sincroniza vía IPC 'playlist-names-changed'. El
// `index` es lo que se envía al renderer al hacer click, así que el ruteo de
// audio sigue ligado a la identidad lógica, nunca al nombre ni a la posición.
let playlistMenuList = [
    { index: 0, name: 'Playlist 1' }, { index: 1, name: 'Playlist 2' },
    { index: 2, name: 'Playlist 3' }, { index: 3, name: 'Playlist 4' }
];
let settingsWindow; let eventEditorWindow; let eventEditorContextKey = null; let eventGroupsWindow; let commercialManagerWindow = null; let genreEditorWindow = null; let artistCatalogWindow = null; let audioEditorWindow; let previewWindow; let encoderWindow; let libraryWindow = null; let artistCardWindow = null; let musicSeparationWindow = null;
let transitionEditorWindow = null; let jingleEditorWindow = null; let consoleWindow = null; let taskManagerWindow = null; let reportsWindow = null; let cartwallWindow = null; let cartwallDockRequested = false; let auxiliaryWindow = null; let auxiliaryDockRequested = false; let aboutWindow = null;
let fileTypesManagerWindow = null;
let ffmpegProcess = null; let activeEncoderConfig = null; let isAppQuitting = false; let forceQuit = false;
let lastEditorSource = 'playlist'; 
let lastVuLevels = {
    pgm: 0,
    monitor: 0,
    cue: 0,
    jingle: 0,
    cartwall: 0,
    playlists: [0, 0, 0, 0],
    rustMeters: [],
    rustMetersUpdatedAt: 0,
    stereo: {
        pgm: { left: 0, right: 0 },
        monitor: { left: 0, right: 0 },
        cue: { left: 0, right: 0 },
        jingle: { left: 0, right: 0 },
        cartwall: { left: 0, right: 0 },
        playlists: Array.from({ length: 4 }, () => ({ left: 0, right: 0 }))
    },
    dbs: {
        pgm: Number.NEGATIVE_INFINITY,
        monitor: Number.NEGATIVE_INFINITY,
        cue: Number.NEGATIVE_INFINITY,
        jingle: Number.NEGATIVE_INFINITY,
        cartwall: Number.NEGATIVE_INFINITY,
        playlists: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    },
    stereoDbs: {
        pgm: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        monitor: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        cue: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        jingle: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        cartwall: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY },
        playlists: Array.from({ length: 4 }, () => ({ left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }))
    },
    diagnostics: {
        activeMode: 'webAudio',
        requestedMode: 'webAudio',
        adapter: 'WebAudioEngineAdapter',
        rustAvailable: false,
        players: [],
        buses: [],
        devices: {},
        latency: { masterMs: 0, monitorMs: null, cueMs: null, note: '' },
        encoder: { active: false, source: 'renderer-media-recorder' },
        warnings: []
    }
};
const auxCueSources = {
    preview: {
        cue: 0,
        cueDb: Number.NEGATIVE_INFINITY,
        cueStereo: { left: 0, right: 0 },
        cueStereoDbs: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }
    },
    'audio-editor': {
        cue: 0,
        cueDb: Number.NEGATIVE_INFINITY,
        cueStereo: { left: 0, right: 0 },
        cueStereoDbs: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }
    },
    'transition-editor': {
        cue: 0,
        cueDb: Number.NEGATIVE_INFINITY,
        cueStereo: { left: 0, right: 0 },
        cueStereoDbs: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }
    },
    'jingle-editor': {
        cue: 0,
        cueDb: Number.NEGATIVE_INFINITY,
        cueStereo: { left: 0, right: 0 },
        cueStereoDbs: { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }
    }
};

function getAuxCueLevel() {
    return Math.max(0, ...Object.values(auxCueSources).map(value => Number(value?.cue) || 0));
}

function getAuxCueDb() {
    const dbValues = Object.values(auxCueSources).map(value => {
        if (value?.cueDb === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
        const parsed = Number(value?.cueDb);
        return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    });
    return dbValues.length ? Math.max(...dbValues) : Number.NEGATIVE_INFINITY;
}

function getAuxCueStereo() {
    return Object.values(auxCueSources).reduce((acc, value) => {
        acc.left = Math.max(acc.left, resolveLevel(value?.cueStereo?.left, 0));
        acc.right = Math.max(acc.right, resolveLevel(value?.cueStereo?.right, 0));
        return acc;
    }, { left: 0, right: 0 });
}

function getAuxCueStereoDbs() {
    return Object.values(auxCueSources).reduce((acc, value) => {
        acc.left = Math.max(acc.left, resolveDb(value?.cueStereoDbs?.left, Number.NEGATIVE_INFINITY));
        acc.right = Math.max(acc.right, resolveDb(value?.cueStereoDbs?.right, Number.NEGATIVE_INFINITY));
        return acc;
    }, { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY });
}

function resolveLevel(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDb(value, fallback = Number.NEGATIVE_INFINITY) {
    if (value === null || value === undefined || value === '') return fallback;
    if (value === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveStereoPair(pair, fallback = { left: 0, right: 0 }) {
    return {
        left: resolveLevel(pair?.left, fallback.left),
        right: resolveLevel(pair?.right, fallback.right)
    };
}

function resolveStereoDbPair(pair, fallback = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }) {
    return {
        left: resolveDb(pair?.left, fallback.left),
        right: resolveDb(pair?.right, fallback.right)
    };
}

function buildVuPayload(levels = {}) {
    const playlists = Array.isArray(levels.playlists) ? levels.playlists : lastVuLevels.playlists;
    const dbs = levels.dbs || {};
    const stereo = levels.stereo || {};
    const stereoDbs = levels.stereoDbs || {};
    const lastDbs = lastVuLevels.dbs || {};
    const lastStereo = lastVuLevels.stereo || {};
    const lastStereoDbs = lastVuLevels.stereoDbs || {};
    const auxCueStereo = getAuxCueStereo();
    const auxCueStereoDbs = getAuxCueStereoDbs();
    return {
        pgm: resolveLevel(levels.pgm, lastVuLevels.pgm),
        monitor: resolveLevel(levels.monitor, lastVuLevels.monitor),
        cue: Math.max(resolveLevel(levels.cue, lastVuLevels.cue), getAuxCueLevel()),
        jingle: resolveLevel(levels.jingle, lastVuLevels.jingle),
        cartwall: resolveLevel(levels.cartwall, lastVuLevels.cartwall),
        playlists: Array.isArray(playlists) ? playlists : [0, 0, 0, 0],
        rustMeters: Array.isArray(levels.rustMeters) ? levels.rustMeters : (Array.isArray(lastVuLevels.rustMeters) ? lastVuLevels.rustMeters : []),
        rustMetersUpdatedAt: resolveLevel(levels.rustMetersUpdatedAt, lastVuLevels.rustMetersUpdatedAt || 0),
        stereo: {
            pgm: resolveStereoPair(stereo.pgm, lastStereo.pgm),
            monitor: resolveStereoPair(stereo.monitor, lastStereo.monitor),
            cue: {
                left: Math.max(resolveStereoPair(stereo.cue, lastStereo.cue).left, auxCueStereo.left),
                right: Math.max(resolveStereoPair(stereo.cue, lastStereo.cue).right, auxCueStereo.right)
            },
            jingle: resolveStereoPair(stereo.jingle, lastStereo.jingle),
            cartwall: resolveStereoPair(stereo.cartwall, lastStereo.cartwall),
            playlists: Array.from({ length: 4 }, (_, idx) => resolveStereoPair(Array.isArray(stereo.playlists) ? stereo.playlists[idx] : undefined, Array.isArray(lastStereo.playlists) ? lastStereo.playlists[idx] : { left: 0, right: 0 }))
        },
        dbs: {
            pgm: resolveDb(dbs.pgm, lastDbs.pgm),
            monitor: resolveDb(dbs.monitor, lastDbs.monitor),
            cue: Math.max(resolveDb(dbs.cue, lastDbs.cue), getAuxCueDb()),
            jingle: resolveDb(dbs.jingle, lastDbs.jingle),
            cartwall: resolveDb(dbs.cartwall, lastDbs.cartwall),
            playlists: Array.from({ length: 4 }, (_, idx) => resolveDb(Array.isArray(dbs.playlists) ? dbs.playlists[idx] : undefined, Array.isArray(lastDbs.playlists) ? lastDbs.playlists[idx] : Number.NEGATIVE_INFINITY))
        },
        stereoDbs: {
            pgm: resolveStereoDbPair(stereoDbs.pgm, lastStereoDbs.pgm),
            monitor: resolveStereoDbPair(stereoDbs.monitor, lastStereoDbs.monitor),
            cue: {
                left: Math.max(resolveStereoDbPair(stereoDbs.cue, lastStereoDbs.cue).left, auxCueStereoDbs.left),
                right: Math.max(resolveStereoDbPair(stereoDbs.cue, lastStereoDbs.cue).right, auxCueStereoDbs.right)
            },
            jingle: resolveStereoDbPair(stereoDbs.jingle, lastStereoDbs.jingle),
            cartwall: resolveStereoDbPair(stereoDbs.cartwall, lastStereoDbs.cartwall),
            playlists: Array.from({ length: 4 }, (_, idx) => resolveStereoDbPair(Array.isArray(stereoDbs.playlists) ? stereoDbs.playlists[idx] : undefined, Array.isArray(lastStereoDbs.playlists) ? lastStereoDbs.playlists[idx] : { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY }))
        },
        diagnostics: levels.diagnostics || lastVuLevels.diagnostics || {}
    };
}

function broadcastVuLevels(levels = lastVuLevels) {
    lastVuLevels = buildVuPayload(levels);
    scheduleVuBroadcast();
}

const VU_BROADCAST_MIN_INTERVAL_MS = 20;
let lastVuBroadcastAt = 0;
let pendingVuBroadcastTimer = null;

function sendVuToConsole() {
    if (!consoleWindow || consoleWindow.isDestroyed()) return;
    lastVuBroadcastAt = Date.now();
    consoleWindow.webContents.send('update-vu', lastVuLevels);
}

function scheduleVuBroadcast(immediate = false) {
    if (!consoleWindow || consoleWindow.isDestroyed()) return;
    const elapsed = Date.now() - lastVuBroadcastAt;
    if (immediate || elapsed >= VU_BROADCAST_MIN_INTERVAL_MS) {
        if (pendingVuBroadcastTimer) {
            clearTimeout(pendingVuBroadcastTimer);
            pendingVuBroadcastTimer = null;
        }
        sendVuToConsole();
        return;
    }
    if (!pendingVuBroadcastTimer) {
        pendingVuBroadcastTimer = setTimeout(() => {
            pendingVuBroadcastTimer = null;
            sendVuToConsole();
        }, VU_BROADCAST_MIN_INTERVAL_MS - elapsed);
    }
}

const scrubbedLogPaths = new Set();
function scrubPersistentLogOnce(filePath) {
    if (scrubbedLogPaths.has(filePath)) return;
    scrubLogFile(filePath);
    scrubbedLogPaths.add(filePath);
}

function writeLog(msg) {
    const timeStr = new Date().toLocaleString('es-PE', { hour12: false });
    const finalMsg = `[${timeStr}] ${redactSensitiveText(msg)}\n`;
    const primaryLogPath = path.join(configDir, 'ERROR_ANALYZER_LOG.txt');
    try {
        scrubPersistentLogOnce(primaryLogPath);
        rotateLogIfNeeded(primaryLogPath);
        fs.appendFileSync(primaryLogPath, finalMsg);
    } catch (err) {
        try {
            const fallbackLogPath = path.join(os.tmpdir(), 'LF-Automatizador-ERROR_ANALYZER_LOG.txt');
            scrubPersistentLogOnce(fallbackLogPath);
            rotateLogIfNeeded(fallbackLogPath);
            fs.appendFileSync(fallbackLogPath, finalMsg);
        } catch (fallbackErr) {}
    }
}

// getTrackFileSignature, storeTrackFileSignature y mapTrackRowToClient ahora
// viven en backend/services/track_mapper.js, compartidos con library_worker.js
// para que la carga masiva de pistas corra fuera del proceso principal.


// Lectura acotada de tags (solo la cabecera ID3, no el archivo completo):
// misma implementación compartida que usan el índice musical y el worker de
// metadatos. La escritura (writeTagsAsync) sigue con node-id3 completo.
const readTagsAsync = (file) => readId3TagsAsync(file);
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
        writeLog(`Archivo no legible por Windows: ${filePath} (${err.message})`);
        return false;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (err) {}
        }
    }
}



const selectTrackByPathStmt = db.prepare("SELECT * FROM tracks WHERE file_path = ?");
const upsertTrackAnalysisForceStmt = db.prepare(`INSERT INTO tracks (file_path, db, peak_db, mix, fin, inicio, duration, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET db=excluded.db, peak_db=excluded.peak_db, mix=excluded.mix, fin=excluded.fin, inicio=excluded.inicio, duration=excluded.duration, file_size=excluded.file_size, file_mtime_ms=excluded.file_mtime_ms`);
const upsertTrackAnalysisFillStmt = db.prepare(`INSERT INTO tracks (file_path, db, peak_db, mix, fin, inicio, duration, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET db=COALESCE(NULLIF(tracks.db, ''), excluded.db), peak_db=COALESCE(NULLIF(tracks.peak_db, ''), excluded.peak_db), mix=COALESCE(NULLIF(tracks.mix, ''), excluded.mix), fin=COALESCE(NULLIF(tracks.fin, ''), excluded.fin), inicio=COALESCE(NULLIF(tracks.inicio, ''), excluded.inicio), duration=excluded.duration, file_size=excluded.file_size, file_mtime_ms=excluded.file_mtime_ms`);
const upsertLocalMetaForceStmt = db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = excluded.custom_title, custom_artist = excluded.custom_artist, feat = excluded.feat, is_remix = excluded.is_remix, album = excluded.album, year = excluded.year, genre = excluded.genre, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const upsertLocalMetaFillStmt = db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, file_size, file_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = COALESCE(NULLIF(tracks.custom_title, ''), excluded.custom_title), custom_artist = COALESCE(NULLIF(tracks.custom_artist, ''), excluded.custom_artist), feat = COALESCE(NULLIF(tracks.feat, ''), excluded.feat), is_remix = COALESCE(tracks.is_remix, excluded.is_remix), album = COALESCE(NULLIF(tracks.album, ''), excluded.album), year = COALESCE(NULLIF(tracks.year, ''), excluded.year), genre = COALESCE(NULLIF(tracks.genre, ''), excluded.genre), file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms`);
const selectTrackMetaForWriteStmt = db.prepare("SELECT custom_title, custom_artist, feat, is_remix, album, year, genre FROM tracks WHERE file_path = ?");
const saveDbTrackStmt = db.prepare(`
    INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre, inicio, intro, mix, outro, fin, p1_active, p1_mode, p1_time, p1_file, p1_options, p2_active, p2_mode, p2_time, p2_file, p2_options, p3_active, p3_mode, p3_time, p3_file, p3_options, p4_active, p4_mode, p4_time, p4_file, p4_options, phora_active, phora_mode, phora_time, file_size, file_mtime_ms)
    VALUES (@filePath, @customTitle, @customArtist, @feat, @is_remix, @album, @year, @genre, @inicio, @intro, @mix, @outro, @fin, @p1_active, @p1_mode, @p1_time, @p1_file, @p1_options, @p2_active, @p2_mode, @p2_time, @p2_file, @p2_options, @p3_active, @p3_mode, @p3_time, @p3_file, @p3_options, @p4_active, @p4_mode, @p4_time, @p4_file, @p4_options, @phora_active, @phora_mode, @phora_time, @fileSize, @fileMtimeMs)
    ON CONFLICT(file_path) DO UPDATE SET
        custom_title = @customTitle, custom_artist = @customArtist, feat = @feat, is_remix = @is_remix, album = @album, year = @year, genre = @genre,
        inicio = @inicio, intro = @intro, mix = @mix, outro = @outro, fin = @fin,
        p1_active = @p1_active, p1_mode = @p1_mode, p1_time = @p1_time, p1_file = @p1_file, p1_options = @p1_options,
        p2_active = @p2_active, p2_mode = @p2_mode, p2_time = @p2_time, p2_file = @p2_file, p2_options = @p2_options,
        p3_active = @p3_active, p3_mode = @p3_mode, p3_time = @p3_time, p3_file = @p3_file, p3_options = @p3_options,
        p4_active = @p4_active, p4_mode = @p4_mode, p4_time = @p4_time, p4_file = @p4_file, p4_options = @p4_options,
        phora_active = @phora_active, phora_mode = @phora_mode, phora_time = @phora_time,
        file_size = @fileSize, file_mtime_ms = @fileMtimeMs
`);
const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i;

































// Inyectar dependencias de género en el módulo de artistas (evita importación circular)


function normalizeClockwheelText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function shuffleClockwheelArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getClockwheelFileTypes() {
    return normalizeFileTypes(loadJsonConfig(fileTypesPath, defaultFileTypes));
}

function getClockwheelExplicitTypes() {
    return loadJsonConfig(explicitTypesPath, {});
}

function getClockwheelFileTypeOptions() {
    return loadJsonConfig(fileTypeOptionsPath, {});
}

function getClockwheelTypeData(filePath, row = null, fileTypes = [], explicitTypes = {}, optionsMap = {}) {
    return fileTypeResolver.resolveFileType(filePath, row, fileTypes, explicitTypes, optionsMap);
}

function getClockwheelGenreCategoryDefs(trackRows = []) {
    const categories = [];
    const seen = new Set();
    const addGenre = (genreKey, displayName, parentGenre = '') => {
        const parentKey = normalizeClockwheelText(parentGenre);
        const baseKey = normalizeClockwheelText(genreKey || displayName);
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

    trackRows.forEach(row => {
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
    });

    return categories.sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name), 'es', { sensitivity: 'base' }));
}

function getClockwheelCategoryDefs(trackRows = [], fileTypes = []) {
    return [
        { id: 'default', name: 'Musica', color: '#e0e0e0', source: 'type' },
        ...fileTypes.map(type => ({
            id: type.id,
            name: type.name,
            color: type.color || '#e0e0e0',
            identifier: type.identifier || '',
            source: 'type'
        })),
        ...getClockwheelGenreCategoryDefs(trackRows)
    ];
}

function resolveClockwheelCategory(token, categoryDefs = []) {
    const clean = normalizeClockwheelText(String(token || '').replace(/^@/, ''));
    if (!clean || ['musica', 'default', 'general', 'normal'].includes(clean)) {
        return { id: 'default', name: 'Musica', color: '#e0e0e0' };
    }
    return categoryDefs.find(category => {
        return normalizeClockwheelText(category.id) === clean
            || normalizeClockwheelText(category.name) === clean
            || normalizeClockwheelText(category.identifier) === clean
            || normalizeClockwheelText(category.genreKey) === clean
            || (Array.isArray(category.aliases) && category.aliases.some(alias => normalizeClockwheelText(alias) === clean));
    }) || null;
}

function getDefaultClockwheelPattern(fileTypes = []) {
    const stationId = fileTypes.find(type => /station|id|pisador|jingle/i.test(`${type.name} ${type.identifier}`));
    return ['Musica', stationId ? stationId.name : null, 'Musica', 'Musica'].filter(Boolean).join('\n');
}

function normalizeClockwheelPrefs(payload = {}, fileTypes = []) {
    const clampInt = (value, fallback, min, max) => {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min, Math.min(max, parsed));
    };
    return {
        pattern: String(payload.pattern || '').trim() || getDefaultClockwheelPattern(fileTypes),
        targetMinutes: clampInt(payload.targetMinutes, 60, 5, 360),
        sepArtist: clampInt(payload.sepArtist, 4, 0, 50),
        sepTitle: clampInt(payload.sepTitle, 8, 0, 50),
        sepFolder: clampInt(payload.sepFolder, 2, 0, 50),
        clearList: payload.clearList === true
    };
}

function getClockwheelPatternCategories(patternText, categoryDefs = [], fileTypes = []) {
    const rawTokens = String(patternText || '').split(/[\n,>]+/).map(token => token.trim()).filter(Boolean);
    const tokens = rawTokens.length ? rawTokens : getDefaultClockwheelPattern(fileTypes).split(/\n/);
    return tokens.map(token => ({ token, category: resolveClockwheelCategory(token, categoryDefs) })).filter(item => item.category);
}

function getClockwheelTrackTitle(row) {
    const filePath = row.file_path || '';
    const baseName = path.basename(filePath, path.extname(filePath));
    const title = String(row.custom_title || '').trim();
    const artist = String(row.custom_artist || '').trim();
    if (artist && title) return `${artist} - ${title}${path.extname(filePath)}`;
    return `${title || baseName}${path.extname(filePath)}`;
}

function getClockwheelArtistKey(row) {
    const artist = String(row.custom_artist || '').trim();
    if (artist) return normalizeClockwheelText(artist);
    const baseName = path.basename(row.file_path || '', path.extname(row.file_path || ''));
    const split = baseName.split(/\s+-\s+/);
    return normalizeClockwheelText(split.length > 1 ? split[0] : baseName);
}

function getClockwheelTitleKey(row) {
    const title = String(row.custom_title || '').trim();
    if (title) return normalizeClockwheelText(title);
    const baseName = path.basename(row.file_path || '', path.extname(row.file_path || ''));
    const split = baseName.split(/\s+-\s+/);
    return normalizeClockwheelText(split.length > 1 ? split.slice(1).join(' - ') : baseName);
}

function getClockwheelDuration(row) {
    const start = parseFloat(row.inicio || 0) || 0;
    const end = parseFloat(row.fin || 0) || 0;
    if (end > start) return Math.round(end - start);
    const duration = parseFloat(row.duration || 0) || 0;
    return duration > 0 ? Math.round(duration) : 180;
}

function getClockwheelTrackGenreCategoryIds(row) {
    const ids = new Set();
    const add = (value) => {
        const key = normalizeClockwheelText(value);
        if (key) ids.add(`genre:${key}`);
    };
    const addSubgenre = (subgenre, parentGenre = '') => {
        const subKey = normalizeClockwheelText(subgenre);
        if (!subKey) return;
        const parentKey = normalizeClockwheelText(parentGenre);
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

function addClockwheelCandidate(byCategory, catId, track) {
    if (!byCategory.has(catId)) byCategory.set(catId, []);
    byCategory.get(catId).push(track);
}

function isClockwheelTimeLocutionTrack(track) {
    return track?.rowType === 'time' || track?.filePath === 'time_locution';
}

function getClockwheelCandidates(trackRows = [], categoryDefs = [], fileTypes = [], explicitTypes = {}, fileTypeOptions = {}) {
    const byCategory = new Map();
    categoryDefs.forEach(category => byCategory.set(category.id, []));
    const timeCategory = fileTypes.find(type => /locuci|hora|time|saytime/i.test(`${type.name} ${type.identifier}`));
    if (timeCategory) {
        addClockwheelCandidate(byCategory, timeCategory.id, {
            filePath: 'time_locution',
            title: '⌚ Locución de hora',
            duration: 5,
            artistKey: 'locucion-hora',
            titleKey: 'locucion-hora',
            folderKey: 'time',
            rowType: 'time'
        });
    }

    trackRows.forEach(row => {
        const filePath = row.file_path || '';
        if (!filePath || !AUDIO_FILE_RE.test(filePath)) return;
        const typeData = getClockwheelTypeData(filePath, row, fileTypes, explicitTypes, fileTypeOptions);
        const catId = typeData ? typeData.id : 'default';
        const track = {
            filePath,
            title: getClockwheelTrackTitle(row),
            duration: getClockwheelDuration(row),
            artistKey: getClockwheelArtistKey(row),
            titleKey: getClockwheelTitleKey(row),
            folderKey: normalizeClockwheelText(path.dirname(filePath)),
            rowType: 'normal'
        };
        addClockwheelCandidate(byCategory, catId, track);
        getClockwheelTrackGenreCategoryIds(row).forEach(genreCatId => addClockwheelCandidate(byCategory, genreCatId, track));
    });

    byCategory.forEach((tracks, catId) => byCategory.set(catId, shuffleClockwheelArray([...tracks])));
    return byCategory;
}

function wasClockwheelRecentlyUsed(value, recent, distance) {
    if (!value || distance <= 0) return false;
    return recent.slice(-distance).includes(value);
}

function pickClockwheelTrack(pool, recent, prefs) {
    if (!pool || pool.length === 0) return null;
    const passes = [
        track => (isClockwheelTimeLocutionTrack(track) || !recent.paths.includes(track.filePath))
            && !wasClockwheelRecentlyUsed(track.artistKey, recent.artists, prefs.sepArtist)
            && !wasClockwheelRecentlyUsed(track.titleKey, recent.titles, prefs.sepTitle)
            && !wasClockwheelRecentlyUsed(track.folderKey, recent.folders, prefs.sepFolder),
        track => (isClockwheelTimeLocutionTrack(track) || !recent.paths.includes(track.filePath))
            && !wasClockwheelRecentlyUsed(track.artistKey, recent.artists, Math.floor(prefs.sepArtist / 2))
            && !wasClockwheelRecentlyUsed(track.titleKey, recent.titles, Math.floor(prefs.sepTitle / 2)),
        track => isClockwheelTimeLocutionTrack(track) || !recent.paths.includes(track.filePath),
        () => true
    ];
    for (const predicate of passes) {
        const index = pool.findIndex(predicate);
        if (index >= 0) {
            const track = pool[index];
            return isClockwheelTimeLocutionTrack(track) ? { ...track } : pool.splice(index, 1)[0];
        }
    }
    return null;
}

function buildClockwheelPlan(payload = {}) {
    const fileTypes = getClockwheelFileTypes();
    const explicitTypes = getClockwheelExplicitTypes();
    const fileTypeOptions = getClockwheelFileTypeOptions();
    const trackRows = db.prepare(`
        SELECT file_path, custom_title, custom_artist, genre, primary_genre, subgenre, genres_json,
               inicio, fin, duration
        FROM tracks
    `).all();
    const prefs = normalizeClockwheelPrefs(payload, fileTypes);
    const categoryDefs = getClockwheelCategoryDefs(trackRows, fileTypes);
    const pattern = getClockwheelPatternCategories(prefs.pattern, categoryDefs, fileTypes);
    const byCategory = getClockwheelCandidates(trackRows, categoryDefs, fileTypes, explicitTypes, fileTypeOptions);
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
        const track = pickClockwheelTrack(pool, recent, prefs);
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
        candidateCount: trackRows.length
    };
}







function getMetadataSourceConfig() {
    const config = loadJsonConfig(path.join(configDir, 'metadata_sources.json'), {});
    return {
        deezer: { enabled: config?.deezer?.enabled !== false },
        spotify: {
            enabled: config?.spotify?.enabled === true || !!process.env.LF_SPOTIFY_CLIENT_ID,
            clientId: String(config?.spotify?.clientId || process.env.LF_SPOTIFY_CLIENT_ID || '').trim(),
            clientSecret: String(config?.spotify?.clientSecret || process.env.LF_SPOTIFY_CLIENT_SECRET || '').trim()
        },
        appleMusic: {
            enabled: config?.appleMusic?.enabled === true || !!process.env.LF_APPLE_MUSIC_TOKEN,
            developerToken: String(config?.appleMusic?.developerToken || process.env.LF_APPLE_MUSIC_TOKEN || '').trim(),
            storefront: String(config?.appleMusic?.storefront || process.env.LF_APPLE_MUSIC_STOREFRONT || 'us').trim().toLowerCase()
        },
        musixmatch: {
            enabled: config?.musixmatch?.enabled === true || !!process.env.LF_MUSIXMATCH_API_KEY,
            apiKey: String(config?.musixmatch?.apiKey || process.env.LF_MUSIXMATCH_API_KEY || '').trim()
        }
    };
}

function bestArtistMatch(items, artistName, getName, minScore = 0.5) {
    const expected = tokenSet(artistName);
    let best = null;
    let bestScore = -1;
    for (const item of Array.isArray(items) ? items : []) {
        const score = jaccard(expected, tokenSet(getName(item) || ''));
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return best && bestScore >= minScore ? best : null;
}

function rememberArtistMetadataSource(result, source, details = {}) {
    if (!result.metadataSources) result.metadataSources = [];
    const existing = result.metadataSources.find(item => item.source === source);
    if (!existing) result.metadataSources.push({ source, ...details });
}

function fillArtistMetadata(result, source, data = {}) {
    let changed = false;
    if (data.country && !result.country) {
        result.country = data.country;
        changed = true;
    }
    if (data.countryCode && !result.countryCode) {
        result.countryCode = data.countryCode;
        changed = true;
    }
    if (data.artistType && !result.artistType) {
        result.artistType = data.artistType;
        changed = true;
    }
    if (data.photoUrl && !result.photoUrl) {
        result.photoUrl = data.photoUrl;
        result.photoSource = source;
        result.photoDownloadAllowed = !['spotify', 'applemusic'].includes(source);
        changed = true;
    }
    if (changed || data.externalId || data.url) {
        result.externalSource = result.externalSource || source;
        result.externalId = result.externalId || data.externalId || data.url || '';
        rememberArtistMetadataSource(result, source, { id: data.externalId || '', url: data.url || '', photo: !!data.photoUrl });
    }
}

async function fetchSpotifyAccessToken(config) {
    if (!config.clientId || !config.clientSecret) return '';
    await waitRateLimit('spotify-token', 1000);
    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    if (!response.ok) return '';
    const data = await response.json();
    return data?.access_token || '';
}

async function fetchArtistMetadataOnline(displayName) {
    const artistName = String(displayName || '').trim();
    if (!artistName) return { success: false, error: 'Artista invalido' };
    const sourceConfig = getMetadataSourceConfig();
    const result = {
        success: true,
        displayName: artistName,
        country: '',
        countryCode: '',
        artistType: '',
        photoUrl: '',
        photoSource: '',
        photoDownloadAllowed: true,
        externalSource: '',
        externalId: '',
        metadataSources: [],
        fetchedAt: new Date().toISOString()
    };

    try {
        await waitRateLimit('musicbrainz-artist', 1100);
        const mbUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artistName}"`)}&fmt=json&limit=5`;
        const mbResponse = await fetch(mbUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0 ( luisfernando@local )' } });
        if (mbResponse.ok) {
            const mbData = await mbResponse.json();
            const best = bestArtistMatch(mbData.artists || [], artistName, candidate => candidate.name || candidate['sort-name'] || '', 0.48);
            if (best) {
                fillArtistMetadata(result, 'musicbrainz', {
                    countryCode: best.country || '',
                    country: best.area?.name || best['begin-area']?.name || best.country || '',
                    artistType: inferArtistTypeFromMetadata(artistName, best, null),
                    externalId: best.id || ''
                });
            }
        }
    } catch (err) {}

    try {
        await waitRateLimit('theaudiodb-artist', 300);
        const adbUrl = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artistName)}`;
        const adbResponse = await fetch(adbUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
        if (adbResponse.ok) {
            const adbData = await adbResponse.json();
            const artist = Array.isArray(adbData.artists) ? adbData.artists[0] : null;
            if (artist) {
                fillArtistMetadata(result, 'theaudiodb', {
                    country: artist.strCountry || '',
                    artistType: inferArtistTypeFromMetadata(artistName, null, artist),
                    photoUrl: artist.strArtistThumb || artist.strArtistFanart || '',
                    externalId: artist.idArtist || ''
                });
            }
        }
    } catch (err) {}

    if (!result.photoUrl && sourceConfig.deezer.enabled) {
        try {
            await waitRateLimit('deezer-artist', 350);
            const deezerUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=5`;
            const deezerResponse = await fetch(deezerUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
            if (deezerResponse.ok) {
                const deezerData = await deezerResponse.json();
                const artist = bestArtistMatch(deezerData.data || [], artistName, item => item.name || '', 0.48);
                if (artist) {
                    fillArtistMetadata(result, 'deezer', {
                        photoUrl: artist.picture_medium || artist.picture_big || artist.picture_xl || artist.picture || '',
                        externalId: artist.id ? String(artist.id) : '',
                        url: artist.link || ''
                    });
                }
            }
        } catch (err) {}
    }

    if (!result.photoUrl && sourceConfig.spotify.enabled && sourceConfig.spotify.clientId && sourceConfig.spotify.clientSecret) {
        try {
            const token = await fetchSpotifyAccessToken(sourceConfig.spotify);
            if (token) {
                await waitRateLimit('spotify-artist-search', 350);
                const spotifyUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=5`;
                const spotifyResponse = await fetch(spotifyUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                if (spotifyResponse.ok) {
                    const spotifyData = await spotifyResponse.json();
                    const artist = bestArtistMatch(spotifyData?.artists?.items || [], artistName, item => item.name || '', 0.48);
                    const image = artist?.images?.find(item => item.width <= 640) || artist?.images?.[0];
                    if (artist) {
                        fillArtistMetadata(result, 'spotify', {
                            photoUrl: image?.url || '',
                            externalId: artist.id || '',
                            url: artist.external_urls?.spotify || '',
                            artistType: inferArtistTypeFromMetadata(artistName, null, { intMembers: 0 })
                        });
                    }
                }
            }
        } catch (err) {}
    }

    if (!result.photoUrl && sourceConfig.appleMusic.enabled && sourceConfig.appleMusic.developerToken) {
        try {
            await waitRateLimit('applemusic-artist', 350);
            const storefront = sourceConfig.appleMusic.storefront || 'us';
            const appleUrl = `https://api.music.apple.com/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(artistName)}&types=artists&limit=5`;
            const appleResponse = await fetch(appleUrl, { headers: { 'Authorization': `Bearer ${sourceConfig.appleMusic.developerToken}` } });
            if (appleResponse.ok) {
                const appleData = await appleResponse.json();
                const artist = bestArtistMatch(appleData?.results?.artists?.data || [], artistName, item => item.attributes?.name || '', 0.48);
                const artwork = artist?.attributes?.artwork;
                const artUrl = artwork?.url ? artwork.url.replace('{w}x{h}', '500x500') : '';
                if (artist) {
                    fillArtistMetadata(result, 'applemusic', {
                        photoUrl: artUrl,
                        externalId: artist.id || '',
                        url: artist.attributes?.url || ''
                    });
                }
            }
        } catch (err) {}
    }

    if ((!result.country && !result.countryCode) && sourceConfig.musixmatch.enabled && sourceConfig.musixmatch.apiKey) {
        try {
            await waitRateLimit('musixmatch-artist', 350);
            const mxUrl = `https://api.musixmatch.com/ws/1.1/artist.search?q_artist=${encodeURIComponent(artistName)}&page_size=5&apikey=${encodeURIComponent(sourceConfig.musixmatch.apiKey)}`;
            const mxResponse = await fetch(mxUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
            if (mxResponse.ok) {
                const mxData = await mxResponse.json();
                const list = mxData?.message?.body?.artist_list?.map(item => item.artist) || [];
                const artist = bestArtistMatch(list, artistName, item => item.artist_name || '', 0.48);
                if (artist) {
                    fillArtistMetadata(result, 'musixmatch', {
                        countryCode: artist.artist_country || '',
                        externalId: artist.artist_id ? String(artist.artist_id) : '',
                        url: artist.artist_share_url || ''
                    });
                }
            }
        } catch (err) {}
    }

    if (!result.photoUrl) {
        for (const wikiLang of ['es', 'en']) {
            if (result.photoUrl) break;
            try {
                await waitRateLimit(`wikipedia-artist-${wikiLang}`, 250);
                const searchText = wikiLang === 'es' ? `${artistName} cantante musica` : `${artistName} singer musician`;
                const wikiSearchUrl = `https://${wikiLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchText)}&format=json&origin=*&srlimit=3`;
                const wikiSearchResponse = await fetch(wikiSearchUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
                if (wikiSearchResponse.ok) {
                    const wikiSearch = await wikiSearchResponse.json();
                    const page = wikiSearch?.query?.search?.[0];
                    if (page?.title) {
                        const summaryUrl = `https://${wikiLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title)}`;
                        const summaryResponse = await fetch(summaryUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
                        if (summaryResponse.ok) {
                            const summary = await summaryResponse.json();
                            result.photoUrl = summary?.thumbnail?.source || summary?.originalimage?.source || '';
                            result.country = result.country || '';
                            result.externalSource = result.externalSource || `wikipedia-${wikiLang}`;
                            result.externalId = result.externalId || page.title;
                        }
                    }
                }
            } catch (err) {}
        }
    }

    result.artistType = result.artistType || inferArtistTypeFromMetadata(artistName, null, null);
    if (!result.country && result.countryCode) {
        const resolved = resolveCountryProfile(result.countryCode);
        result.country = resolved.name || result.countryCode;
    }

    return result;
}

async function autofillArtistProfilesFromCatalog(payload = {}) {
    const requestedKeys = [...new Set((Array.isArray(payload.artistKeys) ? payload.artistKeys : []).map(key => String(key || '').trim()).filter(Boolean))];
    if (!requestedKeys.length) return { success: false, error: 'No hay artistas para completar.' };
    const onlyMissing = payload.onlyMissing !== false;
    const total = requestedKeys.length;
    let updated = 0;
    let failed = 0;
    let withPhoto = 0;
    const details = [];

    for (let i = 0; i < requestedKeys.length; i++) {
        const artistKey = requestedKeys[i];
        const card = getArtistCardByKey(artistKey);
        if (!card) {
            failed++;
            continue;
        }
        if (artistCatalogWindow && !artistCatalogWindow.isDestroyed()) {
            artistCatalogWindow.webContents.send('artist-catalog-autofill-progress', {
                index: i + 1,
                total,
                artistKey,
                displayName: card.displayName || artistKey
            });
        }
        try {
            const meta = await fetchArtistMetadataOnline(card.displayName || artistKey);
            if (!meta?.success) {
                failed++;
                details.push({ artistKey, ok: false, error: meta?.error || 'Sin datos' });
                continue;
            }

            const nextType = (!onlyMissing || !card.artistType) ? (meta.artistType || card.artistType || '') : (card.artistType || '');
            const nextNationality = (!onlyMissing || !(card.nationalities || card.country))
                ? (meta.country || card.nationalities || card.country || '')
                : (card.nationalities || card.country || '');
            let nextPhotoLocalPath = card.photoLocalPath || '';
            if ((!onlyMissing || !nextPhotoLocalPath) && meta.photoUrl && meta.photoDownloadAllowed !== false) {
                try {
                    nextPhotoLocalPath = await downloadArtistImage(card.displayName || artistKey, meta.photoUrl);
                } catch (err) {
                    writeLog("Error descargando foto masiva de artista: " + err.message);
                }
            }
            const nextPhotoUrl = (!onlyMissing || !card.photoUrl) ? (meta.photoUrl || card.photoUrl || '') : (card.photoUrl || '');

            const saveResult = saveArtistCard({
                artistKey: card.artistKey,
                displayName: card.displayName,
                artistType: nextType,
                nationalities: nextNationality,
                country: nextNationality,
                mainGenre: card.mainGenreName || card.habitualGenreName || 'N/A Multigenero',
                mainGenreKey: card.mainGenreKey || card.habitualGenre || '',
                habitualGenre: card.habitualGenreName || card.mainGenreName || 'N/A Multigenero',
                subgenresCsv: card.subgenresCsv || '',
                biography: card.biography || card.notes || '',
                notes: card.biography || card.notes || '',
                photoUrl: nextPhotoUrl,
                photoLocalPath: nextPhotoLocalPath,
                externalSource: meta.externalSource || card.externalSource || '',
                externalId: meta.externalId || card.externalId || '',
                metadataFetchedAt: meta.fetchedAt || card.metadataFetchedAt || null
            });
            if (saveResult?.success) {
                updated++;
                if (nextPhotoLocalPath || nextPhotoUrl) withPhoto++;
                details.push({
                    artistKey,
                    ok: true,
                    photo: !!(nextPhotoLocalPath || nextPhotoUrl),
                    artistType: nextType,
                    country: nextNationality,
                    sources: meta.metadataSources || []
                });
            } else {
                failed++;
                details.push({ artistKey, ok: false, error: saveResult?.error || 'No se pudo guardar' });
            }
        } catch (err) {
            failed++;
            writeLog("Error autofill artist catalog: " + err.message);
            details.push({ artistKey, ok: false, error: err.message });
        }
    }

    sendToWindowSafe(mainWindow, 'refresh-manual-cues');
    sendToWindowSafe(libraryWindow, 'refresh-manual-cues');
    if (artistCatalogWindow && !artistCatalogWindow.isDestroyed()) artistCatalogWindow.webContents.send('artist-catalog-updated');
    return { success: true, total, updated, failed, withPhoto, details };
}

































const runFfmpegCommand = (bin, args) => new Promise((resolve, reject) => {
    const proc = cp.spawn(bin, args, { windowsHide: true });
    let output = '';
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve(output));
});

const CPU_COUNT = Math.max(1, os.cpus()?.length || 2);
let analysisQueue = []; let activeWorkers = 0; const MAX_CONCURRENT = Math.max(1, Math.min(3, Math.floor(CPU_COUNT / 2))); 
ipcMain.on('lib-start-analyzer-ffmpeg', (e, tasks) => {
    analysisQueue = [];
    activeWorkers = 0;
    if (!Array.isArray(tasks) || tasks.length === 0) {
        stopAudioAnalysisWorker();
        return;
    }
    startAudioAnalysisWorker(tasks);
});

async function processNextInQueue() {
    if (analysisQueue.length === 0 || activeWorkers >= MAX_CONCURRENT) return; 
    activeWorkers++; 
    const task = analysisQueue.shift(); 
    const filePath = task.filePath;
    const thresholdMix = (task.dbMix ?? -14); 
    const thresholdStart = (task.dbStart ?? -36); 
    const thresholdFin = (task.dbFin ?? -48); 
    try {
        const volArgs = ['-hide_banner', '-nostats', '-threads', '1', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'];
        const volOutput = await runFfmpegCommand(ffmpegPath, volArgs);
        const meanVolumeMatch = volOutput.match(/mean_volume:\s*([\-\d\.]+)/); 
        const maxVolumeMatch = volOutput.match(/max_volume:\s*([\-\d\.]+)/);
        const durationMatch = volOutput.match(/Duration:\s*([\d\:\.]+)/);
        if (!durationMatch) throw new Error("FFmpeg no pudo leer la duración del archivo.");
        const totalDur = timeToSeconds(durationMatch[1]); 
        const dbValue = meanVolumeMatch ? parseFloat(meanVolumeMatch[1]) : -14.0;
        let rawPeak = maxVolumeMatch ? parseFloat(maxVolumeMatch[1]) : dbValue;
        let peakDbValue = rawPeak > 3.0 ? 3.0 : rawPeak; 
        const mathPeak = Math.min(rawPeak, 0.0); 
        const dynamicMix = (mathPeak + thresholdMix).toFixed(1);
        const absoluteStart = thresholdStart.toFixed(1);
        const absoluteFin = thresholdFin.toFixed(1);
        const runSilDetect = async (dbThreshold, durationThreshold) => {
            const out = await runFfmpegCommand(ffmpegPath, ['-hide_banner', '-nostats', '-threads', '1', '-i', filePath, '-af', `silencedetect=n=${dbThreshold}dB:d=${durationThreshold}`, '-f', 'null', '-']);
            let blocks = []; let currentStart = null; const lines = out.split('\n');
            for (let line of lines) { let ms = line.match(/silence_start:\s*([\d\.]+)/); if (ms) { currentStart = parseFloat(ms[1]); } let me = line.match(/silence_end:\s*([\d\.]+)/); if (me) { if (currentStart !== null) { blocks.push({ start: currentStart, end: parseFloat(me[1]) }); currentStart = null; } else { blocks.push({ start: 0, end: parseFloat(me[1]) }); } } }
            if (currentStart !== null) { blocks.push({ start: currentStart, end: totalDur }); } return blocks;
        };
        const startSil = await runSilDetect(absoluteStart, 0.4); const finSil = await runSilDetect(absoluteFin, 0.4); const mixSil = await runSilDetect(dynamicMix, 0.2);
        let inicioPoint = 0.001; if (startSil.length > 0 && startSil[0].start <= 1.5) { inicioPoint = startSil[0].end; }
        let finPoint = totalDur; for (let i = finSil.length - 1; i >= 0; i--) { let block = finSil[i]; if (block.end >= totalDur - 0.5) { finPoint = block.start; break; } }
        let mixPoint = totalDur; for (let i = mixSil.length - 1; i >= 0; i--) { let block = mixSil[i]; if (block.end >= totalDur - 0.5 && block.start <= finPoint) { mixPoint = block.start; break; } }
        if (mixPoint === totalDur || mixPoint >= finPoint) { mixPoint = Math.max(0.001, finPoint - 1.0); }
        const round3 = (v) => Math.round(v * 1000) / 1000; inicioPoint = round3(inicioPoint); if (inicioPoint <= 0.001) inicioPoint = 0.001; 
        const signature = getTrackFileSignature(filePath);
        if (task.forceOverwrite) {
            upsertTrackAnalysisForceStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        } else {
            upsertTrackAnalysisFillStmt.run(filePath, dbValue.toFixed(1), peakDbValue.toFixed(1), mixPoint.toFixed(3), finPoint.toFixed(3), inicioPoint.toFixed(3), totalDur, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        }
        const updatedRow = selectTrackByPathStmt.get(filePath);
        const mappedTrack = mapTrackRowToClient(updatedRow) || {};
        const result = { success: true, filePath, data: { db: mappedTrack.db, peak_db: mappedTrack.peak_db, mix: mappedTrack.mix, fin: mappedTrack.fin, inicio: mappedTrack.inicio, fileChanged: mappedTrack.fileChanged } };
        broadcastAnalyzerResult(result);
    } catch (ex) {
        writeLog(`Error FFmpeg async ${path.basename(filePath)}: ${ex.message}`);
        const errPayload = { success: false, filePath, data: null, error: ex.message };
        broadcastAnalyzerResult(errPayload);
    } finally { activeWorkers--; processNextInQueue(); }
}
function timeToSeconds(timeStr) { const parts = timeStr.split(':'); return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]); }

let metaLocalQueue = []; let activeMetaLocalWorkers = 0; const MAX_META_LOCAL = Math.max(3, Math.min(8, CPU_COUNT)); let metaWriteQueue = []; let activeMetaWriteWorkers = 0;
ipcMain.on('lib-start-meta-local-read', (e, paths) => {
    metaLocalQueue = [];
    activeMetaLocalWorkers = 0;
    const tasks = (Array.isArray(paths) ? paths : []).map(p => {
        if (typeof p === 'string') return ({ filePath: p, forceOverwrite: true });
        return ({ filePath: p.filePath, forceOverwrite: !!p.forceOverwrite });
    }).filter(t => !!t.filePath);
    if (tasks.length === 0) {
        stopMetadataWorker();
        return;
    }
    startMetadataWorker('read', tasks);
});
async function processNextMetaLocal() {
    if (metaLocalQueue.length === 0 || activeMetaLocalWorkers >= MAX_META_LOCAL) return;
    activeMetaLocalWorkers++;
    const task = metaLocalQueue.shift();
    try {
        const tags = await readTagsAsync(task.filePath);
        const parsed = parseTitleAndArtist(tags.artist || '', tags.title || '');
        const title = parsed.title || tags.title || '';
        const artist = parsed.artist || tags.artist || '';
        const featsJson = parsed.feats.length > 0 ? JSON.stringify(parsed.feats) : null;
        const album = tags.album || '';
        const year = tags.year || '';
        const genre = genreFileTagToLibraryLabel(tags.genre);
        const signature = getTrackFileSignature(task.filePath);

        if (task.forceOverwrite) {
            upsertLocalMetaForceStmt.run(task.filePath, title, artist, featsJson, parsed.isRemix ? 1 : 0, album, year, genre, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        } else {
            upsertLocalMetaFillStmt.run(task.filePath, title, artist, featsJson, parsed.isRemix ? 1 : 0, album, year, genre, signature?.fileSize ?? null, signature?.fileMtimeMs ?? null);
        }

        const updatedRow = selectTrackByPathStmt.get(task.filePath);
        syncTrackArtistLinksFromRow(updatedRow);
        const updated = mapTrackRowToClient(updatedRow);
        sendToWindowSafe(libraryWindow, 'meta-local-read-done', { success: true, filePath: task.filePath, data: updated });
    } catch (err) {
        sendToWindowSafe(libraryWindow, 'meta-local-read-done', { success: false, filePath: task.filePath });
    }
    activeMetaLocalWorkers--;
    processNextMetaLocal();
}
ipcMain.on('lib-start-meta-local-write', (e, paths) => {
    metaWriteQueue = [];
    activeMetaWriteWorkers = 0;
    const tasks = Array.isArray(paths) ? paths : [];
    if (tasks.length === 0) {
        stopMetadataWorker();
        return;
    }
    startMetadataWorker('write', tasks);
});
async function processNextMetaWrite() {
    if (metaWriteQueue.length === 0 || activeMetaWriteWorkers >= MAX_META_LOCAL) return;
    activeMetaWriteWorkers++;
    const filePath = metaWriteQueue.shift();
    try {
        if (!canReadFileBytes(filePath)) {
            sendToWindowSafe(libraryWindow, 'meta-local-write-done', { success: false, filePath: filePath });
            activeMetaWriteWorkers--;
            processNextMetaWrite();
            return;
        }
        const trackData = selectTrackMetaForWriteStmt.get(filePath);
        if (trackData) {
            const tags = {};
            if (trackData.custom_title) tags.title = trackData.custom_title;
            let finalArtist = trackData.custom_artist || '';
            if (trackData.feat) {
                try {
                    let featArr = JSON.parse(trackData.feat);
                    if (Array.isArray(featArr) && featArr.length > 0) finalArtist = `${finalArtist} feat. ${featArr.join(', ')}`;
                } catch (err) {
                    finalArtist = `${finalArtist} feat. ${trackData.feat}`;
                }
            }
            if (finalArtist) tags.artist = finalArtist;
            if (trackData.album) tags.album = trackData.album;
            if (trackData.year) tags.year = trackData.year;
            if (trackData.genre) tags.genre = genreLabelToFileTag(trackData.genre);
            if (Object.keys(tags).length > 0) await writeTagsAsync(tags, filePath);
            storeTrackFileSignature(filePath);
        }
        sendToWindowSafe(libraryWindow, 'meta-local-write-done', { success: true, filePath: filePath });
    } catch (err) {
        sendToWindowSafe(libraryWindow, 'meta-local-write-done', { success: false, filePath: filePath });
    }
    activeMetaWriteWorkers--;
    processNextMetaWrite();
}

let metaNetQueue = []; let activeMetaNetWorkers = 0; const MAX_META_NET = 3; ipcMain.on('lib-start-meta-internet', (e, tasks) => {
    metaNetQueue = [];
    activeMetaNetWorkers = 0;
    if (!Array.isArray(tasks) || tasks.length === 0) {
        stopMetaNetWorker();
        return;
    }
    startMetaNetWorker(tasks);
});
async function processNextMetaNet() { if (metaNetQueue.length === 0 || activeMetaNetWorkers >= MAX_META_NET) { if (metaNetQueue.length === 0) activeMetaNetWorkers = 0; return; } activeMetaNetWorkers++; const task = metaNetQueue.shift(); try { const trackData = db.prepare("SELECT custom_title, custom_artist FROM tracks WHERE file_path = ?").get(task.filePath); const baseName = path.basename(task.filePath, path.extname(task.filePath)).replace(/[-_]/g, ' '); const rawTitle = (trackData?.custom_title || '').trim() || ''; const rawArtist = (trackData?.custom_artist || '').trim() || ''; const parsed = parseTitleAndArtist(rawArtist, rawTitle); let query = `${parsed.artist} ${parsed.title}`.trim(); if (!query) query = baseName; let resultData = null; const expectedTokens = tokenSet(`${parsed.artist} ${parsed.title}`.trim() || baseName); const minScore = 0.55; try { await waitRateLimit('musicbrainz', 1100); let mbQuery = query; if (parsed.artist && parsed.title) mbQuery = `artist:"${parsed.artist}" AND recording:"${parsed.title}"`; const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=5`; const mbResponse = await fetch(mbUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0 ( luisfernando@local )' } }); if (mbResponse.ok) { const mbData = await mbResponse.json(); if (mbData.recordings && mbData.recordings.length > 0) { let best = null; let bestScore = -1; for (const rec of mbData.recordings) { const candTitle = rec.title || ''; const candArtist = rec['artist-credit']?.[0]?.name || ''; const candTokens = tokenSet(`${candArtist} ${candTitle}`); const score = jaccard(expectedTokens, candTokens); if (score > bestScore) { bestScore = score; best = rec; } } if (best && bestScore >= minScore) resultData = { title: best.title || '', artist: best['artist-credit']?.[0]?.name || '', album: best.releases?.[0]?.title || '', year: best.releases?.[0]?.date ? best.releases[0].date.substring(0,4) : '' }; } } } catch(e) {} if (!resultData || !resultData.year || !resultData.album) { try { await waitRateLimit('itunes', 200); const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`; const itResponse = await fetch(itUrl); if (itResponse.ok) { const itData = await itResponse.json(); if (itData.results && itData.results.length > 0) { let best = null; let bestScore = -1; for (const rec of itData.results) { const candTitle = rec.trackName || ''; const candArtist = rec.artistName || ''; const candTokens = tokenSet(`${candArtist} ${candTitle}`); const score = jaccard(expectedTokens, candTokens); if (score > bestScore) { bestScore = score; best = rec; } } if (best && bestScore >= minScore) resultData = { title: resultData?.title || best.trackName || '', artist: resultData?.artist || best.artistName || '', album: resultData?.album || best.collectionName || '', year: resultData?.year || (best.releaseDate ? best.releaseDate.substring(0,4) : ''), genre: best.primaryGenreName || '' }; } } } catch(e) {} } if (resultData) { const parsedRes = parseTitleAndArtist(resultData.artist, resultData.title); const featsJson = parsedRes.feats.length > 0 ? JSON.stringify(parsedRes.feats) : null; const force = task.forceOverwrite ? 1 : 0; const finalRemix = (parsedRes.isRemix || parsed.isRemix) ? 1 : 0; db.prepare(`INSERT INTO tracks (file_path, custom_title, custom_artist, feat, is_remix, album, year, genre) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET custom_title = CASE WHEN ?=1 THEN excluded.custom_title ELSE COALESCE(NULLIF(tracks.custom_title, ''), excluded.custom_title) END, custom_artist = CASE WHEN ?=1 THEN excluded.custom_artist ELSE COALESCE(NULLIF(tracks.custom_artist, ''), excluded.custom_artist) END, feat = CASE WHEN ?=1 THEN excluded.feat ELSE COALESCE(NULLIF(tracks.feat, ''), excluded.feat) END, is_remix = CASE WHEN ?=1 THEN excluded.is_remix ELSE COALESCE(NULLIF(tracks.is_remix, ''), excluded.is_remix) END, album = CASE WHEN ?=1 THEN excluded.album ELSE COALESCE(NULLIF(tracks.album, ''), excluded.album) END, year = CASE WHEN ?=1 THEN excluded.year ELSE COALESCE(NULLIF(tracks.year, ''), excluded.year) END, genre = CASE WHEN ?=1 THEN excluded.genre ELSE COALESCE(NULLIF(tracks.genre, ''), excluded.genre) END`).run(task.filePath, parsedRes.title, parsedRes.artist, featsJson, finalRemix, resultData.album, resultData.year, resultData.genre || '', force, force, force, force, force, force, force); } const updated = db.prepare("SELECT custom_title, custom_artist, feat, is_remix, album, year, genre FROM tracks WHERE file_path=?").get(task.filePath); if (libraryWindow) libraryWindow.webContents.send('meta-net-done', { success: !!resultData, filePath: task.filePath, data: updated }); } catch(err) { if (libraryWindow) libraryWindow.webContents.send('meta-net-done', { success: false, filePath: task.filePath }); } activeMetaNetWorkers--; processNextMetaNet(); }

ipcMain.on('editor-start-meta', async (e, data) => {
    if (data.source === 'internet') {
        try {
            const trackData = db.prepare("SELECT custom_title, custom_artist FROM tracks WHERE file_path = ?").get(data.filePath);
            const baseName = path.basename(data.filePath, path.extname(data.filePath)).replace(/[-_]/g, ' ');
            const rawTitle = (trackData?.custom_title || '').trim() || ''; const rawArtist = (trackData?.custom_artist || '').trim() || '';
            const parsed = parseTitleAndArtist(rawArtist, rawTitle);
            let query = `${parsed.artist} ${parsed.title}`.trim(); if (!query) query = baseName;
            let resultsArray = [];
            try {
                await waitRateLimit('musicbrainz', 1100); let mbQuery = query; if (parsed.artist && parsed.title) mbQuery = `artist:"${parsed.artist}" AND recording:"${parsed.title}"`;
                const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=10`;
                const mbResponse = await fetch(mbUrl, { headers: { 'User-Agent': 'LF_Automatizador/0.9.0' } });
                if (mbResponse.ok) {
                    const mbData = await mbResponse.json();
                    if (mbData.recordings) {
                        mbData.recordings.forEach(rec => {
                            const parsedRes = parseTitleAndArtist(rec['artist-credit']?.[0]?.name, rec.title);
                            resultsArray.push({ title: parsedRes.title || '', artist: parsedRes.artist || '', feats: parsedRes.feats || [], isRemix: parsedRes.isRemix, album: rec.releases?.[0]?.title || '', year: rec.releases?.[0]?.date ? rec.releases[0].date.substring(0,4) : '', genre: '' });
                        });
                    }
                }
            } catch(err) {}
            try {
                await waitRateLimit('itunes', 200); const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10`; const itResponse = await fetch(itUrl);
                if (itResponse.ok) {
                    const itData = await itResponse.json();
                    if (itData.results) {
                        itData.results.forEach(rec => {
                            const parsedRes = parseTitleAndArtist(rec.artistName, rec.trackName);
                            resultsArray.push({ title: parsedRes.title || '', artist: parsedRes.artist || '', feats: parsedRes.feats || [], isRemix: parsedRes.isRemix, album: rec.collectionName || '', year: rec.releaseDate ? rec.releaseDate.substring(0,4) : '', genre: rec.primaryGenreName || '' });
                        });
                    }
                }
            } catch(err) {}
            const uniqueResults = []; const seen = new Set();
            resultsArray.forEach(r => {
                const featStr = r.feats.join('-'); const key = `${r.artist}|${r.title}|${r.album}|${r.year}|${featStr}|${r.isRemix}`.toLowerCase();
                if (!seen.has(key)) { seen.add(key); uniqueResults.push(r); }
            });
            uniqueResults.sort((a, b) => { const yearA = parseInt(a.year) || 9999; const yearB = parseInt(b.year) || 9999; return yearA - yearB; });
            e.reply('editor-meta-results', { success: true, data: uniqueResults });
        } catch (err) { e.reply('editor-meta-results', { success: false, error: err.message }); }
    } else {
        try {
            const tags = await readTagsAsync(data.filePath);
            const parsed = parseTitleAndArtist(tags.artist, tags.title);
            const resultData = { custom_title: parsed.title || '', custom_artist: parsed.artist || '', feat: parsed.feats || [], isRemix: parsed.isRemix, album: tags.album || '', year: tags.year || '', genre: genreFileTagToLibraryLabel(tags.genre) };
            e.reply('editor-meta-done', { success: true, filePath: data.filePath, data: resultData });
        } catch(err) { e.reply('editor-meta-done', { success: false, filePath: data.filePath }); }
    }
});

function buildElectronShortcutCombo(input = {}) {
    if (!input.key || ['Control', 'Alt', 'Shift', 'Meta'].includes(input.key)) return null;
    const parts = [];
    if (input.control) parts.push('Ctrl');
    if (input.alt) parts.push('Alt');
    if (input.shift) parts.push('Shift');
    const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
    parts.push(key);
    return parts.join('+');
}

function installNavigationGuards() {
    ipcMain.on('shortcut-editable-focus', (event, editable) => {
        shortcutEditableByWebContents.set(event.sender.id, editable === true);
    });
    ipcMain.on('shortcut-scope-updated', (_event, scope) => {
        keyboardShortcutScope = ['contextual', 'main-window', 'application'].includes(scope) ? scope : 'contextual';
    });
    app.on('web-contents-created', (event, contents) => {
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('dom-ready', () => {
            contents.executeJavaScript(`
                (() => {
                    if (window.__lfShortcutFocusTracking) return;
                    window.__lfShortcutFocusTracking = true;
                    const { ipcRenderer } = require('electron');
                    const report = () => {
                        const el = document.activeElement;
                        ipcRenderer.send('shortcut-editable-focus', !!el && (
                            el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
                        ));
                    };
                    document.addEventListener('focusin', report, true);
                    document.addEventListener('focusout', () => setTimeout(report, 0), true);
                    report();
                })();
            `).catch(() => {});
        });
        contents.on('before-input-event', (inputEvent, input) => {
            if (keyboardShortcutScope !== 'application' || contents === mainWindow?.webContents) return;
            if (input.type !== 'keyDown' || shortcutEditableByWebContents.get(contents.id) === true) return;
            const combo = buildElectronShortcutCombo(input);
            if (!combo) return;
            _ensureMenuShortcuts();
            const actionId = Object.keys(_menuShortcuts || {}).find(id => _menuShortcuts[id] === combo);
            if (!actionId || !mainWindow || mainWindow.isDestroyed()) return;
            inputEvent.preventDefault();
            mainWindow.webContents.send('dispatch-configured-shortcut', actionId);
        });
        contents.on('will-navigate', (navEvent, targetUrl) => {
            try {
                const parsed = new URL(targetUrl);
                if (parsed.protocol !== 'file:') navEvent.preventDefault();
            } catch (err) {
                navEvent.preventDefault();
            }
        });
        contents.on('destroyed', () => shortcutEditableByWebContents.delete(contents.id));
    });
}

// ── Aceleradores dinámicos del menú nativo ───────────────────────────────────
let _menuShortcuts = null;
function _ensureMenuShortcuts() {
    if (_menuShortcuts) return;
    try {
        const _mdb = require('./database');
        const row = _mdb.prepare("SELECT value FROM app_settings WHERE key = 'keyboard_shortcuts'").get();
        const saved = row ? JSON.parse(row.value || '{}') : {};
        const { DEFAULT_SHORTCUTS } = require('./frontend/command_registry');
        _menuShortcuts = { ...DEFAULT_SHORTCUTS, ...saved };
        Object.keys(_menuShortcuts).forEach(k => { if (!_menuShortcuts[k]) delete _menuShortcuts[k]; });
    } catch (_e) {
        try { _menuShortcuts = { ...require('./frontend/command_registry').DEFAULT_SHORTCUTS }; } catch (_) { _menuShortcuts = {}; }
    }
}
function sc(actionId) {
    _ensureMenuShortcuts();
    const raw = _menuShortcuts[actionId];
    if (!raw) return null;
    return raw.replace(/^Ctrl\+/i, 'CmdOrCtrl+');
}
function menuShortcut(actionId) {
    return { accelerator: sc(actionId), registerAccelerator: false };
}

function createWindow() {
    mainWindow = new BrowserWindow({
        icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),
        width: 1280, height: 720,
        title: `LF Automatizador v${APP_VERSION}`,
        autoHideMenuBar: false,
        backgroundColor: '#1a1a1a', // evita el flash blanco mientras carga el renderer
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    });
    mainWindow.setMenuBarVisibility(uiPrefs.menuVisible);
    mainWindow.maximize();

    // ── Carga auto-reparable del renderer ────────────────────────────────────
    // Al arrancar JUNTO CON EL SISTEMA (inicio de sesión, recuperación tras un
    // corte de luz) el renderer puede no llegar a pintar: el SO todavía está
    // ocupado (GPU/compositor/disco/antivirus) y la carga falla o nunca termina.
    // Sin reintento, la ventana queda en blanco mostrando sólo el menú nativo.
    // Aquí: ruta ABSOLUTA (independiente del directorio de trabajo, que al
    // autoarrancar suele ser C:\Windows\System32), reintento ante fallo de carga,
    // recuperación si el proceso de render se cae, y un watchdog por si la carga
    // se cuelga sin emitir error.
    const INDEX_FILE = require('path').join(__dirname, 'frontend', 'index.html');
    let rendererLoaded = false;
    let reloadAttempts = 0;
    const MAX_RELOAD_ATTEMPTS = 8;

    const loadIndex = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        Promise.resolve(mainWindow.loadFile(INDEX_FILE)).catch(() => {});
    };
    const scheduleReload = (reason) => {
        if (rendererLoaded || !mainWindow || mainWindow.isDestroyed()) return;
        if (reloadAttempts >= MAX_RELOAD_ATTEMPTS) {
            try { writeLog(`[ARRANQUE] El renderer no cargó tras ${reloadAttempts} reintentos (${reason}). Ventana en blanco.`); } catch (_) {}
            return;
        }
        reloadAttempts++;
        const delay = Math.min(4000, 500 * reloadAttempts);
        try { writeLog(`[ARRANQUE] Reintentando cargar la interfaz (intento ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}, motivo: ${reason}).`); } catch (_) {}
        setTimeout(() => { if (!rendererLoaded) loadIndex(); }, delay);
    };

    mainWindow.webContents.on('did-finish-load', () => { rendererLoaded = true; });
    mainWindow.webContents.on('did-fail-load', (e, errorCode, errorDesc, validatedURL, isMainFrame) => {
        // -3 (ERR_ABORTED) ocurre en navegaciones/recargas normales: no es un fallo real.
        if (isMainFrame === false || errorCode === -3) return;
        scheduleReload(`did-fail-load ${errorCode} ${errorDesc || ''}`.trim());
    });
    mainWindow.webContents.on('render-process-gone', (e, details) => {
        const reason = details && details.reason;
        if (reason === 'clean-exit') return; // cierre normal: no recuperar
        rendererLoaded = false;
        scheduleReload(`render-process-gone:${reason}`);
    });

    loadIndex();
    // Watchdog: si a los 20 s la interfaz nunca terminó de cargar, forzar recarga.
    setTimeout(() => { if (!rendererLoaded) scheduleReload('watchdog-sin-carga-20s'); }, 20000);

    mainWindow.on('close', (e) => { if (!forceQuit) { e.preventDefault(); mainWindow.webContents.send('request-close-check'); } });
    mainWindow.on('closed', () => { isAppQuitting = true; app.quit(); });
}
function syncCartwallMenuState(checked) { const appMenu = Menu.getApplicationMenu(); const item = appMenu ? appMenu.getMenuItemById('view-toggle-cartwall') : null; if (item) item.checked = checked; }
function syncAuxiliaryMenuState(checked) { const appMenu = Menu.getApplicationMenu(); const item = appMenu ? appMenu.getMenuItemById('view-toggle-auxiliary') : null; if (item) item.checked = checked; }
function createApplicationMenu() {
    const appMenuLanguage = loadJsonConfig(generalSettingsPath, {}).language || 'es';
    i18n.init(appMenuLanguage);
    const template = [
        {
            label: i18n.t('menu.file'),
            submenu: [
                { label: '📂 ' + i18n.t('menu.open_playlist'), ...menuShortcut('insert.open_playlist'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-action', 'open'); } },
                { label: '💾 ' + i18n.t('menu.save_playlist'), ...menuShortcut('insert.save_playlist'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-action', 'save'); } },
                { type: 'separator' },
                { label: '📄 ' + i18n.t('menu.clear_playlist'), ...menuShortcut('insert.clear_playlist'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-action', 'clear'); } },
                { type: 'separator' },
                { label: i18n.t('menu.exit'), click: () => { if (mainWindow) { mainWindow.webContents.send('request-close-check'); } else { app.quit(); } } }
            ]
        },
        {
            label: i18n.t('menu.view'),
            submenu: [
                { label: i18n.t('menu.full_screen'), role: 'togglefullscreen', accelerator: 'F11' },
                { type: 'separator' },
                {
                    label: i18n.t('menu.controls_pos'),
                    submenu: [
                        { label: i18n.t('menu.top_pos'), type: 'radio', checked: uiPrefs.controlsPos === 'top', click: () => { uiPrefs.controlsPos = 'top'; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('set-controls-position', 'top'); } },
                        { label: i18n.t('menu.bottom_pos'), type: 'radio', checked: uiPrefs.controlsPos === 'bottom', click: () => { uiPrefs.controlsPos = 'bottom'; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('set-controls-position', 'bottom'); } }
                    ]
                },
                { type: 'separator' },
                { label: i18n.t('menu.temperature'), type: 'checkbox', checked: uiPrefs.temp, click: (item) => { uiPrefs.temp = item.checked; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('toggle-temperature', item.checked); } },
                { label: i18n.t('menu.humidity'), type: 'checkbox', checked: uiPrefs.hum, click: (item) => { uiPrefs.hum = item.checked; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('toggle-humidity', item.checked); } },
                { label: i18n.t('menu.toggle_left_panel'), type: 'checkbox', checked: uiPrefs.leftPanel, click: (item) => { uiPrefs.leftPanel = item.checked; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('toggle-left-panel', item.checked); } },
                { label: i18n.t('menu.toggle_extensions'), type: 'checkbox', checked: uiPrefs.ext, click: (item) => { uiPrefs.ext = item.checked; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('toggle-extensions', item.checked); } },
                { id: 'view-toggle-cartwall', label: i18n.t('menu.toggle_cartwall'), type: 'checkbox', checked: !!cartwallWindow || uiPrefs.cartwall, click: (item) => { if (mainWindow) mainWindow.webContents.send('menu-toggle-cartwall', item.checked); } },
                { id: 'view-toggle-auxiliary', label: 'Playlists auxiliares', type: 'checkbox', checked: !!auxiliaryWindow || uiPrefs.auxiliaryPanel, click: (item) => { if (mainWindow) mainWindow.webContents.send('menu-toggle-auxiliary', item.checked); } },
                { type: 'separator' },
                {
                    label: i18n.t('menu.panel_order'),
                    submenu: [
                        { label: i18n.t('menu.order_cartwall_aux'), type: 'radio', checked: uiPrefs.rightPanelOrder === 'cartwall-first', click: () => { uiPrefs.rightPanelOrder = 'cartwall-first'; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('set-right-panel-order', 'cartwall-first'); } },
                        { label: i18n.t('menu.order_aux_cartwall'), type: 'radio', checked: uiPrefs.rightPanelOrder === 'aux-first', click: () => { uiPrefs.rightPanelOrder = 'aux-first'; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('set-right-panel-order', 'aux-first'); } }
                    ]
                },
                { type: 'separator' },
                { label: i18n.t('menu.toggle_syslog'), type: 'checkbox', checked: uiPrefs.sysLog, click: (item) => { uiPrefs.sysLog = item.checked; saveUiPrefs(); if (mainWindow) mainWindow.webContents.send('toggle-sys-log', item.checked); } },
                { type: 'separator' },
                { label: '📊 ' + i18n.t('menu.task_manager'), accelerator: 'Alt+T', click: () => openTaskManagerWindow() },
                { label: '💻 ' + i18n.t('menu.open_console'), accelerator: 'Alt+C', click: () => { ipcMain.emit('open-console'); } }
            ]
        },
        {
            label: i18n.t('menu.list'),
            submenu: [
                { label: '🎵 ' + i18n.t('menu.add_tracks'), click: async () => { const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{name: 'Audio', extensions: ['mp3','wav','ogg','flac','m4a','aiff','aif','mp2']}] }); if(!res.canceled) mainWindow.webContents.send('menu-add-files', res.filePaths); } },
                { label: '📁 ' + i18n.t('menu.add_folder'), click: async () => { const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if(!res.canceled) mainWindow.webContents.send('menu-add-folder', res.filePaths[0]); } },
                { label: '🔀 ' + i18n.t('menu.add_random_folder'), click: async () => { const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if(!res.canceled) mainWindow.webContents.send('menu-add-random', res.filePaths[0]); } },
                { label: '📅 ' + i18n.t('menu.run_event'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-add-event-command'); } },
                { label: '⌚ ' + i18n.t('menu.add_time_locution'), ...menuShortcut('insert.time_locution'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-insert-time'); } },
                { label: '🌡️ ' + i18n.t('menu.add_temp_locution'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-insert-temperature'); } },
                { label: '💧 ' + i18n.t('menu.add_hum_locution'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-insert-humidity'); } },
                { type: 'separator' },
                { label: '⏹ ' + i18n.t('menu.add_stop'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-add-stop'); } },
                {
                    label: '⏭️ ' + i18n.t('menu.play_next_playlist'),
                    submenu: [
                        ...playlistMenuList.map(pl => ({
                            label: pl.name,
                            enabled: activePlaylistTab !== pl.index,
                            click: () => { if (mainWindow) mainWindow.webContents.send('menu-play-next-playlist', pl.index); }
                        })),
                        { type: 'separator' },
                        { label: 'Auxiliar 1', click: () => { if (mainWindow) mainWindow.webContents.send('menu-play-next-auxiliary', 0); } },
                        { label: 'Auxiliar 2', click: () => { if (mainWindow) mainWindow.webContents.send('menu-play-next-auxiliary', 1); } }
                    ]
                },
                { label: '📝 ' + i18n.t('menu.add_note'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-add-note'); } },
                { label: '📡 ' + i18n.t('menu.add_stream_url'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-add-stream-url'); } },
                { type: 'separator' },
                { label: '🎯 ' + i18n.t('menu.set_next'), ...menuShortcut('playlist.set_next'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-set-next'); } },
                { label: '⏳ ' + i18n.t('menu.toggle_temp'), ...menuShortcut('playlist.toggle_temp'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-toggle-temp'); } },
                { label: '🔀 ' + i18n.t('menu.shuffle_list'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-shuffle'); } },
                { type: 'separator' },
                { label: '🧹 ' + i18n.t('menu.clear_played'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-clear-played'); } },
                { label: '🔗 ' + i18n.t('menu.check_broken_links'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-check-links'); } },
                { type: 'separator' },
                { label: '❌ ' + i18n.t('menu.delete_selected'), ...menuShortcut('playlist.delete_selected'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-delete-selected'); } },
                { label: '🗑️ ' + i18n.t('menu.empty_list'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-action', 'clear'); } }
            ]
        },
        {
            label: i18n.t('menu.emission'),
            submenu: [
                { label: '📡 ' + i18n.t('menu.open_encoder'), click: () => { ipcMain.emit('open-encoder'); } },
                { type: 'separator' },
                { label: '▶️ ' + i18n.t('menu.toggle_auto_events'), click: () => { if(mainWindow) mainWindow.webContents.send('menu-toggle-events'); } },
                { label: '🔁 ' + i18n.t('menu.toggle_infinite_loop'), click: () => { if(mainWindow) mainWindow.webContents.send('menu-toggle-loop'); } }
            ]
        },
        {
            label: i18n.t('menu.tools'),
            submenu: [
                { label: '⚙️ ' + i18n.t('menu.general_settings'), ...menuShortcut('app.open_settings'), click: () => { ipcMain.emit('open-settings'); } },
                { label: '📚 ' + i18n.t('menu.music_library'), ...menuShortcut('app.open_library'), click: () => { ipcMain.emit('open-library'); } },
                { label: '🧩 ' + i18n.t('menu.playlist_generator'), click: () => { if (mainWindow) mainWindow.webContents.send('menu-open-rotation'); } },
                { type: 'separator' },
                { label: '📅 ' + i18n.t('menu.event_manager'), click: () => { ipcMain.emit('open-event-editor', null); } },
                { label: '🏷️ ' + i18n.t('menu.event_group_manager'), click: () => { ipcMain.emit('open-event-groups'); } },
                { type: 'separator' },
                { label: '📇 ' + i18n.t('menu.artist_catalog'), ...menuShortcut('app.open_catalog'), click: () => openArtistCatalogWindow() },
                { label: '🎨 ' + i18n.t('menu.genre_editor'), ...menuShortcut('app.open_genre_editor'), click: () => openGenreEditorWindow() },
                { label: '💼 ' + i18n.t('menu.commercial_manager'), ...menuShortcut('app.open_commercial_mgr'), click: () => openCommercialManagerWindow() },
                { type: 'separator' },
                { label: '🎚️ ' + i18n.t('menu.music_separation_rules'), click: () => openMusicSeparationWindow() },
                { label: '🗂️ ' + i18n.t('menu.file_types_manager'), click: () => openFileTypesManagerWindow() },
                { type: 'separator' },
                {
                    label: '🚀 ' + i18n.t('menu.init_curation'),
                    click: async () => {
                        const result = await dialog.showMessageBox(mainWindow || libraryWindow, {
                            type: 'question',
                            buttons: [i18n.t('menu.init_now'), i18n.t('menu.cancel')],
                            defaultId: 0,
                            cancelId: 1,
                            title: i18n.t('menu.init_curation_title'),
                            message: i18n.t('menu.init_curation_msg'),
                            noLink: true
                        });
                        if (result.response !== 0) return;
                        const initResult = await initializeCurationFromConfiguredRoot();
                        dialog.showMessageBox(mainWindow || libraryWindow, {
                            type: initResult.success ? 'info' : 'warning',
                            title: i18n.t('menu.init_curation_result_title'),
                            message: initResult.success
                                ? `Listo. Archivos: ${initResult.files}. Pistas actualizadas: ${initResult.tracks}. Artistas/enlaces: ${initResult.artistLinks}. Géneros aplicados: ${initResult.genreTracks}.`
                                : (initResult.error || 'No se pudo inicializar la curaduría.'),
                            noLink: true
                        });
                    }
                }
            ]
        },
        {
            label: i18n.t('menu.help'),
            submenu: [
                { label: '📖 ' + i18n.t('menu.user_manual'), enabled: false },
                { type: 'separator' },
                { label: '🎯 ' + i18n.t('menu.first_use_guide'), click: () => { require('electron').shell.openPath(require('path').join(__dirname, 'Documentación', 'guia_primer_uso.jpg')).catch(()=>{}); } },
                { type: 'separator' },
                { label: '⌨️ ' + i18n.t('menu.keyboard_shortcuts'), click: () => { ipcMain.emit('open-settings', null, 'tab-shortcuts'); }},
                { label: 'ℹ️ ' + i18n.t('menu.about'), click: () => {
                    if (aboutWindow) { aboutWindow.focus(); return; }
                    aboutWindow = new BrowserWindow({
                        icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, 'icon.ico')),
                        width: 460,
                        height: 580,
                        minWidth: 460,
                        minHeight: 580,
                        maxWidth: 460,
                        maxHeight: 580,
                        title: i18n.t('menu.about_title'),
                        autoHideMenuBar: true,
                        resizable: false,
                        maximizable: false,
                        webPreferences: { nodeIntegration: true, contextIsolation: false }
                    });
                    aboutWindow.loadFile('frontend/about.html', { query: { version: APP_VERSION, lang: appMenuLanguage } });
                    aboutWindow.on('closed', () => { aboutWindow = null; });
                }}
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
app.whenReady().then(() => {
    installAudioPowerGuards();
    installNavigationGuards();
    createApplicationMenu();
    // Pre-spawn del motor Rust ANTES de abrir la ventana.
    // En Windows, child_process.spawn() puede bloquear el event loop del
    // proceso principal ~3-5 s mientras el antivirus escanea el binario.
    // Hacerlo aquí (sin ventana abierta aún) significa que el bloqueo ocurre
    // antes de que el renderer exista y pueda enviar IPC. Cuando createWindow()
    // se llame, el binario ya estará corriendo: start() retorna al instante y
    // db-get-events / db-get-groups responden sin espera.
    try { rustAudioEngine.start(); } catch (_) {}
    createWindow();

    // Intentar agregar exclusión de Windows Defender para el motor Rust.
    // Si el binario está excluido, cp.spawn() pasa de ~4s a <100ms en arranques futuros.
    // Silencioso: si falla (sin privilegios), simplemente no hace nada.
    if (process.platform === 'win32' && rustAudioEngine.exePath) {
        const binDir = path.dirname(rustAudioEngine.exePath);
        const ps = require('child_process').spawn(
            'powershell.exe',
            ['-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
             `Try { Add-MpPreference -ExclusionPath '${binDir}' -ErrorAction Stop } Catch {}`],
            { windowsHide: true, detached: true }
        );
        ps.unref();
    }
});
app.on('before-quit', () => {
    runAppShutdownCleanup('before-quit');
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
    runAppShutdownCleanup('will-quit');
});
app.on('quit', () => {
    runAppShutdownCleanup('quit');
});
process.once('exit', () => {
    runAppShutdownCleanup('process-exit');
});
ipcMain.on('active-tab-changed', (e, tabIndex) => { activePlaylistTab = tabIndex; createApplicationMenu(); });
ipcMain.on('playlist-names-changed', (e, list) => {
    if (Array.isArray(list) && list.length) {
        playlistMenuList = list
            .filter(pl => pl && typeof pl.index === 'number')
            .map(pl => ({ index: pl.index, name: (pl.name || `Playlist ${pl.index + 1}`).toString().slice(0, 40) }));
    }
    createApplicationMenu();
});

function updateAuxiliaryUiState(partial = {}) {
    const mode = ['hidden', 'docked', 'floating'].includes(partial.mode) ? partial.mode : null;
    if (mode) {
        uiPrefs.auxiliaryPanel = mode === 'docked';
        if (['docked', 'floating'].includes(mode)) uiPrefs.auxiliaryPanelLastMode = mode;
        saveUiPrefs();
        syncAuxiliaryMenuState(mode !== 'hidden');
    }
    const payload = { mode: mode || (uiPrefs.auxiliaryPanel ? 'docked' : 'hidden') };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auxiliary-ui-state', payload);
    if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) auxiliaryWindow.webContents.send('auxiliary-ui-state', { mode: 'floating' });
}

ipcMain.on('open-auxiliary-window', () => {
    if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
        if (auxiliaryWindow.isMinimized()) auxiliaryWindow.restore();
        auxiliaryWindow.focus();
        updateAuxiliaryUiState({ mode: 'floating' });
        return;
    }
    auxiliaryDockRequested = false;
    updateAuxiliaryUiState({ mode: 'floating' });
    auxiliaryWindow = new BrowserWindow({
        icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icons', 'main.png')),
        width: 720,
        height: 640,
        title: 'Playlists auxiliares',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
    });
    auxiliaryWindow.loadFile(path.join(__dirname, 'frontend', 'auxiliary_playlists.html'));
    auxiliaryWindow.on('closed', () => {
        const shouldDock = auxiliaryDockRequested;
        auxiliaryDockRequested = false;
        auxiliaryWindow = null;
        updateAuxiliaryUiState({ mode: shouldDock ? 'docked' : 'hidden' });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(shouldDock ? 'auxiliary-docked' : 'auxiliary-floating-closed');
    });
});

ipcMain.on('auxiliary-dock', () => {
    if (!auxiliaryWindow || auxiliaryWindow.isDestroyed()) return;
    auxiliaryDockRequested = true;
    auxiliaryWindow.close();
});

ipcMain.on('auxiliary-hide', () => {
    if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
        auxiliaryDockRequested = false;
        auxiliaryWindow.close();
        return;
    }
    updateAuxiliaryUiState({ mode: 'hidden' });
});

ipcMain.on('auxiliary-main-resume', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auxiliary-main-resume');
});

ipcMain.on('auxiliary-main-jump', (_event, targetIndex) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auxiliary-main-jump', targetIndex);
});
ipcMain.on('auxiliary-play-from-main', (_event, targetIndex) => {
    if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
        auxiliaryWindow.webContents.send('auxiliary-play-from-main', targetIndex);
        return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auxiliary-play-from-main', targetIndex);
});
ipcMain.on('auxiliary-execute-event', (_event, payload = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auxiliary-execute-event', payload);
});
ipcMain.on('toggle-menu-bar', () => { uiPrefs.menuVisible = !uiPrefs.menuVisible; saveUiPrefs(); if (mainWindow) mainWindow.setMenuBarVisibility(uiPrefs.menuVisible); }); ipcMain.on('confirm-app-quit', () => { confirmAppQuit('confirm-app-quit'); }); ipcMain.handle('dialog:askClose', async () => { const res = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: [i18n.t('dialogs.buttons.save'), i18n.t('dialogs.buttons.dont_save'), i18n.t('dialogs.buttons.cancel')], defaultId: 0, cancelId: 2, title: i18n.t('dialogs.ask_close.title'), message: i18n.t('dialogs.ask_close.message'), noLink: true }); return res.response; }); ipcMain.handle('dialog:askClear', async () => { const res = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: [i18n.t('dialogs.buttons.save'), i18n.t('dialogs.buttons.dont_save'), i18n.t('dialogs.buttons.cancel')], defaultId: 0, cancelId: 2, title: i18n.t('dialogs.ask_clear.title'), message: i18n.t('dialogs.ask_clear.message'), noLink: true }); return res.response; }); ipcMain.handle('dialog:confirm', async (e, msg) => { const ownerWindow = BrowserWindow.fromWebContents(e.sender) || mainWindow; const res = await dialog.showMessageBox(ownerWindow, { type: 'question', buttons: [i18n.t('dialogs.buttons.yes'), i18n.t('dialogs.buttons.no')], defaultId: 1, cancelId: 1, title: i18n.t('dialogs.confirm.title'), message: msg, noLink: true }); if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.focus(); return res.response === 0; });
ipcMain.on('preview-ui-layout', (e, data) => { if (mainWindow) mainWindow.webContents.send('preview-ui-layout', data); });
ipcMain.on('revert-ui-layout', () => { if (mainWindow) mainWindow.webContents.send('revert-ui-layout'); });
ipcMain.handle('dialog:pickFolder', async (e, opts = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const res = await dialog.showOpenDialog(ownerWindow, {
        title: opts?.title || 'Seleccionar carpeta',
        defaultPath: opts?.defaultPath || undefined,
        properties: ['openDirectory']
    });
    if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.focus();
    if (res.canceled || !res.filePaths || !res.filePaths.length) return '';
    return res.filePaths[0];
});
ipcMain.handle('dialog:pickAudioFiles', async (e, opts = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const res = await dialog.showOpenDialog(ownerWindow, {
        title: opts?.title || 'Seleccionar archivo de audio',
        defaultPath: opts?.defaultPath || undefined,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'mp2'] }]
    });
    if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.focus();
    if (res.canceled || !res.filePaths) return [];
    return res.filePaths;
});
// Sincronizacion del Gestor de Tipos de Archivo <-> ventana principal.
ipcMain.on('file-types-data-changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('file-types-data-updated');
    if (playlistGeneratorWindow && !playlistGeneratorWindow.isDestroyed()) playlistGeneratorWindow.webContents.send('file-types-data-updated');
});
ipcMain.on('file-types-assignments-changed', () => {
    if (fileTypesManagerWindow && !fileTypesManagerWindow.isDestroyed()) fileTypesManagerWindow.webContents.send('file-types-data-updated');
});
ipcMain.handle('shell:openExternal', async (e, url) => {
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try { await shell.openExternal(url); return true; } catch (err) { return false; }
});

// Auto-instalacion de Microsoft Visual C++ Runtime desde el wizard.
// Busca primero el vc_redist.x64.exe bundleado en resources (lo agrega
// electron-builder via extraResources). Si no esta, lo descarga desde
// Microsoft. Luego lo ejecuta con /install /quiet /norestart — Windows
// dispara UAC automaticamente porque el .exe esta firmado.
ipcMain.handle('wizard:installVcRedist', async () => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows.' };
    }
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'vcredist', 'vc_redist.x64.exe') : '',
        path.join(__dirname, 'build', 'vcredist', 'vc_redist.x64.exe')
    ].filter(Boolean);

    const bundledPath = candidates.find(p => {
        try { return fs.existsSync(p); } catch (e) { return false; }
    });
    let stagingDir;
    let exePath;
    const cleanupStaging = () => {
        if (!stagingDir) return;
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (err) {}
    };
    try {
        stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-vcredist-'));
        exePath = path.join(stagingDir, 'vc_redist.x64.exe');
        if (bundledPath) fs.copyFileSync(bundledPath, exePath);
    } catch (err) {
        cleanupStaging();
        return { ok: false, error: 'No se pudo preparar vc_redist.x64.exe: ' + (err?.message || String(err)) };
    }

    if (!bundledPath) {
        // Descargar a temp como fallback (Microsoft URL redirige)
        try {
            await downloadHttpsWithRedirects('https://aka.ms/vs/17/release/vc_redist.x64.exe', exePath);
        } catch (err) {
            cleanupStaging();
            return { ok: false, error: 'No se pudo descargar vc_redist.x64.exe: ' + (err?.message || String(err)) };
        }
    }

    const signature = verifyMicrosoftAuthenticode(exePath);
    if (!signature.ok) {
        cleanupStaging();
        return { ok: false, error: 'Se rechazo vc_redist.x64.exe porque su firma digital no es valida: ' + signature.error };
    }

    return new Promise((resolve) => {
        try {
            // vc_redist instala DLLs de sistema y SIEMPRE requiere elevación.
            // Lanzarlo con spawn() directo + /quiet nunca muestra el aviso de
            // UAC: en una sesión sin administrador falla en silencio y el único
            // remedio del usuario era ejecutar TODA la app como administrador.
            // Start-Process -Verb RunAs eleva únicamente al instalador del
            // redistributable (UAC puntual), que es lo que la UI promete.
            const psCommand = `try { $p = Start-Process -FilePath '${exePath}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
            const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCommand], {
                detached: false,
                stdio: 'ignore',
                windowsHide: true
            });
            child.on('exit', (code) => {
                cleanupStaging();
                // 0 = ok, 1638 = ya hay version mas reciente, 3010 = ok pero requiere reinicio
                // 1223 = el usuario rechazo el aviso de UAC (ERROR_CANCELLED)
                const success = code === 0 || code === 1638 || code === 3010;
                resolve({
                    ok: success,
                    exitCode: code,
                    rebootRequired: code === 3010,
                    error: success
                        ? null
                        : (code === 1223
                            ? 'El usuario cancelo el aviso de permisos de administrador (UAC).'
                            : `vc_redist.x64.exe devolvio codigo ${code}`)
                });
            });
            child.on('error', (err) => {
                cleanupStaging();
                resolve({ ok: false, error: err?.message || String(err) });
            });
        } catch (err) {
            cleanupStaging();
            resolve({ ok: false, error: err?.message || String(err) });
        }
    });
});

function downloadHttpsWithRedirects(url, destPath, maxRedirects = 5) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const attempt = (u, remaining) => {
            if (remaining < 0) return reject(new Error('Demasiados redirects.'));
            const req = https.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return attempt(res.headers.location, remaining - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => file.close(err => err ? reject(err) : resolve(destPath)));
                file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (e) {} reject(err); });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(new Error('Timeout descarga (60s).')); });
        };
        attempt(url, maxRedirects);
    });
}


// Comerciales refactorizados a backend/ipc/commercials.js
// Eventos refactorizados a backend/ipc/events.js
// UI refactorizado a backend/ipc/ui.js

// ============================================================================
// FASE 3: MANEJO DEL CARTWALL (PERFILES E IPC)
// ============================================================================
const sharedState = {
    get ipcMain() { return ipcMain; },
    get safeStorage() { return safeStorage; },
    get fs() { return fs; },
    get dialog() { return dialog; },
    get path() { return path; },
    get cwConfigPath() { return cwConfigPath; },
    get mainWindow() { return mainWindow; },
    get cartwallWindow() { return cartwallWindow; },
    set cartwallWindow(win) { cartwallWindow = win; },
    get commercialManagerWindow() { return commercialManagerWindow; },
    get settingsWindow() { return settingsWindow; },
    get uiPrefs() { return uiPrefs; },
    saveUiPrefs, syncCartwallMenuState,
    rebuildNativeMenu: (shortcuts) => {
        try {
            const { DEFAULT_SHORTCUTS } = require('./frontend/command_registry');
            const merged = { ...DEFAULT_SHORTCUTS, ...(shortcuts || {}) };
            Object.keys(merged).forEach(k => { if (!merged[k]) delete merged[k]; });
            _menuShortcuts = merged;
            createApplicationMenu();
        } catch (_) {}
    },
    get cartwallDockRequested() { return cartwallDockRequested; },
    set cartwallDockRequested(val) { cartwallDockRequested = val; },
    get BrowserWindow() { return BrowserWindow; },
    get db() { return db; },
    get eventEditorWindow() { return eventEditorWindow; },
    get writeLog() { return writeLog; },
    get scanCommercialPathsInWorker() { return scanCommercialPathsInWorker; },
    get readTagsAsync() { return readTagsAsync; },
    get genreFileTagToLibraryLabel() { return genreFileTagToLibraryLabel; },
    get libraryWindow() { return libraryWindow; },
    get fileTypesManagerWindow() { return fileTypesManagerWindow; },
    get reportsWindow() { return reportsWindow; },
    set reportsWindow(win) { reportsWindow = win; },
    get consoleWindow() { return consoleWindow; },
    set consoleWindow(win) { consoleWindow = win; },
    get lastVuLevels() { return lastVuLevels; },
    set lastVuLevels(val) { lastVuLevels = val; },
    get buildVuPayload() { return buildVuPayload; },
    get scheduleVuBroadcast() { return scheduleVuBroadcast; },
    get broadcastVuLevels() { return broadcastVuLevels; },
    get auxCueSources() { return auxCueSources; },
    get resolveLevel() { return resolveLevel; },
    get resolveDb() { return resolveDb; },
    get resolveStereoPair() { return resolveStereoPair; },
    get resolveStereoDbPair() { return resolveStereoDbPair; },
    set libraryWindow(v) { libraryWindow = v; },
    set settingsWindow(v) { settingsWindow = v; },
    set eventEditorWindow(v) { eventEditorWindow = v; },
    get audioEditorWindow() { return audioEditorWindow; },
    set audioEditorWindow(v) { audioEditorWindow = v; },
    get transitionEditorWindow() { return transitionEditorWindow; },
    set transitionEditorWindow(v) { transitionEditorWindow = v; },
    get jingleEditorWindow() { return jingleEditorWindow; },
    set jingleEditorWindow(v) { jingleEditorWindow = v; },
    get previewWindow() { return previewWindow; },
    set previewWindow(v) { previewWindow = v; },
    get eventGroupsWindow() { return eventGroupsWindow; },
    set eventGroupsWindow(v) { eventGroupsWindow = v; },
    get encoderWindow() { return encoderWindow; },
    set encoderWindow(v) { encoderWindow = v; },
    get ffmpegProcess() { return ffmpegProcess; },
    set ffmpegProcess(v) { ffmpegProcess = v; },
    get activeEncoderConfig() { return activeEncoderConfig; },
    set activeEncoderConfig(v) { activeEncoderConfig = v; },
    get eventEditorContextKey() { return eventEditorContextKey; },
    set eventEditorContextKey(v) { eventEditorContextKey = v; },
    get lastEditorSource() { return lastEditorSource; },
    set lastEditorSource(v) { lastEditorSource = v; },
    get isAppQuitting() { return isAppQuitting; },
    get configDir() { return configDir; },
    get ffmpegPath() { return ffmpegPath; },
    get ffmpegFdkPath() { return ffmpegFdkPath; },
    get ffmpegCapabilities() { return ffmpegCapabilities; },
    get rustAudioEngine() { return rustAudioEngine; },
    get screen() { return screen; },
    get shell() { return shell; },
    get openCommercialManagerWindow() { return openCommercialManagerWindow; },
    get app() { return app; },
    get cp() { return cp; },
    get readLibraryDirInWorker() { return readLibraryDirInWorker; },
    get mapTrackRowToClient() { return mapTrackRowToClient; },
    get buildWaveformPeaksInWorker() { return buildWaveformPeaksInWorker; },
    get selectTrackByPathStmt() { return selectTrackByPathStmt; },
    get saveDbTrackStmt() { return saveDbTrackStmt; },
    get parseFeatList() { return parseFeatList; },
    get normalizeTrackArtistFields() { return normalizeTrackArtistFields; },
    get isProtectedArtistGroup() { return isProtectedArtistGroup; },
    get getTrackFileSignature() { return getTrackFileSignature; },
    get syncTrackArtistLinks() { return syncTrackArtistLinks; },
    get applyGenreToTrackPaths() { return applyGenreToTrackPaths; },
    get buildRootGenrePreview() { return buildRootGenrePreview; },
    get upsertVirtualFolder() { return upsertVirtualFolder; },
    get collectAudioFilesRecursive() { return collectAudioFilesRecursive; },
    get writeGenreTagsToFiles() { return writeGenreTagsToFiles; },
    get inferGenreFromFolderName() { return inferGenreFromFolderName; },
    get AUDIO_FILE_RE() { return AUDIO_FILE_RE; },
    get getCountryProfiles() { return getCountryProfiles; },
    get runLibraryWorkerTask() { return runLibraryWorkerTask; },
    get getArtistCatalogData() { return getArtistCatalogData; },
    get deleteArtistProfiles() { return deleteArtistProfiles; },
    get mergeArtistProfiles() { return mergeArtistProfiles; },
    get setArtistMainGenreFromCatalog() { return setArtistMainGenreFromCatalog; },
    get autofillArtistProfilesFromCatalog() { return autofillArtistProfilesFromCatalog; },
    get getArtistCardDetailsForTrackPath() { return getArtistCardDetailsForTrackPath; },
    get normalizeArtistKey() { return normalizeArtistKey; },
    get getArtistCardByKey() { return getArtistCardByKey; },
    get ensureArtistProfileForLink() { return ensureArtistProfileForLink; },
    get getArtistTracksByKey() { return getArtistTracksByKey; },
    get fetchArtistMetadataOnline() { return fetchArtistMetadataOnline; },
    get downloadArtistImage() { return downloadArtistImage; },
    get saveArtistCard() { return saveArtistCard; },
    get cleanCsvList() { return cleanCsvList; },
    get mergeCsvList() { return mergeCsvList; },
    get toDisplayArtist() { return toDisplayArtist; },
    get openArtistCatalogWindow() { return openArtistCatalogWindow; },
    get openGenreEditorWindow() { return openGenreEditorWindow; },
    get getGenreEditorCatalog() { return getGenreEditorCatalog; },
    get getGenreEditorTracks() { return getGenreEditorTracks; },
    get browseGenreEditorPath() { return browseGenreEditorPath; },
    get suggestGenreForInputPaths() { return suggestGenreForInputPaths; },
    get syncGenreLinksForExistingTracks() { return syncGenreLinksForExistingTracks; },
    get broadcastGenreProfilesUpdated() { return broadcastGenreProfilesUpdated; },
    get saveGenreProfileForEditor() { return saveGenreProfileForEditor; },
    get mergeGenreProfilesForEditor() { return mergeGenreProfilesForEditor; },
    get setGenreProfileTypeForEditor() { return setGenreProfileTypeForEditor; },
    get reclassifyGenreForEditor() { return reclassifyGenreForEditor; },
    get collectAudioFilesFromInputPaths() { return collectAudioFilesFromInputPaths; },
    get normalizeGenreKey() { return normalizeGenreKey; },
    get artistCardWindow() { return artistCardWindow; },
    set artistCardWindow(val) { artistCardWindow = val; },
    get artistCatalogWindow() { return artistCatalogWindow; },
    set artistCatalogWindow(val) { artistCatalogWindow = val; },
    get musicSeparationWindow() { return musicSeparationWindow; },
    set musicSeparationWindow(val) { musicSeparationWindow = val; },

};

require('./backend/ipc/commercials')(sharedState);
require('./backend/ipc/events')(sharedState);
require('./backend/ipc/ui')(sharedState);
require('./backend/ipc/windows')(sharedState);
require('./backend/ipc/system')(sharedState);
require('./backend/ipc/cartwall')(sharedState);
require('./backend/ipc/library')(sharedState);
require('./backend/ipc/library_index')(sharedState);
require('./backend/ipc/stream')(sharedState);
require('./backend/ipc/history')(sharedState);
