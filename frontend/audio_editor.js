const fs = require('fs');
const path = require('path');
const url = require('url'); 
const { ipcRenderer } = require('electron');
// WEBAUDIO_DISABLED_BEGIN — VU meter y enrutamiento Web Audio del editor de audio
// El audio ya sale por el motor Rust al bus cue. Este bloque puede borrarse tras pruebas.
// const { createEditorOutputRouter } = require('./editor_audio_output');
// const { createMeteringAnalyser, startCueVuMeter } = require('./audio_metering');
// const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
// const { outputNode: editorOutputNode, applyRouting: applyEditorAudioRouting, ensurePreviewPlayback: ensureEditorPreviewPlayback } = createEditorOutputRouter(audioCtx);
// const editorCueAnalyser = createMeteringAnalyser(audioCtx, editorOutputNode, 1024);
// const stopEditorVuMeter = startCueVuMeter(ipcRenderer, editorCueAnalyser, 'audio-editor');
// applyEditorAudioRouting();
// ipcRenderer.on('settings-updated', () => { applyEditorAudioRouting(); });
// WEBAUDIO_DISABLED_END

let currentFilePath = null;
let currentDuration = 0;
let zoomLevel = 1;
let audioBuffer = null;
let waveformPeaks = null;

function nodeBufferToArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

let sourceNode = null;
let startTime = 0;      // performance.now()/1000 al inicio (RUST_ENGINE) o audioCtx.currentTime (WEBAUDIO_DISABLED)
let pauseTime = 0;
let isPlaying = false;
let animationFrameId = null;
let editorLoadToken = 0;

// RUST_ENGINE: Carpeta de caché de peaks (se resuelve al arrancar la ventana)
let editorCacheDir = '';
ipcRenderer.invoke('get-cache-dir').then(r => { if (r?.success) editorCacheDir = r.cacheDir; }).catch(() => {});

const container = document.getElementById('wave-container');
const innerWrapper = document.getElementById('wave-inner');
const canvas = document.getElementById('ae-canvas');
const overlayCanvas = document.getElementById('ae-overlay-canvas');
const ctx = canvas.getContext('2d');
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
const aeCursorElement = document.getElementById('ae-cursor');
const timeText = document.getElementById('ae-time-text');
const zoomSlider = document.getElementById('zoom-slider');
const scrollGuideElement = document.getElementById('ae-scroll-guide');

let isDraggingWave = false;
let isDraggingMarker = false;
let draggedMarkerId = null;
let dragStartX = 0;
let scrollStartX = 0;
let autoScrollEnabled = true; 
let lastManualNavigationAt = 0;
let ignoreScrollSync = false;

let pendingAutoAnalysis = null;
let countryProfiles = [];
let genreProfiles = [];

function sortByDisplayName(items, key = 'displayName') {
    return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
        const left = String(a?.[key] || '').toLocaleLowerCase();
        const right = String(b?.[key] || '').toLocaleLowerCase();
        return left.localeCompare(right, 'es');
    });
}

function hasDbNumber(v) { return v !== null && v !== undefined && !isNaN(parseFloat(v)); }
function isZeroOrEmptyCueInput(id) {
    const el = document.getElementById(`cue-${id}`);
    if (!el) return true;
    const t = parseFloat(el.value);
    return isNaN(t) || t <= 0;
}

async function loadCountryProfiles() {
    try {
        countryProfiles = await ipcRenderer.invoke('lib-get-country-profiles') || [];
    } catch (err) {
        countryProfiles = [];
    }
    const list = document.getElementById('country-options');
    if (!list) return;
    list.innerHTML = '';
    countryProfiles.forEach(country => {
        const option = document.createElement('option');
        option.value = country.name || '';
        list.appendChild(option);
    });
}

async function loadGenreProfiles() {
    try {
        genreProfiles = sortByDisplayName(await ipcRenderer.invoke('lib-get-genre-profiles') || []);
    } catch (err) {
        genreProfiles = [];
    }
    const list = document.getElementById('genre-options');
    if (!list) return;
    list.innerHTML = '';
    genreProfiles.forEach(genre => {
        const option = document.createElement('option');
        option.value = genre.displayName || '';
        list.appendChild(option);
    });
}

async function loadArtistCountryForCurrentTrack() {
    if (!currentFilePath) return;
    try {
        const result = await ipcRenderer.invoke('lib-get-artist-card-for-track', currentFilePath);
        const country = result?.card?.country || '';
        const input = document.getElementById('meta-country');
        if (input && country && !input.value.trim()) input.value = country;
    } catch (err) {}
}

loadCountryProfiles();
loadGenreProfiles();

function formatTime(seconds) {
    const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const minutes = Math.floor(safeSeconds / 60);
    const secs = Math.floor(safeSeconds % 60);
    const millis = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 1000);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// El cursor debe seguir el audio real mientras la ventana siga visible.
// No lo detenemos por foco o por scroll del viewport porque eso congelaba
// la lÃ­nea de progreso hasta que otro repaint forzaba la actualizaciÃ³n.
function isEditorActiveForCursorUpdates() {
    return !document.hidden;
}

function stopCursorLoop() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getEditorCurrentTime() {
    // RUST_ENGINE: El tiempo se mide con performance.now() para no depender del AudioContext.
    // startTime se asigna como (performance.now()/1000 - startAt) en playAudio().
    const rawTime = isPlaying ? (performance.now() / 1000 - startTime) : pauseTime;
    if (!currentDuration || currentDuration <= 0) return Math.max(0, rawTime || 0);
    return Math.max(0, Math.min(rawTime || 0, currentDuration));
}

function getCursorPixel(currentT = getEditorCurrentTime()) {
    if (!currentDuration || currentDuration <= 0 || !canvas) return 0;
    return (currentT / currentDuration) * canvas.width;
}

function getMaxScrollLeft() {
    if (!container || !canvas) return 0;
    return Math.max(0, canvas.width - container.clientWidth);
}

function isCursorVisibleInViewport(px = getCursorPixel(), padding = 0) {
    if (!container) return false;
    const viewStart = container.scrollLeft + padding;
    const viewEnd = container.scrollLeft + container.clientWidth - padding;
    return px >= viewStart && px <= viewEnd;
}

function markManualNavigation() {
    autoScrollEnabled = false;
    lastManualNavigationAt = Date.now();
}

