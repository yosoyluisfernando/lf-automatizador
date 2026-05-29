const AUDIO_ENGINE_COMMANDS = Object.freeze([
    'load',
    'play',
    'pause',
    'stop',
    'seek',
    'fade',
    'setGain',
    'route',
    'fx',
    'nowPlaying',
    'transport',
    'repeat',
    'playlistSnapshot',
    'playlistMode',
    'playlistPlaybackContext',
    'playlistFinished',
    'playlistManualNext',
    'cartwallPlay',
    'cartwallStop',
    'startEncoder',
    'stopEncoder',
    'timeLocution',
    'masterGain',
    'monitorGain'
]);

function normalizeEngineMode(mode) {
    return mode === 'rustAudio' ? 'rustAudio' : 'webAudio';
}

function createEmptyDiagnostics(mode = 'webAudio') {
    return {
        mode: normalizeEngineMode(mode),
        fallbackMode: 'webAudio',
        adapter: 'WebAudioEngineAdapter',
        rustAvailable: false,
        commandContract: AUDIO_ENGINE_COMMANDS,
        players: [],
        mix: {
            phase: 'idle',
            active: false,
            referencePlayer: '',
            fadingPlayer: '',
            direction: '',
            audibleCount: 0,
            driftReferencePlayer: '',
            shouldIgnoreDrift: false,
            players: []
        },
        overlays: {
            active: false,
            activePisadores: 0,
            overlayDrops: 0,
            timeLocutionActive: false,
            cartwallActive: false,
            cartwallCount: 0,
            cartwallMode: 'master',
            duckingGain: 1,
            lastTrigger: null
        },
        buses: [],
        devices: {},
        latency: {
            masterMs: 0,
            monitorMs: null,
            cueMs: null,
            note: ''
        },
            encoder: {
                active: false,
                source: 'master',
                owner: 'rustAudioEngine',
                requestedOwner: 'rustAudioEngine',
                captureProvider: 'rustAudioEngine',
                encoderProvider: 'auto',
                rustPcmReady: false,
                pcmBridgeReady: false,
                pcmBridgeMode: 'planned',
                pcmBridgeReason: '',
                fallbackReason: '',
                captureFormat: 'pcm_s16le',
                sampleRate: 0,
            transport: 'ffmpeg-rust-pcm-tap'
        },
        warnings: [],
        updatedAt: Date.now()
    };
}

class WebAudioEngineAdapter {
    constructor({ getState, onCommand } = {}) {
        this.mode = 'webAudio';
        this.getState = typeof getState === 'function' ? getState : () => ({});
        this.onCommand = typeof onCommand === 'function' ? onCommand : null;
    }

    command(type, payload = {}) {
        if (!AUDIO_ENGINE_COMMANDS.includes(type)) {
            return { ok: false, error: `Comando de audio no soportado: ${type}` };
        }
        if (this.onCommand) return this.onCommand(type, payload);
        return { ok: true, handledBy: this.mode, type };
    }

    getDiagnostics() {
        return {
            ...createEmptyDiagnostics(this.mode),
            ...this.getState(),
            mode: this.mode,
            adapter: 'WebAudioEngineAdapter',
            rustAvailable: false,
            updatedAt: Date.now()
        };
    }
}

class RustAudioEngineAdapter {
    constructor({ ipcRenderer, getState, fallbackAdapter } = {}) {
        this.mode = 'rustAudio';
        this.ipcRenderer = ipcRenderer || null;
        this.getState = typeof getState === 'function' ? getState : () => ({});
        this.fallbackAdapter = fallbackAdapter || null;
        this.lastCommand = null;
        this.lastError = '';
    }

    command(type, payload = {}) {
        if (!AUDIO_ENGINE_COMMANDS.includes(type)) {
            return Promise.resolve({ ok: false, error: `Comando de audio no soportado: ${type}` });
        }
        if (!this.ipcRenderer?.invoke) {
            return Promise.resolve({ ok: false, error: 'IPC RustAudio no disponible.' });
        }

        const command = this.toRustCommand(type, payload);
        if (!command) {
            const fallbackResult = this.fallbackAdapter?.command(type, payload);
            return Promise.resolve(fallbackResult || { ok: false, error: `RustAudio aun no implementa ${type}` });
        }

        this.lastCommand = { type, command, at: Date.now() };
        return this.ipcRenderer.invoke('audio-engine-rust-command', command)
            .then(result => {
                if (result?.success !== true) {
                    this.lastError = result?.error || 'RustAudio no pudo ejecutar comando.';
                    return { ok: false, handledBy: this.mode, type, error: this.lastError, result };
                }
                this.lastError = '';
                return { ok: true, handledBy: this.mode, type, result };
            })
            .catch(err => {
                this.lastError = err.message || String(err);
                return { ok: false, handledBy: this.mode, type, error: this.lastError };
            });
    }

