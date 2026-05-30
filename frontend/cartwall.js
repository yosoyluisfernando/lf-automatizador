const { ipcRenderer, webUtils } = require('electron');
const path = require('path');
const { buildComboString } = require('./shortcut_manager');

let cartwallState = null;
let cwActiveTabIndex = 0;
let cwPlayingTabs = new Set();
let cwPlayingButtons = new Set();
let botonSeleccionado = null; 
let tabSeleccionadaIndex = null; 
let modoTab = 'nuevo'; 
let cwSavingProfile = false;
let cwSavingTab = false;
let applyingCartwallUiState = false;

const cwGrid = document.getElementById('cw-grid');
const cwTabsContainer = document.getElementById('cw-tabs');

const cwContextMenu = document.getElementById('cw-context-menu');
const cwTabContextMenu = document.getElementById('cw-tab-context-menu');
const cwProfileMenu = document.getElementById('cw-profile-menu');
const cwProfileButton = document.getElementById('cw-profile-button');
const cwEditModal = document.getElementById('cw-edit-modal');
const cwTabModal = document.getElementById('cw-tab-modal');
const cwProfileModal = document.getElementById('cw-profile-modal');
let modoProfile = 'nuevo';

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

if (cwProfileButton) {
    cwProfileButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAllFloatingMenus();
        buildCwProfileMenu();
        const rect = cwProfileButton.getBoundingClientRect();
        positionFloatingMenu(cwProfileMenu, rect.left, rect.bottom + 4);
    });
}

document.getElementById('btn-dock-cartwall')?.addEventListener('click', () => {
    setCartwallUiState({ mode: 'docked' });
    ipcRenderer.send('cartwall-dock');
});

function extractFirstDroppedPath(e) {
    try {
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            const p = webUtils?.getPathForFile ? webUtils.getPathForFile(e.dataTransfer.files[0]) : e.dataTransfer.files[0].path;
            return p || null;
        }
        if (e.dataTransfer?.types?.includes('application/json')) {
            const raw = e.dataTransfer.getData('application/json');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) return arr[0];
        }
        const txt = e.dataTransfer?.getData('text/plain');
        if (txt && txt !== 'internal_row' && txt !== 'multiple_internal_rows') return txt;
    } catch (err) {}
    return null;
}

function isValidAudioPath(p) { return !!p && /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(p); }
function getRandomDarkEffectColor() {
    const palette = ['#164e3a', '#1f4b5f', '#47346b', '#61395a', '#653b2f', '#36502a', '#214a70', '#5a4630', '#285057', '#4d375f'];
    return palette[Math.floor(Math.random() * palette.length)];
}

function createEmptyCwButtons(total) {
    const botones = [];
    for (let i = 1; i <= total; i++) {
        botones.push({ id: i, label: i.toString(), file: '', type: 'audio', folder: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false, restart: false, shortcut: '' });
    }
    return botones;
}

function createCwPalette(index, rows = 5, cols = 5) {
    return { nombre: `Botonera ${index}`, rows, cols, audioOut: 'global', shortcut: '', tabBg: '#3a3f44', tabText: '#cccccc', botones: createEmptyCwButtons(rows * cols) };
}

function getActiveCwProfile() {
    if (!cartwallState?.profiles?.length) return null;
    return cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId) || cartwallState.profiles[0];
}

function updateCwProfileButton() {
    if (!cwProfileButton) return;
    const profile = getActiveCwProfile();
    cwProfileButton.innerText = `👤 ${profile?.name || 'Principal'}`;
}

function applyCartwallUiState(uiState, { render = true } = {}) {
    if (!uiState || !cartwallState?.profiles?.length) return;
    applyingCartwallUiState = true;
    try {
        const profile = cartwallState.profiles.find(p => p.id === uiState.activeProfileId) || cartwallState.profiles[0];
        cartwallState.activeProfileId = profile.id;
        const tabCount = Math.max(1, profile.paletas?.length || 1);
        cwActiveTabIndex = Math.max(0, Math.min(tabCount - 1, Number(uiState.activeTabIndex) || 0));
        if (render) {
            updateCwProfileButton();
            renderCartwallTabs();
            renderCartwallGrid();
        }
    } finally {
        applyingCartwallUiState = false;
    }
}

function setCartwallUiState(partial) {
    if (applyingCartwallUiState) return;
    ipcRenderer.send('set-cartwall-ui-state', {
        activeProfileId: cartwallState?.activeProfileId,
        activeTabIndex: cwActiveTabIndex,
        mode: 'floating',
        ...partial
    });
}