function shouldResumeAutoFollow() {
    return (Date.now() - lastManualNavigationAt) >= 160;
}

function updateScrollGuide() {
    if (!scrollGuideElement || !container || !canvas || !currentDuration || currentDuration <= 0) return;
    const hasHorizontalScroll = canvas.width > container.clientWidth + 1;
    if (!hasHorizontalScroll) {
        scrollGuideElement.style.display = 'none';
        return;
    }

    const guidePadding = 8;
    const usableWidth = Math.max(0, container.clientWidth - (guidePadding * 2));
    const ratio = canvas.width > 0 ? clamp(getCursorPixel() / canvas.width, 0, 1) : 0;
    scrollGuideElement.style.display = 'block';
    // The guide is rendered outside the scrollable waveform so it stays fixed
    // over the scrollbar area while the user pans left/right manually.
    scrollGuideElement.style.left = `${guidePadding + (ratio * usableWidth)}px`;
}

function syncCursorPosition(currentT = getEditorCurrentTime()) {
    if (!currentDuration || currentDuration <= 0 || !canvas) return;
    const px = getCursorPixel(currentT);
    if (aeCursorElement) aeCursorElement.style.left = `${px}px`;
    if (timeText) timeText.innerText = formatTime(currentT);
    updateScrollGuide();
}

function setWaveCursor(cursor) {
    if (innerWrapper) innerWrapper.style.cursor = cursor;
    if (canvas) canvas.style.cursor = cursor;
    if (overlayCanvas) overlayCanvas.style.cursor = cursor;
}

function setContainerScrollLeft(nextLeft) {
    if (!container) return;
    const clampedLeft = clamp(nextLeft, 0, getMaxScrollLeft());
    if (Math.abs(container.scrollLeft - clampedLeft) < 0.5) {
        updateScrollGuide();
        return;
    }
    ignoreScrollSync = true;
    container.scrollLeft = clampedLeft;
    updateScrollGuide();
    requestAnimationFrame(() => {
        ignoreScrollSync = false;
        updateScrollGuide();
    });
}

function centerCursorInViewport(px = getCursorPixel()) {
    if (!container) return;
    setContainerScrollLeft(px - (container.clientWidth / 2));
}

function refreshOverlay() {
    drawMarkers();
    syncCursorPosition();
}

function updateCursorOnce() {
    if (!isPlaying || !currentDuration || currentDuration <= 0) return;
    const currentT = getEditorCurrentTime();
    const px = getCursorPixel(currentT);
    syncCursorPosition(currentT);
    if (!container || isDraggingMarker || isDraggingWave) return;

    if (!autoScrollEnabled) {
        if (isCursorVisibleInViewport(px, 2) && shouldResumeAutoFollow()) {
            autoScrollEnabled = true;
        }
        return;
    }

    const visibleWidth = container.clientWidth;
    const scrollLeft = container.scrollLeft;
    const centerScreenX = scrollLeft + (visibleWidth / 2);
    if (px > centerScreenX) {
        setContainerScrollLeft(px - (visibleWidth / 2));
    }
}
function cursorLoop() {
    if (!isPlaying) { stopCursorLoop(); return; }
    if (!isEditorActiveForCursorUpdates()) { stopCursorLoop(); return; }
    updateCursorOnce();
    animationFrameId = requestAnimationFrame(cursorLoop);
}

function startCursorLoop() {
    stopCursorLoop();
    if (!isPlaying) return;
    if (!isEditorActiveForCursorUpdates()) return;
    cursorLoop();
}

// --- LÃ“GICA DE LISTA DINÃMICA DE FEATS ---
function addFeatInput(val = '') {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.gap = '5px';
    div.innerHTML = `
        <span style="color: #888; font-size: 11px; align-self: center;">Feat:</span>
        <input type="text" class="ae-input meta-feat-input" value="${val}" style="flex: 1;" placeholder="Artista Invitado">
        <button class="cue-btn" style="background: #e74c3c;" onclick="this.parentElement.remove()" title="Eliminar Invitado">X</button>
    `;
    document.getElementById('feat-list').appendChild(div);
}

window.addEmptyFeat = function() { addFeatInput(''); };

function getFeats() { return Array.from(document.querySelectorAll('.meta-feat-input')).map(inp => inp.value.trim()).filter(v => v !== ''); }

function setFeats(featsData) {
    document.getElementById('feat-list').innerHTML = '';
    if (Array.isArray(featsData)) {
        featsData.forEach(f => addFeatInput(f));
    } else if (typeof featsData === 'string' && featsData.trim() !== '') {
        try { const parsed = JSON.parse(featsData); if(Array.isArray(parsed)) parsed.forEach(f => addFeatInput(f)); else addFeatInput(featsData); } 
        catch(e) { featsData.split(',').forEach(f => addFeatInput(f.trim())); }
    }
}

// --- LÃ“GICA DEL ACORDEÃ“N DE METADATOS ---
const extraMeta = document.getElementById('extra-meta-container');
const btnToggleMeta = document.getElementById('btn-toggle-meta');
let isMetaExpanded = localStorage.getItem('ae_meta_expanded') === 'true';

function updateMetaToggle() {
    if (isMetaExpanded) { extraMeta.style.display = 'flex'; btnToggleMeta.innerText = 'â–² Ocultar detalles'; } 
    else { extraMeta.style.display = 'none'; btnToggleMeta.innerText = 'â–¼ Mostrar mÃ¡s detalles (Ãlbum, AÃ±o, GÃ©nero)'; }
}
updateMetaToggle();

if (btnToggleMeta) {
    btnToggleMeta.addEventListener('click', () => {
        isMetaExpanded = !isMetaExpanded; localStorage.setItem('ae_meta_expanded', isMetaExpanded); updateMetaToggle();
    });
}

// --- LÃ“GICA DE BÃšSQUEDA INTERACTIVA Y CURIOSIDAD (CTRL+CLIC) ---
let currentPreview = { artist: '', feats: [], title: '', isRemix: false, album: '', year: '', genre: '' };

document.getElementById('btn-auto-internet').addEventListener('click', () => {
    if(!currentFilePath) return;
    document.getElementById('btn-auto-internet').innerText = 'â³ Buscando...';
    ipcRenderer.send('editor-start-meta', { filePath: currentFilePath, source: 'internet' });
});

