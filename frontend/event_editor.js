const { ipcRenderer } = require('electron');
const path = require('path');

let currentEventId = null;
let commercialBlocks = [];
let pendingGroupSelection = '';

async function loadCommercialBlocksIntoSelect(selectedId = '') {
    const sel = document.getElementById('ev-commercial-block');
    if (!sel) return;
    sel.innerHTML = '';
    try {
        commercialBlocks = await ipcRenderer.invoke('commercial-get-blocks');
    } catch (err) {
        commercialBlocks = [];
    }
    if (!Array.isArray(commercialBlocks) || commercialBlocks.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.innerText = 'No hay bloques comerciales';
        sel.appendChild(opt);
        return;
    }
    commercialBlocks.forEach(block => {
        const opt = document.createElement('option');
        opt.value = block.id;
        opt.innerText = `${block.primaryTime ? block.primaryTime.substring(0, 5) + ' - ' : ''}${block.name}`;
        sel.appendChild(opt);
    });
    if (selectedId && Array.from(sel.options).some(opt => opt.value === selectedId)) sel.value = selectedId;
    else if (sel.options.length > 0) sel.selectedIndex = 0;
}

function syncSourceTypeUi() {
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked')?.value || 'file';
    const pathInput       = document.getElementById('ev-filepath');
    const commercialSelect = document.getElementById('ev-commercial-block');
    const browseButton    = document.getElementById('btn-browse');
    const filepathRow     = document.getElementById('ev-filepath-row');
    const streamConfig    = document.getElementById('ev-stream-config');
    const locutionConfig  = document.getElementById('ev-locution-config');

    const isCommercial = sourceType === 'commercial';
    const isStream     = sourceType === 'stream_url';
    const isLocution   = sourceType === 'locution';

    // Fila de ruta de archivo / bloque comercial
    if (filepathRow) filepathRow.style.display = (isStream || isLocution) ? 'none' : '';
    if (pathInput)   pathInput.style.display   = isCommercial ? 'none' : '';
    if (commercialSelect) commercialSelect.style.display = isCommercial ? '' : 'none';
    if (browseButton) browseButton.style.display = isCommercial ? 'none' : '';

    // Panel de configuración de stream
    if (streamConfig) streamConfig.style.display = isStream ? 'flex' : 'none';

    // Panel de configuración de locución
    if (locutionConfig) locutionConfig.style.display = isLocution ? 'flex' : 'none';

    if (isCommercial) {
        if (!commercialBlocks.length) loadCommercialBlocksIntoSelect(pathInput.value);
        else if (commercialSelect && pathInput.value) commercialSelect.value = pathInput.value;
    }

    syncStreamActionLock();
    syncStreamExecutionWarning();
    syncDuckingAvailability();
}

/** Bloquea el radio "Borrar lista" cuando la fuente es stream_url o locution. */
function syncStreamActionLock() {
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked')?.value || 'file';
    const clearRadio = document.getElementById('ev-action-clear');
    const clearLabel = document.getElementById('ev-action-clear-label');
    if (!clearRadio || !clearLabel) return;

    const isStream   = sourceType === 'stream_url';
    const isLocution = sourceType === 'locution';
    const shouldLock = isStream || isLocution;

    clearRadio.disabled = shouldLock;
    clearLabel.style.opacity = shouldLock ? '0.4' : '';
    clearLabel.style.cursor  = shouldLock ? 'not-allowed' : '';
    clearLabel.title = isStream   ? 'No disponible para emisoras de radio (riesgo de silencio)' :
                       isLocution ? 'No disponible para locuciones (la playlist principal no debe borrarse)' : '';

    // Si estaba seleccionado y ahora lo bloqueamos, cambiar a 'append-end'
    if (shouldLock && clearRadio.checked) {
        const appendRadio = document.querySelector('input[name="ev-action"][value="append-end"]');
        if (appendRadio) appendRadio.checked = true;
        syncActionExecutionCompatibility();
    }
}

/** Habilita o deshabilita el radio "ducking" según el tipo de fuente. */
function syncDuckingAvailability() {
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked')?.value || 'file';
    const duckingLabel = document.getElementById('ev-action-ducking-label');
    const duckingRadio = document.getElementById('ev-action-ducking');
    const duckingAllowed = sourceType === 'file' || sourceType === 'locution';

    if (duckingLabel) {
        duckingLabel.style.opacity = duckingAllowed ? '' : '0.4';
        duckingLabel.style.pointerEvents = duckingAllowed ? '' : 'none';
    }
    if (duckingRadio) {
        duckingRadio.disabled = !duckingAllowed;
        // Si se deshabilita mientras estaba seleccionado, volver a 'add'
        if (!duckingAllowed && duckingRadio.checked) {
            const addRadio = document.querySelector('input[name="ev-action"][value="add"]');
            if (addRadio) addRadio.checked = true;
            syncDuckingActionUi();
        }
    }
}

