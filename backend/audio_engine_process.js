const fs = require('fs');
const path = require('path');
const readline = require('readline');

function resolveRustAudioEnginePath(rootDir) {
    const baseDir = path.resolve(rootDir);
    // Cross-Platform: en Windows el binario lleva .exe, en Linux no tiene extensión.
    const ext = process.platform === 'win32' ? '.exe' : '';
    const resourcesDir = process.resourcesPath ? path.resolve(process.resourcesPath) : '';

    // BUG FIX: Electron parcha fs.existsSync para que devuelva true en rutas dentro
    // de app.asar (sistema de archivos virtual). Sin embargo, child_process.spawn()
    // NO usa ese parche — va directo al SO y lanza ENOENT si la ruta apunta a dentro
    // del .asar. Por eso NUNCA incluimos candidatos con "app.asar" sin ".unpacked".
    // Se usa orden de prioridad fijo (no sort por mtime) para garantizar que
    // extraResources (resources/bin/) siempre gane sobre asarUnpack.
    const isPackaged = baseDir.includes('app.asar');
    // Convierte cualquier ruta app.asar/… → app.asar.unpacked/… (ruta real en disco).
    const toUnpacked = p => p.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked');

    const candidates = [
        // Prioridad 1 — extraResources: resources/bin/  (siempre la ubicación canónica)
        resourcesDir ? path.join(resourcesDir, 'bin', `lf-audio-engine${ext}`) : '',
        resourcesDir ? path.join(resourcesDir, 'bin', `lf-audio-engine-debug${ext}`) : '',
        // Prioridad 2 — asarUnpack: app.asar.unpacked/bin/  (sólo en build empaquetado)
        isPackaged ? toUnpacked(path.join(baseDir, 'bin', `lf-audio-engine${ext}`)) : '',
        isPackaged ? toUnpacked(path.join(baseDir, 'bin', `lf-audio-engine-debug${ext}`)) : '',
        // Prioridad 3 — entorno de desarrollo (sólo cuando baseDir no está dentro de asar)
        !isPackaged ? path.join(baseDir, 'bin', `lf-audio-engine${ext}`) : '',
        !isPackaged ? path.join(baseDir, 'bin', `lf-audio-engine-debug${ext}`) : '',
        !isPackaged ? path.join(baseDir, 'audio-engine-rust', 'target', 'release', `lf-audio-engine${ext}`) : '',
        !isPackaged ? path.join(baseDir, 'audio-engine-rust', 'target', 'debug', `lf-audio-engine${ext}`) : '',
    ].filter(Boolean);

    // Primer candidato que exista en el sistema de archivos REAL.
    // NO se ordena por mtime — el orden de prioridad ya es el correcto.
    const found = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } });
    return found || candidates[0] || '';
}


function isBenignRustStderr(message = '') {
    return String(message).includes('Dropping DeviceSink, audio playing through this sink will stop');
}

const REPORT_MAX_BYTES = 5 * 1024 * 1024;
const REPORT_KEEP_BYTES = 1024 * 1024;
const ROUTINE_STATUS_LOG_INTERVAL_MS = 30000;