async function assignPathToButton(btnInfo, filePath) {
    if (!btnInfo || !isValidAudioPath(filePath)) return false;
    let nombre = path.basename(filePath);
    nombre = nombre.substring(0, nombre.lastIndexOf('.')) || nombre;
    btnInfo.file = filePath;
    btnInfo.type = 'audio';
    btnInfo.folder = '';
    btnInfo.name = (nombre || '').toUpperCase();
    btnInfo.bg = getRandomDarkEffectColor();
    btnInfo.text = '#FFFFFF';
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallGrid();
    return true;
}

function normalizeCwButtonShape(btn) {
    if (!btn) return;
    btn.type = ['audio', 'time', 'temperature', 'humidity'].includes(btn.type) ? btn.type : 'audio';
    btn.folder = btn.folder || '';
}

function isCartwallTimeButton(btnInfo) {
    return btnInfo?.type === 'time';
}

function isCartwallClimateButton(btnInfo) {
    return btnInfo?.type === 'temperature' || btnInfo?.type === 'humidity';
}

function getClimateLocutionLabel(kind) {
    return kind === 'humidity' ? 'Humedad' : 'Temperatura';
}

function resetCartwallButtonModeOptions(btnInfo) {
    if (!isCartwallTimeButton(btnInfo) && !isCartwallClimateButton(btnInfo)) return;
    btnInfo.loop = false;
    btnInfo.stopOther = false;
    btnInfo.overlap = false;
    btnInfo.restart = false;
}

ipcRenderer.on('sync-cartwall-state', async () => {
    await loadState();
});

ipcRenderer.on('cartwall-ui-state', async (e, uiState) => {
    if (!cartwallState) await loadState();
    applyCartwallUiState(uiState, { render: true });
});

ipcRenderer.on('cartwall-play-state', (e, payload) => {
    const id = payload?.id;
    const tabIndex = Number.isInteger(payload?.tabIndex) ? payload.tabIndex : cwActiveTabIndex;
    if (!id) return;
    const runtimeKey = `${tabIndex}:${id}`;
    if (payload.state === 'playing') {
        cwPlayingTabs.add(tabIndex);
        cwPlayingButtons.add(runtimeKey);
    }
    if (payload.state === 'stopped') {
        cwPlayingButtons.delete(runtimeKey);
        if (!payload.tabPlaying) cwPlayingTabs.delete(tabIndex);
    }
    renderCartwallTabs();
    if (tabIndex !== cwActiveTabIndex) return;
    const btn = document.getElementById(`cw-btn-${id}`);
    if (!btn) return;
    const isPlaying = payload.state === 'playing';
    btn.classList.toggle('cw-playing', isPlaying);
    if (!isPlaying) {
        const pb = document.getElementById(`cw-progress-${id}`);
        const tt = document.getElementById(`cw-timer-${id}`);
        if (pb) pb.style.width = '0%';
        if (tt) {
            const paleta = getActiveCwPalette();
            const info = paleta ? paleta.botones.find(b => b.id == id) : null;
            tt.innerText = getCartwallButtonReadyText(info);
        }
    }
});

ipcRenderer.on('cartwall-progress', (e, payload) => {
    const id = payload?.id;
    const tabIndex = Number.isInteger(payload?.tabIndex) ? payload.tabIndex : cwActiveTabIndex;
    const duration = Number(payload?.duration) || 0;
    const currentTime = Number(payload?.currentTime) || 0;
    if (!id || duration <= 0 || tabIndex !== cwActiveTabIndex) return;
    const pb = document.getElementById(`cw-progress-${id}`);
    const tt = document.getElementById(`cw-timer-${id}`);
    if (pb) pb.style.width = `${Math.min(100, (currentTime / duration) * 100)}%`;
    if (tt) tt.innerText = `${formatCwTime(currentTime)} / ${formatCwTime(duration)}`;
});


function createCwProfile(name) {
    return { id: `profile_${Date.now()}_${Math.random().toString(16).slice(2)}`, name: name || 'Nuevo Perfil', bg: '#008c3a', text: '#ffffff', config: { outMain: 'default', outPre: 'default', keys: { stopAll: '', next: '', prev: '' } }, paletas: [createCwPalette(1)] };
}

async function saveCartwallStateAndRefresh() {
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallTabs();
    renderCartwallGrid();
    updateCwProfileButton();
}

function stopAllCartwallAudio() {
    cwPlayingTabs.clear();
    cwPlayingButtons.clear();
    ipcRenderer.send('remote-cw-stopall');
}

function openCwProfileModal(mode) {
    const profile = getActiveCwProfile();
    modoProfile = mode;
    document.getElementById('cw-profile-modal-title').innerText = mode === 'editar' ? 'Editar Perfil' : 'Nuevo Perfil';
    document.getElementById('cw-profile-name').value = mode === 'editar' ? (profile?.name || 'Perfil') : `Perfil ${cartwallState.profiles.length + 1}`;
    document.getElementById('cw-profile-text-color').value = mode === 'editar' ? (profile?.text || '#ffffff') : '#ffffff';
    hideAllFloatingMenus();
    cwProfileModal.style.display = 'flex';
    cwProfileModal.tabIndex = -1;
    setTimeout(() => {
        cwProfileModal.focus();
        document.getElementById('cw-profile-name')?.select();
    }, 0);
}