/** Muestra/oculta el engranaje y deshabilita los radios de ejecución cuando ducking está activo. */
function syncDuckingActionUi() {
    const isDucking = document.getElementById('ev-action-ducking')?.checked;
    const gearBtn   = document.getElementById('btn-ducking-config');
    const duckPanel = document.getElementById('ev-ducking-panel');

    // Engranaje: visible solo cuando ducking está seleccionado
    if (gearBtn) gearBtn.style.display = isDucking ? 'inline-block' : 'none';
    if (!isDucking && duckPanel) duckPanel.style.display = 'none';

    // Sección 4: los 3 radios de ejecución se deshabilitan en modo pisador
    const execLabels = ['ev-exec-interrupt-label', 'ev-exec-wait-label', 'ev-exec-maxdelay-label'];
    execLabels.forEach(id => {
        const lbl = document.getElementById(id);
        if (!lbl) return;
        lbl.style.opacity = isDucking ? '0.4' : '';
        lbl.style.pointerEvents = isDucking ? 'none' : '';
        const radio = lbl.querySelector('input[type="radio"]');
        if (radio) radio.disabled = !!isDucking;
    });
    // También ocultar el bloque de Tiempo Máx si está activo
    const maxDelayRow = document.querySelector('#ev-max-delay-minutes')?.closest('.row-item');
    if (maxDelayRow) maxDelayRow.style.opacity = isDucking ? '0.4' : '';
}

/** Muestra advertencia cuando fuente=stream_url Y ejecución=interrupt. */
function syncStreamExecutionWarning() {
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked')?.value || 'file';
    const execVal    = document.querySelector('input[name="ev-exec"]:checked')?.value || '';
    const warningDiv = document.getElementById('ev-stream-interrupt-warning');
    if (warningDiv) {
        warningDiv.style.display = (sourceType === 'stream_url' && execVal === 'interrupt') ? '' : 'none';
    }
}

/** Actualiza la vista previa del total de segundos de duración del stream. */
function syncStreamDurationPreview() {
    const h = parseInt(document.getElementById('ev-stream-hours')?.value  || 0, 10) || 0;
    const m = parseInt(document.getElementById('ev-stream-minutes')?.value || 0, 10) || 0;
    const s = parseInt(document.getElementById('ev-stream-secs')?.value    || 0, 10) || 0;
    const total = h * 3600 + m * 60 + s;
    const preview = document.getElementById('ev-stream-dur-preview');
    if (preview) {
        preview.textContent = total > 0
            ? `(${total} seg.)`
            : '⚠️ Debe ser mayor a 0';
        preview.style.color = total > 0 ? '#888' : '#e74c3c';
    }
}

/** Retorna los segundos de duración configurados para el stream. */
function getStreamStopSeconds() {
    const h = parseInt(document.getElementById('ev-stream-hours')?.value  || 0, 10) || 0;
    const m = parseInt(document.getElementById('ev-stream-minutes')?.value || 0, 10) || 0;
    const s = parseInt(document.getElementById('ev-stream-secs')?.value    || 0, 10) || 0;
    return h * 3600 + m * 60 + s;
}

async function loadGroupsIntoSelect() {
    const sel = document.getElementById('ev-group');
    const currentVal = pendingGroupSelection || sel.value;
    sel.innerHTML = '';
    
    try {
        // Pedimos los grupos a SQLite a través del Main
        const groups = await ipcRenderer.invoke('db-get-groups');
        if (groups && groups.length > 0) {
            groups.forEach(g => {
                if (g.name && g.name.trim() !== '') {
                    const opt = document.createElement('option');
                    opt.value = g.id;
                    opt.innerText = g.name;
                    sel.appendChild(opt);
                }
            });
        } else {
            const opt = document.createElement('option');
            opt.value = 'g_general';
            opt.innerText = 'General';
            sel.appendChild(opt);
        }
    } catch(e){
        console.error("Error cargando grupos:", e);
    }

    if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
        sel.value = currentVal;
        pendingGroupSelection = '';
    }
}
// Cargar al iniciar
loadGroupsIntoSelect();
loadCommercialBlocksIntoSelect();

