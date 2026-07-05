// Fase 1 encoder: Electron mantiene ventana, preferencias e IPC; Rust posee
// validacion, FFmpeg, protocolos de streaming, tap PCM y metadata remota.

const { loadEncoderPrefs, saveEncoderPrefs } = require('../encoder/prefs');
const { createRustManagedEncoderBridge } = require('../encoder/rust_bridge');
const { redactSensitiveText } = require('../utils/log_security');

module.exports = function(context) {
    const { ipcMain, dialog, screen, openCommercialManagerWindow, BrowserWindow, writeLog, path, configDir, fs, ffmpegPath, ffmpegFdkPath, ffmpegCapabilities, safeStorage } = context;

    // Detectar soporte de libfdk_aac en el FFmpeg empaquetado. El resultado se
    // pasa al motor Rust para habilitar HE-AAC solo con un binario autorizado.
    // En builds estándar (ffmpeg-static / gyan.dev GPL) siempre será false porque
    // libfdk_aac es non-free y no se incluye. Si el operador sustituye el binario
    // por uno compilado con --enable-libfdk_aac, el probe lo detecta y habilita
    // HE-AAC real automáticamente.
    const _fdkAacAvailable = !!(ffmpegFdkPath && ffmpegCapabilities?.fdk?.libfdkAac === true);

    // ── Registro multi-servidor del encoder ──────────────────────────────────
    // Cada servidor de streaming tiene su propio proceso FFmpeg, alimentado por
    // UNA sola fuente PCM compartida (el tap del motor Rust). El registro mapea
    // serverId -> runtime del servidor.
    if (!context.encoderServers) context.encoderServers = new Map();
    if (!context.pendingEncoderConnects) context.pendingEncoderConnects = new Map();
    if (!context.encoderConnectVersions) context.encoderConnectVersions = new Map();

    function getEncoderServer(id) { return context.encoderServers.get(String(id)); }
    function beginEncoderConnect(id, config) {
        const sid = String(id);
        const version = (context.encoderConnectVersions.get(sid) || 0) + 1;
        context.encoderConnectVersions.set(sid, version);
        context.pendingEncoderConnects.set(sid, {
            version,
            source: config.source === 'mic' ? 'mic' : 'master'
        });
        return version;
    }
    function cancelEncoderConnect(id) {
        const sid = String(id);
        if (!context.encoderConnectVersions) context.encoderConnectVersions = new Map();
        if (!context.pendingEncoderConnects) context.pendingEncoderConnects = new Map();
        context.encoderConnectVersions.set(sid, (context.encoderConnectVersions.get(sid) || 0) + 1);
        context.pendingEncoderConnects.delete(sid);
    }
    function finishEncoderConnect(id, attempt) {
        const sid = String(id);
        if (context.pendingEncoderConnects.get(sid)?.version === attempt) {
            context.pendingEncoderConnects.delete(sid);
        }
    }
    function isEncoderConnectCurrent(id, attempt) {
        return context.encoderConnectVersions.get(String(id)) === attempt;
    }
    function emitEncoderError(id, message, details = {}) {
        const cleanMessage = redactSensitiveText(message || 'Error de encoder desconocido.');
        const classified = details.category
            ? { category: details.category, retryable: details.retryable === true }
            : { category: 'server', retryable: false };
        const payload = {
            serverId: String(id),
            message: cleanMessage,
            category: classified.category,
            retryable: classified.retryable
        };
        if (context.encoderWindow && !context.encoderWindow.isDestroyed()) {
            context.encoderWindow.webContents.send('encoder-error', payload);
        }
        return payload;
    }
    function countLiveServers() {
        let n = 0;
        for (const s of context.encoderServers.values()) if (s.proc || s.rustManaged) n++;
        return n;
    }

    // Estado global agregado (para el badge del encoder en la ventana principal).
    // live si algún servidor está en vivo; connecting si alguno conecta; si no, disconnected.
    function recomputeGlobalEncoderStatus() {
        let anyLive = false, anyConnecting = false;
        for (const s of context.encoderServers.values()) {
            if (s.status === 'live') anyLive = true;
            else if (s.status === 'connecting') anyConnecting = true;
        }
        const global = anyLive ? 'live' : (anyConnecting ? 'connecting' : 'disconnected');
        context.encoderRuntimeStatus = global;
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('encoder-global-status', global);
        return global;
    }

    // Estado de UN servidor → notifica a la ventana del encoder con serverId y
    // recalcula el agregado global.
    function setServerStatus(id, status) {
        const server = getEncoderServer(id);
        if (server) server.status = status;
        if (context.encoderWindow && !context.encoderWindow.isDestroyed()) {
            context.encoderWindow.webContents.send('encoder-status', { serverId: String(id), status });
        }
        recomputeGlobalEncoderStatus();
    }

    // Compat: setEncoderStatus global directo (usado por rutas legacy de error).
    function setEncoderStatus(status) {
        context.encoderRuntimeStatus = status;
        if (context.encoderWindow && !context.encoderWindow.isDestroyed()) context.encoderWindow.webContents.send('encoder-status', { serverId: null, status });
        if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('encoder-global-status', status);
    }


    function buildEncoderSourceContract(config = {}, active = false) {
        const normalized = normalizeEncoderConfig(config || context.activeEncoderConfig || {});
        const source = normalized.source === 'mic' ? 'mic' : 'master';
        return {
            active: !!active,
            source,
            owner: 'rustAudioEngine',
            requestedOwner: 'rustAudioEngine',
            captureProvider: 'rustAudioEngine',
            encoderProvider: 'rust',
            tapPoint: normalized.tapPoint,
            rustPcmReady: true,
            pcmBridgeReady: true,
            pcmBridgeMode: source === 'mic' ? 'input-router' : 'native-tap',
            pcmBridgeReason: '',
            fallbackReason: '',
            captureFormat: config.captureFormat || 'pcm_s16le',
            sampleRate: Number(config.sampleRate) || 44100,
            transport: source === 'mic' ? 'rust-input-router' : 'rust-encoder-tap'
        };
    }

    let _lastStopAt = 0;
    let _lastHealthAt = 0;
    function notifyRustEncoder(action, config = {}) {
        const active = action === 'start';
        const contract = buildEncoderSourceContract(config, active);
        const health = {
            bitrateKbps: Number(config.bitrateKbps) || Number(context.encoderSourceContract?.bitrateKbps) || 0,
            speed: Number(config.speed) || Number(context.encoderSourceContract?.speed) || 0,
            ffmpegTime: config.ffmpegTime || context.encoderSourceContract?.ffmpegTime || '',
            maxGapMs: Number(config.maxGapMs) || Number(context.encoderSourceContract?.maxGapMs) || 0,
            gapWarnings: Number(config.gapWarnings) || Number(context.encoderSourceContract?.gapWarnings) || 0
        };
        const previous = context.encoderSourceContract || {};
        const signature = JSON.stringify({ action, ...contract, ...health });
        const healthOnly = action === 'health';
        const now = Date.now();
        if (action === 'start') _lastStopAt = 0;
        if (action === 'stop') {
            if (_lastStopAt && now - _lastStopAt < 5000) return;
            _lastStopAt = now;
        }
        if (previous.signature === signature) return;
        if (healthOnly && _lastHealthAt && now - _lastHealthAt < 15000) {
            context.encoderSourceContract = { ...previous, ...contract, ...health, active: previous.active === true, signature };
            return;
        }
        if (healthOnly) _lastHealthAt = now;
        context.encoderSourceContract = { ...contract, ...health, active: healthOnly ? previous.active === true : contract.active, signature };
        const encoderCommand = {
            cmd: 'encoder',
            action: healthOnly ? 'status' : action,
            source: contract.source,
            sourceBus: contract.source,
            owner: 'rustAudioEngine',
            captureProvider: 'rustAudioEngine',
            tapPoint: contract.tapPoint,
            captureFormat: contract.captureFormat,
            sampleRate: contract.sampleRate,
            bitrateKbps: health.bitrateKbps,
            speed: health.speed,
            ffmpegTime: health.ffmpegTime,
            maxGapMs: health.maxGapMs,
            gapWarnings: health.gapWarnings
        };
        if (context.isAppQuitting) {
            if (context.rustAudioEngine?.isRunning?.() && context.rustAudioEngine?.send) {
                context.rustAudioEngine.send(encoderCommand);
            }
            return;
        }
        if (!context.rustAudioEngine?.command) return;
        context.rustAudioEngine.command(encoderCommand).catch(err => writeLog(`RustAudio encoder ${action}: ${err.message || err}`));
    }

    // Detiene la fuente PCM compartida y la captura SOLO si ya no queda ningún
    // servidor con proceso vivo. Llamar tras matar un servidor.
    function maybeStopEncoderInput(options = {}) {
        if (countLiveServers() > 0 || context.pendingEncoderConnects.size > 0) return;
        notifyRustEncoder('stop', context.encoderSourceContract || context.activeEncoderConfig || {});
        if (!options.suppressStopCapture && context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('stop-audio-capture');
        }
    }

    // Mata el proceso FFmpeg de UN servidor (sin afectar a los demás).
    function killEncoderServer(id, reason = '', options = {}) {
        cancelEncoderConnect(id);
        const server = getEncoderServer(id);
        if (!server) {
            if (!options.suppressStatus) setServerStatus(id, 'disconnected');
            if (reason && !options.suppressError) emitEncoderError(id, reason, options.details || {});
            maybeStopEncoderInput(options);
            return;
        }
        const proc = server.proc;
        const rustManaged = server.rustManaged === true;
        server.proc = null;
        server.rustManaged = false;
        if (proc) {
            try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.destroy(); } catch (err) {}
            try { proc.kill('SIGKILL'); } catch (err) { try { proc.kill(); } catch (innerErr) {} }
        }
        if (rustManaged) {
            rustManagedEncoderBridge.stopServer(id).catch(err => writeLog(`Rust encoder stop [srv ${id}]: ${err.message || err}`));
        }
        if (!options.suppressStatus) setServerStatus(id, 'disconnected');
        if (reason && !options.suppressError) emitEncoderError(id, reason, options.details || {});
        maybeStopEncoderInput(options);
    }

    // Mata TODOS los servidores (desconectar todo / parada de emergencia).
    function killAllEncoderServers(reason = '', options = {}) {
        const ids = Array.from(new Set([
            ...context.encoderServers.keys(),
            ...(context.pendingEncoderConnects?.keys?.() || [])
        ]));
        for (const id of ids) {
            cancelEncoderConnect(id);
            const server = getEncoderServer(id);
            const proc = server && server.proc;
            const rustManaged = server && server.rustManaged === true;
            if (server) {
                server.proc = null;
                server.rustManaged = false;
            }
            if (proc) {
                try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.destroy(); } catch (err) {}
                try { proc.kill('SIGKILL'); } catch (err) { try { proc.kill(); } catch (innerErr) {} }
            }
            if (rustManaged) {
                rustManagedEncoderBridge.stopServer(id).catch(err => writeLog(`Rust encoder stop [srv ${id}]: ${err.message || err}`));
            }
            if (!options.suppressStatus) setServerStatus(id, 'disconnected');
        }
        maybeStopEncoderInput(options);
    }

    function shutdownEncoderOnAppQuit() {
        killAllEncoderServers('', {
            suppressStatus: true,
            suppressError: true,
            suppressStopCapture: true
        });
        context.activeEncoderConfig = null;
    }

    context.app?.once?.('before-quit', shutdownEncoderOnAppQuit);

    function normalizeEncoderConfig(config = {}) {
        // Tipos validos: 'icecast' (Icecast 2 PUT), 'shoutcast' (ICY legacy)
        // y 'shoutcast2' (Ultravox 2.1 salvo compatibilidad ICY explicita).
        // Cualquier otro valor cae a 'icecast' como defensa adicional.
        const rawType = config.serverType || config.type || 'icecast';
        const serverType = ['icecast', 'shoutcast', 'shoutcast2'].includes(rawType) ? rawType : 'icecast';
        const password = config.password || config.pass || '';
        const bitrate = Math.min(320, Math.max(32, parseInt(config.bitrate, 10) || 128));
        const source = config.source === 'mic' ? 'mic' : 'master';
        // Usuario del source: por defecto 'source' (estándar Icecast/SHOUTcast).
        // Solo Icecast 2 permite usuarios personalizados según el proveedor.
        const user = String(config.user || config.username || '').trim() || 'source';
        return {
            ...config,
            serverType,
            type: serverType,
            user,
            password,
            pass: password,
            ip: String(config.ip || '').trim(),
            port: String(config.port || '').trim(),
            adminPort: String(config.adminPort || '').trim(),
            mount: String(config.mount || '').trim(),
            source,
            tapPoint: config.tapPoint === 'preFx' ? 'preFx' : 'postFx',
            sourceId: config.sourceId || config.micId || config.mic || '',
            micId: config.micId || config.mic || config.sourceId || '',
            codec: config.codec === 'mp3' ? 'mp3' : config.codec === 'aac_he' ? 'aac_he' : 'aac',
            // El motor de audio es siempre Rust (WebAudio fue retirado del programa).
            encoderProvider: 'rust',
            bitrate: String(bitrate),
            legacy: config.legacy === true,
            icyName: String(config.icyName || config.name || 'Radio').trim() || 'Radio',
            icyGenre: String(config.icyGenre || 'Variado').trim() || 'Variado'
        };
    }


    // Conecta UN servidor del path master. Cualquier protocolo operativo debe
    // existir en Rust; Electron no lanza FFmpeg ni transportes de encoder.
    const rustManagedEncoderBridge = createRustManagedEncoderBridge({
        context,
        writeLog,
        ffmpegPath,
        ffmpegFdkPath,
        fdkAvailable: _fdkAacAvailable,
        normalizeEncoderConfig,
        countLiveServers,
        getEncoderServer,
        setServerStatus,
        emitEncoderError,
        notifyRustEncoder,
        killEncoderServer,
    });

    async function connectEncoderServer(id, config, attempt) {
        const normalized = normalizeEncoderConfig(config);
        const rustStart =
            normalized.serverType === 'icecast'
                ? rustManagedEncoderBridge.startIcecast
                : ['shoutcast', 'shoutcast2'].includes(normalized.serverType)
                    ? rustManagedEncoderBridge.startShoutcast
                    : null;
        if (rustStart) {
            const started = await rustStart(id, normalized);
            if (!isEncoderConnectCurrent(id, attempt)) {
                killEncoderServer(id, '', { suppressError: true });
                return { success: false, cancelled: true, error: 'Conexion cancelada.' };
            }
            if (!started.success) maybeStopEncoderInput();
            return started;
        }
        const message = `Tipo de servidor no soportado por el motor Rust: ${normalized.serverType || 'desconocido'}.`;
        emitEncoderError(id, message, { category: 'config', retryable: false });
        maybeStopEncoderInput();
        return { success: false, error: message };
    }

    async function startEncoderCapture(config, id = '0', attempt) {
        const sid = String(id);
        const started = await connectEncoderServer(sid, config, attempt);
        if (started.success || started.cancelled) return started;
        writeLog(`Rust PCM encoder [srv ${sid}] no inicio (${started.error || 'sin detalle'}).`);
        setServerStatus(sid, 'disconnected');
        emitEncoderError(sid, started.error || 'Rust PCM encoder no inicio.');
        return started;
    }

    ipcMain.handle('dialog:openFile', async (event) => { 
        const currentWin = BrowserWindow.fromWebContents(event.sender) || context.eventEditorWindow || context.mainWindow; 
        const res = await dialog.showOpenDialog(currentWin, { properties: ['openFile'], filters: [ { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aiff', 'aif', 'mp2'] } ] });
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; 
    }); 
    
    ipcMain.handle('dialog:openPlaylist', async () => { 
        const currentWin = context.eventEditorWindow || context.mainWindow;
        const res = await dialog.showOpenDialog(currentWin, { title: 'Abrir Playlist', properties: ['openFile'], filters: [{ name: 'LFPlay Playlist', extensions: ['lfplay'] }] }); 
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; 
    }); 
    
    ipcMain.handle('dialog:savePlaylist', async (e, defName) => { const currentWin = BrowserWindow.fromWebContents(e.sender) || context.mainWindow; const res = await dialog.showSaveDialog(currentWin, { title: 'Guardar Playlist', defaultPath: defName || 'Mi_Playlist.LFPlay', filters: [{ name: 'LFPlay Playlist', extensions: ['lfplay'] }] }); return (!res.canceled && res.filePath) ? res.filePath : null; }); 
    
    ipcMain.handle('dialog:selectFolder', async (event) => { 
        const currentWin = BrowserWindow.fromWebContents(event.sender) || context.eventEditorWindow || context.libraryWindow || context.settingsWindow || context.mainWindow; 
        const res = await dialog.showOpenDialog(currentWin, { title: 'Seleccionar Carpeta', properties: ['openDirectory'] }); 
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; 
    }); 

    // ── Handler `rust-pcm-ffmpeg-test` ELIMINADO ──────────────────────────
    // Era un botón de smoke test que dependía de `runRustPcmBridgeFfmpegSmokeTest`
    // (función nunca implementada). El botón en consola.html se mantiene como
    // referencia visual pero su click handler ya falla controladamente.

    // FASE D · sub-paso 8.2 — En modo tap nativo, el motor Rust maneja su
    // propio mapa de players internamente. El antiguo `syncPlayers` del lado
    // JS era para el `RustPcmBridgeEncoderSource` muerto; ahora es noop.
    ipcMain.handle('rust-pcm-encoder-status', async () => {
        return context.rustPcmEncoderSource?.status?.() || { running: false };
    });
    
    ipcMain.handle('show-context-menu', (event, template) => {
        return new Promise((resolve) => {
            const { Menu } = require('electron');
            let resolved = false;
            const buildMenu = (items) => {
                return items.map(item => {
                    if (item.type === 'separator') return { type: 'separator' };
                    if (item.submenu) return { label: item.label, submenu: buildMenu(item.submenu) };
                    return {
                        label: item.label,
                        type: item.type || 'normal',
                        checked: item.checked,
                        enabled: item.enabled !== false,
                        click: () => { resolved = true; resolve(item.id); }
                    };
                });
            };
            const menu = Menu.buildFromTemplate(buildMenu(template));
            menu.once('menu-will-close', () => { setTimeout(() => { if (!resolved) resolve(null); }, 50); });
            menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
        });
    });

    
    function forwardSettingsUpdated(payload = {}) {
        if (context.mainWindow) context.mainWindow.webContents.send('settings-updated', payload);
        if (context.audioEditorWindow) context.audioEditorWindow.webContents.send('settings-updated', payload);
        if (context.transitionEditorWindow) context.transitionEditorWindow.webContents.send('settings-updated', payload);
        if (context.jingleEditorWindow) context.jingleEditorWindow.webContents.send('settings-updated', payload);
        if (context.libraryWindow) context.libraryWindow.webContents.send('settings-updated', payload);
        if (context.previewWindow) context.previewWindow.webContents.send('settings-updated', payload);
        if (context.consoleWindow) context.consoleWindow.webContents.send('settings-updated', payload);
        if (context.reportsWindow && !context.reportsWindow.isDestroyed()) context.reportsWindow.webContents.send('settings-updated', payload);
        if (context.musicSeparationWindow && !context.musicSeparationWindow.isDestroyed()) context.musicSeparationWindow.webContents.send('settings-updated', payload);
    }

    ipcMain.on('open-commercial-manager', () => openCommercialManagerWindow());
    ipcMain.on('open-library', () => { if (context.libraryWindow) { context.libraryWindow.focus(); return; } context.libraryWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'library.png')),   width: 1150, height: 750, title: 'Biblioteca de Música', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.libraryWindow.loadFile('frontend/libreria.html'); context.libraryWindow.on('closed', () => { context.libraryWindow = null; }); }); 
    ipcMain.on('open-settings', (e, targetTab) => { 
        if (context.settingsWindow) { 
            context.settingsWindow.focus(); 
            if (targetTab) context.settingsWindow.webContents.send('switch-tab', targetTab);
            return; 
        } 
        context.settingsWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'settings.png')),   width: 980, height: 760, minWidth: 900, minHeight: 700, title: 'Ajustes Generales', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); 
        const opts = targetTab ? { query: { tab: targetTab } } : {};
        context.settingsWindow.loadFile('frontend/settings.html', opts); 
        context.settingsWindow.on('closed', () => { context.settingsWindow = null; }); 
    }); 
    ipcMain.on('settings-updated', (_e, payload) => { forwardSettingsUpdated(payload || {}); }); ipcMain.on('refresh-event-groups', () => { if (context.mainWindow) context.mainWindow.webContents.send('refresh-event-groups'); if (context.eventEditorWindow) context.eventEditorWindow.webContents.send('refresh-event-groups'); if (context.calendarWindow && !context.calendarWindow.isDestroyed()) context.calendarWindow.webContents.send('refresh-event-groups'); }); ipcMain.on('open-event-groups', () => { if (context.eventGroupsWindow) { context.eventGroupsWindow.focus(); return; } context.eventGroupsWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'groups.png')),   width: 650, height: 550, title: 'Grupos de Eventos', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.eventGroupsWindow.loadFile('frontend/event_groups.html'); context.eventGroupsWindow.on('closed', () => { context.eventGroupsWindow = null; if (context.mainWindow) context.mainWindow.webContents.send('refresh-event-groups'); if(context.eventEditorWindow) context.eventEditorWindow.webContents.send('refresh-event-groups'); }); }); ipcMain.on('open-event-editor', (e, eventData) => { const requestedKey = eventData && eventData.id ? `edit:${eventData.id}` : 'new'; if (context.eventEditorWindow && !context.eventEditorWindow.isDestroyed()) { if (context.eventEditorContextKey === requestedKey) { if (context.eventEditorWindow.isMinimized()) context.eventEditorWindow.restore(); context.eventEditorWindow.show(); context.eventEditorWindow.focus(); return; } context.eventEditorWindow.destroy(); context.eventEditorWindow = null; context.eventEditorContextKey = null; } context.eventEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'events.png')),   width: 820, height: 760, title: 'Editor de Eventos', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.eventEditorContextKey = requestedKey; context.eventEditorWindow.loadFile('frontend/event_editor.html'); context.eventEditorWindow.webContents.on('did-finish-load', () => { context.eventEditorWindow.webContents.send('load-event-data', eventData); }); context.eventEditorWindow.on('closed', () => { context.eventEditorWindow = null; context.eventEditorContextKey = null; if (context.calendarWindow && !context.calendarWindow.isDestroyed()) context.calendarWindow.webContents.send('refresh-events'); }); });
    ipcMain.on('open-audio-editor', (e, filePath) => { if (context.mainWindow && e.sender.id === context.mainWindow.webContents.id) context.lastEditorSource = 'playlist'; if (context.libraryWindow && e.sender.id === context.libraryWindow.webContents.id) context.lastEditorSource = 'library'; if (context.audioEditorWindow) { context.audioEditorWindow.focus(); context.audioEditorWindow.webContents.send('load-audio-file', filePath); } else { context.audioEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'editor.png')),   width: 1000, height: 600, title: 'Editor de Pistas Avanzado', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.audioEditorWindow.loadFile('frontend/audio_editor.html'); context.audioEditorWindow.webContents.on('did-finish-load', () => { context.audioEditorWindow.webContents.send('load-audio-file', filePath); }); context.audioEditorWindow.on('closed', () => { context.audioEditorWindow = null; if (context.mainWindow) context.mainWindow.webContents.send('refresh-manual-cues'); if(context.libraryWindow) context.libraryWindow.webContents.send('refresh-manual-cues'); }); } });

    ipcMain.on('open-calendar', () => {
        if (context.calendarWindow) { context.calendarWindow.focus(); return; }
        context.calendarWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'events.png')),  
            width: 1200, height: 750,
            minWidth: 1000, minHeight: 600,
            title: 'Calendario Semanal y Parrilla de Programación',
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        context.calendarWindow.loadFile('frontend/calendar.html');
        context.calendarWindow.on('closed', () => { context.calendarWindow = null; });
    });

    ipcMain.on('refresh-events-from-calendar', () => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('refresh-events');
        }
    });

    
    ipcMain.on('open-transition-editor', (e, data) => { 
        if (context.transitionEditorWindow) { context.transitionEditorWindow.focus(); return; }
        context.transitionEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'transition.png')),   width: 1000, height: 450, title: 'Editor de Transición Musical', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        context.transitionEditorWindow.loadFile('frontend/transition_editor.html');
        context.transitionEditorWindow.webContents.on('did-finish-load', () => { context.transitionEditorWindow.webContents.send('load-data', data); });
        context.transitionEditorWindow.on('closed', () => { context.transitionEditorWindow = null; });
    });
    
    ipcMain.on('open-jingle-editor', (e, data) => { 
        if (context.jingleEditorWindow) { context.jingleEditorWindow.focus(); return; }
        context.jingleEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'jingle.png')),   width: 1000, height: 600, title: 'Editor de Músicas y Pisadores', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        context.jingleEditorWindow.loadFile('frontend/jingle_editor.html');
        context.jingleEditorWindow.webContents.on('did-finish-load', () => { context.jingleEditorWindow.webContents.send('load-data', data); });
        context.jingleEditorWindow.on('closed', () => { context.jingleEditorWindow = null; });
    });
    
    ipcMain.on('save-transition', (e, result) => { if(context.mainWindow) context.mainWindow.webContents.send('apply-transition', result); if(context.transitionEditorWindow) context.transitionEditorWindow.close(); });
    ipcMain.on('save-jingle-transition', (e, result) => { if(context.mainWindow) context.mainWindow.webContents.send('apply-jingle-transition', result); if(context.jingleEditorWindow) context.jingleEditorWindow.close(); });
    
    ipcMain.on('editor-request-track', (e, data) => { if (context.lastEditorSource === 'library' && context.libraryWindow) { context.libraryWindow.webContents.send('editor-handle-request-track', data); } else if (context.mainWindow) { context.mainWindow.webContents.send('editor-handle-request-track', data); } });
    ipcMain.on('open-preview', (e, filePath) => { if (context.previewWindow) { context.previewWindow.focus(); context.previewWindow.webContents.send('load-preview-track', filePath); } else { const { height } = screen.getPrimaryDisplay().workAreaSize; context.previewWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'editor.png')),   width: 480, height: 200, x: 20, y: height - 220, title: 'Escucha previa', autoHideMenuBar: true, resizable: false, alwaysOnTop: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.previewWindow.loadFile('frontend/preview.html'); context.previewWindow.webContents.on('did-finish-load', () => { context.previewWindow.webContents.send('load-preview-track', filePath); }); context.previewWindow.on('closed', () => { context.previewWindow = null; }); } });
    const encoderPrefsPath = path.join(configDir, 'encoder_prefs.json');
    ipcMain.on('encoder-prefs-load-sync', event => {
        const result = loadEncoderPrefs({ filePath: encoderPrefsPath, safeStorage, fileSystem: fs });
        event.returnValue = result;
    });
    ipcMain.on('encoder-prefs-save', (event, prefs = {}) => {
        const result = saveEncoderPrefs({ filePath: encoderPrefsPath, prefs, safeStorage, fileSystem: fs });
        if (!result.success) writeLog(`No se pudo guardar la configuracion del encoder: ${result.error}`);
        if (result.warning || result.error) {
            event.sender.send('encoder-prefs-warning', result.warning || result.error);
        }
    });

    // Crea (o reutiliza) la ventana del encoder. `show` permite abrirla oculta
    // —útil para el auto-arranque del encoder en operación desatendida, donde la
    // ventana solo necesita existir para que su lógica de conexión/reconexión
    // corra; no hace falta mostrársela al operador—. `autoConnectMarked` pide a
    // la UI del encoder que conecte los servidores marcados como "auto-conectar".
    function openEncoderWindow({ show = true, autoConnectMarked = false } = {}) {
        if (context.encoderWindow) {
            if (show) {
                context.encoderWindow.show();
                context.encoderWindow.focus();
            }
            // La ventana ya está cargada: pedir la autoconexión directamente.
            if (autoConnectMarked && !context.encoderWindow.webContents.isLoading()) {
                context.encoderWindow.webContents.send('encoder-autoconnect-marked');
            }
            return;
        }
        context.encoderWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'encoder.png')),
            width: 480,
            height: 760,
            minWidth: 460,
            minHeight: 680,
            title: 'Emisor de Radio (Encoder)',
            autoHideMenuBar: true,
            resizable: true,
            show,
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        context.encoderWindow.loadFile('frontend/encoder.html');
        context.encoderWindow.webContents.on('did-finish-load', () => {
            // Enviar el estado actual de cada servidor para que la UI reabierta
            // refleje las transmisiones que siguen en vivo.
            const snapshot = [];
            for (const s of context.encoderServers.values()) {
                snapshot.push({ serverId: s.id, status: s.status || (s.proc ? 'connecting' : 'disconnected') });
            }
            context.encoderWindow.webContents.send('encoder-servers-snapshot', snapshot);
            if (autoConnectMarked) {
                context.encoderWindow.webContents.send('encoder-autoconnect-marked');
            }
        });
        context.encoderWindow.on('close', (e) => {
            if (!context.isAppQuitting && countLiveServers() > 0) {
                e.preventDefault();
                context.encoderWindow.hide();
            }
        });
        context.encoderWindow.on('closed', () => { context.encoderWindow = null; });
    }

    ipcMain.on('open-encoder', () => openEncoderWindow({ show: true }));

    // Disparado por el renderer cuando arranca la reproducción automática y el
    // operador activó "Iniciar el encoder al comenzar la reproducción
    // automática". Solo actúa si hay al menos un servidor marcado, para no abrir
    // una ventana oculta inútil.
    ipcMain.on('autoplay-start-encoders', () => {
        let anyMarked = false;
        try {
            const { prefs } = loadEncoderPrefs({ filePath: encoderPrefsPath, safeStorage, fileSystem: fs });
            anyMarked = Array.isArray(prefs.servers) && prefs.servers.some(s => s && s.autoConnect === true);
        } catch (_) { anyMarked = false; }
        if (!anyMarked) {
            try { writeLog('[AUTOPLAY] Encoder: ningún servidor está marcado para auto-conectar; se omite.'); } catch (_) {}
            return;
        }
        openEncoderWindow({ show: false, autoConnectMarked: true });
    });
    // Conecta un servidor a partir de su config cruda (resuelve contrato + arranca).
    async function connectOneFromConfig(id, rawConfig) {
        const normalized = normalizeEncoderConfig(rawConfig);
        const attempt = beginEncoderConnect(id, normalized);
        setServerStatus(id, 'connecting');
        try {
            return await startEncoderCapture(normalized, id, attempt);
        } finally {
            finishEncoderConnect(id, attempt);
            maybeStopEncoderInput();
        }
    }

    // start-encoder: acepta un ARRAY de configs (conectar todos / botón maestro) o
    // un único objeto (compatibilidad con el modo de un solo servidor). Cada config
    // puede traer su propio `serverId`; si no, se usa el índice.
    ipcMain.on('start-encoder', (e, payload) => {
        const list = Array.isArray(payload) ? payload : [payload];
        list.forEach((cfg, idx) => {
            const id = (cfg && (cfg.serverId !== undefined && cfg.serverId !== null)) ? cfg.serverId : idx;
            void connectOneFromConfig(id, cfg || {}).catch(err => emitEncoderError(id, err.message || err));
        });
    });

    // start-encoder-server: conecta/reconecta UN servidor individual (botón por
    // servidor o reconexión automática del frontend).
    ipcMain.on('start-encoder-server', (e, payload = {}) => {
        const id = (payload.serverId !== undefined && payload.serverId !== null) ? payload.serverId : '0';
        void connectOneFromConfig(id, payload).catch(err => emitEncoderError(id, err.message || err));
    });

    // stop-encoder-server: detiene UN servidor individual sin afectar a los demás.
    ipcMain.on('stop-encoder-server', (e, payload) => {
        const id = (payload && typeof payload === 'object') ? payload.serverId : payload;
        if (id === undefined || id === null) return;
        killEncoderServer(id, '');
    });

    // FIX: el operador conmutó Pre-FX / Post-FX desde la ventana del encoder.
    // Lo reenviamos al renderer principal para que actualice el `route` del
    // bus encoder al motor Rust en caliente (sin reiniciar el encoder).
    ipcMain.on('encoder-tap-point-changed', (e, payload = {}) => {
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('encoder-tap-point-changed', payload);
        }
    });
    
    ipcMain.on('update-metadata', async (e, metaText) => {
        const txtPath = path.join(configDir, 'NowPlaying.txt');
        rustManagedEncoderBridge.writeNowPlaying(metaText, txtPath)
            .catch(err => writeLog(`Rust NowPlaying: ${err.message || err}`));
        for (const server of context.encoderServers.values()) {
            if (!server.rustManaged || !server.config) continue;
            try {
                rustManagedEncoderBridge.updateMetadata(server.id, server.config, metaText, '')
                    .catch(err => writeLog(`Rust metadata [srv ${server.id}]: ${err.message || err}`));
            } catch(err) { writeLog(`Error preparando metadata remota [srv ${server.id}]: ` + err); }
        }
    });
    
    ipcMain.on('encoder-health', (e, report = {}) => {
        const reason = report.reason || 'report';
        if (reason === 'minute' || reason === 'stop' || reason === 'chunk-gap') {
            const parts = [
                `Encoder captura ${reason}`,
                `chunks=${report.chunks || 0}`,
                `MB=${(((report.bytes || 0) / 1048576) || 0).toFixed(2)}`
            ];
            if (Number.isFinite(report.maxGapMs)) parts.push(`maxGap=${Math.round(report.maxGapMs)}ms`);
            if (Number.isFinite(report.gapMs)) parts.push(`gap=${Math.round(report.gapMs)}ms`);
            if (Number.isFinite(report.expectedGapMs)) parts.push(`esperado=${Math.round(report.expectedGapMs)}ms`);
            if (Number.isFinite(report.gapWarnings)) parts.push(`avisos=${report.gapWarnings}`);
            writeLog(parts.join(' | '));
            if (context.encoderWindow && !context.encoderWindow.isDestroyed()) {
                context.encoderWindow.webContents.send('encoder-capture-health', report);
            }
            notifyRustEncoder('health', {
                ...(context.activeEncoderConfig || {}),
                maxGapMs: report.maxGapMs,
                gapWarnings: report.gapWarnings
            });
        }
    });

    ipcMain.on('audio-chunk', () => {
        writeLog('audio-chunk ignorado: la ruta renderer/FFmpeg del encoder fue retirada en Fase 1.');
    });
    // stop-encoder: detiene TODOS los servidores (botón "Desconectar todo" /
    // parada general). El stop individual usa stop-encoder-server.
    ipcMain.on('stop-encoder', () => {
        killAllEncoderServers('');
        context.activeEncoderConfig = null;
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('stop-audio-capture');
            context.mainWindow.webContents.send('encoder-global-status', 'disconnected');
        }
    });
    ipcMain.on('emergency-stop-playback', () => {
        writeLog('Parada de reproduccion recibida. Encoder permanece activo.');
    });

    // ── Atajos de teclado personalizables ────────────────────────────────────
    const _db = require('../../database');

    ipcMain.handle('get-keyboard-shortcuts', () => {
        try {
            const row = _db.prepare("SELECT value FROM app_settings WHERE key = 'keyboard_shortcuts'").get();
            return row ? JSON.parse(row.value || '{}') : {};
        } catch (e) {
            return {};
        }
    });

    ipcMain.handle('save-keyboard-shortcuts', (e, shortcutsObj) => {
        try {
            if (typeof shortcutsObj !== 'object' || shortcutsObj === null) return { ok: false };
            const now = new Date().toISOString();
            _db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('keyboard_shortcuts', ?, ?)")
               .run(JSON.stringify(shortcutsObj), now);
            const payload = { shortcutsChanged: true, shortcuts: shortcutsObj };
            if (context.mainWindow && !context.mainWindow.isDestroyed())
                context.mainWindow.webContents.send('shortcuts-updated', payload);
            if (context.cartwallWindow && !context.cartwallWindow.isDestroyed())
                context.cartwallWindow.webContents.send('shortcuts-updated', payload);
            if (context.rebuildNativeMenu) context.rebuildNativeMenu(shortcutsObj);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
};
