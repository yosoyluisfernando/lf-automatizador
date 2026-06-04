'use strict';

// Lógica de "Iniciar reproducción automáticamente al iniciar" (y, opcionalmente,
// arrancar el encoder con ella). Vive fuera de render.js para no seguir
// engrosando ese archivo: render.js solo le pasa las dependencias que necesita.
//
// Comportamiento (todo desactivado por defecto):
//  - Si autoPlayOnStart está activo y hay pistas reproducibles, dispara la MISMA
//    función que el botón Play (resumeCurrentPlayback) → idéntico a un Play
//    manual, sin caminos paralelos.
//  - Si además startEncoderOnAutoPlay está activo, pide al proceso principal
//    que conecte los servidores del encoder marcados como "auto-conectar".
//
// Se garantiza una sola ejecución por arranque (no en recargas de sesión).

let autoPlayDone = false;

function runAutoPlayOnStart({ generalPrefs, hasPlayableRows, resumeCurrentPlayback, ipcRenderer, logSystem } = {}) {
    if (autoPlayDone) return;
    autoPlayDone = true;

    const log = typeof logSystem === 'function' ? logSystem : () => {};

    if (!generalPrefs || generalPrefs.autoPlayOnStart !== true) return;

    if (typeof hasPlayableRows === 'function' && !hasPlayableRows()) {
        log('[AUTOPLAY] Reproducción automática omitida: la lista de reproducción está vacía.');
        return;
    }

    log('[AUTOPLAY] Iniciando reproducción automática al abrir el programa.');
    try {
        resumeCurrentPlayback();
    } catch (err) {
        log('[AUTOPLAY] No se pudo iniciar la reproducción automática: ' + (err && err.message ? err.message : err));
        return;
    }

    if (generalPrefs.startEncoderOnAutoPlay === true) {
        try {
            ipcRenderer.send('autoplay-start-encoders');
            log('[AUTOPLAY] Solicitando arranque del encoder (servidores marcados para auto-conectar).');
        } catch (err) {
            log('[AUTOPLAY] No se pudo solicitar el arranque del encoder: ' + (err && err.message ? err.message : err));
        }
    }
}

// Permite resetear el guard en pruebas.
function __resetAutoPlayGuardForTests() { autoPlayDone = false; }

module.exports = { runAutoPlayOnStart, __resetAutoPlayGuardForTests };
