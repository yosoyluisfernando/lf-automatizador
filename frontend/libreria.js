const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const Fuse = require('fuse.js');
const { getConfigDir } = require('../backend/utils/app_paths');
const i18n = require('./i18n');

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

const configDir = getConfigDir(path.join(__dirname, '..', 'config'), __dirname);
const libSessionPath = path.join(configDir, 'lib_session.json');
const libraryPrefsPath = path.join(configDir, 'library_prefs.json');

const defaultLibraryColumnsConfig = [
    { id: 'status', width: 50 },
    { id: 'fullPath', width: 230 },
    { id: 'title', width: 160 },
    { id: 'artist', width: 130 },
    { id: 'album', width: 120 },
    { id: 'genre', width: 110 },
    { id: 'year', width: 50 },
    { id: 'inicio', width: 55 },
    { id: 'mix', width: 55 },
    { id: 'fin', width: 55 },
    { id: 'db', width: 60 }
];

function getLocalizedColumnsConfig() {
    return defaultLibraryColumnsConfig.map(col => {
        let title = '';
        switch(col.id) {
            case 'status': title = i18n.t('library.dynamic.col_status') || 'Estado'; break;
            case 'fullPath': title = i18n.t('library.dynamic.col_path') || 'Ruta Completa'; break;
            case 'title': title = i18n.t('library.dynamic.col_title') || 'Título'; break;
            case 'artist': title = i18n.t('library.dynamic.col_artist') || 'Artista'; break;
            case 'album': title = i18n.t('library.dynamic.col_album') || 'Álbum'; break;
            case 'genre': title = i18n.t('library.dynamic.col_genre') || 'Género'; break;
            case 'year': title = i18n.t('library.dynamic.col_year') || 'Año'; break;
            case 'inicio': title = i18n.t('library.dynamic.col_ini') || 'Ini (s)'; break;
            case 'mix': title = i18n.t('library.dynamic.col_mix') || 'Mix (s)'; break;
            case 'fin': title = i18n.t('library.dynamic.col_fin') || 'Fin (s)'; break;
            case 'db': title = 'dB'; break;
        }
        return { ...col, title };
    });
}

const defaultLibraryColumnWidths = defaultLibraryColumnsConfig.map(col => col.width);
const libraryColumnMinWidths = [50, 180, 140, 120, 120, 105, 50, 55, 55, 55, 60];

const defaultLibraryPrefs = {
    persistentRoot: '',
    autoLoadRootOnOpen: true,
    rescanRootOnOpen: false,
    columnWidths: defaultLibraryColumnWidths
};

let workQueueTracks = []; 
let filteredTracks = []; 
const __isLinux = process.platform === 'linux';
let defaultPaths = __isLinux
    ? { downloads: path.sep, music: path.sep, home: path.sep }
    : { desktop: path.sep, downloads: path.sep, music: path.sep };
let systemDrives = __isLinux ? [] : ['C:\\']; 

let isAnalyzing = false; 
let cancelRequested = false; 
let currentTab = 'audio';

let currentSortCol = 'fullPath'; 
let isSortAscending = true;

let selectedPaths = new Set();
let lastSelectedPath = null;
let pendingGenreEditPaths = [];

// Variables para el árbol del explorador (Izquierda)
let selectedTreeNodes = new Set();
let lastSelectedTreeNode = null;
let activeTreeNodeElements = new Set();

let fuseEngine = null;
let searchTimeout = null;
let manualCuesDB = {}; 
let trackedLibraryRoots = [];
let libraryPrefs = { ...defaultLibraryPrefs };
let genreAssistantItems = [];
let genreProfiles = [];

let totalBatchTasks = 0;
let completedBatchTasks = 0;
let virtualRenderPending = false;

function sortByDisplayName(items, key = 'displayName') {
    return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
        const left = String(a?.[key] || '').toLocaleLowerCase();
        const right = String(b?.[key] || '').toLocaleLowerCase();
        return left.localeCompare(right, 'es');
    });
}

// ESTADO DE VISTA DE DECIBELES
let dbViewMode = localStorage.getItem('lib_db_view_mode') || 'peak';

const ROW_HEIGHT = 26; 
const OVERSCAN = 50; 

let columnsConfig = getLocalizedColumnsConfig();

function normalizeLibraryColumnWidths(widths) {
    const normalized = [];
    for (let i = 0; i < defaultLibraryColumnWidths.length; i++) {
        const fallbackWidth = defaultLibraryColumnWidths[i];
        const minWidth = libraryColumnMinWidths[i] || 50;
        const rawWidth = Array.isArray(widths) ? Number(widths[i]) : NaN;
        normalized.push(Number.isFinite(rawWidth) ? Math.max(minWidth, Math.round(rawWidth)) : fallbackWidth);
    }
    return normalized;
}

function applyStoredLibraryColumnWidths() {
    const normalizedWidths = normalizeLibraryColumnWidths(libraryPrefs.columnWidths);
    columnsConfig = getLocalizedColumnsConfig().map((column, index) => ({
        ...column,
        width: normalizedWidths[index]
    }));
    libraryPrefs.columnWidths = normalizedWidths;
}

function getLibraryTableTotalWidth() {
    return columnsConfig.reduce((total, column) => total + (Number(column.width) || 0), 0);
}

function syncLibraryTableWidths() {
    const headerTable = document.getElementById('lib-header-table');
    const bodyTable = document.getElementById('lib-tracks-table');
    const spacer = document.getElementById('virtual-spacer');
    const scrollContainer = document.getElementById('lib-scroll-container');
    const headerContainer = document.querySelector('.table-header-container');
    const tableWidth = getLibraryTableTotalWidth();
    const widthValue = `${tableWidth}px`;

    if (headerTable) {
        headerTable.style.width = widthValue;
        headerTable.style.minWidth = widthValue;
        headerTable.style.maxWidth = widthValue;
    }
    if (bodyTable) {
        bodyTable.style.width = widthValue;
        bodyTable.style.minWidth = widthValue;
        bodyTable.style.maxWidth = widthValue;
    }
    if (spacer) spacer.style.width = widthValue;
    if (headerContainer && scrollContainer) headerContainer.scrollLeft = scrollContainer.scrollLeft;
}

function syncLibraryColumnWidthsToDom() {
    syncLibraryTableWidths();
    const headerCells = document.querySelectorAll('#lib-table-head th');
    headerCells.forEach((th, index) => {
        const widthValue = `${columnsConfig[index].width}px`;
        th.style.width = widthValue;
        th.style.minWidth = widthValue;
        th.style.maxWidth = widthValue;
    });

    const bodyRows = document.querySelectorAll('#lib-table-body tr');
    bodyRows.forEach((row) => {
        Array.from(row.children).forEach((cell, index) => {
            const widthValue = `${columnsConfig[index].width}px`;
            cell.style.width = widthValue;
            cell.style.minWidth = widthValue;
            cell.style.maxWidth = widthValue;
        });
    });
}

function applySelectionToVisibleRows() {
    document.querySelectorAll('#lib-table-body tr[data-path]').forEach(row => {
        row.classList.toggle('selected', selectedPaths.has(row.dataset.path));
    });
}

function requestVirtualRender() {
    if (virtualRenderPending) return;
    virtualRenderPending = true;
    window.requestAnimationFrame(() => {
        virtualRenderPending = false;
        renderVirtualQueue();
    });
}

function persistLibraryColumnWidths() {
    libraryPrefs.columnWidths = columnsConfig.map(column => column.width);
    saveLibraryPrefs();
}

function startLibraryColumnResize(event, columnIndex) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = Number(columnsConfig[columnIndex]?.width) || defaultLibraryColumnWidths[columnIndex];
    const minWidth = libraryColumnMinWidths[columnIndex] || 50;
    document.body.classList.add('table-resizing');

    const onMouseMove = (moveEvent) => {
        const nextWidth = Math.max(minWidth, Math.round(startWidth + (moveEvent.clientX - startX)));
        if (columnsConfig[columnIndex].width === nextWidth) return;
        columnsConfig[columnIndex].width = nextWidth;
        syncLibraryColumnWidthsToDom();
    };

    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.classList.remove('table-resizing');
        persistLibraryColumnWidths();
        renderTableHeader();
        renderVirtualQueue();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function saveLibSession() {
    try {
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        const sessionData = {
            paths: workQueueTracks.map(t => t.fullPath),
            roots: trackedLibraryRoots
        };
        fs.writeFileSync(libSessionPath, JSON.stringify(sessionData));
    } catch(e) {}
}

function loadLibraryPrefs() {
    try {
        if (fs.existsSync(libraryPrefsPath)) {
            const rawPrefs = JSON.parse(fs.readFileSync(libraryPrefsPath, 'utf-8'));
            libraryPrefs = {
                ...defaultLibraryPrefs,
                ...(rawPrefs && typeof rawPrefs === 'object' ? rawPrefs : {})
            };
        } else {
            libraryPrefs = { ...defaultLibraryPrefs };
        }
    } catch (err) {
        libraryPrefs = { ...defaultLibraryPrefs };
    }

    if (libraryPrefs.persistentRoot) {
        libraryPrefs.persistentRoot = normalizeLibraryPath(libraryPrefs.persistentRoot);
    }
    applyStoredLibraryColumnWidths();
}

function saveLibraryPrefs() {
    try {
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(libraryPrefsPath, JSON.stringify(libraryPrefs, null, 2));
    } catch (err) {}
}