    toRustCommand(type, payload = {}) {
        const player = payload.player || payload.playerId || payload.id || 'player-a';
        switch (type) {
            case 'route':
                return {
                    cmd: 'route',
                    bus: payload.bus || payload.id || 'master',
                    outputId: payload.outputId || payload.deviceId || 'default',
                    sourceMode: payload.sourceMode || payload.monitorSourceMode || ''
                };
            case 'fx':
                return {
                    cmd: 'fx',
                    eq: payload.eq === true,
                    comp: payload.comp === true,
                    limiter: payload.limiter === true,
                    preampDb: payload.preampDb ?? payload.preamp ?? 0,
                    pan: payload.pan ?? 0,
                    mono: payload.mono === true,
                    bands: Array.isArray(payload.bands) ? payload.bands : [],
                    order: Array.isArray(payload.order) ? payload.order : []
                };
            case 'nowPlaying':
                return {
                    cmd: 'nowPlaying',
                    title: payload.title || '',
                    artist: payload.artist || '',
                    path: payload.path || '',
                    player: payload.player || '',
                    source: payload.source || 'renderer'
                };
            case 'transport':
                return {
                    cmd: 'transport',
                    player: payload.player || '',
                    status: payload.status || 'unknown',
                    positionMs: payload.positionMs ?? 0,
                    durationMs: payload.durationMs ?? 0,
                    startCause: payload.startCause || '',
                    mixActive: payload.mixActive === true,
                    mixPhase: payload.mixPhase || '',
                    mixDirection: payload.mixDirection || '',
                    mixReferencePlayer: payload.mixReferencePlayer || payload.player || ''
                };
            case 'repeat':
                return {
                    cmd: 'repeat',
                    player,
                    enabled: payload.enabled === true,
                    startMs: payload.startMs ?? payload.positionMs ?? 0
                };
            case 'playlistSnapshot':
                return {
                    cmd: 'playlistSnapshot',
                    rows: Array.isArray(payload.rows) ? payload.rows : []
                };
            case 'playlistMode':
                return {
                    cmd: 'playlistMode',
                    repeatTrack: payload.repeatTrack === true,
                    removePlayed: payload.removePlayed === true,
                    loopPlaylist: payload.loopPlaylist === true,
                    repeatForgetProtectionEnabled: payload.repeatForgetProtectionEnabled === true,
                    repeatForgetProtectionMax: payload.repeatForgetProtectionMax ?? 10,
                    repeatDisableOnManualNext: payload.repeatDisableOnManualNext !== false,
                    removePlayedProtectionEnabled: payload.removePlayedProtectionEnabled === true,
                    removePlayedProtectionMinRemaining: payload.removePlayedProtectionMinRemaining ?? 2
                };
            case 'playlistPlaybackContext':
                return {
                    cmd: 'playlistPlaybackContext',
                    currentRowId: payload.currentRowId || '',
                    currentPlayer: payload.currentPlayer || payload.player || '',
                    queuedRowId: payload.queuedRowId || '',
                    pgmTab: payload.pgmTab ?? 0
                };
            case 'playlistFinished':
                return {
                    cmd: 'playlistFinished',
                    currentRowId: payload.currentRowId || '',
                    currentPlayer: payload.currentPlayer || payload.player || '',
                    queuedRowId: payload.queuedRowId || '',
                    pgmTab: payload.pgmTab ?? 0
                };
            case 'playlistManualNext':
                return {
                    cmd: 'playlistManualNext',
                    currentRowId: payload.currentRowId || '',
                    currentPlayer: payload.currentPlayer || payload.player || '',
                    queuedRowId: payload.queuedRowId || '',
                    pgmTab: payload.pgmTab ?? 0
                };
            case 'load':
                return {
                    cmd: payload.path ? 'loadAudio' : 'load',
                    player,
                    bus: payload.bus || '',
                    path: payload.path || '',
                    outputId: payload.outputId || payload.deviceId || 'default',
                    gain: payload.gain,
                    autoplay: payload.autoplay === true,
                    cacheDir: payload.cacheDir || ''
                };
            case 'play':
            case 'pause':
            case 'stop':
                return { cmd: type, player };
            case 'seek':
                return { cmd: 'seek', player, positionMs: payload.positionMs ?? payload.ms ?? 0 };
            case 'setGain':
                return { cmd: 'setGain', player, gain: payload.gain ?? payload.value ?? 1 };
            case 'fade':
                return {
                    cmd: 'fade',
                    player,
                    fromGain: payload.fromGain ?? payload.from ?? undefined,
                    toGain: payload.toGain ?? payload.to ?? payload.gain ?? payload.value ?? 1,
                    durationMs: payload.durationMs ?? payload.ms ?? Math.round((Number(payload.seconds) || 0) * 1000),
                    stopAfter: payload.stopAfter === true
                };
            case 'cartwallPlay':
                return {
                    cmd: 'loadAudio',
                    player: payload.player || payload.playerId || payload.id || `cartwall-${Date.now()}`,
                    bus: payload.bus || 'cartwall',
                    path: payload.path || payload.file || '',
                    outputId: payload.outputId || payload.deviceId || 'default',
                    gain: payload.gain ?? payload.volume ?? 1,
                    autoplay: payload.autoplay !== false,
                    cacheDir: payload.cacheDir || ''
                };
            case 'cartwallStop':
                return {
                    cmd: 'stop',
                    player: payload.player || payload.playerId || payload.id || 'cartwall'
                };
            case 'startEncoder':
                const startEncoderIsMic = (payload.source || payload.sourceBus) === 'mic';
                const startEncoderOwner = startEncoderIsMic ? 'mediaInputRenderer' : 'rustAudioEngine';
                return {
                    cmd: 'encoder',
                    action: 'start',
                    source: payload.source || payload.sourceBus || 'master',
                    owner: payload.owner || startEncoderOwner,
                    requestedOwner: payload.requestedOwner || payload.owner || startEncoderOwner,
                    captureProvider: payload.captureProvider || payload.owner || startEncoderOwner,
                    encoderProvider: payload.encoderProvider || 'auto',
                    rustPcmReady: payload.rustPcmReady === true,
                    pcmBridgeReady: payload.pcmBridgeReady === true,
                    pcmBridgeMode: payload.pcmBridgeMode || 'planned',
                    pcmBridgeReason: payload.pcmBridgeReason || '',
                    fallbackReason: payload.fallbackReason || '',
                    captureFormat: payload.captureFormat || 'pcm_s16le',
                    sampleRate: payload.sampleRate || 0,
                    transport: payload.transport || (startEncoderIsMic ? 'ffmpeg' : 'ffmpeg-rust-pcm-tap')
                };
            case 'timeLocution':
                // Locución horaria delegada 100% al motor Rust: el frontend solo
                // pasa carpeta, bus y player; Rust lee el reloj, resuelve los
                // archivos y los encadena. Emite evento async `timeLocutionEnded`.
                // `player` permite que la locución salga por player-a/player-b en
                // el bus de programa (pl1-pl4) cuando se dispara desde la playlist,
                // o por 'time-locucion' en el bus 'jingle' cuando es manual.
                return {
                    cmd: 'timeLocution',
                    player: payload.player || 'time-locucion',
                    folder: payload.folder || '',
                    bus: payload.bus || 'jingle',
                    gain: payload.gain ?? 1,
                    outputId: payload.outputId || payload.deviceId || 'default',
                    cacheDir: payload.cacheDir || ''
                };
            case 'cacheDuration':
                // Warm-up: lista de archivos de locución a medir y cachear (.dur)
                // sin reproducir. El motor los procesa en un hilo aparte.
                return {
                    cmd: 'cacheDuration',
                    paths: Array.isArray(payload.paths) ? payload.paths : [],
                    cacheDir: payload.cacheDir || ''
                };
            case 'cartwallSequence':
                // Cartwall: locución de hora gapless. El motor encadena todos los
                // archivos (HORAS+MINUTOS) en un único player con append.
                return {
                    cmd: 'cartwallSequence',
                    player: payload.player || payload.playerId || payload.id || `cartwall-${Date.now()}`,
                    bus: payload.bus || 'cartwall',
                    paths: Array.isArray(payload.paths) ? payload.paths : [],
                    outputId: payload.outputId || payload.deviceId || 'default',
                    gain: payload.gain ?? payload.volume ?? 1,
                    cacheDir: payload.cacheDir || ''
                };
            case 'masterGain':
                return { cmd: 'masterGain', gain: payload.gain ?? 1.0 };
            case 'monitorGain':
                return { cmd: 'monitorGain', gain: payload.gain ?? 1.0 };
            case 'stopEncoder':
                const stopEncoderIsMic = (payload.source || payload.sourceBus) === 'mic';
                const stopEncoderOwner = stopEncoderIsMic ? 'mediaInputRenderer' : 'rustAudioEngine';
                return {
                    cmd: 'encoder',
                    action: 'stop',
                    source: payload.source || payload.sourceBus || 'master',
                    owner: payload.owner || stopEncoderOwner,
                    requestedOwner: payload.requestedOwner || payload.owner || stopEncoderOwner,
                    captureProvider: payload.captureProvider || payload.owner || stopEncoderOwner,
                    encoderProvider: payload.encoderProvider || 'auto',
                    rustPcmReady: payload.rustPcmReady === true,
                    pcmBridgeReady: payload.pcmBridgeReady === true,
                    pcmBridgeMode: payload.pcmBridgeMode || 'planned',
                    pcmBridgeReason: payload.pcmBridgeReason || '',
                    fallbackReason: payload.fallbackReason || '',
                    captureFormat: payload.captureFormat || 'pcm_s16le',
                    sampleRate: payload.sampleRate || 0,
                    transport: payload.transport || (stopEncoderIsMic ? 'ffmpeg' : 'ffmpeg-rust-pcm-tap')
                };
            default:
                return null;
        }
    }

