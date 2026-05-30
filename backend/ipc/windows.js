// FASE D · sub-paso 8.2 — Encoder ahora va por `engine.attachPcmConsumer`
// (modo tap nativo desde el motor Rust). Los antiguos `RustPcmBridgeEncoderSource`
// y `runRustPcmBridgeFfmpegSmokeTest` eran código muerto que nunca se llegó
// a implementar — eliminados de los imports.

module.exports = function(context) {
    const { ipcMain, dialog, screen, openCommercialManagerWindow, BrowserWindow, writeLog, path, configDir, fs, cp, ffmpegPath } = context;

    // Detectar soporte de libfdk_aac en el FFmpeg empaquetado (fire-and-forget al
    // inicio del módulo). El resultado se cachea en _fdkAacAvailable y se usa en
    // buildCodecArgs() sin añadir async al path de encodificación.
    // En builds estándar (ffmpeg-static / gyan.dev GPL) siempre será false porque
    // libfdk_aac es non-free y no se incluye. Si el operador sustituye el binario
    // por uno compilado con --enable-libfdk_aac, el probe lo detecta y habilita
    // HE-AAC real automáticamente.
    let _fdkAacAvailable = null;
    (function probeFdkAac() {
        try {
            const probe = cp.spawn(ffmpegPath, ['-encoders'], { windowsHide: true });
            let out = '';
            if (probe.stdout) probe.stdout.on('data', d => { out += d.toString(); });
            if (probe.stderr) probe.stderr.on('data', d => { out += d.toString(); });
            probe.on('close', () => { _fdkAacAvailable = out.includes('libfdk_aac'); });
            probe.on('error', () => { _fdkAacAvailable = false; });
        } catch (_) { _fdkAacAvailable = false; }
    }());

    // ── Registro multi-servidor del encoder ──────────────────────────────────
    // Cada servidor de streaming tiene su propio proceso FFmpeg, alimentado por
    // UNA sola fuente PCM compartida (el tap del motor Rust). El registro mapea
    // serverId -> runtime del servidor.
    if (!context.encoderServers) context.encoderServers = new Map();

    function getEncoderServer(id) { return context.encoderServers.get(String(id)); }
    function countLiveServers() {
        let n = 0;
        for (const s of context.encoderServers.values()) if (s.proc) n++;
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

    function readAudioEngineMode() {
        try {
            const prefsPath = path.join(configDir, 'general_settings.json');
            const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
            return prefs.audioEngineMode || 'webAudio';
        } catch (err) {
            return 'webAudio';
        }
    }

    function getRustPcmReadiness() {
        const encoder = context.rustAudioEngine?.lastStatus?.encoder || {};
        const nativeTapReady = !!(
            context.rustAudioEngine?.isRunning?.()
            && typeof context.rustAudioEngine?.attachPcmConsumer === 'function'
        );
        const ready = nativeTapReady
            || encoder.pcmBridgeReady === true
            || (encoder.rustPcmReady === true
                && (encoder.owner === 'rustAudioEngine' || encoder.captureProvider === 'rustAudioEngine'));
        return {
            ready,
            reason: ready ? '' : (encoder.pcmBridgeReason || encoder.fallbackReason || 'rust-master-pcm-pending'),
            bridgeMode: nativeTapReady ? 'native-tap' : (encoder.pcmBridgeMode || 'planned'),
            captureFormat: encoder.captureFormat || 'pcm_s16le',
            sampleRate: Number(encoder.sampleRate) || 44100,
            transport: nativeTapReady ? 'ffmpeg-rust-pcm-tap' : (encoder.transport || 'ffmpeg-rust-pcm-tap')
        };
    }

    function resolveEncoderProvider(_value, isMaster) {
        if (!isMaster) return 'mediaInputRenderer';
        return 'rustAudioEngine';
    }

    function buildEncoderSourceContract(config = {}, active = false) {
        const normalized = normalizeEncoderConfig(config || context.activeEncoderConfig || {});
        const isMaster = normalized.source !== 'mic';
        const requestedOwner = resolveEncoderProvider(normalized.encoderProvider, isMaster);
        const rustPcm = getRustPcmReadiness();
        const explicitRustReady = config.pcmBridgeReady === true
            || config.rustPcmReady === true
            || config.transport === 'ffmpeg-rust-pcm-tap';
        const rustPcmReady = isMaster && requestedOwner === 'rustAudioEngine' && (explicitRustReady || rustPcm.ready);
        const owner = isMaster ? 'rustAudioEngine' : 'mediaInputRenderer';
        const fallbackReason = isMaster && !rustPcmReady ? rustPcm.reason : '';
        const pcmBridgeMode = isMaster ? (config.pcmBridgeMode || rustPcm.bridgeMode) : '';
        const pcmBridgeReason = isMaster && !rustPcmReady ? rustPcm.reason : '';
        const transport = isMaster
            ? (config.transport || rustPcm.transport || 'ffmpeg-rust-pcm-tap')
            : 'ffmpeg';
        return {
            active: !!active,
            source: isMaster ? 'master' : 'mic',
            owner,
            requestedOwner,
            captureProvider: owner,
            encoderProvider: normalized.encoderProvider,
            tapPoint: normalized.tapPoint,
            rustPcmReady,
            pcmBridgeReady: rustPcmReady,
            pcmBridgeMode,
            pcmBridgeReason,
            fallbackReason,
            captureFormat: config.captureFormat || (isMaster ? 'pcm_s16le' : 'webm-opus'),
            sampleRate: Number(config.sampleRate) || (isMaster ? rustPcm.sampleRate : 0),
            transport
        };
    }

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
        if (action === 'start') context.lastRustEncoderStopAt = 0;
        if (action === 'stop') {
            if (context.lastRustEncoderStopAt && now - context.lastRustEncoderStopAt < 5000) return;
            context.lastRustEncoderStopAt = now;
        }
        if (previous.signature === signature) return;
        if (healthOnly && context.lastRustEncoderHealthAt && now - context.lastRustEncoderHealthAt < 15000) {
            context.encoderSourceContract = { ...previous, ...contract, ...health, active: previous.active === true, signature };
            return;
        }
        if (healthOnly) context.lastRustEncoderHealthAt = now;
        context.encoderSourceContract = { ...contract, ...health, active: healthOnly ? previous.active === true : contract.active, signature };
        if (!context.rustAudioEngine?.command) return;
        context.rustAudioEngine.command({
            cmd: 'encoder',
            action: healthOnly ? 'status' : action,
            source: contract.source,
            owner: contract.owner,
            requestedOwner: contract.requestedOwner,
            captureProvider: contract.captureProvider,
            encoderProvider: contract.encoderProvider,
            tapPoint: contract.tapPoint,
            rustPcmReady: contract.rustPcmReady,
            pcmBridgeReady: contract.pcmBridgeReady,
            pcmBridgeMode: contract.pcmBridgeMode,
            pcmBridgeReason: contract.pcmBridgeReason,
            fallbackReason: contract.fallbackReason,
            captureFormat: contract.captureFormat,
            sampleRate: contract.sampleRate,
            transport: contract.transport,
            bitrateKbps: health.bitrateKbps,
            speed: health.speed,
            ffmpegTime: health.ffmpegTime,
            maxGapMs: health.maxGapMs,
            gapWarnings: health.gapWarnings
        }).catch(err => writeLog(`RustAudio encoder ${action}: ${err.message || err}`));
    }

    // Detiene la fuente PCM compartida y la captura SOLO si ya no queda ningún
    // servidor con proceso vivo. Llamar tras matar un servidor.
    function maybeStopEncoderInput(options = {}) {
        if (countLiveServers() > 0) return;
        logEncoderWriteStats('stop');
        stopRustPcmEncoderSource();
        notifyRustEncoder('stop', context.encoderSourceContract || context.activeEncoderConfig || {});
        if (!options.suppressStopCapture && context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('stop-audio-capture');
        }
    }

    // Mata el proceso FFmpeg de UN servidor (sin afectar a los demás).
    function killEncoderServer(id, reason = '', options = {}) {
        const server = getEncoderServer(id);
        if (!server) return;
        const proc = server.proc;
        const scSocket = server.scSocket;
        server.proc = null;
        server.scSocket = null;
        if (scSocket) { try { scSocket.destroy(); } catch (err) {} }
        if (proc) {
            try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.destroy(); } catch (err) {}
            try { proc.kill('SIGKILL'); } catch (err) { try { proc.kill(); } catch (innerErr) {} }
        }
        if (!options.suppressStatus) setServerStatus(id, 'disconnected');
        if (reason && !options.suppressError && context.encoderWindow && !context.encoderWindow.isDestroyed()) {
            context.encoderWindow.webContents.send('encoder-error', { serverId: String(id), message: reason });
        }
        maybeStopEncoderInput(options);
    }

    // Mata TODOS los servidores (desconectar todo / parada de emergencia).
    function killAllEncoderServers(reason = '', options = {}) {
        const ids = Array.from(context.encoderServers.keys());
        for (const id of ids) {
            const server = getEncoderServer(id);
            const proc = server && server.proc;
            if (server) server.proc = null;
            if (proc) {
                try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.destroy(); } catch (err) {}
                try { proc.kill('SIGKILL'); } catch (err) { try { proc.kill(); } catch (innerErr) {} }
            }
            if (!options.suppressStatus) setServerStatus(id, 'disconnected');
        }
        maybeStopEncoderInput(options);
    }

    // Compat: nombre legacy usado en rutas de error que aún no conocen serverId.
    // Mata todos los servidores (comportamiento equivalente al modo de 1 servidor).
    function killFfmpegProcess(reason = '', options = {}) {
        killAllEncoderServers(reason, options);
        if (reason && !options.suppressError && context.encoderWindow && !context.encoderWindow.isDestroyed()) {
            context.encoderWindow.webContents.send('encoder-error', reason);
        }
    }

    function resetEncoderWriteStats() {
        const now = Date.now();
        context.encoderWriteStats = {
            startedAt: now,
            chunks: 0,
            bytes: 0,
            backpressure: 0,
            flowControlEvents: 0,
            drainEvents: 0,
            maxDrainMs: 0,
            slowDrainEvents: 0,
            waitingDrain: false,
            lastBackpressureAt: 0,
            lastSlowDrainLogAt: 0,
            errors: 0,
            lastSummaryAt: now,
            inputPeak: 0,
            inputRms: 0,
            inputPeakDb: -120,
            inputRmsDb: -120,
            lastInputMeterAt: 0,
            lastInputSignalAt: 0,
            inputSilentMs: 0,
            lastInputSilenceLogAt: 0
        };
    }

    function pcmLevelToDb(value) {
        const safe = Math.max(0, Math.min(1, Number(value) || 0));
        if (safe <= 0.000001) return -120;
        return Math.max(-120, 20 * Math.log10(safe));
    }

    function measurePcmS16leLevel(buffer) {
        if (!buffer || buffer.length < 2) {
            return { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 };
        }
        const sampleCount = Math.floor(buffer.length / 2);
        let peak = 0;
        let sumSquares = 0;
        for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
            const value = buffer.readInt16LE(offset) / 32768;
            const abs = Math.abs(value);
            if (abs > peak) peak = abs;
            sumSquares += value * value;
        }
        const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
        return {
            peak,
            rms,
            peakDb: pcmLevelToDb(peak),
            rmsDb: pcmLevelToDb(rms)
        };
    }

    function updateEncoderInputMeter(buffer, source = 'renderer') {
        const stats = context.encoderWriteStats;
        if (!stats) return;
        const format = context.encoderSourceContract?.captureFormat || context.activeEncoderConfig?.captureFormat || '';
        if (format !== 'pcm_s16le') return;

        const now = Date.now();
        const level = measurePcmS16leLevel(buffer);
        const hasSignal = level.peak > 0.0008 || level.rms > 0.00025;
        if (hasSignal) {
            stats.lastInputSignalAt = now;
            stats.inputSilentMs = 0;
            stats.inputSilenceLogCount = 0;
            stats.inputSilenceSuppressed = false;
            stats.inputSilentSummaryLogCount = 0;
            stats.inputSilentSummarySuppressed = false;
            context.rustPcmSilenceAlertLogCount = 0;
            context.rustPcmSilenceAlertSuppressed = false;
        } else {
            stats.inputSilentMs = stats.lastInputSignalAt ? now - stats.lastInputSignalAt : now - stats.startedAt;
        }
        stats.inputPeak = level.peak;
        stats.inputRms = level.rms;
        stats.inputPeakDb = level.peakDb;
        stats.inputRmsDb = level.rmsDb;

        if (context.encoderWindow && !context.encoderWindow.isDestroyed() && now - stats.lastInputMeterAt >= 20) {
            stats.lastInputMeterAt = now;
            context.encoderWindow.webContents.send('encoder-input-meter', {
                source,
                captureProvider: context.encoderSourceContract?.captureProvider || context.activeEncoderConfig?.captureProvider || '',
                captureFormat: format,
                peak: level.peak,
                rms: level.rms,
                peakDb: level.peakDb,
                rmsDb: level.rmsDb,
                hasSignal,
                silentMs: stats.inputSilentMs,
                updatedAt: now
            });
        }

        if (!hasSignal && stats.inputSilentMs > 8000 && now - (stats.lastInputSilenceLogAt || 0) > 30000) {
            stats.lastInputSilenceLogAt = now;
            stats.inputSilenceLogCount = (stats.inputSilenceLogCount || 0) + 1;
            if (stats.inputSilenceLogCount <= 3) {
                writeLog(`Encoder entrada PCM sin senal (${source}) por ${Math.round(stats.inputSilentMs / 1000)}s. FFmpeg sigue recibiendo datos.`);
            } else if (!stats.inputSilenceSuppressed) {
                stats.inputSilenceSuppressed = true;
                writeLog(`Encoder entrada PCM sin senal (${source}): se silencian avisos repetidos hasta recuperar audio.`);
            }
        }
    }

    function logEncoderWriteStats(reason = 'summary') {
        const stats = context.encoderWriteStats;
        if (!stats || !stats.chunks) return;
        if (reason === 'minute' && (stats.inputSilentMs || 0) > 8000) {
            stats.inputSilentSummaryLogCount = (stats.inputSilentSummaryLogCount || 0) + 1;
            if (stats.inputSilentSummaryLogCount > 3) {
                if (!stats.inputSilentSummarySuppressed) {
                    stats.inputSilentSummarySuppressed = true;
                    writeLog('Encoder PCM minute: se silencian resumenes repetidos mientras la entrada siga sin senal.');
                }
                stats.lastSummaryAt = Date.now();
                return;
            }
        }
        const elapsedSec = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
        const kbps = (stats.bytes * 8 / 1000 / elapsedSec).toFixed(1);
        const flowControlEvents = stats.flowControlEvents || stats.backpressure || 0;
        const drainEvents = stats.drainEvents || 0;
        const slowDrainEvents = stats.slowDrainEvents || 0;
        let estado = 'normal';
        if (stats.errors > 0) estado = 'error';
        else if (slowDrainEvents > 0) estado = 'observacion';
        else if (flowControlEvents > 0 && flowControlEvents === drainEvents) estado = 'normal-regulado';
        const peakText = Number.isFinite(stats.inputPeakDb) ? `${stats.inputPeakDb.toFixed(1)}dB` : '--';
        const rmsText = Number.isFinite(stats.inputRmsDb) ? `${stats.inputRmsDb.toFixed(1)}dB` : '--';
        writeLog(`Encoder PCM ${reason}: estado=${estado}, chunks=${stats.chunks}, MB=${(stats.bytes / 1048576).toFixed(2)}, pcm=${kbps} kbps, entradaPeak=${peakText}, entradaRms=${rmsText}, silencio=${Math.round((stats.inputSilentMs || 0) / 1000)}s, flujoControlado=${flowControlEvents}, drains=${drainEvents}, drainsLentos=${slowDrainEvents}, maxDrain=${Math.round(stats.maxDrainMs || 0)}ms, errores=${stats.errors}`);
        stats.lastSummaryAt = Date.now();
    }

    function normalizeEncoderConfig(config = {}) {
        // Tipos válidos: 'icecast' (Icecast 2 PUT), 'shoutcast' (clásico SOURCE
        // legacy), 'shoutcast2' (DNAS 2.x con PUT moderno). Cualquier otro valor
        // cae a 'icecast' por seguridad.
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
            mount: String(config.mount || '').trim(),
            source,
            tapPoint: config.tapPoint === 'preFx' ? 'preFx' : 'postFx',
            micId: config.micId || config.mic || '',
            codec: config.codec === 'mp3' ? 'mp3' : config.codec === 'aac_he' ? 'aac_he' : 'aac',
            // El motor de audio es siempre Rust (WebAudio fue retirado del programa).
            encoderProvider: 'rust',
            bitrate: String(bitrate),
            legacy: config.legacy === true,
            icyName: String(config.icyName || config.name || 'Radio').trim() || 'Radio',
            icyGenre: String(config.icyGenre || 'Variado').trim() || 'Variado'
        };
    }

    function normalizeMount(mount) {
        const mountStr = String(mount || '').trim();
        if (!mountStr) return '/';
        return mountStr.startsWith('/') ? mountStr : `/${mountStr}`;
    }

    function buildStreamUrl(config) {
        const safePassword = encodeURIComponent(String(config.password || ''));
        const safeUser = encodeURIComponent(String(config.user || 'source').trim() || 'source');

        // SHOUTcast clásico (Listen2MyRadio): usuario 'source' fijo y Stream ID /1
        // hardcoded — es el único valor que aceptan los proveedores free. La
        // diferencia con shoutcast2 NO está en la URL sino en el método HTTP
        // (SOURCE legacy vs PUT moderno), controlado por `-legacy_icecast`.
        if (config.serverType === 'shoutcast') {
            return `icecast://source:${safePassword}@${config.ip}:${config.port}/1`;
        }

        // SHOUTcast 2.x (DNAS): puede alojar varios streams por Stream ID (SID).
        // Tomamos el SID del campo mount (que en la UI se muestra como "Stream ID"),
        // sanitizando a dígitos. Por defecto SID 1.
        if (config.serverType === 'shoutcast2') {
            const sid = String(config.mount || '').replace(/[^\d]/g, '') || '1';
            return `icecast://source:${safePassword}@${config.ip}:${config.port}/${sid}`;
        }

        // Icecast 2: usuario configurable (default 'source') + mount libre.
        let mountStr = normalizeMount(config.mount);
        if (mountStr === '/' || !mountStr) mountStr = '/stream';
        return `icecast://${safeUser}:${safePassword}@${config.ip}:${config.port}${mountStr}`;
    }

    function buildCodecArgs(config) {
        // aresample=async:1 solo es necesario cuando la fuente tiene timing variable
        // (renderer WebAudio o micrófono). El tap PCM nativo de Rust entrega s16le
        // a sample rate exacto y fijo, así que el filtro no aporta nada y puede
        // introducir micro-artefactos por el modo async.
        const needsResample = config.captureFormat !== 'pcm_s16le';
        const resampleFilter = needsResample ? ['-af', 'aresample=async=1:first_pts=0'] : [];
        const common = ['-vn', '-ac', '2', '-ar', '44100', ...resampleFilter];
        // El protocolo `icecast://` de FFmpeg envía por defecto HTTP PUT (Icecast
        // 2.4+). SHOUTcast clásico (v1 y la mayoría de v2 free como Listen2MyRadio)
        // sólo entiende el método SOURCE legacy — sin `-legacy_icecast 1` falla
        // con "End of file" antes de transmitir audio.
        //
        // Tres modos según el dropdown del encoder:
        //   - 'icecast'    → PUT moderno (Icecast 2.4+, Zeno.fm)
        //   - 'shoutcast'  → SOURCE legacy (Shoutcast 1.x / 2.x clásico, L2MR)
        //   - 'shoutcast2' → PUT moderno por defecto; SOURCE legacy si config.legacy=true
        //                    (necesario en proveedores como Listen2MyRadio que corren
        //                    DNAS 2.x pero solo aceptan el método SOURCE, no HTTP PUT)
        const needsLegacy = config.serverType === 'shoutcast' || (config.serverType === 'shoutcast2' && config.legacy === true);
        const legacyShoutcast = needsLegacy ? ['-legacy_icecast', '1'] : [];
        // SHOUTcast DNAS 2.x valida los headers icy-* tras el handshake SOURCE.
        // FFmpeg internamente usa "Ice-" (Icecast) pero los envía igualmente. El
        // user-agent debe identificarse como cliente SHOUTcast compatible para no
        // ser rechazado por el DNAS. icy-br no lo envía FFmpeg automáticamente.
        const icyMeta = needsLegacy ? [
            '-ice_name', config.icyName || 'Radio',
            '-ice_genre', config.icyGenre || 'Variado',
            '-ice_public', '1',
            '-user_agent', `LF-Radio/1.0 (Lavf; SHOUTcast; br=${config.bitrate || 128})`
        ] : [];
        if (config.codec === 'aac') return [...common, '-c:a', 'aac', '-b:a', `${config.bitrate}k`, ...legacyShoutcast, ...icyMeta, '-f', 'adts', '-content_type', 'audio/aac'];
        if (config.codec === 'aac_he') {
            // Usar libfdk_aac solo si el probe de inicio confirmó que está disponible.
            // En ffmpeg-static/gyan.dev (GPL) no está incluido por ser non-free, así
            // que caemos al encoder nativo aac (AAC-LC). El aviso al usuario se emite
            // en startFfmpegProcess() antes de llamar a esta función.
            if (_fdkAacAvailable === true) {
                return [...common, '-c:a', 'libfdk_aac', '-profile:a', 'aac_he', '-b:a', `${config.bitrate}k`, ...legacyShoutcast, ...icyMeta, '-f', 'adts', '-content_type', 'audio/aac'];
            }
            return [...common, '-c:a', 'aac', '-b:a', `${config.bitrate}k`, ...legacyShoutcast, ...icyMeta, '-f', 'adts', '-content_type', 'audio/aac'];
        }
        return [...common, '-c:a', 'libmp3lame', '-b:a', `${config.bitrate}k`, '-minrate', `${config.bitrate}k`, '-maxrate', `${config.bitrate}k`, '-bufsize', `${parseInt(config.bitrate, 10) * 2}k`, ...legacyShoutcast, ...icyMeta, '-f', 'mp3', '-content_type', 'audio/mpeg'];
    }

    // Codec args para SHOUTcast nativo: FFmpeg solo codifica y escribe a pipe:1.
    // El handshake SOURCE, los headers icy-* y el TCP lo maneja Node.js directamente.
    //
    // IMPORTANTE — MP3: se suprimen las cabeceras ID3 (-id3v2_version 0 -write_id3v1 0).
    // Sin esto, FFmpeg puede escribir un bloque ID3 al inicio del pipe que el DNAS 2.x
    // no entiende como audio válido y aborta la conexión a los ~1-2 segundos.
    // ADTS (AAC) no tiene este problema — es un formato de stream puro sin contenedor.
    function buildShoutcastPipeArgs(config) {
        const needsResample = config.captureFormat !== 'pcm_s16le';
        const resampleFilter = needsResample ? ['-af', 'aresample=async=1:first_pts=0'] : [];
        const common = ['-vn', '-ac', '2', '-ar', '44100', ...resampleFilter];
        const br = config.bitrate || '128';
        // AAC: ADTS es un bitstream puro, sin cabecera de contenedor. Ideal para streaming.
        if (config.codec === 'aac') return [...common, '-c:a', 'aac', '-b:a', `${br}k`, '-f', 'adts', 'pipe:1'];
        if (config.codec === 'aac_he') {
            if (_fdkAacAvailable === true)
                return [...common, '-c:a', 'libfdk_aac', '-profile:a', 'aac_he', '-b:a', `${br}k`, '-f', 'adts', 'pipe:1'];
            return [...common, '-c:a', 'aac', '-b:a', `${br}k`, '-f', 'adts', 'pipe:1'];
        }
        // MP3: CBR estricto + sin cabeceras ID3 para que el primer byte sea 0xFF (sync frame).
        return [...common,
            '-c:a', 'libmp3lame', '-b:a', `${br}k`, '-minrate', `${br}k`, '-maxrate', `${br}k`,
            '-bufsize', `${parseInt(br) * 2}k`,
            '-id3v2_version', '0', '-write_id3v1', '0',
            '-f', 'mp3', 'pipe:1'];
    }

    // Abre la conexión TCP nativa SHOUTcast. Bifurca según serverType:
    //
    //   'shoutcast'      → ICY v1 legacy (L2MR, SC1 clásico, cualquier DNAS):
    //   'shoutcast2'       password\r\n → OK2 → icy headers → audio inmediato.
    //     (legacy=true)    Sin HTTP, sin Authorization header.
    //                      Los servidores etiquetados "Shoutcast2" (L2MR) también
    //                      usan este protocolo en su puerto de fuente.
    //
    //   'shoutcast2'     → HTTP SOURCE (DNAS 2.x puro con PUT desactivado):
    //     (legacy=false)   SOURCE /SID HTTP/1.0 + Authorization:Basic → ICY 200 OK.
    //                      Usado cuando el servidor NO acepta HTTP PUT pero sí SOURCE HTTP.
    //
    // Callbacks:
    //   onReady(socket)  — handshake OK; el caller pica stdout al socket.
    //   onFail(reason)   — error / timeout / rechazo; el caller limpia el proceso.
    function openShoutcastSocket(config, sid, onReady, onFail) {
        const net = require('net');

        // ICY v1 para 'shoutcast' Y para 'shoutcast2'+legacy.
        // Muchos servidores etiquetados como "Shoutcast 2" (L2MR, RadioFe, etc.)
        // SOLO aceptan ICY v1 en el puerto fuente — no HTTP SOURCE ni HTTP PUT.
        const useIcyLegacy = (config.serverType === 'shoutcast') ||
                             (config.serverType === 'shoutcast2' && config.legacy === true);

        const mountSid = config.serverType === 'shoutcast2'
            ? (String(config.mount || '').replace(/[^\d]/g, '') || '1')
            : '1';
        const br = String(config.bitrate || '128');
        // MP3 → audio/mpeg | AAC/HE-AAC → audio/aacp (SHOUTcast rechaza audio/aac)
        const contentType = (config.codec === 'mp3') ? 'audio/mpeg' : 'audio/aacp';

        writeLog(`[Srv ${sid}] SHOUTcast nativo (${useIcyLegacy ? 'ICY v1 legacy' : 'HTTP SOURCE'}): conectando a ${config.ip}:${config.port}${useIcyLegacy ? '' : ' → SOURCE /' + mountSid} | ${config.codec} ${br}kbps`);

        const socket = new net.Socket();
        let settled   = false;
        let streaming = false;
        let responseBuffer = '';
        let handshakeDone  = false;

        function settle(ok, arg) {
            if (settled) return;
            settled = true;
            if (ok) { onReady(socket); }
            else    { try { socket.destroy(); } catch (_) {} onFail(arg); }
        }

        socket.setTimeout(10000);
        socket.connect(parseInt(config.port, 10), config.ip, () => {
            socket.setTimeout(0);

            if (useIcyLegacy) {
                // ── SHOUTcast 1.x ICY legacy ──────────────────────────────────
                // Paso 1: contraseña en texto plano (sin HTTP, sin Base64).
                socket.write(`${config.password}\r\n`);
            } else {
                // ── DNAS 2.x HTTP SOURCE ──────────────────────────────────────
                // Authorization:Basic + icy-password para máxima compatibilidad.
                // ice-audio-info le informa al DNAS el codec antes del primer frame.
                const auth = Buffer.from(`source:${config.password}`).toString('base64');
                socket.write(
                    `SOURCE /${mountSid} HTTP/1.0\r\n` +
                    `Authorization: Basic ${auth}\r\n` +
                    `icy-password: ${config.password}\r\n` +
                    `User-Agent: LF-Radio/1.0\r\n` +
                    `Content-Type: ${contentType}\r\n` +
                    `ice-audio-info: ice-samplerate=44100;ice-bitrate=${br};ice-channels=2\r\n` +
                    `icy-name: ${config.icyName || 'Radio'}\r\n` +
                    `icy-genre: ${config.icyGenre || 'Variado'}\r\n` +
                    `icy-pub: 1\r\n` +
                    `icy-br: ${br}\r\n` +
                    `\r\n`
                );
            }
        });

        socket.on('data', (data) => {
            if (handshakeDone) return;
            responseBuffer += data.toString('latin1');

            if (useIcyLegacy) {
                // ── ICY v1: esperar al menos una línea de respuesta ────────────
                if (!responseBuffer.includes('\n')) return;
                handshakeDone = true;

                if (/^OK2/i.test(responseBuffer.trimStart())) {
                    // Paso 2: auth OK → enviar icy headers.
                    // El servidor NO responde tras los headers; el audio puede
                    // empezar inmediatamente a continuación.
                    socket.write(
                        `icy-name:${config.icyName || 'Radio'}\r\n` +
                        `icy-genre:${config.icyGenre || 'Variado'}\r\n` +
                        `icy-pub:1\r\n` +
                        `icy-br:${br}\r\n` +
                        `icy-url:http://\r\n` +
                        `content-type:${contentType}\r\n` +
                        `\r\n`
                    );
                    writeLog(`[Srv ${sid}] SHOUTcast ICY OK2 → headers enviados, transmitiendo`);
                    setServerStatus(sid, 'live');
                    streaming = true;
                    if (context.mainWindow) setTimeout(() => {
                        if (context.mainWindow && !context.mainWindow.isDestroyed())
                            context.mainWindow.webContents.send('force-metadata-update');
                    }, 3000);
                    settle(true);
                } else {
                    const resp = responseBuffer.replace(/\r/g, '').trim().slice(0, 200);
                    writeLog(`[Srv ${sid}] SHOUTcast ICY rechazado: ${resp}`);
                    if (context.encoderWindow && !context.encoderWindow.isDestroyed())
                        context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: `SHOUTcast ICY rechazó: ${resp}` });
                    settle(false, `ICY rechazó: ${resp}`);
                }

            } else {
                // ── HTTP SOURCE: esperar doble-CRLF o ICY 200 ─────────────────
                const hasEnd = responseBuffer.includes('\r\n\r\n') || responseBuffer.includes('\n\n');
                const hasICY = /ICY 200/i.test(responseBuffer);
                if (!hasEnd && !hasICY) return;
                handshakeDone = true;

                if (hasICY || /200 OK/i.test(responseBuffer)) {
                    writeLog(`[Srv ${sid}] SHOUTcast HTTP SOURCE OK → transmitiendo`);
                    setServerStatus(sid, 'live');
                    streaming = true;
                    if (context.mainWindow) setTimeout(() => {
                        if (context.mainWindow && !context.mainWindow.isDestroyed())
                            context.mainWindow.webContents.send('force-metadata-update');
                    }, 3000);
                    settle(true);
                } else {
                    const firstLine = responseBuffer.split(/\r?\n/)[0].trim();
                    const fullResp  = responseBuffer.replace(/\r/g, '').trim().slice(0, 400);
                    writeLog(`[Srv ${sid}] SHOUTcast HTTP SOURCE rechazado:\n${fullResp}`);
                    if (context.encoderWindow && !context.encoderWindow.isDestroyed())
                        context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: `SHOUTcast rechazó: ${firstLine}` });
                    settle(false, `SHOUTcast rechazó: ${firstLine}`);
                }
            }
        });

        socket.on('timeout', () => {
            writeLog(`[Srv ${sid}] SHOUTcast timeout conectando`);
            settle(false, 'SHOUTcast: timeout de conexión (10 s)');
        });

        socket.on('error', (err) => {
            writeLog(`[Srv ${sid}] SHOUTcast socket error: ${err.message}`);
            settle(false, `Error de socket: ${err.message}`);
        });

        socket.on('close', () => {
            if (!settled) {
                writeLog(`[Srv ${sid}] SHOUTcast socket cerrado antes del handshake`);
                settle(false, 'Conexión cerrada por el servidor antes del handshake');
            } else if (streaming) {
                writeLog(`[Srv ${sid}] SHOUTcast socket cerrado por el servidor`);
                onFail('Servidor cerró la conexión durante la transmisión');
            }
        });

        return socket;
    }

    function buildEncoderInputArgs(config) {
        if (config.captureFormat === 'pcm_s16le') {
            const sampleRate = Math.max(8000, Math.min(192000, parseInt(config.sampleRate, 10) || 44100));
            return ['-f', 's16le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0'];
        }
        return ['-f', 'webm', '-c:a', 'opus', '-i', 'pipe:0'];
    }

    function writeEncoderAudioChunk(chunk, source = 'renderer') {
        // La fuente PCM es única (la mezcla del programa). Se reparte el MISMO
        // buffer al stdin de cada servidor con proceso vivo. La medición de
        // entrada (Pico/RMS) y las estadísticas de bytes se hacen UNA sola vez
        // porque la entrada es compartida; el backpressure se gestiona por
        // servidor para que un destino lento no afecte a los demás.
        if (countLiveServers() === 0) return false;
        let wroteAny = false;
        try {
            const buffer = Buffer.from(chunk);
            if (context.encoderWriteStats) {
                context.encoderWriteStats.chunks++;
                context.encoderWriteStats.bytes += buffer.length;
            }
            updateEncoderInputMeter(buffer, source);

            for (const server of context.encoderServers.values()) {
                const proc = server.proc;
                if (!proc || !proc.stdin || proc.stdin.destroyed) continue;
                try {
                    const accepted = proc.stdin.write(buffer);
                    wroteAny = true;
                    if (!accepted && !server.waitingDrain) {
                        server.waitingDrain = true;
                        server.lastBackpressureAt = Date.now();
                        if (context.encoderWriteStats) {
                            context.encoderWriteStats.backpressure++;
                            context.encoderWriteStats.flowControlEvents++;
                        }
                        proc.stdin.once('drain', () => {
                            const drainMs = Date.now() - (server.lastBackpressureAt || Date.now());
                            server.waitingDrain = false;
                            if (context.encoderWriteStats) {
                                context.encoderWriteStats.drainEvents++;
                                context.encoderWriteStats.maxDrainMs = Math.max(context.encoderWriteStats.maxDrainMs || 0, drainMs);
                                if (drainMs > 1000) {
                                    context.encoderWriteStats.slowDrainEvents++;
                                    const now = Date.now();
                                    if (!context.encoderWriteStats.lastSlowDrainLogAt || now - context.encoderWriteStats.lastSlowDrainLogAt > 30000) {
                                        context.encoderWriteStats.lastSlowDrainLogAt = now;
                                        writeLog(`Encoder PCM drain lento (srv ${server.id}): ${Math.round(drainMs)}ms. FFmpeg recupero la escritura.`);
                                    }
                                }
                            }
                        });
                    }
                } catch (errWrite) {
                    if (context.encoderWriteStats) context.encoderWriteStats.errors++;
                }
            }

            if (context.encoderWriteStats && Date.now() - context.encoderWriteStats.lastSummaryAt > 60000) {
                logEncoderWriteStats('minute');
            }
            reportRustPcmSilence(source);
            return wroteAny;
        } catch (err) {
            if (context.encoderWriteStats) context.encoderWriteStats.errors++;
            writeLog(`Error escribiendo audio al encoder (${source}): ${err.message || err}`);
            return false;
        }
    }

    function stopRustPcmEncoderSource() {
        if (context.rustPcmEncoderSource) {
            try { context.rustPcmEncoderSource.stop(); } catch (err) {
                writeLog(`Rust PCM encoder source stop: ${err.message || err}`);
            }
            context.rustPcmEncoderSource = null;
        }
        // Siempre desregistrar el consumer del engine principal (modo --pcm-tap)
        try { context.rustAudioEngine?.detachPcmConsumer?.(); } catch (err) { }
        if (context.mainWindow && !context.mainWindow.isDestroyed()) {
            context.mainWindow.webContents.send('stop-rust-pcm-encoder-sync');
        }
    }

    // Lanza el proceso FFmpeg de UN servidor (sin tocar los demás). La fuente PCM
    // compartida (tap de Rust o chunks del renderer) alimenta a todos los procesos
    // vía writeEncoderAudioChunk. `id` identifica el servidor en el registro.
    function startServerFfmpeg(id, rawConfig = {}) {
        const sid = String(id);
        const config = normalizeEncoderConfig(rawConfig);
        const localTesting = process.env.LOCAL_TESTING === 'true' || config?.localTesting === true;
        const streamUrl = buildStreamUrl(config);
        // Notificar al operador si AAC+ solicitado pero libfdk_aac no disponible.
        if (config.codec === 'aac_he' && _fdkAacAvailable !== true && context.encoderWindow && !context.encoderWindow.isDestroyed()) {
            const fallbackMsg = _fdkAacAvailable === null
                ? 'Verificando soporte AAC+ en FFmpeg, transmitiendo como AAC-LC por ahora.'
                : 'AAC+ (libfdk_aac) no esta disponible en este FFmpeg. Transmitiendo como AAC-LC. Para HE-AAC real usa un FFmpeg compilado con --enable-libfdk-aac.';
            context.encoderWindow.webContents.send('encoder-warn', { serverId: sid, message: fallbackMsg });
        }
        const codecArgs = buildCodecArgs(config);
        try {
            // Reset de estadísticas de entrada solo cuando arranca el PRIMER servidor
            // (la entrada PCM es compartida entre todos).
            if (countLiveServers() === 0) resetEncoderWriteStats();

            // Si este servidor ya tenía proceso (reconexión), lo matamos primero.
            const existing = getEncoderServer(sid);
            if (existing) {
                if (existing.scSocket) { try { existing.scSocket.destroy(); } catch (e) {} existing.scSocket = null; }
                if (existing.proc) {
                    try { if (existing.proc.stdin && !existing.proc.stdin.destroyed) existing.proc.stdin.destroy(); } catch (e) {}
                    try { existing.proc.kill('SIGKILL'); } catch (e) { try { existing.proc.kill(); } catch (e2) {} }
                    existing.proc = null;
                }
            }

            const inputArgs = buildEncoderInputArgs(config);
            const useNativeShoutcast = !localTesting && (config.serverType === 'shoutcast' || (config.serverType === 'shoutcast2' && config.legacy === true));
            const ffmpegArgs = localTesting
                ? ['-hide_banner', '-nostdin', ...inputArgs, '-f', 'null', '-']
                : useNativeShoutcast
                    ? ['-hide_banner', '-nostdin', ...inputArgs, ...buildShoutcastPipeArgs(config)]
                    : ['-hide_banner', '-nostdin', ...inputArgs, ...codecArgs, streamUrl];
            const _codecLabel = config.codec === 'mp3' ? 'MP3' : config.codec === 'aac_he' ? (_fdkAacAvailable === true ? 'AAC+ (HE-AAC)' : 'AAC-LC (fallback de AAC+)') : 'AAC-LC';
            writeLog(`Encoder FFmpeg [srv ${sid}] iniciado. Codec: ${_codecLabel} ${config.bitrate || 128}kbps, modo: ${useNativeShoutcast ? 'SHOUTcast-nativo' : (config.serverType || 'icecast')}${useNativeShoutcast ? `, icy-name="${config.icyName || 'Radio'}"` : ''}`);
            notifyRustEncoder('start', config);

            const proc = cp.spawn(ffmpegPath, ffmpegArgs, { windowsHide: true, stdio: ['pipe', useNativeShoutcast ? 'pipe' : 'ignore', 'pipe'] });
            const server = existing || { id: sid };
            server.id = sid;
            server.config = config;
            server.proc = proc;
            server.waitingDrain = false;
            server.scSocket = null;
            context.encoderServers.set(sid, server);

            if (useNativeShoutcast) {
                // ── ANTI-DEADLOCK: consumir stdout de FFmpeg desde el primer instante ──
                // FFmpeg empieza a codificar y escribir en pipe:1 inmediatamente. Si
                // nadie lee stdout, el buffer del kernel (~64 KB en Windows) se llena
                // en pocos segundos → FFmpeg bloquea → deja de leer stdin → el tap PCM
                // de Rust se congela → todo colapsa. Solución: acumular los chunks en
                // memoria mientras el handshake TCP está en curso. En cuanto el servidor
                // responde ICY 200, volcamos el buffer al socket y hacemos pipe del resto.
                const audioBuffer = [];
                let stdoutLive = false;
                proc.stdout.on('data', (chunk) => {
                    if (!stdoutLive) audioBuffer.push(Buffer.from(chunk));
                });
                // Silenciar errores de stdout (p.ej. broken-pipe si el socket cierra).
                proc.stdout.on('error', () => {});

                let scFailCalled = false;
                const onScReady = (socket) => {
                    // Handshake OK: volcar buffer pre-handshake y hacer pipe del resto.
                    stdoutLive = true;
                    proc.stdout.removeAllListeners('data');
                    for (const ch of audioBuffer) {
                        if (!socket.destroyed && socket.writable) socket.write(ch);
                    }
                    audioBuffer.length = 0;
                    if (!socket.destroyed) proc.stdout.pipe(socket, { end: false });
                };
                const onScFail = (reason) => {
                    if (scFailCalled) return;
                    scFailCalled = true;
                    stdoutLive = true;   // detener acumulación
                    audioBuffer.length = 0;
                    // killEncoderServer limpia proc + socket + estado + PCM tap si procede
                    killEncoderServer(sid, reason);
                };
                server.scSocket = openShoutcastSocket(config, sid, onScReady, onScFail);
            }
            setServerStatus(sid, 'connecting');

            let isFfmpegLive = false;
            let ffmpegLastStderr = '';
            proc.stderr.on('data', (data) => {
                const out = data.toString();
                ffmpegLastStderr = (ffmpegLastStderr + out).slice(-2000);
                const bitrateMatch = out.match(/bitrate=\s*([\d.]+)\s*kbits\/s/i);
                const speedMatch = out.match(/speed=\s*([\d.]+)x/i);
                const timeMatch = out.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/i);
                if (bitrateMatch && context.encoderWindow && !context.encoderWindow.isDestroyed()) {
                    const throughput = {
                        serverId: sid,
                        bitrateKbps: Number(bitrateMatch[1]),
                        speed: speedMatch ? Number(speedMatch[1]) : null,
                        ffmpegTime: timeMatch ? timeMatch[1] : ''
                    };
                    context.encoderWindow.webContents.send('encoder-throughput', throughput);
                    notifyRustEncoder('health', { ...config, ...throughput });
                }
                // En modo SHOUTcast nativo el estado 'live' lo pone el handshake TCP
                // (openShoutcastSocket), NO el stderr de FFmpeg: FFmpeg escribe a pipe:1
                // e imprime time=/bitrate= aunque el socket aún no se haya conectado.
                // Usar el stderr para marcar 'live' aquí causaría un flash falso antes
                // del handshake y enmascaría rechazos del servidor.
                if (!useNativeShoutcast && !isFfmpegLive && out.includes('time=') && out.includes('bitrate=')) {
                    isFfmpegLive = true;
                    setServerStatus(sid, 'live');
                    if (context.mainWindow) {
                        setTimeout(() => { if (context.mainWindow && !context.mainWindow.isDestroyed()) context.mainWindow.webContents.send('force-metadata-update'); }, 3000);
                    }
                }
            });
            proc.stdin.on('error', (err) => {
                if (context.encoderWriteStats) context.encoderWriteStats.errors++;
                writeLog(`Encoder stdin [srv ${sid}]: ${err.message}`);
            });
            proc.on('error', (err) => { killEncoderServer(sid, `FFmpeg no pudo iniciar: ${err.message || err}`); });
            proc.on('close', (code) => {
                const s = getEncoderServer(sid);
                // Solo procesamos efectos si este proceso sigue siendo el activo del
                // servidor. Si fue reemplazado/matado intencionalmente, s.proc !== proc.
                const wasCurrent = !!(s && s.proc === proc);
                if (s && s.proc === proc) s.proc = null;
                notifyRustEncoder('stop', config);
                writeLog(`Encoder FFmpeg [srv ${sid}] cerrado. Codigo: ${code}. Ultima salida: ${ffmpegLastStderr || 'sin salida'}`);
                if (wasCurrent) {
                    if (code && code !== 0 && context.encoderWindow && !context.encoderWindow.isDestroyed()) {
                        const cleanErr = (ffmpegLastStderr || 'Error de conexion desconocido. Revisa la IP, puerto y clave.').replace(/\n/g, ' ').trim();
                        context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: `FFmpeg termino con codigo ${code}: ${cleanErr}` });
                    }
                    setServerStatus(sid, 'disconnected');
                }
                maybeStopEncoderInput();
            });
            return { success: true };
        } catch (err) {
            setServerStatus(sid, 'disconnected');
            if (context.encoderWindow) context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: 'Error critico lanzando FFmpeg.' });
            return { success: false, error: err.message || String(err) };
        }
    }

    // Compat legacy: arranca un único servidor con id '0' (usado por init-ffmpeg /
    // pruebas locales). El multi-servidor real usa connectEncoderServer por cada id.
    function startFfmpegProcess(rawConfig = {}) {
        return startServerFfmpeg('0', rawConfig);
    }

    function startRendererEncoderCapture(config) {
        context.activeEncoderConfig = config;
        if (context.mainWindow) context.mainWindow.webContents.send('start-audio-capture', config);
    }

    // Asegura que la fuente PCM compartida (tap nativo del motor Rust) esté
    // activa. Idempotente: si ya está enganchada, no hace nada — así varios
    // servidores comparten la misma entrada sin re-enganchar el tap.
    function ensureEncoderInput(config) {
        const sampleRate = Math.max(8000, Math.min(192000, parseInt(config.sampleRate, 10) || 44100));
        const engine = context.rustAudioEngine;
        if (!engine || !engine.isRunning?.() || typeof engine.attachPcmConsumer !== 'function') {
            return { success: false, error: 'Motor Rust no disponible para tap del encoder.' };
        }
        const resolved = {
            ...config,
            source: 'master',
            owner: 'rustAudioEngine',
            captureProvider: 'rustAudioEngine',
            tapPoint: config.tapPoint === 'preFx' ? 'preFx' : 'postFx',
            rustPcmReady: true,
            pcmBridgeReady: true,
            captureFormat: 'pcm_s16le',
            sampleRate,
            transport: 'ffmpeg-rust-pcm-tap'
        };
        context.activeEncoderConfig = resolved;
        context.encoderSourceContract = { ...(context.encoderSourceContract || {}), ...resolved, active: false };

        // El tap se engancha UNA sola vez (fuente compartida). Si ya existe un
        // tap activo, reutilizarlo — así varios servidores comparten la misma
        // fuente PCM sin re-enganchar el consumer.
        // Excepción: si rustPcmEncoderSource existe pero el engine reporta que
        // ya NO hay consumer activo (p.ej. tras una conexión fallida que llamó
        // detachPcmConsumer sin limpiar el objeto), re-enganchar igual.
        const tapAlreadyActive = context.rustPcmEncoderSource
            && context.rustPcmEncoderSource.isRunning?.()
            && (typeof engine.isPcmConsumerAttached !== 'function' || engine.isPcmConsumerAttached());
        if (!tapAlreadyActive) {
            // Asegurar que no quede un consumer previo colgado antes de enganchar.
            try { engine.detachPcmConsumer?.(); } catch (_) {}
            engine.attachPcmConsumer(chunk => writeEncoderAudioChunk(chunk, 'rust-pcm'));
            context.rustPcmEncoderSource = {
                _tap: true,
                isRunning: () => !!engine.isRunning(),
                stop: () => { try { engine.detachPcmConsumer(); } catch (err) { } },
                status: () => ({ tap: true, running: engine.isRunning() })
            };
            writeLog(`Encoder en modo Rust PCM tap nativo (${resolved.tapPoint}).`);
            if (context.mainWindow && !context.mainWindow.isDestroyed()) {
                context.mainWindow.webContents.send('start-rust-pcm-encoder-sync', resolved);
            }
        }
        return { success: true };
    }

    // Conecta UN servidor del path master (Rust): arranca su FFmpeg y se asegura
    // de que la fuente PCM compartida esté activa.
    function connectEncoderServer(id, config) {
        const started = startServerFfmpeg(id, config);
        if (!started.success) return started;
        const input = ensureEncoderInput(config);
        if (!input.success) {
            killEncoderServer(id, input.error);
            return input;
        }
        return started;
    }

    function reportRustPcmSilence(source = '') {
        if (source !== 'rust-pcm') return;
        const stats = context.encoderWriteStats;
        const engine = context.rustAudioEngine;
        // En modo --pcm-tap la fuente PCM es el engine principal (no un proceso bridge)
        const tapActive = !!(engine?.isPcmTapMode?.() && engine?.isRunning?.());
        const bridgeActive = !tapActive && !!(context.rustPcmEncoderSource?.isRunning?.());
        if (!stats || (!tapActive && !bridgeActive)) return;
        if ((Date.now() - (stats.startedAt || Date.now())) < 12000) return;
        const silentMs = Number(stats.inputSilentMs) || 0;
        if (silentMs < 12000) return;
        if (context.lastRustPcmSilenceAlertAt && Date.now() - context.lastRustPcmSilenceAlertAt < 60000) return;
        context.lastRustPcmSilenceAlertAt = Date.now();
        const rustStatus = tapActive
            ? { tap: true, running: engine.isRunning(), activePlayers: null }
            : (context.rustPcmEncoderSource?.status?.() || {});
        context.rustPcmSilenceAlertLogCount = (context.rustPcmSilenceAlertLogCount || 0) + 1;
        if (context.rustPcmSilenceAlertLogCount > 3) {
            if (!context.rustPcmSilenceAlertSuppressed) {
                context.rustPcmSilenceAlertSuppressed = true;
                writeLog('Rust PCM encoder sin senal persistente: se silencian avisos repetidos hasta recuperar audio.');
            }
            return;
        }
        const reason = (Number(rustStatus.activePlayers) || 0) > 0
            ? 'rust-pcm-silent-with-active-players'
            : 'rust-pcm-silent-no-live-players';
        writeLog(`Rust PCM encoder sin senal: ${reason}. Detalle=${JSON.stringify({
            silentMs,
            tapMode: tapActive,
            activePlayers: rustStatus.activePlayers,
            stdoutBytes: rustStatus.stdoutBytes,
            stdoutChunks: rustStatus.stdoutChunks,
            players: rustStatus.players
        })}`);
    }

    function startEncoderCapture(config, id = '0') {
        const sid = String(id);
        if ((config.source || 'master') === 'master' && (config.captureProvider === 'rustAudioEngine' || config.owner === 'rustAudioEngine' || config.requestedOwner === 'rustAudioEngine')) {
            const started = connectEncoderServer(sid, config);
            if (started.success) return;
            if (readAudioEngineMode() === 'rustAudio') {
                writeLog(`Rust PCM encoder [srv ${sid}] no inicio (${started.error || 'sin detalle'}). Modo Rust exclusivo: no se activa WebAudio.`);
                setServerStatus(sid, 'disconnected');
                if (context.encoderWindow) context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: started.error || 'Rust PCM encoder no inicio.' });
                return;
            }
            writeLog(`Rust PCM encoder [srv ${sid}] no inicio (${started.error || 'sin detalle'}). Ruta WebAudio master retirada: no se activa ruta alternativa.`);
            setServerStatus(sid, 'disconnected');
            if (context.encoderWindow) context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: started.error || 'Rust PCM encoder no inicio y la ruta WebAudio master fue retirada.' });
            return;
        }
        if ((config.source || 'master') === 'master') {
            writeLog('Encoder master bloqueado: el master ya no usa captura WebAudio del renderer.');
            setServerStatus(sid, 'disconnected');
            if (context.encoderWindow) context.encoderWindow.webContents.send('encoder-error', { serverId: sid, message: 'El encoder master requiere Rust PCM tap; la captura WebAudio fue retirada.' });
            return;
        }
        // Path de micrófono / entrada externa (renderer capture): legacy de servidor
        // único. El renderer arranca FFmpeg vía init-ffmpeg y manda audio-chunk.
        const rendererCapture = config.captureProvider === 'rustAudioEngine'
            ? {
                ...config,
                owner: 'mediaInputRenderer',
                captureProvider: 'mediaInputRenderer',
                rustPcmReady: false,
                pcmBridgeReady: false,
                fallbackReason: ''
            }
            : config;
        context.encoderSourceContract = { ...(context.encoderSourceContract || {}), ...rendererCapture, active: false };
        startRendererEncoderCapture(rendererCapture);
    }

    ipcMain.handle('dialog:openFile', async (event) => { 
        const currentWin = BrowserWindow.fromWebContents(event.sender) || context.eventEditorWindow || context.mainWindow; 
        const res = await dialog.showOpenDialog(currentWin, { properties: ['openFile'], filters: [ { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] } ] });
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; 
    }); 
    
    ipcMain.handle('dialog:openPlaylist', async () => { 
        const currentWin = context.eventEditorWindow || context.mainWindow;
        const res = await dialog.showOpenDialog(currentWin, { title: 'Abrir Playlist', properties: ['openFile'], filters: [{ name: 'LFPlay Playlist', extensions: ['lfplay'] }] }); 
        return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null; 
    }); 
    
    ipcMain.handle('dialog:savePlaylist', async (e, defName) => { const res = await dialog.showSaveDialog(context.mainWindow, { title: 'Guardar Playlist', defaultPath: defName || 'Mi_Playlist.LFPlay', filters: [{ name: 'LFPlay Playlist', extensions: ['lfplay'] }] }); return (!res.canceled && res.filePath) ? res.filePath : null; }); 
    
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
    }

    ipcMain.on('open-commercial-manager', () => openCommercialManagerWindow());
    ipcMain.on('open-library', () => { if (context.libraryWindow) { context.libraryWindow.focus(); return; } context.libraryWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'library.png')),   width: 1150, height: 750, title: 'Biblioteca de Música', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.libraryWindow.loadFile('frontend/libreria.html'); context.libraryWindow.on('closed', () => { context.libraryWindow = null; }); }); ipcMain.on('open-settings', () => { if (context.settingsWindow) { context.settingsWindow.focus(); return; } context.settingsWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'settings.png')),   width: 980, height: 760, minWidth: 900, minHeight: 700, title: 'Ajustes Generales', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.settingsWindow.loadFile('frontend/settings.html'); context.settingsWindow.on('closed', () => { context.settingsWindow = null; }); }); ipcMain.on('settings-updated', (_e, payload) => { forwardSettingsUpdated(payload || {}); }); ipcMain.on('refresh-event-groups', () => { if (context.mainWindow) context.mainWindow.webContents.send('refresh-event-groups'); if (context.eventEditorWindow) context.eventEditorWindow.webContents.send('refresh-event-groups'); if (context.calendarWindow && !context.calendarWindow.isDestroyed()) context.calendarWindow.webContents.send('refresh-event-groups'); }); ipcMain.on('open-event-groups', () => { if (context.eventGroupsWindow) { context.eventGroupsWindow.focus(); return; } context.eventGroupsWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'groups.png')),   width: 650, height: 550, title: 'Grupos de Eventos', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.eventGroupsWindow.loadFile('frontend/event_groups.html'); context.eventGroupsWindow.on('closed', () => { context.eventGroupsWindow = null; if (context.mainWindow) context.mainWindow.webContents.send('refresh-event-groups'); if(context.eventEditorWindow) context.eventEditorWindow.webContents.send('refresh-event-groups'); }); }); ipcMain.on('open-event-editor', (e, eventData) => { const requestedKey = eventData && eventData.id ? `edit:${eventData.id}` : 'new'; if (context.eventEditorWindow && !context.eventEditorWindow.isDestroyed()) { if (context.eventEditorContextKey === requestedKey) { if (context.eventEditorWindow.isMinimized()) context.eventEditorWindow.restore(); context.eventEditorWindow.show(); context.eventEditorWindow.focus(); return; } context.eventEditorWindow.destroy(); context.eventEditorWindow = null; context.eventEditorContextKey = null; } context.eventEditorWindow = new BrowserWindow({ icon: require('electron').nativeImage.createFromPath(require('path').join(__dirname, '..', '..', 'assets', 'icons', 'events.png')),   width: 820, height: 760, title: 'Editor de Eventos', autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }); context.eventEditorContextKey = requestedKey; context.eventEditorWindow.loadFile('frontend/event_editor.html'); context.eventEditorWindow.webContents.on('did-finish-load', () => { context.eventEditorWindow.webContents.send('load-event-data', eventData); }); context.eventEditorWindow.on('closed', () => { context.eventEditorWindow = null; context.eventEditorContextKey = null; if (context.calendarWindow && !context.calendarWindow.isDestroyed()) context.calendarWindow.webContents.send('refresh-events'); }); });
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
    ipcMain.on('open-encoder', () => {
        if (context.encoderWindow) {
            context.encoderWindow.show();
            context.encoderWindow.focus();
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
        });
        context.encoderWindow.on('close', (e) => {
            if (!context.isAppQuitting && countLiveServers() > 0) {
                e.preventDefault();
                context.encoderWindow.hide();
            }
        });
        context.encoderWindow.on('closed', () => { context.encoderWindow = null; });
    });
    // Conecta un servidor a partir de su config cruda (resuelve contrato + arranca).
    function connectOneFromConfig(id, rawConfig) {
        const normalized = normalizeEncoderConfig(rawConfig);
        const contract = buildEncoderSourceContract(normalized, false);
        const resolved = { ...normalized, ...contract };
        context.encoderSourceContract = { ...(context.encoderSourceContract || {}), ...contract, active: false };
        startEncoderCapture(resolved, id);
    }

    // start-encoder: acepta un ARRAY de configs (conectar todos / botón maestro) o
    // un único objeto (compatibilidad con el modo de un solo servidor). Cada config
    // puede traer su propio `serverId`; si no, se usa el índice.
    ipcMain.on('start-encoder', (e, payload) => {
        const list = Array.isArray(payload) ? payload : [payload];
        list.forEach((cfg, idx) => {
            const id = (cfg && (cfg.serverId !== undefined && cfg.serverId !== null)) ? cfg.serverId : idx;
            connectOneFromConfig(id, cfg || {});
        });
    });

    // start-encoder-server: conecta/reconecta UN servidor individual (botón por
    // servidor o reconexión automática del frontend).
    ipcMain.on('start-encoder-server', (e, payload = {}) => {
        const id = (payload.serverId !== undefined && payload.serverId !== null) ? payload.serverId : '0';
        connectOneFromConfig(id, payload);
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
    
    // Construye la URL de actualización de metadata remota para un servidor según
    // su tipo. Devuelve { url, headers } o null si el tipo no la soporta.
    function buildMetadataUpdate(conf, encodedMeta) {
        if (conf.serverType === 'icecast') {
            const mountStr = encodeURIComponent(normalizeMount(conf.mount));
            return {
                url: `http://${conf.ip}:${conf.port}/admin/metadata?mount=${mountStr}&mode=updinfo&song=${encodedMeta}`,
                headers: { 'Authorization': 'Basic ' + Buffer.from(`admin:${conf.password}`).toString('base64') }
            };
        }
        if (conf.serverType === 'shoutcast' || conf.serverType === 'shoutcast2') {
            // El `sid` (stream ID) es obligatorio en SHOUTcast DNAS 2.x — sin él
            // responde 404. Para clásico (L2MR) usamos sid=1 (su /1 fijo); para
            // shoutcast2 usamos el SID que el operador configuró (campo mount).
            const sid = conf.serverType === 'shoutcast2'
                ? (String(conf.mount || '').replace(/[^\d]/g, '') || '1')
                : '1';
            return {
                url: `http://${conf.ip}:${conf.port}/admin.cgi?pass=${encodeURIComponent(conf.password)}&mode=updinfo&sid=${sid}&song=${encodedMeta}`,
                headers: {}
            };
        }
        return null;
    }

    ipcMain.on('update-metadata', async (e, metaText) => {
        try { const txtPath = path.join(configDir, 'NowPlaying.txt'); fs.writeFileSync(txtPath, metaText, 'utf-8'); } catch(err) { writeLog("Error escribiendo NowPlaying.txt: " + err); }
        // Empujar la metadata a CADA servidor en vivo con su propia configuración.
        const encodedMeta = encodeURIComponent(String(metaText || '').slice(0, 255));
        for (const server of context.encoderServers.values()) {
            if (!server.proc || !server.config) continue;
            try {
                const conf = normalizeEncoderConfig(server.config);
                const meta = buildMetadataUpdate(conf, encodedMeta);
                if (meta && meta.url) {
                    fetch(meta.url, { headers: meta.headers || {} }).then((res) => {
                        if (!res.ok) writeLog(`Metadata remota [srv ${server.id}] respondio HTTP ${res.status}`);
                    }).catch(err => writeLog(`Error actualizando metadata remota [srv ${server.id}]: ` + err));
                }
            } catch(err) { writeLog(`Error preparando metadata remota [srv ${server.id}]: ` + err); }
        }
    });
    
    ipcMain.on('init-ffmpeg', (e, config) => {
        startFfmpegProcess(config);
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

    ipcMain.on('audio-chunk', (e, chunk) => {
        writeEncoderAudioChunk(chunk, 'renderer');
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