// Escuchar actualizaciones en tiempo real si el usuario cambia los grupos
ipcRenderer.on('refresh-event-groups', loadGroupsIntoSelect);

document.getElementById('btn-edit-groups').addEventListener('click', (e) => {
    e.preventDefault();
    ipcRenderer.send('open-event-groups');
});

document.getElementById('btn-reset-ev-colors').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('ev-color-txt').value = '#ffffff';
    document.getElementById('ev-color-bg').value = '#1a1a1c';
});

// ── Pisador / Ducking: listeners ─────────────────────────────────────────
document.getElementById('ev-action-ducking')?.addEventListener('change', syncDuckingActionUi);
document.querySelectorAll('input[name="ev-action"]').forEach(r => {
    if (r.value !== 'ducking') r.addEventListener('change', syncDuckingActionUi);
});

document.getElementById('btn-ducking-config')?.addEventListener('click', () => {
    const panel = document.getElementById('ev-ducking-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
});

document.getElementById('ev-ducking-vol')?.addEventListener('input', (e) => {
    const display = document.getElementById('ev-ducking-vol-display');
    if (display) display.textContent = `${e.target.value}%`;
});

const hoursContainer = document.getElementById('other-hours-container');
for (let i = 0; i <= 23; i++) {
    const lbl = document.createElement('label');
    lbl.style.fontSize = '12px'; lbl.style.display = 'flex'; lbl.style.alignItems = 'center'; lbl.style.gap = '4px';
    lbl.innerHTML = `<input type="checkbox" class="chk-hour" value="${i}"> ${i.toString().padStart(2, '0')} hrs`;
    hoursContainer.appendChild(lbl);
}

document.getElementById('chk-other-hours').addEventListener('change', (e) => {
    hoursContainer.style.display = e.target.checked ? 'grid' : 'none';
});

document.querySelectorAll('input[name="ev-days"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const isSpecificDays = e.target.value === 'specific';
        const isMonthlyWeeks = e.target.value === 'monthlyWeeks';
        document.getElementById('specific-days-container').style.display = isSpecificDays ? 'flex' : 'none';
        document.getElementById('monthly-weeks-container').style.display = isMonthlyWeeks ? 'block' : 'none';
    });
});

const timeInput = document.getElementById('ev-time');
let lastPrimaryHour = -1; 

function syncPrimaryHour() {
    const timeVal = timeInput.value; 
    if (!timeVal) return;
    const primaryHour = parseInt(timeVal.split(':')[0], 10);
    
    document.querySelectorAll('.chk-hour').forEach(cb => {
        const cbHour = parseInt(cb.value, 10);
        if (cbHour === primaryHour) {
            cb.checked = true;
            cb.disabled = true; 
            cb.parentElement.style.opacity = '0.5'; 
            cb.parentElement.title = 'Hora principal (obligatoria)';
        } else {
            if (cbHour === lastPrimaryHour) {
                cb.checked = false; 
            }
            cb.disabled = false;
            cb.parentElement.style.opacity = '1';
            cb.parentElement.title = '';
        }
    });
    
    lastPrimaryHour = primaryHour; 
}

timeInput.addEventListener('input', syncPrimaryHour);

const chkValidity = document.getElementById('chk-validity');
const validityContainer = document.getElementById('validity-container');
const dateStart = document.getElementById('ev-date-start');
const dateEnd = document.getElementById('ev-date-end');

chkValidity.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    dateStart.disabled = !isChecked;
    dateEnd.disabled = !isChecked;
    validityContainer.style.opacity = isChecked ? '1' : '0.5';
});

function openPicker(inputEl) {
    if (!inputEl.disabled && typeof inputEl.showPicker === 'function') {
        try { inputEl.showPicker(); } catch (e) {}
    }
}

document.getElementById('icon-date-start').addEventListener('click', () => openPicker(dateStart));
document.getElementById('icon-date-end').addEventListener('click', () => openPicker(dateEnd));
dateStart.addEventListener('dblclick', () => openPicker(dateStart));
dateEnd.addEventListener('dblclick', () => openPicker(dateEnd));

const inputMaxDelayMinutes = document.getElementById('ev-max-delay-minutes');
const inputMaxDelaySeconds = document.getElementById('ev-max-delay-seconds');
const inputMaxDelayAction = document.getElementById('ev-max-delay-action');
const prioritySelect = document.getElementById('ev-priority');
const execRadios = document.querySelectorAll('input[name="ev-exec"]');
const actionRadios = document.querySelectorAll('input[name="ev-action"]');
const execInterrupt = document.querySelector('input[name="ev-exec"][value="interrupt"]');
const execWait = document.querySelector('input[name="ev-exec"][value="wait"]');
const execMaxDelay = document.querySelector('input[name="ev-exec"][value="max-delay"]');