    getDiagnostics() {
        return {
            ...createEmptyDiagnostics(this.mode),
            ...this.getState(),
            mode: this.mode,
            adapter: 'RustAudioEngineAdapter',
            rustAvailable: true,
            lastCommand: this.lastCommand,
            lastError: this.lastError,
            updatedAt: Date.now()
        };
    }
}

class AudioEngineClient {
    constructor({ mode = 'webAudio', adapter, fallbackAdapter } = {}) {
        this.requestedMode = normalizeEngineMode(mode);
        this.fallbackAdapter = fallbackAdapter || adapter || new WebAudioEngineAdapter();
        this.adapter = adapter || this.fallbackAdapter;
        this.adapters = { [this.adapter.mode || 'webAudio']: this.adapter };
        if (this.fallbackAdapter) this.adapters[this.fallbackAdapter.mode || 'webAudio'] = this.fallbackAdapter;
        this.applyRequestedMode();
    }

    setRequestedMode(mode) {
        this.requestedMode = normalizeEngineMode(mode);
        this.applyRequestedMode();
    }

    registerAdapter(mode, adapter) {
        if (!adapter) return;
        this.adapters[normalizeEngineMode(mode)] = adapter;
        this.applyRequestedMode();
    }

    applyRequestedMode() {
        this.adapter = this.adapters[this.requestedMode] || this.fallbackAdapter || this.adapter;
    }

    command(type, payload = {}) {
        return this.adapter.command(type, payload);
    }

    getDiagnostics() {
        const diagnostics = this.adapter.getDiagnostics();
        const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [];
        if (this.requestedMode === 'rustAudio' && diagnostics.mode !== 'rustAudio') {
            warnings.push('rustAudio solicitado, usando fallback webAudio hasta que el motor nativo este disponible.');
        }
        return {
            ...diagnostics,
            requestedMode: this.requestedMode,
            activeMode: diagnostics.mode || 'webAudio',
            fallbackMode: 'webAudio',
            warnings
        };
    }
}

module.exports = {
    AUDIO_ENGINE_COMMANDS,
    AudioEngineClient,
    WebAudioEngineAdapter,
    RustAudioEngineAdapter,
    createEmptyDiagnostics,
    normalizeEngineMode
};