function lockUI() {
    document.getElementById('btn-load-root').classList.add('ui-locked-buttons');
    document.getElementById('btn-refresh').classList.add('ui-locked-buttons');
    document.getElementById('group-footer-btn').classList.add('ui-locked-buttons');
    document.getElementById('lib-explorer').classList.add('ui-locked-buttons');
}

function unlockUI() {
    document.getElementById('btn-load-root').classList.remove('ui-locked-buttons');
    document.getElementById('btn-refresh').classList.remove('ui-locked-buttons');
    document.getElementById('group-footer-btn').classList.remove('ui-locked-buttons');
    document.getElementById('lib-explorer').classList.remove('ui-locked-buttons');
}

function isCompleteAudio(d) {
    return (d.inicio != null && d.inicio !== '' && d.mix != null && d.mix !== '' && d.fin != null && d.fin !== '' && d.db != null && d.db !== '');
}

function getTrackStatusCode(trackData) {
    if (trackData?.fileChanged === true) return 2;
    return isCompleteAudio(trackData) ? 1 : 0;
}

function buildQueueTrack(filePath, dbData = {}, existingTrack = null) {
    const filename = path.basename(filePath);
    const fallbackTitle = filename.replace(/\.[^/.]+$/, "");
    const nextTrack = {
        fullPath: filePath,
        filename,
        title: dbData.customTitle || existingTrack?.title || fallbackTitle,
        artist: dbData.customArtist || existingTrack?.artist || '',
        album: dbData.album || existingTrack?.album || '',
        genre: dbData.genre || existingTrack?.genre || '',
        primaryGenre: dbData.primaryGenre || existingTrack?.primaryGenre || '',
        subgenre: dbData.subgenre || existingTrack?.subgenre || '',
        artistCountry: dbData.artistCountry || existingTrack?.artistCountry || '',
        artistCountryCode: dbData.artistCountryCode || existingTrack?.artistCountryCode || '',
        genresJson: dbData.genresJson || existingTrack?.genresJson || '',
        year: dbData.year || existingTrack?.year || '',
        inicio: dbData.inicio ?? existingTrack?.inicio ?? '',
        fin: dbData.fin ?? existingTrack?.fin ?? '',
        mix: dbData.mix ?? existingTrack?.mix ?? '',
        db: dbData.db ?? existingTrack?.db ?? '',
        peak_db: dbData.peak_db ?? existingTrack?.peak_db ?? '',
        bpm: dbData.bpm ?? existingTrack?.bpm ?? '',
        metaError: existingTrack?.metaError === true,
        fileChanged: dbData.fileChanged === true,
        fileSize: dbData.fileSize ?? existingTrack?.fileSize ?? null,
        fileMtimeMs: dbData.fileMtimeMs ?? existingTrack?.fileMtimeMs ?? null
    };
    nextTrack.status = getTrackStatusCode(nextTrack);
    return nextTrack;
}

function applyCurrentSearchAndRender() {
    const query = document.getElementById('lib-search-input')?.value?.trim() || '';
    if (!query) {
        filteredTracks = [...workQueueTracks];
    } else if (fuseEngine) {
        filteredTracks = fuseEngine.search(query).map(result => result.item);
    } else {
        filteredTracks = [...workQueueTracks];
    }
    applySortingAndRender();
}

function isAudioFilePath(filePath) {
    return /\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i.test(filePath || '');
}

function normalizeLibraryPath(targetPath) {
    try {
        return path.resolve(targetPath || '');
    } catch (err) {
        return targetPath || '';
    }
}

function mergeTrackedRoots(...rootGroups) {
    const merged = [];
    for (const rootGroup of rootGroups) {
        for (const rawRoot of rootGroup || []) {
            const normalizedRoot = normalizeLibraryPath(rawRoot);
            if (!normalizedRoot) continue;

            const alreadyCovered = merged.some(existing => normalizedRoot === existing || normalizedRoot.startsWith(`${existing}${path.sep}`));
            if (alreadyCovered) continue;

            for (let i = merged.length - 1; i >= 0; i--) {
                if (merged[i].startsWith(`${normalizedRoot}${path.sep}`)) merged.splice(i, 1);
            }

            merged.push(normalizedRoot);
        }
    }
    return merged;
}