function syncActionExecutionCompatibility() {
    const selectedAction = document.querySelector('input[name="ev-action"]:checked').value;
    const disableExecutionRules = selectedAction === 'append-end';
    execInterrupt.disabled = false;
    execWait.disabled = false;
    execMaxDelay.disabled = false;

    if (disableExecutionRules) {
        execWait.checked = true;
        execInterrupt.disabled = true;
        execWait.disabled = true;
        execMaxDelay.disabled = true;
    }
    syncExecutionModeUI();
}

function syncExecutionModeUI() {
    const selectedAction = document.querySelector('input[name="ev-action"]:checked').value;
    if (selectedAction === 'append-end') {
        inputMaxDelayMinutes.disabled = true;
        inputMaxDelaySeconds.disabled = true;
        inputMaxDelayAction.disabled = true;
        return;
    }
    const selectedExec = document.querySelector('input[name="ev-exec"]:checked').value;
    const useMaxDelay = selectedExec === 'max-delay';
    inputMaxDelayMinutes.disabled = !useMaxDelay;
    inputMaxDelaySeconds.disabled = !useMaxDelay;
    inputMaxDelayAction.disabled = !useMaxDelay;
}

function getMaxDelayTotalSeconds() {
    const minutes = Math.max(0, parseInt(inputMaxDelayMinutes.value || 0, 10) || 0);
    const rawSeconds = parseInt(inputMaxDelaySeconds.value || 0, 10) || 0;
    const seconds = Math.min(59, Math.max(0, rawSeconds));
    inputMaxDelaySeconds.value = seconds.toString();
    return (minutes * 60) + seconds;
}

execRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        syncExecutionModeUI();
        syncStreamExecutionWarning();
    });
});
actionRadios.forEach(radio => {
    radio.addEventListener('change', syncActionExecutionCompatibility);
});

// Listeners de campos stream_url
document.getElementById('ev-stream-hours')?.addEventListener('input', syncStreamDurationPreview);
document.getElementById('ev-stream-minutes')?.addEventListener('input', syncStreamDurationPreview);
document.getElementById('ev-stream-secs')?.addEventListener('input', syncStreamDurationPreview);
document.getElementById('ev-stream-meta-mode')?.addEventListener('change', () => {
    const mode = document.getElementById('ev-stream-meta-mode').value;
    const customInput = document.getElementById('ev-stream-meta-custom');
    if (customInput) customInput.style.display = mode === 'custom' ? '' : 'none';
});

const chkCyclic = document.getElementById('chk-cyclic-active');
const inputCyclicInterval = document.getElementById('ev-cyclic-interval');
const inputCyclicUnit = document.getElementById('ev-cyclic-unit');
const inputCyclicLimit = document.getElementById('ev-cyclic-limit');

chkCyclic.addEventListener('change', (e) => {
    inputCyclicInterval.disabled = !e.target.checked;
    inputCyclicUnit.disabled = !e.target.checked;
    inputCyclicLimit.disabled = !e.target.checked;
});

document.getElementById('btn-browse').addEventListener('click', async (e) => {
    e.preventDefault();
    
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked').value;
    let filePath = null;

    // Lógica independiente para cada selección
    if (sourceType === 'folder') {
        filePath = await ipcRenderer.invoke('dialog:selectFolder');
    } else if (sourceType === 'playlist') {
        filePath = await ipcRenderer.invoke('dialog:openPlaylist');
    } else {
        filePath = await ipcRenderer.invoke('dialog:openFile');
    }
    
    if (filePath) {
        document.getElementById('ev-filepath').value = filePath;
        
        const nameField = document.getElementById('ev-name');
        if (!nameField.value || nameField.value.trim() === '' || nameField.value === 'undefined') {
            let baseName = require('path').basename(filePath);
            baseName = baseName.replace(/\.[^/.]+$/, ""); 
            if (sourceType === 'folder') {
                nameField.value = `[Carpeta] ${baseName}`;
            } else {
                nameField.value = baseName;
            }
        }
    }
});

