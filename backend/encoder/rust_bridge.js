'use strict';

function createRustManagedEncoderBridge({
    context,
    writeLog,
    ffmpegPath,
    ffmpegFdkPath,
    fdkAvailable,
    normalizeEncoderConfig,
    countLiveServers,
    getEncoderServer,
    setServerStatus,
    emitEncoderError,
    notifyRustEncoder,
    killEncoderServer,
    } = {}) {
    const CONNECT_TIMEOUT_MS = 20000;

    function clearConnectTimer(server) {
        if (server?.connectTimer) {
            clearTimeout(server.connectTimer);
            server.connectTimer = null;
        }
    }

    function findRustServerSnapshot(id) {
        const sid = String(id);
        const list = context?.rustAudioEngine?.lastStatus?.encoderServers;
        return Array.isArray(list) ? list.find(item => String(item.serverId) === sid) : null;
    }

    function armConnectTimeout(id, config) {
        const sid = String(id);
        const server = getEncoderServer(sid);
        clearConnectTimer(server);
        if (!server) return;
        server.connectTimer = setTimeout(() => {
            const current = getEncoderServer(sid);
            if (!current?.rustManaged) return;
            const rustServer = findRustServerSnapshot(sid);
            if (rustServer?.status === 'live') {
                setServerStatus(sid, 'live');
                clearConnectTimer(current);
                return;
            }
            if (!rustServer) {
                setServerStatus(sid, 'disconnected');
                clearConnectTimer(current);
                return;
            }
            const label = (config?.serverType || current.config?.serverType || 'icecast').toUpperCase();
            const message = `Timeout conectando ${label}: FFmpeg recibe PCM pero no confirma transmision. Revisa host, puerto, usuario, clave y mount/SID.`;
            writeLog(`Encoder ${label} Rust [srv ${sid}] timeout. pcmBytes=${rustServer.pcmBytes || 0}, chunks=${rustServer.pcmChunks || 0}`);
            notifyRustEncoder('stop', config || current.config || {});
            killEncoderServer(sid, message, {
                details: { category: 'network', retryable: true }
            });
        }, CONNECT_TIMEOUT_MS);
        server.connectTimer.unref?.();
    }

    async function ensureInput(config) {
        const engine = context?.rustAudioEngine;
        if (!engine || typeof engine.command !== 'function') {
            return { success: false, error: 'Motor Rust no disponible para encoder.' };
        }
        const sampleRate = Math.max(8000, Math.min(192000, parseInt(config.sampleRate, 10) || 44100));
        const resolved = {
            ...config,
            source: config.source === 'mic' ? 'mic' : 'master',
            tapPoint: config.tapPoint === 'preFx' ? 'preFx' : 'postFx',
            captureFormat: 'pcm_s16le',
            sampleRate,
        };
        if (resolved.source === 'mic') {
            const deviceId = String(config.sourceId || config.micId || config.mic || config.deviceId || 'default').trim() || 'default';
            resolved.sourceId = deviceId;
            resolved.deviceId = deviceId;
            context.activeEncoderConfig = resolved;
            return { success: true, config: resolved };
        }
        context.activeEncoderConfig = resolved;
        const tapAck = await engine.command({ cmd: 'encoderTap', enable: true }, 5000);
        if (!tapAck?.success) {
            return { success: false, error: tapAck?.error || 'RustAudio no activo el tap PCM del encoder.' };
        }
        const tap = tapAck.message?.encoder?.tap;
        if (!tap?.active || !tap?.ready) {
            return { success: false, error: 'RustAudio confirmo el tap, pero no esta listo para alimentar el encoder.' };
        }
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('start-rust-pcm-encoder-sync', resolved);
        }
        return { success: true, config: resolved };
    }

    function buildCommand(id, config = {}, cmd = 'startIcecast') {
        const selectedFfmpegPath = config.codec === 'aac_he' ? ffmpegFdkPath : ffmpegPath;
        return {
            module: 'encoder',
            cmd,
            serverId: String(id),
            serverType: config.serverType || config.type || 'icecast',
            ip: config.ip || '',
            port: config.port || '',
            adminPort: config.adminPort || '',
            user: config.user || config.username || 'source',
            password: config.password || config.pass || '',
            mount: config.mount || '',
            codec: config.codec || 'mp3',
            bitrate: config.bitrate || '128',
            legacy: config.legacy === true,
            icyName: config.icyName || config.name || 'Radio',
            icyGenre: config.icyGenre || 'Variado',
            icyUrl: config.icyUrl || 'http://',
            icyPublic: config.icyPublic !== false,
            fdkAvailable: fdkAvailable === true,
            ffmpegPath: selectedFfmpegPath || 'ffmpeg',
            source: config.source === 'mic' ? 'mic' : 'master',
            sourceId: config.sourceId || config.deviceId || config.micId || config.mic || '',
            deviceId: config.deviceId || config.sourceId || config.micId || config.mic || '',
            captureFormat: config.captureFormat || 'pcm_s16le',
            sampleRate: Number(config.sampleRate) || 44100,
            _timeoutMs: cmd === 'startShoutcast' ? 12000 : 5000
        };
    }

    async function stopServer(id) {
        clearConnectTimer(getEncoderServer(id));
        const engine = context?.rustAudioEngine;
        if (!engine || typeof engine.command !== 'function') return { success: true, skipped: true };
        return engine.command({
            module: 'encoder',
            cmd: 'stopServer',
            serverId: String(id),
            _timeoutMs: 3000
        }, 3000);
    }

    async function updateMetadata(id, rawConfig = {}, text = '', nowPlayingPath = '') {
        const engine = context?.rustAudioEngine;
        if (!engine || typeof engine.command !== 'function') {
            return { success: false, error: 'Motor Rust no disponible para metadata del encoder.' };
        }
        const config = normalizeEncoderConfig(rawConfig);
        const command = buildCommand(id, config, 'updateMetadata');
        command.message = String(text || '');
        command.path = nowPlayingPath || '';
        command._timeoutMs = 6000;
        const result = await engine.command(command, 6000);
        if (!result?.success) {
            return { success: false, error: result?.error || 'RustAudio no pudo actualizar metadata.' };
        }
        return { success: true, response: result.message };
    }

    async function writeNowPlaying(text = '', nowPlayingPath = '') {
        const engine = context?.rustAudioEngine;
        if (!engine || typeof engine.command !== 'function') {
            return { success: false, error: 'Motor Rust no disponible para NowPlaying.' };
        }
        const result = await engine.command({
            module: 'encoder',
            cmd: 'updateMetadata',
            message: String(text || ''),
            path: nowPlayingPath || '',
            _timeoutMs: 3000
        }, 3000);
        if (!result?.success) {
            return { success: false, error: result?.error || 'RustAudio no pudo escribir NowPlaying.' };
        }
        return { success: true, response: result.message };
    }

    async function startIcecast(id, rawConfig = {}) {
        const sid = String(id);
        const config = normalizeEncoderConfig(rawConfig);
        if (config.serverType !== 'icecast') {
            return { success: false, skipped: true, error: 'El puente Rust solo maneja Icecast.' };
        }
        if (config.codec === 'aac_he' && fdkAvailable !== true) {
            const message = 'AAC+ / HE-AAC requiere LF_FFMPEG_FDK_PATH con un FFmpeg externo autorizado que incluya libfdk_aac.';
            emitEncoderError(sid, message, { category: 'codec', retryable: false });
            return { success: false, error: message };
        }

        const existing = getEncoderServer(sid);
        if (existing?.rustManaged) await stopServer(sid);
        else if (existing?.proc) {
            clearConnectTimer(existing);
            killEncoderServer(sid, '', { suppressStatus: true, suppressError: true });
        }

        const input = await ensureInput(config);
        if (!input.success) return input;

        notifyRustEncoder('start', input.config || config);
        const result = await context.rustAudioEngine.command(buildCommand(sid, input.config || config), 5000);
        if (!result?.success) {
            notifyRustEncoder('stop', input.config || config);
            return { success: false, error: result?.error || 'RustAudio no pudo iniciar Icecast.' };
        }
        const server = existing || { id: sid };
        server.id = sid;
        server.config = input.config || config;
        server.proc = null;
        server.waitingDrain = false;
        server.rustManaged = true;
        context.encoderServers.set(sid, server);
        setServerStatus(sid, 'connecting');
        armConnectTimeout(sid, input.config || config);
        writeLog(`Encoder Icecast Rust [srv ${sid}] iniciado. Codec: ${(config.codec || 'mp3').toUpperCase()} ${config.bitrate || 128}kbps.`);
        return { success: true, rustManaged: true, response: result.message };
    }

    async function startShoutcast(id, rawConfig = {}) {
        const sid = String(id);
        const config = normalizeEncoderConfig(rawConfig);
        if (!['shoutcast', 'shoutcast2'].includes(config.serverType)) {
            return { success: false, skipped: true, error: 'El puente Rust solo maneja SHOUTcast.' };
        }
        if (config.codec === 'aac_he' && fdkAvailable !== true) {
            const message = 'AAC+ / HE-AAC requiere LF_FFMPEG_FDK_PATH con un FFmpeg externo autorizado que incluya libfdk_aac.';
            emitEncoderError(sid, message, { category: 'codec', retryable: false });
            return { success: false, error: message };
        }

        const existing = getEncoderServer(sid);
        if (existing?.rustManaged) await stopServer(sid);
        else if (existing?.proc) {
            clearConnectTimer(existing);
            killEncoderServer(sid, '', { suppressStatus: true, suppressError: true });
        }

        const input = await ensureInput(config);
        if (!input.success) return input;

        notifyRustEncoder('start', input.config || config);
        const result = await context.rustAudioEngine.command(buildCommand(sid, input.config || config, 'startShoutcast'), 12000);
        if (!result?.success) {
            notifyRustEncoder('stop', input.config || config);
            return { success: false, error: result?.error || 'RustAudio no pudo iniciar SHOUTcast.' };
        }
        const server = existing || { id: sid };
        server.id = sid;
        server.config = input.config || config;
        server.proc = null;
        server.waitingDrain = false;
        server.rustManaged = true;
        context.encoderServers.set(sid, server);
        setServerStatus(sid, 'connecting');
        armConnectTimeout(sid, input.config || config);
        writeLog(`Encoder SHOUTcast Rust [srv ${sid}] iniciado. Codec: ${(config.codec || 'mp3').toUpperCase()} ${config.bitrate || 128}kbps.`);
        return { success: true, rustManaged: true, response: result.message };
    }

    return {
        buildCommand,
        ensureInput,
        startIcecast,
        startShoutcast,
        stopServer,
        updateMetadata,
        writeNowPlaying,
    };
}

module.exports = {
    createRustManagedEncoderBridge,
};