document.getElementById('btn-auto-local').addEventListener('click', () => {
    if(!currentFilePath) return;
    document.getElementById('btn-auto-local').innerText = 'â³ Leyendo...';
    ipcRenderer.send('editor-start-meta', { filePath: currentFilePath, source: 'local' });
});

ipcRenderer.on('editor-meta-results', (e, result) => {
    document.getElementById('btn-auto-internet').innerText = 'ðŸŒ Buscar (Internet)';
    if (result.success && result.data && result.data.length > 0) { openMetaModal(result.data); } 
    else { alert("No se encontraron resultados en internet. Intenta limpiar el tÃ­tulo y artista antes de buscar."); }
});

ipcRenderer.on('editor-meta-done', (e, result) => {
    document.getElementById('btn-auto-local').innerText = 'ðŸ“ Leer de MP3';
    if (result.success && result.filePath === currentFilePath && result.data) {
        if (result.data.custom_title) document.getElementById('meta-title').value = result.data.custom_title;
        if (result.data.custom_artist) document.getElementById('meta-artist').value = result.data.custom_artist;
        if (result.data.album) document.getElementById('meta-album').value = result.data.album;
        if (result.data.year) document.getElementById('meta-year').value = result.data.year;
        if (result.data.genre) document.getElementById('meta-genre').value = result.data.genre;
        document.getElementById('meta-remix').checked = !!result.data.isRemix;
        setFeats(result.data.feat || []);
        
        if ((result.data.album || result.data.year || result.data.genre) && !isMetaExpanded) {
            isMetaExpanded = true; localStorage.setItem('ae_meta_expanded', 'true'); updateMetaToggle();
        }
    } else { alert("No se encontraron metadatos fÃ­sicos dentro del archivo MP3."); }
});

function openMetaModal(results) {
    const tbody = document.getElementById('meta-search-results');
    tbody.innerHTML = '';
    updatePreview(results[0]);
    
    results.forEach((res, index) => {
        const tr = document.createElement('tr');
        if(index === 0) tr.classList.add('selected');
        let featStr = Array.isArray(res.feats) ? res.feats.join(', ') : '';
        let remixStr = res.isRemix ? 'SÃ­' : 'No';
        
        tr.innerHTML = `
            <td data-type="artist">${res.artist || ''}</td>
            <td data-type="feats" data-raw="${encodeURIComponent(JSON.stringify(res.feats || []))}">${featStr}</td>
            <td data-type="title">${res.title || ''}</td>
            <td data-type="isRemix" data-raw="${res.isRemix ? 'true' : 'false'}">${remixStr}</td>
            <td data-type="album">${res.album || ''}</td>
            <td data-type="year">${res.year || ''}</td>
            <td data-type="genre">${res.genre || ''}</td>
        `;
        
        tr.onclick = (e) => {
            if (e.ctrlKey) {
                const type = e.target.dataset.type;
                if (type) {
                    if (type === 'feats') currentPreview.feats = JSON.parse(decodeURIComponent(e.target.dataset.raw));
                    else if (type === 'isRemix') currentPreview.isRemix = (e.target.dataset.raw === 'true');
                    else currentPreview[type] = e.target.innerText;
                    renderPreview();
                    document.querySelectorAll(`.meta-table td[data-type="${type}"]`).forEach(td => td.classList.remove('cell-selected'));
                    e.target.classList.add('cell-selected');
                }
            } else {
                document.querySelectorAll('.meta-table tr').forEach(r => r.classList.remove('selected'));
                document.querySelectorAll('.meta-table td').forEach(td => td.classList.remove('cell-selected'));
                tr.classList.add('selected');
                updatePreview({
                    artist: tr.children[0].innerText,
                    feats: JSON.parse(decodeURIComponent(tr.children[1].dataset.raw)),
                    title: tr.children[2].innerText,
                    isRemix: tr.children[3].dataset.raw === 'true',
                    album: tr.children[4].innerText,
                    year: tr.children[5].innerText,
                    genre: tr.children[6].innerText
                });
            }
        };
        tbody.appendChild(tr);
    });
    document.getElementById('meta-search-modal').style.display = 'flex';
}

function updatePreview(data) { currentPreview = { ...data }; renderPreview(); }

function renderPreview() {
    document.getElementById('prev-artist').innerText = currentPreview.artist || '-';
    let featStr = Array.isArray(currentPreview.feats) && currentPreview.feats.length > 0 ? currentPreview.feats.join(', ') : '-';
    document.getElementById('prev-feats').innerText = featStr;
    document.getElementById('prev-title').innerText = currentPreview.title || '-';
    document.getElementById('prev-remix').innerText = currentPreview.isRemix ? 'SÃ' : 'NO';
    document.getElementById('prev-remix').style.color = currentPreview.isRemix ? '#e74c3c' : '#2ecc71';
    document.getElementById('prev-album').innerText = currentPreview.album || '-';
    document.getElementById('prev-year').innerText = currentPreview.year || '-';
    document.getElementById('prev-genre').innerText = currentPreview.genre || '-';
}

window.closeMetaModal = function() { document.getElementById('meta-search-modal').style.display = 'none'; }

window.applyMetaSelection = function() {
    document.getElementById('meta-artist').value = currentPreview.artist || '';
    document.getElementById('meta-title').value = currentPreview.title || '';
    document.getElementById('meta-remix').checked = !!currentPreview.isRemix;
    document.getElementById('meta-album').value = currentPreview.album || '';
    document.getElementById('meta-year').value = currentPreview.year || '';
    document.getElementById('meta-genre').value = currentPreview.genre || '';
    
    setFeats(currentPreview.feats || []);
    
    if (!isMetaExpanded) { isMetaExpanded = true; localStorage.setItem('ae_meta_expanded', 'true'); updateMetaToggle(); }
    closeMetaModal();
}

// --- DIBUJO Y AUDIO ---
// FIX BUG (resize en modo Rust): la guarda original `if (audioBuffer)` era
// false en modo Rust porque el motor Rust hace la decodificación y aquí
// dejamos `audioBuffer = null`. Usamos `waveformPeaks` que sí se llena con
// los datos pre-calculados que vienen del motor.
const resizeObserver = new ResizeObserver(() => { if (waveformPeaks && container.clientWidth > 0) drawWaveform(); });
resizeObserver.observe(container);