async function saveCwProfileModal() {
    if (cwSavingProfile) return;
    cwSavingProfile = true;
    try {
        const name = document.getElementById('cw-profile-name').value.trim() || 'Perfil';
        const text = document.getElementById('cw-profile-text-color').value || '#ffffff';
        closeCwProfileModal();
        if (modoProfile === 'nuevo') {
            stopAllCartwallAudio();
            const profile = createCwProfile(name);
            profile.text = text;
            cartwallState.profiles.push(profile);
            cartwallState.activeProfileId = profile.id;
            cwActiveTabIndex = 0;
        } else {
            const profile = getActiveCwProfile();
            if (profile) {
                profile.name = name;
                profile.text = text;
            }
        }
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
    } finally {
        cwSavingProfile = false;
    }
}

async function switchCwProfile(profileId) {
    if (profileId === cartwallState.activeProfileId) return;
    stopAllCartwallAudio();
    cartwallState.activeProfileId = profileId;
    cwActiveTabIndex = 0;
    await saveCartwallStateAndRefresh();
    setCartwallUiState({ activeProfileId: profileId, activeTabIndex: 0 });
}

function buildCwProfileMenu() {
    if (!cwProfileMenu || !cartwallState) return;
    const active = getActiveCwProfile();
    cwProfileMenu.innerHTML = '';
    const addItem = (label, onClick, className = '') => {
        const item = document.createElement('div');
        item.className = `context-item ${className}`;
        item.innerText = label;
        item.onclick = async () => { hideAllFloatingMenus(); await onClick(); };
        cwProfileMenu.appendChild(item);
        return item;
    };
    const sep = () => { const el = document.createElement('div'); el.className = 'context-separator'; cwProfileMenu.appendChild(el); };
    addItem(`👤 ${active?.name || 'Principal'}`, async () => {}, 'cw-profile-current');
    sep();
    addItem('Nuevo Perfil...', async () => openCwProfileModal('nuevo'));
    addItem('Editar Perfil actual...', async () => openCwProfileModal('editar'));
    sep();
    addItem('Importar Perfil (.bdeplf)', async () => {
        const imported = await ipcRenderer.invoke('importar-bdeplf');
        if (!imported) return;
        imported.id = `profile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        imported.name = imported.name || 'Perfil importado';
        if (!Array.isArray(imported.paletas) || imported.paletas.length === 0) imported.paletas = [createCwPalette(1)];
        cartwallState.profiles.push(imported);
        cartwallState.activeProfileId = imported.id;
        cwActiveTabIndex = 0;
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: imported.id, activeTabIndex: 0 });
    });
    addItem('Exportar Perfil (.bdeplf)', async () => { await ipcRenderer.invoke('exportar-bdeplf', getActiveCwProfile()); });
    sep();
    addItem('Eliminar Perfil actual', async () => {
        if (cartwallState.profiles.length <= 1) { alert('No puedes eliminar el unico perfil.'); return; }
        const profile = getActiveCwProfile();
        const ok = await ipcRenderer.invoke('dialog:confirm', `¿Seguro que deseas eliminar el perfil "${profile.name}"?`);
        if (!ok) return;
        stopAllCartwallAudio();
        cartwallState.profiles = cartwallState.profiles.filter(p => p.id !== profile.id);
        cartwallState.activeProfileId = cartwallState.profiles[0].id;
        cwActiveTabIndex = 0;
        await saveCartwallStateAndRefresh();
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: 0 });
    }, 'danger');
    sep();
    cartwallState.profiles.forEach(profile => {
        const item = addItem(profile.name || 'Perfil', async () => switchCwProfile(profile.id), profile.id === cartwallState.activeProfileId ? 'cw-profile-current' : '');
        if (profile.text) item.style.color = profile.text;
    });
}
async function loadState() {
    cartwallState = await ipcRenderer.invoke('get-cartwall-profiles');
    if (!cartwallState) return;
    const uiState = await ipcRenderer.invoke('get-cartwall-ui-state');
    applyCartwallUiState(uiState, { render: false });
    updateCwProfileButton();
    renderCartwallTabs();
    renderCartwallGrid();
    setCartwallUiState({ mode: 'floating' });
}

function getActiveCwPalette() {
    const profile = getActiveCwProfile();
    if (!profile || profile.paletas.length === 0) return null;
    if (cwActiveTabIndex >= profile.paletas.length) cwActiveTabIndex = 0;
    return profile.paletas[cwActiveTabIndex];
}

function hideAllFloatingMenus() {
    cwContextMenu.style.display = 'none';
    cwTabContextMenu.style.display = 'none';
    if (cwProfileMenu) cwProfileMenu.style.display = 'none';
}

function positionFloatingMenu(menuElement, x, y) {
    if (!menuElement) return;
    menuElement.style.display = 'block';
    menuElement.style.width = 'max-content';
    const menuWidth = menuElement.offsetWidth;
    const menuHeight = menuElement.offsetHeight;
    const margin = 6;
    const nextX = Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin));
    const nextY = Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin));
    menuElement.style.left = `${nextX}px`;
    menuElement.style.top = `${nextY}px`;
}

function renderCartwallTabs() {
    cwTabsContainer.innerHTML = '';
    updateCwProfileButton();
    const profile = getActiveCwProfile();
    if (!profile) return;
    profile.paletas.forEach((paleta, index) => {
        let tab = document.createElement('div');
        tab.className = `cw-tab ${index === cwActiveTabIndex ? 'active' : ''} ${cwPlayingTabs.has(index) && index !== cwActiveTabIndex ? 'cw-tab-playing' : ''}`;
        tab.innerText = paleta.nombre;
        
        tab.onclick = (e) => { 
            cwActiveTabIndex = index; 
            renderCartwallTabs(); 
            renderCartwallGrid(); 
            setCartwallUiState({ activeTabIndex: index });
        };
        
        tab.oncontextmenu = (e) => {
            e.preventDefault(); 
            tabSeleccionadaIndex = index;
            hideAllFloatingMenus();
            positionFloatingMenu(cwTabContextMenu, e.clientX, e.clientY);
        };
        
        cwTabsContainer.appendChild(tab);
    });
    const addTab = document.createElement('div');
    addTab.className = 'cw-tab cw-tab-add';
    addTab.innerText = '+';
    addTab.title = 'Agregar botonera';
    addTab.onclick = addCartwallTab;
    cwTabsContainer.appendChild(addTab);
}

function closeCwTabModal() {
    cwTabModal.style.display = 'none';
}

function closeCwEditModal() {
    cwEditModal.style.display = 'none';
}

function closeCwProfileModal() {
    cwProfileModal.style.display = 'none';
}

function handleCartwallModalKeydown(event, acceptFn, cancelFn) {
    if (event.key === 'Escape') {
        event.preventDefault();
        cancelFn();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        acceptFn();
    }
}

function getCartwallButtonReadyText(btnInfo) {
    return isCartwallButtonPlayable(btnInfo) ? 'LISTO' : '';
}

function refreshCartwallModeMenu(btnInfo) {
    const disabled = isCartwallTimeButton(btnInfo) || isCartwallClimateButton(btnInfo);
    ['menu-bucle', 'menu-overlap', 'menu-restart', 'menu-detener'].forEach(id => {
        const item = document.getElementById(id);
        if (item) item.classList.toggle('context-disabled', disabled);
    });
}

function isCartwallButtonPlayable(btnInfo) {
    if (!btnInfo) return false;
    if (btnInfo.file) return true;
    if (isCartwallTimeButton(btnInfo)) return !!btnInfo.folder;
    if (isCartwallClimateButton(btnInfo)) return true;
    return false;
}

function hasConfiguredCartwallEffects(paleta) {
    return !!paleta && Array.isArray(paleta.botones) && paleta.botones.some(isCartwallButtonPlayable);
}

async function confirmDeleteCartwallTab(paleta) {
    if (!hasConfiguredCartwallEffects(paleta)) return true;
    return await ipcRenderer.invoke('dialog:confirm', `La botonera "${paleta.nombre}" tiene efectos cargados. ¿Seguro que deseas eliminarla?`);
}

function forgetFloatingPlayingTab(tabIndex) {
    cwPlayingTabs.delete(tabIndex);
    cwPlayingButtons = new Set(Array.from(cwPlayingButtons).filter(key => !key.startsWith(`${tabIndex}:`)));
}

function createEmptyCwButtonForSlot(id) {
    return { id, label: String(id), file: '', type: 'audio', folder: '', name: '', bg: '', text: '#FFFFFF', vol: 1, loop: false, stopOther: false, overlap: false, restart: false, shortcut: '' };
}

async function moveCartwallButton(fromTabIndex, fromId, toTabIndex, toId) {
    const profile = getActiveCwProfile();
    const fromPalette = profile?.paletas?.[fromTabIndex];
    const toPalette = profile?.paletas?.[toTabIndex];
    if (!fromPalette || !toPalette || (fromTabIndex === toTabIndex && fromId === toId)) return false;
    const source = fromPalette.botones.find(btn => btn.id === fromId);
    const target = toPalette.botones.find(btn => btn.id === toId);
    if (!source || !target || !isCartwallButtonPlayable(source)) return false;
    const moved = { ...source, id: target.id, label: target.label || String(target.id) };
    Object.assign(target, moved);
    Object.assign(source, createEmptyCwButtonForSlot(source.id));
    ipcRenderer.send('remote-cw-move-button', { fromTabIndex, fromId, toTabIndex, toId });
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState);
    renderCartwallGrid();
    return true;
}

async function addCartwallTab() {
    const profile = getActiveCwProfile();
    if (!profile) return;
    modoTab = 'nuevo';
    tabSeleccionadaIndex = null;
    document.getElementById('cw-tab-modal-title').innerText = 'Nueva Botonera';
    document.getElementById('cw-tab-name').value = `Botonera ${profile.paletas.length + 1}`;
    document.getElementById('cw-tab-v').value = 5;
    document.getElementById('cw-tab-h').value = 5;
    document.getElementById('cw-tab-bg-color').value = '#3a3f44';
    document.getElementById('cw-tab-text-color').value = '#cccccc';
    hideAllFloatingMenus();
    cwTabModal.style.display = 'flex';
    cwTabModal.tabIndex = -1;
    setTimeout(() => cwTabModal.focus(), 0);
}

function renderCartwallGrid() {
    cwGrid.innerHTML = '';
    const paleta = getActiveCwPalette();
    if (!paleta) return;

    cwGrid.style.gridTemplateColumns = `repeat(${paleta.cols}, minmax(0, 1fr))`;
    cwGrid.style.gridTemplateRows = `repeat(${paleta.rows}, minmax(0, 1fr))`;

    paleta.botones.forEach(btnInfo => {
        Object.defineProperty(btnInfo, '_cwTabIndex', { value: cwActiveTabIndex, configurable: true, writable: true });
        normalizeCwButtonShape(btnInfo);
        resetCartwallButtonModeOptions(btnInfo);
        let btn = document.createElement('div');
        btn.className = 'cw-grid-item';
        btn.id = `cw-btn-${btnInfo.id}`;
        
        if (btnInfo.bg) btn.style.backgroundColor = btnInfo.bg;
        if (btnInfo.text) btn.style.color = btnInfo.text;
        
        const _scHint = btnInfo.shortcut ? `<span class="cw-shortcut">${btnInfo.shortcut}</span>` : '';
        btn.innerHTML = `<span class="cw-index">${btnInfo.id}</span>${_scHint}<span class="cw-name">${btnInfo.name || ''}</span><span class="cw-timer" id="cw-timer-${btnInfo.id}">${getCartwallButtonReadyText(btnInfo)}</span><div class="cw-progress-container"><div class="cw-progress-bar" id="cw-progress-${btnInfo.id}"></div></div>`;

        btn.onclick = () => {
            if (isCartwallButtonPlayable(btnInfo)) {
                ipcRenderer.send('remote-cw-play', { ...btnInfo, _cwTabIndex: cwActiveTabIndex });
            }
        };
        btn.draggable = true;
        btn.addEventListener('dragstart', (e) => {
            if (!e.ctrlKey || !getCartwallButtonReadyText(btnInfo)) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-lf-cartwall-button', JSON.stringify({ tabIndex: cwActiveTabIndex, id: btnInfo.id }));
        });

        // Permite clic derecho en "espacios" (gap) usando el último hover
        btn.addEventListener('mouseenter', () => { botonSeleccionado = btnInfo; });

        btn.oncontextmenu = (e) => {
            e.preventDefault(); e.stopPropagation(); 
            botonSeleccionado = btnInfo;
            hideAllFloatingMenus();
            document.getElementById('check-bucle').innerText = btnInfo.loop ? '✓' : ''; 
            document.getElementById('check-detener').innerText = btnInfo.stopOther ? '✓' : '';
            document.getElementById('check-overlap').innerText = btnInfo.overlap ? '✓' : '';
            document.getElementById('check-restart').innerText = btnInfo.restart ? '✓' : '';
            refreshCartwallModeMenu(btnInfo);
            positionFloatingMenu(cwContextMenu, e.clientX, e.clientY);
        };

        btn.addEventListener('dragenter', (e) => { e.preventDefault(); btn.classList.add('cw-drag-over'); });
        btn.addEventListener('dragover', (e) => { e.preventDefault(); btn.classList.add('cw-drag-over'); });
        btn.addEventListener('dragleave', () => btn.classList.remove('cw-drag-over'));
        
        btn.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation(); btn.classList.remove('cw-drag-over');
            const movedRaw = e.dataTransfer?.getData('application/x-lf-cartwall-button');
            if (movedRaw) {
                const moved = JSON.parse(movedRaw);
                await moveCartwallButton(moved.tabIndex, moved.id, cwActiveTabIndex, btnInfo.id);
                return;
            }
            const p = extractFirstDroppedPath(e);
            await assignPathToButton(btnInfo, p);
        });
        
        cwGrid.appendChild(btn);
        if (cwPlayingButtons.has(`${cwActiveTabIndex}:${btnInfo.id}`)) btn.classList.add('cw-playing');
    });
}

// Drop/click derecho en el fondo de la grilla (entre botones)
if (cwGrid) {
    cwGrid.addEventListener('contextmenu', (e) => {
        if (e.target && e.target.closest('.cw-grid-item')) return;
        if (!botonSeleccionado) return;
        e.preventDefault(); e.stopPropagation();
        hideAllFloatingMenus();
        document.getElementById('check-bucle').innerText = botonSeleccionado.loop ? '✓' : ''; 
        document.getElementById('check-detener').innerText = botonSeleccionado.stopOther ? '✓' : '';
        document.getElementById('check-overlap').innerText = botonSeleccionado.overlap ? '✓' : '';
        document.getElementById('check-restart').innerText = botonSeleccionado.restart ? '✓' : '';
        refreshCartwallModeMenu(botonSeleccionado);
        positionFloatingMenu(cwContextMenu, e.clientX, e.clientY);
    });

    cwGrid.addEventListener('drop', async (e) => {
        if (e.target && e.target.closest('.cw-grid-item')) return;
        e.preventDefault(); e.stopPropagation();
        const p = extractFirstDroppedPath(e);
        if (!isValidAudioPath(p)) return;
        const paleta = getActiveCwPalette();
        if (!paleta) return;
        const firstEmpty = paleta.botones.find(b => !isCartwallButtonPlayable(b));
        if (firstEmpty) await assignPathToButton(firstEmpty, p);
        else if (botonSeleccionado) await assignPathToButton(botonSeleccionado, p);
    });

    cwGrid.addEventListener('dragover', (e) => { e.preventDefault(); });
}

document.addEventListener('click', (e) => {
  if (!cwContextMenu.contains(e.target)) cwContextMenu.style.display = 'none';
  if (!cwTabContextMenu.contains(e.target)) cwTabContextMenu.style.display = 'none';
  if (cwProfileMenu && !cwProfileMenu.contains(e.target) && e.target !== cwProfileButton) cwProfileMenu.style.display = 'none';
});

document.getElementById('menu-editar').onclick = () => {
    normalizeCwButtonShape(botonSeleccionado);
    document.getElementById('cw-edit-type').value = botonSeleccionado.type;
    document.getElementById('cw-edit-filepath').value = (botonSeleccionado.type === 'time' || isCartwallClimateButton(botonSeleccionado)) ? (botonSeleccionado.folder || '') : (botonSeleccionado.file || '');
    document.getElementById('cw-edit-name').value = botonSeleccionado.name || ''; 
    document.getElementById('cw-edit-volume').value = botonSeleccionado.vol || 1; 
    document.getElementById('cw-edit-bg-color').value = botonSeleccionado.bg || '#444444'; 
    document.getElementById('cw-edit-text-color').value = botonSeleccionado.text || '#FFFFFF'; 
    hideAllFloatingMenus(); 
    cwEditModal.style.display = 'flex';
    cwEditModal.tabIndex = -1;
    setTimeout(() => cwEditModal.focus(), 0);
};

document.getElementById('menu-limpiar').onclick = () => { 
    ipcRenderer.send('remote-cw-stop', { ...botonSeleccionado, _cwTabIndex: cwActiveTabIndex });
    botonSeleccionado.file = ''; botonSeleccionado.folder = ''; botonSeleccionado.type = 'audio'; botonSeleccionado.name = ''; botonSeleccionado.bg = ''; botonSeleccionado.overlap = false; botonSeleccionado.restart = false; 
    ipcRenderer.invoke('save-cartwall-profiles', cartwallState); renderCartwallGrid(); hideAllFloatingMenus(); 
};

document.getElementById('menu-bucle').onclick = () => { if (isCartwallTimeButton(botonSeleccionado) || isCartwallClimateButton(botonSeleccionado)) return; botonSeleccionado.loop = !botonSeleccionado.loop; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllFloatingMenus(); };
document.getElementById('menu-detener').onclick = () => { if (isCartwallTimeButton(botonSeleccionado) || isCartwallClimateButton(botonSeleccionado)) return; botonSeleccionado.stopOther = !botonSeleccionado.stopOther; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllFloatingMenus(); };
document.getElementById('menu-overlap').onclick = () => { if (isCartwallTimeButton(botonSeleccionado) || isCartwallClimateButton(botonSeleccionado)) return; botonSeleccionado.overlap = !botonSeleccionado.overlap; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllFloatingMenus(); };
document.getElementById('menu-restart').onclick = () => { if (isCartwallTimeButton(botonSeleccionado) || isCartwallClimateButton(botonSeleccionado)) return; botonSeleccionado.restart = !botonSeleccionado.restart; ipcRenderer.invoke('save-cartwall-profiles', cartwallState); hideAllFloatingMenus(); };

document.getElementById('menu-previa').onclick = () => { 
    if (botonSeleccionado.file) { ipcRenderer.send('open-preview', botonSeleccionado.file); }
    hideAllFloatingMenus(); 
};

document.getElementById('tab-menu-editar').onclick = () => {
    modoTab = 'editar'; 
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    const paleta = profile.paletas[tabSeleccionadaIndex]; 
    document.getElementById('cw-tab-modal-title').innerText = 'Editar Botonera';
    document.getElementById('cw-tab-name').value = paleta.nombre; 
    document.getElementById('cw-tab-v').value = paleta.rows; 
    document.getElementById('cw-tab-h').value = paleta.cols; 
    document.getElementById('cw-tab-bg-color').value = paleta.tabBg || '#3a3f44'; 
    document.getElementById('cw-tab-text-color').value = paleta.tabText || '#cccccc';
    hideAllFloatingMenus(); 
    cwTabModal.style.display = 'flex';
    cwTabModal.tabIndex = -1;
    setTimeout(() => cwTabModal.focus(), 0);
};


document.getElementById('tab-menu-eliminar').onclick = async () => {
    hideAllFloatingMenus();
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    if (profile.paletas.length <= 1) { alert("No puedes eliminar la unica botonera."); return; }
    const paleta = profile.paletas[tabSeleccionadaIndex];
    if (!(await confirmDeleteCartwallTab(paleta))) return;
    ipcRenderer.send('remote-cw-stop-tab', tabSeleccionadaIndex);
    forgetFloatingPlayingTab(tabSeleccionadaIndex);
    profile.paletas.splice(tabSeleccionadaIndex, 1); 
    cwActiveTabIndex = Math.min(cwActiveTabIndex, profile.paletas.length - 1); 
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState); 
    renderCartwallTabs(); 
    renderCartwallGrid(); 
    setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
};

const cwCloseModalButton = document.getElementById('cw-close-modal');
if (cwCloseModalButton) cwCloseModalButton.onclick = closeCwEditModal;
document.getElementById('btn-cancel-cw-edit').onclick = closeCwEditModal;
cwEditModal.addEventListener('mousedown', (event) => { if (event.target === cwEditModal) closeCwEditModal(); });
cwEditModal.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-edit').click(), closeCwEditModal));

document.getElementById('btn-select-file').onclick = async () => {
    const selectedType = document.getElementById('cw-edit-type')?.value || 'audio';
    const ruta = (selectedType === 'time' || selectedType === 'temperature' || selectedType === 'humidity')
        ? await ipcRenderer.invoke('dialog:selectFolder')
        : await ipcRenderer.invoke('dialog:openFile');
    if (ruta) { 
        document.getElementById('cw-edit-filepath').value = ruta; 
        const nombre = path.basename(ruta); 
        document.getElementById('cw-edit-name').value = selectedType === 'time' ? 'Locución de hora' : ((selectedType === 'temperature' || selectedType === 'humidity') ? getClimateLocutionLabel(selectedType) : (nombre.substring(0, nombre.lastIndexOf('.')) || nombre).toUpperCase());
    }
};

document.getElementById('cw-edit-type')?.addEventListener('change', () => {
    const selectedType = document.getElementById('cw-edit-type').value;
    document.getElementById('cw-edit-filepath').value = selectedType === botonSeleccionado?.type
        ? ((selectedType === 'time' || selectedType === 'temperature' || selectedType === 'humidity') ? (botonSeleccionado.folder || '') : (botonSeleccionado.file || ''))
        : '';
    if (selectedType === 'time') document.getElementById('cw-edit-name').value = 'Locución de hora';
    if (selectedType === 'temperature' || selectedType === 'humidity') document.getElementById('cw-edit-name').value = getClimateLocutionLabel(selectedType);
});

document.getElementById('btn-save-cw-edit').onclick = async () => {
    const selectedType = document.getElementById('cw-edit-type')?.value || 'audio';
    const selectedPath = document.getElementById('cw-edit-filepath').value;
    const folderBacked = selectedType === 'time' || selectedType === 'temperature' || selectedType === 'humidity';
    const previousPath = folderBacked ? botonSeleccionado.folder : botonSeleccionado.file;
    if (botonSeleccionado.type !== selectedType || previousPath !== selectedPath) { 
        ipcRenderer.send('remote-cw-stop', { ...botonSeleccionado, _cwTabIndex: cwActiveTabIndex });
    }
    botonSeleccionado.type = selectedType;
    botonSeleccionado.file = folderBacked ? '' : selectedPath;
    botonSeleccionado.folder = folderBacked ? selectedPath : '';
    botonSeleccionado.name = document.getElementById('cw-edit-name').value; 
    botonSeleccionado.vol = parseFloat(document.getElementById('cw-edit-volume').value); 
    botonSeleccionado.bg = document.getElementById('cw-edit-bg-color').value; 
    botonSeleccionado.text = document.getElementById('cw-edit-text-color').value; 
    resetCartwallButtonModeOptions(botonSeleccionado);
    await ipcRenderer.invoke('save-cartwall-profiles', cartwallState); 
    renderCartwallGrid(); 
    closeCwEditModal();
};

const cwCloseTabModalButton = document.getElementById('cw-close-tab-modal');
if (cwCloseTabModalButton) cwCloseTabModalButton.onclick = closeCwTabModal;
document.getElementById('btn-cancel-cw-tab')?.addEventListener('click', closeCwTabModal);
cwTabModal.addEventListener('mousedown', (event) => {
    if (event.target === cwTabModal) closeCwTabModal();
});
cwTabModal.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-tab').click(), closeCwTabModal));
document.getElementById('btn-cancel-cw-profile')?.addEventListener('click', closeCwProfileModal);
cwProfileModal?.addEventListener('mousedown', (event) => { if (event.target === cwProfileModal) closeCwProfileModal(); });
cwProfileModal?.addEventListener('keydown', (event) => handleCartwallModalKeydown(event, () => document.getElementById('btn-save-cw-profile').click(), closeCwProfileModal));
document.getElementById('btn-save-cw-profile')?.addEventListener('click', saveCwProfileModal);
document.getElementById('btn-save-cw-tab').onclick = async () => {
    if (cwSavingTab) return;
    cwSavingTab = true;
    const profile = cartwallState.profiles.find(p => p.id === cartwallState.activeProfileId);
    const nombre = document.getElementById('cw-tab-name').value.trim() || `Botonera ${profile.paletas.length + 1}`; 
    const v = Math.max(1, Math.min(20, parseInt(document.getElementById('cw-tab-v').value) || 5)); 
    const h = Math.max(1, Math.min(20, parseInt(document.getElementById('cw-tab-h').value) || 5));
    document.getElementById('cw-tab-v').value = v;
    document.getElementById('cw-tab-h').value = h;
    
    closeCwTabModal();
    try {
        if (modoTab === 'nuevo') {
            let botones = createEmptyCwButtons(v * h);
            profile.paletas.push({ nombre, rows: v, cols: h, tabBg: document.getElementById('cw-tab-bg-color').value, tabText: document.getElementById('cw-tab-text-color').value, botones }); 
            cwActiveTabIndex = profile.paletas.length - 1; 
        } else {
            const paleta = profile.paletas[tabSeleccionadaIndex]; 
            paleta.nombre = nombre; 
            paleta.tabBg = document.getElementById('cw-tab-bg-color').value; 
            paleta.tabText = document.getElementById('cw-tab-text-color').value; 
            
            const total = v * h;
            if (paleta.botones.length < total) {
                for (let i = paleta.botones.length + 1; i <= total; i++) { paleta.botones.push(createEmptyCwButtonForSlot(i)); }
            } else if (paleta.botones.length > total) { 
                paleta.botones = paleta.botones.slice(0, total); 
            }
            paleta.botones.forEach((b, i) => b.id = i + 1); 
            paleta.rows = v; 
            paleta.cols = h;
        }
        await ipcRenderer.invoke('save-cartwall-profiles', cartwallState); 
        renderCartwallTabs(); 
        renderCartwallGrid(); 
        setCartwallUiState({ activeProfileId: cartwallState.activeProfileId, activeTabIndex: cwActiveTabIndex });
    } finally {
        cwSavingTab = false;
    }
};

loadState();

// ── Atajos de teclado del cartwall (modo ventana flotante) ───────────────────
// Cuando el cartwall está flotante, esta ventana tiene su propio contexto de
// teclado. Interceptamos en capture phase para actuar antes que cualquier modal.
window.addEventListener('keydown', (e) => {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    if (['Escape', 'Enter', 'Tab'].includes(e.key)) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA'].includes(tag) && !e.ctrlKey && !e.altKey) return;

    const combo = buildComboString(e);
    if (!combo) return;

    const profile = cartwallState?.profiles?.find(p => p.id === cartwallState?.activeProfileId)
                 || cartwallState?.profiles?.[0];
    if (!profile?.paletas) return;

    for (let ti = 0; ti < profile.paletas.length; ti++) {
        for (const btn of (profile.paletas[ti]?.botones || [])) {
            if (btn.shortcut === combo && (btn.file || btn.type !== 'audio')) {
                e.preventDefault();
                e.stopPropagation();
                ipcRenderer.send('remote-cw-play', { ...btn, _cwTabIndex: ti });
                return;
            }
        }
    }
}, true);