function isPathInsideRoot(filePath, rootPath) {
    const normalizedFile = normalizeLibraryPath(filePath);
    const normalizedRoot = normalizeLibraryPath(rootPath);
    return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`);
}

function getPersistentRootPath() {
    const configuredRoot = normalizeLibraryPath(libraryPrefs.persistentRoot || '');
    if (!configuredRoot) return '';
    try {
        return (fs.existsSync(configuredRoot) && fs.statSync(configuredRoot).isDirectory()) ? configuredRoot : '';
    } catch (err) {
        return '';
    }
}

function refreshLibraryRootUi() {
    const btnLoadRoot = document.getElementById('btn-load-root');
    if (btnLoadRoot) {
        const rootPath = getPersistentRootPath();
        if (rootPath) {
            btnLoadRoot.innerText = i18n.t('library.root_btn_text') || '📁 Mostrar Raíz';
            btnLoadRoot.title = (i18n.t('library.dynamic.root_configured') || 'Cargar la carpeta raíz configurada:') + ' ' + rootPath;
        } else {
            btnLoadRoot.innerText = i18n.t('library.dynamic.root_config_btn') || '📁 Configurar Raíz';
            btnLoadRoot.title = i18n.t('library.dynamic.root_config_title') || 'Define una carpeta raíz fija para la biblioteca';
        }
    }

    const rootPathField = document.getElementById('library-root-path');
    if (rootPathField) rootPathField.value = libraryPrefs.persistentRoot || '';

    const rootStatus = document.getElementById('library-root-status');
    if (rootStatus) {
        const activeRoot = getPersistentRootPath();
        if (activeRoot) {
            rootStatus.innerText = i18n.t('library.dynamic.root_ready') || 'La carpeta raíz fija está lista para cargarse y refrescarse cuando lo necesites.';
        } else if (libraryPrefs.persistentRoot) {
            rootStatus.innerText = i18n.t('library.dynamic.root_unavailable') || 'La carpeta configurada no está disponible ahora mismo. Revisa si fue movida, renombrada o si la unidad no está conectada.';
        } else {
            rootStatus.innerText = i18n.t('library.dynamic.root_empty') || 'No hay una carpeta raíz fija configurada todavía.';
        }
    }

    const autoLoadCheckbox = document.getElementById('chk-lib-auto-root');
    if (autoLoadCheckbox) autoLoadCheckbox.checked = libraryPrefs.autoLoadRootOnOpen === true;

    const rescanCheckbox = document.getElementById('chk-lib-root-rescan');
    if (rescanCheckbox) rescanCheckbox.checked = libraryPrefs.rescanRootOnOpen === true;
}

function closeLibrarySettings() {
    const modal = document.getElementById('library-settings-modal');
    if (modal) modal.style.display = 'none';
}

window.openLibrarySettings = function() {
    refreshLibraryRootUi();
    const modal = document.getElementById('library-settings-modal');
    if (modal) modal.style.display = 'flex';
}

window.closeLibrarySettings = closeLibrarySettings;

window.pickPersistentRootFolder = async function() {
    if (isAnalyzing) return;
    try {
        const folderPath = await ipcRenderer.invoke('dialog:selectFolder');
        if (!folderPath) return;
        libraryPrefs.persistentRoot = normalizeLibraryPath(folderPath);
        saveLibraryPrefs();
        refreshLibraryRootUi();
    } catch (err) {}
}

window.clearPersistentRootFolder = function() {
    const previousRoot = getPersistentRootPath();
    libraryPrefs.persistentRoot = '';
    libraryPrefs.autoLoadRootOnOpen = false;
    libraryPrefs.rescanRootOnOpen = false;
    if (previousRoot) {
        trackedLibraryRoots = trackedLibraryRoots.filter(root => normalizeLibraryPath(root) !== previousRoot);
        saveLibSession();
    }
    saveLibraryPrefs();
    refreshLibraryRootUi();
}

window.applyLibrarySettings = async function() {
    const autoLoadCheckbox = document.getElementById('chk-lib-auto-root');
    const rescanCheckbox = document.getElementById('chk-lib-root-rescan');
    libraryPrefs.autoLoadRootOnOpen = !!autoLoadCheckbox?.checked;
    libraryPrefs.rescanRootOnOpen = !!rescanCheckbox?.checked;
    saveLibraryPrefs();
    refreshLibraryRootUi();

    const persistentRoot = getPersistentRootPath();
    if (persistentRoot && libraryPrefs.autoLoadRootOnOpen) {
        trackedLibraryRoots = mergeTrackedRoots(trackedLibraryRoots, [persistentRoot]);
        saveLibSession();
    }
    closeLibrarySettings();
}

window.loadPersistentRootNow = async function() {
    if (!getPersistentRootPath()) {
        await window.pickPersistentRootFolder();
        if (!getPersistentRootPath()) return;
    }
    closeLibrarySettings();
    await window.selectRootFolder();
}

async function refreshWorkQueueFromDatabase() {
    const paths = workQueueTracks.map(track => track.fullPath).filter(Boolean);
    const scopedDb = await ipcRenderer.invoke('lib-get-db-tracks', paths);
    manualCuesDB = { ...manualCuesDB, ...(scopedDb || {}) };
    workQueueTracks = workQueueTracks.map(track => buildQueueTrack(track.fullPath, manualCuesDB[track.fullPath] || {}, track));
    initFuseEngine();
    applyCurrentSearchAndRender();
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

function renderGenreAssistant(items) {
    const tbody = document.getElementById('genre-assistant-body');
    const summary = document.getElementById('genre-assistant-summary');
    if (!tbody) return;
    genreAssistantItems = Array.isArray(items) ? items : [];
    tbody.innerHTML = '';

    if (genreAssistantItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:#888; text-align:center;">${i18n.t('library.dynamic.assistant_no_folders_table') || 'No se encontraron carpetas dentro de la raiz configurada.'}</td></tr>`;
        if (summary) summary.innerText = i18n.t('library.dynamic.assistant_no_folders') || 'Sin carpetas disponibles para sugerir.';
        return;
    }

    const fragment = document.createDocumentFragment();
    genreAssistantItems.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.className = `genre-folder-depth-${item.depth || 1}`;
        tr.dataset.index = String(index);
        tr.title = item.path || '';
        tr.innerHTML = `
            <td><input type="checkbox" class="genre-use" checked></td>
            <td>${item.depth > 1 ? '- ' : ''}${escapeHtml(item.name || '')}</td>
            <td><input type="text" class="genre-name" value="${escapeHtml(item.suggestedGenre || '')}"></td>
            <td><input type="text" class="genre-subgenre" value="${escapeHtml(item.suggestedSubgenre || '')}"></td>
            <td>${Number(item.trackCount) || 0}</td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    if (summary) summary.innerText = `${genreAssistantItems.length} ${i18n.t('library.dynamic.assistant_suggested') || 'carpeta(s) sugeridas desde la raiz musical.'}`;
}

window.openGenreAssistant = async function() {
    if (isAnalyzing) return;
    let rootPath = getPersistentRootPath();
    if (!rootPath) {
        await window.pickPersistentRootFolder();
        rootPath = getPersistentRootPath();
    }
    if (!rootPath) return;

    const modal = document.getElementById('genre-assistant-modal');
    const summary = document.getElementById('genre-assistant-summary');
    if (modal) modal.style.display = 'flex';
    if (summary) summary.innerText = i18n.t('library.dynamic.assistant_reading') || 'Leyendo carpetas de la raiz musical...';
    const result = await ipcRenderer.invoke('lib-preview-root-genres', rootPath);
    if (!result?.success) {
        if (summary) summary.innerText = result?.error || i18n.t('library.dynamic.assistant_read_error') || 'No se pudo leer la carpeta raiz.';
        renderGenreAssistant([]);
        return;
    }
    renderGenreAssistant(result.items || []);
}

window.closeGenreAssistant = function() {
    const modal = document.getElementById('genre-assistant-modal');
    if (modal) modal.style.display = 'none';
}

window.selectAllGenreAssistant = function(checked) {
    document.querySelectorAll('#genre-assistant-body .genre-use').forEach(input => { input.checked = !!checked; });
}

window.applyGenreAssistant = async function() {
    const rows = Array.from(document.querySelectorAll('#genre-assistant-body tr[data-index]'));
    const selectedItems = rows.map(row => {
        const index = Number(row.dataset.index);
        const base = genreAssistantItems[index];
        if (!base || !row.querySelector('.genre-use')?.checked) return null;
        return {
            ...base,
            genre: row.querySelector('.genre-name')?.value?.trim() || '',
            subgenre: row.querySelector('.genre-subgenre')?.value?.trim() || ''
        };
    }).filter(item => item && item.genre);

    if (selectedItems.length === 0) {
        alert(i18n.t('library.dynamic.alert_genre') || 'Selecciona al menos una carpeta con genero.');
        return;
    }

    const summary = document.getElementById('genre-assistant-summary');
    if (summary) summary.innerText = i18n.t('library.dynamic.assistant_saving') || 'Guardando generos en la base de datos...';
    const result = await ipcRenderer.invoke('lib-apply-folder-genres', {
        rootPath: getPersistentRootPath(),
        items: selectedItems,
        applyToTracks: document.getElementById('genre-apply-to-tracks')?.checked !== false
    });

    if (!result?.success) {
        if (summary) summary.innerText = result?.error || i18n.t('library.dynamic.assistant_save_error') || 'No se pudieron guardar los generos.';
        return;
    }

    await refreshWorkQueueFromDatabase();
    if (summary) summary.innerText = (i18n.t('library.dynamic.assistant_ready') || 'Listo:') + ` ${result.savedFolders || 0} ` + (i18n.t('library.dynamic.assistant_folders_tracks') || 'carpeta(s) y') + ` ${result.updatedTracks || 0} ` + (i18n.t('library.dynamic.assistant_updated') || 'pista(s) actualizadas.');
    await loadGenreProfiles();
    setTimeout(() => { window.closeGenreAssistant(); }, 900);
}

async function loadGenreProfiles() {
    try {
        genreProfiles = sortByDisplayName(await ipcRenderer.invoke('lib-get-genre-profiles') || []);
    } catch (err) {
        genreProfiles = [];
    }
    const list = document.getElementById('genre-options');
    if (list) {
        list.innerHTML = '';
        genreProfiles.forEach(genre => {
            const option = document.createElement('option');
            option.value = genre.displayName || '';
            list.appendChild(option);
        });
    }
    renderTrackGenrePicker();
}

function setTrackGenreField(fieldId, value) {
    const input = document.getElementById(fieldId);
    if (!input) return;
    input.value = value || '';
    input.focus();
}

function renderTrackGenrePicker() {
    const container = document.getElementById('track-genre-picker-list');
    if (!container) return;
    container.innerHTML = '';

    const padres = genreProfiles.filter(g => g.tipo === 'padre');
    const subgeneros = genreProfiles.filter(g => g.tipo === 'subgenero');
    const sinIdentificar = genreProfiles.filter(g => !g.tipo || g.tipo === 'sin_identificar');

    if (padres.length === 0 && subgeneros.length === 0 && sinIdentificar.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'track-genre-picker-empty';
        empty.textContent = i18n.t('library.dynamic.genre_picker_empty') || 'Todavia no hay generos guardados.';
        container.appendChild(empty);
        return;
    }

    const renderGroup = (title, items) => {
        if (items.length === 0) return;
        const head = document.createElement('div');
        head.style.padding = '8px';
        head.style.color = '#00a8ff';
        head.style.fontWeight = 'bold';
        head.style.fontSize = '12px';
        head.textContent = title;
        container.appendChild(head);

        items.forEach(genre => {
            const name = genre.displayName;
            const row = document.createElement('div');
            row.className = 'track-genre-picker-item';

            const label = document.createElement('span');
            label.textContent = name;

            const genreButton = document.createElement('button');
            genreButton.type = 'button';
            genreButton.textContent = i18n.t('library.dynamic.genre_btn') || 'A genero';
            genreButton.addEventListener('click', () => setTrackGenreField('track-genre-name', name));

            const subgenreButton = document.createElement('button');
            subgenreButton.type = 'button';
            subgenreButton.textContent = i18n.t('library.dynamic.subgenre_btn') || 'A subgenero';
            subgenreButton.addEventListener('click', () => setTrackGenreField('track-subgenre-name', name));

            row.appendChild(label);
            row.appendChild(genreButton);
            row.appendChild(subgenreButton);
            container.appendChild(row);
        });
    };

    renderGroup(i18n.t('library.dynamic.group_parent') || 'GÉNEROS PADRE (RAÍZ)', padres);
    renderGroup(i18n.t('library.dynamic.group_subgenre') || 'SUBGÉNEROS', subgeneros);
    renderGroup(i18n.t('library.dynamic.group_unknown') || 'SIN IDENTIFICAR', sinIdentificar);
}

window.closeTrackGenreModal = function() {
    pendingGenreEditPaths = [];
    const modal = document.getElementById('track-genre-modal');
    if (modal) modal.style.display = 'none';
}

function openTrackGenreModal(paths) {
    pendingGenreEditPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (pendingGenreEditPaths.length === 0) return;
    const firstTrack = workQueueTracks.find(track => track.fullPath === pendingGenreEditPaths[0]);
    const genreInput = document.getElementById('track-genre-name');
    const subgenreInput = document.getElementById('track-subgenre-name');
    const summary = document.getElementById('track-genre-summary');
    const currentGenre = firstTrack?.genre || firstTrack?.primaryGenre || '';
    const genreParts = String(currentGenre).split('/').map(part => part.trim()).filter(Boolean);
    if (genreInput) genreInput.value = genreParts[0] || '';
    if (subgenreInput) subgenreInput.value = firstTrack?.subgenre || genreParts.slice(1).join(' / ');
    if (summary) {
        summary.innerText = pendingGenreEditPaths.length === 1
            ? `${i18n.t('library.dynamic.genre_editing') || 'Editando genero de:'} ${firstTrack?.title || path.basename(pendingGenreEditPaths[0])}`
            : `${i18n.t('library.dynamic.genre_multiple_pre') || 'El genero se aplicara a'} ${pendingGenreEditPaths.length} ${i18n.t('library.dynamic.genre_multiple_post') || 'pista(s) seleccionada(s).'}`;
    }
    renderTrackGenrePicker();
    const modal = document.getElementById('track-genre-modal');
    if (modal) modal.style.display = 'flex';
    setTimeout(() => genreInput?.focus(), 50);
}

window.applyTrackGenreModal = async function() {
    if (pendingGenreEditPaths.length === 0) {
        window.closeTrackGenreModal();
        return;
    }
    const genre = document.getElementById('track-genre-name')?.value?.trim() || '';
    const subgenre = document.getElementById('track-subgenre-name')?.value?.trim() || '';
    if (!genre) {
        alert(i18n.t('library.dynamic.alert_main_genre') || 'Escribe un genero principal antes de aplicar.');
        return;
    }
    const result = await ipcRenderer.invoke('lib-set-track-genre', {
        paths: pendingGenreEditPaths,
        genre,
        subgenre
    });
    if (!result?.success) {
        alert(result?.error || i18n.t('library.dynamic.alert_save_genre_err') || 'No se pudo guardar el genero.');
        return;
    }
    await refreshWorkQueueFromDatabase();
    await loadGenreProfiles();
    window.closeTrackGenreModal();
}

async function syncWorkQueueWithDisk() {
    const currentPaths = workQueueTracks.map(track => track.fullPath).filter(Boolean);
    const scopedDb = await ipcRenderer.invoke('lib-get-db-tracks', currentPaths);
    manualCuesDB = { ...manualCuesDB, ...(scopedDb || {}) };
    const previousSelection = new Set(selectedPaths);
    workQueueTracks = workQueueTracks
        .filter(track => fs.existsSync(track.fullPath))
        .map(track => buildQueueTrack(track.fullPath, manualCuesDB[track.fullPath] || {}, track));
    selectedPaths = new Set(Array.from(previousSelection).filter(trackPath => workQueueTracks.some(track => track.fullPath === trackPath)));
    if (lastSelectedPath && !selectedPaths.has(lastSelectedPath) && !workQueueTracks.some(track => track.fullPath === lastSelectedPath)) {
        lastSelectedPath = null;
    }
    initFuseEngine();
    applyCurrentSearchAndRender();
    saveLibSession();
}

async function initializeExplorer() {
    try {
        const prefsPath = path.join(configDir, 'general_settings.json');
        let lang = 'es';
        try {
            if (fs.existsSync(prefsPath)) {
                const p = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
                lang = p.language || 'es';
            }
        } catch (e) {}
        i18n.init(lang);
        i18n.applyToDOM();

        await loadGenreProfiles();
        const paths = await ipcRenderer.invoke('get-default-paths');
        if (paths) defaultPaths = paths;
        const drives = await ipcRenderer.invoke('get-system-drives');
        if (drives && drives.length > 0) systemDrives = drives;
        loadLibraryPrefs();

        let savedPaths = [];
        try {
            if (fs.existsSync(libSessionPath)) {
                const savedSession = JSON.parse(fs.readFileSync(libSessionPath, 'utf-8'));
                if (Array.isArray(savedSession)) {
                    savedPaths = savedSession;
                    trackedLibraryRoots = [];
                } else if (savedSession && typeof savedSession === 'object') {
                    savedPaths = Array.isArray(savedSession.paths) ? savedSession.paths : [];
                    trackedLibraryRoots = mergeTrackedRoots(savedSession.roots || []);
                }
            }
        } catch(e) {}

        const persistentRoot = getPersistentRootPath();
        if (persistentRoot) {
            trackedLibraryRoots = mergeTrackedRoots(trackedLibraryRoots, [persistentRoot]);
        }

        const existingSavedPaths = savedPaths.filter(p => fs.existsSync(p));
        manualCuesDB = await ipcRenderer.invoke('lib-get-db-tracks', existingSavedPaths);

        const dbTracks = [];
        for (let p of existingSavedPaths) {
            dbTracks.push(buildQueueTrack(p, manualCuesDB[p] || {}));
        }
        
        workQueueTracks = dbTracks;
        initFuseEngine();
        applyCurrentSearchAndRender();

    } catch(e) {}

    refreshLibraryRootUi();
    buildHomeTree();
    setupDropZone();
    renderTableHeader(); 
    setupVirtualScroll();

    const persistentRoot = getPersistentRootPath();
    if (persistentRoot && libraryPrefs.autoLoadRootOnOpen && (workQueueTracks.length === 0 || libraryPrefs.rescanRootOnOpen)) {
        setTimeout(() => { processPathsMassively([persistentRoot]); }, 60);
    }
}

window.refreshHomeTree = async function() { 
    if(isAnalyzing) return;
    try {
        const drives = await ipcRenderer.invoke('get-system-drives');
        if (drives && drives.length > 0) systemDrives = drives;
    } catch(e) {}
    const persistentRoot = getPersistentRootPath();
    trackedLibraryRoots = mergeTrackedRoots(
        trackedLibraryRoots.filter(root => {
            try {
                return fs.existsSync(root) && fs.statSync(root).isDirectory();
            } catch (err) {
                return false;
            }
        }),
        persistentRoot ? [persistentRoot] : []
    );
    if (trackedLibraryRoots.length > 0) {
        await processPathsMassively(trackedLibraryRoots);
    } else {
        await syncWorkQueueWithDisk();
    }
    buildHomeTree(); 
}

function buildHomeTree() {
    const explorer = document.getElementById('lib-explorer'); 
    explorer.innerHTML = ''; 
    activeTreeNodeElements.clear();
    explorer.appendChild(createTreeNode('Escritorio', defaultPaths.desktop, true, '💻'));
    explorer.appendChild(createTreeNode('Descargas', defaultPaths.downloads, true, '📥'));
    explorer.appendChild(createTreeNode('Música', defaultPaths.music, true, '🎵'));
    const sep = document.createElement('div'); sep.style.margin = '5px 0'; sep.style.borderBottom = '1px solid #333'; explorer.appendChild(sep);
    systemDrives.forEach(drive => { explorer.appendChild(createTreeNode(`Disco Local (${drive.replace(/[\\\/]/g, '')})`, drive, true, '💽')); });
}

function createTreeNode(name, itemPath, isDirectory, iconOverride = null) {
    const wrapper = document.createElement('div'); wrapper.className = 'tree-item-wrapper';
    const node = document.createElement('div'); node.className = 'tree-node';
    node.draggable = true;

    node.dataset.path = itemPath; // Necesario para la selección con Shift
    
    node.addEventListener('dragstart', (e) => { 
        if(isAnalyzing) { e.preventDefault(); return; } 
        
        if (selectedTreeNodes.size > 1 && selectedTreeNodes.has(itemPath)) {
            e.dataTransfer.setData('application/json', JSON.stringify(Array.from(selectedTreeNodes)));
            e.dataTransfer.setData('text/plain', 'multiple_explorer_items');
        } else {
            e.dataTransfer.setData('application/json', JSON.stringify([itemPath]));
            e.dataTransfer.setData('text/plain', itemPath); 
        }
        e.dataTransfer.effectAllowed = 'copy'; 
    });
    
    const caret = document.createElement('span'); caret.className = 'tree-caret'; caret.innerText = isDirectory ? '▶' : '\u00A0'; 
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.innerText = iconOverride ? iconOverride : (isDirectory ? '📁' : '🎶');
    const text = document.createElement('span'); text.className = 'tree-text'; text.innerText = name;
    
    node.appendChild(caret); node.appendChild(icon); node.appendChild(text); wrapper.appendChild(node);
    const childrenContainer = document.createElement('div'); childrenContainer.className = 'tree-children'; wrapper.appendChild(childrenContainer);

    if (isDirectory) {
        const toggleAction = (e) => { e.stopPropagation(); toggleFolderTree(wrapper, itemPath, childrenContainer, caret); };
        caret.onclick = toggleAction; node.ondblclick = toggleAction;
    } else {
        node.ondblclick = async (e) => {
            e.stopPropagation();
            if(isAnalyzing) return;
            let pathsToProcess = Array.from(selectedTreeNodes);
            if (!pathsToProcess.includes(itemPath)) pathsToProcess = [itemPath];
            await processPathsMassively(pathsToProcess);
        };
    }

    node.onclick = (e) => { 
        e.stopPropagation(); 
        if (e.ctrlKey) {
            if (selectedTreeNodes.has(itemPath)) {
                selectedTreeNodes.delete(itemPath);
                node.classList.remove('active');
                activeTreeNodeElements.delete(node);
            } else {
                selectedTreeNodes.add(itemPath);
                node.classList.add('active');
                activeTreeNodeElements.add(node);
            }
            lastSelectedTreeNode = itemPath;
        } else if (e.shiftKey && lastSelectedTreeNode) {
            const visibleNodes = Array.from(document.querySelectorAll('.tree-node'));
            const idx1 = visibleNodes.findIndex(n => n.dataset.path === lastSelectedTreeNode);
            const idx2 = visibleNodes.indexOf(node);
            if (idx1 !== -1 && idx2 !== -1) {
                const start = Math.min(idx1, idx2);
                const end = Math.max(idx1, idx2);
                activeTreeNodeElements.forEach(n => n.classList.remove('active'));
                activeTreeNodeElements.clear();
                selectedTreeNodes.clear();
                for (let i = start; i <= end; i++) {
                    const p = visibleNodes[i].dataset.path;
                    selectedTreeNodes.add(p);
                    visibleNodes[i].classList.add('active');
                    activeTreeNodeElements.add(visibleNodes[i]);
                }
            }
        } else {
            activeTreeNodeElements.forEach(n => n.classList.remove('active'));
            activeTreeNodeElements.clear();
            selectedTreeNodes.clear();
            selectedTreeNodes.add(itemPath);
            node.classList.add('active'); 
            activeTreeNodeElements.add(node);
            lastSelectedTreeNode = itemPath;
        }
    };
    
    return wrapper;
}

async function toggleFolderTree(wrapper, dirPath, childrenContainer, caret) {
    if (wrapper.classList.contains('open')) { 
        wrapper.classList.remove('open'); caret.innerText = '▶'; 
    } else {
        wrapper.classList.add('open'); caret.innerText = '▼';
        if (childrenContainer.children.length === 0) {
            document.getElementById('loader-icon').style.display = 'inline';
            const res = await ipcRenderer.invoke('lib-read-dir', dirPath, false);
            if (res.success) {
                res.dirs.sort((a,b)=>a.localeCompare(b)).forEach(d => childrenContainer.appendChild(createTreeNode(d, require('path').join(dirPath, d), true)));
                res.files.sort((a,b)=>a.localeCompare(b)).forEach(f => childrenContainer.appendChild(createTreeNode(f, require('path').join(dirPath, f), false)));
                if (res.dirs.length===0 && res.files.length===0) { 
                    const empty = document.createElement('div'); empty.className = 'tree-empty'; empty.innerText = i18n.t('library.dynamic.tree_empty') || '(Vacía)'; childrenContainer.appendChild(empty); 
                }
            } else {
                const errDiv = document.createElement('div'); errDiv.className = 'tree-empty'; errDiv.style.color = '#e74c3c'; errDiv.innerText = '❌ ' + (i18n.t('library.dynamic.tree_denied') || 'Acceso denegado'); childrenContainer.appendChild(errDiv);
            }
            document.getElementById('loader-icon').style.display = 'none';
        }
    }
}

function setupDropZone() {
    const dropZone = document.getElementById('lib-dropzone');
    dropZone.addEventListener('dragover', (e) => { if(isAnalyzing) return; e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); });
    dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
    
    dropZone.addEventListener('drop', async (e) => {
        if(isAnalyzing) return; e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
        
        let pathsToLoad = [];
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) { 
            pathsToLoad = Array.from(e.dataTransfer.files).map(f => f.path);
        } else {
            const types = Array.from(e.dataTransfer.types || []);
            if (types.includes('application/json')) {
                try {
                    pathsToLoad = JSON.parse(e.dataTransfer.getData('application/json'));
                } catch(err){}
            } else {
                const internalPath = e.dataTransfer.getData('text/plain');
                if (internalPath && internalPath !== 'internal_row' && internalPath !== 'multiple_internal_rows') { 
                    pathsToLoad.push(internalPath);
                }
            }
        }
        
        if(pathsToLoad.length > 0) {
            await processPathsMassively(pathsToLoad);
        }
    });
}

async function processPathsMassively(pathsArray) {
    document.getElementById('import-modal').style.display = 'flex';
    document.getElementById('import-status-text').innerText = i18n.t('library.dynamic.import_scanning') || "Escaneando directorios en el disco duro...";
    document.getElementById('import-progress-fill').style.width = '0%';
    document.getElementById('import-progress-percent').innerText = '0%';
    
    let allExtractedFiles = [];
    const scannedDirectoryRoots = [];

    for(let itemPath of pathsArray) {
        let isDir = false;
        try {
            if (fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory()) {
                isDir = true;
                scannedDirectoryRoots.push(itemPath);
            }
        } catch (err) {}
        
        if (isDir) {
            const res = await ipcRenderer.invoke('lib-read-dir', itemPath, true); 
            if (res.success) {
                allExtractedFiles = allExtractedFiles.concat(res.files);
            }
        } else {
            if (/\.(mp3|wav|flac|ogg|m4a|aac|aiff|aif|mp2)$/i.test(itemPath)) {
                allExtractedFiles.push({ path: itemPath, name: require('path').basename(itemPath) });
            }
        }
    }

    if (scannedDirectoryRoots.length > 0) {
        trackedLibraryRoots = mergeTrackedRoots(trackedLibraryRoots, scannedDirectoryRoots);
    }

    const totalFiles = allExtractedFiles.length;
    if(totalFiles === 0) {
        document.getElementById('import-modal').style.display = 'none';
        saveLibSession();
        return;
    }

    document.getElementById('import-status-text').innerText = i18n.t('library.dynamic.import_reading') || "Leyendo datos guardados de estas pistas...";
    const scannedPaths = allExtractedFiles.map(file => file.path);
    const scopedDb = await ipcRenderer.invoke('lib-get-db-tracks', scannedPaths);
    manualCuesDB = { ...manualCuesDB, ...(scopedDb || {}) };

    let processed = 0;
    const trackIndexByPath = new Map(workQueueTracks.map((track, index) => [track.fullPath, index]));
    
    function processChunk() {
        const chunkEnd = Math.min(processed + 1000, totalFiles);
        for (; processed < chunkEnd; processed++) {
            const file = allExtractedFiles[processed];
            const existingIndex = trackIndexByPath.get(file.path);
            const dbData = manualCuesDB[file.path] || {};
            if (existingIndex === undefined) {
                trackIndexByPath.set(file.path, workQueueTracks.length);
                workQueueTracks.push(buildQueueTrack(file.path, dbData));
            } else {
                workQueueTracks[existingIndex] = buildQueueTrack(file.path, dbData, workQueueTracks[existingIndex]);
            }
        }
        
        let percent = Math.round((processed / totalFiles) * 100);
        document.getElementById('import-progress-fill').style.width = percent + '%';
        document.getElementById('import-progress-percent').innerText = percent + '%';
        document.getElementById('import-status-text').innerText = (i18n.t('library.dynamic.import_adding') || 'Agregando a la lista:') + ` ${processed} / ${totalFiles}`;

        if (processed < totalFiles) {
            setTimeout(processChunk, 15); 
        } else {
            if (scannedDirectoryRoots.length > 0) {
                const scannedSet = new Set(allExtractedFiles.map(file => file.path));
                const previousSelection = new Set(selectedPaths);
                workQueueTracks = workQueueTracks.filter(track => {
                    const belongsToScannedRoot = scannedDirectoryRoots.some(root => isPathInsideRoot(track.fullPath, root));
                    if (!belongsToScannedRoot) return true;
                    return scannedSet.has(track.fullPath);
                });
                const remainingPaths = new Set(workQueueTracks.map(track => track.fullPath));
                selectedPaths = new Set(Array.from(previousSelection).filter(trackPath => remainingPaths.has(trackPath)));
                if (lastSelectedPath && !selectedPaths.has(lastSelectedPath) && !remainingPaths.has(lastSelectedPath)) {
                    lastSelectedPath = null;
                }
            }
            document.getElementById('import-modal').style.display = 'none';
            initFuseEngine();
            applyCurrentSearchAndRender();
            saveLibSession();
        }
    }
    processChunk();
}

window.selectRootFolder = async function() {
    if(isAnalyzing) return;
    try {
        const persistentRoot = getPersistentRootPath();
        if (!persistentRoot) {
            window.openLibrarySettings();
            return;
        }
        trackedLibraryRoots = mergeTrackedRoots([persistentRoot]);
        workQueueTracks = []; filteredTracks = []; selectedPaths.clear();
        lastSelectedPath = null;
        await processPathsMassively([persistentRoot]);
    } catch(err) {}
}

function initFuseEngine() {
    const options = { keys: [ { name: 'title', weight: 0.38 }, { name: 'artist', weight: 0.24 }, { name: 'genre', weight: 0.16 }, { name: 'artistCountry', weight: 0.10 }, { name: 'fullPath', weight: 0.12 } ], threshold: 0.3, ignoreLocation: true, useExtendedSearch: true };
    fuseEngine = new Fuse(workQueueTracks, options);
}

function handleSortClick(colId) {
    if (currentSortCol === colId) { isSortAscending = !isSortAscending; } else { currentSortCol = colId; isSortAscending = true; }
    applySortingAndRender(); renderTableHeader(); 
}

function applySortingAndRender() {
    filteredTracks.sort((a, b) => {
        let valA = a[currentSortCol] || ''; let valB = b[currentSortCol] || '';
        const numericCols = ['inicio', 'fin', 'mix', 'db', 'year'];
        if (numericCols.includes(currentSortCol)) { valA = parseFloat(valA) || -9999; valB = parseFloat(valB) || -9999; } 
        else { if (typeof valA === 'string') valA = valA.toLowerCase(); if (typeof valB === 'string') valB = valB.toLowerCase(); }
        if (valA < valB) return isSortAscending ? -1 : 1;
        if (valA > valB) return isSortAscending ? 1 : -1;
        return 0;
    });
    renderVirtualQueue();
}

function renderTableHeader() {
    const thead = document.getElementById('lib-table-head');
    thead.innerHTML = ''; const tr = document.createElement('tr');
    columnsConfig.forEach((col, index) => {
        const th = document.createElement('th');
        const widthValue = `${col.width}px`;
        th.style.width = widthValue;
        th.style.minWidth = widthValue;
        th.style.maxWidth = widthValue;
        th.className = 'draggable-header';
        let sortIndicator = (currentSortCol === col.id) ? (isSortAscending ? '▲' : '▼') : '';
        th.innerHTML = `<div class="header-content"><span>${col.title}</span><span class="sort-icon">${sortIndicator}</span></div><div class="resizer" data-col-index="${index}"></div>`;
        th.addEventListener('click', (e) => {
            if (e.target.classList.contains('resizer') || e.target.closest('.resizer')) return;
            handleSortClick(col.id);
        });
        
        // INTERRUPTOR PARA LA COLUMNA DB
        if (col.id === 'db') {
            th.oncontextmenu = (e) => {
                e.preventDefault(); e.stopPropagation(); hideAllMenus();
                const menu = document.getElementById('db-header-menu');
                document.getElementById('ctx-db-peak').innerHTML = dbViewMode === 'peak' ? ('✓ ' + (i18n.t('library.db_menu.peak') || 'Modo DJ (Pico)')) : ('&nbsp;&nbsp;&nbsp; ' + (i18n.t('library.db_menu.peak') || 'Modo DJ (Pico)'));
                document.getElementById('ctx-db-rms').innerHTML = dbViewMode === 'rms' ? ('✓ ' + (i18n.t('library.db_menu.rms') || 'Modo Estudio (Promedio)')) : ('&nbsp;&nbsp;&nbsp; ' + (i18n.t('library.db_menu.rms') || 'Modo Estudio (Promedio)'));
                showContextMenu(menu, e.pageX, e.pageY);
            };
        }
        
        tr.appendChild(th);
    });
    thead.appendChild(tr);
    tr.querySelectorAll('.resizer').forEach((resizer) => {
        resizer.addEventListener('mousedown', (event) => {
            startLibraryColumnResize(event, Number(resizer.dataset.colIndex));
        });
    });
    syncLibraryColumnWidthsToDom();
}

function renderVirtualQueue() {
    const container = document.getElementById('lib-scroll-container');
    const table = document.getElementById('lib-tracks-table');
    const spacer = document.getElementById('virtual-spacer');
    const emptyMsg = document.getElementById('empty-queue');
    const tbody = document.getElementById('lib-table-body');
    syncLibraryTableWidths();
    
    if (filteredTracks.length === 0) {
        table.style.display = 'none'; spacer.style.height = '0px'; emptyMsg.style.display = 'flex';
        document.getElementById('lib-status-count').innerText = i18n.t('library.track_count') || 'Lista: 0 pistas'; return;
    }
    
    table.style.display = 'table'; emptyMsg.style.display = 'none';
    const totalHeight = filteredTracks.length * ROW_HEIGHT;
    spacer.style.height = `${totalHeight}px`;

    const scrollTop = container.scrollTop;
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(container.clientHeight / ROW_HEIGHT);
    const endIndex = Math.min(filteredTracks.length - 1, startIndex + visibleCount + (OVERSCAN * 2));
    const offsetY = startIndex * ROW_HEIGHT;
    table.style.transform = `translateY(${offsetY}px)`;

    tbody.innerHTML = ''; 

    const fragment = document.createDocumentFragment();
    for (let i = startIndex; i <= endIndex; i++) {
        const track = filteredTracks[i];
        const tr = document.createElement('tr');
        tr.dataset.path = track.fullPath;
        tr.dataset.index = i;
        tr.draggable = true; 
        
        if (selectedPaths.has(track.fullPath)) tr.classList.add('selected');

        tr.addEventListener('dragstart', (e) => {
            if (!selectedPaths.has(track.fullPath)) {
                selectedPaths.clear();
                selectedPaths.add(track.fullPath);
                lastSelectedPath = track.fullPath;
                applySelectionToVisibleRows();
            }
            draggedTableRow = tr; e.dataTransfer.effectAllowed = 'copyMove';
            if (selectedPaths.size > 1) {
                e.dataTransfer.setData('application/json', JSON.stringify(Array.from(selectedPaths)));
                e.dataTransfer.setData('text/plain', 'multiple_internal_rows');
            } else { e.dataTransfer.setData('text/plain', track.fullPath); }
        });

        if (track.metaError) { tr.style.color = '#e74c3c'; }

        columnsConfig.forEach(col => {
            const td = document.createElement('td');
            const widthValue = `${col.width}px`;
            td.style.width = widthValue;
            td.style.minWidth = widthValue;
            td.style.maxWidth = widthValue;
            switch(col.id) {
                case 'status':
                    if (track.status === 2) td.innerHTML = `<span class="status-badge status-changed" title="Archivo cambiado: conviene reanalizar">♻</span>`;
                    else if (track.status === 1) td.innerHTML = `<span class="status-badge status-ok">✅</span>`;
                    else td.innerHTML = `<span class="status-badge status-pending">⏳</span>`;
                    break;
                case 'fullPath': td.innerText = track.fullPath; td.title = track.fullPath; break;
                case 'title': 
                    if (track.metaError) { td.innerHTML = `<span title="${i18n.t('library.dynamic.meta_err_title') || 'Error Metadatos'}" style="cursor:help;">⚠️</span> ${track.title}`; td.style.color = "#e74c3c"; } 
                    else { td.innerText = track.title; td.style.color = "#fff"; } break;
                case 'artist': td.innerText = track.artist; break;
                case 'album': td.innerText = track.album; break;
                case 'genre': td.innerText = track.genre; break;
                case 'year': td.innerText = track.year; break;
                case 'inicio': td.innerText = track.inicio; td.style.color = track.metaError ? "" : "#aaa"; break; 
                case 'mix': td.innerText = track.mix; td.style.color = track.metaError ? "" : "#aaa"; break; 
                case 'fin': td.innerText = track.fin; td.style.color = track.metaError ? "" : "#aaa"; break; 
                case 'db': 
                    let valToShow = dbViewMode === 'peak' ? track.peak_db : track.db;
                    td.innerText = valToShow !== '' && valToShow !== null && valToShow !== undefined ? valToShow + ' dB' : ''; 
                    td.style.color = track.metaError ? "" : "#aaa"; 
                    break;
            }
            tr.appendChild(td);
        });

        tr.onclick = (e) => {
            const pathId = track.fullPath;
            if (e.shiftKey && lastSelectedPath) {
                const lastIndex = filteredTracks.findIndex(t => t.fullPath === lastSelectedPath);
                const start = Math.min(lastIndex, i); const end = Math.max(lastIndex, i);
                selectedPaths.clear();
                for(let k = start; k <= end; k++) selectedPaths.add(filteredTracks[k].fullPath);
            } else if (e.ctrlKey) {
                if (selectedPaths.has(pathId)) selectedPaths.delete(pathId); else selectedPaths.add(pathId);
                lastSelectedPath = pathId;
            } else {
                selectedPaths.clear(); selectedPaths.add(pathId);
                lastSelectedPath = pathId;
            }
            applySelectionToVisibleRows(); 
        };
        fragment.appendChild(tr);
    }
    
    tbody.appendChild(fragment);
    document.getElementById('lib-status-count').innerText = (i18n.t('library.dynamic.showing') || 'Mostrando:') + ` ${filteredTracks.length} / ${workQueueTracks.length} ` + (i18n.t('library.dynamic.tracks') || 'pistas');
}

function setupVirtualScroll() {
    const container = document.getElementById('lib-scroll-container');
    container.addEventListener('scroll', () => {
        const headerContainer = document.querySelector('.table-header-container');
        if (headerContainer) headerContainer.scrollLeft = container.scrollLeft;
        requestVirtualRender();
    });
}

window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || filteredTracks.length === 0) return;
    
    // Suprimir tracks de la lista
    if (e.key === 'Delete') {
        e.preventDefault();
        if (selectedPaths.size > 0 && !isAnalyzing) {
            workQueueTracks = workQueueTracks.filter(t => !selectedPaths.has(t.fullPath));
            selectedPaths.clear();
            lastSelectedPath = null;
            filteredTracks = [...workQueueTracks];
            initFuseEngine();
            applySortingAndRender();
            saveLibSession();
        }
        return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
        e.preventDefault(); selectedPaths.clear(); filteredTracks.forEach(t => selectedPaths.add(t.fullPath)); applySelectionToVisibleRows(); return;
    }
    const navKeys = ['ArrowUp', 'ArrowDown'];
    if (navKeys.includes(e.key)) {
        e.preventDefault();
        let currentIndex = lastSelectedPath ? filteredTracks.findIndex(t => t.fullPath === lastSelectedPath) : 0;
        if (currentIndex === -1) currentIndex = 0;

        let nextIndex = e.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
        nextIndex = Math.max(0, Math.min(filteredTracks.length - 1, nextIndex));
        const nextPath = filteredTracks[nextIndex].fullPath;

        if (e.shiftKey) selectedPaths.add(nextPath); else { selectedPaths.clear(); selectedPaths.add(nextPath); }
        lastSelectedPath = nextPath;
        
        const container = document.getElementById('lib-scroll-container');
        const targetScrollY = nextIndex * ROW_HEIGHT;
        if (targetScrollY < container.scrollTop || targetScrollY > container.scrollTop + container.clientHeight - ROW_HEIGHT) {
            container.scrollTop = targetScrollY - (container.clientHeight / 2);
            requestVirtualRender();
        } else {
            applySelectionToVisibleRows();
        }
    }
});

const libContextMenu = document.getElementById('lib-context-menu');
document.addEventListener('click', () => { if (libContextMenu) libContextMenu.style.display = 'none'; });

document.getElementById('lib-table-body').addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    e.preventDefault(); const pathId = tr.dataset.path;
    
    if (!selectedPaths.has(pathId)) {
        selectedPaths.clear(); selectedPaths.add(pathId); lastSelectedPath = pathId; applySelectionToVisibleRows();
    }
    libContextMenu.style.display = 'block';
    let x = e.pageX; let y = e.pageY;
    if (x + libContextMenu.offsetWidth > window.innerWidth) x = window.innerWidth - libContextMenu.offsetWidth;
    if (y + libContextMenu.offsetHeight > window.innerHeight) y = window.innerHeight - libContextMenu.offsetHeight;
    libContextMenu.style.left = `${x}px`; libContextMenu.style.top = `${y}px`;
});

document.getElementById('ctx-preview').addEventListener('click', () => {
    if (selectedPaths.size > 0) ipcRenderer.send('open-preview', Array.from(selectedPaths)[0]);
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-add-playlist').addEventListener('click', () => {
    if (selectedPaths.size > 0) ipcRenderer.send('lib-add-to-playlist', Array.from(selectedPaths));
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-edit-audio').addEventListener('click', () => {
    if (selectedPaths.size > 0) ipcRenderer.send('open-audio-editor', Array.from(selectedPaths)[0]);
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-edit-genre')?.addEventListener('click', () => {
    if (selectedPaths.size === 0) return;
    openTrackGenreModal(Array.from(selectedPaths));
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-sync-folder-genre')?.addEventListener('click', async () => {
    if (selectedPaths.size === 0) return;
    const ok = confirm(`Usar el nombre de la carpeta como genero/subgenero para ${selectedPaths.size} pista(s)?`);
    if (!ok) {
        libContextMenu.style.display = 'none';
        return;
    }
    const result = await ipcRenderer.invoke('lib-sync-folder-genre', Array.from(selectedPaths));
    if (!result?.success) alert(result?.error || 'No se pudo sincronizar el genero desde carpeta.');
    await refreshWorkQueueFromDatabase();
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-edit-artist-card')?.addEventListener('click', () => {
    if (selectedPaths.size === 0) return;
    const firstPath = Array.from(selectedPaths)[0];
    ipcRenderer.send('open-artist-card-editor', firstPath);
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-rebuild-artist-card')?.addEventListener('click', async () => {
    if (selectedPaths.size === 0) return;
    const result = await ipcRenderer.invoke('lib-rebuild-artist-profiles', Array.from(selectedPaths));
    if (result?.success) {
        alert(`Cedula de artista actualizada.\nPistas enlazadas: ${result.linkedTracks || 0}\nArtistas detectados: ${result.linkedArtists || 0}`);
    } else {
        alert(result?.error || 'No se pudo actualizar la cedula de artista.');
    }
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-clear-cues').addEventListener('click', async () => {
    if (selectedPaths.size > 0) {
        const pathsArr = Array.from(selectedPaths);
        const ok = confirm(`¿Eliminar Inicio/Fin/Mix de ${pathsArr.length} pista(s) en la Base de Datos?`);
        if (ok) {
            ipcRenderer.send('lib-clear-cues', pathsArr);
            pathsArr.forEach(p => {
                const track = workQueueTracks.find(t => t.fullPath === p);
                if (track) { track.inicio = ''; track.fin = ''; track.mix = ''; track.status = getTrackStatusCode(track); }
            });
            renderVirtualQueue();
        }
    }
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-clear-meta').addEventListener('click', async () => {
    if (selectedPaths.size > 0) {
        const pathsArr = Array.from(selectedPaths);
        const ok = confirm(`¿Eliminar Metadatos (título/artista/álbum/año/género) de ${pathsArr.length} pista(s) en la Base de Datos?`);
        if (ok) {
            ipcRenderer.send('lib-clear-meta', pathsArr);
            pathsArr.forEach(p => {
                const track = workQueueTracks.find(t => t.fullPath === p);
                if (track) { track.title = track.filename.replace(/\.[^/.]+$/, ""); track.artist = ''; track.album = ''; track.genre = ''; track.primaryGenre = ''; track.subgenre = ''; track.genresJson = ''; track.year = ''; }
            });
            renderVirtualQueue();
        }
    }
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-delete-db').addEventListener('click', () => {
    if (selectedPaths.size > 0) {
        const pathsArr = Array.from(selectedPaths);
        const ok = confirm(`¿Eliminar TODO de la Base de Datos para ${pathsArr.length} pista(s)?`);
        if (ok) {
            ipcRenderer.send('lib-delete-db-tracks', pathsArr);
            pathsArr.forEach(p => {
                const track = workQueueTracks.find(t => t.fullPath === p);
                if (track) {
                    track.title = track.filename.replace(/\.[^/.]+$/, ""); track.artist = ''; track.album = ''; track.genre = ''; track.primaryGenre = ''; track.subgenre = ''; track.genresJson = ''; track.year = '';
                    track.inicio = ''; track.fin = ''; track.mix = ''; track.db = ''; track.peak_db = ''; track.bpm = ''; track.fileChanged = false; track.fileSize = null; track.fileMtimeMs = null; track.status = getTrackStatusCode(track); track.metaError = false;
                }
            });
            renderVirtualQueue();
        }
    }
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-read-meta').addEventListener('click', () => {
    if (selectedPaths.size > 0) {
        startProgressUI(selectedPaths.size, "Leyendo etiquetas locales...");
        ipcRenderer.send('lib-start-meta-local-read', Array.from(selectedPaths));
    }
    libContextMenu.style.display = 'none';
});

document.getElementById('ctx-embed-meta').addEventListener('click', () => {
    if (selectedPaths.size > 0) {
        startProgressUI(selectedPaths.size, "Incrustando etiquetas en MP3...");
        ipcRenderer.send('lib-start-meta-local-write', Array.from(selectedPaths));
    }
    libContextMenu.style.display = 'none';
});

window.switchModalTab = function(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`tab-btn-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
}