function autoDetectSilence(buffer) {
    const rawData = buffer.getChannelData(0); const sampleRate = buffer.sampleRate;
    const thresholdStart = Math.pow(10, -38 / 20); const thresholdEnd = Math.pow(10, -30 / 20); 

    let startIndex = 0;
    for (let i = 0; i < rawData.length; i++) { if (Math.abs(rawData[i]) > thresholdStart) { startIndex = Math.max(0, i - Math.floor(sampleRate * 0.05)); break; } }
    let endIndex = rawData.length - 1;
    for (let i = rawData.length - 1; i >= 0; i--) { if (Math.abs(rawData[i]) > thresholdEnd) { endIndex = Math.min(rawData.length - 1, i + Math.floor(sampleRate * 0.05)); break; } }
    if (startIndex >= endIndex) return { start: 0, end: buffer.duration };
    return { start: startIndex / sampleRate, end: endIndex / sampleRate };
}

function buildWaveformPeaks(buffer) {
    if (!buffer) return null;
    const rawData = buffer.getChannelData(0);
    const targetBins = Math.max(2048, Math.min(60000, Math.ceil(buffer.duration * 120)));
    const samplesPerBin = Math.max(1, Math.ceil(rawData.length / targetBins));
    const bins = Math.ceil(rawData.length / samplesPerBin);
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);

    for (let bin = 0; bin < bins; bin++) {
        const start = bin * samplesPerBin;
        const end = Math.min(rawData.length, start + samplesPerBin);
        let binMin = 1;
        let binMax = -1;
        for (let i = start; i < end; i++) {
            const datum = rawData[i];
            if (datum < binMin) binMin = datum;
            if (datum > binMax) binMax = datum;
        }
        min[bin] = binMin;
        max[bin] = binMax;
    }
    return { min, max, bins };
}

ipcRenderer.on('load-audio-file', async (e, filePath) => {
    const loadToken = ++editorLoadToken;
    currentFilePath = filePath;
    document.getElementById('lbl-filename').innerText = "Cargando: " + path.basename(filePath);
    
    try {
        document.getElementById('meta-artist').value = '';
        document.getElementById('meta-title').value = '';
        document.getElementById('meta-remix').checked = false;
        document.getElementById('meta-album').value = '';
        document.getElementById('meta-year').value = '';
        document.getElementById('meta-genre').value = '';
        const countryInput = document.getElementById('meta-country');
        if (countryInput) countryInput.value = '';
        document.getElementById('feat-list').innerHTML = '';
        
        ['inicio', 'intro', 'mix', 'outro', 'fin', 'p1', 'p2', 'p3', 'phora'].forEach(k => { const el = document.getElementById(`cue-${k}`); if (el) el.value = '0.00'; });
        ['p1', 'p2', 'p3'].forEach(k => { const el = document.getElementById(`file-${k}`); if (el) el.value = ''; });
    } catch (cleanErr) {}
    
    pauseTime = 0; startTime = 0; isPlaying = false;
    if (aeCursorElement) aeCursorElement.style.left = '0px';
    if (timeText) timeText.innerText = "00:00.000";
    if (scrollGuideElement) scrollGuideElement.style.display = 'none';

    try {
        try {
            const metadata = await ipcRenderer.invoke('editor-read-local-tags', filePath);
            const artistInput = document.getElementById('meta-artist');
            const titleInput = document.getElementById('meta-title');
            if (artistInput) artistInput.value = metadata?.artist || '';
            if (titleInput) titleInput.value = metadata?.title || '';
        } catch(metaErr) {}

        // ── RUST_ENGINE: Peaks, duración y silencios vía motor Rust ──────────────
        // Sustituye: fs.readFile → decodeAudioData → buildWaveformPeaks → autoDetectSilence
        // El motor Rust decodifica en streaming (bajo RAM), calcula picos y detecta silencios.
        const peaksResult = await ipcRenderer.invoke('audio-engine-rust-command', {
            cmd: 'getPeaks',
            path: filePath,
            bins: 8192,
            cacheDir: editorCacheDir,
        });
        if (loadToken !== editorLoadToken || currentFilePath !== filePath) return;

        if (!peaksResult?.success || peaksResult.message?.type !== 'peaks') {
            const lblFileName = document.getElementById('lbl-filename');
            if (lblFileName) {
                lblFileName.innerText = 'Error: Motor Rust no pudo leer el archivo.';
                lblFileName.style.color = '#e74c3c';
            }
            return;
        }

        const peaksMsg = peaksResult.message;
        audioBuffer = null; // WEBAUDIO_DISABLED: ya no se necesita el AudioBuffer en RAM
        waveformPeaks = {
            min: new Float32Array(peaksMsg.min),
            max: new Float32Array(peaksMsg.max),
            bins: peaksMsg.bins,
        };
        currentDuration = peaksMsg.durationMs / 1000;
        // ─────────────────────────────────────────────────────────────────────────

        const lblFileName = document.getElementById('lbl-filename');
        if (lblFileName) lblFileName.innerText = path.basename(filePath);

        // Silencios detectados por Rust (reemplaza autoDetectSilence())
        const autoCues = {
            start: peaksMsg.silenceStart ?? 0,
            end:   peaksMsg.silenceEnd   ?? currentDuration,
        };
        await loadExistingCues(autoCues);
        
        requestAnimationFrame(() => { setTimeout(() => drawWaveform(), 150); });
    } catch(err) {
        const lblFileName = document.getElementById('lbl-filename');
        if (lblFileName) {
            lblFileName.innerText = 'Error crítico cargando el archivo.';
            lblFileName.style.color = '#e74c3c';
        }
    }
});

// WEBAUDIO_DISABLED_BEGIN — callbacks Web Audio desconectados
// ipcRenderer.on('settings-updated', () => { applyEditorAudioRouting(); });
// window.addEventListener('beforeunload', () => { stopEditorVuMeter(); });
// WEBAUDIO_DISABLED_END

