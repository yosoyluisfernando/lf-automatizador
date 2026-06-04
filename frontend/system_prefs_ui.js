'use strict';

// Cableado de la sección "Sistema" dentro de la pestaña "Sistema e Interfaz"
// de la ventana de Ajustes. Se mantiene fuera de settings.js para no engrosarlo.
//
// Tres opciones (todas desactivadas por defecto):
//   chk-autostart-system   -> generalPrefs.autoStartWithSystem
//   chk-autoplay-onstart    -> generalPrefs.autoPlayOnStart
//   chk-encoder-on-autoplay -> generalPrefs.startEncoderOnAutoPlay
//
// El interruptor de auto-arranque del sistema requiere hablar con el proceso
// principal (set-auto-launch), porque registrar el inicio de sesión no se puede
// hacer desde el renderer.

const IDS = {
    autostart: 'chk-autostart-system',
    autoplay: 'chk-autoplay-onstart',
    encoder: 'chk-encoder-on-autoplay',
    hint: 'hint-autostart-dev',
};

function $(id) { return document.getElementById(id); }

// El arranque del encoder solo tiene sentido si la reproducción automática está
// activa: lo deshabilitamos visualmente cuando autoplay está apagado.
function syncEncoderDependency() {
    const autoplayEl = $(IDS.autoplay);
    const encoderEl = $(IDS.encoder);
    if (!autoplayEl || !encoderEl) return;
    const enabled = autoplayEl.checked;
    encoderEl.disabled = !enabled;
    const label = encoderEl.closest('label') || encoderEl.parentElement;
    if (label) label.style.opacity = enabled ? '1' : '0.45';
}

async function wireSystemPrefs(generalPrefs, ipcRenderer) {
    const autostartEl = $(IDS.autostart);
    const autoplayEl = $(IDS.autoplay);
    const encoderEl = $(IDS.encoder);
    const hintEl = $(IDS.hint);
    if (!autostartEl || !autoplayEl || !encoderEl) return;

    // Estado inicial desde la memoria del programa (general_settings.json).
    autostartEl.checked = generalPrefs.autoStartWithSystem === true;
    autoplayEl.checked = generalPrefs.autoPlayOnStart === true;
    encoderEl.checked = generalPrefs.startEncoderOnAutoPlay === true;
    syncEncoderDependency();

    // Verificar contra el sistema operativo: si el registro real difiere de la
    // preferencia guardada (p. ej. lo quitó otra herramienta), reflejamos el SO.
    // En desarrollo el auto-arranque no se aplica: mostramos un aviso.
    try {
        const info = await ipcRenderer.invoke('get-auto-launch');
        if (info && info.packaged === false && hintEl) {
            hintEl.style.display = 'block';
            hintEl.textContent = 'Nota: el inicio con el sistema solo se aplica en la versión instalada del programa (no en modo desarrollo). Tu elección se recordará igualmente.';
        } else if (info && typeof info.enabled === 'boolean') {
            autostartEl.checked = info.enabled;
        }
    } catch (_) { /* sin información del SO: conservamos lo guardado */ }

    autostartEl.addEventListener('change', async () => {
        try {
            const res = await ipcRenderer.invoke('set-auto-launch', autostartEl.checked);
            if (res && res.ok === false && res.reason === 'dev' && hintEl) {
                hintEl.style.display = 'block';
                hintEl.textContent = 'Nota: el inicio con el sistema solo se aplica en la versión instalada del programa (no en modo desarrollo). Tu elección se recordará igualmente.';
            }
        } catch (_) { /* el guardado en general_settings.json conserva la intención */ }
    });

    autoplayEl.addEventListener('change', syncEncoderDependency);
}

// Copia el estado de los checkboxes al objeto de preferencias antes de guardar.
function collectSystemPrefs(generalPrefs) {
    const autostartEl = $(IDS.autostart);
    const autoplayEl = $(IDS.autoplay);
    const encoderEl = $(IDS.encoder);
    if (autostartEl) generalPrefs.autoStartWithSystem = autostartEl.checked === true;
    if (autoplayEl) generalPrefs.autoPlayOnStart = autoplayEl.checked === true;
    if (encoderEl) generalPrefs.startEncoderOnAutoPlay = encoderEl.checked === true;
}

module.exports = { wireSystemPrefs, collectSystemPrefs };