window.toggleDbSettings = function() { document.getElementById('panel-custom-db').style.display = document.getElementById('chk-custom-db').checked ? 'block' : 'none'; }
window.updateMasterCheck = function() {
    const c1 = document.getElementById('chk-task-cues').checked; const c2 = document.getElementById('chk-task-gain').checked; const c3 = document.getElementById('chk-task-bpm').checked;
    document.getElementById('chk-master-all').checked = (c1 && c2 && c3);
}
window.toggleMasterCheck = function() {
    const m = document.getElementById('chk-master-all').checked;
    document.getElementById('chk-task-cues').checked = m; document.getElementById('chk-task-gain').checked = m; document.getElementById('chk-task-bpm').checked = m;
}

window.openAnalysisModal = function() {
    if (workQueueTracks.length === 0 && !isAnalyzing) { alert("La lista de trabajo está vacía."); return; }
    document.getElementById('analysis-modal').style.display = 'flex';
}
window.closeAnalysisModal = function() { document.getElementById('analysis-modal').style.display = 'none'; }
window.hideAnalysisModal = function() { document.getElementById('analysis-modal').style.display = 'none'; }

// FUNCION DEL MENÚ DB
window.setDbViewMode = function(mode) {
    dbViewMode = mode;
    localStorage.setItem('lib_db_view_mode', mode);
    document.getElementById('db-header-menu').style.display = 'none';
    renderVirtualQueue();
}