async function loadExistingCues(autoCues = null) {
    let defaultInicio = autoCues ? autoCues.start : 0;
    let defaultFin = autoCues ? autoCues.end : (currentDuration || 0);
    // Mix automÃ¡tico (solo si no existe en BD). Regla simple: ~1s antes del fin
    // pero nunca antes del inicio + margen.
    const computeDefaultMix = () => {
        const minMix = Math.max(0.001, defaultInicio + 0.20);
        const mix = (defaultFin && defaultFin > 0) ? (defaultFin - 1.00) : 0;
        return Math.max(minMix, mix);
    };
    const defaultMix = computeDefaultMix();

    const row = await ipcRenderer.invoke('lib-get-db-track', currentFilePath);

    if (row) {
        if (row.customArtist) document.getElementById('meta-artist').value = row.customArtist;
        if (row.customTitle) document.getElementById('meta-title').value = row.customTitle;
        if (row.album) document.getElementById('meta-album').value = row.album;
        if (row.year) document.getElementById('meta-year').value = row.year;
        if (row.genre) document.getElementById('meta-genre').value = row.genre;
        document.getElementById('meta-remix').checked = (row.is_remix === 1);

        setFeats(row.feat || []);

        // Cues principales: si existen en BD, no se tocan.
        // Si NO existen (NULL/undefined), se calculan automÃ¡ticamente.
        ['inicio', 'intro', 'mix', 'outro', 'fin'].forEach(k => {
            const el = document.getElementById(`cue-${k}`);
            if (!el) return;

            const v = row[k];
            const hasDbValue = (v !== null && v !== undefined && !isNaN(parseFloat(v)));
            if (hasDbValue) { 
                el.value = parseFloat(v).toFixed(2);
                return;
            }

            if (k === 'inicio') el.value = defaultInicio.toFixed(2);
            else if (k === 'fin') el.value = defaultFin.toFixed(2);
            else if (k === 'mix') el.value = defaultMix.toFixed(2);
            else el.value = '0.00';
        });

        // Si faltan valores clave (inicio/fin/mix), dispara el anÃ¡lisis inteligente (FFmpeg)
        // usando los mismos umbrales que la Biblioteca: start -36dB, fin -48dB, mix -14dB.
        const needInicio = !hasDbNumber(row.inicio);
        const needFin = !hasDbNumber(row.fin);
        const needMix = !hasDbNumber(row.mix);
        if (needInicio || needFin || needMix) {
            pendingAutoAnalysis = { filePath: currentFilePath, needInicio, needFin, needMix };
            ipcRenderer.send('lib-start-analyzer-ffmpeg', [{
                filePath: currentFilePath,
                dbMix: -14,
                dbStart: -36,
                dbFin: -48,
                forceOverwrite: false
            }]);
        } else {
            pendingAutoAnalysis = null;
        }

        ['p1', 'p2', 'p3', 'phora'].forEach(k => {
            if(row[`${k}_mode`]) document.getElementById(`mode-${k}`).value = row[`${k}_mode`];
            const elTime = document.getElementById(`cue-${k}`);
            if (elTime) {
                if (row[`${k}_time`] !== null && row[`${k}_time`] !== undefined) elTime.value = parseFloat(row[`${k}_time`]).toFixed(2);
                else elTime.value = '0.00';
            }
            if(k !== 'phora' && row[`${k}_file`]) document.getElementById(`file-${k}`).value = row[`${k}_file`];
        });
    } else {
        ['inicio', 'intro', 'mix', 'outro', 'fin'].forEach(k => {
            const el = document.getElementById(`cue-${k}`);
            if (el) {
                if (k === 'inicio') el.value = defaultInicio.toFixed(2);
                else if (k === 'fin') el.value = defaultFin.toFixed(2);
                else if (k === 'mix') el.value = defaultMix.toFixed(2);
                else el.value = '0.00';
            }
        });

        // No existe fila aÃºn en BD: dispara anÃ¡lisis para poblarla (sin sobrescribir si luego se guarda manualmente).
        pendingAutoAnalysis = { filePath: currentFilePath, needInicio: true, needFin: true, needMix: true };
        ipcRenderer.send('lib-start-analyzer-ffmpeg', [{
            filePath: currentFilePath,
            dbMix: -14,
            dbStart: -36,
            dbFin: -48,
            forceOverwrite: false
        }]);
    }
    await loadArtistCountryForCurrentTrack();
}

ipcRenderer.on('analyzer-done', (e, payload) => {
    if (!payload || !payload.filePath) return;
    if (!currentFilePath || payload.filePath !== currentFilePath) return;
    if (!pendingAutoAnalysis || pendingAutoAnalysis.filePath !== currentFilePath) return;
    if (!payload.success || !payload.data) return;

    // Solo completa los campos que estaban faltando, y sin pisar si el usuario ya cambiÃ³ algo.
    if (pendingAutoAnalysis.needInicio && payload.data.inicio !== null && payload.data.inicio !== undefined) {
        if (isZeroOrEmptyCueInput('inicio')) document.getElementById('cue-inicio').value = parseFloat(payload.data.inicio).toFixed(2);
    }
    if (pendingAutoAnalysis.needFin && payload.data.fin !== null && payload.data.fin !== undefined) {
        if (isZeroOrEmptyCueInput('fin')) document.getElementById('cue-fin').value = parseFloat(payload.data.fin).toFixed(2);
    }
    if (pendingAutoAnalysis.needMix && payload.data.mix !== null && payload.data.mix !== undefined) {
        if (isZeroOrEmptyCueInput('mix')) document.getElementById('cue-mix').value = parseFloat(payload.data.mix).toFixed(2);
    }

    pendingAutoAnalysis = null;
    refreshOverlay();
});

async function saveCuesSilently() {
    if (!currentFilePath) return;
    
    const mc = { filePath: currentFilePath };
    mc.customArtist = document.getElementById('meta-artist').value;
    mc.feat = JSON.stringify(getFeats()); 
    mc.customTitle = document.getElementById('meta-title').value;
    mc.is_remix = document.getElementById('meta-remix').checked ? 1 : 0;
    mc.album = document.getElementById('meta-album').value;
    mc.year = document.getElementById('meta-year').value;
    mc.genre = document.getElementById('meta-genre').value;
    mc.artistCountry = document.getElementById('meta-country')?.value || '';
    
    ['inicio', 'intro', 'mix', 'outro', 'fin'].forEach(k => {
        const el = document.getElementById(`cue-${k}`);
        if(el) {
            const valNum = parseFloat(el.value);
            if (isNaN(valNum) || valNum === 0) mc[k] = null;
            else mc[k] = valNum;
        }
    });

    ['p1', 'p2', 'p3', 'phora'].forEach(k => {
        const timeVal = document.getElementById(`cue-${k}`).value;
        const numVal = parseFloat(timeVal);
        mc[`${k}_active`] = (!isNaN(numVal) && numVal > 0);
        mc[`${k}_mode`] = document.getElementById(`mode-${k}`).value;
        mc[`${k}_time`] = (!isNaN(numVal) && numVal > 0) ? timeVal : null;
        if(k !== 'phora') mc[`${k}_file`] = document.getElementById(`file-${k}`).value || null;
    });

    await ipcRenderer.invoke('lib-save-db-track', mc);
    ipcRenderer.send('refresh-manual-cues');
}

