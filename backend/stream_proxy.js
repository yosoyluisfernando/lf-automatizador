'use strict';

/**
 * StreamProxy — puente FFmpeg → Motor Rust para retransmisión de emisoras.
 *
 * Flujo de señal:
 *   URL remota (Icecast / SHOUTcast / HLS / MP3 directo)
 *     → FFmpeg (reconexión automática, múltiples formatos)
 *     → PCM s16le 44100 Hz estéreo (stdout de FFmpeg)
 *     → chunks base64 → stdin del motor Rust via `stream_chunk`
 *     → PcmRingSource en el deck del player Rust
 *     → master bus → parlantes + encoder tap
 *
 * ICY metadata (StreamTitle):
 *   FFmpeg escribe en su stderr líneas como:
 *     "  StreamTitle=Artista - Canción;"
 *   o (en reconexiones):
 *     "Metadata update for stream #0:0\n  StreamTitle=..."
 *   El módulo las parsea y emite evento 'icy-title'.
 *
 * Uso:
 *   const proxy = new StreamProxy({ ffmpegPath, engine, writeLog });
 *   proxy.on('status', s => ...)   // 'connecting'|'live'|'reconnecting'|'error'|'stopped'
 *   proxy.on('icy-title', title => ...)
 *   proxy.on('icy-name',  name  => ...)
 *   proxy.on('error',     msg   => ...)
 *   proxy.start('http://...', 'player-a');
 *   // ...
 *   proxy.stop();
 */

const { EventEmitter } = require('events');

// Tamaño de chunk PCM enviado a Rust: 20 ms @ 44100 Hz estéreo s16le.
// 44100 * 2 canales * 2 bytes/muestra * 0.02 s = 3528 bytes.
const PCM_CHUNK_BYTES = 3528;
const PCM_BYTES_PER_SECOND = 44100 * 2 * 2;
const MIN_PREBUFFER_SECONDS = 1;
const DEFAULT_PREBUFFER_SECONDS = 5;
const MAX_PREBUFFER_SECONDS = 15;

function normalizePrebufferSeconds(value = DEFAULT_PREBUFFER_SECONDS) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_PREBUFFER_SECONDS;
    return Math.min(MAX_PREBUFFER_SECONDS, Math.max(MIN_PREBUFFER_SECONDS, Math.round(parsed)));
}

function ringBufferSecondsForPrebuffer(value = DEFAULT_PREBUFFER_SECONDS) {
    const prebufferSeconds = normalizePrebufferSeconds(value);
    return Math.max(2, Math.ceil(prebufferSeconds * 4 / 3));
}