document.querySelectorAll('input[name="ev-source-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
        const sourceType = document.querySelector('input[name="ev-source-type"]:checked').value;
        const pathInput = document.getElementById('ev-filepath');
        if (sourceType === 'commercial') {
            syncSourceTypeUi();
            const sel = document.getElementById('ev-commercial-block');
            pathInput.value = sel?.value || '';
            const block = commercialBlocks.find(item => item.id === pathInput.value);
            if (block && !document.getElementById('ev-name').value.trim()) document.getElementById('ev-name').value = `[Comerciales] ${block.name}`;
        } else if (sourceType === 'stream_url') {
            if (pathInput) pathInput.value = '';
            syncSourceTypeUi();
        } else {
            pathInput.value = '';
            syncSourceTypeUi();
        }
    });
});

// Botón Verificar URL del stream (probe)
document.getElementById('btn-stream-verify')?.addEventListener('click', async () => {
    const urlInput  = document.getElementById('ev-stream-url');
    const resultDiv = document.getElementById('ev-stream-probe-result');
    const btn       = document.getElementById('btn-stream-verify');
    const url = urlInput?.value?.trim() || '';
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        if (resultDiv) { resultDiv.textContent = '⚠ URL inválida (debe comenzar con http:// o https://)'; resultDiv.style.color = '#e74c3c'; }
        return;
    }
    if (btn) btn.disabled = true;
    if (resultDiv) { resultDiv.textContent = '🔍 Detectando…'; resultDiv.style.color = '#888'; }
    try {
        const info = await ipcRenderer.invoke('stream-probe', { url });
        if (info.error) {
            if (resultDiv) { resultDiv.textContent = `⚠ ${info.error}`; resultDiv.style.color = '#e74c3c'; }
        } else {
            const parts = [];
            if (info.format) parts.push(info.format.split(',')[0]);
            if (info.codec)  parts.push(info.codec.toUpperCase());
            if (info.bitrate) parts.push(`${info.bitrate} kbps`);
            if (info.sampleRate) parts.push(`${info.sampleRate} Hz`);
            if (resultDiv) {
                resultDiv.textContent = parts.length ? `✓ ${parts.join(' · ')}` : '✓ Stream detectado';
                resultDiv.style.color = '#27ae60';
            }
            // Auto-rellenar nombre del evento con el nombre ICY si está vacío
            if (info.icyName) {
                const nameField = document.getElementById('ev-name');
                if (nameField && !nameField.value.trim()) nameField.value = info.icyName;
            }
        }
    } catch (err) {
        if (resultDiv) { resultDiv.textContent = `⚠ Error: ${err.message || err}`; resultDiv.style.color = '#e74c3c'; }
    } finally {
        if (btn) btn.disabled = false;
    }
});

document.getElementById('ev-commercial-block').addEventListener('change', (e) => {
    const block = commercialBlocks.find(item => item.id === e.target.value);
    document.getElementById('ev-filepath').value = e.target.value || '';
    if (block && !document.getElementById('ev-name').value.trim()) document.getElementById('ev-name').value = `[Comerciales] ${block.name}`;
});