// FASE 2A — detener el player Rust antes de cerrar.
function stopAudioEditorRustOnExit() {
    try {
        ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player: 'audio-editor' }).catch(() => {});
    } catch (err) {}
}
window.addEventListener('beforeunload', stopAudioEditorRustOnExit);

window.saveAndClose = async function() {
    stopAudioEditorRustOnExit();
    await saveCuesSilently();
    window.close();
}
// FASE 2A — el HTML pone onclick="window.close()" directo en el botón Cancelar.
// Lo interceptamos sobreescribiendo window.close para que pare el player primero.
const __originalWindowClose = window.close.bind(window);
window.close = function() {
    stopAudioEditorRustOnExit();
    __originalWindowClose();
};

const btnPrev = document.getElementById('btn-prev-track');
if(btnPrev) { btnPrev.addEventListener('click', async () => { await saveCuesSilently(); ipcRenderer.send('editor-request-track', { current: currentFilePath, dir: 'prev' }); }); }

const btnNext = document.getElementById('btn-next-track');
if(btnNext) { btnNext.addEventListener('click', async () => { await saveCuesSilently(); ipcRenderer.send('editor-request-track', { current: currentFilePath, dir: 'next' }); }); }

window.setCue = function(type) { let t = getEditorCurrentTime(); const el = document.getElementById(`cue-${type}`); if(el) el.value = t.toFixed(2); refreshOverlay(); };
window.clearCue = function(type) { const el = document.getElementById(`cue-${type}`); if(el) el.value = '0.00'; refreshOverlay(); };
window.playFrom = function(type) { const cueInput = document.getElementById(`cue-${type}`); if (cueInput) { const timeVal = parseFloat(cueInput.value); if (!isNaN(timeVal)) playAudio(timeVal, true); } };
window.togglePlay = async function() {
    try {
        if (isPlaying) {
            stopAudio(true);
        } else {
            // WEBAUDIO_DISABLED: if (audioCtx.state === 'suspended') await audioCtx.resume();
            await playAudio(pauseTime, true);
        }
    } catch (err) {
        console.error('[AudioEditor] togglePlay error:', err);
    }
    updatePlayButtonVisual();
};

function updatePlayButtonVisual() {
    const btn = document.getElementById('btn-master-play');
    if (!btn) return;
    btn.innerText = isPlaying ? '⏸ Pausa' : '▶ Play';
}

window.stopAudio = function(isPause = false) {
    // WEBAUDIO_DISABLED_BEGIN — ya no hay sourceNode de WebAudio en reproducción normal
    // if (sourceNode) { sourceNode.onended = null; try { sourceNode.stop(); } catch(e) {} sourceNode.disconnect(); sourceNode = null; }
    // WEBAUDIO_DISABLED_END

    // RUST_ENGINE: Detener el player del editor en el motor Rust
    ipcRenderer.invoke('audio-engine-rust-command', { cmd: 'stop', player: 'audio-editor' }).catch(() => {});

    if (isPause) pauseTime = performance.now() / 1000 - startTime;
    else { pauseTime = 0; if(aeCursorElement) aeCursorElement.style.left = '0px'; if(timeText) timeText.innerText = "00:00.000"; }
    isPlaying = false;
    stopCursorLoop();
    updatePlayButtonVisual();
};

async function playAudio(startAt, forcePlay = false) {
    if (!currentFilePath || !waveformPeaks) return;

    // WEBAUDIO_DISABLED_BEGIN — reproducción ya no usa AudioBuffer ni BufferSourceNode
    // if (!audioBuffer) return;
    // if (audioCtx.state === 'suspended') await audioCtx.resume();
    // ensureEditorPreviewPlayback();
    // if (sourceNode) { sourceNode.onended = null; try { sourceNode.stop(); } catch(e){} sourceNode.disconnect(); sourceNode = null; }
    // sourceNode = audioCtx.createBufferSource(); sourceNode.buffer = audioBuffer; sourceNode.connect(editorOutputNode);
    // sourceNode.start(0, startAt); startTime = audioCtx.currentTime - startAt;
    // sourceNode.onended = () => { if (isPlaying) stopAudio(); };
    // WEBAUDIO_DISABLED_END

    const wasPlaying = isPlaying;
    pauseTime = startAt;

    if (wasPlaying || forcePlay) {
        // RUST_ENGINE: Cargar archivo en el motor Rust y reproducir desde startAt
        try {
            await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'loadAudio', player: 'audio-editor', path: currentFilePath, gain: 1.0, bus: 'cue',
            });
            if (startAt > 0.01) {
                await ipcRenderer.invoke('audio-engine-rust-command', {
                    cmd: 'seek', player: 'audio-editor', positionMs: Math.round(startAt * 1000),
                });
            }
            await ipcRenderer.invoke('audio-engine-rust-command', {
                cmd: 'play', player: 'audio-editor',
            });
        } catch (err) {
            console.error('[AudioEditor] Rust playback error:', err);
        }

        startTime = performance.now() / 1000 - startAt; // reloj para getEditorCurrentTime()
        isPlaying = true;
        autoScrollEnabled = true;
        lastManualNavigationAt = 0;

        const px = getCursorPixel(startAt);
        centerCursorInViewport(px);
        syncCursorPosition(startAt);
        startCursorLoop();
        updatePlayButtonVisual();
    } else {
        syncCursorPosition(pauseTime);
    }
}