function startProgressUI(totalTasks, message) {
    isAnalyzing = true; cancelRequested = false; totalBatchTasks = totalTasks; completedBatchTasks = 0;
    
    document.querySelectorAll('.config-input').forEach(el => el.disabled = true);
    document.getElementById('btn-modal-start').style.display = 'none';
    document.getElementById('btn-modal-cancel').style.display = 'none';
    document.getElementById('btn-modal-stop').style.display = 'block'; document.getElementById('btn-modal-stop').disabled = false;
    document.getElementById('btn-modal-hide').style.display = 'block'; 
    document.getElementById('modal-progress-section').style.display = 'flex';
    document.getElementById('modal-stop-warning').style.display = 'none';
    
    document.getElementById('btn-analyze-main').classList.add('working');
    document.getElementById('btn-analyze-text').innerText = (i18n.t('library.processing') || "Procesando...") + " 0%"; 
    document.getElementById('btn-analyze-fill').style.width = "0%";
    
    document.getElementById('lib-processing-status').style.display = 'inline';
    document.getElementById('lib-processing-status').innerText = `${message} (0/${totalBatchTasks})...`;
}

window.executeBatchAnalysis = function() {
    let tasks = [];
    if (currentTab === 'audio') {
        const useCustomDb = document.getElementById('chk-custom-db') ? document.getElementById('chk-custom-db').checked : false;
        const analyzerProvider = document.querySelector('input[name="analysis_engine"]:checked')?.value || 'rustAudio';
        const analyzerLabel = analyzerProvider === 'ffmpeg' ? 'FFmpeg' : 'Rust';
        
        // RECUPERAMOS LOS 3 VALORES INDIVIDUALMENTE DESDE LA UI
        const dbMixVal = parseFloat(document.getElementById('val-db-mix')?.value) || -14;
        const dbStartVal = parseFloat(document.getElementById('val-db-start')?.value) || -36;
        const dbFinVal = parseFloat(document.getElementById('val-db-fin')?.value) || -48;
        
        const taskDbMix = useCustomDb ? dbMixVal : -14;
        const taskDbStart = useCustomDb ? dbStartVal : -36;
        const taskDbFin = useCustomDb ? dbFinVal : -48;
        
        let modeForce = document.getElementById('scope-force') ? document.getElementById('scope-force').checked : false;
        if (modeForce) {
            tasks = workQueueTracks.map(t => ({
                filePath: t.fullPath,
                dbMix: taskDbMix,
                dbStart: taskDbStart,
                dbFin: taskDbFin,
                analyzerProvider,
                forceOverwrite: true
            }));
        } else {
            const doGain = document.getElementById('chk-task-gain') ? document.getElementById('chk-task-gain').checked : false;
            const doCues = document.getElementById('chk-task-cues') ? document.getElementById('chk-task-cues').checked : false;
            tasks = workQueueTracks.filter(t => {
                let needsUpdate = false;
                if (doGain && (t.db === '' || t.db === null || t.db === undefined)) needsUpdate = true;
                if (doCues && (t.inicio === '' || t.inicio === null || t.mix === '' || t.mix === null || t.fin === '' || t.fin === null)) needsUpdate = true;
                return needsUpdate;
            }).map(t => ({
                filePath: t.fullPath,
                dbMix: taskDbMix,
                dbStart: taskDbStart,
                dbFin: taskDbFin,
                analyzerProvider,
                forceOverwrite: false
            }));
        }
        if (tasks.length === 0) { alert("Todas las pistas ya tienen los datos solicitados. Nada que procesar."); return; }
        startProgressUI(tasks.length, `Analizando con ${analyzerLabel}`);
        ipcRenderer.send('lib-start-analyzer-ffmpeg', tasks);

    } else if (currentTab === 'meta') {
        const sourceInternet = document.getElementById('meta-source-internet') ? document.getElementById('meta-source-internet').checked : true;
        let modeForceMeta = document.getElementById('scope-meta-force') ? document.getElementById('scope-meta-force').checked : false;
        if (modeForceMeta) {
            tasks = workQueueTracks.map(t => ({ filePath: t.fullPath, forceOverwrite: true }));
        } else {
            tasks = workQueueTracks.filter(t => {
                return (t.title === '' || t.artist === '' || t.year === '' || t.album === '' || t.genre === '');
            }).map(t => ({ filePath: t.fullPath, forceOverwrite: false }));
        }
        if (tasks.length === 0) { alert("Todas las pistas ya tienen los metadatos solicitados. Nada que procesar."); return; }
        if (sourceInternet) {
            startProgressUI(tasks.length, "Buscando en Internet");
            ipcRenderer.send('lib-start-meta-internet', tasks);
        } else {
            startProgressUI(tasks.length, "Leyendo etiquetas locales");
            ipcRenderer.send('lib-start-meta-local-read', tasks);
        }
    }
}

