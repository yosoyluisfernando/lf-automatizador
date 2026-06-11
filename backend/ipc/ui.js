module.exports = function(context) {
    const {
        ipcMain, dialog, fs, path, shell, configDir, db, writeLog, readTagsAsync, genreFileTagToLibraryLabel,
        BrowserWindow,
        lastVuLevels, buildVuPayload, scheduleVuBroadcast, broadcastVuLevels, auxCueSources,
        resolveLevel, resolveDb, resolveStereoPair, resolveStereoDbPair
    } = context;
    const i18n = require('../i18n_main');
    let fileMetadataEditorWindow = null;

    ipcMain.handle('dialog:askClearLibrary', async () => { const res = await dialog.showMessageBox(context.libraryWindow || context.mainWindow, { type: 'question', buttons: [i18n.t('dialogs.buttons.save_list'), i18n.t('dialogs.buttons.dont_save'), i18n.t('dialogs.buttons.cancel')], defaultId: 0, cancelId: 2, title: i18n.t('dialogs.clear_library.title'), message: i18n.t('dialogs.clear_library.message'), noLink: true }); return res.response; });
    ipcMain.handle('dialog:openLibraryList', async () => { const res = await dialog.showOpenDialog(context.libraryWindow || context.mainWindow, { title: i18n.t('dialogs.open_library.title'), properties: ['openFile'], filters: [{ name: 'LF Library File', extensions: ['lflib'] }] }); return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; });
    ipcMain.handle('dialog:saveLibraryList', async () => { const res = await dialog.showSaveDialog(context.libraryWindow || context.mainWindow, { title: i18n.t('dialogs.save_library.title'), defaultPath: 'Mi_Libreria.lflib', filters: [{ name: 'LF Library File', extensions: ['lflib'] }] }); return (!res.canceled && res.filePath) ? res.filePath : null; });
    ipcMain.on('save-file-sync', (e, filePath, data) => { try { fs.writeFileSync(filePath, data, 'utf-8'); } catch(err) { writeLog("Error save-file-sync: " + err); } });

    ipcMain.handle('db-maintenance-vacuum', async () => {
        if (!db?.runMaintenanceVacuum) return { success: false, error: 'Mantenimiento VACUUM no disponible.' };
        return db.runMaintenanceVacuum();
    });

    ipcMain.handle('file:show-in-folder', async (event, filePath) => {
        try {
            const resolvedPath = path.resolve(String(filePath || ''));
            if (!filePath || !fs.existsSync(resolvedPath)) return { success: false, error: 'El archivo no existe.' };
            shell.showItemInFolder(resolvedPath);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    // Cross-Platform: Auditoría de mayúsculas/minúsculas en rutas de archivos.
    // En Linux, "Bachata.mp3" y "bachata.mp3" son archivos DISTINTOS.
    // Esta herramienta detecta (y opcionalmente corrige) discrepancias entre la BD y el disco.
    const { runPathCaseAudit } = require('../path_case_audit');
    ipcMain.handle('db-maintenance-path-audit', async (e, options = {}) => {
        if (!db) return { success: false, error: 'BD no conectada.' };
        try {
            return runPathCaseAudit(db, { autoFix: options.autoFix === true, writeLog });
        } catch (err) {
            writeLog("[PATH AUDIT] Error: " + err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('audio-engine-rust-status', async () => {
        return context.rustAudioEngine?.status?.() || { available: false, running: false, lastError: 'RustAudio no configurado.' };
    });

    ipcMain.handle('audio-engine-rust-command', async (event, command = {}) => {
        if (!context.rustAudioEngine?.command) return { success: false, error: 'RustAudio no configurado.' };
        // _timeoutMs es un campo interno de JS; el probe lo extrae antes de enviar al proceso Rust.
        return context.rustAudioEngine.command(command);
    });

    ipcMain.handle('audio-engine-rust-recover', async (event, reason = '') => {
        if (!context.rustAudioEngine?.recover) return { success: false, error: 'Recuperacion RustAudio no configurada.' };
        return context.rustAudioEngine.recover(String(reason || 'Recuperacion solicitada por renderer.'));
    });

    // Devuelve la carpeta de caché de peaks. Creada automáticamente si no existe.
    // Valor por defecto: <raíz del programa>/cache/peaks/
    // TODO futuro: permitir al usuario elegir la carpeta desde Configuración.
    ipcMain.handle('get-cache-dir', async () => {
        try {
            const cacheDir = path.join(path.resolve(__dirname, '..', '..'), 'cache', 'peaks');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            return { success: true, cacheDir };
        } catch (err) {
            return { success: false, cacheDir: '', error: err.message || String(err) };
        }
    });

    ipcMain.handle('audio-engine-report-tail', async (event, maxLines = 30) => {
        if (!context.rustAudioEngine?.readReportTail) return { success: false, error: 'Reporte RustAudio no configurado.', entries: [] };
        return context.rustAudioEngine.readReportTail(maxLines);
    });

    ipcMain.handle('audio-routing-config', async () => {
        try {
            const filePath = path.join(configDir, 'general_settings.json');
            if (!fs.existsSync(filePath)) return { success: true, config: {} };
            return { success: true, config: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
        } catch (err) {
            return { success: false, error: err.message || String(err), config: {} };
        }
    });

    ipcMain.handle('audio-engine-snapshot', async (event, extra = {}) => {
        if (!context.rustAudioEngine?.writeDiagnosticsSnapshot) return { success: false, error: 'Snapshot RustAudio no configurado.' };
        return context.rustAudioEngine.writeDiagnosticsSnapshot(extra);
    });

    ipcMain.handle('editor-read-local-tags', async (e, filePath) => {
        try {
            const tags = await readTagsAsync(filePath);
            return {
                title: tags.title || '',
                artist: tags.artist || '',
                album: tags.album || '',
                year: tags.year || '',
                genre: genreFileTagToLibraryLabel(tags.genre)
            };
        } catch (err) {
            return {};
        }
    });

    ipcMain.on('lib-add-to-playlist', (e, paths) => { if (context.mainWindow) context.mainWindow.webContents.send('menu-add-files', paths); });
    ipcMain.on('refresh-manual-cues', () => { if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues'); if (context.libraryWindow) context.libraryWindow.webContents.send('refresh-manual-cues'); });

    ipcMain.on('open-reports-window', () => {
        if (context.reportsWindow) {
            if (context.reportsWindow.isMinimized()) context.reportsWindow.restore();
            context.reportsWindow.focus();
            return;
        }
        context.reportsWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'reports.png')), 
            width: 860, height: 760, minWidth: 720, minHeight: 560,
            title: 'Centro de Estado e Incidencias',
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        context.reportsWindow.loadFile('frontend/reportes.html');
        context.reportsWindow.on('closed', () => { context.reportsWindow = null; });
    });

    ipcMain.on('open-file-metadata-editor', (event, filePath) => {
        if (fileMetadataEditorWindow && !fileMetadataEditorWindow.isDestroyed()) {
            fileMetadataEditorWindow.focus();
            fileMetadataEditorWindow.webContents.send('load-file-metadata', filePath);
            return;
        }
        fileMetadataEditorWindow = new BrowserWindow({
            icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'editor.png')),
            width: 560, height: 470, minWidth: 520, minHeight: 430,
            title: 'Editar archivo y metadatos',
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        fileMetadataEditorWindow.loadFile('frontend/file_metadata_editor.html');
        fileMetadataEditorWindow.webContents.on('did-finish-load', () => {
            fileMetadataEditorWindow.webContents.send('load-file-metadata', filePath);
        });
        fileMetadataEditorWindow.on('closed', () => {
            fileMetadataEditorWindow = null;
            if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues');
            if (context.libraryWindow) context.libraryWindow.webContents.send('refresh-manual-cues');
        });
    });

    ipcMain.on('incident-sync-broadcast', (event, snapshot) => {
        if (context.reportsWindow && !context.reportsWindow.isDestroyed()) {
            context.reportsWindow.webContents.send('incident-sync-update', snapshot);
        }
    });

    ipcMain.on('incident-request-sync', () => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('incident-request-sync');
        }
    });

    const pendingAudioEngineCommands = new Map();
    ipcMain.handle('audio-engine-command', async (event, command = {}) => {
        if (!context.mainWindow || context.mainWindow.isDestroyed()) {
            return { success: false, error: 'Ventana principal no disponible.' };
        }
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                pendingAudioEngineCommands.delete(id);
                resolve({ success: false, error: 'Timeout esperando respuesta del motor de audio.' });
            }, 3000);
            pendingAudioEngineCommands.set(id, { resolve, timeout });
            context.mainWindow.webContents.send('audio-engine-command', { id, ...command });
        });
    });

    ipcMain.on('audio-engine-command-result', (event, payload = {}) => {
        const pending = pendingAudioEngineCommands.get(payload.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingAudioEngineCommands.delete(payload.id);
        pending.resolve({ success: true, ...payload });
    });

    ipcMain.on('open-console', () => {
        if (context.consoleWindow) { context.consoleWindow.focus(); return; }
        context.consoleWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'console.png')), 
            width: 1280, height: 420, minWidth: 980, minHeight: 320, title: 'Consola Virtual de Monitoreo',
            autoHideMenuBar: true, resizable: true, maximizable: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
        });
        context.consoleWindow.loadFile('frontend/consola.html');
        context.consoleWindow.webContents.on('did-finish-load', () => {
            context.lastVuLevels = buildVuPayload(context.lastVuLevels);
            scheduleVuBroadcast(true);
        });
        context.consoleWindow.on('closed', () => { context.consoleWindow = null; });
    });

    // ─── Bloqueo de amplitudes Web Audio en la consola virtual ─────────────
    // La consola es exclusiva del motor Rust. Cuando el motor está corriendo,
    // las amplitudes que llegan de WebAudio se descartan: sólo dejamos pasar
    // el bloque de diagnósticos. Cada intento se registra una vez cada 30 s
    // por origen en `audio_engine_report.jsonl` para detectar qué editor o
    // proceso sigue mandando datos WebAudio aunque ya no deba.
    const __WEBAUDIO_REJECT_THROTTLE_MS = 30000;
    const __webAudioRejectLog = new Map();
    function __logWebAudioReject(origin) {
        if (!origin) origin = 'unknown';
        const now = Date.now();
        const last = __webAudioRejectLog.get(origin) || 0;
        if (now - last < __WEBAUDIO_REJECT_THROTTLE_MS) return;
        __webAudioRejectLog.set(origin, now);
        try {
            if (context.rustAudioEngine?.logEvent) {
                context.rustAudioEngine.logEvent('webaudio-rejected', { origin, channel: 'vu-levels' });
            }
        } catch (err) {}
    }
    function __isRustRunning() {
        try { return context.rustAudioEngine?.status?.()?.running === true; }
        catch (err) { return false; }
    }
    function __rustMeterRawToVisualPercent(value) {
        const amp = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
        if (amp <= 0.0001) return 0;
        const db = 20 * Math.log10(amp);
        if (db < -36) return 0;
        if (db > 3) return 100;
        return ((db + 36) / 39) * 100;
    }
    function __rustMeterToLevel(meter = {}) {
        const rawLeft = Math.max(0, Math.min(100, Number(meter.left) || 0));
        const rawRight = Math.max(0, Math.min(100, Number(meter.right) || 0));
        const left = __rustMeterRawToVisualPercent(rawLeft);
        const right = __rustMeterRawToVisualPercent(rawRight);
        const rawPeak = Math.max(rawLeft, rawRight);
        const db = Number.isFinite(Number(meter.db))
            ? Number(meter.db)
            : (rawPeak > 0 ? 20 * Math.log10(rawPeak / 100) : Number.NEGATIVE_INFINITY);
        return { left, right, max: Math.max(left, right), db };
    }
    function __mergeRustLevels(levels = []) {
        return levels.reduce((acc, level) => {
            if (!level) return acc;
            acc.left = Math.max(acc.left, Number(level.left) || 0);
            acc.right = Math.max(acc.right, Number(level.right) || 0);
            acc.max = Math.max(acc.max, Number(level.max) || 0);
            acc.db = Math.max(acc.db, Number.isFinite(Number(level.db)) ? Number(level.db) : Number.NEGATIVE_INFINITY);
            return acc;
        }, { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY });
    }
    function __deriveRustVuLevels(levels = {}) {
        const meters = Array.isArray(levels.rustMeters) && levels.rustMeters.length
            ? levels.rustMeters
            : (Array.isArray(levels.diagnostics?.rustProbe?.lastStatus?.meters) ? levels.diagnostics.rustProbe.lastStatus.meters : []);
        const byBus = new Map();
        meters.forEach(meter => {
            const bus = String(meter?.bus || '').toLowerCase();
            if (!bus) return;
            byBus.set(bus, __mergeRustLevels([byBus.get(bus), __rustMeterToLevel(meter)]));
        });
        const playlistMode = levels.diagnostics?.devices?.playlistMode || 'disabled';
        const program = byBus.get('master') || __mergeRustLevels([
            playlistMode === 'independent' ? null : byBus.get('pl1'),
            playlistMode === 'independent' ? null : byBus.get('pl2'),
            playlistMode === 'independent' ? null : byBus.get('pl3'),
            playlistMode === 'independent' ? null : byBus.get('pl4'),
            byBus.get('aux1'),
            byBus.get('aux2'),
            byBus.get('jingle'),
            byBus.get('cartwall')
        ]);
        return {
            program,
            monitor: byBus.get('monitor') || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY },
            cue: byBus.get('cue') || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY },
            jingle: byBus.get('jingle') || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY },
            cartwall: byBus.get('cartwall') || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY },
            playlists: ['pl1', 'pl2', 'pl3', 'pl4'].map(bus => byBus.get(bus) || { left: 0, right: 0, max: 0, db: Number.NEGATIVE_INFINITY })
        };
    }
    function __stripWebAudioAmplitude(levels = {}) {
        // Mantiene diagnosticos y meters Rust; pisa amplitudes WebAudio, pero
        // reconstruye la senal visible desde Rust para no dejar la UI en -inf.
        const rust = __deriveRustVuLevels(levels);
        return {
            ...levels,
            pgm: rust.program.max,
            monitor: rust.monitor.max,
            cue: rust.cue.max,
            jingle: rust.jingle.max,
            cartwall: rust.cartwall.max,
            playlists: rust.playlists.map(level => level.max),
            stereo: {
                pgm: { left: rust.program.left, right: rust.program.right },
                monitor: { left: rust.monitor.left, right: rust.monitor.right },
                cue: { left: rust.cue.left, right: rust.cue.right },
                jingle: { left: rust.jingle.left, right: rust.jingle.right },
                cartwall: { left: rust.cartwall.left, right: rust.cartwall.right },
                playlists: rust.playlists.map(level => ({ left: level.left, right: level.right }))
            },
            dbs: {
                pgm: rust.program.db,
                monitor: rust.monitor.db,
                cue: rust.cue.db,
                jingle: rust.jingle.db,
                cartwall: rust.cartwall.db,
                playlists: rust.playlists.map(level => level.db)
            },
            stereoDbs: {
                pgm: { left: rust.program.db, right: rust.program.db },
                monitor: { left: rust.monitor.db, right: rust.monitor.db },
                cue: { left: rust.cue.db, right: rust.cue.db },
                jingle: { left: rust.jingle.db, right: rust.jingle.db },
                cartwall: { left: rust.cartwall.db, right: rust.cartwall.db },
                playlists: rust.playlists.map(level => ({ left: level.db, right: level.db }))
            }
        };
    }

    ipcMain.on('vu-levels', (e, levels) => {
        if (__isRustRunning()) {
            __logWebAudioReject('renderer.vu-levels');
            broadcastVuLevels(__stripWebAudioAmplitude(levels || {}));
            return;
        }
        broadcastVuLevels(levels);
    });

    ipcMain.on('aux-vu-levels', (e, payload) => {
        if (!payload || !payload.source) return;
        if (__isRustRunning()) {
            __logWebAudioReject(`editor.${payload.source}`);
            return;
        }
        auxCueSources[payload.source] = {
            cue: resolveLevel(payload.cue, 0),
            cueDb: resolveDb(payload.cueDb, Number.NEGATIVE_INFINITY),
            cueStereo: resolveStereoPair(payload.cueStereo, { left: 0, right: 0 }),
            cueStereoDbs: resolveStereoDbPair(payload.cueStereoDbs, { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY })
        };
        broadcastVuLevels(context.lastVuLevels);
    });

    ipcMain.on('remote-add-to-playlist', (e, payload) => {
        if (context.mainWindow) {
            context.mainWindow.webContents.send('remote-add-to-playlist', payload);
        }
    });
};