if (container) {
    container.addEventListener('mousedown', (e) => {
        if (e.target === container) markManualNavigation();
    });
    container.addEventListener('scroll', () => {
        if (!ignoreScrollSync) markManualNavigation();
        updateScrollGuide();
    }, { passive: true });
    // Bug 1 fix: mouseleave como respaldo para soltar el drag si el cursor sale del contenedor
    container.addEventListener('mouseleave', () => {
        if (isDraggingWave) {
            isDraggingWave = false;
            setWaveCursor('crosshair');
        }
    });
}

if (zoomSlider) {
    // Slider: zoom centrado en el playhead (línea roja)
    zoomSlider.addEventListener('input', (e) => {
        let currentSeconds = getEditorCurrentTime(); // RUST_ENGINE: era audioCtx.currentTime - startTime

        zoomLevel = parseFloat(e.target.value);
        drawWaveform();

        if (currentDuration > 0) {
            syncCursorPosition(currentSeconds);
            // Centrar siempre en el playhead
            autoScrollEnabled = true;
            const px = getCursorPixel(currentSeconds);
            setContainerScrollLeft(px - (container.clientWidth / 2));
        }
    });
}

function drawWaveform() {
    // RUST_ENGINE: audioBuffer ya no se usa; la guarda pasa a waveformPeaks + currentDuration
    if (!waveformPeaks || !currentDuration || !container || !canvas || !innerWrapper || !ctx) return;
    const baseWidth = container.clientWidth; if(baseWidth === 0) return;

    canvas.width = baseWidth * zoomLevel; canvas.height = container.clientHeight; innerWrapper.style.width = `${canvas.width}px`;
    if (overlayCanvas) {
        overlayCanvas.width = canvas.width;
        overlayCanvas.height = canvas.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const binsPerPixel = waveformPeaks.bins / canvas.width;
    const amp = canvas.height / 2;

    // FIX BUG (waveform legible): el algoritmo anterior pintaba rectángulos
    // verticales de `min` a `max` por pixel. En música densa con bins agrupados,
    // ambos rozan ±1 → la onda se ve como "código de barras" saturado. La
    // solución profesional: pintar una ENVELOPE espejada usando la amplitud
    // absoluta máxima por pixel. Resultado: silueta clásica de Audition.

    // 1) Calcular amplitud absoluta por columna de pixel.
    const peakPerPixel = new Float32Array(canvas.width);
    for (let i = 0; i < canvas.width; i++) {
        let absMax = 0;
        const startBin = Math.floor(i * binsPerPixel);
        const endBin = Math.max(startBin + 1, Math.ceil((i + 1) * binsPerPixel));
        for (let j = startBin; j < endBin && j < waveformPeaks.bins; j++) {
            const a = Math.max(Math.abs(waveformPeaks.min[j]), Math.abs(waveformPeaks.max[j]));
            if (a > absMax) absMax = a;
        }
        peakPerPixel[i] = absMax;
    }

    // 2) Pintar envelope rellena (top + bottom espejada desde el centro).
    ctx.fillStyle = '#00a8ff';
    ctx.beginPath();
    ctx.moveTo(0, amp);
    // Borde superior (de izquierda a derecha)
    for (let i = 0; i < canvas.width; i++) {
        const y = amp - (peakPerPixel[i] * amp);
        ctx.lineTo(i, y);
    }
    // Borde inferior (de derecha a izquierda, espejado)
    for (let i = canvas.width - 1; i >= 0; i--) {
        const y = amp + (peakPerPixel[i] * amp);
        ctx.lineTo(i, y);
    }
    ctx.closePath();
    ctx.fill();

    // 3) Línea central tenue para reforzar la lectura del "eje cero".
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, amp);
    ctx.lineTo(canvas.width, amp);
    ctx.stroke();

    refreshOverlay();
}