let lastRenderTime = 0;

function handleTaskDone(result, processName) {
    completedBatchTasks++;
    let percent = totalBatchTasks > 0 ? Math.round((completedBatchTasks / totalBatchTasks) * 100) : 0;
    let filenameDisplay = result.filePath ? result.filePath.split('\\').pop() : 'Desconocido';
    
    document.getElementById('modal-progress-file').innerText = `(${completedBatchTasks}/${totalBatchTasks}) ${filenameDisplay}`;
    document.getElementById('modal-progress-percent').innerText = `${percent}%`; 
    document.getElementById('modal-progress-fill').style.width = `${percent}%`;
    document.getElementById('btn-analyze-text').innerText = (i18n.t('library.processing') || 'Procesando...') + ` ${percent}%`; 
    document.getElementById('btn-analyze-fill').style.width = `${percent}%`;
    document.getElementById('lib-processing-status').innerText = `${processName}... (${completedBatchTasks}/${totalBatchTasks})`;

    const track = workQueueTracks.find(t => t.fullPath === result.filePath);
    if (track && result.success && result.data) {
        if(result.data.db !== undefined) track.db = result.data.db; 
        if(result.data.peak_db !== undefined) track.peak_db = result.data.peak_db; 
        if(result.data.inicio !== undefined) track.inicio = result.data.inicio; 
        if(result.data.mix !== undefined) track.mix = result.data.mix; 
        if(result.data.fin !== undefined) track.fin = result.data.fin; 
        if(result.data.customTitle !== undefined) track.title = result.data.customTitle;
        if(result.data.custom_title !== undefined) track.title = result.data.custom_title;
        if(result.data.customArtist !== undefined) track.artist = result.data.customArtist;
        if(result.data.custom_artist !== undefined) track.artist = result.data.custom_artist;
        if(result.data.album !== undefined) track.album = result.data.album;
        if(result.data.year !== undefined) track.year = result.data.year;
        if(result.data.genre !== undefined) track.genre = result.data.genre;
        if(result.data.fileChanged !== undefined) track.fileChanged = result.data.fileChanged === true;
        if(result.data.fileSize !== undefined) track.fileSize = result.data.fileSize;
        if(result.data.fileMtimeMs !== undefined) track.fileMtimeMs = result.data.fileMtimeMs;
        
        track.status = getTrackStatusCode(track);
        
        const now = Date.now();
        if (now - lastRenderTime > 500 || completedBatchTasks >= totalBatchTasks) {
            renderVirtualQueue();
            lastRenderTime = now;
        }
    }

    if (completedBatchTasks >= totalBatchTasks || cancelRequested) { finishAnalysisUI(cancelRequested); }
}

