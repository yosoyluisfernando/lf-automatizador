'use strict';

/**
 * backend/ipc/stream.js — Handlers IPC para retransmisión de emisoras de radio.
 *
 * Registra los siguientes canales:
 *   stream-url-start   (invoke)  { url, playerId, displayName }
 *                                → { success, streamId, error? }
 *   stream-url-stop    (invoke)  { streamId }
 *                                → { success }
 *   stream-probe       (invoke)  { url }
 *                                → { format, codec, bitrate, icyName, sampleRate, channels, error? }
 *
 * Emisiones al renderer:
 *   stream-status    { streamId, playerId, status }
 *   stream-icy-title { streamId, playerId, title }
 *   stream-icy-name  { streamId, playerId, name }
 *   stream-error     { streamId, playerId, message }
 *
 * Cada stream activo tiene un `streamId` único (string). El renderer lo usa para
 * identificar qué proxy controlar cuando hay múltiples decks simultáneos.
 */

const { StreamProxy, normalizePrebufferSeconds } = require('../stream_proxy');

module.exports = function registerStreamIpc(context) {
    const { ipcMain, ffmpegPath, writeLog, rustAudioEngine } = context;

    /** Mapa de streams activos: streamId → StreamProxy */
    const activeStreams = new Map();
    const activeStreamByPlayer = new Map();
    let nextStreamId = 1;

    function releasePlayerReservation(streamId) {
        for (const [playerId, reservedStreamId] of activeStreamByPlayer.entries()) {
            if (reservedStreamId === streamId) activeStreamByPlayer.delete(playerId);
        }
    }

    /**
     * Envía un evento al renderer principal (y a cualquier ventana secundaria
     * que pueda estar escuchando). Usa el mismo patrón que windows.js.
     */
    function sendToRenderer(channel, payload) {
        const windows = [
            context.mainWindow,
            context.encoderWindow,
            context.consoleWindow,
        ].filter(w => w && !w.isDestroyed());
        for (const win of windows) {
            try { win.webContents.send(channel, payload); } catch (_) {}
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // stream-probe — detectar formato/codec/nombre antes de reproducir
    // ─────────────────────────────────────────────────────────────────────────
    ipcMain.handle('stream-probe', async (_event, { url } = {}) => {
        if (!url || typeof url !== 'string') {
            return { format: '', codec: '', bitrate: 0, icyName: '', sampleRate: 44100, channels: 2, error: 'URL inválida.' };
        }
        const probe = new StreamProxy({ ffmpegPath, engine: rustAudioEngine, writeLog });
        return probe.probe(url.trim());
    });

    // ─────────────────────────────────────────────────────────────────────────
    // stream-url-start — iniciar retransmisión de un stream
    // ─────────────────────────────────────────────────────────────────────────
    ipcMain.handle('stream-url-start', async (_event, { url, playerId, displayName, maxRetries, prebufferSeconds } = {}) => {
        if (!url || typeof url !== 'string' || !playerId || typeof playerId !== 'string') {
            return { success: false, error: 'Parámetros inválidos: se requieren url y playerId.' };
        }
        const resolvedMaxRetries = (maxRetries != null && Number.isFinite(Number(maxRetries))) ? Number(maxRetries) : 3;
        const resolvedPrebufferSeconds = normalizePrebufferSeconds(prebufferSeconds);

        // Si ya hay un stream activo en ese playerId, detenerlo primero.
        const previousStreamId = activeStreamByPlayer.get(playerId);
        if (previousStreamId) {
            const previousProxy = activeStreams.get(previousStreamId);
            if (previousProxy) previousProxy.stop();
            activeStreams.delete(previousStreamId);
            activeStreamByPlayer.delete(playerId);
        }

        const streamId = `stream-${Date.now()}-${nextStreamId++}`;
        const proxy = new StreamProxy({ ffmpegPath, engine: rustAudioEngine, writeLog });

        proxy.on('status', (status) => {
            writeLog(`[Stream ${streamId}] Estado: ${status}`);
            sendToRenderer('stream-status', { streamId, playerId, status, displayName });
            // Limpiar mapa en estados terminales
            if (status === 'error' || status === 'max-retries') {
                // Detener antes de retirar el proxy del mapa. De lo contrario,
                // el close tardio de FFmpeg puede programar una reconexion
                // huerfana que ya no responde a stream-url-stop ni will-quit.
                try { proxy.stop(); } catch (_) {}
                activeStreams.delete(streamId);
                releasePlayerReservation(streamId);
            }
        });

        proxy.on('icy-title', (title) => {
            sendToRenderer('stream-icy-title', { streamId, playerId, title, displayName });
        });

        proxy.on('icy-name', (name) => {
            sendToRenderer('stream-icy-name', { streamId, playerId, name, displayName });
        });

        proxy.on('error', (message) => {
            writeLog(`[Stream ${streamId}] Error: ${message}`);
            sendToRenderer('stream-error', { streamId, playerId, message, displayName });
        });

        activeStreams.set(streamId, proxy);
        activeStreamByPlayer.set(playerId, streamId);
        // setImmediate garantiza que el invoke retorne (y el renderer setee
        // currentStreamId) ANTES de que proxy.start() emita los primeros
        // eventos de estado. Sin esto, 'connecting' y cualquier 'error'
        // síncrono de spawn llegan al renderer cuando currentStreamId es null
        // y son descartados silenciosamente.
        setImmediate(() => {
            if (activeStreams.has(streamId) && activeStreamByPlayer.get(playerId) === streamId) {
                proxy.start(url.trim(), playerId, resolvedMaxRetries, resolvedPrebufferSeconds);
            }
        });

        return { success: true, streamId };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // stream-url-stop — detener un stream por streamId
    // ─────────────────────────────────────────────────────────────────────────
    ipcMain.handle('stream-url-stop', async (_event, { streamId } = {}) => {
        const proxy = activeStreams.get(streamId);
        if (!proxy) {
            return { success: false, error: `Stream '${streamId}' no encontrado.` };
        }
        proxy.stop();
        activeStreams.delete(streamId);
        releasePlayerReservation(streamId);
        return { success: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // stream-url-fade-stop — fade-out en Rust + stop limpio
    //
    // Detiene FFmpeg inmediatamente (deja de enviar chunks) y manda un comando
    // `fade` al motor Rust para bajar el volumen gradualmente. Después de que
    // termina el fade, envía `stream_stop` para liberar el ring buffer.
    // Esto evita que el audio del buffer siga sonando a volumen completo.
    // ─────────────────────────────────────────────────────────────────────────
    ipcMain.handle('stream-url-fade-stop', async (_event, { streamId, fadeSeconds } = {}) => {
        const proxy = activeStreams.get(streamId);
        if (!proxy) return { success: false, error: `Stream '${streamId}' no encontrado.` };

        const safeFadeMs = Math.max(0, Number(fadeSeconds) || 0) * 1000;
        const playerId = proxy.playerId || 'stream-live';

        // Detener FFmpeg de inmediato (sin mandar stream_stop a Rust aún).
        proxy.stopFfmpegOnly();

        if (safeFadeMs > 30) {
            // Fade-out en Rust: el volumen baja gradualmente y el player
            // se detiene solo al terminar el fade (stopAfter: true).
            rustAudioEngine.command({
                cmd: 'fade',
                player: playerId,
                fromGain: 1.0,
                toGain: 0.0001,
                durationMs: Math.round(safeFadeMs),
                stopAfter: true
            }).catch(() => {});

            // Limpiar el ring buffer y el mapa de streams tras el fade.
            const cleanupTimer = setTimeout(() => {
                rustAudioEngine.send({ cmd: 'stream_stop', player: playerId });
                activeStreams.delete(streamId);
                releasePlayerReservation(streamId);
            }, safeFadeMs + 300);
            if (cleanupTimer.unref) cleanupTimer.unref();
        } else {
            // Sin fade apreciable: parada inmediata.
            rustAudioEngine.send({ cmd: 'stream_stop', player: playerId });
            activeStreams.delete(streamId);
            releasePlayerReservation(streamId);
        }

        return { success: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // stream-url-stop-player — detener el stream de un player específico
    // (útil cuando el frontend sabe el playerId pero no el streamId)
    // ─────────────────────────────────────────────────────────────────────────
    ipcMain.handle('stream-url-stop-player', async (_event, { playerId } = {}) => {
        let stopped = false;
        const streamId = activeStreamByPlayer.get(playerId);
        const proxy = streamId ? activeStreams.get(streamId) : null;
        if (proxy) {
            proxy.stop();
            activeStreams.delete(streamId);
            activeStreamByPlayer.delete(playerId);
            stopped = true;
        }
        return { success: stopped };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Limpieza cuando la app cierra
    // ─────────────────────────────────────────────────────────────────────────
    const cleanupActiveStreams = () => {
        if (!activeStreams.size && !activeStreamByPlayer.size) return;
        for (const proxy of activeStreams.values()) {
            try { proxy.stop(); } catch (_) {}
        }
        activeStreams.clear();
        activeStreamByPlayer.clear();
    };

    const { app } = context;
    if (app) {
        app.on('before-quit', cleanupActiveStreams);
        app.on('will-quit', cleanupActiveStreams);
    }
};