function drawMarkers() {
    if(!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const markers = [
        { id: 'inicio', color: '#2ecc71', lbl: 'INICIO' }, { id: 'intro', color: '#f1c40f', lbl: 'INTRO' }, { id: 'mix', color: '#00a8ff', lbl: 'MIX' },
        { id: 'outro', color: '#e74c3c', lbl: 'OUTRO' }, { id: 'fin', color: '#c0392b', lbl: 'FIN' }, { id: 'p1', color: '#9b59b6', lbl: 'P1' },
        { id: 'p2', color: '#9b59b6', lbl: 'P2' }, { id: 'p3', color: '#9b59b6', lbl: 'P3' }, { id: 'phora', color: '#2ecc71', lbl: 'HORA' }
    ];
    overlayCtx.font = '10px Consolas';
    markers.forEach(m => {
        const inputEl = document.getElementById(`cue-${m.id}`);
        if (inputEl && inputEl.value && !isNaN(parseFloat(inputEl.value))) {
            const t = parseFloat(inputEl.value);
            if (t > 0) {
                const px = (t / currentDuration) * canvas.width;
                overlayCtx.beginPath(); overlayCtx.moveTo(px, 0); overlayCtx.lineTo(px, canvas.height); overlayCtx.strokeStyle = m.color; overlayCtx.setLineDash([5, 5]); overlayCtx.lineWidth = 2; overlayCtx.stroke(); overlayCtx.setLineDash([]);
                overlayCtx.fillStyle = m.color; overlayCtx.fillRect(px + 2, 5, overlayCtx.measureText(m.lbl).width + 10, 16); overlayCtx.fillStyle = '#000'; overlayCtx.fillText(m.lbl, px + 7, 16);
            }
        }
    });
}

function getMarkerAtX(x) {
    const tolerance = 10; const markers = ['inicio', 'intro', 'mix', 'outro', 'fin', 'p1', 'p2', 'p3', 'phora'];
    for (let id of markers) {
        const inputEl = document.getElementById(`cue-${id}`);
        if (inputEl && inputEl.value && !isNaN(parseFloat(inputEl.value))) {
            const t = parseFloat(inputEl.value); if (t > 0) { const px = (t / currentDuration) * canvas.width; if (Math.abs(x - px) <= tolerance) return id; }
        }
    }
    return null;
}

if (innerWrapper) {
    innerWrapper.addEventListener('mousedown', (e) => {
        // FIX BUG (click sobre onda no responde): en modo Rust audioBuffer
        // siempre es null porque el decode lo hace el motor nativo. Antes el
        // guard `!audioBuffer` bloqueaba el inicio del click/drag de la onda.
        // Cambiado a `!waveformPeaks` que sí refleja "pista lista".
        if (!waveformPeaks) return;
        const rect = innerWrapper.getBoundingClientRect(); const x = e.clientX - rect.left; draggedMarkerId = getMarkerAtX(x);
        if (draggedMarkerId) { isDraggingMarker = true; setWaveCursor('ew-resize'); }
        else { isDraggingWave = true; dragStartX = e.clientX; scrollStartX = container.scrollLeft; setWaveCursor('grabbing'); markManualNavigation(); }
    });
    // Ctrl+Rueda: zoom centrado en la posición del mouse
    innerWrapper.addEventListener('wheel', (e) => {
        if (!waveformPeaks) return;
        if (e.ctrlKey || e.shiftKey) {
            e.preventDefault();
            const containerRect = container.getBoundingClientRect();
            const mouseContainerX = e.clientX - containerRect.left;
            // Tiempo en la posición del mouse antes del zoom
            const canvasX = container.scrollLeft + mouseContainerX;
            const timeAtMouse = currentDuration > 0 ? (canvasX / canvas.width) * currentDuration : 0;
            // Cambiar zoom
            const step = 1;
            zoomLevel = e.deltaY < 0 ? Math.min(zoomLevel + step, 30) : Math.max(zoomLevel - step, 1);
            if (zoomSlider) zoomSlider.value = zoomLevel;
            // Redibujar con nuevo zoom
            drawWaveform();
            if (currentDuration > 0) {
                // Calcular nueva posición del pixel para el tiempo que estaba bajo el mouse
                const newCanvasX = (timeAtMouse / currentDuration) * canvas.width;
                markManualNavigation();
                setContainerScrollLeft(newCanvasX - mouseContainerX);
                syncCursorPosition();
            }
        }
    });
    // Bug 1 fix: mouseleave en el wrapper interno también
    innerWrapper.addEventListener('mouseleave', () => {
        if (isDraggingMarker) {
            // No soltar marcador en mouseleave - solo en mouseup (puede necesitar arrastrar fuera)
        }
        // El drag de onda sí se suelta si el cursor sale
        if (isDraggingWave) {
            isDraggingWave = false;
            setWaveCursor('crosshair');
        }
    });
}


window.addEventListener('mousemove', (e) => {
    // FIX BUG: mismo motivo — `audioBuffer` siempre null en modo Rust.
    if (!waveformPeaks || !innerWrapper) return;
    if (isDraggingMarker && draggedMarkerId) {
        const rect = innerWrapper.getBoundingClientRect(); let x = e.clientX - rect.left;
        if (x < 0) x = 0; if (x > canvas.width) x = canvas.width;
        const newTime = (x / canvas.width) * currentDuration; document.getElementById(`cue-${draggedMarkerId}`).value = newTime.toFixed(2); drawMarkers(); 
    } else if (isDraggingWave && container) { const deltaX = e.clientX - dragStartX; container.scrollLeft = scrollStartX - deltaX; }
});

// Bug 1+2 fix: mouseup global con reset robusto de todos los estados de drag
window.addEventListener('mouseup', (e) => {
    if (isDraggingMarker) {
        isDraggingMarker = false;
        draggedMarkerId = null;
        setWaveCursor('crosshair');
        refreshOverlay();
    } else if (isDraggingWave) {
        const wasDrag = Math.abs(e.clientX - dragStartX) >= 5;
        isDraggingWave = false;
        setWaveCursor('crosshair');
        // Bug 2 fix: si fue un clic (no un drag real), saltar a esa posición
        if (!wasDrag && innerWrapper && canvas && currentDuration > 0) {
            autoScrollEnabled = true;
            const rect = innerWrapper.getBoundingClientRect();
            const x = clamp(e.clientX - rect.left, 0, canvas.width);
            const targetTime = clamp((x / canvas.width) * currentDuration, 0, currentDuration);
            // Siempre sincronizar visual + audio juntos
            pauseTime = targetTime;
            syncCursorPosition(targetTime);
            playAudio(targetTime, true);
        }
    }
});

// Bug 1 fix: blur en window como último respaldo — si la ventana pierde foco, soltar todo
window.addEventListener('blur', () => {
    if (isDraggingMarker) {
        isDraggingMarker = false;
        draggedMarkerId = null;
        setWaveCursor('crosshair');
    }
    if (isDraggingWave) {
        isDraggingWave = false;
        setWaveCursor('crosshair');
    }
});

// FIX BUG (resize en modo Rust): mismo motivo que el resizeObserver — la
// guarda `if (audioBuffer)` era false porque el motor Rust hace el decode.
window.addEventListener('resize', () => { if(waveformPeaks) drawWaveform(); });
window.browsePisador = async function(id) {
    const filePath = await ipcRenderer.invoke('dialog:openFile');
    if (filePath) {
        document.getElementById(`file-${id}`).value = filePath;
    }
};
window.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return; if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePlay(); } });

// Bug 4 fix: vincular el botón Play explícitamente con addEventListener
const btnMasterPlay = document.getElementById('btn-master-play');
if (btnMasterPlay) {
    // Remover el onclick inline para evitar doble disparo
    btnMasterPlay.removeAttribute('onclick');
    btnMasterPlay.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await togglePlay();
    });
}

// Reanudar/pausar actualización del cursor según visibilidad.
document.addEventListener('visibilitychange', () => { 
    if (isEditorActiveForCursorUpdates()) startCursorLoop();
    else stopCursorLoop();
});
window.addEventListener('focus', () => startCursorLoop());


// Control de Scroll para inputs numéricos (Global)
document.addEventListener('wheel', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        e.preventDefault();
        const input = e.target;
        if (input.disabled || input.readOnly) return;
        
        const step = parseFloat(input.getAttribute('step')) || 1;
        let val = parseFloat(input.value) || 0;
        
        if (e.deltaY < 0) val += step;
        else val -= step;
        
        const min = input.getAttribute('min');
        if (min !== null && val < parseFloat(min)) val = parseFloat(min);
        const max = input.getAttribute('max');
        if (max !== null && val > parseFloat(max)) val = parseFloat(max);
        
        const stepStr = step.toString();
        const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
        input.value = val.toFixed(decimalPlaces);
        
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}, { passive: false });