ipcRenderer.on('analyzer-done', (e, r) => {
    const analyzer = String(r?.analyzer || '').toLowerCase();
    const label = analyzer.includes('rust') ? 'Analizando con Rust' : (analyzer.includes('fallback') ? 'Analizando con FFmpeg (respaldo)' : 'Analizando con FFmpeg');
    handleTaskDone(r, label);
});
ipcRenderer.on('meta-local-read-done', (e, r) => handleTaskDone(r, "Leyendo etiquetas locales"));
ipcRenderer.on('meta-local-write-done', (e, r) => handleTaskDone(r, "Escribiendo en disco"));
ipcRenderer.on('meta-net-done', (e, r) => handleTaskDone(r, "Buscando en Internet"));

window.stopBatchAnalysis = function() {
    cancelRequested = true;
    ipcRenderer.send('lib-start-analyzer-ffmpeg', []);
    ipcRenderer.send('lib-start-meta-local-read', []);
    ipcRenderer.send('lib-start-meta-local-write', []);
    ipcRenderer.send('lib-start-meta-internet', []);

    document.getElementById('modal-stop-warning').style.display = 'block';
    document.getElementById('modal-stop-warning').innerText = i18n.t('library.dynamic.cancel_process') || "Cancelando proceso...";
    document.getElementById('btn-modal-stop').disabled = true;
    document.getElementById('lib-processing-status').innerText = i18n.t('library.dynamic.stopping') || "Deteniendo...";
    
    setTimeout(() => { if(isAnalyzing) finishAnalysisUI(true); }, 1500);
}