class StreamProxy extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string}   opts.ffmpegPath   Ruta al ejecutable ffmpeg (o 'ffmpeg').
     * @param {object}   opts.engine       Instancia de RustAudioEngineProbe.
     * @param {function} [opts.writeLog]   Función de log opcional.
     * @param {object}   [opts.cp]         Módulo child_process (inyectable en tests).
     */
    constructor({ ffmpegPath = 'ffmpeg', engine, writeLog, cp } = {}) {
        super();
        this.ffmpegPath = ffmpegPath;
        this.engine = engine;
        this.writeLog = typeof writeLog === 'function' ? writeLog : () => {};
        this._cp = cp || require('child_process');
        this._process = null;
        this._playerId = null;
        this._url = null;
        this._stopping = false;
        this._buffer = Buffer.alloc(0);
        this._status = 'stopped';
        this._icyName = '';
        this._reconnectTimer = null;
        this._startupTimer = null;
        this._retryCount = 0;
        this._maxRetries = 3; // sobreescrito en start()
        this._prebufferSeconds = DEFAULT_PREBUFFER_SECONDS;
        this._preBufferBytes = PCM_BYTES_PER_SECOND * DEFAULT_PREBUFFER_SECONDS;
        this._ringBufferSeconds = ringBufferSecondsForPrebuffer(DEFAULT_PREBUFFER_SECONDS);
        this._maxBufferBytes = PCM_BYTES_PER_SECOND * (DEFAULT_PREBUFFER_SECONDS + 5);
    }

    /** Estado actual ('connecting'|'live'|'reconnecting'|'error'|'stopped'). */
    get status() { return this._status; }

    /** URL activa. */
    get url() { return this._url; }

    /** ID del player Rust al que se inyecta audio. */
    get playerId() { return this._playerId; }

    // ─────────────────────────────────────────────────────────────────────────
    // Método público: probe (obtiene info antes de reproducir)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Obtiene metadatos del stream sin iniciarlo: formato, codec, bitrate,
     * nombre ICY, etc. Usa `ffmpeg -i` (no ffprobe, que no está incluido en
     * ffmpeg-static) y parsea el stderr que contiene la descripción del stream.
     *
     * FFmpeg escribe en stderr líneas como:
     *   Input #0, mp3, from '...':
     *   Metadata:
     *     icy-name        : Radio Example FM
     *   Stream #0:0: Audio: mp3, 44100 Hz, stereo, s16, 128 kb/s
     *
     * @param {string} url
     * @param {number} [timeoutMs=8000]
     * @returns {Promise<{format:string,codec:string,bitrate:number,icyName:string,sampleRate:number,channels:number,error:string|null}>}
     */
    probe(url, timeoutMs = 8000) {
        return new Promise((resolve) => {
            // -t 0 → conecta, lee headers/metadata, sale inmediatamente.
            // Usamos NUL (Windows) o /dev/null (Linux/Mac) como output.
            const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
            const args = [
                '-hide_banner', '-nostdin',
                '-reconnect', '1',
                '-user_agent', 'Mozilla/5.0 (compatible; LFRadio/1.0)',
                '-i', url,
                '-t', '0',          // lee solo los headers, sin decodificar
                '-f', 'null',
                nullDevice
            ];

            const result = {
                format: '',
                codec: '',
                bitrate: 0,
                icyName: '',
                sampleRate: 44100,
                channels: 2,
                error: null
            };

            let proc = null;
            let done = false;
            const finish = (err = null) => {
                if (done) return;
                done = true;
                try { proc && proc.kill('SIGKILL'); } catch (_) {}
                result.error = err;
                resolve(result);
            };

            // Matar si tarda demasiado (URL lenta o sin respuesta)
            const timer = setTimeout(() => finish(null), timeoutMs); // sin error: timeout es normal

            try {
                proc = this._cp.spawn(this.ffmpegPath, args, {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (err) {
                clearTimeout(timer);
                finish(err.message || String(err));
                return;
            }

            let stderr = '';
            proc.stdout.on('data', () => {}); // ignorar stdout (output es null)
            proc.stderr.on('data', d => {
                stderr += d.toString('utf-8');
                // En cuanto tengamos suficiente info, matar el proceso
                // (para no esperar que -t 0 drene completamente).
                if (stderr.includes('Stream #0') && stderr.includes('Audio')) {
                    clearTimeout(timer);
                    parseAndFinish();
                }
            });

            proc.on('error', err => { clearTimeout(timer); finish(err.message || String(err)); });
            proc.on('close', () => { clearTimeout(timer); parseAndFinish(); });

            function parseAndFinish() {
                if (done) return;
                // Formato: "Input #0, mp3, from '...':"
                const inputMatch = stderr.match(/Input #0,\s*([^,\n]+)/i);
                if (inputMatch) result.format = inputMatch[1].trim();

                // Stream de audio: "Stream #0:0: Audio: mp3, 44100 Hz, stereo, s16, 128 kb/s"
                const streamMatch = stderr.match(/Stream #0:\d[^:]*:\s*Audio:\s*(\w+)[^,]*,\s*(\d+)\s*Hz[^,]*,\s*(\w+)(?:.*?,\s*(\d+)\s*kb\/s)?/i);
                if (streamMatch) {
                    result.codec = streamMatch[1] || '';
                    result.sampleRate = parseInt(streamMatch[2], 10) || 44100;
                    result.channels = streamMatch[3] === 'stereo' ? 2 : streamMatch[3] === 'mono' ? 1 : (parseInt(streamMatch[3], 10) || 2);
                    if (streamMatch[4]) result.bitrate = parseInt(streamMatch[4], 10) || 0;
                }

                // ICY metadata del header: "icy-name  : Radio Name"
                const icyNameMatch = stderr.match(/icy-name\s*:\s*(.+)/i);
                if (icyNameMatch) result.icyName = icyNameMatch[1].trim();

                // Bitrate alternativo desde "bitrate: 128 kb/s"
                if (!result.bitrate) {
                    const brMatch = stderr.match(/bitrate:\s*(\d+)\s*kb\/s/i);
                    if (brMatch) result.bitrate = parseInt(brMatch[1], 10) || 0;
                }

                finish(null);
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Método público: start
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Inicia la retransmisión del stream.
     * @param {string} url       URL del stream de radio.
     * @param {string} playerId  ID del player Rust ('player-a', 'player-b', etc.).
     */
    start(url, playerId, maxRetries = 3, prebufferSeconds = DEFAULT_PREBUFFER_SECONDS) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        clearTimeout(this._startupTimer);
        this._startupTimer = null;
        if (this._process && !this._process.killed) {
            this._killProcess();
        }

        this._url = url;
        this._playerId = playerId;
        this._stopping = false;
        this._buffer = Buffer.alloc(0);
        this._retryCount = 0;
        this._maxRetries = maxRetries;
        this._prebufferSeconds = normalizePrebufferSeconds(prebufferSeconds);
        this._preBufferBytes = PCM_BYTES_PER_SECOND * this._prebufferSeconds;
        this._ringBufferSeconds = ringBufferSecondsForPrebuffer(this._prebufferSeconds);
        this._maxBufferBytes = PCM_BYTES_PER_SECOND * Math.max(
            this._ringBufferSeconds,
            this._prebufferSeconds + 5
        );
        this._setStatus('connecting');
        this._spawn();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Método público: stop
    // ─────────────────────────────────────────────────────────────────────────

    /** Detiene la retransmisión. */
    stop() {
        this._stopping = true;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        clearTimeout(this._startupTimer);
        this._startupTimer = null;
        // Señalar al motor Rust que el stream terminó (drena el ring buffer y para).
        if (this.engine && this._playerId) {
            try {
                this.engine.send({ cmd: 'stream_stop', player: this._playerId });
            } catch (_) {}
        }
        this._killProcess();
        this._setStatus('stopped');
        this._buffer = Buffer.alloc(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internos
    // ─────────────────────────────────────────────────────────────────────────

    _setStatus(s) {
        this._status = s;
        this.emit('status', s);
    }

    _spawn() {
        this._buffer = Buffer.alloc(0);
        // NOTA: stream_start se envía a Rust DESPUÉS de que el pre-buffer esté
        // lleno (ver _flushBuffer). Esto evita que Rust empiece a reproducir
        // sin datos suficientes → glitches / cortes en los primeros segundos.
        let preBufferFull = false; // se vuelve true una sola vez

        // Flags de reconexión de FFmpeg.
        // -reconnect 1               → reconecta si la conexión cae antes de empezar a leer.
        // -reconnect_streamed 1      → reconecta si cae durante la lectura (streams HTTP).
        // -reconnect_delay_max 5     → espera máx 5 s entre intentos.
        // -reconnect_at_eof 1        → util para HLS y playlists que terminan.
        // -timeout 10000000          → timeout de conexión en microsegundos (10 s).
        const args = [
            '-hide_banner', '-nostdin',
            '-v', 'verbose',          // necesario para recibir actualizaciones de StreamTitle en stderr
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-reconnect_at_eof', '1',
            '-timeout', '10000000',
            '-user_agent', 'Mozilla/5.0 (compatible; LFRadio/1.0)',
            '-i', this._url,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ar', '44100',
            '-ac', '2',
            '-f', 's16le',
            'pipe:1'
        ];

        let proc;
        try {
            proc = this._cp.spawn(this.ffmpegPath, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            this.writeLog(`[StreamProxy] No se pudo lanzar FFmpeg: ${err.message || err}`);
            this.emit('error', `No se pudo lanzar FFmpeg: ${err.message || err}`);
            this._setStatus('error');
            return;
        }

        this._process = proc;

        // ── Leer PCM del stdout y bombear al motor Rust ──────────────────────
        proc.stdout.on('data', (chunk) => {
            if (this._stopping || this._process !== proc) return;
            // Protección contra buffer desbordado
            if (this._buffer.length + chunk.length > this._maxBufferBytes) {
                const excess = (this._buffer.length + chunk.length) - this._maxBufferBytes;
                this._buffer = this._buffer.slice(excess);
            }
            this._buffer = Buffer.concat([this._buffer, chunk]);

            // Pre-buffer: no enviar a Rust hasta tener suficiente audio acumulado.
            // Esto garantiza que el ring buffer de Rust esté lleno desde el inicio.
            if (!preBufferFull) {
                if (this._buffer.length < this._preBufferBytes) return; // seguir acumulando
                preBufferFull = true;
                // Activar el deck en Rust ANTES de enviar los chunks
                if (this.engine && this._playerId) {
                    try {
                        this.engine.command({
                            cmd: 'stream_start',
                            player: this._playerId,
                            bus: 'master',
                            sampleRate: 44100,
                            channels: 2,
                            gain: 1.0,
                            ringBufferSeconds: this._ringBufferSeconds
                        }).catch(() => {});
                    } catch (_) {}
                }
                // Rust prepara el player pausado. El orden del pipe stdin garantiza
                // que stream_play llegue despues de todos los chunks precargados.
                this._flushBuffer();
                if (this.engine && this._playerId) {
                    this.engine.send({ cmd: 'stream_play', player: this._playerId });
                }
                this._setStatus('live');
                return;
            }

            this._flushBuffer();
        });

        // ── Parsear ICY metadata del stderr de FFmpeg ─────────────────────────
        let stderrAccum = '';
        proc.stderr.on('data', (chunk) => {
            if (this._stopping || this._process !== proc) return;
            stderrAccum += chunk.toString('utf-8');
            // Procesar líneas completas
            let newlineIdx;
            while ((newlineIdx = stderrAccum.indexOf('\n')) !== -1) {
                const line = stderrAccum.slice(0, newlineIdx).trim();
                stderrAccum = stderrAccum.slice(newlineIdx + 1);
                this._parseStderrLine(line);
            }
        });

        proc.on('error', (err) => {
            if (this._stopping || this._process !== proc) return;
            const msg = err.message || String(err);
            this.writeLog(`[StreamProxy] Error FFmpeg: ${msg}`);
            this.emit('error', msg);
            this._setStatus('error');
        });

        proc.on('close', (code) => {
            if (this._stopping || this._process !== proc) return;
            clearTimeout(this._startupTimer);
            this._startupTimer = null;
            this._process = null;
            this._retryCount++;

            if (this._maxRetries >= 0 && this._retryCount > this._maxRetries) {
                this.writeLog(`[StreamProxy] Máx. reintentos (${this._maxRetries}) alcanzados. Deteniendo stream.`);
                this._setStatus('max-retries');
                return;
            }

            this.writeLog(`[StreamProxy] FFmpeg cerró (código ${code}), reintento ${this._retryCount}/${this._maxRetries < 0 ? '∞' : this._maxRetries} en 3 s…`);
            this._setStatus('reconnecting');
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                if (!this._stopping) this._spawn();
            }, 3000);
        });
    }

    _flushBuffer() {
        while (this._buffer.length >= PCM_CHUNK_BYTES && !this._stopping) {
            const chunk = this._buffer.slice(0, PCM_CHUNK_BYTES);
            this._buffer = this._buffer.slice(PCM_CHUNK_BYTES);
            const b64 = chunk.toString('base64');
            if (this.engine && this._playerId) {
                this.engine.send({ cmd: 'stream_chunk', player: this._playerId, data: b64 });
            }
        }
    }

    _parseStderrLine(line) {
        // StreamTitle aparece en dos formatos según la versión de FFmpeg y el momento:
        //
        // Formato A — actualización dinámica (-v verbose):
        //   [icy @ 0x...] StreamTitle=Artista - Canción;
        //   StreamTitle=Artista - Canción;StreamUrl=;
        //
        // Formato B — bloque Metadata inicial (-v info):
        //   StreamTitle     : Artista - Canción
        //   StreamTitle     : Artista - Canción;StreamUrl=;
        //
        // El regex cubre ambos con (?:=|:)\s* entre la clave y el valor.
        const titleMatch = line.match(/StreamTitle\s*(?:[=:])\s*([^;\r\n]+)/i);
        if (titleMatch) {
            const title = titleMatch[1].trim().replace(/^['"]|['"]$/g, '').replace(/;.*$/, '').trim();
            if (title) this.emit('icy-title', title);
        }
        // icy-name en la conexión inicial (ambos formatos)
        const nameMatch = line.match(/icy-name\s*(?:[=:])\s*(.+)/i);
        if (nameMatch) {
            const name = nameMatch[1].trim().replace(/;.*$/, '').trim();
            if (name && name !== this._icyName) {
                this._icyName = name;
                this.emit('icy-name', name);
            }
        }
    }

    _killProcess() {
        const proc = this._process;
        this._process = null;
        if (proc && !proc.killed) {
            let closed = false;
            let killTimer = null;
            proc.once('close', () => {
                closed = true;
                clearTimeout(killTimer);
            });
            try {
                proc.kill('SIGTERM');
                killTimer = setTimeout(() => {
                    if (closed) return;
                    try { proc.kill('SIGKILL'); } catch (_) {}
                }, 500);
                if (typeof killTimer.unref === 'function') killTimer.unref();
            } catch (_) {
                try { proc.kill('SIGKILL'); } catch (_2) {}
            }
        }
    }
}

module.exports = {
    StreamProxy,
    PCM_BYTES_PER_SECOND,
    normalizePrebufferSeconds,
    ringBufferSecondsForPrebuffer,
};