class RustAudioEngineProbe {
    constructor({ rootDir, cp, writeLog, onEngineEvent } = {}) {
        this.rootDir = rootDir || path.join(__dirname, '..');
        this.cp = cp || require('child_process');
        this.writeLog = typeof writeLog === 'function' ? writeLog : () => {};
        // Callback opcional para eventos asíncronos del motor que no son
        // respuesta directa a un comando (p.ej. `timeLocutionStarted`,
        // `timeLocutionEnded`). main.js los reenvía al renderer vía IPC para
        // que el frontend reaccione sin tener que orquestar nada por sí mismo.
        this.onEngineEvent = typeof onEngineEvent === 'function' ? onEngineEvent : null;
        this.exePath = resolveRustAudioEnginePath(this.rootDir);
        this.reportPath = path.join(this.rootDir, 'config', 'audio_engine_report.jsonl');
        this.process = null;
        this.readline = null;
        this.pending = [];
        this.pendingByRequestId = new Map();
        this.nextRequestId = 1;
        this.lastStatus = null;
        this.lastDevices = null;
        this.lastError = '';
        this.lastMessageAt = 0;
        this.lastStatusAt = 0;
        this.recoveryPromise = null;
        this.lastRoutineStatusLogAt = 0;
        this.lastRoutineCommandLogAt = 0;
        this.startedAt = null;
        this.stopping = false;
        // FASE D · sub-paso 8.2 — Tap del encoder directo desde Rust.
        // Cuando el lado JS arranca el encoder, llama attachPcmConsumer(cb)
        // y el probe envía `encoderTap { enable: true }` al motor. Cada
        // PushTick (20 ms) el motor emite un mensaje `pcmChunk` con base64
        // del PCM s16le acumulado. handleLine lo decodifica y se lo entrega
        // al callback registrado. Eso reemplaza al viejo RustPcmBridgeEncoderSource
        // (que estaba referenciado pero nunca implementado).
        this.pcmConsumer = null;
        this.pcmSession = null;
        this.pcmFirstChunkWaiter = null;
        this.pcmWatchdog = null;
        this.processGeneration = 0;
        this.nextPcmSessionId = 1;
        this.lastEncoderTapDroppedSamples = 0;
        try { fs.mkdirSync(path.dirname(this.reportPath), { recursive: true }); } catch (err) {}
    }

    logEvent(type, data = {}) {
        if (type === 'command' && data.command?.cmd === 'encoder' && data.command?.action === 'status') {
            return;
        }
        if (type === 'command' && this.isRoutineCommand(data.command)) {
            const now = Date.now();
            if (now - this.lastRoutineCommandLogAt < ROUTINE_STATUS_LOG_INTERVAL_MS) return;
            this.lastRoutineCommandLogAt = now;
        }
        if (type === 'message' && this.isRoutineStatusMessage(data.message)) {
            const now = Date.now();
            if (now - this.lastRoutineStatusLogAt < ROUTINE_STATUS_LOG_INTERVAL_MS) return;
            this.lastRoutineStatusLogAt = now;
        }
        this.rotateReportIfNeeded();
        const entry = {
            at: new Date().toISOString(),
            type,
            engine: 'rustAudio',
            pid: this.process?.pid || null,
            ...data
        };
        try {
            fs.appendFileSync(this.reportPath, `${JSON.stringify(entry)}\n`, 'utf-8');
        } catch (err) {}
    }

    isRoutineCommand(command = {}) {
        if (!command || typeof command !== 'object') return false;
        if (command.cmd === 'transport' || command.cmd === 'status') return true;
        if (command.cmd === 'encoder' && command.action === 'status') return true;
        return false;
    }

    isRoutineStatusMessage(message = {}) {
        return message?.type === 'status';
    }

    rotateReportIfNeeded() {
        try {
            if (!fs.existsSync(this.reportPath)) return;
            const stat = fs.statSync(this.reportPath);
            if (stat.size <= REPORT_MAX_BYTES) return;
            const keepBytes = Math.min(REPORT_KEEP_BYTES, stat.size);
            const fd = fs.openSync(this.reportPath, 'r');
            const buffer = Buffer.alloc(keepBytes);
            fs.readSync(fd, buffer, 0, keepBytes, stat.size - keepBytes);
            fs.closeSync(fd);
            let tail = buffer.toString('utf-8');
            const firstNewline = tail.indexOf('\n');
            if (firstNewline >= 0) tail = tail.slice(firstNewline + 1);
            const marker = {
                at: new Date().toISOString(),
                type: 'report-rotated',
                engine: 'rustAudio',
                previousBytes: stat.size,
                keptBytes: Buffer.byteLength(tail, 'utf-8')
            };
            fs.writeFileSync(this.reportPath, `${JSON.stringify(marker)}\n${tail}`, 'utf-8');
        } catch (err) {}
    }

    isAvailable() {
        return fs.existsSync(this.exePath);
    }

    isRunning() {
        return !!(this.process && !this.process.killed && this.process.exitCode === null);
    }