document.getElementById('btn-save').addEventListener('click', (e) => {
    e.preventDefault();
    const sourceType = document.querySelector('input[name="ev-source-type"]:checked').value;

    // ── Validación y preparación según tipo de fuente ──────────────────────
    let streamUrl = ''; let streamStopSeconds = 0;
    let streamConnectTimeout = 10; let streamMaxRetries = 3;
    let streamMetadataMode = 'icy'; let streamCustomMetadata = '';

    if (sourceType === 'stream_url') {
        streamUrl = (document.getElementById('ev-stream-url')?.value || '').trim();
        if (!streamUrl || (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://'))) {
            alert("Debes ingresar una URL válida para la emisora (debe comenzar con http:// o https://).");
            document.getElementById('ev-stream-url')?.focus();
            return;
        }
        streamStopSeconds = getStreamStopSeconds();
        if (streamStopSeconds <= 0) {
            alert("Las emisoras requieren una duración definida mayor a 0 segundos.");
            document.getElementById('ev-stream-hours')?.focus();
            return;
        }
        streamConnectTimeout = parseInt(document.getElementById('ev-stream-timeout')?.value || 10, 10) || 10;
        streamMaxRetries     = parseInt(document.getElementById('ev-stream-retries')?.value || 3, 10);
        streamMetadataMode   = document.getElementById('ev-stream-meta-mode')?.value || 'icy';
        streamCustomMetadata = streamMetadataMode === 'custom'
            ? (document.getElementById('ev-stream-meta-custom')?.value || '').trim()
            : '';
        // Sincronizar filePath con la URL para compatibilidad con otros sistemas
        document.getElementById('ev-filepath').value = streamUrl;
    }

    if (sourceType === 'commercial') {
        const commercialSelect = document.getElementById('ev-commercial-block');
        document.getElementById('ev-filepath').value = commercialSelect ? commercialSelect.value : '';
    }

    // ── Locuciones: fijar filePath placeholder ──────────────────────────
    let locutionType = 'time';
    if (sourceType === 'locution') {
        locutionType = document.getElementById('ev-locution-type')?.value || 'time';
        document.getElementById('ev-filepath').value = `locution:${locutionType}`;
    }

    // ── Pisador / Ducking: leer config del panel de sección 3 ───────────
    const isDucking = document.getElementById('ev-action-ducking')?.checked || false;
    const eventDuckingVolume = parseInt(document.getElementById('ev-ducking-vol')?.value ?? 20, 10);
    const eventDuckingFade   = parseInt(document.getElementById('ev-ducking-fade')?.value ?? 500, 10);

    const filePath = document.getElementById('ev-filepath').value;
    if (!filePath || filePath === 'undefined' || filePath.trim() === '') {
        alert("Debes seleccionar una ruta válida en Origen del Audio.");
        return;
    }

    let name = document.getElementById('ev-name').value.trim();
    if (!name || name === 'undefined') {
        if (sourceType === 'stream_url') {
            name = streamUrl.split('/').slice(2, 3).join('') || 'Emisora';
        } else if (sourceType === 'locution') {
            name = locutionType === 'time' ? 'Locución de Hora'
                 : locutionType === 'temperature' ? 'Locución de Temperatura'
                 : 'Locución de Humedad';
        } else {
            name = require('path').basename(filePath).replace(/\.[^/.]+$/, "");
        }
    }

    let otherHours = [];
    if (document.getElementById('chk-other-hours').checked) {
        const primaryHour = parseInt(timeInput.value.split(':')[0], 10);
        document.querySelectorAll('.chk-hour:checked').forEach(cb => {
            const val = parseInt(cb.value);
            if (val !== primaryHour) {
                otherHours.push(val);
            }
        });
    }

    let specificDays = [];
    const dayMode = document.querySelector('input[name="ev-days"]:checked').value;
    if (dayMode === 'specific') {
        document.querySelectorAll('.chk-day:checked').forEach(cb => specificDays.push(parseInt(cb.value)));
    }

    let targetWeeks = [];
    if (dayMode === 'monthlyWeeks') {
        document.querySelectorAll('.chk-week:checked').forEach(cb => targetWeeks.push(parseInt(cb.value)));
        if (targetWeeks.length === 0) {
            alert("Debes seleccionar al menos una semana del mes.");
            return;
        }
    }

    const groupId = document.getElementById('ev-group').value || 'g_general';

    const selectedAction = document.querySelector('input[name="ev-action"]:checked').value;
    const selectedExecution = selectedAction === 'append-end'
        ? 'wait'
        : document.querySelector('input[name="ev-exec"]:checked').value;
    const maxDelayActive = selectedExecution === 'max-delay';
    const maxDelayTotalSeconds = maxDelayActive ? getMaxDelayTotalSeconds() : 0;

    if (maxDelayActive && maxDelayTotalSeconds < 1) {
            alert("Debes indicar un Tiempo Máx de Espera válido (mínimo 1 segundo).");
            return;
    }

    const newEvent = {
        id: currentEventId || 'ev_' + Date.now(),
        name: name,
        group: groupId,
        sourceType: sourceType,
        filePath: filePath,
        primaryTime: document.getElementById('ev-time').value,
        otherHours: otherHours,
        dayMode: dayMode, 
        specificDays: specificDays,
        targetWeeks: targetWeeks,
        validityStart: chkValidity.checked ? (dateStart.value || null) : null, 
        validityEnd: chkValidity.checked ? (dateEnd.value || null) : null,     
        action: selectedAction,
        execution: selectedExecution,
        priority: prioritySelect ? prioritySelect.value : 'normal',
        colorText: document.getElementById('ev-color-txt').value,
        colorBg: document.getElementById('ev-color-bg').value,
        lastFired: null,
        
        requirePlaying: document.getElementById('chk-require-playing').checked,
        maxDelayActive: maxDelayActive,
        maxDelayMinutes: maxDelayActive ? Math.floor(maxDelayTotalSeconds / 60) : 0,
        maxDelaySeconds: maxDelayActive ? (maxDelayTotalSeconds % 60) : 0,
        maxDelayTime: maxDelayActive ? Math.floor(maxDelayTotalSeconds / 60) : 0,
        maxDelayAction: maxDelayActive ? inputMaxDelayAction.value : 'omit',
        cyclicActive: chkCyclic.checked,
        cyclicInterval: chkCyclic.checked ? parseInt(inputCyclicInterval.value || 0) : 0,
        cyclicUnit: chkCyclic.checked ? inputCyclicUnit.value : 'minutes',
        cyclicLimit: chkCyclic.checked ? parseInt(inputCyclicLimit.value || 0) : 0,
        // Campos de emisora (stream_url)
        streamUrl:            streamUrl,
        streamStopSeconds:    streamStopSeconds,
        streamConnectTimeout: streamConnectTimeout,
        streamMaxRetries:     streamMaxRetries,
        streamMetadataMode:   streamMetadataMode,
        streamCustomMetadata: streamCustomMetadata,
        // Campos de locución
        locutionType:         locutionType,
        // Campos de pisador / ducking (aplica a file y locution cuando action=ducking)
        eventDuckingVolume:   eventDuckingVolume,
        eventDuckingFade:     eventDuckingFade
    };

    // Enviamos a guardar a SQLite vía main.js
    ipcRenderer.send('save-event', newEvent);
});

document.getElementById('btn-cancel').addEventListener('click', (e) => {
    e.preventDefault();
    window.close();
});

ipcRenderer.on('load-event-data', (e, data) => {
    if(!data) {
        syncPrimaryHour(); 
        syncActionExecutionCompatibility();
        syncSourceTypeUi();
        return;
    }
    currentEventId = data.id;
    
    let sourceType = data.sourceType || 'file';
    
    // Retrocompatibilidad: Si era "file" pero la ruta es ".lfplay", actualizar a "playlist" para que el UI cuadre
    if (sourceType === 'file' && data.filePath && data.filePath.toLowerCase().endsWith('.lfplay')) {
        sourceType = 'playlist';
    }

    const sourceRadio = document.querySelector(`input[name="ev-source-type"][value="${sourceType}"]`);
    if(sourceRadio) sourceRadio.checked = true;

    document.getElementById('ev-filepath').value = (data.filePath && data.filePath !== 'undefined') ? data.filePath : '';
    if (sourceType === 'commercial') loadCommercialBlocksIntoSelect(data.filePath || '').then(syncSourceTypeUi);
    else syncSourceTypeUi();
    document.getElementById('ev-name').value = (data.name && data.name !== 'undefined') ? data.name : '';
    
    if (data.group) {
        pendingGroupSelection = data.group;
        document.getElementById('ev-group').value = data.group;
        loadGroupsIntoSelect();
    }
    
    document.getElementById('ev-time').value = data.primaryTime;
    document.getElementById('ev-color-txt').value = data.colorText || '#ffffff';
    document.getElementById('ev-color-bg').value = data.colorBg || '#1a1a1c';
    if (prioritySelect) prioritySelect.value = data.priority || 'normal';

    if (data.otherHours && data.otherHours.length > 0) {
        document.getElementById('chk-other-hours').checked = true;
        hoursContainer.style.display = 'grid';
        document.querySelectorAll('.chk-hour').forEach(cb => {
            if (data.otherHours.includes(parseInt(cb.value))) cb.checked = true;
        });
    }

    const dayModeRadio = document.querySelector(`input[name="ev-days"][value="${data.dayMode}"]`);
    if(dayModeRadio) dayModeRadio.checked = true;

    if (data.dayMode === 'specific') {
        document.getElementById('specific-days-container').style.display = 'flex';
        document.querySelectorAll('.chk-day').forEach(cb => {
            if (data.specificDays && data.specificDays.includes(parseInt(cb.value))) cb.checked = true;
        });
    }

    if (data.dayMode === 'monthlyWeeks') {
        document.getElementById('monthly-weeks-container').style.display = 'block';
    }

    if (data.targetWeeks && Array.isArray(data.targetWeeks)) {
        document.querySelectorAll('.chk-week').forEach(cb => {
            cb.checked = data.targetWeeks.includes(parseInt(cb.value));
        });
    }

    if (data.validityStart || data.validityEnd) {
        chkValidity.checked = true;
        validityContainer.style.opacity = '1';
        dateStart.disabled = false;
        dateEnd.disabled = false;
        if (data.validityStart) dateStart.value = data.validityStart;
        if (data.validityEnd) dateEnd.value = data.validityEnd;
    }

    const actionRadio = document.querySelector(`input[name="ev-action"][value="${data.action}"]`);
    if(actionRadio) actionRadio.checked = true;

    const execValue = (data.maxDelayActive && (data.execution === 'wait' || data.execution === 'max-delay')) ? 'max-delay' : (data.execution || 'interrupt');
    const execRadio = document.querySelector(`input[name="ev-exec"][value="${execValue}"]`);
    if(execRadio) execRadio.checked = true;

    document.getElementById('chk-require-playing').checked = data.requirePlaying || false;

    if (data.maxDelayActive) {
        const savedMinutes = parseInt(data.maxDelayMinutes, 10);
        const savedSeconds = parseInt(data.maxDelaySeconds, 10);
        if (Number.isFinite(savedMinutes) || Number.isFinite(savedSeconds)) {
            inputMaxDelayMinutes.value = Number.isFinite(savedMinutes) ? Math.max(0, savedMinutes) : 0;
            inputMaxDelaySeconds.value = Number.isFinite(savedSeconds) ? Math.min(59, Math.max(0, savedSeconds)) : 0;
        } else {
            inputMaxDelayMinutes.value = parseInt(data.maxDelayTime || 0, 10) || 0;
            inputMaxDelaySeconds.value = 0;
        }
        inputMaxDelayAction.value = data.maxDelayAction || 'omit';
    }

    if (data.cyclicActive) {
        chkCyclic.checked = true;
        inputCyclicInterval.disabled = false;
        inputCyclicUnit.disabled = false;
        inputCyclicLimit.disabled = false;
        inputCyclicInterval.value = data.cyclicInterval || '';
        inputCyclicUnit.value = data.cyclicUnit || 'minutes';
        inputCyclicLimit.value = data.cyclicLimit || '';
    }

    // Prefill campos stream_url si el evento es de tipo emisora
    if (sourceType === 'stream_url') {
        const urlInput = document.getElementById('ev-stream-url');
        if (urlInput) urlInput.value = data.streamUrl || data.filePath || '';

        const totalSecs = Number(data.streamStopSeconds) || 0;
        const hEl = document.getElementById('ev-stream-hours');
        const mEl = document.getElementById('ev-stream-minutes');
        const sEl = document.getElementById('ev-stream-secs');
        if (hEl) hEl.value = Math.floor(totalSecs / 3600);
        if (mEl) mEl.value = Math.floor((totalSecs % 3600) / 60);
        if (sEl) sEl.value = totalSecs % 60;
        syncStreamDurationPreview();

        const toEl = document.getElementById('ev-stream-timeout');
        const rtEl = document.getElementById('ev-stream-retries');
        if (toEl) toEl.value = Number(data.streamConnectTimeout) || 10;
        if (rtEl) rtEl.value = Number(data.streamMaxRetries) !== undefined ? Number(data.streamMaxRetries) : 3;

        const metaMode = document.getElementById('ev-stream-meta-mode');
        const metaCustom = document.getElementById('ev-stream-meta-custom');
        if (metaMode)   { metaMode.value = data.streamMetadataMode || 'icy'; }
        if (metaCustom) {
            metaCustom.value   = data.streamCustomMetadata || '';
            metaCustom.style.display = (data.streamMetadataMode === 'custom') ? '' : 'none';
        }

        const probeResult = document.getElementById('ev-stream-probe-result');
        if (probeResult) probeResult.textContent = '';
    }

    // Prefill campos de locución
    if (sourceType === 'locution') {
        const locTypeEl = document.getElementById('ev-locution-type');
        if (locTypeEl) locTypeEl.value = data.locutionType || (data.filePath || '').replace('locution:', '') || 'time';
    }

    // Prefill config de pisador / ducking (aplica a file y locution)
    if (data.action === 'ducking') {
        const vol = data.eventDuckingVolume !== undefined ? data.eventDuckingVolume : 20;
        const volEl = document.getElementById('ev-ducking-vol');
        const volDisplay = document.getElementById('ev-ducking-vol-display');
        if (volEl) volEl.value = vol;
        if (volDisplay) volDisplay.textContent = `${vol}%`;

        const fadeEl = document.getElementById('ev-ducking-fade');
        if (fadeEl) fadeEl.value = data.eventDuckingFade !== undefined ? data.eventDuckingFade : 500;
    }
    syncDuckingAvailability();
    syncDuckingActionUi();

    syncPrimaryHour();
    syncActionExecutionCompatibility();
});
