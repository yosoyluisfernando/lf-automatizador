const { ipcRenderer } = require('electron');
const path = require('path');

// ─── Referencias a elementos de la interfaz ───────────────────────────────────
const titleEl       = document.getElementById('preview-title');
const progressBg    = document.getElementById('preview-progress-bg');
const progressFill  = document.getElementById('preview-progress-fill');
const currentEl     = document.getElementById('preview-current');
const totalEl       = document.getElementById('preview-total');
const btnStop       = document.getElementById('btn-preview-stop');

// Nota: el elemento <audio> del HTML se deja inerte; toda la reproducción
// pasa ahora por el motor Rust → bus cue → tarjeta de sonido de pre-escucha.

// ─── Estado de reproducción ───────────────────────────────────────────────────
let duracionTotal   = 0;        // duración de la pista en segundos (llega de getPeaks)
let iniciandoMs     = 0;        // performance.now() en el instante exacto de arranque
let timerProgreso   = null;     // handle del setInterval que anima la barra
let cacheDirEditor  = '';       // ruta de la carpeta de caché de peaks

// Obtener la carpeta de caché al arrancar (misma que usan los editores avanzados)
ipcRenderer.invoke('get-cache-dir')
    .then(r => { if (r?.success) cacheDirEditor = r.cacheDir; })
    .catch(() => {});

// ─── Enviar comando al motor Rust ─────────────────────────────────────────────
function rustCmd(payload) {
    return ipcRenderer.invoke('audio-engine-rust-command', payload).catch(() => {});
}

// ─── Formatear segundos → mm:ss ───────────────────────────────────────────────
function formatearTiempo(segundos) {
    if (!isFinite(segundos) || segundos < 0) return '00:00';
    const m = Math.floor(segundos / 60).toString().padStart(2, '0');
    const s = Math.floor(segundos % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// ─── Tick de animación de la barra de progreso ────────────────────────────────
function tickProgreso() {
    const transcurrido = (performance.now() - iniciandoMs) / 1000;
    currentEl.innerText = formatearTiempo(transcurrido);

    if (duracionTotal > 0) {
        const pct = Math.min(1, transcurrido / duracionTotal) * 100;
        progressFill.style.width = `${pct}%`;
        // Cerrar automáticamente cuando termina la pista
        if (transcurrido >= duracionTotal) {
            detener();
            window.close();
        }
    } else {
        // Todavía esperando la duración del motor Rust
        progressFill.style.width = '0%';
    }
}

// ─── Detener reproducción y cancelar animación ────────────────────────────────
function detener() {
    if (timerProgreso) {
        clearInterval(timerProgreso);
        timerProgreso = null;
    }
    rustCmd({ cmd: 'stop', player: 'cue-player' });
}

// ─── Reproducir una pista por el bus de pre-escucha ───────────────────────────
async function reproducir(rutaArchivo) {
    duracionTotal = 0;
    iniciandoMs   = performance.now();

    // Actualizar título y resetear barra
    titleEl.innerText       = path.basename(rutaArchivo);
    titleEl.style.color     = '#ffffff';
    progressFill.style.width = '0%';
    currentEl.innerText     = '00:00';
    totalEl.innerText       = '--:--';

    // Parar cualquier pista que estuviera sonando
    await rustCmd({ cmd: 'stop', player: 'cue-player' });

    // Cargar y reproducir por el bus cue (pre-escucha independiente)
    await rustCmd({ cmd: 'loadAudio', player: 'cue-player', path: rutaArchivo, gain: 1.0, bus: 'cue' });
    await rustCmd({ cmd: 'play',      player: 'cue-player' });
    // Reajustar el origen de tiempo tras la latencia de IPC
    iniciandoMs = performance.now();

    // Iniciar animación de barra de progreso
    if (timerProgreso) clearInterval(timerProgreso);
    timerProgreso = setInterval(tickProgreso, 100);

    // Solicitar duración en paralelo (usa caché en disco si el archivo ya fue analizado)
    // bins = 128 es suficiente para obtener durationMs sin procesar la forma de onda completa
    ipcRenderer.invoke('audio-engine-rust-command', {
        cmd: 'getPeaks', path: rutaArchivo, bins: 128, cacheDir: cacheDirEditor,
    }).then(respuesta => {
        // La respuesta llega envuelta: { success, message: { type, durationMs, ... }, status }
        // Desempaquetamos igual que en render.js getRustAudioPeaks().
        const peaks = respuesta?.message || respuesta;
        if (peaks && peaks.type === 'peaks' && peaks.durationMs > 0) {
            duracionTotal           = peaks.durationMs / 1000;
            totalEl.innerText       = formatearTiempo(duracionTotal);
        }
    }).catch(() => {});
}

// ─── Saltar a posición al hacer clic en la barra de progreso ─────────────────
progressBg.addEventListener('click', (e) => {
    if (!duracionTotal) return;
    const rect   = progressBg.getBoundingClientRect();
    const pct    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const posMs  = Math.round(pct * duracionTotal * 1000);
    // Reubicar el origen del temporizador para que la barra no salte
    iniciandoMs  = performance.now() - posMs;
    rustCmd({ cmd: 'seek', player: 'cue-player', positionMs: posMs });
});

// ─── Botón Stop: detener reproducción y cerrar ventana ───────────────────────
btnStop.addEventListener('click', () => {
    detener();
    window.close();
});

// ─── Recibir pista desde el programa principal (clic derecho → Escucha previa) ─
ipcRenderer.on('load-preview-track', (evento, rutaArchivo) => {
    reproducir(rutaArchivo).catch(() => {
        titleEl.innerText   = 'Error al reproducir este formato.';
        titleEl.style.color = '#e74c3c';
    });
});

// ─── Limpiar al cerrar la ventana ─────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    detener();
});