    start() {
        if (this.isRunning()) return { success: true, alreadyRunning: true };
        if (!this.isAvailable()) {
            this.lastError = `No existe ${this.exePath}`;
            return { success: false, error: this.lastError };
        }

        try {
            this.process = this.cp.spawn(this.exePath, [], {
                cwd: path.dirname(this.exePath),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.startedAt = Date.now();
            const processGeneration = ++this.processGeneration;
            this.lastError = '';
            this.stopping = false;
            this.logEvent('start', { exePath: this.exePath });

            this.readline = readline.createInterface({ input: this.process.stdout });
            this.readline.on('line', line => this.handleLine(line, processGeneration));
            this.process.stderr.on('data', chunk => {
                if (processGeneration !== this.processGeneration) return;
                const stderrText = String(chunk || '').trim();
                if (!stderrText) return;
                if (isBenignRustStderr(stderrText)) {
                    this.logEvent('stderr-info', { message: stderrText });
                    return;
                }
                this.lastError = stderrText;
                this.writeLog(`[RustAudio] ${this.lastError}`);
                this.logEvent('stderr', { error: this.lastError });
            });
            this.process.on('error', err => {
                if (processGeneration !== this.processGeneration) return;
                this.lastError = err.message || String(err);
                this.logEvent('process-error', { error: this.lastError });
                this.rejectPending(this.lastError);
            });
            this.process.on('close', code => {
                if (processGeneration !== this.processGeneration) return;
                this.lastError = (code === 0 || this.stopping) ? '' : `Proceso RustAudio cerrado con codigo ${code}`;
                this.logEvent('close', { code, error: this.lastError });
                this.rejectPending(this.lastError || 'Proceso RustAudio cerrado.');
                this.process = null;
                this.readline = null;
                this.invalidatePcmSession();
            });
            return { success: true, started: true };
        } catch (err) {
            this.lastError = err.message || String(err);
            this.process = null;
            return { success: false, error: this.lastError };
        }
    }

    stop() {
        if (!this.process) return { success: true, stopped: false };
        const pid = this.process.pid;
        try {
            this.stopping = true;
            this.process.kill();
        } catch (err) {}
        // En Windows, kill() sólo envía TerminateProcess al proceso raíz.
        // taskkill /F /T garantiza que el árbol completo (incluyendo hilos de
        // audio WASAPI) cierre y libere la tarjeta de sonido antes de que una
        // nueva instancia intente abrirla.
        if (process.platform === 'win32' && pid) {
            try {
                require('child_process').execSync(
                    `taskkill /F /T /PID ${pid}`,
                    { windowsHide: true, timeout: 3000 }
                );
            } catch (_) {}
        }
        this.logEvent('stop');
        this.process = null;
        this.readline = null;
        this.invalidatePcmSession();
        this.rejectPending('Proceso RustAudio detenido.');
        return { success: true, stopped: true };
    }

    // ─── FASE D · sub-paso 8.2 — Tap PCM del encoder ─────────────────────
    //
    // attachPcmConsumer(cb): registra el callback que recibirá chunks PCM
    // s16le del bus encoder. Manda `encoderTap { enable: true }` al motor,
    // que empieza a drenar el ring del encoder en cada PushTick y a emitir
    // mensajes `pcmChunk` por stdout. handleLine los decodifica y se los
    // entrega al callback (típicamente `chunk => ffmpeg.stdin.write(chunk)`).
    //
    // detachPcmConsumer(): apaga el envío y limpia el callback.
    //
    // isPcmTapMode(): retorna true si hay consumer activo (compatibilidad
    // con el código existente en windows.js que pregunta esto para decidir
    // el path de inicialización del encoder).
    async attachPcmConsumer(callback, options = {}) {
        if (typeof callback !== 'function') return { success: false, error: 'Consumer PCM invalido.' };
        this.invalidatePcmSession();
        const sessionId = `pcm-${this.processGeneration}-${this.nextPcmSessionId++}`;
        const session = {
            id: sessionId,
            generation: this.processGeneration,
            ready: false,
            lastChunkAt: 0,
            stalled: false,
        };
        this.pcmConsumer = callback;
        this.pcmSession = session;
        this.lastEncoderTapDroppedSamples = 0;
        const ack = await this.command({ cmd: 'encoderTap', enable: true });
        if (!ack?.success || this.pcmSession !== session) {
            if (this.pcmSession === session) {
                this.invalidatePcmSession();
                this.disablePcmTapBestEffort();
            }
            return { success: false, error: ack?.error || 'RustAudio no confirmo el tap PCM.' };
        }
        const tap = ack.message?.encoder?.tap;
        if (!tap?.active || !tap?.ready) {
            if (this.pcmSession === session) {
                this.invalidatePcmSession();
                this.disablePcmTapBestEffort();
            }
            return { success: false, error: 'RustAudio confirmo el comando, pero el tap PCM no esta listo.' };
        }
        const firstChunkTimeoutMs = Math.max(1, Number(options.firstChunkTimeoutMs) || 1000);
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                if (this.pcmFirstChunkWaiter?.session === session) this.pcmFirstChunkWaiter = null;
                if (this.pcmSession === session) {
                    this.invalidatePcmSession();
                    this.disablePcmTapBestEffort();
                }
                resolve({ success: false, error: 'Timeout esperando el primer bloque PCM del tap RustAudio.' });
            }, firstChunkTimeoutMs);
            this.pcmFirstChunkWaiter = {
                session,
                timeout,
                reject: error => {
                    clearTimeout(timeout);
                    this.pcmFirstChunkWaiter = null;
                    resolve({ success: false, error });
                },
                resolve: () => {
                    clearTimeout(timeout);
                    this.pcmFirstChunkWaiter = null;
                    session.ready = true;
                    this.armPcmWatchdog(session);
                    resolve({ success: true, sessionId });
                },
            };
        });
    }

    detachPcmConsumer() {
        if (!this.pcmConsumer && !this.pcmSession) return;
        this.invalidatePcmSession();
        this.disablePcmTapBestEffort();
    }

    isPcmTapMode() {
        return this.isPcmConsumerAttached();
    }

    isPcmConsumerAttached(sessionId = '') {
        return !!(
            this.pcmConsumer
            && this.pcmSession?.ready
            && this.pcmSession.generation === this.processGeneration
            && (!sessionId || this.pcmSession.id === sessionId)
        );
    }

    invalidatePcmSession(reason = 'Sesion PCM cancelada.') {
        const waiter = this.pcmFirstChunkWaiter;
        if (waiter) waiter.reject(reason);
        if (this.pcmWatchdog) clearInterval(this.pcmWatchdog);
        this.pcmWatchdog = null;
        this.pcmConsumer = null;
        this.pcmSession = null;
    }

    disablePcmTapBestEffort() {
        this.command({ cmd: 'encoderTap', enable: false }).catch(() => {});
    }

    armPcmWatchdog(session) {
        if (this.pcmWatchdog) clearInterval(this.pcmWatchdog);
        this.pcmWatchdog = setInterval(() => {
            if (this.pcmSession !== session || !session.ready || !session.lastChunkAt) return;
            if (Date.now() - session.lastChunkAt < 5000 || session.stalled) return;
            session.stalled = true;
            this.writeLog('RustAudio encoder tap: no llegan bloques PCM desde hace mas de 5 s.');
            this.logEvent('encoder-tap-stalled', { sessionId: session.id, lastChunkAt: session.lastChunkAt });
        }, 1000);
        this.pcmWatchdog.unref?.();
    }

    handleLine(line, processGeneration = this.processGeneration) {
        if (processGeneration !== this.processGeneration) return;
        this.lastMessageAt = Date.now();
        let message = null;
        try {
            message = JSON.parse(line);
        } catch (err) {
            this.lastError = `Respuesta RustAudio invalida: ${line}`;
            this.logEvent('parse-error', { line });
            return;
        }
        // FASE D · sub-paso 8.2: chunks PCM del bus encoder. Llegan en cada
        // PushTick (20 ms) si encoder_tap_active=true en Rust. NO van por
        // pending ni se loguean al jsonl (volumen alto: ~10/s). Se decodifican
        // y se entregan al callback registrado por attachPcmConsumer.
        if (message?.type === 'pcmChunk') {
            if (this.pcmConsumer && typeof message.pcm === 'string') {
                try {
                    const buf = Buffer.from(message.pcm, 'base64');
                    if (this.pcmSession) {
                        this.pcmSession.lastChunkAt = Date.now();
                        this.pcmSession.stalled = false;
                    }
                    this.pcmConsumer(buf);
                    if (this.pcmFirstChunkWaiter?.session === this.pcmSession) {
                        this.pcmFirstChunkWaiter.resolve();
                    }
                } catch (err) {
                    this.lastError = `pcmChunk decode: ${err.message || err}`;
                }
            }
            return;
        }
        const pending = message.type === 'ready' ? null : this.takePendingForMessage(message);
        if (message.type === 'status' || message.type === 'ready') {
            if (message.type === 'status') this.lastStatusAt = Date.now();
            const droppedSamples = Number(message.encoder?.tap?.droppedSamples);
            if (Number.isFinite(droppedSamples)) {
                const previousDroppedSamples = Number(this.lastEncoderTapDroppedSamples) || 0;
                if (droppedSamples > previousDroppedSamples) {
                    const delta = droppedSamples - previousDroppedSamples;
                    this.writeLog(`RustAudio encoder tap perdio ${delta} muestras PCM (total sesion=${droppedSamples}).`);
                    this.logEvent('encoder-tap-drops', { droppedSamples, delta });
                }
                this.lastEncoderTapDroppedSamples = droppedSamples;
            }
            this.lastStatus = message;
            this.lastError = '';
        } else if (message.type === 'devices') {
            this.lastDevices = message;
            this.lastError = '';
        } else if (message.type === 'error') {
            this.lastError = message.message || 'RustAudio reporto error.';
        }
        this.logEvent('message', { message });
        // Eventos asíncronos del motor: tipos que NO son respuesta directa al
        // último comando. Se reenvían al renderer vía onEngineEvent. Si además
        // arrastran el requestId del comando original (como `timeLocutionStarted`),
        // dejamos que el flujo normal de pending también los resuelva.
        //
        // Caso especial PUSH STATUS: cuando el motor emite `status` por su
        // propio bucle de 100 ms (sin que nadie lo pidió), `pending` viene
        // vacío. Lo reenviamos al renderer por el mismo canal para apagar
        // el polling agresivo (filosofía "humilde control remoto").
        const isPushStatus = message?.type === 'status' && !pending;
        const isAsyncEvent = message?.type && message.type !== 'status' && message.type !== 'devices' && message.type !== 'error' && message.type !== 'ready' && message.type !== 'peaks';
        if (this.onEngineEvent && (isPushStatus || isAsyncEvent)) {
            try { this.onEngineEvent(message); } catch (err) {}
        }
        if (message.type === 'ready') return;
        if (pending) {
            clearTimeout(pending.timeout);
            if (message.type === 'error') {
                pending.resolve({ success: false, error: message.message || 'RustAudio reporto error.', message, status: this.lastStatus });
            } else {
                pending.resolve({ success: true, message, status: this.lastStatus });
            }
        }
    }

    takePendingForMessage(message = {}) {
        const requestId = message.requestId || '';
        if (requestId && this.pendingByRequestId.has(requestId)) {
            const pending = this.pendingByRequestId.get(requestId);
            this.pendingByRequestId.delete(requestId);
            this.pending = this.pending.filter(item => item !== pending);
            return pending;
        }
        if (requestId) return null;
        // FIX BUG CRÍTICO (editor abre vacío sin caché de peaks): los mensajes
        // PUSH del motor llegan sin `requestId` — son emitidos espontáneamente
        // por el bucle de 100 ms (`status`), por el tap del encoder (`pcmChunk`)
        // o por eventos asíncronos (`timeLocutionEnded`/`timeLocutionStarted`).
        // Si tomáramos el primer pending de la cola con uno de estos, lo
        // resolveríamos con la respuesta equivocada — el frontend recibiría
        // `success: true` con un mensaje de tipo distinto al que esperaba,
        // dejando `message.min/max/bins` en undefined.
        //
        // Ejemplo del bug: 3 `getPeaks` en cola, llega un `status` push antes
        // de que termine la decodificación → `takePendingForMessage` lo asigna
        // al primer pending → el frontend hace `new Float32Array(undefined)`
        // y obtiene un buffer vacío → editor abre con pistas en blanco.
        //
        // Los mensajes PUSH se manejan por separado vía `onEngineEvent` y
        // `this.lastStatus`/`this.lastDevices`. NO deben tocar la cola pending.
        if (message.type === 'status') return null;
        if (message.type === 'devices' && !requestId) return null;
        if (message.type === 'pcmChunk') return null;
        if (message.type === 'timeLocutionEnded') return null;
        if (message.type === 'timeLocutionStarted') return null;
        if (message.type === 'playlistAction') return null;
        if (message.type === 'playlistModeChanged') return null;
        if (message.type === 'stream_ready') return null;
        if (message.type === 'stream_stopped') return null;
        const pending = this.pending.shift();
        if (pending?.requestId) this.pendingByRequestId.delete(pending.requestId);
        return pending || null;
    }

    rejectPending(error) {
        const pendingItems = this.pending.splice(0);
        this.pendingByRequestId.clear();
        pendingItems.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.resolve({ success: false, error });
        });
    }

    /**
     * Escribe un comando en stdin del motor sin esperar respuesta (fire-and-forget).
     * Uso típico: `stream_chunk` (alta frecuencia, ~50/s) donde Rust no emite reply.
     * Devuelve true si se escribió, false si el motor no está corriendo.
     */
    send(command = {}) {
        if (!this.isRunning()) return false;
        try {
            this.process.stdin.write(`${JSON.stringify(command)}\n`);
            return true;
        } catch (_) {
            return false;
        }
    }

    command(command = {}, timeoutMs = null) {
        const started = this.start();
        if (!started.success) return Promise.resolve(started);
        // getPeaks decodifica el audio completo; necesita más tiempo que el default de 3 s.
        // El caller puede pasar _timeoutMs en el objeto comando o como segundo argumento.
        const effectiveTimeout = timeoutMs
            ?? command._timeoutMs
            ?? (command.cmd === 'getPeaks' ? 20000 : 3000);
        return new Promise(resolve => {
            const requestId = command.requestId || `rust-${Date.now()}-${this.nextRequestId++}`;
            // Extraer _timeoutMs para no enviarlo al proceso Rust
            const { _timeoutMs: _omit, ...commandClean } = command;
            const commandWithRequestId = { ...commandClean, requestId };
            const timeout = setTimeout(() => {
                this.pending = this.pending.filter(item => item.resolve !== resolve);
                this.pendingByRequestId.delete(requestId);
                const now = Date.now();
                const diagnostics = {
                    command: commandWithRequestId.cmd || '',
                    player: commandWithRequestId.player || '',
                    requestId,
                    pid: this.process?.pid || null,
                    pendingCount: this.pending.length,
                    lastMessageAgeMs: this.lastMessageAt ? now - this.lastMessageAt : null,
                    lastStatusAgeMs: this.lastStatusAt ? now - this.lastStatusAt : null,
                };
                this.lastError = 'Timeout esperando respuesta RustAudio.';
                this.writeLog(`[RustAudio] Timeout global: cmd=${diagnostics.command || 'desconocido'}, player=${diagnostics.player || 'n/a'}, pendientes=${diagnostics.pendingCount}, ultimoStatusMs=${diagnostics.lastStatusAgeMs ?? 'n/a'}.`);
                this.logEvent('command-timeout', diagnostics);
                resolve({ success: false, error: this.lastError, engineUnresponsive: true, diagnostics });
            }, effectiveTimeout);
            const pending = { resolve, timeout, command: commandWithRequestId, requestId };
            this.pending.push(pending);
            this.pendingByRequestId.set(requestId, pending);
            try {
                this.logEvent('command', { command: commandWithRequestId });
                this.process.stdin.write(`${JSON.stringify(commandWithRequestId)}\n`);
            } catch (err) {
                clearTimeout(timeout);
                this.pending = this.pending.filter(item => item.resolve !== resolve);
                this.pendingByRequestId.delete(requestId);
                this.logEvent('command-error', { command: commandWithRequestId, error: err.message || String(err) });
                resolve({ success: false, error: err.message || String(err) });
            }
        });
    }

    waitForFreshStatus(since = Date.now(), timeoutMs = 1500) {
        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1500);
        return new Promise(resolve => {
            const check = () => {
                if (this.lastStatusAt > since) return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(check, 25);
            };
            check();
        });
    }

    recover(reason = 'Recuperacion solicitada.') {
        if (this.recoveryPromise) return this.recoveryPromise;
        this.recoveryPromise = (async () => {
            const pcmConsumer = this.isPcmConsumerAttached() ? this.pcmConsumer : null;
            this.writeLog(`[RustAudio] Reiniciando motor: ${reason}`);
            this.logEvent('recovery-start', { reason });
            this.stop();
            await new Promise(resolve => setTimeout(resolve, 150));
            const started = this.start();
            if (!started.success) {
                this.logEvent('recovery-failed', { reason, error: started.error });
                return started;
            }
            const result = await this.command({ cmd: 'status', recovery: true }, 5000);
            if (!result?.success) {
                this.logEvent('recovery-failed', { reason, error: result?.error || '' });
                return result;
            }
            let pcmRestored = false;
            if (pcmConsumer) {
                const attached = await this.attachPcmConsumer(pcmConsumer, { firstChunkTimeoutMs: 2500 });
                if (!attached?.success) {
                    this.logEvent('recovery-failed', { reason, error: attached?.error || 'No se restauro tap PCM.' });
                    return { success: false, error: attached?.error || 'RustAudio no restauro el tap PCM del encoder.' };
                }
                pcmRestored = true;
            }
            this.logEvent('recovery-ready', { reason, pcmRestored });
            return { success: true, recovered: true, pcmRestored, status: result.status || result.message };
        })().finally(() => {
            this.recoveryPromise = null;
        });
        return this.recoveryPromise;
    }

    readReportTail(maxLines = 30) {
        const limit = Math.max(1, Math.min(200, Number(maxLines) || 30));
        try {
            if (!fs.existsSync(this.reportPath)) {
                return { success: true, reportPath: this.reportPath, entries: [] };
            }
            const lines = fs.readFileSync(this.reportPath, 'utf-8')
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-limit);
            const entries = lines.map(line => {
                try { return JSON.parse(line); } catch (err) { return { raw: line }; }
            });
            return { success: true, reportPath: this.reportPath, entries };
        } catch (err) {
            return { success: false, reportPath: this.reportPath, error: err.message || String(err), entries: [] };
        }
    }

    writeDiagnosticsSnapshot(extra = {}) {
        const snapshotPath = path.join(this.rootDir, 'config', 'audio_engine_snapshot.json');
        const snapshot = {
            at: new Date().toISOString(),
            engine: 'rustAudio',
            available: this.isAvailable(),
            running: this.isRunning(),
            exePath: this.exePath,
            reportPath: this.reportPath,
            lastStatus: this.lastStatus,
            lastDevices: this.lastDevices,
            lastError: this.lastError,
            lastMessageAt: this.lastMessageAt,
            lastStatusAt: this.lastStatusAt,
            ...extra
        };
        try {
            fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
            this.logEvent('snapshot', { snapshotPath });
            return { success: true, snapshotPath, snapshot };
        } catch (err) {
            return { success: false, snapshotPath, error: err.message || String(err), snapshot };
        }
    }

    status() {
        return {
            available: this.isAvailable(),
            running: this.isRunning(),
            exePath: this.exePath,
            startedAt: this.startedAt,
            lastStatus: this.lastStatus,
            lastDevices: this.lastDevices,
            lastError: this.lastError,
            reportPath: this.reportPath,
            snapshotPath: path.join(this.rootDir, 'config', 'audio_engine_snapshot.json')
        };
    }
}

module.exports = {
    RustAudioEngineProbe,
    resolveRustAudioEnginePath
};