function finishAnalysisUI(wasCancelled) {
    isAnalyzing = false; totalBatchTasks = 0; completedBatchTasks = 0;
    document.getElementById('lib-processing-status').innerText = wasCancelled ? (i18n.t('library.dynamic.process_canceled') || "Proceso Cancelado") : (i18n.t('library.dynamic.process_completed') || "¡Proceso Completado!");
    setTimeout(() => { document.getElementById('lib-processing-status').style.display = 'none'; }, 3000);
    
    document.getElementById('modal-progress-fill').style.width = "100%"; 
    document.querySelectorAll('.config-input').forEach(el => el.disabled = false);
    document.getElementById('btn-modal-stop').style.display = 'none'; document.getElementById('btn-modal-hide').style.display = 'none'; 
    document.getElementById('btn-modal-start').style.display = 'block'; document.getElementById('btn-modal-cancel').style.display = 'block';
    document.getElementById('modal-progress-file').innerText = wasCancelled ? (i18n.t('library.dynamic.canceled_by_user') || "Cancelado por el usuario.") : (i18n.t('library.dynamic.process_success') || "¡Proceso completado con éxito!");
    
    document.getElementById('btn-analyze-main').classList.remove('working');
    document.getElementById('btn-analyze-text').innerText = i18n.t('library.analyze_btn_text') || "▶ Centro de Procesamiento"; document.getElementById('btn-analyze-fill').style.width = "0%";
    
    renderVirtualQueue();
}

document.getElementById('lib-search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        const query = e.target.value.trim();
        if (!query) { filteredTracks = [...workQueueTracks]; applySortingAndRender(); return; }
        if (fuseEngine) { const results = fuseEngine.search(query); filteredTracks = results.map(r => r.item); applySortingAndRender(); }
    }, 300);
});

window.saveLibraryList = async function() {
    if (workQueueTracks.length === 0) return true; 
    const filePath = await ipcRenderer.invoke('dialog:saveLibraryList');
    if (filePath) { ipcRenderer.send('save-file-sync', filePath, JSON.stringify(workQueueTracks, null, 2)); return true; }
    return false; 
}
window.openLibraryList = async function() { if(!isAnalyzing) await ipcRenderer.invoke('dialog:openLibraryList'); }
window.clearWorkQueue = async function() {
    if(isAnalyzing) return; if (workQueueTracks.length === 0) return;
    const response = await ipcRenderer.invoke('dialog:askClearLibrary');
    if (response === 2) return; 
    trackedLibraryRoots = [];
    workQueueTracks = []; filteredTracks = []; selectedPaths.clear(); 
    document.getElementById('lib-search-input').value = ''; 
    renderVirtualQueue();
    saveLibSession();
}

ipcRenderer.on('refresh-manual-cues', async () => {
    const paths = workQueueTracks.map(track => track.fullPath).filter(Boolean);
    const scopedDb = await ipcRenderer.invoke('lib-get-db-tracks', paths);
    manualCuesDB = { ...manualCuesDB, ...(scopedDb || {}) };
    workQueueTracks = workQueueTracks.map(track => buildQueueTrack(track.fullPath, manualCuesDB[track.fullPath] || {}, track));
    initFuseEngine();
    applyCurrentSearchAndRender();
});

ipcRenderer.on('settings-updated', (e, payload) => {
    try {
        const prefsPath = path.join(configDir, 'general_settings.json');
        let lang = 'es';
        if (fs.existsSync(prefsPath)) {
            const p = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
            lang = p.language || 'es';
        }
        i18n.init(lang);
        i18n.applyToDOM();
        loadLibraryPrefs(); // Reload columns with new translations
        renderVirtualQueue();
        refreshLibraryRootUi();
    } catch(err) {
        console.error("Error applying language from settings-updated:", err);
    }
});

initializeExplorer();
